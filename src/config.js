// Vercel AI Gateway 语音合成的静态元信息。
//
// info.json 里的模型菜单可以用 scripts/sync_models.py 从网关公开目录同步
// （GET https://ai-gateway.vercel.sh/v1/models，筛 type == "speech"，不需要 Key），
// 但「模型能力」这类目录不返回的信息在这里手工维护。

var DEFAULT_API_BASE = "https://ai-gateway.vercel.sh";
// 网关的 speech 端点。它不是 OpenAI 兼容的 /v1/audio/speech，而是 AI SDK 的
// speech-model 协议：模型放在 ai-model-id 请求头里，音频以 base64 放在 JSON 的 audio 字段。
var SPEECH_PATH = "/v4/ai/speech-model";
var DEFAULT_MODEL = "openai/tts-1";

// 音色菜单里代表「不发送 voice、用提供方默认音色或按语言自动选音色」的哨兵值（Microsoft / Fish Audio 用）
var PROVIDER_DEFAULT_VOICE = "default";

// 各模型家族的能力（2026-10-18 依据 Vercel 文档与各家 API 文档整理）。
//
// 网关对不支持的选项通常只在响应 warnings 里报告而不报错，但有几处不能赌：
//   - instructions 发给 OpenAI tts-1 / tts-1-hd 会被上游拒绝（仅 gpt-* 系列支持）
//   - language 发给 Grok 时必须在其列表内，否则 400
//   - Microsoft MAI-Voice 同时传具体 voice 与不一致的 language，或传列表外的 language 会产生告警并回退英文
// 所以插件按家族门控，只发确实支持的字段，其余丢弃并写日志。
//
//   voiceOption    info.json 里对应的音色菜单
//   defaultVoice   菜单为空时的兜底
//   defaultFormat  outputFormat 选「自动」时用的格式；null 表示不发送、由提供方决定
//   formats        可发送的 outputFormat 白名单；null 表示不校验
//   speed          是否支持 speed 参数
//   instructions   是否支持 instructions；"gpt-only" 表示仅 gpt-* 系列
//   language       是否支持 language 参数
//   charLimit      单次文本字符上限（保守取值，超过直接报 param 而不是等上游报错）
var FAMILIES = {
    openai: {
        label: "OpenAI",
        voiceOption: "voiceOpenai",
        defaultVoice: "alloy",
        defaultFormat: "mp3",
        formats: ["mp3", "wav", "opus", "aac", "flac", "pcm"],
        speed: true,
        instructions: "gpt-only",
        language: false,
        charLimit: 4096
    },
    google: {
        label: "Gemini",
        voiceOption: "voiceGoogle",
        defaultVoice: "Kore",
        // Gemini 默认返回带头的 WAV；不支持 mp3、speed、language（官方文档明确）
        defaultFormat: "wav",
        formats: ["wav", "pcm", "mulaw", "alaw"],
        speed: false,
        instructions: true,
        language: false,
        charLimit: 8000
    },
    microsoft: {
        label: "Microsoft MAI",
        voiceOption: "voiceMicrosoft",
        defaultVoice: PROVIDER_DEFAULT_VOICE,
        // MAI-Voice 默认返回 24kHz MP3，支持 mp3 / wav / pcm / opus；支持 speed，不支持 instructions
        defaultFormat: "mp3",
        formats: ["mp3", "wav", "pcm", "opus"],
        speed: true,
        instructions: false,
        language: true,
        charLimit: 8000
    },
    grok: {
        label: "Grok",
        voiceOption: "voiceGrok",
        defaultVoice: "eve",
        defaultFormat: "mp3",
        formats: ["mp3", "wav", "pcm", "mulaw", "alaw"],
        // xAI 文档：speed 0.7~1.5，language 限定列表，风格靠文本里的行内标签
        speed: true,
        instructions: false,
        language: true,
        charLimit: 15000
    },
    fish: {
        label: "Fish Audio",
        voiceOption: "voiceFish",
        defaultVoice: PROVIDER_DEFAULT_VOICE,
        defaultFormat: "mp3",
        formats: ["mp3", "wav", "pcm", "opus"],
        // AI SDK 将 speed 映射为 Fish Audio prosody.speed（0.5~2）
        speed: true,
        instructions: false,
        language: false,
        charLimit: 8000
    },
    // 识别不出家族的自定义模型：用户填什么就发什么，让网关的 warnings / 错误说话
    custom: {
        label: "自定义",
        voiceOption: null,
        defaultVoice: "",
        defaultFormat: null,
        formats: null,
        speed: true,
        instructions: true,
        language: false,
        charLimit: 4096
    }
};

