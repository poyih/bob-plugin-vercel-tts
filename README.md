# Vercel AI Gateway 语音合成 · Bob 插件

给 [Bob](https://bobtranslate.com) 用的 TTS 插件，通过 [Vercel AI Gateway](https://vercel.com/ai-gateway) 一个 Key 调用目录里全部语音合成模型：OpenAI TTS-1 / TTS-1 HD、Gemini 3.8 Flash / Flash-Lite TTS、Grok TTS、Fish Audio S1 / S2 Pro / S2.1 Pro。划词之后直接用 AI 语音朗读。

> 语音合成在 AI Gateway 上仍是 beta，官方说明「access is rolling out gradually」。如果验证时报 403 / 404，多半是你的团队还没被放开，而不是插件配置有误。

## 特点

**一个 Key 换着用八个模型。** 网关的 speech 端点不是 OpenAI 兼容的 `/v1/audio/speech`，而是 AI SDK 的 speech-model 协议：模型放在 `ai-model-id` 请求头，音频以 base64 放在 JSON 的 `audio` 字段。插件封装了这套协议，切模型只需要换菜单。

**按模型家族门控参数。** Gemini 不支持 mp3 / speed / language，OpenAI tts-1 不接受 instructions，Grok 的 language 只认固定列表——插件按模型 ID 前缀识别家族，只发确实支持的字段，其余丢弃并写日志，不让请求带着注定被拒绝的参数出去。网关自己返回的 `warnings` 也会记进日志。

**错误不会被吞掉。** 失败时网关返回的是 JSON，不检查状态码就直接播放，表现是「点了没声音也没报错」。这里把 HTTP 状态码和 `error.type` 一起映射成 Bob 的错误类型：Key 无效、额度不足、模型不存在 / 团队未开放、参数被拒、限流，各报各的；2xx 但不是 `{ audio }` 形态（代理返回 HTML、字段改名、音频为空）同样报错。返回的音频还会嗅探容器格式写进日志，遇到 macOS 播不了的 Ogg 会提醒。

**模型列表过期也不影响使用。** 除了内置菜单，还有自定义模型 ID 和自定义音色输入框，优先级更高——目录里刚上架的模型、fish.audio 音色库的任意 reference ID 都能直接填。`make sync` 能从网关公开目录同步模型菜单，不需要 Key。

**可测试、可发布。** `make test` 用 macOS 自带的 jsc——也就是 Bob 跑插件的同一个 JavaScriptCore——桩掉 `$http` / `$option` / `$log` 跑 90 多个用例，不联网、不消耗额度。工具链只用 Makefile 和标准库 Python，无需 Node。

## 安装

从 [Releases](https://github.com/poyih/bob-plugin-vercel-tts/releases) 下载 `.bobplugin` 双击安装，或者本地构建：

```bash
make install
```

装好后在 Bob 的「服务」里添加「Vercel AI Gateway 语音合成」，填 API Key 即可。API Key 在 Vercel 控制台 → 团队 → **AI Gateway → API Keys** 里 Create key（形如 `vck_...`），团队需要有 AI Gateway 额度。Bob 验证配置时会用两个字符真实合成一次，用来确认 Key、团队是否开通 TTS、当前模型和音色确实可用。

## 设置项

| 选项 | 说明 |
|---|---|
| API Key | 密文输入，只发给下方 API 地址 |
| API 地址 | 默认 `https://ai-gateway.vercel.sh`，一般不用改。走代理可填基础地址或完整的 `/v4/ai/speech-model`；远程地址必须 HTTPS（仅 `localhost` / `127.x` / `[::1]` 可用 HTTP） |
| 模型 | 默认 OpenAI TTS-1（快、便宜，适合划词朗读）。八个模型见下表 |
| 自定义模型 ID | 填了就优先生效，用于菜单里还没有的模型（例如 `fish-audio/s2.1-pro-free`） |
| 音色 · OpenAI / Gemini / Grok / Fish Audio | 四个家族各一个菜单。Bob 的设置项是静态显示的，四个菜单会同时出现，插件只读当前模型家族那一个 |
| 自定义音色 | 填了就优先生效，覆盖所有音色菜单。OpenAI / Grok 填音色名，Gemini 填 `Kore` 这类名称，Fish Audio 填 32 位 reference ID |
| 音频格式 | 默认「自动」：OpenAI / Grok / Fish Audio 用 mp3，Gemini 用 wav。也可强制 mp3 / wav（Gemini 选 mp3 会被改成 wav） |
| 语速 | 仅在非 1.0 时发送；OpenAI 与 Grok 支持，Gemini 与 Fish Audio 不支持（插件不发送） |
| 语音指令 | 控制语气 / 情绪 / 节奏，不会被朗读。Gemini 支持；OpenAI tts-1 / tts-1-hd、Grok、Fish Audio 不支持（插件不发送）。Grok 与 Fish Audio 可直接在待朗读文本里写行内标签 |

## 模型与音色

| 模型 | Gateway ID | 音色菜单 | 自动格式 | 语速 | 指令 | 价格（2026-09-25 目录） |
|---|---|---|---|---|---|---|
| OpenAI TTS-1 | `openai/tts-1` | 音色 · OpenAI（9 个） | mp3 | ✓ | ✗ | $15 / 百万字符 |
| OpenAI TTS-1 HD | `openai/tts-1-hd` | 音色 · OpenAI | mp3 | ✓ | ✗ | $30 / 百万字符 |
| Gemini 3.8 Flash TTS | `google/gemini-3.8-flash-tts` | 音色 · Gemini（30 个） | wav | ✗ | ✓ | 输入 $0.5 + 音频输出 $9 / 百万 token |
| Gemini 3.8 Flash-Lite TTS | `google/gemini-3.8-flash-lite-tts` | 音色 · Gemini | wav | ✗ | ✓ | 输入 $0.5 + 音频输出 $6 / 百万 token |
| Grok TTS | `spacexai/grok-tts` | 音色 · Grok（5 个） | mp3 | ✓（0.7~1.5） | ✗，用文本里的行内标签 | $15 / 百万字符 |
| Fish Audio S2.1 Pro | `fish-audio/s2.1-pro` | 音色 · Fish Audio | mp3 | ✗ | ✗，S2 系列用行内标签 | $15 / 百万字符 |
| Fish Audio S2 Pro | `fish-audio/s2-pro` | 音色 · Fish Audio | mp3 | ✗ | ✗ | $15 / 百万字符 |
| Fish Audio S1 | `fish-audio/s1` | 音色 · Fish Audio | mp3 | ✗ | ✗，用情绪 / 音效标记 | $15 / 百万字符 |

家族按模型 ID 识别：`openai/` → OpenAI；`google/` 或含 `gemini` → Gemini；`spacexai/`、`xai/` 或含 `grok` → Grok；`fish-audio/` 或含 `fish` → Fish Audio；其余视为自定义家族——不发 voice 与 outputFormat（除非你在自定义音色 / 音频格式里明确填了），speed 与 instructions 照发，让网关的 warnings 说话。

Fish Audio 选「默认音色」时不发送 voice，由 Fish Audio 决定；其他音色到 [fish.audio](https://fish.audio/app/discovery) 音色页点 **Copy Model Id**，把 reference ID 填到「自定义音色」。菜单里预置的两个中文音色沿用自 OpenRouter TTS 插件。

Grok 只在 Bob 语言能映射到其 `language` 列表（zh / en / ja / ko / fr / de / hi / id / it / ru / tr / vi / bn / pt-PT / pt-BR / es-ES）时才发送 language，其余交给自动识别。

## 常见报错

| 提示 | 原因 |
|---|---|
| 请先在插件设置里填写 Vercel AI Gateway API Key | Key 为空 |
| AI Gateway 认证失败，请检查 API Key | HTTP 401 / `authentication_error`：Key 填错、已撤销，或创建它的成员已离开团队（Vercel 会停用其 Key） |
| 当前 API Key 或团队无权访问该资源 | HTTP 403：多半是团队尚未被放开 TTS beta |
| 模型 xxx 不存在或不可用 | HTTP 404：模型 ID 写错，或 TTS 模型还没出现在你团队的目录里。用 `make sync -- --dry-run` 可以看当前目录 |
| AI Gateway 额度不足或超出预算 | HTTP 402 或错误码含 credit / budget：去 AI Gateway 控制台充值或调整 Key 预算 |
| 请求被网关拒绝 | HTTP 400 / 422，后面会带网关原文，常见是音色名不属于当前模型 |
| 请求过于频繁或超出速率限制 | HTTP 429 |
| 文本长度 N 超过 xxx 的单次上限 | 各家族上限不同（OpenAI 4096、Gemini / Fish Audio 8000、Grok 15000），分段朗读即可 |
| AI Gateway 返回的不是 JSON / 响应里没有 audio 字段 | 2xx 但响应形态不对，通常是代理或网关改动；日志里有响应片段 |

报错弹窗里的链接是纯文本，插件已把地址明文写进提示。排查时看 Bob 日志：

```bash
grep -rh 'vercel-tts' ~/Library/Containers/com.hezongyidev.Bob/Data/Documents/MMKitLogs/MMLogs/Default/ | tail -20
```

日志文件名带空格且按天滚动，所以用 `-r` 搜整个目录而不是 `*.log` 通配。如果终端报 `no matches found` 或 `Permission denied`，多半是那个终端 App 没有「完全磁盘访问权限」，换 Bob 偏好设置里的「打开日志目录」。每次合成都会写 `start`（实际发出的模型 / 音色 / 格式 / 参数）与 `success` / `failed` 两行，被丢弃的参数和网关 warnings 也在里面。日志里的 Key 会被打码。

## 开发

```bash
make test       # 语法检查 + info.json 校验 + jsc 单测
make pack       # 打包到 dist/，并打印 sha256
make install    # 打包并交给 Bob 安装
make appcast DESC="更新说明"   # 把 dist/ 里的包登记进 appcast.json
make sync       # 从网关公开目录同步 TTS 模型菜单（不需要 Key；SYNC_ARGS=--replace 整体重写标题）
```

发版：改 `src/info.json` 的 `version` → `make pack` → 在 GitHub 创建 `v<version>` Release 并上传 `dist/*.bobplugin` → `make appcast DESC="..."` → 提交 `appcast.json`。Bob 靠 `appcast.json` 检查更新，下载地址默认指向 `https://github.com/poyih/bob-plugin-vercel-tts/releases/download/v<version>/<包名>`。

> 如果你的 GitHub 用户名不是 `poyih`，需要改：`src/info.json` 的 `homepage` / `appcast`、`scripts/update_appcast.py` 的 `DEFAULT_REPO`。

## 结构

```
src/
  info.json   插件元信息与设置项
  main.js     tts / pluginValidate / supportLanguages、请求组装、错误映射、响应校验
  config.js   网关地址、各家族能力（音色菜单、默认格式、speed / instructions / language 支持、字符上限）、Bob↔BCP-47 语言映射
  icon.png    插件图标
scripts/
  test_plugin.js     jsc 测试（桩掉 $http / $data / $option / $log）
  check_info.py      校验 info.json，并核对选项 identifier 与 JS 里读取的一致
  update_appcast.py  打包后登记 appcast.json
  sync_models.py     从 https://ai-gateway.vercel.sh/v1/models 同步 type=speech 的模型菜单
```

## 参考

- [AI Gateway Text to Speech](https://vercel.com/docs/ai-gateway/modalities/text-to-speech)：端点、请求头、请求体与响应格式
- [AI Gateway 模型目录 · TTS](https://vercel.com/ai-gateway/models?q=tts)
- [Bob 插件文档 · 语音合成](https://bobtranslate.com/plugin/quickstart/tts.html)

## License

MIT
