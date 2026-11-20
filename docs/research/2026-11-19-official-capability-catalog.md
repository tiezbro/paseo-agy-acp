# 官方 agy_acp_server 1.5.0 能力目录（四稿合并）

> 这不是验收证书，也不是 README。它是把席 A 协议面、席 B 运行面及两份补充按官方行为去重后的目录，供后续拆进 README 或当适配指引。文中没有 file:line 的判断，不得当成已通过验收。

## 总览

- 基准是未修改的官方 `antigravity-acp` 1.5.0；能力、名称、顺序、模式、重试、取消都由官方决定。Paseo 只呈现官方已经给出的信号，不替官方造能力。
- 没有可追加的第三方模型白名单：官方只对 JetBrains、JetBrains Air、Android Studio、Android Performance Analyzer、Zed、Xcode、T3 Code 七类客户端保留非 Gemini 模型；Paseo 不冒充 Zed/Xcode/JetBrains，也不恢复任何全局排队。
- 官方 `server.py` 只有 Python 方法实现，没有 JSON-RPC 路由字符串。本文所有 RPC 章节标题带 † 者，**路由名待 SDK 核对**；实现与行为以 `server.py` 为准。
- 适配器 HEAD `3443b97`、工作树有未提交改动；配套 HEAD `b9726d2`、工作树有未提交改动；生产旧客户端未切换、未核实。下文“工作树”指两仓未提交改动，“生产”仅表示本轮没部署，不等于已实测。
- 已对齐的 12 项工作树改动列在第十三节，其中包括账号档位、六项用量、高风险警告正文、重试和终止失败。生产旧客户端没有这些改动。
- 审批选项顺序单独成条（C086）。认证细条保留，第十三节将它们归到同一决定：Google 登录只在终端办理。
- `BuiltinTools.default()` 与 `policy.safe_defaults` 的具体允许项已由 A 补充从官方 SDK 源码确认，不再放进未确认。

路径别名：`S=/tmp/agy150/src/server.py`；`P=/tmp/agy-audit-57c8.MDpA52/par-source/google3/cloud/developer_experience/antigravity_extensions/acp_server`；`K=/tmp/agy-audit-57c8.MDpA52/state/releases/1.5.0-8a35f63dd228-compat-v1-ea865a786680-aad1b9cfe5d0/agy_acp_server.runfiles/google3/third_party/py/google/antigravity`；`AD=/home/tiezbro/projects/paseo-agy-acp/ACP Connector/official-kernel`；`PC=/home/tiezbro/projects/MAACS-agy-capabilities/paseo/packages/server/src/server/agent/providers/acp-agent.ts`；`PP=/home/tiezbro/projects/MAACS-agy-capabilities/paseo/packages/protocol/src/provider-config.ts`。

## 一、初始化与能力位（†）

† 本节 RPC 路由名待 SDK 核对。

### C001 initialize 与协议版本回显
官方名称：`initialize`
- 官方做什么：把客户端 `protocolVersion` 原样回显；读取 `clientCapabilities` 与 `clientInfo`，据此定后续能力与 User-Agent；不校验版本。
- 官方信号：`S:2576-2716`。
- 官方不做什么：不拒绝未知版本；不在运行中二次协商；不另造版本号。
- Paseo 适配：适配器透传全部字段，只覆盖 `agentInfo`（`AD/proxy.ts:513-515`、`AD/identity.ts:3-16`）；Paseo 发自己的 `PROTOCOL_VERSION`（`PC:3209-3214`）。
- 适配状态：已对齐

### C002 `loadSession` 能力位
官方名称：`loadSession`
- 官方做什么：声明支持 `session/load` 并在 load 时重放历史；客户端据此选择 load 而非 resume。
- 官方信号：`S:2679-2681`。
- 官方不做什么：不声明分页或增量重放；不承诺每个内部步骤都产生事件。
- Paseo 适配：Paseo 读该位，为真时走 load，否则退 resume（`PC:2086-2104`）。
- 适配状态：已对齐

### C003 `auth.logout` 能力位
官方名称：`auth.logout`
- 官方做什么：在 `agentCapabilities.auth.logout` 声明 `logout` 可用；客户端只应在此能力存在时调用。
- 官方信号：`S:2681-2684`。
- 官方不做什么：不公布默认认证方法；不在能力位暗示账号已登录。
- Paseo 适配：保留官方退出能力声明。Paseo 对话框没有登录或退出账号入口，也不调用 `logout` RPC。
- 适配状态：已决定维持现状

### C004 `sessionCapabilities.list`
官方名称：`session/list` capability
- 官方做什么：声明可枚举本地会话；实现枚举 `<gemini_home>/antigravity-acp/conversations` 下的 `.db`。
- 官方信号：`S:2685-2687`、`3828-3885`。
- 官方不做什么：不声明分页；实现忽略 `cursor`，不返回 `nextCursor`。
- Paseo 适配：Paseo 只在能力位存在时调 `listSessions` 并按 `nextCursor` 循环；官方不返回时自然结束（`PC:1420-1450`）。
- 适配状态：已对齐

### C005 `sessionCapabilities.resume`
官方名称：`session/resume` capability
- 官方做什么：声明恢复会话但不重放历史；resume 返回配置、模型、模式与 tier。
- 官方信号：`S:2685-2691`、`4112-4149`。
- 官方不做什么：不发 `user_message_chunk`、planner 文本或工具历史。
- Paseo 适配：崩溃后继续按 `loadSession` 能力调用 load 并重放历史。只有不支持 load 且声明 resume 时才走 resume（`PC:initializeResumedSession`）。
- 适配状态：已决定维持现状

### C006 `sessionCapabilities.additionalDirectories`
官方名称：`additionalDirectories` capability
- 官方做什么：声明 new/load/resume 接受额外工作区根；三个入口都读取。
- 官方信号：`S:2685-2691`、`3689-3692`、`3959-3963`、`4118`、`4215`。
- 官方不做什么：不在客户端省略时隐式恢复旧目录；load/resume 省略即清除（`S:3901-3903`）。
- Paseo 适配：Paseo 先查能力位再带参数（`PC:2050-2062`）；适配器透传。
- 适配状态：已对齐

### C007 `promptCapabilities.image`
官方名称：`image` prompt capability
- 官方做什么：声明接受 `image` 块；base64 解码成 SDK `Image`，失败只告警并丢弃。
- 官方信号：`S:2692-2696`、`1305-1321`。
- 官方不做什么：不保证模型理解图片；不因解码失败让整个 prompt 失败。
- Paseo 适配：Paseo 发 `{type:"image",data,mimeType}`（`PC:4015-4018`）；适配器透传。
- 适配状态：已对齐

### C008 `promptCapabilities.audio`
官方名称：`audio` prompt capability
- 官方做什么：声明接受 `audio` 块；解码成 SDK `Audio`，失败只告警并丢弃。
- 官方信号：`S:2692-2696`、`1322-1338`。
- 官方不做什么：不保证后端接受音频；不把音频转文本。
- Paseo 适配：内核支持音频块。Paseo 上传音频时只传本机文件位置，由内核读取，不把音频内容嵌进消息（`PC:toACPContentBlocks`）。
- 适配状态：已决定维持现状

### C009 `promptCapabilities.embeddedContext`
官方名称：`embeddedContext` prompt capability
- 官方做什么：声明接受 `resource` 块（内嵌文本或 image/audio blob）。
- 官方信号：`S:2692-2696`、`1339-1395`。
- 官方不做什么：不接受任意 MIME 的 blob；非 image/audio 直接丢弃。
- Paseo 适配：粘贴图片使用官方图片块。上传文件（含音频）只传本机位置，带 MIME 的文本上下文仍可作为文本 `resource` 发送（`PC:toACPContentBlocks`）。
- 适配状态：已决定维持现状

### C010 `mcpCapabilities.http` / `sse`
官方名称：`http` / `sse` MCP capabilities
- 官方做什么：声明 new/load/resume 的 `mcpServers` 接受 HTTP 与 SSE；stdio 不需要能力位。
- 官方信号：`S:2697-2700`；`P/mcp_servers.py:56-114`。
- 官方不做什么：不声明 MCP 资源列表 RPC；MCP 工具仍走工具事件。
- Paseo 适配：Paseo 归一化 stdio/http/sse（`PC:3956-3994`）；适配器整理 headers，http(s) 走本地桥（`AD/mcp-rewrite.ts:1-41`、`AD/mcp-protocol-bridge.ts:7-33,150-160`）。
- 适配状态：已对齐

### C011 tier 能力位与响应元数据
官方名称：`_meta.antigravity.tier`
- 官方做什么：initialize 声明会返回 tier；authenticate/new/load/resume 响应带 `{name,id,upgradeUri}`；空 tier 省略整段。
- 官方信号：`S:2701-2708`、`3191`、`3756`、`4148`、`4250`；`P/tier_info.py:26-35`。
- 官方不做什么：不发独立 tier 通知；不保证每个账号都有 tier。
- Paseo 适配：配套工作树将会话响应中的 tier 写入 `runtimeInfo().extra.antigravityTier`。模型选择器旁显示 `name`，缺少名称时显示 `id`。三项全空时省略。
- 适配状态：已对齐（工作树未提交，生产旧客户端没有）

### C012 `_meta.antigravity.systemPrompt.append`
官方名称：`systemPrompt.append`
- 官方做什么：声明并接受 new/load/resume 的 append 字符串；只追加，不替换；是会话快照，不是逐轮开关。
- 官方信号：`S:2704-2707`、`3687`、`4006`；`P/system_prompt.py:11-45`。
- 官方不做什么：不提供 replace；不接受非字符串；不在 prompt 轮次重读。
- Paseo 适配：默认在每条消息前加 daemon 保存的背景说明。只有设置 `PASEO_AGY_ACP_NATIVE_SYSTEM_CONTEXT=1` 且内核声明支持，才在新建、加载或恢复会话时通过官方 append 追加一次（`AD/context.ts:51-85`）。只有 daemon 没有保存背景说明，或已设置 `PASEO_AGY_ACP_NATIVE_SYSTEM_CONTEXT=1` 时，官方内核才会截住 `/usage` 和 `/logout`，否则前置的背景文字会让这两条命令作为普通消息进入模型。
- 适配状态：已决定维持现状

### C013 agentInfo 官方身份
官方名称：`agentInfo`
- 官方做什么：返回 `name:"antigravity-acp"`、`title:"Google Antigravity"`、`version:"1.5.0"`。
- 官方信号：`S:2710-2715`；`P/_version.py:3`、`P/useragent.py:43-45`。
- 官方不做什么：不提供改名 RPC；不把版本写进其它响应。
- Paseo 适配：连接回包保留 `agy-acp`、当前标题 `paseo-agy-acp (official Antigravity ACP kernel)` 和适配器版本（`AD/identity.ts:3-16`）。
- 适配状态：已决定维持现状

### C014 客户端 fs 能力位
官方名称：`fs.readTextFile` / `fs.writeTextFile`
- 官方做什么：客户端声明对应 fs 能力时注入 `client_view_file`、`client_create_file`、`client_edit_file`；写能力为真时禁用原生 create/edit。
- 官方信号：`S:2584-2585`、`4347-4374`、`4419-4423`。
- 官方不做什么：不提供 ACP fs 请求反转；能力只影响工具注入。
- Paseo 适配：Paseo 明确 `fs.readTextFile=false`、`writeTextFile=false`（`PC:455-463`），官方保留原生文件工具。
- 适配状态：官方条件不满足

### C015 clientInfo 与第三方模型白名单
官方名称：`clientInfo`
- 官方做什么：只有 JetBrains、JetBrains Air（`air-plugin:<ide>`）、Android Studio、Android Performance Analyzer、Zed、Xcode、T3 Code 七类客户端保留非 Gemini 模型；未识别或无 clientInfo 一律 Gemini-only；名单是源码常量，没有环境变量、`_meta`、settings 或配置文件入口。
- 官方信号：`S:2586-2603`；`P/client_info.py:16-162`；`P/model_selection.py:33-58`、`418-424`。
- 官方不做什么：不提供可追加白名单；不对未知客户端报错；不改写 Paseo 的 clientInfo。
- Paseo 适配：工作树已删除覆盖 `allow_third_party` 的补丁。Paseo 以自己的身份连接，不在官方白名单，非 Gemini 模型按官方规则不出现，不冒充 Zed 或 Xcode。
- 适配状态：已对齐（工作树未提交，生产旧客户端没有）

## 二、认证（†）

† 本节 RPC 路由名待 SDK 核对。

### C016 `Log in with Google`
官方名称：`Log in with Google`
- 官方做什么：公布第一项 `oauth-personal`；选择后完成 OAuth 登录/刷新并解析项目 ID；唯一走 CCPA 动态目录与 CCPA 配额。
- 官方信号：`S:2607-2612`、`3047-3051`。
- 官方不做什么：不在 initialize 登录；不返回 token 或账号资料。
- Paseo 适配：仅在终端运行 `paseo-agy-acp --login` 登录 Google，`methodId` 固定为 `oauth-personal`（`AD/login.ts:91`）。对话框不办理登录或退出。
- 适配状态：已决定维持现状

