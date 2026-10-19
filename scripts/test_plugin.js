// 本地测试：用 macOS 自带的 jsc（Bob 插件运行时用的同一个 JavaScriptCore）跑 src/main.js，
// $http / $data / $option / $log 全部用桩替换，不会真的请求 AI Gateway，也不消耗额度。
//
// 用法：make test
//
// jsc 路径：/System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc

var failures = [];
var checks = 0;

function ok(condition, label) {
    checks += 1;
    if (!condition) {
        failures.push(label);
        print("FAIL  " + label);
    } else {
        print("ok    " + label);
    }
}

// ------------------------------------------------------------ 运行时桩

function utf8Bytes(str) {
    var bytes = [];
    for (var i = 0; i < str.length; i++) {
        var c = str.charCodeAt(i);
        if (c < 0x80) {
            bytes.push(c);
        } else if (c < 0x800) {
            bytes.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
        } else {
            bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
        }
    }
    return bytes;
}

var B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function base64(bytes) {
    var out = "";
    for (var i = 0; i < bytes.length; i += 3) {
        var b0 = bytes[i];
        var b1 = bytes[i + 1];
        var b2 = bytes[i + 2];
        out += B64[b0 >> 2];
        out += B64[((b0 & 3) << 4) | ((b1 === undefined ? 0 : b1) >> 4)];
        out += b1 === undefined ? "=" : B64[((b1 & 15) << 2) | ((b2 === undefined ? 0 : b2) >> 6)];
        out += b2 === undefined ? "=" : B64[b2 & 63];
    }
    return out;
}

// 刻意不暴露 length：Bob 实际运行时 $data 就没有这个属性
function makeData(bytes) {
    return {
        __data: true,
        toBase64: function () {
            return base64(bytes);
        },
        toUTF8: function () {
            var s = "";
            for (var i = 0; i < bytes.length; i++) {
                s += String.fromCharCode(bytes[i]);
            }
            return s;
        }
    };
}

globalThis.$data = {
    isData: function (v) {
        return !!(v && v.__data);
    },
    fromData: function (v) {
        return v;
    },
    fromUTF8: function (s) {
        return makeData(utf8Bytes(s));
    }
};

var logs = [];

globalThis.$log = {
    info: function (m) {
        logs.push(String(m));
    },
    error: function (m) {
        logs.push(String(m));
    }
};

function loggedLine(needle) {
    return logs.some(function (line) {
        return line.indexOf(needle) >= 0;
    });
}

globalThis.$option = {};

var lastRequest = null;
var nextResponse = null;

globalThis.$http = {
    request: function (req) {
        lastRequest = req;
        return Promise.resolve(nextResponse);
    }
};