// 按模型 ID 识别家族。网关里 xAI 的目录前缀是 spacexai/，旧文档写 xai/，两个都认。
function getModelFamily(model) {
    var value = String(model || "").toLowerCase();
    if (value.indexOf("openai/") === 0) {
        return "openai";
    }
    if (value.indexOf("google/") === 0 || value.indexOf("gemini") !== -1) {
        return "google";
    }
    if (value.indexOf("microsoft/") === 0 || value.indexOf("mai-voice") !== -1) {
        return "microsoft";
    }
    if (value.indexOf("spacexai/") === 0 || value.indexOf("xai/") === 0 || value.indexOf("grok") !== -1) {
        return "grok";
    }
    if (value.indexOf("fish-audio/") === 0 || value.indexOf("fish") !== -1) {
        return "fish";
    }
    return "custom";
}

function familyInfo(family) {
    return FAMILIES[family] || FAMILIES.custom;
}

function modelAcceptsInstructions(family, model) {
    var flag = familyInfo(family).instructions;
    if (flag === "gpt-only") {
        return /(^|\/)gpt-/i.test(String(model || ""));
    }
    return !!flag;
}

// 用户选的格式 → 实际发送的 outputFormat。「自动」按家族默认；家族白名单外的格式
// 退回家族默认并带一条说明（写日志），不让请求带着注定被忽略的格式出去。
function resolveOutputFormat(family, requested) {
    var info = familyInfo(family);
    var want = String(requested || "").trim().toLowerCase();
    if (!want || want === "auto") {
        return { format: info.defaultFormat || "", note: "" };
    }
    if (info.formats && info.formats.indexOf(want) === -1) {
        return {
            format: info.defaultFormat || "",
            note: info.label + " 不支持 " + want + "，改用 " + (info.defaultFormat || "提供方默认格式")
        };
    }
    return { format: want, note: "" };
}

// Bob 语言代码 -> BCP-47 / ISO 639-1。
// 网关的 TTS 模型都是多语言自动识别，这张表主要决定 supportLanguages() 返回什么：
// 返回并集——某个模型不原生支持时最多是口音不准，不该直接判定为「不支持」。
var LANGUAGES = [
    ["zh-Hans", "zh"],
    ["zh-Hant", "zh"],
    ["yue", "zh"],
    ["wyw", "zh"],
    ["en", "en"],
    ["ja", "ja"],
    ["ko", "ko"],
    ["de", "de"],
    ["hi", "hi"],
    ["fr", "fr"],
    ["pt", "pt"],
    ["pt-pt", "pt"],
    ["pt-br", "pt"],
    ["it", "it"],
    ["es", "es"],
    ["id", "id"],
    ["nl", "nl"],
    ["tr", "tr"],
    ["fil", "fil"],
    ["tl", "fil"],
    ["pl", "pl"],
    ["sv", "sv"],
    ["bg", "bg"],
    ["ro", "ro"],
    ["ar", "ar"],
    ["cs", "cs"],
    ["el", "el"],
    ["fi", "fi"],
    ["hr", "hr"],
    ["ms", "ms"],
    ["sk", "sk"],
    ["da", "da"],
    ["ta", "ta"],
    ["uk", "uk"],
    ["ru", "ru"],
    ["hu", "hu"],
    ["no", "no"],
    ["nb", "no"],
    ["vi", "vi"],
    ["af", "af"],
    ["hy", "hy"],
    ["as", "as"],
    ["az", "az"],
    ["be", "be"],
    ["bn", "bn"],
    ["bs", "bs"],
    ["ca", "ca"],
    ["ceb", "ceb"],
    ["ny", "ny"],
    ["et", "et"],
    ["gl", "gl"],
    ["ka", "ka"],
    ["gu", "gu"],
    ["ha", "ha"],
    ["he", "he"],
    ["is", "is"],
    ["ga", "ga"],
    ["jv", "jv"],
    ["jw", "jv"],
    ["kn", "kn"],
    ["kk", "kk"],
    ["ky", "ky"],
    ["lv", "lv"],
    ["ln", "ln"],
    ["lt", "lt"],
    ["lb", "lb"],
    ["mk", "mk"],
    ["ml", "ml"],
    ["mr", "mr"],
    ["ne", "ne"],
    ["ps", "ps"],
    ["fa", "fa"],
    ["pa", "pa"],
    ["sr", "sr"],
    ["sr-Cyrl", "sr"],
    ["sr-Latn", "sr"],
    ["sd", "sd"],
    ["sl", "sl"],
    ["so", "so"],
    ["sw", "sw"],
    ["te", "te"],
    ["th", "th"],
    ["ur", "ur"],
    ["cy", "cy"]
];