### C017 `Log in with Gemini Enterprise`
官方名称：`Log in with Gemini Enterprise`
- 官方做什么：公布 `oauth-business`；authenticate 内完成登录与许可解析；决定 tier、BAIC 配额、管理员管控与浏览器注入。
- 官方信号：`S:2613-2617`、`3053-3060`、`1145-1174`。
- 官方不做什么：不提供企业项目/许可选择 RPC；配置来自 settings 的 `gcp`。
- Paseo 适配：本次不提供 Gemini Enterprise 登录入口。终端命令只办理 Google 个人登录。
- 适配状态：已决定维持现状

### C018 `Gemini API key`
官方名称：`Gemini API key`
- 官方做什么：公布 `gemini-api-key`；key 可来自 `_meta` 的 `api-key`/`apiKey`/`api_key` 外层条目，对象时再认 `apiKey`/`api_key`/`api-key`/`key` 内层，最后回退 `GEMINI_API_KEY`；key 缺失时 authenticate 仍成功，`-32000` 推迟到 `session/new`。
- 官方信号：`S:2604-2606`、`2618-2622`、`738-740`、`3062-3092`、`1128-1134`。
- 官方不做什么：不在 initialize 要求 key；不在 authenticate 抛缺失；不把详情塞进 `data`。
- Paseo 适配：本次不提供 Gemini API key 的输入或认证入口。`paseo-agy-acp --login` 固定使用 `oauth-personal`。
- 适配状态：已决定维持现状

### C019 `Gemini Enterprise Agent Platform`
官方名称：`Gemini Enterprise Agent Platform`
- 官方做什么：公布 `agent-platform`；凭据优先 `GOOGLE_API_KEY`，否则 `GOOGLE_CLOUD_PROJECT`+`GOOGLE_CLOUD_LOCATION`，否则 settings 的 `gcp`。
- 官方信号：`S:2623-2632`、`3097-3108`、`711-713`。
- 官方不做什么：缺配置时 authenticate 返回 `-32602`；不在 initialize 校验。
- Paseo 适配：本次不提供企业 Agent Platform 登录入口。对话框也不切换到该认证方式。
- 适配状态：已决定维持现状

### C020 `vertex-ai` 旧 id
官方名称：`vertex-ai` alias
- 官方做什么：接受旧 id 并归一化为 `agent-platform`；公布列表只给规范 id。
- 官方信号：`S:697-698`、`732-733`、`743-748`、`2623-2624`。
- 官方不做什么：不把 `vertex-ai` 作为第二个 authMethod 公布。
- Paseo 适配：适配器通用转发；Paseo 不调用。
- 适配状态：已对齐

### C021 `AI API Gateway`
官方名称：`AI API Gateway`
- 官方做什么：三重门（客户端 `auth._meta.gateway=true`、`AGY_ACP_ENABLE_GATEWAY_AUTH`、企业策略允许）同时成立才公布 gateway；REQUIRED 清空全部 authMethods，FORBIDDEN 撤下 gateway。
- 官方信号：`S:2634-2676`、`948-990`。
- 官方不做什么：不对未 opt-in 客户端公布；不在未设 env 时启用；gateway 不写 `settings.json`。
- Paseo 适配：Paseo 的 `BASE_ACP_CLIENT_CAPABILITIES` 无 gateway meta（`PC:455-461`），第一道门不满足。
- 适配状态：官方条件不满足

### C022 `authenticate` 方法分派
官方名称：`authenticate`
- 官方做什么：按 methodId 分派四种标准方法（含旧 id）；成功后记住认证类型；真实认证方式变化时迁移活动会话。
- 官方信号：`S:2966-3191`、`3172-3190`、`2122-2180`。
- 官方不做什么：不返回 token；不把 authenticate 成功当推理可用。
- Paseo 适配：终端 `paseo-agy-acp --login` 调用 `authenticate`，`methodId` 固定为 `oauth-personal`（`AD/login.ts:91`）。对话框不分派认证方法。
- 适配状态：已决定维持现状

### C023 `auth_required` 与 `data.reason`
官方名称：`auth_required`
- 官方做什么：需要认证或已注销时返回 `-32000`；已注销路径带 `data.reason="logged_out"`；客户端据此重开账号选择器。
- 官方信号：`S:704-708`、`2728-2733`、`2916-2921`、`5524-5529`。
- 官方不做什么：不用 resource_not_found 表示注销；不在其它认证错误里也塞 reason。
- Paseo 适配：保留 `-32000` 及官方 `logged_out` 原因。需要重新登录时在终端运行 `paseo-agy-acp --login`，对话框不弹登录窗口。
- 适配状态：已决定维持现状

### C024 `logout` RPC
官方名称：`logout`
- 官方做什么：清除当前认证方式凭据、重置认证状态、拆除活动会话；API key/Agent Platform 无凭据可清时保持连接。
- 官方信号：`S:3193-3207`、`3239-3290`。
- 官方不做什么：不清另一种 OAuth 的凭据；gateway 明确是空操作。
- Paseo 适配：Paseo 对话框不调用 `logout`，也不提供退出账号按钮。官方文本命令另见 C025。
- 适配状态：已决定维持现状

### C025 `/logout` 命令
官方名称：`/logout`
- 官方做什么：prompt 文本恰为 `/logout` 时在 session 查找之前拦截；注销后发确认正文并 `end_turn`；gateway 说明无可注销。
- 官方信号：`S:5518-5521`、`3292-3316`；`P/logout.py:29-87`。
- 官方不做什么：不接受额外文本；不交给模型；不发独立通知。
- Paseo 适配：名单保留官方 `/logout`，内核返回的确认文字按普通回复显示。Paseo 对话框不另办退出或切换账号。只有 daemon 没有保存背景说明，或已设置 `PASEO_AGY_ACP_NATIVE_SYSTEM_CONTEXT=1` 时，官方内核才会截住 `/usage` 和 `/logout`，否则前置的背景文字会让这两条命令作为普通消息进入模型。
- 适配状态：已决定维持现状

### C026 认证 UI 与交互式 OAuth 事件
官方名称：auth UI
- 官方做什么：只公布 authMethods；OAuth 在服务进程内完成，ACP 没有登录 URL、进度、账号资料或切换事件。
- 官方信号：`S:2604-2676`、`3047-3108`；`/tmp/agy150/src/main.py:65-88` 是独立 CLI。
- 官方不做什么：不发登录 URL；不发账号切换事件；不发 token。
- Paseo 适配：Google OAuth 只通过终端 `paseo-agy-acp --login` 发起，固定 `oauth-personal`。对话框不办理登录或退出，本次不提供企业、API key、企业平台入口。
- 适配状态：已决定维持现状

## 三、会话 RPC（†）

† 本节 RPC 路由名待 SDK 核对。

### C027 `session/new`
官方名称：`session/new`
- 官方做什么：展开 `~`、要求认证、初始化管理员管控、预建 trajectory、列模型、合并 MCP、构建 agent、写 sidecar；返回 UUID、configOptions、models、modes、tier；响应入队后异步补发 usage/commands。
- 官方信号：`S:3631-3757`、`3664`、`3745-3748`。
- 官方不做什么：不发模型正文；不把 MCP/技能列表当独立字段；不返回历史数组。
- Paseo 适配：适配器补 cwd、daemon context、技能 MCP（`AD/proxy.ts:286-307`）；Paseo 读 sessionId 与 configOptions。
- 适配状态：已对齐

### C028 `additionalDirectories` 规范化
官方名称：`additionalDirectories`
- 官方做什么：展开 `~`、abspath、按序去重、排除 cwd；非法项只告警跳过，不让 new 失败。
- 官方信号：`S:1406-1466`、`3689-3692`、`3959-3963`。
- 官方不做什么：不因单个坏目录失败；load/resume 省略即清除旧值。
- Paseo 适配：适配器透传；Paseo 在能力位存在时发数组（`PC:2050-2062`）。
- 适配状态：已对齐

### C029 MCP 合并、管理员管控与浏览器同名冲突
官方名称：`mcpServers`
- 官方做什么：客户端 mcpServers 与全局 `mcp_config.json` 合并，同名客户端优先；管理员禁用时全丢；允许列表再过滤；注入浏览器前剔除同名 `chrome_devtools`，内建胜出。
- 官方信号：`S:4270-4295`、`4486-4490`；`P/mcp_servers.py:222-330`。
- 官方不做什么：不把全局 MCP 列表发给客户端；不在响应里回报合并结果；不重命名冲突项。
- Paseo 适配：适配器保留 stdio，HTTP/SSE 经桥（`AD/proxy.ts:306-315`、`AD/mcp-protocol-bridge.ts:150-160`）；Paseo 发 mcpServers。
- 适配状态：已对齐

### C030 `session/load`
官方名称：`session/load`
- 官方做什么：恢复上下文并初始化 agent，然后从 SQLite 逐条重放；返回配置与 tier，不返回历史数组。
- 官方信号：`S:4209-4251`、`3887-4110`、`6503-6651`。
- 官方不做什么：不重放 usage、plan、compaction、浏览器通知；不保证每步产生事件。
- Paseo 适配：适配器透传并补 cwd/技能 MCP；Paseo 在 `replayingHistory` 期间灌入持久时间线（`PC:2086-2095`）。
- 适配状态：已对齐

### C031 历史重放事件形状
官方名称：historical replay
- 官方做什么：user_input→user_message_chunk；planner_response→先 agent_thought_chunk 再 agent_message_chunk；工具步→tool_call（status 直接 completed）再 tool_call_update 带输出与终态。
- 官方信号：`S:6503-6651`；工具段 `S:6600-6651`。
- 官方不做什么：不发 usage_update；历史 generate_image 不重发内联图；不把被拒工具重放成 completed。
- Paseo 适配：适配器透传；Paseo 的 handleUserMessageChunk/translateSessionUpdate 消费这些事件（`PC:3380-3460`）。
- 适配状态：已对齐

### C032 `session/resume`
官方名称：`session/resume`
- 官方做什么：恢复上下文但不重放历史；返回 configOptions/models/modes/tier；热恢复模型列表失败可保留旧模型，冷恢复失败。
- 官方信号：`S:4112-4149`、`4035-4051`。
- 官方不做什么：不发 user_message_chunk 或工具历史；不要求 load 能力位。
- Paseo 适配：崩溃后继续优先用 `loadSession` 重放历史，不主动改用无重放的官方 resume（`PC:initializeResumedSession`）。
- 适配状态：已决定维持现状

### C033 `session/list`
官方名称：`session/list`
- 官方做什么：枚举会话 `.db`，从 sidecar 读 cwd/附加目录，标题固定 `Session <8位>`，可按 cwd 过滤。
- 官方信号：`S:3828-3885`、`3864-3866`；`P/session_store.py:32-34`。
- 官方不做什么：忽略 cursor；不返回 nextCursor；不生成动态标题；不返回更新时间。
- Paseo 适配：适配器透传；Paseo 循环 nextCursor，官方不返回时结束（`PC:1420-1450`）。
- 适配状态：已对齐

### C034 会话 sidecar 元数据
官方名称：session sidecar
- 官方做什么：保存 cwd、additional_directories、mode_id、tool_filter、allowed_tool_calls + allowed_tools_workspace；load/resume 只恢复同 workspace 的 Allow Always，旧格式忽略。
- 官方信号：`S:3736-3743`、`4097-4103`、`3959-3975`；`P/session_store.py:81-113`。
- 官方不做什么：不把 sidecar 当 ACP 响应字段；不跨 workspace 复用授权；不迁移旧格式。
- Paseo 适配：适配器不读 sidecar；Paseo 用自身持久化恢复 `_meta`/session 参数（`PP:6-9`、`PC` sessionParameters）。
- 适配状态：已对齐

### C035 `session/cancel`
官方名称：`session/cancel`
- 官方做什么：通知式取消当前 turn，只调用 conversation.cancel，不释放会话；SDK 取消异常时发一条正文并返回 cancelled。
- 官方信号：`S:3759-3772`、`5716-5731`、`5826-5827`。
- 官方不做什么：不返回 JSON-RPC 响应；不删除会话；不保证无晚到事件。
- Paseo 适配：适配器转发 cancel，30 秒未确认则关闭共享连接；工作树把本地已取消但官方回 end_turn 改写为 cancelled（`AD/proxy.ts:256-273,564-567`）；Paseo interrupt 发 cancel（`PC:2798-2808`）。
- 适配状态：已对齐