// "ID3" 头 + 一个 MPEG 帧同步字，足够被识别成 mp3
var MP3_B64 = base64([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0xfb, 0x90, 0x64, 0x00, 0x00]);
var WAV_B64 = base64([0x52, 0x49, 0x46, 0x46, 0x24, 0x08, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74, 0x20]);
var RAW_MPEG_B64 = base64([0xff, 0xfb, 0x90, 0x64, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
var AAC_B64 = base64([0xff, 0xf1, 0x50, 0x80, 0x00, 0x1f, 0xfc, 0x00, 0x00, 0x00, 0x00, 0x00]);
var OGG_B64 = base64([0x4f, 0x67, 0x67, 0x53, 0x00, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
var PCM_B64 = base64([0x00, 0x00, 0x01, 0x00, 0xfe, 0xff, 0x02, 0x00, 0x00, 0x00, 0x01, 0x00]);

function jsonResponse(statusCode, obj) {
    return {
        response: { statusCode: statusCode, headers: { "content-type": "application/json" } },
        data: obj,
        rawData: makeData(utf8Bytes(JSON.stringify(obj)))
    };
}

function audioResponse(b64, warnings) {
    return jsonResponse(200, { audio: b64 || MP3_B64, warnings: warnings || [] });
}

function textResponse(statusCode, text, mimeType) {
    return {
        response: { statusCode: statusCode, headers: { "content-type": mimeType || "text/plain" } },
        data: text,
        rawData: makeData(utf8Bytes(text))
    };
}

function gatewayError(statusCode, message, type) {
    return jsonResponse(statusCode, { error: { message: message, type: type || "" } });
}

// ------------------------------------------------------------ 加载插件

globalThis.exports = {};
load("src/config.js");
var configModule = globalThis.exports;

globalThis.require = function (path) {
    if (path === "./config.js" || path === "config.js") {
        return configModule;
    }
    throw new Error("未知模块: " + path);
};

globalThis.exports = {};
load("src/main.js");
var plugin = globalThis.exports;

// ------------------------------------------------------------ 用例

var BASE_OPTIONS = {
    apiKey: "vck_test_key_123",
    apiUrl: "https://ai-gateway.vercel.sh",
    model: "openai/tts-1",
    customModel: "",
    voiceOpenai: "alloy",
    voiceGoogle: "Kore",
    voiceMicrosoft: "default",
    voiceGrok: "eve",
    voiceFish: "default",
    customVoice: "",
    outputFormat: "auto",
    speed: "1.0",
    instructions: ""
};

function withOptions(overrides) {
    var opts = {};
    Object.keys(BASE_OPTIONS).forEach(function (k) {
        opts[k] = BASE_OPTIONS[k];
    });
    Object.keys(overrides || {}).forEach(function (k) {
        opts[k] = overrides[k];
    });
    globalThis.$option = opts;
}

function speak(query) {
    return new Promise(function (resolve) {
        plugin.tts(query, resolve);
    });
}

function validate() {
    return new Promise(function (resolve) {
        plugin.pluginValidate(resolve);
    });
}

var EN = { text: "hello world", lang: "en" };
var SPEECH_URL = "https://ai-gateway.vercel.sh/v4/ai/speech-model";

(async function () {
    // 1. 基本接口
    var langs = plugin.supportLanguages();
    ok(Array.isArray(langs) && langs.length > 60, "supportLanguages 返回语言数组");
    ok(langs.indexOf("zh-Hans") >= 0 && langs.indexOf("en") >= 0 && langs.indexOf("ja") >= 0,
        "语言列表包含 zh-Hans / en / ja");
    ok(langs.indexOf("auto") < 0, "TTS 语言列表不含 auto");
    ok(plugin.pluginTimeoutInterval() === 60, "pluginTimeoutInterval 为 60 秒");

    // 2. 缺 API Key
    withOptions({ apiKey: "" });
    var r = await speak(EN);
    ok(r.error && r.error.type === "secretKey", "缺 API Key 时报 secretKey");
    ok(r.error && r.error.message.indexOf("vercel.com/docs/ai-gateway") > 0,
        "缺 Key 的报错把 troubleshootingLink 明文写进 message");

    // 3. 默认配置下的请求形态
    withOptions({});
    nextResponse = audioResponse();
    logs = [];
    r = await speak(EN);
    ok(r.result && r.result.type === "base64" && r.result.value === MP3_B64, "成功时原样返回网关的 base64 音频");
    ok(lastRequest.method === "POST" && lastRequest.url === SPEECH_URL, "默认打到 /v4/ai/speech-model");
    ok(lastRequest.header.Authorization === "Bearer vck_test_key_123", "带上 Bearer Key");
    ok(lastRequest.header["ai-model-id"] === "openai/tts-1", "模型放在 ai-model-id 请求头");
    ok(lastRequest.header["ai-speech-model-specification-version"] === "4" &&
        lastRequest.header["ai-gateway-protocol-version"] === "0.0.1",
        "带上 speech spec v4 与 protocol 0.0.1 头");
    ok(lastRequest.header["Content-Type"] === "application/json", "Content-Type 为 JSON，Bob 才会 JSON 编码 body");
    ok(lastRequest.body.text === "hello world" && lastRequest.body.voice === "alloy" &&
        lastRequest.body.outputFormat === "mp3",
        "OpenAI 默认：voice=alloy、outputFormat=mp3");
    ok(lastRequest.body.speed === undefined && lastRequest.body.instructions === undefined &&
        lastRequest.body.language === undefined,
        "1.0 倍速、空指令、OpenAI 不发 speed / instructions / language");
    ok(lastRequest.timeout === 50 && lastRequest.timeout < plugin.pluginTimeoutInterval(),
        "HTTP 超时早于 Bob 宿主超时");
    ok(r.result.raw.detected_format === "mp3" && r.result.raw.model === "openai/tts-1",
        "raw 里记录识别出的格式与模型");
    ok(loggedLine("success status=200 format=mp3"), "成功时写一条 success 日志");
    ok(!logs.some(function (l) { return l.indexOf("vck_test_key_123") >= 0; }), "日志里不出现 API Key");

    // 4. 文本会被 trim；空文本报 param
    nextResponse = audioResponse();
    await speak({ text: "  hi  ", lang: "en" });
    ok(lastRequest.body.text === "hi", "文本首尾空白被去掉");
    r = await speak({ text: "   ", lang: "en" });
    ok(r.error && r.error.type === "param", "空文本报 param");

    // 5. Gemini 家族：音色菜单、wav、指令、丢弃 speed
    withOptions({ model: "google/gemini-3.8-flash-tts", voiceGoogle: "Puck", speed: "1.25", instructions: "温柔一点" });
    nextResponse = audioResponse(WAV_B64);
    logs = [];
    r = await speak({ text: "你好", lang: "zh-Hans" });
    ok(lastRequest.header["ai-model-id"] === "google/gemini-3.8-flash-tts", "Gemini 模型写进 ai-model-id");
    ok(lastRequest.body.voice === "Puck" && lastRequest.body.outputFormat === "wav",
        "Gemini 读音色 · Gemini 菜单，自动格式为 wav");
    ok(lastRequest.body.instructions === "温柔一点", "Gemini 发送 instructions");
    ok(lastRequest.body.speed === undefined && loggedLine("参数丢弃（google/gemini-3.8-flash-tts 不支持）：speed"),
        "Gemini 不发 speed 并写日志");
    ok(lastRequest.body.language === undefined, "Gemini 不发 language");
    ok(r.result && r.result.raw.detected_format === "wav", "识别出 wav");

    withOptions({ model: "google/gemini-3.8-flash-lite-tts", outputFormat: "mp3" });
    nextResponse = audioResponse(WAV_B64);
    logs = [];
    await speak(EN);
    ok(lastRequest.body.outputFormat === "wav" && loggedLine("Gemini 不支持 mp3，改用 wav"),
        "Gemini 选 mp3 时改成 wav 并写日志");

    // 6. Grok 家族：音色、language 映射、speed 放行、指令丢弃
    withOptions({ model: "spacexai/grok-tts", voiceGrok: "rex", speed: "1.25", instructions: "whisper" });
    nextResponse = audioResponse();
    logs = [];
    await speak({ text: "你好", lang: "zh-Hans" });
    ok(lastRequest.body.voice === "rex" && lastRequest.body.outputFormat === "mp3", "Grok 读音色 · Grok 菜单，默认 mp3");
    ok(lastRequest.body.language === "zh", "Grok zh-Hans → language=zh");
    ok(lastRequest.body.speed === 1.25, "Grok 发送 speed（数字）");
    ok(lastRequest.body.instructions === undefined && loggedLine("instructions"), "Grok 不发 instructions 并写日志");

    nextResponse = audioResponse();
    await speak({ text: "olá", lang: "pt-br" });
    ok(lastRequest.body.language === "pt-BR", "Grok pt-br → pt-BR");
    nextResponse = audioResponse();
    await speak({ text: "hallo", lang: "af" });
    ok(lastRequest.body.language === undefined, "Grok 列表外的语言不发 language（交给自动识别）");

    withOptions({ model: "xai/grok-tts" });
    nextResponse = audioResponse();
    await speak(EN);
    ok(lastRequest.body.voice === "eve", "旧前缀 xai/ 也识别为 Grok 家族");

    // 7. Fish Audio（含 Drama 3）：默认不发 voice；菜单 reference ID；发送 speed，丢弃 instructions
    withOptions({ model: "fish-audio/s2.1-pro", speed: "1.5" });
    nextResponse = audioResponse();
    await speak(EN);
    ok(lastRequest.body.voice === undefined && lastRequest.body.outputFormat === "mp3",
        "Fish Audio 默认音色不发 voice，格式 mp3");
    ok(lastRequest.body.speed === 1.5, "Fish Audio S2.1 Pro 发送 speed（数字）");
    withOptions({ model: "fish-audio/drama-3", speed: "1.25", instructions: "sad" });
    nextResponse = audioResponse();
    logs = [];
    await speak(EN);
    ok(lastRequest.header["ai-model-id"] === "fish-audio/drama-3" &&
        lastRequest.body.voice === undefined &&
        lastRequest.body.outputFormat === "mp3" &&
        lastRequest.body.speed === 1.25 &&
        lastRequest.body.instructions === undefined &&
        loggedLine("参数丢弃（fish-audio/drama-3 不支持）：instructions"),
        "Fish Audio Drama 3 发送 speed，丢弃 instructions");
    withOptions({ model: "fish-audio/s1", voiceFish: "7f92f8afb8ec43bf81429cc1c9199cb1", speed: "0.75" });
    nextResponse = audioResponse();
    await speak(EN);
    ok(lastRequest.body.voice === "7f92f8afb8ec43bf81429cc1c9199cb1", "Fish Audio 菜单里的 reference ID 作为 voice");
    ok(lastRequest.body.speed === 0.75, "Fish Audio S1 发送 speed（数字）");
    withOptions({ model: "fish-audio/s2-pro", speed: "1.1" });
    nextResponse = audioResponse();
    await speak(EN);
    ok(lastRequest.body.speed === 1.1, "Fish Audio S2 Pro 发送 speed（数字）");
    withOptions({ model: "fish-audio/drama-3", speed: "1.0" });
    nextResponse = audioResponse();
    await speak(EN);
    ok(lastRequest.body.speed === undefined, "Fish Audio 1.0 倍速不发送 speed");

    // 7b. Microsoft MAI-Voice 家族：默认按语言自动选音色（发 language 不发 voice）；显式选音色则发 voice 不发 language
    withOptions({ model: "microsoft/mai-voice-2.1-flash", speed: "1.25", instructions: "cheerful" });
    nextResponse = audioResponse();
    logs = [];
    await speak({ text: "你好世界", lang: "zh-Hans" });
    ok(lastRequest.header["ai-model-id"] === "microsoft/mai-voice-2.1-flash", "Microsoft 模型写进 ai-model-id");
    ok(lastRequest.body.voice === undefined && lastRequest.body.language === "zh",
        "Microsoft 默认按语言自动选音色：zh-Hans 不发 voice、发送 language=zh");
    ok(lastRequest.body.outputFormat === "mp3" && lastRequest.body.speed === 1.25,
        "Microsoft 自动格式为 mp3 并放行 speed");
    ok(lastRequest.body.instructions === undefined && loggedLine("instructions"),
        "Microsoft 不发 instructions 并写日志");

    nextResponse = audioResponse();
    await speak({ text: "こんにちは", lang: "ja" });
    ok(lastRequest.body.voice === undefined && lastRequest.body.language === undefined,
        "Microsoft 默认列表外的语言不发 language（避免告警）");

    withOptions({ model: "microsoft/mai-voice-2.1", voiceMicrosoft: "zh-CN-Bo" });
    nextResponse = audioResponse();
    await speak(EN);
    ok(lastRequest.body.voice === "zh-CN-Bo" && lastRequest.body.language === undefined,
        "Microsoft 显式选定音色时只发 voice、不发冲突的 language");

    withOptions({ model: "microsoft/mai-voice-2", outputFormat: "flac" });
    nextResponse = audioResponse();
    logs = [];
    await speak(EN);
    ok(lastRequest.body.outputFormat === "mp3" && loggedLine("Microsoft MAI 不支持 flac，改用 mp3"),
        "Microsoft 选不支持的格式时退回 mp3 并写日志");

    // 8. 自定义模型 / 自定义音色优先
    withOptions({ customModel: "  fish-audio/s2.1-pro-free  ", customVoice: "  abc123  " });
    nextResponse = audioResponse();
    logs = [];
    await speak(EN);
    ok(lastRequest.header["ai-model-id"] === "fish-audio/s2.1-pro-free", "自定义模型 ID 优先且被 trim");
    ok(lastRequest.body.voice === "abc123", "自定义音色优先且被 trim");
    ok(loggedLine("model=fish-audio/s2.1-pro-free(custom)") && loggedLine("voice=abc123(custom)"),
        "日志记录模型与音色的来源");

    // 9. 识别不出家族的模型：不发 voice / outputFormat，用户填的 speed / instructions 照发
    withOptions({ customModel: "acme/super-tts", speed: "1.1", instructions: "cheerful" });
    nextResponse = audioResponse();
    await speak(EN);
    ok(lastRequest.body.voice === undefined && lastRequest.body.outputFormat === undefined,
        "未知家族默认不发 voice 与 outputFormat");
    ok(lastRequest.body.speed === 1.1 && lastRequest.body.instructions === "cheerful",
        "未知家族放行 speed 与 instructions，让网关 warnings 说话");
    withOptions({ customModel: "acme/super-tts", outputFormat: "wav", customVoice: "v1" });
    nextResponse = audioResponse();
    await speak(EN);
    ok(lastRequest.body.outputFormat === "wav" && lastRequest.body.voice === "v1",
        "未知家族显式选的格式与自定义音色原样发送");

    // 10. OpenAI 的 instructions 门控：tts-1 丢弃，gpt-* 放行
    withOptions({ instructions: "slowly" });
    nextResponse = audioResponse();
    logs = [];
    await speak(EN);
    ok(lastRequest.body.instructions === undefined && loggedLine("参数丢弃（openai/tts-1 不支持）：instructions"),
        "tts-1 不发 instructions 并写日志");
    withOptions({ customModel: "openai/gpt-4o-mini-tts", instructions: "slowly", voiceOpenai: "nova" });
    nextResponse = audioResponse();
    await speak(EN);
    ok(lastRequest.body.instructions === "slowly" && lastRequest.body.voice === "nova",
        "gpt-4o-mini-tts 发送 instructions 并沿用 OpenAI 音色菜单");

    // 11. 语速解析
    withOptions({ speed: "abc" });
    nextResponse = audioResponse();
    await speak(EN);
    ok(lastRequest.body.speed === undefined, "非数字语速不发送");
    withOptions({ speed: "0.75" });
    nextResponse = audioResponse();
    await speak(EN);
    ok(lastRequest.body.speed === 0.75, "0.75 倍速发送为数字");

    // 12. 字符上限按家族
    withOptions({});
    r = await speak({ text: new Array(4098).join("x"), lang: "en" });
    ok(r.error && r.error.type === "param" && r.error.message.indexOf("4096") > 0,
        "OpenAI 超过 4096 字报 param");
    withOptions({ model: "spacexai/grok-tts" });
    nextResponse = audioResponse();
    r = await speak({ text: new Array(5002).join("x"), lang: "en" });
    ok(r.result && lastRequest.body.text.length === 5001, "Grok 上限更高，5001 字放行");

    // 13. API 地址各种写法
    withOptions({ apiUrl: "https://proxy.example.com" });
    nextResponse = audioResponse();
    await speak(EN);
    ok(lastRequest.url === "https://proxy.example.com/v4/ai/speech-model", "基础地址自动补 /v4/ai/speech-model");
    withOptions({ apiUrl: "https://proxy.example.com/v4/ai/speech-model/" });
    nextResponse = audioResponse();
    await speak(EN);
    ok(lastRequest.url === "https://proxy.example.com/v4/ai/speech-model", "完整地址不重复补路径，去掉末尾斜杠");
    withOptions({ apiUrl: "https://proxy.example.com/gateway/v4" });
    nextResponse = audioResponse();
    await speak(EN);
    ok(lastRequest.url === "https://proxy.example.com/gateway/v4/ai/speech-model", "以 /v4 结尾的地址补 /ai/speech-model");
    withOptions({ apiUrl: "proxy.example.com" });
    nextResponse = audioResponse();
    await speak(EN);
    ok(lastRequest.url === "https://proxy.example.com/v4/ai/speech-model", "没写协议时默认 https");
    withOptions({ apiUrl: "http://localhost:8787" });
    nextResponse = audioResponse();
    await speak(EN);
    ok(lastRequest.url === "http://localhost:8787/v4/ai/speech-model", "本机地址允许 HTTP");
    withOptions({ apiUrl: "http://proxy.example.com" });
    r = await speak(EN);
    ok(r.error && r.error.type === "param" && r.error.message.indexOf("HTTPS") > 0, "远程 HTTP 地址被拒绝");
    withOptions({ apiUrl: "http://127.999.0.1:8787" });
    r = await speak(EN);
    ok(r.error && r.error.type === "param", "越界 IPv4 段 127.999.0.1 不当作本机回环放行");
    withOptions({ apiUrl: "https://proxy.example.com/v4?x=1" });
    r = await speak(EN);
    ok(r.error && r.error.type === "param", "带 query 的地址被拒绝");
    withOptions({ apiUrl: "https://user:pw@proxy.example.com" });
    r = await speak(EN);
    ok(r.error && r.error.type === "param", "带用户名密码的地址被拒绝");

    // 14. HTTP 错误映射（网关格式 { error: { message, type } }）
    withOptions({});
    nextResponse = gatewayError(401, "Authentication failed. Check that your Vercel credential is valid and has access to AI Gateway.", "authentication_error");
    r = await speak(EN);
    ok(r.error && r.error.type === "secretKey" && r.error.message.indexOf("Authentication failed") > 0,
        "401 authentication_error 映射为 secretKey 并带上网关原文");
    ok(r.error.message.indexOf("vercel.com/docs/ai-gateway/authentication-and-byok/api-keys") > 0,
        "401 报错里明文写出 API Key 文档地址");

    nextResponse = gatewayError(403, "forbidden", "permission_error");
    r = await speak(EN);
    ok(r.error && r.error.type === "secretKey" && r.error.message.indexOf("beta") > 0,
        "403 提示可能是团队未开放 TTS beta");

    nextResponse = gatewayError(402, "Insufficient credits");
    r = await speak(EN);
    ok(r.error && r.error.type === "api" && r.error.message.indexOf("额度") >= 0, "402 提示额度不足");

    nextResponse = gatewayError(404, "model not found", "not_found_error");
    r = await speak(EN);
    ok(r.error && r.error.type === "notFound" && r.error.message.indexOf("openai/tts-1") > 0,
        "404 映射为 notFound 并带上实际发出的模型 ID");

    nextResponse = gatewayError(400, "voice 'foo' is not supported", "invalid_request_error");
    r = await speak(EN);
    ok(r.error && r.error.type === "param" && r.error.message.indexOf("voice 'foo'") > 0,
        "400 映射为 param 并带出网关说明");

    nextResponse = gatewayError(429, "rate limited", "rate_limit_error");
    r = await speak(EN);
    ok(r.error && r.error.type === "api" && r.error.message.indexOf("频繁") > 0, "429 提示稍后重试");

    nextResponse = gatewayError(503, "upstream unavailable");
    r = await speak(EN);
    ok(r.error && r.error.type === "api" && r.error.message.indexOf("503") > 0, "5xx 报 api 并带状态码");

    nextResponse = textResponse(418, "I'm a teapot", "text/plain");
    r = await speak(EN);
    ok(r.error && r.error.type === "api" && r.error.message.indexOf("418") > 0 && r.error.message.indexOf("teapot") > 0,
        "非 JSON 错误体也能带出原文");

    // 15. 2xx 但响应不对
    nextResponse = jsonResponse(200, { warnings: [] });
    r = await speak(EN);
    ok(r.error && r.error.type === "api" && r.error.message.indexOf("audio") > 0, "2xx 缺 audio 字段时报错");
    nextResponse = textResponse(200, "<html>gateway</html>", "text/html; charset=utf-8");
    r = await speak(EN);
    ok(r.error && r.error.type === "api" && r.error.message.indexOf("不是 JSON") > 0, "2xx HTML 页不会被当成音频");
    nextResponse = jsonResponse(200, { audio: "not base64!!" });
    r = await speak(EN);
    ok(r.error && r.error.type === "api", "非法 base64 报错");
    nextResponse = jsonResponse(200, { audio: "" });
    r = await speak(EN);
    ok(r.error && r.error.type === "api", "空音频报错");

    // Base64 可省略整个 padding，但已有 padding 必须完整且尾部未使用位为零。
    var onePadAudio = base64([0x49, 0x44, 0x33, 0x00, 0x00]);
    var validBase64 = [
        { audio: MP3_B64, expected: MP3_B64, label: "合法双 padding" },
        { audio: onePadAudio, expected: onePadAudio, label: "合法单 padding" },
        { audio: RAW_MPEG_B64, expected: RAW_MPEG_B64, label: "完整三字节分组无 padding" },
        { audio: MP3_B64.slice(0, -2), expected: MP3_B64, label: "省略双 padding 时补齐" },
        { audio: onePadAudio.slice(0, -1), expected: onePadAudio, label: "省略单 padding 时补齐" },
        { audio: " \n" + MP3_B64.slice(0, 8) + "\t" + MP3_B64.slice(8) + "\r\n", expected: MP3_B64, label: "忽略音频中的空白" },
        { audio: "data:audio/mpeg;base64,\n" + onePadAudio.slice(0, -1) + " ", expected: onePadAudio, label: "data URI 可带空白与未填充音频" }
    ];
    for (var i = 0; i < validBase64.length; i++) {
        var valid = validBase64[i];
        nextResponse = jsonResponse(200, { audio: valid.audio });
        r = await speak(EN);
        ok(r.result && r.result.value === valid.expected, valid.label);
    }
    var invalidBase64 = ["A", "AAAA==", "AA=", "AA===", "=AAA", "AA=A", "AAAA=", "AB==", "AAB=", "AB", "AAB", "===="];
    for (var j = 0; j < invalidBase64.length; j++) {
        nextResponse = jsonResponse(200, { audio: invalidBase64[j] });
        r = await speak(EN);
        ok(r.error && r.error.type === "api", "拒绝损坏的 base64：" + invalidBase64[j]);
    }
    var largeAudio = RAW_MPEG_B64 + new Array(262145).join("AAAA");
    nextResponse = jsonResponse(200, { audio: largeAudio });
    r = await speak(EN);
    ok(r.result && r.result.value === largeAudio, "超过 1 MB 的 base64 可正常校验");

    nextResponse = jsonResponse(200, { audio: "data:audio/mpeg;base64," + MP3_B64 });
    r = await speak(EN);
    ok(r.result && r.result.value === MP3_B64, "data: URI 前缀被剥掉");
    nextResponse = textResponse(200, JSON.stringify({ audio: WAV_B64 }), "application/json");
    r = await speak(EN);
    ok(r.result && r.result.value === WAV_B64, "Bob 没自动解析 JSON 时也能手动解析");
    nextResponse = { response: { statusCode: 200 }, data: makeData(utf8Bytes(JSON.stringify({ audio: MP3_B64 }))) };
    r = await speak(EN);
    ok(r.result && r.result.value === MP3_B64, "响应体是 $data 时也能解析");

    // 16. warnings 与格式嗅探
    nextResponse = audioResponse(MP3_B64, [{ type: "unsupported", setting: "speed", details: "not supported" }]);
    logs = [];
    r = await speak(EN);
    ok(loggedLine("gateway warnings: unsupported speed not supported"), "网关 warnings 写进日志");
    ok(r.result && r.result.raw.warnings.length === 1, "warnings 放进 raw");
    nextResponse = audioResponse(RAW_MPEG_B64);
    r = await speak(EN);
    ok(r.result && r.result.raw.detected_format === "mp3", "无 ID3 头的裸 MPEG 帧识别为 mp3");
    nextResponse = audioResponse(AAC_B64);
    r = await speak(EN);
    ok(r.result && r.result.raw.detected_format === "aac", "ADTS 识别为 aac");
    nextResponse = audioResponse(OGG_B64);
    logs = [];
    r = await speak(EN);
    ok(r.result && r.result.raw.detected_format === "ogg" && loggedLine("Ogg"), "Ogg 仍返回但写警告");
    nextResponse = audioResponse(PCM_B64);
    logs = [];
    r = await speak(EN);
    ok(r.result && r.result.raw.detected_format === "unknown" && loggedLine("无法识别音频容器"),
        "识别不出的容器仍返回但写警告");

    // 17. 网络错误
    nextResponse = { error: { message: "timed out" }, response: null };
    r = await speak(EN);
    ok(r.error && r.error.type === "network" && r.error.message.indexOf("timed out") > 0, "网络失败映射为 network");
    nextResponse = { response: null, data: null };
    r = await speak(EN);
    ok(r.error && r.error.type === "network", "缺失 HTTP 响应时也映射为 network");
    nextResponse = gatewayError(401, "bad key", "authentication_error");
    nextResponse.error = { message: "Request failed: unauthorized (401)" };
    r = await speak(EN);
    ok(r.error && r.error.type === "secretKey" && r.error.message.indexOf("bad key") > 0,
        "非 2xx 同时带 error 时仍按状态码映射");
    nextResponse = audioResponse();
    nextResponse.error = { message: "connection lost" };
    r = await speak(EN);
    ok(r.error && r.error.type === "network" && r.error.message.indexOf("connection lost") > 0,
        "2xx 但带 error 时报 network");
    nextResponse = Promise.reject(null);
    r = await speak(EN);
    ok(r.error && r.error.type === "unknown", "运行时抛出 null 时也能稳定回传错误");
    nextResponse = Promise.reject(new TypeError("boom"));
    r = await speak(EN);
    ok(r.error && r.error.type === "unknown" && r.error.message.indexOf("boom") > 0, "运行时异常带出原因");

    // 18. 日志打码：网关原文里若带 Key 也不会进日志
    nextResponse = gatewayError(400, "bad header Bearer vck_leaked_secret_value", "invalid_request_error");
    logs = [];
    r = await speak(EN);
    ok(logs.length > 0 && !logs.some(function (l) { return l.indexOf("vck_leaked") >= 0; }),
        "日志里的 Bearer / vck_ 都被打码");

    // 19. pluginValidate：用两个字符真实合成验证
    withOptions({});
    nextResponse = audioResponse();
    var v = await validate();
    ok(v.result === true && v.error === undefined, "pluginValidate 在真实合成成功时通过");
    ok(lastRequest.body.text === "Hi" && lastRequest.timeout === 20, "pluginValidate 用 Hi 探测且超时更短");
    nextResponse = gatewayError(401, "bad key", "authentication_error");
    v = await validate();
    ok(v.result === false && v.error && v.error.type === "secretKey", "pluginValidate 在 401 时报 secretKey");
    nextResponse = gatewayError(401, "bad key", "authentication_error");
    nextResponse.error = { message: "Request failed: unauthorized (401)" };
    v = await validate();
    ok(v.result === false && v.error && v.error.type === "secretKey",
        "pluginValidate 在 401 且带 error 时仍报 secretKey");
    nextResponse = textResponse(200, "<html>gateway</html>", "text/html");
    v = await validate();
    ok(v.result === false && v.error && v.error.type === "api", "pluginValidate 不把 2xx HTML 误判为可用");
    nextResponse = jsonResponse(200, { audio: MP3_B64.slice(0, -3) + "B==" });
    v = await validate();
    ok(v.result === false && v.error && v.error.type === "api", "pluginValidate 拒绝有音频头但尾位损坏的 base64");
    nextResponse = { response: null, data: null };
    v = await validate();
    ok(v.result === false && v.error && v.error.type === "network", "pluginValidate 缺失响应时报 network");
    withOptions({ apiKey: "" });
    v = await validate();
    ok(v.result === false && v.error && v.error.type === "secretKey", "pluginValidate 缺 Key 时报 secretKey");
    withOptions({ apiUrl: "http://proxy.example.com" });
    v = await validate();
    ok(v.result === false && v.error && v.error.type === "param", "pluginValidate 地址不合法时报 param");

    // 20. 菜单为空时的兜底
    withOptions({ model: "", voiceOpenai: "" });
    nextResponse = audioResponse();
    await speak(EN);
    ok(lastRequest.header["ai-model-id"] === "openai/tts-1" && lastRequest.body.voice === "alloy",
        "模型 / 音色为空时回落到默认值");

    print("");
    if (failures.length === 0) {
        print("ALL PASS (" + checks + " checks)");
    } else {
        print("FAILED " + failures.length + "/" + checks);
    }
})();
