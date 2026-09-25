var config = require("./config.js");

var LOG_TAG = "[vercel-tts]";

// Bob 宿主超时；单次 HTTP 请求必须比它更早结束，才有机会把明确的错误交回 Bob。
var PLUGIN_TIMEOUT_INTERVAL = 60;
var TTS_HTTP_TIMEOUT = 50;
var VALIDATE_HTTP_TIMEOUT = 20;

var API_KEYS_LINK = "https://vercel.com/docs/ai-gateway/authentication-and-byok/api-keys";
var PRICING_LINK = "https://vercel.com/docs/ai-gateway/pricing";
var TTS_DOC_LINK = "https://vercel.com/docs/ai-gateway/modalities/text-to-speech";

// ---------------------------------------------------------------- 工具函数

function trimmed(value) {
    if (value === undefined || value === null) {
        return "";
    }
    return String(value).trim();
}

function readOption(name) {
    return trimmed(typeof $option !== "undefined" && $option ? $option[name] : "");
}

// 日志里绝不能出现 Key：Bearer 头和 vck_ 开头的 Key 一律打码，并压成一行。
function sanitize(value) {
    var str = value === undefined || value === null ? "" : String(value);
    str = str.replace(/Bearer\s+[^\s"']+/gi, "Bearer [REDACTED]");
    str = str.replace(/vck_[A-Za-z0-9_-]+/g, "[REDACTED]");
    str = str.replace(/\s+/g, " ").trim();
    return str.length > 300 ? str.slice(0, 297) + "..." : str;
}

function logInfo(message) {
    if (typeof $log !== "undefined" && $log && typeof $log.info === "function") {
        $log.info(LOG_TAG + " " + message);
    }
}

function logError(message) {
    if (typeof $log !== "undefined" && $log && typeof $log.error === "function") {
        $log.error(LOG_TAG + " " + message);
    } else {
        logInfo(message);
    }
}

function isBinary(value) {
    return typeof $data !== "undefined" && !!$data &&
        typeof $data.isData === "function" && $data.isData(value);
}

// 把响应体尽量变成可读文本。Bob 会把 JSON 自动解析成对象，解析不了的留在 $data 里。
function bodyToText(body) {
    if (body === undefined || body === null) {
        return "";
    }
    if (typeof body === "string") {
        return body;
    }
    if (isBinary(body)) {
        return body.toUTF8() || "";
    }
    try {
        return JSON.stringify(body);
    } catch (err) {
        return String(body);
    }
}

function bodyToObject(body) {
    if (body && typeof body === "object" && !isBinary(body)) {
        return body;
    }
    var text = bodyToText(body);
    if (!text) {
        return null;
    }
    try {
        var parsed = JSON.parse(text);
        return parsed && typeof parsed === "object" ? parsed : null;
    } catch (err) {
        return null;
    }
}

// ---------------------------------------------------------------- 端点

function isLoopbackHost(host) {
    var value = String(host || "").toLowerCase().replace(/:\d+$/, "");
    if (value === "localhost" || value === "[::1]") {
        return true;
    }
    var match = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(value);
    return !!match && Number(match[1]) === 127;
}

// 用户可以填网关基础地址、代理地址，或者完整的 /v4/ai/speech-model 地址，
// 这里统一补成 speech 端点。远程地址强制 HTTPS：Key 和待合成文本都在请求里。
function resolveEndpoint() {
    var raw = readOption("apiUrl") || config.DEFAULT_API_BASE;
    if (/[\u0000-\u001f\u007f\s]/.test(raw)) {
        return { error: "API 地址不能包含空格或控制字符" };
    }
    var value = raw;
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
        value = "https://" + value;
    }
    var match = /^(https?):\/\/([^\/?#]+)(\/[^?#]*)?(\?[^#]*)?(#.*)?$/i.exec(value);
    if (!match) {
        return { error: "API 地址格式无效，仅支持 http(s)://主机[/路径]" };
    }
    if (match[4] || match[5]) {
        return { error: "API 地址不能带 query 或 #fragment" };
    }
    var scheme = match[1].toLowerCase();
    var host = match[2];
    var path = match[3] || "";
    if (host.indexOf("@") !== -1) {
        return { error: "API 地址不能包含用户名或密码" };
    }
    if (scheme === "http" && !isLoopbackHost(host)) {
        return { error: "远程地址必须使用 HTTPS（仅 localhost / 127.x / [::1] 可用 HTTP）" };
    }
    path = path.replace(/\/+$/, "");
    if (!/\/v4\/ai\/speech-model$/i.test(path)) {
        if (/\/v4\/ai$/i.test(path)) {
            path += "/speech-model";
        } else if (/\/v4$/i.test(path)) {
            path += "/ai/speech-model";
        } else {
            path += config.SPEECH_PATH;
        }
    }
    return { url: scheme + "://" + host + path };
}

// ---------------------------------------------------------------- 模型 / 音色 / 请求体

// 自定义模型 ID 优先，方便用目录里刚上架、菜单还没有的模型
function resolveModel() {
    var custom = readOption("customModel");
    if (custom) {
        return { id: custom, source: "custom" };
    }
    return { id: readOption("model") || config.DEFAULT_MODEL, source: "menu" };
}

// 自定义音色优先；否则按家族取对应菜单。Bob 的设置项是静态显示的，所有音色菜单
// 会同时出现，插件只读当前模型家族那一个。
function resolveVoice(family) {
    var custom = readOption("customVoice");
    if (custom) {
        return { id: custom, source: "custom" };
    }
    var info = config.familyInfo(family);
    if (!info.voiceOption) {
        return { id: "", source: "none" };
    }
    var selected = readOption(info.voiceOption) || info.defaultVoice;
    if (selected === config.PROVIDER_DEFAULT_VOICE) {
        selected = "";
    }
    return { id: selected, source: selected ? "menu" : "none" };
}

function buildRequest(text, lang) {
    var model = resolveModel();
    var family = config.getModelFamily(model.id);
    var info = config.familyInfo(family);
    var voice = resolveVoice(family);
    var dropped = [];
    var notes = [];

    var body = { text: text };
    if (voice.id) {
        body.voice = voice.id;
    }

    var format = config.resolveOutputFormat(family, readOption("outputFormat"));
    if (format.note) {
        notes.push(format.note);
    }
    if (format.format) {
        body.outputFormat = format.format;
    }

    // 语速只在偏离 1.0 时发送，且只发给支持的家族
    var speedRaw = readOption("speed");
    var speed = speedRaw ? Number(speedRaw) : NaN;
    if (!isNaN(speed) && speed > 0 && speed !== 1) {
        if (info.speed) {
            body.speed = speed;
        } else {
            dropped.push("speed");
        }
    }

    var instructions = readOption("instructions");
    if (instructions) {
        if (config.modelAcceptsInstructions(family, model.id)) {
            body.instructions = instructions;
        } else {
            dropped.push("instructions");
        }
    }

    var language = config.languageParam(family, lang);
    if (language) {
        body.language = language;
    }

    return {
        model: model,
        family: family,
        info: info,
        voice: voice,
        body: body,
        format: format.format || "",
        dropped: dropped,
        notes: notes
    };
}

function requestHeaders(apiKey, modelId) {
    return {
        "Authorization": "Bearer " + apiKey,
        "Content-Type": "application/json",
        "ai-gateway-protocol-version": "0.0.1",
        "ai-speech-model-specification-version": "4",
        "ai-model-id": modelId
    };
}

// ---------------------------------------------------------------- 错误映射

// 网关错误格式：{ "error": { "message": "...", "type": "authentication_error" } }
function parseGatewayError(body) {
    var obj = bodyToObject(body);
    var result = { message: "", type: "", code: "" };
    if (!obj) {
        result.message = bodyToText(body).slice(0, 300);
        return result;
    }
    var err = obj.error;
    if (typeof err === "string") {
        result.message = err;
    } else if (err && typeof err === "object") {
        result.message = typeof err.message === "string" ? err.message : "";
        result.type = typeof err.type === "string" ? err.type : "";
        result.code = typeof err.code === "string" ? err.code : "";
    }
    if (!result.message && typeof obj.message === "string") {
        result.message = obj.message;
    }
    if (!result.message) {
        try {
            result.message = JSON.stringify(obj).slice(0, 300);
        } catch (e) {
            result.message = "";
        }
    }
    return result;
}

// 把 HTTP 状态码 + 网关的 error.type 翻译成 Bob 的 service error
function toServiceError(statusCode, body, modelId) {
    var parsed = parseGatewayError(body);
    var detail = parsed.message ? "：" + parsed.message : "";
    var kind = (parsed.type + " " + parsed.code).toLowerCase();

    if (statusCode === 401 || parsed.type === "authentication_error") {
        return {
            type: "secretKey",
            message: "AI Gateway 认证失败，请检查 API Key" + detail,
            troubleshootingLink: API_KEYS_LINK,
            addition: parsed
        };
    }
    if (statusCode === 402 || /insufficient|credit|payment|budget|billing/.test(kind)) {
        return {
            type: "api",
            message: "AI Gateway 额度不足或超出预算" + detail,
            troubleshootingLink: PRICING_LINK,
            addition: parsed
        };
    }
    if (statusCode === 403 || parsed.type === "permission_error") {
        return {
            type: "secretKey",
            message: "当前 API Key 或团队无权访问该资源" + detail +
                "。语音合成在 AI Gateway 上仍是 beta，可能尚未对你的团队开放",
            troubleshootingLink: TTS_DOC_LINK,
            addition: parsed
        };
    }
    if (statusCode === 404 || parsed.type === "not_found_error") {
        return {
            type: "notFound",
            message: "模型 " + (modelId || "") + " 不存在或不可用" + detail +
                "。请核对模型 ID；TTS 模型处于 beta 灰度，可能尚未出现在你团队的目录里",
            troubleshootingLink: TTS_DOC_LINK,
            addition: parsed
        };
    }
    if (statusCode === 429 || parsed.type === "rate_limit_error") {
        return {
            type: "api",
            message: "请求过于频繁或超出速率限制" + detail + "，请稍后重试",
            addition: parsed
        };
    }
    if (statusCode === 400 || statusCode === 422 || parsed.type === "invalid_request_error") {
        return { type: "param", message: "请求被网关拒绝" + detail, addition: parsed };
    }
    if (statusCode >= 500) {
        return {
            type: "api",
            message: "AI Gateway 或模型提供方暂时不可用（HTTP " + statusCode + "）" + detail + "，请稍后重试",
            addition: parsed
        };
    }
    return {
        type: "api",
        message: "AI Gateway 返回错误（HTTP " + statusCode + "）" + detail,
        addition: parsed
    };
}

// Bob 的 tts 报错弹窗里 troubleshootingLink 只渲染成纯文本（URL 能看见但不可点）。
// 把地址明文追加进 message，保证用户总能看到自救入口；message 已含该地址则不重复。
function ensureLinkVisible(err) {
    if (!err || !err.troubleshootingLink || !err.message) {
        return err;
    }
    var link = err.troubleshootingLink;
    var probe = link.replace(/^https?:\/\//, "");
    if (err.message.indexOf(link) !== -1 || err.message.indexOf(probe) !== -1) {
        return err;
    }
    err.message = err.message + "（详见 " + link + "）";
    return err;
}

// ---------------------------------------------------------------- 响应解析

var BASE64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
var BASE64_RE = /^[A-Za-z0-9+\/]+={0,2}$/;

// 去掉空白和 data: URI 前缀，校验字符集；不合法返回空串
function normalizeBase64(value) {
    var str = String(value || "").replace(/\s+/g, "");
    if (str.indexOf("data:") === 0) {
        var comma = str.indexOf(",");
        str = comma === -1 ? "" : str.slice(comma + 1);
    }
    if (!str || str.length % 4 === 1 || !BASE64_RE.test(str)) {
        return "";
    }
    return str;
}

// 只解码开头几个字节用来嗅探容器格式，不需要 $data，也不会复制整段音频
function decodeBase64Prefix(base64, byteCount) {
    var bytes = [];
    var chars = Math.ceil(byteCount / 3) * 4;
    var acc = 0;
    var bits = 0;
    for (var i = 0; i < chars && i < base64.length && bytes.length < byteCount; i++) {
        var ch = base64.charAt(i);
        if (ch === "=") {
            break;
        }
        var v = BASE64_CHARS.indexOf(ch);
        if (v < 0) {
            break;
        }
        acc = (acc << 6) | v;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            bytes.push((acc >>> bits) & 0xff);
            acc &= (1 << bits) - 1;
        }
    }
    return bytes;
}

function bytesMatch(bytes, offset, ascii) {
    for (var i = 0; i < ascii.length; i++) {
        if (bytes[offset + i] !== ascii.charCodeAt(i)) {
            return false;
        }
    }
    return true;
}

// 识别音频容器：Bob 用系统播放器播放 base64，识别结果只用于日志和 raw，
// 让「有响应但没声音」这类问题能从日志里直接看出返回的到底是什么。
function sniffAudioFormat(base64) {
    var b = decodeBase64Prefix(base64, 12);
    if (b.length < 4) {
        return "unknown";
    }
    if (bytesMatch(b, 0, "RIFF") && bytesMatch(b, 8, "WAVE")) {
        return "wav";
    }
    if (bytesMatch(b, 0, "ID3")) {
        return "mp3";
    }
    if (bytesMatch(b, 0, "fLaC")) {
        return "flac";
    }
    if (bytesMatch(b, 0, "OggS")) {
        return "ogg";
    }
    if (bytesMatch(b, 4, "ftyp")) {
        return "mp4";
    }
    if (b[0] === 0xff && (b[1] & 0xe0) === 0xe0) {
        // 12 位同步字 + layer 位为 00 是 ADTS AAC，否则是 MPEG 音频帧
        return (b[1] & 0xf6) === 0xf0 ? "aac" : "mp3";
    }
    return "unknown";
}

// 2xx 响应必须是 { audio: base64 } 形态。代理返回 HTML、网关改了字段名、音频为空，
// 都要报错而不是把乱码交给 Bob 播放（表现为「点了没声音也没报错」）。
function extractAudio(resp) {
    var obj = bodyToObject(resp.data);
    if (!obj) {
        var text = bodyToText(resp.data);
        throw {
            type: "api",
            message: "AI Gateway 返回的不是 JSON" + (text ? "：" + text.slice(0, 200) : ""),
            addition: { mimeType: responseMimeType(resp.response) }
        };
    }
    var audio = obj.audio;
    if (audio && typeof audio === "object") {
        audio = audio.base64 || audio.data;
    }
    if (typeof audio !== "string") {
        throw {
            type: "api",
            message: "AI Gateway 响应里没有 audio 字段" +
                (obj.error ? "：" + parseGatewayError(obj).message : ""),
            addition: { keys: Object.keys(obj) }
        };
    }
    var encoded = normalizeBase64(audio);
    if (!encoded) {
        throw { type: "api", message: "AI Gateway 返回的音频为空或不是合法的 base64" };
    }
    return {
        audio: encoded,
        warnings: Array.isArray(obj.warnings) ? obj.warnings : [],
        providerMetadata: obj.providerMetadata
    };
}

function responseMimeType(response) {
    if (!response) {
        return "";
    }
    var direct = trimmed(response.MIMEType || response.mimeType);
    if (direct) {
        return direct.toLowerCase().split(";")[0];
    }
    var headers = response.headers || {};
    var found = "";
    Object.keys(headers).some(function (key) {
        if (String(key).toLowerCase() === "content-type") {
            found = trimmed(headers[key]).toLowerCase().split(";")[0];
            return true;
        }
        return false;
    });
    return found;
}

function describeWarnings(warnings) {
    return warnings.map(function (w) {
        if (!w || typeof w !== "object") {
            return String(w);
        }
        var parts = [w.type || "warning"];
        if (w.setting) {
            parts.push(w.setting);
        }
        if (w.feature) {
            parts.push(w.feature);
        }
        if (w.details || w.message) {
            parts.push(w.details || w.message);
        }
        return parts.join(" ");
    }).join("; ");
}

// ---------------------------------------------------------------- 合成

// tts 与 pluginValidate 共用：成功返回 { audio, format, warnings, request }，失败抛 service error
async function synthesize(text, lang, timeout) {
    var apiKey = readOption("apiKey");
    if (!apiKey) {
        throw {
            type: "secretKey",
            message: "请先在插件设置里填写 Vercel AI Gateway API Key",
            troubleshootingLink: API_KEYS_LINK
        };
    }

    var endpoint = resolveEndpoint();
    if (endpoint.error) {
        throw { type: "param", message: "API 地址无效：" + endpoint.error };
    }

    if (!trimmed(text)) {
        throw { type: "param", message: "没有可合成的文本" };
    }

    var req = buildRequest(text, lang);
    if (text.length > req.info.charLimit) {
        throw {
            type: "param",
            message: "文本长度 " + text.length + " 超过 " + req.model.id +
                " 的单次上限 " + req.info.charLimit + " 字符，请分段朗读"
        };
    }

    req.notes.forEach(function (note) {
        logInfo("note " + note);
    });
    if (req.dropped.length) {
        logInfo("参数丢弃（" + req.model.id + " 不支持）：" + req.dropped.join(","));
    }
    logInfo(
        "start chars=" + text.length +
        " lang=" + (lang || "-") +
        " model=" + sanitize(req.model.id) + "(" + req.model.source + ")" +
        " voice=" + (req.voice.id ? sanitize(req.voice.id) : "-") + "(" + req.voice.source + ")" +
        " format=" + (req.format || "-") +
        " speed=" + (req.body.speed === undefined ? "-" : req.body.speed) +
        " instructions=" + (req.body.instructions ? "on" : "off") +
        " language=" + (req.body.language || "-") +
        " url=" + sanitize(endpoint.url)
    );
    var startedAt = Date.now();

    var resp = await $http.request({
        method: "POST",
        url: endpoint.url,
        header: requestHeaders(apiKey, req.model.id),
        body: req.body,
        timeout: timeout
    });

    if (!resp || resp.error) {
        var networkError = resp && resp.error;
        throw {
            type: "network",
            message: "请求 AI Gateway 失败：" +
                (networkError && networkError.message ? networkError.message : "未收到 HTTP 响应"),
            addition: networkError
        };
    }

    // 必须查状态码：非 2xx 时响应体是 JSON 错误，不能当音频交出去
    var statusCode = resp.response ? Number(resp.response.statusCode) : 0;
    if (!statusCode) {
        throw { type: "network", message: "AI Gateway 请求没有收到有效的 HTTP 响应" };
    }
    if (statusCode < 200 || statusCode >= 300) {
        var failure = toServiceError(statusCode, resp.data, req.model.id);
        logInfo("failed status=" + statusCode + " model=" + sanitize(req.model.id) + " type=" + failure.type);
        throw failure;
    }

    var audio = extractAudio(resp);
    var detected = sniffAudioFormat(audio.audio);
    if (audio.warnings.length) {
        logInfo("gateway warnings: " + sanitize(describeWarnings(audio.warnings)));
    }
    if (detected === "unknown") {
        logInfo("warn 无法识别音频容器（开头不是 mp3/wav/flac/aac/ogg/mp4），仍交给 Bob 播放；若无声请换音频格式");
    } else if (detected === "ogg") {
        logInfo("warn 返回的是 Ogg 容器，macOS 系统播放器可能不支持，请在设置里改用 mp3 或 wav");
    }
    logInfo(
        "success status=" + statusCode +
        " format=" + detected +
        " base64_chars=" + audio.audio.length +
        " ms=" + (Date.now() - startedAt)
    );

    return { audio: audio.audio, format: detected, warnings: audio.warnings, request: req };
}

function toCaught(err, fallbackMessage) {
    var caught = err && typeof err === "object"
        ? err
        : { type: "unknown", message: err ? String(err) : fallbackMessage };
    if (!caught.type && caught instanceof Error) {
        caught = { type: "unknown", message: fallbackMessage + "：" + caught.message };
    }
    ensureLinkVisible(caught);
    return {
        type: caught.type || "unknown",
        message: caught.message || fallbackMessage,
        troubleshootingLink: caught.troubleshootingLink,
        addition: caught.addition
    };
}

// ---------------------------------------------------------------- 插件接口

function supportLanguages() {
    return config.LANGUAGES.map(function (item) {
        return item[0];
    });
}

function pluginTimeoutInterval() {
    return PLUGIN_TIMEOUT_INTERVAL;
}

// 只有一次真实合成能无歧义地验证 Key、团队是否开通 TTS、当前模型和音色是否可用。
// 用两个字符把验证成本压到最低。
function pluginValidate(completion) {
    (async () => {
        try {
            await synthesize("Hi", "en", VALIDATE_HTTP_TIMEOUT);
            completion({ result: true });
        } catch (err) {
            var failure = toCaught(err, "验证失败");
            logError("validate error type=" + failure.type + " message=" + sanitize(failure.message));
            completion({ result: false, error: failure });
        }
    })();
}

function tts(query, completion) {
    (async () => {
        try {
            var text = query && typeof query.text === "string" ? query.text.trim() : "";
            var lang = query && query.lang ? String(query.lang) : "";
            var out = await synthesize(text, lang, TTS_HTTP_TIMEOUT);
            completion({
                result: {
                    type: "base64",
                    value: out.audio,
                    raw: {
                        model: out.request.model.id,
                        voice: out.request.voice.id || null,
                        output_format: out.request.format || null,
                        detected_format: out.format,
                        warnings: out.warnings,
                        base64_chars: out.audio.length
                    }
                }
            });
        } catch (err) {
            var failure = toCaught(err, "语音合成失败");
            logError("error type=" + failure.type + " message=" + sanitize(failure.message));
            completion({ error: failure });
        }
    })();
}

exports.supportLanguages = supportLanguages;
exports.pluginTimeoutInterval = pluginTimeoutInterval;
exports.pluginValidate = pluginValidate;
exports.tts = tts;