### C036 会话不存在 `-32002`
官方名称：`resource_not_found`
- 官方做什么：load/resume 找不到 trajectory 时返回 `-32002`，data 带 sessionId/geminiHome/expectedPath/details。
- 官方信号：`S:3917-3940`、`1140-1142`。
- 官方不做什么：不把缺失会话当空会话；不在 list 隐藏 DB 存在的会话。
- Paseo 适配：适配器透传；Paseo 保留 code/message/data 摘要（`PC:360-396`）。
- 适配状态：已对齐

### C037 客户端断开清理
官方名称：`on_disconnect`
- 官方做什么：客户端断开时清理所有会话、后台任务、代理与遥测；不发会话结束通知。
- 官方信号：`S:1729-1733`、`3774-3826`。
- 官方不做什么：不把清理结果回给客户端；不在此时发事件。
- Paseo 适配：适配器 stdin 结束/关闭时终止内核并清理本地状态（`AD/proxy.ts:145-215`）；Paseo 按 close 能力位决定 close 或杀进程（`PC:2819-2870`）。
- 适配状态：已对齐

### C038 `session/set_model`（superseded）
官方名称：`session/set_model`
- 官方做什么：仍可切模型；只记录选择，agent 下一轮重建；成功返回空响应；未知模型 `-32602` 带 modelId/availableModels。
- 官方信号：`S:2759-2858`、`2318-2346`。
- 官方不做什么：不重建运行中 agent；不返回完整 configOptions；不静默忽略不可用模型。
- Paseo 适配：Paseo 优先 config option，失败才回退该 RPC（`PC:2505-2555`）；适配器透传。superseded 日志属于同一行为的观测点（`S:2778-2783`）。
- 适配状态：已对齐

### C039 模型切换延迟到下一轮
官方名称：model switch apply
- 官方做什么：set_config_option/set_model 立即返回并更新选择；真正 agent 重建在下一轮 prompt 前。
- 官方信号：`S:2318-2346`、`2785-2858`。
- 官方不做什么：不在切换 RPC 内启动推理；不保证运行中 turn 用新模型。
- Paseo 适配：适配器透传；Paseo 收到成功后更新选择器，下一轮由官方重建。
- 适配状态：已对齐

### C040 认证方式切换时迁移活动会话
官方名称：auth switch rebuild
- 官方做什么：真实认证方式变化时重建所有活动会话；gateway 配置轮换原地重建且不重列 CCPA 模型。
- 官方信号：`S:2122-2180`、`3172-3190`、`3139-3158`。
- 官方不做什么：不发迁移通知；不保留旧认证模型命名空间。
- Paseo 适配：保留内核迁移机制。Paseo 只有终端 Google 个人登录入口，对话框不切换认证方式，不主动触发迁移。
- 适配状态：已决定维持现状

### C041 `GEMINI_HOME` 与会话存储
官方名称：`GEMINI_HOME`
- 官方做什么：会话、凭据、技能、app data、hooks、trust 全部在解析后的 Gemini home 下；`$GEMINI_HOME` 非空用它，否则 `~/.gemini`，`~` 会展开。
- 官方信号：`P/paths.py:42`、`P/paths.py:68-100`；`S:3661-3662`、`3915-3917`。
- 官方不做什么：不把会话写进工作区；不把 GEMINI_HOME 暴露给客户端。
- Paseo 适配：适配器不覆盖 GEMINI_HOME；Paseo 用 PASEO_HOME 做 daemon context/技能发现（`AD/context.ts:45-80`、`AD/skill-commands.ts:108-190`）。
- 适配状态：已对齐

### C042 回合结束清理（含权限帧清扫）
官方名称：turn cleanup
- 官方做什么：正常结束记 completed，异常/取消记 failed；关闭所有未终结工具；策略路径按工具名+FIFO 把权限帧与执行步对账成一行；已批准未执行的权限帧标 failed 并写 approved but never executed。
- 官方信号：`S:6295-6329`、`5909-5960`、`5794-5834`、`5132-5145`。
- 官方不做什么：不让工具或权限框永久 pending；不把未执行算成功。
- Paseo 适配：适配器透传工具/权限终态；Paseo 映射 timeline（`PC:3493-3541`）。
- 适配状态：已对齐

## 四、配置选项

### C043 `Model` 选择器
官方名称：`Model`
- 官方做什么：configOptions 中发 id/category 为 model、name 为 Model 的 select；currentValue 是 family id 或具体模型 id；选项顺序沿用目录顺序。
- 官方信号：`P/config_options.py:170-208`、`339-347`；`S:3594-3601`。
- 官方不做什么：不改显示名大小写；不按字母重排；不保证多模型。
- Paseo 适配：适配器透传，不碰模型名/顺序（`AD/proxy.ts:584-586` 只加 mode meta）；Paseo 从 configOptions 派生目录（`PC:3235-3260,3732-3740`）。
- 适配状态：已对齐

### C044 thinking family 折叠
官方名称：model family grouping
- 官方做什么：同族有 ≥2 变体时，model 选项只出现一个 family 项，变体由 thinking_level 选择；只有一个变体或 family id 与已提供模型 id 冲突时平铺。
- 官方信号：`P/config_options.py:109-167`、`339-347`。
- 官方不做什么：不折叠单变体；不为 gateway 声明项分组（`S:3603-3629`）。
- Paseo 适配：适配器透传；Paseo 展开为模型目录（`PC:998-1030`）。
- 适配状态：已对齐

### C045 `Thinking Level` 选择器
官方名称：`Thinking Level`
- 官方做什么：当前模型属于有 ≥2 变体的 family 时发 thought_level select，选项按 minimal/low/medium/high/xhigh/extra_high/max 排序，未知排最后。
- 官方信号：`P/config_options.py:211-249`、`56-70`、`345-347`。
- 官方不做什么：没有 family 时不发；不发明档位；gateway 不分组。
- Paseo 适配：适配器透传；Paseo 保留官方名称/顺序/当前值（`PC:998-1030,2586-2650`）。
- 适配状态：已对齐

### C046 `Session Mode` 选择器
官方名称：`Session Mode`
- 官方做什么：发 mode select，顺序 Default/default、Auto Edit/auto_edit、YOLO/yolo，并附官方描述。
- 官方信号：`P/config_options.py:25-41`、`252-274`、`347`。
- 官方不做什么：1.5.0 没有 plan 模式；不改大小写；不静默降级未知模式。
- Paseo 适配：保留 Default、Auto Edit、YOLO 的官方名称、顺序和当前值。只加 `paseo.dev/unattended` 标记，只有 `yolo` 为真（`AD/mode-map.ts:40-64`）。
- 适配状态：已决定维持现状

### C047 superseded `models` 字段
官方名称：`models`
- 官方做什么：除 configOptions 外仍返回旧 SessionModelState（availableModels/currentModelId）。
- 官方信号：`P/config_options.py:9-11`、`318-357`；`S:3754`、`4146`、`4248`。
- 官方不做什么：不保证与 configOptions 粒度一致（models 保留扁平变体）。
- Paseo 适配：适配器透传；Paseo 优先 configOptions，models 回退（`PC:3235-3260`）。
- 适配状态：已对齐

### C048 superseded `modes` 字段
官方名称：`modes`
- 官方做什么：除 configOptions 外仍返回旧 SessionModeState。
- 官方信号：`P/config_options.py:348-357`；`S:3755`、`4147`、`4249`。
- 官方不做什么：不保证客户端优先读 modes；Zed 会丢弃该字段（`P/config_options.py:325-328`）。
- Paseo 适配：适配器透传；Paseo 从 configOptions 派生，modes 回退。
- 适配状态：已对齐

### C049 `session/set_config_option` 与值类型
官方名称：`session/set_config_option`
- 官方做什么：接受 model/thinking_level/mode，值为字符串；返回全量 configOptions；非字符串返回 -32602；未知 id 返回 -32602。
- 官方信号：`S:2881-2964`、`2926-2930`、`2951-2955`。
- 官方不做什么：不接受布尔值；不接受未知 id；不改一项只返回一项。
- Paseo 适配：适配器透传并补 mode meta；Paseo 每次读取完整回包（`PC:2708-2735,3539-3578`）。
- 适配状态：已对齐

### C050 `thinking_level` 到具体模型
官方名称：`thinking_level`
- 官方做什么：把档位解析为当前 family 的具体模型；family 没有该档时取最近档，同距取更高；从无档位模型进入取第一个变体。
- 官方信号：`P/config_options.py:360-431`；`S:2860-2872`、`2932-2948`。
- 官方不做什么：不把档位写成独立模型；档位不存在时返回 -32602。
- Paseo 适配：适配器透传；Paseo 通过 thinking 事件更新（`PC:3543-3578`）。
- 适配状态：已对齐

### C051 `session/set_mode`
官方名称：`session/set_mode`
- 官方做什么：校验 modeId；同值直接成功；否则写 sidecar；管理员终端策略不锁模式，而在每次 exec 调用复核。
- 官方信号：`S:2718-2757`、`2750-2753`。
- 官方不做什么：未知模式 -32602；不因 yolo 跳过管理员终端复核。
- Paseo 适配：适配器翻译已知别名后透传；Paseo 优先 config option 写 mode（`PC:2339-2460`）。
- 适配状态：已对齐

### C052 未知 config/mode/model 错误
官方名称：invalid params
- 官方做什么：未知 mode -32602；未知 config id -32602；不可用模型 -32602 并带 availableModels。
- 官方信号：`S:2741-2744`、`2838-2848`、`2951-2955`。
- 官方不做什么：不静默降级；不返回 resource_not_found。
- Paseo 适配：适配器透传；Paseo 保留错误摘要（`PC:360-396`）。
- 适配状态：已对齐

### C053 模型自动替换与 `config_option_update`
官方名称：model replacement
- 官方做什么：企业会话每轮前重新列模型；当前模型消失时自动换到可用模型，发全量 config_option_update，并最多一次发替换说明正文。
- 官方信号：`S:2277-2316`、`2348-2388`；`P/config_options.py:299-315`。
- 官方不做什么：用户主动切换不发 config_option_update（只靠 set 回包）；同一旧模型只提示一次。
- Paseo 适配：适配器透传；Paseo handleConfigOptionUpdate 发出 model/mode/thinking 事件（`PC:3543-3578`）。
- 适配状态：已对齐

### C054 认证方式决定模型命名空间
官方名称：auth-scoped model catalog
- 官方做什么：OAuth/business 走 CCPA；API key/Agent Platform 走静态目录；gateway 走管理员声明目录；不同认证模型 id 不互通。
- 官方信号：`P/model_selection.py:801-830`；`S:3481-3519`、`3566-3579`。
- 官方不做什么：不把另一认证模型当可用；恢复跨认证会话时自动换到可用模型。
- Paseo 适配：适配器透传；Paseo 只消费目录并在切换失败时保留旧选择（`PC:2505-2555`）。
- 适配状态：已对齐

### C055 模型目录失败退化为单模型
官方名称：model catalog degradation
- 官方做什么：列模型失败时会话只提供当前模型的单条目，而不是让恢复失败。
- 官方信号：`S:3580-3592`。
- 官方不做什么：不伪造完整目录；new 初次列模型失败仍失败。
- Paseo 适配：适配器透传；Paseo 接受单模型目录。
- 适配状态：已对齐

## 五、输入块

### C056 文本块
官方名称：`text`
- 官方做什么：接受 text 块，拼接后交给 SDK；不在 prompt 开始时回显用户文本。
- 官方信号：`S:1271-1280`、`1249-1403`。
- 官方不做什么：不发 user_message_chunk（只有 load 重放才发）。
- Paseo 适配：适配器透传；Paseo 发 text 块（`PC:3998-4003`）。
- 适配状态：已对齐

### C057 文本中的官方斜杠命令
官方名称：builtin slash command
- 官方做什么：按 BuiltinSlashCommandName 识别 `/name`，拆成普通字符串与 SlashCommand；`/plan` 是其中之一。
- 官方信号：`S:1195-1213`、`1271-1280`。
- 官方不做什么：不把斜杠命令识别成模式切换；不为未枚举自定义命令创建 SlashCommand。
- Paseo 适配：保留官方 `/plan`、`/logout`、`/usage`，再追加本地技能命令。同名时官方优先（`AD/skill-commands.ts:221-243`）。
- 适配状态：已决定维持现状

### C058 图片块
官方名称：`image`
- 官方做什么：base64 解码成 SDK Image；失败只告警并丢弃该块。
- 官方信号：`S:1305-1321`。
- 官方不做什么：不保证后端理解图片；不因坏图失败。
- Paseo 适配：适配器透传；Paseo 发 image 块（`PC:4015-4018`）。
- 适配状态：已对齐

### C059 音频块
官方名称：`audio`
- 官方做什么：base64 解码成 SDK Audio；失败只告警并丢弃。
- 官方信号：`S:1322-1338`。
- 官方不做什么：不保证后端接受；不把音频转文本。
- Paseo 适配：粘贴图片用官方图片块。上传音频只交本机文件位置，由内核读取，不再内嵌 `audio` 块（`PC:toACPContentBlocks`）。
- 适配状态：已决定维持现状