// Grok 的 language 参数只认这份列表（xAI 文档：auto, en, ar-EG, ar-SA, ar-AE, bn, zh,
// fr, de, hi, id, it, ja, ko, pt-BR, pt-PT, ru, es-MX, es-ES, tr, vi）。
// 表外的 Bob 语言不发 language，让 Grok 自动识别；阿拉伯语 Bob 只有一个 ar，
// 分不出地区变体，同样交给自动识别。
var GROK_LANGUAGE_BY_BOB = {
    "zh-Hans": "zh",
    "zh-Hant": "zh",
    "yue": "zh",
    "wyw": "zh",
    "en": "en",
    "ja": "ja",
    "ko": "ko",
    "fr": "fr",
    "de": "de",
    "hi": "hi",
    "id": "id",
    "it": "it",
    "ru": "ru",
    "tr": "tr",
    "vi": "vi",
    "bn": "bn",
    "pt": "pt-PT",
    "pt-pt": "pt-PT",
    "pt-br": "pt-BR",
    "es": "es-ES"
};

// Microsoft MAI-Voice 在不传 voice 时靠 language 自动挑对应语种的默认音色
// （AI SDK Azure 文档：de, en, es, fr, hi, hu, it, ko, nl, pt, ro, ru, th, tr, zh；
// 其余语言若传了会产生告警并回退 en-US-Harper，因此仅对这 15 种语言发 language）。
var MICROSOFT_LANGUAGE_BY_BOB = {
    "zh-Hans": "zh",
    "zh-Hant": "zh",
    "yue": "zh",
    "wyw": "zh",
    "en": "en",
    "de": "de",
    "es": "es",
    "fr": "fr",
    "hi": "hi",
    "hu": "hu",
    "it": "it",
    "ko": "ko",
    "nl": "nl",
    "pt": "pt",
    "pt-pt": "pt",
    "pt-br": "pt",
    "ro": "ro",
    "ru": "ru",
    "th": "th",
    "tr": "tr"
};

var langMap = new Map(LANGUAGES.map(function (item) {
    return [item[0], item[1]];
}));

// 该家族应发送的 language 值；空字符串表示不发送。
// Microsoft MAI-Voice 的音色名自带地区（如 zh-CN-Mei），一旦显式指定了 voice 就不再发 language，避免冲突告警。
function languageParam(family, bobLang, voiceId) {
    if (!familyInfo(family).language) {
        return "";
    }
    if (family === "grok") {
        return GROK_LANGUAGE_BY_BOB[bobLang] || "";
    }
    if (family === "microsoft") {
        if (voiceId) {
            return "";
        }
        return MICROSOFT_LANGUAGE_BY_BOB[bobLang] || "";
    }
    return langMap.get(bobLang) || "";
}

exports.DEFAULT_API_BASE = DEFAULT_API_BASE;
exports.SPEECH_PATH = SPEECH_PATH;
exports.DEFAULT_MODEL = DEFAULT_MODEL;
exports.PROVIDER_DEFAULT_VOICE = PROVIDER_DEFAULT_VOICE;
exports.FAMILIES = FAMILIES;
exports.LANGUAGES = LANGUAGES;
exports.GROK_LANGUAGE_BY_BOB = GROK_LANGUAGE_BY_BOB;
exports.MICROSOFT_LANGUAGE_BY_BOB = MICROSOFT_LANGUAGE_BY_BOB;
exports.langMap = langMap;
exports.getModelFamily = getModelFamily;
exports.familyInfo = familyInfo;
exports.modelAcceptsInstructions = modelAcceptsInstructions;
exports.resolveOutputFormat = resolveOutputFormat;
exports.languageParam = languageParam;