### C060 `resource` 文本形式
官方名称：`resource`（embedded context）
- 官方做什么：resource.text 存在时拼成 `Embedded resource (<uri>):\n<text>`。
- 官方信号：`S:1339-1350`。
- 官方不做什么：不把文本 resource 当文件路径读；不保留原始 URI 结构。
- Paseo 适配：带 MIME 的文本上下文仍可生成文本 `resource`。上传文件只交本机位置，不再把文件正文嵌进消息（`PC:toACPContentBlocks`）。
- 适配状态：已决定维持现状

### C061 `resource` image/audio blob
官方名称：`resource` blob
- 官方做什么：blob MIME 以 image/ 或 audio/ 开头时解码成 SDK Image/Audio，URI 作 description。
- 官方信号：`S:1350-1389`。
- 官方不做什么：不接受其他 MIME；失败只告警丢弃。
- Paseo 适配：粘贴图片使用官方图片块。上传文件（含音频）使用本机文件位置，不把文件内容再发成 `resource` blob（`PC:toACPContentBlocks`）。
- 适配状态：已决定维持现状

### C062 不支持 resource MIME
官方名称：unsupported resource blob
- 官方做什么：非 image/audio blob 记日志并丢弃，prompt 继续。
- 官方信号：`S:1390-1395`。
- 官方不做什么：不把二进制转文本；不返回 -32602。
- Paseo 适配：Paseo 不主动发这类块。
- 适配状态：已对齐

### C063 `resource_link`
官方名称：`resource_link`
- 官方做什么：按 URI path 在服务端本地读文件，from_file 构造文档；失败退化为文件路径字符串；不支持 MIME 会重标记。
- 官方信号：`S:1281-1304`、`1220-1246`。
- 官方不做什么：不从客户端上传通道取内容；不保证远端路径存在。
- Paseo 适配：Paseo 对 uploaded_file 在 embeddedContext 为真时发 file:// resource_link（`PC:4020-4035`）；适配器透传。
- 适配状态：已对齐

### C064 不支持的内容块
官方名称：unsupported prompt block
- 官方做什么：未知 block.type 只记 warning、跳过，不使 prompt 失败。
- 官方信号：`S:1396-1399`。
- 官方不做什么：不返回 -32602；不猜块类型。
- Paseo 适配：Paseo 只生成已知类型（`PC:3998-4048`）。
- 适配状态：已对齐

### C065 prompt 的 `messageId`
官方名称：`messageId`
- 官方做什么：接收可选 messageId，仅用于每轮 telemetry prompt id 与 BAIC 追踪头；没有时生成 UUID；不回显、不去重。
- 官方信号：`S:5503`、`5577-5582`。
- 官方不做什么：不把它当文本回显；不用它去重。
- Paseo 适配：适配器透传；Paseo 每轮生成 UUID（`PC:2179-2205`）。
- 适配状态：已对齐

### C066 `/usage` 命令
官方名称：`/usage`
- 官方做什么：prompt 文本以 /usage 开头且后接空白或结束时，在 session 查找后、agent 调用前拦截；生成 token/配额 Markdown 作为普通 chunk，返回 end_turn；带参数报错。
- 官方信号：`S:3385-3462`、`5532-5533`；`P/usage.py:18-46`、`206-272`。
- 官方不做什么：不调模型；非 OAuth 路径不查配额；不做升级推销。
- Paseo 适配：将官方 `/usage` 返回的报告原文显示为普通回复，不制作配额卡片。只有 daemon 没有保存背景说明，或已设置 `PASEO_AGY_ACP_NATIVE_SYSTEM_CONTEXT=1` 时，官方内核才会截住 `/usage` 和 `/logout`，否则前置的背景文字会让这两条命令作为普通消息进入模型。
- 适配状态：已决定维持现状

## 六、输出事件

### C067 正文只对根 trajectory
官方名称：`agent_message_chunk`
- 官方做什么：只在 MODEL→USER、非 ERROR、parent_trajectory_id 为空时发 content_delta；子 agent 与 ERROR 状态的 MODEL→USER 文本不发。
- 官方信号：`S:6025-6056`。
- 官方不做什么：不发 subagent 文本；不把拒绝回执发成助手正文开头。
- Paseo 适配：适配器经系统封套折叠后透传（`AD/system-message-fold.ts:60-110`）；Paseo 映射 assistant message（`PC:3363-3385`）。
- 适配状态：已对齐

### C068 操作性文本清单
官方名称：operational `agent_message_chunk`
- 官方做什么：浏览器不可用/降级、SDK 终端错误、连接丢失、重建失败、模型替换说明、引用来源、/logout 确认、/usage 报告，全部复用普通 agent_message_chunk，无独立通道、无 `_meta` 标记。
- 官方信号：`S:5552-5575`、`5733-5767`、`5775-5785`、`2361-2376`、`5836-5874`、`3305-3313`、`3453-3462`。
- 官方不做什么：不区分助手正文与系统提示；不发 JSON-RPC error；不加身份标记。
- Paseo 适配：浏览器、连接、模型替换、引用、`/logout` 和 `/usage` 的官方文字按普通回复显示。在官方正文中只给 `SYSTEM_MESSAGE` 封套加系统标记（`AD/system-message-fold.ts`）。
- 适配状态：已决定维持现状

### C069 实时思考摘要
官方名称：`agent_thought_chunk`
- 官方做什么：与正文同组条件，只取 thinking_delta；不凭空生成摘要。
- 官方信号：`S:6029-6046`。
- 官方不做什么：模型不吐 thinking_delta 就没有事件；不把正文转思考。
- Paseo 适配：适配器透传；Paseo 映射 reasoning（`PC:3386-3390`）。
- 适配状态：已对齐

### C070 历史思考摘要
官方名称：historical `agent_thought_chunk`
- 官方做什么：load 重放 planner_response.thinking 时先发 thought 再发正文。
- 官方信号：`S:6523-6534`。
- 官方不做什么：只重放 planner thinking；不重放其它内部 thinking。
- Paseo 适配：适配器透传；Paseo 映射 reasoning。
- 适配状态：已对齐

### C071 工具开始
官方名称：`tool_call`
- 官方做什么：新调用发 ToolCallStart，带 toolCallId/title/kind/content/locations/rawInput/status/MCP `_meta`；需审批先 pending，自动批准为 in_progress。
- 官方信号：`S:5119-5131`、`6148-6162`。
- 官方不做什么：不省略 toolCallId；不保证所有工具都有 kind/content/locations。
- Paseo 适配：适配器透传；Paseo 映射 timeline（`PC:3493-3541`）。
- 适配状态：已对齐

### C072 工具进行中
官方名称：`tool_call_update`（in_progress）
- 官方做什么：执行步复用 pending 权限帧时，把同一 toolCallId 推进到 in_progress，并补 title/kind/content/locations/rawInput；未复用时直接发新 tool_call。
- 官方信号：`S:6132-6162`。
- 官方不做什么：不创建第二个工具行；不把 pending 与 exec 分成两行。
- Paseo 适配：适配器透传；Paseo 合并工具快照（`PC:3493-3541,4078-4110`）。
- 适配状态：已对齐

### C073 工具终态
官方名称：`tool_call_update`（completed/failed）
- 官方做什么：DONE/ERROR/CANCELED 时发终态；正常 completed，错误/拒绝/manage_task kill 为 failed；rawOutput/content 按工具类型填充。
- 官方信号：`S:6164-6292`、`6295-6329`、`4937-4968`。
- 官方不做什么：不把非零退出码当工具错误；不让工具停在 in_progress。
- Paseo 适配：适配器透传；Paseo 映射工具状态。
- 适配状态：已对齐

### C074 内部 MCP schema 读取隐藏
官方名称：internal MCP schema read
- 官方做什么：模型读 `<app_data_dir>/brain/<conversation>/mcp/<server>/<tool>.json` 时，从客户端事件流隐藏该 view_file/client_view_file，底层读取仍执行。
- 官方信号：`S:418-481`、`6077-6083`、`6220-6223`。
- 官方不做什么：不隐藏用户对同路径的真实读取；不隐藏写操作。
- Paseo 适配：适配器透传过滤后的流；Paseo 不额外处理。
- 适配状态：已对齐

### C075 MCP 输出与调度包装
官方名称：MCP tool output
- 官方做什么：非 eager MCP 经 call_mcp_tool 的 `{ServerName,ToolName,Arguments}` 调度；权限与流展示拆成展示名+干净 rawInput+`_meta.mcp`；终态 rawOutput 放结果字符串，同时包成 text content。
- 官方信号：`P/tools.py:50`、`558-665`；`S:5163-5180`、`6100-6145`、`6281-6282`。
- 官方不做什么：不对 eager 服务器绕这一层；不丢 MCP 标题。
- Paseo 适配：适配器经 MCP 桥转发；Paseo 映射工具内容（`PC:3493-3541`）。
- 适配状态：已对齐

### C076 exec 结构化输出
官方名称：exec rawOutput
- 官方做什么：完成的 exec 带 exit_code/combined_output 时转 `{commandLine,workingDir,exitCode,combinedOutput}`，并保留 exit_code/formatted_output 给 JetBrains；非零退出码仍 completed。
- 官方信号：`S:126-166`、`282-313`、`6263-6266`。
- 官方不做什么：不在未完成时发结构化结果；不伪造未知退出码。
- Paseo 适配：适配器透传；Paseo 保留 rawOutput。
- 适配状态：已对齐

### C077 `generate_image` 内联图片
官方名称：`generate_image` output
- 官方做什么：rawOutput 带 imageName/imagePath/prompt/aspectRatio；图片可读时再发 ImageContentBlock（base64、MIME、file:// URI）。
- 官方信号：`S:167-237`、`6267-6274`。
- 官方不做什么：路径无效不伪造图片；历史重放只给 rawOutput 字典。
- Paseo 适配：适配器透传；Paseo 渲染工具内容。
- 适配状态：已对齐

### C078 `search_web` 输出双重编码
官方名称：`search_web` output
- 官方做什么：完成时 summary 同时进 rawOutput 与单个 text content 块。
- 官方信号：`S:250-259`、`6275-6280`。
- 官方不做什么：in_progress 阶段不发 summary。
- Paseo 适配：适配器透传；Paseo 渲染工具内容。
- 适配状态：已对齐

### C079 后台 exec 跨 turn 保持打开
官方名称：background exec
- 官方做什么：正常回合结束时仍 active 的 exec 移入 persisted_open_tool_calls，不立即关闭；后续步骤完成时再发终态。
- 官方信号：`S:5631-5639`、`6195-6213`。
- 官方不做什么：不把后台 exec 当失败；不切 turn 丢工具行。
- Paseo 适配：适配器透传；Paseo 时间线允许跨 turn 更新同一 toolCallId（`PC:3493-3541`）。
- 适配状态：已对齐

### C080 `manage_task` kill
官方名称：`manage_task` kill
- 官方做什么：manage_task(Action="kill",TaskId="task-<n>") 成功时，把匹配的活动与持久化后台工具标 failed，rawOutput 为 Killed by manage_task(<id>)。
- 官方信号：`S:6175-6213`、`262-279`。
- 官方不做什么：不把被杀工具当 completed；不猜不匹配 id。
- Paseo 适配：适配器透传；Paseo 显示失败终态。
- 适配状态：已对齐

### C081 上下文占用 `usage_update`
官方名称：`usage_update`
- 官方做什么：每轮结束/切模型/恢复时读主轨迹累计用量，算本次上下文占用并发 used/size；分母按 CCPA maxTokens、gateway catalog、内置表三级来源，未知不发；恢复会话首次模型调用前不伪造 0；主轨迹排除 subagent。
- 官方信号：`S:6363-6435`、`1597-1624`、`4102-4105`；`P/model_selection.py:330-368`；`P/token_usage_tracker.py:35-169`。
- 官方不做什么：不猜分母；不发 0 清空上下文条；不读子 agent 轨迹。
- Paseo 适配：适配器透传；Paseo handleUsageUpdate 发 usage_updated（`PC:3598-3615`）。
- 适配状态：已对齐

### C082 `PromptResponse.usage`
官方名称：`PromptResponse.usage`
- 官方做什么：返回本轮增量；input_tokens 是净未缓存输入（prompt 减 cached），output_tokens 含 thinking，cached_write_tokens 恒 0；无正向增量省略。
- 官方信号：`S:5820-5834`；`P/token_usage_tracker.py:116-221`。
- 官方不做什么：不返回跨轮累计；不在压缩后发负数；不重复计 cached。
- Paseo 适配：配套工作树的 `mapACPUsage` 映射全部六项用量，客户端快照也保留六项。已知零值原样保留，`outputTokens` 不重复计入 `thoughtTokens`。
- 适配状态：已对齐（工作树未提交，生产旧客户端没有）

### C083 引用来源
官方名称：citation notice
- 官方做什么：BAIC 代理检测到引用时，turn 末尾一次性以普通 agent_message_chunk 发来源列表；ACP 没有引用原语。
- 官方信号：`S:5836-5874`。
- 官方不做什么：不发结构化 citation；不在流中逐条插入。
- Paseo 适配：引用来源按官方原文显示为普通回复，不另做引用卡片。只对官方正文里的 `SYSTEM_MESSAGE` 封套标记系统消息。
- 适配状态：已决定维持现状

## 七、权限与问答

### C084 工具审批请求
官方名称：`session/request_permission`
- 官方做什么：需审批工具先发 tool_call(status=pending)，再发 request_permission；客户端回 AllowedOutcome 或 DeniedOutcome。
- 官方信号：`S:5119-5239`、`5271-5325`。
- 官方不做什么：不提供独立权限 RPC；不把审批结果当正文；不自动回答需审批工具。
- Paseo 适配：适配器把 permission 请求原样转给客户端、响应原样转回（`AD/proxy.ts:490-494,592`）；Paseo requestPermission 生成单选动作（`PC:2875-2938`）。
- 适配状态：已对齐

### C085 审批选项集合
官方名称：permission options
- 官方做什么：普通工具给 allow_always/allow/deny；文件写、管理员复核 exec、ALWAYS_ASK 文件工具只给 allow/deny；高风险 exec/web 的 allow_always 带 `(risky)` 与 `agy.security.warning`。
- 官方信号：`S:5154-5224`、`314-321`。
- 官方不做什么：不给写工具可持久化的 Allow Always；不对 ALWAYS_ASK/终端复核缓存。
- Paseo 适配：适配器不改 options；Paseo 每个 option 变单选动作（`PC:2875-2938,4381-4415`）。
- 适配状态：已对齐

### C086 审批选项顺序
官方名称：permission option order
- 官方做什么：allow_always 存在时顺序固定 `[allow_always, allow, deny]`，不存在时 `[allow, deny]`；第三种永远第一。来源 B补充 补51。
- 官方信号：`S:5173-5231`、`5277-5318`。
- 官方不做什么：不接受客户端自定义 option id；不重排；不在选项里塞 kind 之外的语义。
- Paseo 适配：适配器不改 options；Paseo 按官方顺序生成动作，不重排（`PC:2875-2938`）。
- 适配状态：已对齐

### C087 高风险审批警告
官方名称：`Allow Always (risky)`
- 官方做什么：exec/文件写/web 归为高风险；allow_always 显示名带 `(risky)`，`_meta["agy.security.warning"]` 带 severity/risk/title/message；web 与 exec 措辞不同。
- 官方信号：`S:314-321`、`5186-5224`。
- 官方不做什么：不给写工具 allow_always；不隐藏 `(risky)` 字面。
- Paseo 适配：配套工作树将选项 `_meta["agy.security.warning"].message` 显示为该次权限请求的 `description`，保留官方按钮名及 `(risky)`。没有警告时沿用原描述。
- 适配状态：已对齐（工作树未提交，生产旧客户端没有）

### C088 `Allow Always` 缓存身份
官方名称：Allow Always scoped cache
- 官方做什么：exec 按精确命令字符串缓存；文件写永不缓存；其他工具按工具名缓存；缓存按 session 保存并绑定 workspace。
- 官方信号：`S:87-123`、`5074-5088`、`5284-5303`、`3963-3975`。
- 官方不做什么：不缓存写工具；不缓存缺 CommandLine 的 exec；不跨 workspace 恢复。
- Paseo 适配：适配器透传审批结果；Paseo 只回 optionId。
- 适配状态：已对齐

### C089 用户拒绝
官方名称：denied permission
- 官方做什么：客户端回 DeniedOutcome 或非 allow 选项时不执行，发 tool_call_update(status=failed, rawOutput="Rejected by user")，turn 继续。
- 官方信号：`S:5271-5275`、`4937-4968`。
- 官方不做什么：不把拒绝当 turn 取消；不显示 completed。
- Paseo 适配：适配器透传；Paseo 区分 selected/cancelled（`PC:2737-2770`）。
- 适配状态：已对齐

### C090 取消审批与拒绝审批
官方名称：`cancelled` outcome
- 官方做什么：DeniedOutcome(outcome=cancelled) 与选择 deny 不同：前者取消交互，后者明确拒绝；两者都关闭工具行，只有拒绝写 Rejected by user。
- 官方信号：`S:5271-5275`、`5319-5325`。
- 官方不做什么：不把取消当 allow；不把取消当成功。
- Paseo 适配：适配器透传；Paseo 无选项取消发 `{outcome:"cancelled"}`（`PC:2737-2770`）。
- 适配状态：已对齐

### C091 模式自动批准
官方名称：`Default` / `Auto Edit` / `YOLO`
- 官方做什么：yolo 自动批所有工具；auto_edit 只批 AUTO_EDIT_TOOLS；default 不自动批；管理员终端复核与 ALWAYS_ASK 可覆盖。
- 官方信号：`S:5063-5069`、`5028-5061`、`2750-2753`。
- 官方不做什么：不让 yolo 绕过管理员终端复核；不让 auto_edit 批 exec/web/MCP。
- Paseo 适配：三种模式名称及当前值不变。`paseo.dev/unattended` 仅在 `yolo` 为真，配套客户端据此自动选允许项，Default 与 Auto Edit 保留官方审批（`AD/mode-map.ts:40-64`）。
- 适配状态：已决定维持现状

### C092 官方问答协议
官方名称：`ask_question`
- 官方做什么：没有独立 RPC；发 dummy tool_call（interaction_<8hex>），再用 request_permission 呈现问题与选项；用户选择后关闭工具行。
- 官方信号：`S:5381-5497`。
- 官方不做什么：不支持多选/自由文本；不保证问题有 kind/content/locations；不把问答当正文。
- Paseo 适配：适配器透传；Paseo 当 permission 单选处理（`PC:2875-2938,4444-4465`）。
- 适配状态：已对齐

### C093 `ask_question` 的 safe_defaults 覆盖
官方名称：`ask_question` policy override
- 官方做什么：safe_defaults 的 ask_user("*") 会预拦 ask_question；官方在策略表头插具体 allow("ask_question")，让回答本身成为确认。
- 官方信号：`S:4385-4398`。
- 官方不做什么：不再发一次预拦；不改变问答的 dummy tool_call + permission 形状。
- Paseo 适配：适配器透传；Paseo 只看到真正的问题 permission。
- 适配状态：已对齐

### C094 问答选项 kind 映射
官方名称：question option kind
- 官方做什么：选项 id 为 deny/dont_trust/block（大小写不敏感）映射 reject_once，其余 allow_once。
- 官方信号：`S:5403-5414`。
- 官方不做什么：不提供 allow_always 问答选项；不合并多个 allow。
- Paseo 适配：适配器透传；Paseo 的 isACPChooserRequest 在重复 allow kind 时阻止自动批准（`PC:4444-4465`）。
- 适配状态：已对齐

### C095 问答结果终局
官方名称：question resolution
- 官方做什么：允许→completed + Response received；拒绝/取消→failed + Interaction cancelled。返回 AllowedOutcome 的 option_id；DeniedOutcome 取 option_id（可能 None）；其它 None。
- 官方信号：`S:5474-5497`。
- 官方不做什么：不把拒绝当失败正文；不重试；不提供多选。
- Paseo 适配：适配器透传；Paseo 取消回 cancelled，拿到 None（`PC:2737-2770`）。
- 适配状态：已对齐

### C096 客户端 fs 回调工具
官方名称：`client_view_file` / `client_create_file` / `client_edit_file`
- 官方做什么：客户端声明 fs 能力后，把文件读取/创建/编辑变成回调客户端的工具；写能力为真时禁用原生 create/edit；写工具审批由 harness 统一做，工具内不再判权限。
- 官方信号：`S:4341-4390`、`4303-4312`；`P/tools.py:305-557`。
- 官方不做什么：不在未声明时注入；不在工具内部再判一次权限。
- Paseo 适配：Paseo 明确关闭 fs 能力（`PC:455-463`），这些工具不会出现。
- 适配状态：官方条件不满足

### C097 浏览器子代理
官方名称：`chrome_devtools` browser subagent
- 官方做什么：仅 oauth-business + 管理员 browser_enabled 时注入 chrome_devtools MCP 与 browser subagent；启动前 npx preflight；失败跳过注入并发一次性通知；运行时失败钉住会话、降级通知、重建并重试一次；evaluate_script 按 JS 策略审批。
- 官方信号：`S:4445-4529`、`5547-5575`、`5660-5720`；`P/browser_subagent.py:11-36,140-559`。
- 官方不做什么：不对非企业注入；不在 preflight 失败后反复注入；不把浏览器工具作为 ACP 能力位公布。
- Paseo 适配：适配器不注入；Paseo 只有通用工具/审批 UI。
- 适配状态：官方条件不满足

### C098 浏览器 `evaluate_script` 复核
官方名称：`chrome_devtools/evaluate_script` policy
- 官方做什么：只对 evaluate_script 应用 JS 策略：DISABLED 从工具面剔除；REQUEST_REVIEW 在策略表头插 ask_user，压过 safe_defaults 只读 allow；NOT_ENFORCED 不加规则；UNSPECIFIED 归一化 DISABLED。
- 官方信号：`S:4492-4504`；`P/browser_subagent.py:46-50,158-180,227-243,276-283`。
- 官方不做什么：不把策略做成 enabledTools；不审计其它浏览器工具；不在非企业注入。
- Paseo 适配：适配器不注入；Paseo 不触发企业浏览器。
- 适配状态：官方条件不满足

### C099 hooks 与 workspace trust
官方名称：workspace trust / hooks
- 官方做什么：读取全局与工作区 hooks；工作区未信任时 load_hooks_config_async 无 ask_user_fn 不弹询问、不加载工作区 hooks；运行 hook 时用 ask_user_callback 发 trust/dont_trust；五个事件 PreToolUse/PostToolUse/PreInvocation/PostInvocation/Stop。
- 官方信号：`S:4607-4638`；`P/hooks.py:196-262,273-431`、`P/workspace_trust.py:17-227`。
- 官方不做什么：不在 new 时弹 trust；不把 trust 作为 ACP 独立事件；不支持 Notification/SubagentStop。
- Paseo 适配：工作区是否可信继续由官方询问。Default 与 Auto Edit 由人点选，YOLO 自动选允许项，即信任该工作区。
- 适配状态：已决定维持现状

### C100 hook 执行协议与失败即拒绝
官方名称：external hooks
- 官方做什么：shlex.split 后子进程执行，JSON 写 stdin，读 stdout JSON；默认 30 秒；非零退出/非 dict/执行失败都算失败；PreToolUse 执行失败视同拒绝；PostInvocation terminate 可结束，injectSteps 被忽略。
- 官方信号：`P/hooks.py:26-113`、`116-125`、`475-573`、`705-781`、`821-876`。
- 官方不做什么：不重试 hook；不因 post hook 失败回滚；不支持轨迹注入；不把 ask 当独立决策。
- Paseo 适配：适配器不读写 hooks；Paseo 只在 hook 触发权限时看到 request_permission。
- 适配状态：已对齐

### C101 workspace trust 持久化
官方名称：workspace trust state
- 官方做什么：状态存 `<GEMINI_HOME>/antigravity-acp/trusted_workspaces.json`（trusted/untrusted，原子写，损坏备份）；AGY_ACP_DISABLE_WORKSPACE_TRUST=1|true|yes 可关闭检查；unknown 时问一次，其它回答记本轮抑制不写文件。
- 官方信号：`P/workspace_trust.py:17-41,56-227`；`P/hooks.py:365-431`。
- 官方不做什么：不在未信任时静默加载；不把不信任当永久拒绝；不把全局 hooks 纳入信任。
- Paseo 适配：适配器透传该 permission；Paseo 用户回答 trust/dont_trust。
- 适配状态：已对齐

## 八、命令

### C102 命令更新发送时机
官方名称：`available_commands_update`
- 官方做什么：new/load/resume 响应入队后，后台任务 sleep(0) 再发一次；每会话只在建立/恢复时发一次，不落盘。
- 官方信号：`S:5338-5354`、`3745-3748`、`4104`。
- 官方不做什么：不在每 turn 重发；不持久化；不提供命令结果独立通道。
- Paseo 适配：适配器追加技能命令后透传（`AD/proxy.ts:464-475`）；Paseo 缓存列表（`PC:3431-3437`）。
- 适配状态：已对齐

### C103 命令集合
官方名称：available commands
- 官方做什么：1.5.0 实际发布 plan/logout/usage 三条；构造时只带 name/description。
- 官方信号：`S:5344-5365`；`P/logout.py:39-42`；`P/usage.py:48-51`。
- 官方不做什么：不列技能为命令；不列 MCP 工具；不保证枚举之外的自定义命令。
- Paseo 适配：保留官方 `/plan`、`/logout`、`/usage` 的名称和说明，再追加可调用的本地技能。同名时官方优先（`AD/skill-commands.ts:193-243`）。
- 适配状态：已决定维持现状

### C104 `/plan`
官方名称：`/plan`
- 官方做什么：只是 prompt 文本中的内置斜杠命令，交给 SDK SlashCommand；没有 plan 模式，没有 plan session update。
- 官方信号：`S:1195-1213`、`1271-1280`。
- 官方不做什么：不把 /plan 当模式；不发 plan 事件；不提供 plan 审批 RPC。
- Paseo 适配：适配器透传 /plan；Paseo 命令列表可见并保留通用 plan 映射（`PC:3409-3411`），官方不会触发。
- 适配状态：已对齐

### C105 命令参数提示
官方名称：`AvailableCommand.input`
- 官方做什么：schema 支持 input.hint，但 1.5.0 构造时从不填；/usage 自己检查参数。
- 官方信号：`S:5355-5363`、`3455-3460`。
- 官方不做什么：不声明参数提示；不校验客户端参数。
- Paseo 适配：适配器 augment 只处理 name/description；Paseo 读 input?.hint，无值为空（`PC:3431-3437`）。
- 适配状态：已对齐

## 九、终态与错误

### C106 `end_turn`
官方名称：`end_turn`
- 官方做什么：默认成功终态；没有 SDK stop_reason 或无法映射时也回 end_turn。
- 官方信号：`S:5829-5834`、`1625-1653`。
- 官方不做什么：不保证 end_turn 一定有可见正文。
- Paseo 适配：有可见输出的正常 `end_turn` 记为完成。成功轮次完全没有可见内容时，适配器继续返回 `-32000` 失败（C114）。
- 适配状态：已决定维持现状

### C107 `max_tokens`
官方名称：`max_tokens`
- 官方做什么：SDK 输入/输出/总 token 超限都映射 max_tokens。
- 官方信号：`S:1633-1646`。
- 官方不做什么：不区分输入/输出/总超限；不附 token 计数。
- Paseo 适配：配套工作树将 `max_tokens` 映射为 `turn_failed`，`code` 保留官方原文 `max_tokens`（`PC:handlePromptResponse`）。三种 stopReason 的合成测试共 3 项通过。
- 适配状态：已对齐（工作树未提交，生产旧客户端没有）

### C108 `max_turn_requests`
官方名称：`max_turn_requests`
- 官方做什么：模型调用次数/工具调用次数超限映射 max_turn_requests。
- 官方信号：`S:1639-1646`。
- 官方不做什么：不说明是模型还是工具超限。
- Paseo 适配：配套工作树将 `max_turn_requests` 映射为 `turn_failed`，`code` 保留官方原文 `max_turn_requests`（`PC:handlePromptResponse`）。三种 stopReason 的合成测试共 3 项通过。
- 适配状态：已对齐（工作树未提交，生产旧客户端没有）

### C109 `refusal`
官方名称：`refusal`
- 官方做什么：QUOTA_EXHAUSTED 映射 refusal；正常带 response 时出现。
- 官方信号：`S:1646`。
- 官方不做什么：不把配额错误做成 JSON-RPC 错误；不保证所有配额路径都到这里。
- Paseo 适配：配套工作树将 `refusal` 映射为 `turn_failed`，`code` 保留官方原文 `refusal`（`PC:handlePromptResponse`）。三种 stopReason 的合成测试共 3 项通过。
- 适配状态：已对齐（工作树未提交，生产旧客户端没有）

### C110 `cancelled`
官方名称：`cancelled`
- 官方做什么：取消路径显式返回 cancelled；SDK 取消异常先发取消文本再 cancelled。
- 官方信号：`S:5716-5731`、`5826-5827`。
- 官方不做什么：不把取消当 end_turn；不保证取消后无工具终态。
- Paseo 适配：适配器透传；工作树把本地已取消但官方回 end_turn 改写为 cancelled（`AD/proxy.ts:564-567`）；Paseo 映射 turn_canceled（`PC:3621-3630`）。
- 适配状态：已对齐

### C111 `-32602` invalid params
官方名称：`-32602`
- 官方做什么：未知模式、未知 config id、非字符串值、不可用模型、未满足的认证方法/Vertex 配置、未知 auth method 都返回 -32602。
- 官方信号：`S:2741-2744`、`2838-2848`、`2926-2955`、`3027-3045`、`3099-3106`、`3160-3164`。
- 官方不做什么：不伪装成 -32603；不返回成功。
- Paseo 适配：适配器透传；Paseo 保留错误摘要（`PC:360-396`）。
- 适配状态：已对齐

### C112 `-32002` resource not found
官方名称：`-32002`
- 官方做什么：会话 trajectory 缺失时返回 -32002 并带定位数据。
- 官方信号：`S:1140-1142`、`3917-3940`。
- 官方不做什么：不在 prompt 的 session 缺失时用同一错误（抛 ValueError，通常 -32603）。
- Paseo 适配：适配器透传；Paseo 保留 code/message/data 摘要。
- 适配状态：已对齐

### C113 终态错误文案链与诊断隔离
官方名称：terminal error copy chain
- 官方做什么：SDK 终态异常先记日志，再按浏览器→MCP 加载失败→配额耗尽→通用 API 净化文案选一条，作为普通 agent_message_chunk 发出，随后默认 end_turn；官方不隔离诊断正文。
- 官方信号：`S:5732-5785`、`5829-5834`。
- 官方不做什么：不发 JSON-RPC error；不把错误正文与模型正文分通道；不标记诊断。
- Paseo 适配：工作树让已识别的计划重试和 HTTP 错误立即可见，轮次仍继续。只有内核确认本轮终止失败才报失败，并从正文排除该终止路径发出的诊断长文（`AD/proxy.ts:553-581`）。
- 适配状态：已对齐（工作树未提交，生产旧客户端没有）

### C114 空成功轮次
官方名称：blank successful turn
- 官方做什么：允许 end_turn 且无可见正文；没有空正文检查。
- 官方信号：`S:5829-5834`。
- 官方不做什么：不补“无输出”错误；不把空轮次改失败。
- Paseo 适配：成功轮次完全没有可见内容时，继续返回 `-32000` 失败（`AD/errors.ts:34-41`、`AD/proxy.ts:577-581`）。
- 适配状态：已决定维持现状

## 十、模型目录

### C115 内置静态目录（7 族）
官方名称：built-in model catalog
- 官方做什么：固定 7 族 gemini-4-carbon（Medium/High/Low，Agent Platform only）、gemini-4-argon（High/Medium/Low，Agent Platform only）、gemini-3.8/3.7/3.6/3.5-flash（High/Medium/Low）、gemini-3.1-pro（High/Low，base gemini-3.1-pro-preview）；每族第一个变体为默认；淘汰 id 仍保留。
- 官方信号：`P/model_selection.py:60-195`；`S:3481-3520`。
- 官方不做什么：不按 max_tokens 排序；不改族顺序；不隐藏淘汰 id。
- Paseo 适配：适配器不改表；Paseo 只渲染 configOptions。
- 适配状态：已对齐

### C116 Agent Platform 专属模型与默认值
官方名称：`agent_platform_only`
- 官方做什么：gemini-4-carbon/argon 只在 Agent Platform 路径；API key 默认 gemini-3.8-flash-high，Agent Platform 默认 gemini-4-carbon-medium；AGY_ACP_DEFAULT_MODEL 可覆盖且不校验值。
- 官方信号：`P/model_selection.py:126-141`、`180-195`、`313-328`。
- 官方不做什么：不在 API key 路径提供这两个族；不因客户端请求开放；不在 initialize 公布默认。
- Paseo 适配：Paseo 无 Agent Platform 认证入口，不可达。
- 适配状态：官方条件不满足

### C117 CCPA 目录顺序、disabled 与旧档位
官方名称：CCPA model catalog
- 官方做什么：按 agentModelSorts 顺序展平去重；缺详情跳过并告警；disabled 跳过；档位先查 5 条旧 id，再按尾部 -<level>（可带 -effort）解析；显示名去掉档位括号。
- 官方信号：`P/model_selection.py:206-311`、`349-408`。
- 官方不做什么：不重排；不猜缺失条目；不把 disabled 降级显示。
- Paseo 适配：适配器透传；Paseo 只消费目录。
- 适配状态：已对齐

### C118 图像模型按认证绑定
官方名称：image model target
- 官方做什么：每会话固定挂 IMAGE target；OAuth 用 gemini-3.1-flash-image，企业用 gemini-3-pro-image，其余用 SDK 默认；不列入 configOptions。
- 官方信号：`S:1177-1182`、`4197-4207`、`4700-4760`。
- 官方不做什么：不让用户选图像模型；不把图像 target 显示成文本模型。
- Paseo 适配：适配器透传；Paseo 只看到 generate_image 工具调用/输出。
- 适配状态：已对齐

### C119 网关模型目录
官方名称：gateway model catalog
- 官方做什么：AGY_LLM_GATEWAY_MODELS 优先，除非 admin_settings 设 models.list/listSource；否则四层目录；内置 id 保留元数据、基础 id 展开变体、其余为 custom（受 MAX_CUSTOM_MODELS）；gateway 不走 _finalize_model_state 自补。
- 官方信号：`P/model_selection.py:488-630`；`S:4666-4700`。
- 官方不做什么：不在 gateway 路径调用 CCPA；不允许保留被撤回模型；不与 CCPA 合并。
- Paseo 适配：Paseo 不设 auth.type=gateway，不读 admin_settings，官方不进入。
- 适配状态：官方条件不满足

## 十一、策略、工具、MCP、技能与重试

### C120 `policy.safe_defaults` 基线
官方名称：`safe_defaults`
- 官方做什么：allow read_only（view_file/read_url_content/schedule/finish）与 deprecated（list_directory/search_directory/find_file），再加 ask_user("*")；其余落到通配询问。
- 官方信号：`K/hooks/policy.py:464-480`；`K/types.py:564-603,653-681`；`S:4384`。
- 官方不做什么：不基线允许 create/edit/run_command/ask_question/invoke_subagent/run_workflow/generate_image/search_web；不把 deprecated 放进 default()。
- Paseo 适配：适配器不改 policies；Paseo 只看到官方 permission。
- 适配状态：已对齐

### C121 政策优先级
官方名称：policy precedence
- 官方做什么：Specific Deny > Specific Ask > Specific Allow > Wildcard Deny > Wildcard Ask > Wildcard Allow；同桶先匹配先返回；enforce 排序键先范围（具体0、server/*1、全局*2）再决策（DENY0/ASK1/APPROVE2）。
- 官方信号：`K/hooks/policy.py:19-31`、`934-942`；`S:4385-4418`。
- 官方不做什么：不按书写顺序决定优先级；不让通配压过具体；不把 ask 当 deny。
- Paseo 适配：适配器不重排/不改写 policies；Paseo 只消费最终 permission。
- 适配状态：已对齐

### C122 `read_url_content` 的 ask 覆盖
官方名称：`read_url_content` policy override
- 官方做什么：safe_defaults 因 read_only 给它具体 allow；官方插具体 ask_user("read_url_content")，压过 allow，理由是不可信远端内容是提示注入面。
- 官方信号：`S:4399-4418`；`K/types.py:564-573`；`K/hooks/policy.py:19-31`。
- 官方不做什么：不禁用该工具；不按 URL 来源区分；不改 search_web 的询问。
- Paseo 适配：适配器不改策略；Paseo 收到实际 permission。
- 适配状态：已对齐

### C123 非管理员 `view_file` 边界
官方名称：`view_file` scope policy
- 官方做什么：非管理员会话在 safe_defaults 之上前置具体 deny("view_file", when=outside)，限制在 allowed_dirs（cwd+additional+GEMINI_HOME+技能）；原因是 harness 内建 containment 还放行临时目录与 memory。
- 官方信号：`S:519-546`、`4331-4335`、`4431-4437`。
- 官方不做什么：不在管理员会话套用；不阻止工作区内读取；不对无路径调用报错。
- Paseo 适配：适配器不改策略；Paseo 只消费 permission/结果。
- 适配状态：已对齐

### C124 管理员 outside-workspace 文件策略
官方名称：outside-workspace file access policy
- 官方做什么：企业路径对 14 个命名文件工具各挂 deny/ask_user，再对 "*" 挂通配覆盖 MCP 文件工具与 exec；DENY 阻止、ALWAYS_ASK 每次问、NOT_ENFORCED 不限制；UNSPECIFIED 归一化 DENY；管理员会话关闭 harness 内建 containment。
- 官方信号：`S:347-372`、`1967-2048`、`4423-4437`、`4692-4693`。
- 官方不做什么：不对工作区内加限制；不一次性读值；不依赖 SDK file_tools()。
- Paseo 适配：仅企业 oauth-business 可达；Paseo 无企业策略入口。
- 适配状态：官方条件不满足

### C125 exec 越界 token 扫描
官方名称：exec outside-workspace detection
- 官方做什么：shlex.split 拆 CommandLine，跳过 argv[0]，只检查参数；绝对路径、~/$HOME、相对路径按 Cwd（回退 workspace）解析，再与 roots 比较；--flag=value 检查值，裸 flag 跳过；无法解析 fail-open。
- 官方信号：`S:564-626`、`628-662`、`664-741`。
- 官方不做什么：不把 argv[0] 当文件访问；不声称完备；不替代终端复核或 OS 沙箱。
- Paseo 适配：仅管理员策略调用；Paseo 无企业分支。
- 适配状态：官方条件不满足

### C126 `AdminControls.allowed_models` 已解析未执行
官方名称：`allowed_models`
- 官方做什么：解析顶层 allowedModels 成 tuple；is_model_allowed 实现并支持 projects/.../models/xxx 归一化；空 tuple 表示全允许；但 server.py 全文没有任何调用/读取。
- 官方信号：`P/admin_controls_manager.py:120-137`、`338-360`、`370-395`、`815-828`；`S` 无命中。
- 官方不做什么：不按允许列表过滤 configOptions；不拒绝模型切换；不传给 harness。这是官方自身未接线。
- Paseo 适配：Paseo 不读企业策略。
- 适配状态：官方条件不满足

### C127 管理员适用门与 Safe Defaults
官方名称：AdminControls
- 官方做什么：只有 oauth-business 且 user_tier/project/location 齐备才适用；初始 FetchConfig 遇 5xx/408/429/网络错误回落 Safe Defaults（MCP 关、终端复核、工作区外 always ask、沙箱关、浏览器关、JS 关、allowed_models/mcp_allowlist 空）；401/403、其它 4xx、token/许可失败阻断会话。
- 官方信号：`P/admin_controls_manager.py:719-736`、`292-320`、`741-805`；`S:3660`。
- 官方不做什么：不在非 entitlement 会话套用；不把空 allowed_models 当全禁；不在 transient 失败阻断。
- Paseo 适配：Paseo 无企业 entitlement 分支。
- 适配状态：官方条件不满足

### C128 `-32001` 管理员策略校验错误
官方名称：`-32001`
- 官方做什么：企业策略无法验证时返回 -32001；401/403 → admin_controls_permission_denied，其它非 transient 4xx → admin_controls_verification_failed；消息带项目名。
- 官方信号：`P/admin_controls_manager.py:82-92`、`1006-1040`；`S:3660`。
- 官方不做什么：不复用 -32000；不在 transient 失败发 -32001；不塞 IAM 详情。
- Paseo 适配：适配器透传 code/data；Paseo 保留摘要，无企业策略 UI。
- 适配状态：官方条件不满足

### C129 OS 沙箱 exebox
官方名称：exebox / enable_sandbox
- 官方做什么：macOS/Windows 支持；Linux 探测两个 userns 开关；仅企业 + sandbox_mode 开 + 主机支持时传 enable_sandbox=True；PROCEED_IN_SANDBOX 在沙箱不可用时回落逐条复核。
- 官方信号：`P/terminal_sandbox.py:32-176`；`S:4563-4573`。
- 官方不做什么：不在非企业启用；不把沙箱当权限替代；不在 Linux 假设可用。
- Paseo 适配：仅企业可达；Paseo 不触发。
- 适配状态：官方条件不满足

### C130 `BuiltinTools.default()` 成员表
官方名称：`BuiltinTools.default()`
- 官方做什么：枚举全部工具，排除 ASK_QUESTION 与 list_directory/search_directory/find_file；默认集为 view_file/create_file/edit_file/run_command/invoke_subagent/run_workflow/generate_image/search_web/read_url_content/schedule/finish。
- 官方信号：`K/types.py:501-681`；`S:4555-4568`。
- 官方不做什么：不把 ask_question 放进 default；不把 deprecated 放进默认；不使用 disabled_tools 字段。
- Paseo 适配：适配器不改工具表；Paseo 不传过滤时得到默认集 + ask_question。
- 适配状态：已对齐

### C131 `enabledTools` / `disabledTools`
官方名称：tool filter
- 官方做什么：enabledTools 允许列表，不在其中全禁，[] 全禁；disabledTools 拒绝列表，与允许列表同时存在做减法；省略字段无意见；{"disabledTools":[]} 清除持久过滤；只作用内建工具。
- 官方信号：`P/tool_filter.py:56-165`；`P/request_meta.py:23-49`；`S:3680`、`3981-3994`。
- 官方不做什么：不读下划线拼写；不对 MCP/client_* 生效；不猜未知名字。
- Paseo 适配：适配器不改键；Paseo 设置页原样保存 `_meta`。
- 适配状态：已对齐

### C132 工具名匹配契约
官方名称：builtin tool name matching
- 官方做什么：只接受 BuiltinTools 值，仅容忍首尾空白；枚举名不认；未知名字 warning 后跳过。
- 官方信号：`P/tool_filter.py:25-53`、`137-165`。
- 官方不做什么：不做大小写折叠/别名/前缀匹配；不把 MCP 名当内建。
- Paseo 适配：适配器不翻译工具名；Paseo 发什么由 Paseo 决定。
- 适配状态：已对齐

### C133 客户端 `view_file` 输出格式
官方名称：`view_file` output
- 官方做什么：加行号前言；正文 800 行/45 KiB 双限额；单文件 100 MiB；超限给“不是完整文件”说明；超长行截断说明；二进制拒绝并提示内建 view_file。
- 官方信号：`P/tools.py:74-121`、`176-303`、`305-557`。
- 官方不做什么：不返回裸内容；不一次返回超限内容；不把二进制当文本。
- Paseo 适配：适配器透传；Paseo 只显示 raw_output。
- 适配状态：已对齐

### C134 行号回写拒绝
官方名称：copied line-number rejection
- 官方做什么：写工具检测内容是否带 `<数字>:` 前缀；至少 80% 非空行且至少 3 行递增时拒绝，提示删行号。
- 官方信号：`P/tools.py:98`、`125-160`、`421-557`。
- 官方不做什么：不静默剥离；不把它当成功；不误伤 YAML 整数键。
- Paseo 适配：适配器透传；Paseo 显示工具结果。
- 适配状态：已对齐

### C135 子 agent 与工具过滤耦合
官方名称：`invoke_subagent` / `start_subagent`
- 官方做什么：start_subagent（真实枚举 invoke_subagent，start_subagent 是 deprecated alias）被过滤时 enable_subagents=False；浏览器子 agent 因此也不注入。
- 官方信号：`S:4445-4458`、`4566-4572`、`4528-4531`；`K/types.py:501-681`。
- 官方不做什么：不在子 agent 被禁时保留浏览器半套能力；不把 alias 当独立工具。
- Paseo 适配：适配器透传工具过滤；Paseo 不特别处理子 agent。
- 适配状态：已对齐

### C136 `eagerMcpServers` / `forceAllToolsEager`
官方名称：`eagerMcpServers`
- 官方做什么：会话级 eagerMcpServers 或单条 forceAllToolsEager=true 命中即 force_all_tools_eager=True；工具直接进 prompt，不走 call_mcp_tool + 磁盘 schema；名单不持久化，load/resume 重发。
- 官方信号：`P/mcp_servers.py:27-34`、`90-131`；`S:3681-3684`、`3995-3999`。
- 官方不做什么：不持久化；不提供工具级 eager；不把 eager 当权限许可。
- Paseo 适配：适配器不改 `_meta`；Paseo 设置页原样保存。
- 适配状态：已对齐

### C137 `mcpMaxOutputBytes`
官方名称：`mcpMaxOutputBytes`
- 官方做什么：会话级 `_meta.antigravity.mcpMaxOutputBytes` 必须正整数；bool/非正整数 warning 后忽略；经 CapabilitiesConfig.mcp_max_output_bytes 传 harness；None 保持 harness 默认（文档 4096 字节）。
- 官方信号：`P/mcp_servers.py:35`、`133-158`；`S:4563-4565`。
- 官方不做什么：不对单条服务器生效；不把非法值当 0；不保证 harness 一定按该值截断。
- Paseo 适配：适配器透传；Paseo 设置页可保存。
- 适配状态：已对齐

### C138 MCP 加载失败文案
官方名称：MCP load failure message
- 官方做什么：识别 `MCP load failed for <name>: <reason>`，折叠 Go 多层错误，生成纯文本“The MCP server '<name>' failed to initialize: <reason>. Fix the MCP server, or remove it ...”；优先于通用 API 错误。
- 官方信号：`P/mcp_errors.py:53-95`；`S:5747-5757`。
- 官方不做什么：不重试加载；不自动移除；不套用非 MCP 错误。
- Paseo 适配：适配器透传普通 chunk；Paseo 当正文显示。
- 适配状态：已对齐

### C139 官方技能发现路径
官方名称：skills paths
- 官方做什么：固定顺序 `<GEMINI_HOME>/config/skills`、项目 `.gemini/skills`、`<GEMINI_HOME>/antigravity-cli/skills`、项目 `.agents/skills/`；项目项对 cwd 与每个 additionalDirectories 各展开；全局目录跟随 GEMINI_HOME。
- 官方信号：`S:1468-1510`；`P/paths.py:176-195`；`S:4297`。
- 官方不做什么：不扫描 .paseo/.codex/.claude；不递归；不读 skills.json；不发技能列表。
- Paseo 适配：官方 5 组由官方消费；适配器另扫 Paseo/Codex/Claude 只用于追加命令（`AD/skill-commands.ts:108-243`），两套机制互不替代。
- 适配状态：已对齐

### C140 技能目录进入 allowed_dirs
官方名称：skills allowed dirs
- 官方做什么：allowed_dirs 含 cwd、additional、GEMINI_HOME、技能目录；skills_paths 单独传 harness；workspaces 只含 cwd+additional；hooks workspace_paths 含技能目录。
- 官方信号：`S:4331-4335`、`4692`、`4704`、`4610-4614`。
- 官方不做什么：不把技能目录当写边界；不扩大 workspaces。
- Paseo 适配：适配器不改变官方路径；Paseo 自己的技能 MCP 是扩展。
- 适配状态：已对齐

### C141 计划重试唯一日志源与 502 边界
官方名称：model retry scheduled
- 官方做什么：计划重试没有 ACP 信号；local_connection 的 stderr reader 把 harness 每行转 logging；harness 决定重试时打印 `Encountered retryable api error. retrying in <duration>`；普通 502 不是这条日志，也不是计划重试；重试次数/退避由 harness 默认策略决定。
- 官方信号：`/tmp/agy150/src/local_connection.py:541-559`（尤其 553）、`144-163`、`1355-1358`；`S` 无重试通知发送点。
- 官方不做什么：不发 session/update；不发 JSON-RPC error；不告诉客户端已计划重试；不把 502 当计划重试。
- Paseo 适配：工作树只在内核明确记录已安排重试时立即提示，本轮继续。普通 502 只显示 HTTP 错误，不推断计划重试，不改变官方重试策略。
- 适配状态：已对齐（工作树未提交，生产旧客户端没有）

### C142 `RetryConfig` 不由 server 注入
官方名称：harness default retry
- 官方做什么：server 构造 LocalAgentConfig/ProxyAgentConfig 不传 retry_config；ProxyAgentConfig 透传调用方值（默认 None）；空配置返回 None；harness 用默认重试策略。
- 官方信号：`/tmp/agy150/src/proxy_agent_config.py:132`；`/tmp/agy150/src/local_connection.py:144-163`；`S:4670-4710` 无 retry 键。
- 官方不做什么：不覆盖 harness 默认；不把重试参数做成 ACP 选项；不让客户端改策略。
- Paseo 适配：适配器工作树只读观察，不替换策略；HEAD 不观察。
- 适配状态：已对齐

### C143 连接断开重建并重试一次
官方名称：connection rebuild retry
- 官方做什么：上一轮致命/取消可能让 harness 死掉、websocket 1000 关闭；下一轮 chat 抛 ConnectionClosed；官方重建一次 agent 并重试本轮；第二次关闭发连接丢失正文并结束，不暴露 -32603。
- 官方信号：`S:5596-5616`、`5624-5670`、`5768-5785`。
- 官方不做什么：不无限重建；不把重建失败当 JSON-RPC error；不丢历史。
- Paseo 适配：适配器透传；Paseo 只看到正常重试后的轮次或连接丢失正文。
- 适配状态：已对齐

### C144 API 错误净化
官方名称：API error sanitization
- 官方做什么：从 Go `google.rpc.Status` 取公开 message；无匹配则剥掉 Details 块并包成“Agent execution error: …”；唯一例外是 ErrorInfo 的 validation_url/appeal_url，且只接受 https 的 google.com 或其子域。
- 官方信号：`P/api_errors.py:32-175`。
- 官方不做什么：不展示非 Google 域链接；不展示 DebugInfo；不翻译错误码；不泄露 Details。
- Paseo 适配：适配器透传净化后文本；Paseo 不二次净化。
- 适配状态：已对齐

### C145 配额耗尽文案
官方名称：quota exhausted message
- 官方做什么：针对 QUOTA_EXHAUSTED 形状重写文案为“Usage Limit Reached / You have reached your current quota for this period.”；解析 quotaResetDelay/quotaResetTimeStamp（Go duration 支持）；不做升级推销。
- 官方信号：`P/ccpa_connection/quota_errors.py:14-147`；`S:5755`。
- 官方不做什么：不主动对其他认证查配额；不展示升级链接；不把查询失败当 /usage 失败。
- Paseo 适配：适配器透传正文；Paseo 当普通消息显示。
- 适配状态：已对齐

### C146 工具 kind 推断
官方名称：tool kind inference
- 官方做什么：MCP 一律 other；run_command/shell→execute；AUTO_EDIT_TOOLS→edit；FILE_READ_TOOLS→read；read_url_content→fetch；SEARCH_TOOLS→search；其余 other；同时抽 locations/content，MCP 先拆包。
- 官方信号：`P/tools.py:705-738`、`558-665`、`764-830`、`860-1032`；`S:5103-5111`、`6116-6124`。
- 官方不做什么：不发明 ACP 之外 kind；不为 UI 改工具名。
- Paseo 适配：适配器透传；Paseo 只渲染工具快照。
- 适配状态：已对齐

### C147 原生技能呈现
官方名称：skills presentation
- 官方做什么：1.5.0 把内置技能写入工作区；server.py 完全不出现 presentation_mode/SkillsConfig；呈现方式由官方/harness 决定；ACP 无开关；不发技能 session update。
- 官方信号：`S` 全文无该符号；`S:4297`；工作树实测 `skills/system/run-workflow/SKILL.md` 两侧同哈希（B 稿记录）。
- 官方不做什么：不提供 SkillsConfig.TOOL 改写入口；不发技能列表。
- Paseo 适配：工作树已删除 `SkillsConfig.TOOL` 改写。原生技能采用内核默认呈现方式，Paseo 的本地技能命令和资源独立提供。
- 适配状态：已对齐（工作树未提交，生产旧客户端没有）

## 十二、官方本来就不发的信号

### C148 plan session update 与 plan 模式
官方名称：`plan`
- 官方做什么：没有。`/plan` 只是 prompt 斜杠命令；没有 plan session update，没有 plan 模式。
- 官方信号：`S:1195-1213`、`1271-1280`；`P/config_options.py:25-41`。
- 官方不做什么：不发 plan 事件；不提供只读 plan 模式；不提供 plan 审批 RPC。
- Paseo 适配：Paseo 有通用 plan 分支（`PC:3409-3411`），官方不会触发。
- 适配状态：非官方扩展

### C149 `current_mode_update`
官方名称：`current_mode_update`
- 官方做什么：没有。模式变化只通过 set_mode/set_config_option 响应体现；服务端不主动发模式变更通知。
- 官方信号：`S` 无发送点；`S:2754-2756`、`2949-2950`。
- 官方不做什么：不在自动策略改变模式时发通知；不把模式塞进 config_option_update。
- Paseo 适配：Paseo 有 current_mode_update 分支（`PC:3412`），官方不会触发。
- 适配状态：非官方扩展

### C150 `session_info_update`
官方名称：`session_info_update`
- 官方做什么：没有。session/list 标题固定；没有改标题 RPC，也不返回 updatedAt。
- 官方信号：`S` 无发送点；`S:3864-3866`。
- 官方不做什么：不生成动态标题；不发 session_info_update；不更新时间戳。
- Paseo 适配：Paseo 有 handleSessionInfoUpdate（`PC:3584-3592`），官方不会触发。
- 适配状态：非官方扩展

### C151 `session/close`
官方名称：`session/close`
- 官方做什么：没有声明也没有实现；sessionCapabilities 只有 list/resume/additionalDirectories。
- 官方信号：`S:2685-2691`；`S` 无 close_session。
- 官方不做什么：不返回成功；不能用它释放会话；释放只能靠 logout/断开。
- Paseo 适配：适配器转发 close 并在成功时释放技能 token（`AD/proxy.ts:279-283,533-544`）；Paseo 只在能力位存在时调用，官方未声明所以不调用。
- 适配状态：非官方扩展

### C152 `session/delete`、`session/fork`
官方名称：delete/fork/custom
- 官方做什么：没有。只实现 initialize/authenticate/logout/new/load/resume/list/set_mode/set_model/set_config_option/prompt/cancel。
- 官方信号：`S` 无 delete_session/fork_session；能力位 `S:2679-2708`。
- 官方不做什么：不删除、不 fork、不提供 mcp.acp 等扩展路由。
- Paseo 适配：适配器只通用转发，不合成这些方法；Paseo 不依赖。
- 适配状态：官方条件不满足

### C153 客户端 `terminal/*`
官方名称：client terminal
- 官方做什么：没有调用。命令在 harness 内执行，官方不请求客户端开终端。
- 官方信号：`S` 无 terminal/create 等；exec 路径 `S:5618-5641`、`6263-6266`。
- 官方不做什么：不请求客户端终端；不使用 ACP 终端能力位。
- Paseo 适配：Paseo 声明 terminal:true（`PC:455-461`），官方永远不消费。
- 适配状态：官方条件不满足

### C154 全局排队/席位/冷却
官方名称：scheduling
- 官方做什么：没有 ACP 调度信号；new/prompt 不发排队位置、席位、冷却、启动延迟；cancel 只取消当前 turn。
- 官方信号：`S:3631-3757`、`5499-5834`、`3759-3772`。
- 官方不做什么：不保证跨会话并发额度；不告诉客户端排队。
- Paseo 适配：适配器 HEAD/工作树已删除全局 Admission；独立会话直接派发，只保留同一 session 拒绝重叠 prompt（`AD/proxy.ts:352`）。
- 适配状态：官方条件不满足

### C155 HTTP 错误状态没有 ACP 通道
官方名称：backend HTTP error
- 官方做什么：没有 ACP 通知；HTTP 失败只在 harness stderr、SDK 异常字符串和错误文案链里可见。
- 官方信号：`S` 无状态码通知；`S:5726-5762`。
- 官方不做什么：不发 HTTP 502 这类结构化通知。
- Paseo 适配：工作树识别本轮内核 HTTP 错误后立即显示状态码。状态已完成、错误码为 503 的错误消息也会立即显示为 HTTP 503，同一轮只提示一次，本轮继续。普通 502 不标成计划重试，只有官方明确安排重试才另行提示（`AD/proxy.ts:598-625`）。
- 适配状态：已对齐（工作树未提交，生产旧客户端没有）

### C156 终态 JSON-RPC 失败
官方名称：structured turn failure
- 官方做什么：没有。SDK 终态失败先发普通正文，最终仍 end_turn；PromptResponse 不带错误码。
- 官方信号：`S:5732-5785`、`5829-5834`。
- 官方不做什么：不发 -32000 turn_failed；不发 error class；不发最后 HTTP 状态。
- Paseo 适配：工作树只在读到本轮终止失败的内核记录时返回 `-32000`，配套客户端显示失败。该终止路径的诊断长文不留在正文，之前的 HTTP 或计划重试提示不结束本轮（`AD/proxy.ts:553-581,651-664`）。
- 适配状态：已对齐（工作树未提交，生产旧客户端没有）

## 十三、按根因归并的缺口索引

按本次决定，下列 30 项维持现状，12 项在工作树已对齐。目录中不再有状态为“有缺口”或“已知差异”的条目。

| 决定 | 涉及条目 | 对用户的影响 |
| --- | --- | --- |
| 已决定维持现状 | C003、C016–C019、C022–C026、C040 | 仅终端 `paseo-agy-acp --login` 办理 Google 登录，固定 `oauth-personal`。对话框无登录或退出入口，本次不提供企业、API key 或企业平台登录。 |
| 已决定维持现状 | C005、C032、C008、C009、C059–C061 | 崩溃后优先 load 重放历史。粘贴图片发图片块，上传文件（含音频）只交本机位置。 |
| 已决定维持现状 | C012、C013 | 默认逐条前置 daemon 背景，可显式启用官方会话级追加。连接回包继续显示 `agy-acp` 和当前标题。只有 daemon 没有保存背景说明，或已设置 `PASEO_AGY_ACP_NATIVE_SYSTEM_CONTEXT=1` 时，官方内核才会截住 `/usage` 和 `/logout`，否则前置的背景文字会让这两条命令作为普通消息进入模型。 |
| 已决定维持现状 | C046、C057、C091、C099、C103 | 官方三条命令后追加本地技能。仅 YOLO 标记无人值守并自动选信任，其他模式由人回答信任问题。 |
| 已决定维持现状 | C066、C068、C083、C106、C114 | 用量、引用等官方原文按普通回复显示，只有官方系统封套加标记。成功却无可见内容时返回 `-32000`。 |
| 已对齐（工作树未提交，生产旧客户端没有） | C011、C082、C087、C107–C109 | 配套客户端显示档位、保留六项用量和警告正文。三种非成功 stopReason 都记为失败，code 保留原值，合成测试 3 项通过。 |
| 已对齐（工作树未提交，生产旧客户端没有） | C015、C147 | 已删除第三方模型白名单覆盖和技能呈现改写，均遵循官方规则。 |
| 已对齐（工作树未提交，生产旧客户端没有） | C113、C141、C155、C156 | 计划重试和 HTTP 错误立即提示，本轮仍继续。普通 502 不推断重试，确认终止失败后才报失败，并隔离该终止路径的诊断正文。 |

其余特殊条目保留原分类：C014、C021、C096–C098、C116、C119、C124–C129、C152–C154 共 16 项为“官方条件不满足”，C148–C151 共 4 项为“非官方扩展”。官方未提供的事件或 RPC 不作为本次修复项目。

## 十四、仍未确认

1. **Go harness `planner_generator.go:359` 的原文与打印频率。** `local_connection.py:541-559` 只证明逐行转发 stderr；Go 源码不在解包内，不能确认模板每个重试计划恰好打印一次。本次在固定版本的 harness 二进制中找到了前缀 `Encountered retryable api error. retrying in `。完整原文以及每个重试计划是否只打印一次，本次未观测。
2. **harness 默认重试策略的具体数值。** 能确认 server 不注入 RetryConfig，但默认次数、退避、可重试错误集合不在解包内。本次一个真实短消息轮次的轨迹中有五条 503 错误记录，没有出现上述重试前缀。默认重试次数、退避和可重试错误集合，本次未观测。
3. **`forceAllToolsEager` 在 harness 内的实际行为。** 能确认官方转成 force_all_tools_eager=True 并传 SDK，但 harness 如何变成 native prompt 工具未读。`forceAllToolsEager` 在 harness 内的实际行为，本次未观测。
4. **`mcpMaxOutputBytes` 的真实截断行为。** 4096 字节来自 `K/types.py` 的 CapabilitiesConfig 文档注释，不是 harness 实现。`mcpMaxOutputBytes` 的实际截断边界，本次未观测。
5. **未实现方法的实际错误码。** `session/close`、`delete`、`fork` 等依赖 SDK 默认路由，通常 -32601，但未实测。未实现方法的实际错误码，本次未观测。
6. **`authenticate` 除 `logged_out` 之外的 `data` 形状。** 只确认了 `data.reason="logged_out"`，其它认证错误是否带 data 未逐条确认。`authenticate` 除 `logged_out` 以外的错误 `data`，本次未观测。
7. **JSON-RPC 路由名。** `server.py` 无路由字符串；所有 RPC 章节标题带 †，路由名待 SDK 核对（尤其 set_model 的 unstable 前缀）。本次实际使用的线路名为 `initialize`、`session/new`、`session/set_config_option`、`session/set_mode` 和 `session/prompt`。`set_model` 的线路名及前缀，本次未观测。
8. **`session/list` 的 nextCursor 是否真的不在 wire 上。** `S:3883-3885` 只构造 sessions，本文据此写不返回 cursor，未抓包。`session/list` 回包是否包含 `nextCursor`，本次未观测。
9. **`BuiltinSlashCommandName` 完整枚举。** 1.5.0 实测只发布 plan/logout/usage，但枚举全量未展开，不宣称只有三条。本次会话中官方公布的命令是 `plan`、`logout`、`usage`。完整枚举本次未观测。

## 十五、状态计数

- 合并后条数：156（C001–C156）。
- 已对齐：94
- 已对齐（工作树未提交，生产旧客户端没有）：12
- 已决定维持现状：30
- 官方条件不满足：16
- 非官方扩展：4
- 有缺口：0
- 已知差异：0
- 合计：156
- 去重：四稿原始 340 条（135 + 107 + 36 + 62），合并后 156 条，去掉重复 184 条。去重按官方行为，不按编号；同一行为的不同细节合并为一条。
- 未确认：9 条。
