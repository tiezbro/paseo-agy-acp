# 官方 agy_acp_server 1.5.0 协议能力底稿（调研席 A）

这是调研席 A 的独立底稿，不是合并稿，不是验收证书。本文只从官方源码的协议面出发，逐条列出未修改的 `agy_acp_server` 1.5.0 已经给出的能力，再附 Paseo 适配现状。文中没有 file:line 或实测路径的判断，不得当成已通过验收。

## 版本、哈希与仓库

- 官方版本：`antigravity-acp` 1.5.0（`_version.py:3` 为 `__version__ = "1.5.0"`）。
- 主入口：`/tmp/agy150/src/server.py`。
- 实测 SHA-256：`c4a5909af7ba15079309a67012014d071c608ac920ab229f3a2344f21383e4fb`，与任务给定的值一致。
- `/tmp/agy150/src/` 只有 `server.py`、`local_connection.py`、`main.py`、`proxy_agent_config.py` 与一个 `sdk/` 目录，不足以覆盖 `config_options`、`model_selection`、`logout`、`usage`、`tools`、`mcp_servers`、`hooks`、`browser_subagent` 等被 `server.py` 调用的协议模块。本文对这些模块的引用来自 `/tmp/agy-audit-57c8.MDpA52/par-source/google3/cloud/developer_experience/antigravity_extensions/acp_server/`；该目录的 `server.py` 与 `/tmp/agy150/src/server.py` 同哈希 `c4a5909a…e4fb`。下文凡写 `PAR/` 的模块，均指这一份同哈希官方解包。
- 适配器仓：`/home/tiezbro/projects/paseo-agy-acp`，分支 `refactor/official-core-paseo-lightweight`，HEAD `3443b97d232955d90b3db0c7c180fb7fcded9942`。工作树有未提交改动，关键文件为 `ACP Connector/official-kernel/proxy.ts`、`run.ts`、`kernel-compat-rc01-recipe.ts`、`assets/official-kernel-compat/rc01/paseo_model_compat.py`，以及新增的 `kernel-events.ts`、`kernel-event-tracker.ts`、`kernel-terminal-state.ts`。
- 配套仓：`/home/tiezbro/projects/MAACS-agy-capabilities`，分支 `feat/antigravity-official-capabilities`，HEAD `b9726d2d379956ee38075c28d73ec66fb6f6d985`。工作树有未提交的 `paseo/packages/server/src/server/agent/providers/acp-agent.ts`、`acp-mode-policy.test.ts`、协议类型与 UI 选择器改动。
- 生产旧客户端：本轮未切换，源码不在上述两仓当前分支内，版本与逐项行为均未核实。下文写“生产：未核实”即指这一状态；写“生产未部署”只表示本轮改动没有进入生产，不表示生产行为已经过验证。

状态只用五种：

- **已对齐**：官方信号存在，适配器/Paseo 源码按官方形状透传或消费，未发现协议层矛盾；不等于真实账号已验收。
- **有缺口**：官方信号存在，但适配器或 Paseo 未消费、只消费一部分，或只有模拟证据。
- **已知差异**：适配器/Paseo 有意改写、替换或补偿官方行为。
- **官方条件不满足**：能力是官方的，但当前 Paseo/环境不满足触发条件，或官方明确不发。
- **非官方扩展**：协议里没有，由适配器或 Paseo 增加。

方法名说明：`server.py` 是 Python 方法实现，不包含 JSON-RPC 路由字符串。`initialize`、`session/new`、`session/load`、`session/resume`、`session/list`、`session/set_mode`、`session/set_model`、`session/set_config_option`、`session/prompt`、`session/cancel`、`logout` 这些路由名来自 ACP v1 与 `server.py` 注释（例如 `session/setMode`、`session/set_model`、`session/set_config_option`），不是从 `server.py` 字面抓到的。此点列入文末“未从源码确认”。

---

## 一、初始化与能力位

### I01 initialize 与协议版本回显
官方名称：`initialize`
- 官方做什么：接收客户端 `protocolVersion`，把它原样放进 `InitializeResponse`；同时读取 `clientCapabilities` 与 `clientInfo`，据此决定后续能力与 User-Agent。官方不校验版本号，也不在响应里另造版本。
- 官方信号：RPC `initialize`；响应字段 `protocolVersion`、`agentCapabilities`、`agentInfo`、`authMethods`。`server.py:2576-2716`。
- 官方不做什么：不拒绝未知协议版本；不主动发额外通知；不在运行时再次协商。
- Paseo 适配：适配器透传 initialize，只覆盖 `agentInfo`（`ACP Connector/official-kernel/proxy.ts:513-515`、`identity.ts:3-16`）。Paseo 发送 `PROTOCOL_VERSION` 与 `clientInfo:{name:"Paseo",version:"dev"}`（配套 `acp-agent.ts:3209-3214`）。适配 HEAD=WT。
- 适配状态：已对齐

### I02 `loadSession` 能力位
官方名称：`loadSession`
- 官方做什么：声明支持 `session/load`，并在 load 时重放历史。客户端据此选择 load 而不是 resume。
- 官方信号：`agentCapabilities.loadSession=true`（`server.py:2679-2681`）。
- 官方不做什么：不声明 load 的分页或增量重放；不保证重放所有内部步骤。
- Paseo 适配：Paseo 读 `agentCapabilities.loadSession`，为真时走 `session/load`，否则才走 `unstable_resumeSession`（配套 `acp-agent.ts:2086-2104`）。适配 HEAD=WT。
- 适配状态：已对齐

### I03 `auth.logout` 能力位
官方名称：`logout` capability
- 官方做什么：在 `agentCapabilities.auth.logout` 公布 `logout`；客户端只应在此能力存在时调用 `logout`。
- 官方信号：`schema.AgentAuthCapabilities(logout=schema.LogoutCapabilities())`（`server.py:2681-2684`）。
- 官方不做什么：不公布认证方法的默认选择；不把 `authenticate` 成功等同于账号可用。
- Paseo 适配：适配器透传该能力位，但 Paseo 全文件没有 `authenticate`/`logout` 调用（配套 `acp-agent.ts` 无对应调用）。生产：未核实。
- 适配状态：有缺口

### I04 `sessionCapabilities.list`
官方名称：`session/list` capability
- 官方做什么：声明可枚举本地会话。
- 官方信号：`sessionCapabilities.list`（`server.py:2685-2687`）。
- 官方不做什么：不声明分页能力；`session/list` 实现忽略 `cursor`。
- Paseo 适配：Paseo 只在能力位存在时调用 `listSessions`，并循环 `nextCursor`；官方不返回 cursor 时自然结束（配套 `acp-agent.ts:1420-1450`）。适配 HEAD=WT。
- 适配状态：已对齐

### I05 `sessionCapabilities.resume`
官方名称：`session/resume` capability
- 官方做什么：声明支持恢复会话但不重放历史。
- 官方信号：`sessionCapabilities.resume`（`server.py:2685-2691`）。
- 官方不做什么：不在 resume 时重放 `user_message_chunk`、planner 文本或工具历史。
- Paseo 适配：Paseo 因官方 `loadSession=true` 优先走 load，官方能力下不会主动走 resume（配套 `acp-agent.ts:2086-2104`）。生产：未核实。
- 适配状态：有缺口

### I06 `sessionCapabilities.additionalDirectories`
官方名称：`additionalDirectories` capability
- 官方做什么：声明 new/load/resume 接受 `additionalDirectories`，作为额外工作区根。
- 官方信号：`sessionCapabilities.additionalDirectories`（`server.py:2685-2691`）；参数在 `new_session`、`_restore_session`、`resume_session`、`load_session` 读取（`server.py:3631-3636`、`3887-3894`、`4112-4118`、`4209-4215`）。
- 官方不做什么：不把非法目录当错误；不在客户端省略参数时隐式恢复旧目录（load/resume 省略即清除，`server.py:3901-3903`）。
- Paseo 适配：Paseo 在发送前检查该能力位，满足才带 `additionalDirectories`（配套 `acp-agent.ts:2050-2062`）；适配器透传（`proxy.ts:286-305`）。适配 HEAD=WT。
- 适配状态：已对齐

### I07 `promptCapabilities.image`
官方名称：`image` prompt capability
- 官方做什么：声明接受 `session/prompt` 的 `image` 内容块。
- 官方信号：`promptCapabilities.image=true`（`server.py:2692-2696`）。
- 官方不做什么：不保证所有模型/账号都接受图片；不把解码失败变成 RPC 错误。
- Paseo 适配：Paseo 发送 `{type:"image",data,mimeType}`（配套 `acp-agent.ts:4015-4018`）；适配器透传。适配 HEAD=WT。
- 适配状态：已对齐

### I08 `promptCapabilities.audio`
官方名称：`audio` prompt capability
- 官方做什么：声明接受 `session/prompt` 的 `audio` 内容块；官方 base64 解码后交给 SDK。
- 官方信号：`promptCapabilities.audio=true`（`server.py:2692-2696`）；解析在 `server.py:1322-1338`。
- 官方不做什么：不保证后端模型接受音频；不在失败时保留音频。
- Paseo 适配：Paseo 不生成 `audio` block，上传音频走 `uploaded_file`→`resource_link`（配套 `acp-agent.ts:4020-4035`）。适配 HEAD=WT。
- 适配状态：有缺口

### I09 `promptCapabilities.embeddedContext`
官方名称：`embeddedContext` prompt capability
- 官方做什么：声明接受嵌入式上下文，即 `resource` 内容块（含 text 或 image/audio blob）。
- 官方信号：`promptCapabilities.embeddedContext=true`（`server.py:2692-2696`）；`resource` 解析在 `server.py:1339-1395`。
- 官方不做什么：不接受任意 MIME 的 blob；非 image/audio 只记日志并丢弃。
- Paseo 适配：Paseo 只在能力位为真时把带 `mimeType` 的文本块转成 `resource`；普通文本仍走 `text`，不发送 resource blob（配套 `acp-agent.ts:4004-4014`）。适配 HEAD=WT。
- 适配状态：有缺口

### I10 `mcpCapabilities.http` 与 `mcpCapabilities.sse`
官方名称：`http` / `sse` MCP capabilities
- 官方做什么：声明 new/load/resume 的 `mcpServers` 接受 HTTP 与 SSE 传输。stdio 不需要能力位。
- 官方信号：`mcpCapabilities.http=true`、`mcpCapabilities.sse=true`（`server.py:2697-2700`）；转换见 `PAR/mcp_servers.py:56-111`。
- 官方不做什么：不声明 MCP 资源列表 RPC；不把 MCP 工具变成 ACP 特有事件，仍走工具调用事件。
- Paseo 适配：Paseo 归一化 stdio/http/sse 并发送（配套 `acp-agent.ts:3956-3994`）；适配器整理 headers，并对所有 http(s) 走本地桥（`mcp-rewrite.ts:1-41`、`mcp-protocol-bridge.ts:7-33,150-160`）。适配 HEAD=WT。
- 适配状态：已对齐（源码级；真实 HTTP/SSE MCP 未核实）

### I11 `_meta.antigravity.tier` 能力声明
官方名称：`_meta.antigravity.tier`
- 官方做什么：在 initialize 的能力 meta 中声明会在 authenticate/new/load/resume 返回 tier 元数据。
- 官方信号：`field_meta.antigravity.tier=true`（`server.py:2701-2708`）；实际 tier 组装在 `server.py:3521-3541`、`PAR/tier_info.py:26-35`。
- 官方不做什么：不发独立的 tier 通知；不保证每个账号都有 tier。
- Paseo 适配：适配器透传；Paseo `applySessionState` 不读 `_meta`，runtimeInfo 没有 tier 字段（配套 `acp-agent.ts:3235-3260,3732-3756`）。适配 HEAD=WT。
- 适配状态：有缺口

### I12 `_meta.antigravity.systemPrompt.append`
官方名称：`systemPrompt.append`
- 官方做什么：声明 new/load/resume 接受 `_meta.antigravity.systemPrompt.append` 字符串；只追加，不替换。
- 官方信号：能力位 `server.py:2704-2707`；提取在 `PAR/system_prompt.py:11-45`；注入在 new/load/resume（`server.py:3687`、`4006`）。
- 官方不做什么：不提供逐轮更新 system prompt 的 RPC；不接受 `replace`；不接受非字符串 append。
- Paseo 适配：适配器默认每轮读 Paseo daemon state 并前置文本（`context.ts:14-25,82-86`）；只有 `PASEO_AGY_ACP_NATIVE_SYSTEM_CONTEXT=1` 时才用官方原生 append（`context.ts:51-80`）。Paseo 设置页可保存 `_meta` 原文（配套协议 `provider-config.ts:6-9`）。适配 HEAD=WT。
- 适配状态：已知差异

### I13 `agentInfo` 官方身份
官方名称：`agentInfo`
- 官方做什么：返回 `name:"antigravity-acp"`、`title:"Google Antigravity"`、`version:"1.5.0"`。
- 官方信号：`server.py:2710-2715`；版本来自 `PAR/_version.py:3`、`PAR/useragent.py:43-45`。
- 官方不做什么：不提供改名 RPC；不把版本写进其他响应。
- Paseo 适配：适配器把 `agentInfo` 覆盖为 `agy-acp` / `paseo-agy-acp (official Antigravity ACP kernel)` / 适配器包版本（`proxy.ts:513-515`、`identity.ts:3-16`）。适配 HEAD=WT。
- 适配状态：已知差异

### I14 `clientCapabilities.fs.readTextFile` 与 `writeTextFile`
官方名称：`fs.readTextFile` / `fs.writeTextFile`
- 官方做什么：只在客户端声明对应 fs 能力时，注入 `client_view_file`、`client_create_file`、`client_edit_file` 三个回调工具，并用客户端文件系统读写。写能力为真时还会禁用原生 `create_file`/`edit_file`，避免双重实现。
- 官方信号：initialize 保存 `client_capabilities.fs`（`server.py:2584-2585`）；工具注入在 `server.py:4347-4374`、`4419-4423`。
- 官方不做什么：不提供 ACP 的 `fs/read_text_file` 或 `fs/write_text_file` 请求反转；客户端能力只影响工具注入。
- Paseo 适配：Paseo 的 `BASE_ACP_CLIENT_CAPABILITIES.fs` 明确 `readTextFile:false, writeTextFile:false`（配套 `acp-agent.ts:455-463`），因此官方保留原生文件工具。适配 HEAD=WT。
- 适配状态：官方条件不满足

### I15 `clientInfo` 参与第三方模型目录门控与 User-Agent
官方名称：`clientInfo`
- 官方做什么：解析客户端名称/版本，用于模型目录白名单与 User-Agent。非白名单客户端（含 Paseo）只看到 Gemini 前缀模型。
- 官方信号：`server.py:2586-2603`；白名单在 `PAR/model_selection.py:33-58`；目录过滤在 `PAR/model_selection.py:419-421`、`720-722`、`790-792`。
- 官方不做什么：不提供客户端改白名单的 RPC；不把 `clientInfo` 原样回传。
- Paseo 适配：Paseo 发送 `clientInfo.name="Paseo"`（配套 `acp-agent.ts:3210-3214`），不在官方白名单。适配 HEAD 仍用内核补丁把非 Gemini 目录放回（`kernel-compat-rc01-recipe.ts:6-21`）；适配工作树删除该补丁（当前 `kernel-compat-rc01-recipe.ts:1-28` 只剩 proxy 与 step-observer）。Paseo 客户端只消费目录，不伪造 clientInfo。生产：未核实。
- 适配状态：已知差异（适配 HEAD 覆盖官方门控；工作树已回到官方行为）

---

## 二、认证

### A01 `Log in with Google`
官方名称：`Log in with Google`
- 官方做什么：公布个人 Google OAuth 方法，id 为 `oauth-personal`。选择后触发 OAuth 登录或刷新，解析项目 ID。
- 官方信号：initialize 的 `authMethods[]`，顺序第一（`server.py:2607-2612`）；`authenticate` 分支在 `server.py:3047-3051`。
- 官方不做什么：不在 initialize 时登录；不在 `authenticate` 回包里返回 token。
- Paseo 适配：适配器透传。Paseo 不发 `authenticate`；官方允许跳过 authenticate，在 `session/new` 触发登录（`server.py:3466-3479`）。适配 HEAD=WT。
- 适配状态：有缺口

### A02 `Log in with Gemini Enterprise`
官方名称：`Log in with Gemini Enterprise`
- 官方做什么：公布企业 Google 登录，id 为 `oauth-business`。选择后在 `authenticate` 内完成交互登录与许可解析。
- 官方信号：`server.py:2613-2617`、`3053-3060`；许可错误文案见 `server.py:1145-1174`。
- 官方不做什么：不提供企业项目/许可选择 RPC；配置来自 `settings.json` 的 `gcp.project`/`gcp.location`。
- Paseo 适配：适配器透传；Paseo 无认证选择入口。生产：未核实。
- 适配状态：有缺口

### A03 `Gemini API key`
官方名称：`Gemini API key`
- 官方做什么：公布 API key 方法，id 为 `gemini-api-key`。key 可由客户端 `_meta` 的 `api-key`/`apiKey`/`api_key` 提供，否则回退 `GEMINI_API_KEY`。
- 官方信号：`server.py:2618-2622`；解析在 `server.py:3062-3095`、`_META_API_KEY_ENTRIES` 在 `server.py:739`。
- 官方不做什么：不在 initialize 里要求 key；**key 缺失时 `authenticate` 仍返回成功**，把 `auth_required` 推迟到 `session/new`（`server.py:3080-3092`）。
- Paseo 适配：适配器透传；Paseo 不发 authenticate，API key 是否可用取决于宿主环境。生产：未核实。
- 适配状态：有缺口

### A04 `Gemini Enterprise Agent Platform`
官方名称：`Gemini Enterprise Agent Platform`
- 官方做什么：公布 Agent Platform 方法，id 为 `agent-platform`（前身 Vertex AI）。使用 `GOOGLE_API_KEY`，或 `GOOGLE_CLOUD_PROJECT` + `GOOGLE_CLOUD_LOCATION`，或 `settings.json` 的 `gcp` 块。
- 官方信号：`server.py:2623-2632`、`3097-3108`；变量名在 `server.py:711-713`。
- 官方不做什么：缺少配置时在 `authenticate` 返回 `-32602`；不在 initialize 校验凭据。
- Paseo 适配：适配器透传；Paseo 无认证入口。生产：未核实。
- 适配状态：有缺口

### A05 旧 id `vertex-ai`
官方名称：`vertex-ai` alias
- 官方做什么：仍接受旧 id `vertex-ai`，归一化为 `agent-platform`；公布列表只给规范 id，避免一个方法出现两个按钮。
- 官方信号：`server.py:697-698`、`732-733`、`743-748`、`2997-2999`；注释在 `server.py:2623-2624`。
- 官方不做什么：不把 `vertex-ai` 作为第二项 authMethod 公布。
- Paseo 适配：适配器把认证请求原样转发，只改 mode 字段（`proxy.ts:276-327` 的通用转发；`320-322` 只处理 set_mode/set_config_option）。Paseo 无认证调用。生产：未核实。
- 适配状态：已对齐（源码级）

### A06 条件式 `AI API Gateway`
官方名称：`AI API Gateway`
- 官方做什么：只有当客户端在 `clientCapabilities.auth._meta.gateway` 传真、环境开关 `AGY_ACP_ENABLE_GATEWAY_AUTH` 开启、企业策略未禁止时，才追加 `gateway` 认证方法，并带 `_meta.gateway.protocol=google`。
- 官方信号：`server.py:2634-2676`；策略解析在 `server.py:3016-3045`。
- 官方不做什么：不对未请求的客户端公布；企业策略 `REQUIRED` 时反而清空所有 authMethods（`server.py:2657-2663`）；`FORBIDDEN` 时撤下 gateway（`server.py:2664-2665`）。
- Paseo 适配：Paseo 的 `BASE_ACP_CLIENT_CAPABILITIES` 没有 `auth._meta.gateway`（配套 `acp-agent.ts:455-477`），第一道门就不满足。适配 HEAD=WT。
- 适配状态：官方条件不满足

### A07 `authenticate` 的方法分派
官方名称：`authenticate`
- 官方做什么：按 `methodId` 分派四种标准方法（含旧 id 归一化）；成功后记住认证类型；真实账号切换时迁移已存在的会话。
- 官方信号：RPC `authenticate`；`server.py:2966-3191`；会话重建在 `server.py:3178-3190`、`2122-2180`。
- 官方不做什么：不返回 token 或账号资料；不把 `authenticate` 成功当成本轮推理可用。
- Paseo 适配：适配器双向透传；Paseo 没有 authenticate 入口或调用（配套 `acp-agent.ts` 全文件无 authenticate）。生产：未核实。
- 适配状态：有缺口

### A08 API key 缺失的延迟错误
官方名称：`auth_required`（API key）
- 官方做什么：API key 缺失时 `authenticate` 成功返回，但清空旧认证状态；`session/new` 再以顶层 `-32000` 文案提示设置 `GEMINI_API_KEY`。
- 官方信号：`server.py:3080-3092`；错误构造 `server.py:1128-1134`。
- 官方不做什么：不在 `authenticate` 抛错（Zed 会丢弃该错误，`server.py:3080-3087` 注释）。
- Paseo 适配：适配器不改变时序；Paseo 若不允许 authenticate，只能靠 `session/new` 报错。生产：未核实。
- 适配状态：已对齐（源码级）

### A09 `auth_required` 错误码与 `data.reason`
官方名称：`auth_required`
- 官方做什么：需要认证或已注销时返回 `-32000`，并在 `data.reason` 放入具体原因；客户端据此重开账号选择器。
- 官方信号：`_AUTH_REQUIRED_CODE=-32000`（`server.py:704-708`）；`data.reason=logged_out`（`server.py:2728-2733`、`2916-2921`、`5524-5529`）；通用构造 `server.py:1059-1140`。
- 官方不做什么：不用 `resource_not_found` 表示已注销；不把 API key 缺口的详情塞进 `data`（`server.py:1128-1134` 注释）。
- Paseo 适配：传输层保留 code/message/data；Paseo 的 `summarizeACPRequestError` 会拼 `data` 文本（配套 `acp-agent.ts:360-396`），但没有专门重开认证 UI。适配 HEAD=WT。
- 适配状态：有缺口

### A10 `logout` RPC
官方名称：`logout`
- 官方做什么：清除当前认证方式对应的凭据，重置认证状态，拆除所有活动会话；API key/Agent Platform 连接没有可清凭据时保持连接可用。
- 官方信号：RPC `logout`；`server.py:3193-3207`、`3239-3290`。
- 官方不做什么：不清除另一种 OAuth 方式的凭据；gateway 不写 `settings.json`，logout 对它是空操作（`server.py:3227-3237`）。
- Paseo 适配：适配器透传；Paseo 无 logout 调用或 UI（配套 `acp-agent.ts` 无 logout）。生产：未核实。
- 适配状态：有缺口

### A11 `/logout` 命令
官方名称：`/logout`
- 官方做什么：prompt 文本恰为 `/logout` 时，在 session 查找之前拦截；执行注销，发送一行确认正文，返回 `end_turn`。
- 官方信号：`server.py:5518-5521`、`3292-3316`；命令描述在 `PAR/logout.py:29-31`。
- 官方不做什么：不接受 `/logout` 之外的参数；不把注销结果做成独立通知。
- Paseo 适配：适配器把 `/logout` 当普通 prompt 透传；Paseo 命令列表可发送，但认证状态 UI 不联动（配套 `acp-agent.ts:3431-3437` 只消费命令列表）。适配 HEAD=WT。
- 适配状态：有缺口

### A12 authenticate/new/load/resume 的 tier `_meta`
官方名称：tier 元数据
- 官方做什么：在 `authenticate`、`new_session`、`resume_session`、`load_session` 响应里放 `_meta.antigravity.tier`，包含 `name`、`id`、`upgradeUri`。
- 官方信号：`server.py:3191`、`3756`、`4148`、`4250`；`PAR/tier_info.py:26-35`。
- 官方不做什么：不在流式 `session/update` 中更新 tier；不保证空 tier 也发。
- Paseo 适配：适配器透传 `_meta`；Paseo `applySessionState` 不读 tier（配套 `acp-agent.ts:3235-3260`）。适配 HEAD=WT。
- 适配状态：有缺口

---

## 三、会话

### S01 `session/new`
官方名称：`session/new`
- 官方做什么：展开 `~`，要求已认证，初始化企业管控，预建 trajectory DB，列模型，合并 MCP，构建 SDK agent，写 sidecar，返回新会话。
- 官方信号：RPC `session/new`；参数 `cwd`、`additionalDirectories`、`mcpServers`、`_meta`；响应 `sessionId`、`configOptions`、`models`、`modes`、`_meta.antigravity.tier`（`server.py:3631-3757`）。
- 官方不做什么：不在 new 里发模型正文；不把 MCP 或技能列表作为独立响应字段；`sessionId` 是 UUID（`server.py:3664`）。
- Paseo 适配：适配器补 cwd、daemon context、技能 MCP，其余透传（`proxy.ts:286-307`）；Paseo 发送 cwd、mcpServers、additionalDirectories（配套 `acp-agent.ts:2026-2062`）。适配 HEAD=WT。
- 适配状态：已对齐

### S02 `additionalDirectories` 的规范化
官方名称：`additionalDirectories`
- 官方做什么：展开 `~`、转绝对路径、去重、排除 cwd；非法项（非字符串、空、相对路径、根目录、已有非目录文件）只告警并跳过，不使 new 失败。
- 官方信号：`server.py:1406-1466`、`3689-3692`、`3959-3963`。
- 官方不做什么：不因单个坏目录失败；不在客户端省略时恢复旧值（load/resume 省略即清除）。
- Paseo 适配：适配器原样透传；Paseo 在能力位存在时发送数组（配套 `acp-agent.ts:2050-2062`）。适配 HEAD=WT。
- 适配状态：已对齐

### S03 `session/new` 的 MCP 合并与管理员管控
官方名称：`mcpServers`
- 官方做什么：把客户端 `mcpServers` 与全局 `<gemini_home>/config/mcp_config.json` 合并，同名客户端优先；管理员禁用 MCP 时全部丢弃；企业允许列表再过滤并套用管理员覆盖。
- 官方信号：`server.py:4270-4295`；`PAR/mcp_servers.py:222-330`。
- 官方不做什么：不把全局 MCP 列表发给客户端；不在响应里回报合并结果。
- Paseo 适配：适配器保留 stdio，HTTP/SSE 经本地桥（`proxy.ts:306-315`、`mcp-protocol-bridge.ts:150-160`）；Paseo 发 `mcpServers`。适配 HEAD=WT。
- 适配状态：已对齐（源码级）

### S04 `session/load` 恢复并重放历史
官方名称：`session/load`
- 官方做什么：恢复会话上下文并初始化 agent，然后从 SQLite trajectory 读取步骤并逐条重放；返回配置与 tier，不返回历史数组。
- 官方信号：RPC `session/load`；`server.py:4209-4251`、`3887-4110`、`6503-6651`。
- 官方不做什么：不重放 usage、plan、compaction、浏览器通知、模型正文以外的内部步骤；不保证每个历史步骤都产生事件。
- Paseo 适配：适配器透传并补 cwd/技能 MCP；Paseo 在 `loadSession=true` 时走 load，`replayingHistory` 期间把历史事件送入持久化时间线（配套 `acp-agent.ts:2086-2095`）。适配 HEAD=WT。
- 适配状态：已对齐（源码级；真实重放未核实）

### S05 `session/load` 的历史事件形状
官方名称：历史重放
- 官方做什么：`user_input` 发 `user_message_chunk`（纯文本）；`planner_response` 先发 `agent_thought_chunk`（thinking）再发 `agent_message_chunk`（modified/response）；工具步骤先发 `tool_call`，`status` 直接是 `completed`，再发 `tool_call_update` 携带输出与最终状态。
- 官方信号：`server.py:6503-6651`。
- 官方不做什么：不在重放时发 `usage_update`；不为历史 `generate_image` 附内联图片块，只给 rawOutput 字典；不把被拒绝工具当 completed。
- Paseo 适配：适配器透传；Paseo 的 `handleUserMessageChunk`/`translateSessionUpdate` 会消费这些事件（配套 `acp-agent.ts:3380-3460`）。适配 HEAD=WT。
- 适配状态：已对齐（源码级）

### S06 `session/resume`
官方名称：`session/resume`
- 官方做什么：恢复会话上下文但不重放历史；返回 `configOptions`、`models`、`modes`、tier。模型列表失败时热恢复可保留已有模型，冷恢复则失败。
- 官方信号：RPC `session/resume`；`server.py:4112-4149`、`4035-4051`。
- 官方不做什么：不发 `user_message_chunk`/工具历史；不要求 load 能力位。
- Paseo 适配：适配器透传；Paseo 因官方 `loadSession=true` 不会选 resume（配套 `acp-agent.ts:2086-2104`）。适配 HEAD=WT。
- 适配状态：有缺口

### S07 `session/list`
官方名称：`session/list`
- 官方做什么：枚举 `<gemini_home>/antigravity-acp/conversations` 下的 `.db` 会话；读取 sidecar 的 cwd 与附加目录；标题固定为 `Session <8位>`；可按 cwd 过滤。
- 官方信号：RPC `session/list`；`server.py:3828-3885`；常量在 `PAR/session_store.py:32-34`。
- 官方不做什么：忽略 `cursor`（`server.py:3842`）；不返回 `nextCursor`；不生成动态标题；不返回更新时间。
- Paseo 适配：适配器透传；Paseo 循环 cursor，官方不返回时结束（配套 `acp-agent.ts:1420-1450`）。适配 HEAD=WT。
- 适配状态：已对齐（源码级）

### S08 会话 sidecar 元数据
官方名称：session sidecar
- 官方做什么：在 `<session>.meta` 保存 cwd、附加目录、模式、工具过滤、Allow Always 缓存（带 workspace 绑定）等；load/resume 时只恢复同 workspace 的 Allow Always。
- 官方信号：`server.py:3736-3743`、`4097-4103`、`3959-3975`；`PAR/session_store.py:81-113`。
- 官方不做什么：不把 sidecar 作为 ACP 响应字段；不恢复跨 workspace 的 Allow Always。
- Paseo 适配：适配器不读 sidecar；Paseo 用自身 persistence 恢复 `_meta`/session 参数（配套 `provider-config.ts:6-9`、`acp-agent.ts` sessionParameters）。适配 HEAD=WT。
- 适配状态：已对齐（Paseo 持久化自己的参数，不与官方 sidecar 混用）

### S09 `session/cancel`
官方名称：`session/cancel`
- 官方做什么：通知式取消当前 turn；只调用当前 agent 的 `conversation.cancel()`，不释放会话。若 SDK 抛 `AntigravityCancelledError`，官方发一条 `agent_message_chunk` 文本，并返回 `stopReason:"cancelled"`。
- 官方信号：通知 `session/cancel`；`server.py:3759-3772`、`5716-5731`、`5826-5827`。
- 官方不做什么：不返回 JSON-RPC 响应；不删除会话；不保证取消后没有晚到事件。
- Paseo 适配：适配器转发 cancel，30 秒未确认则关闭共享连接；工作树在本地已取消但官方回 `end_turn` 时改写为 `cancelled`（`proxy.ts:256-273`、`564-567`）。Paseo 的 `interrupt` 发 cancel（配套 `acp-agent.ts:2798-2808`）。适配 HEAD=WT。
- 适配状态：已对齐（源码级；取消超时策略是适配器差异）

### S10 会话不存在：`-32002`
官方名称：`resource_not_found`（session）
- 官方做什么：load/resume 找不到 trajectory 时返回 `-32002`，`data` 带 `sessionId`、`geminiHome`、`expectedPath`、`details`。
- 官方信号：`server.py:3917-3940`；错误码在 `server.py:1140-1142`。
- 官方不做什么：不把缺失会话当空会话；不在 list 中隐藏 sidecar 缺失但 DB 存在的会话（标题/目录回退）。
- Paseo 适配：适配器透传；Paseo 的 `summarizeACPRequestError` 会保留 code/message/data 摘要（配套 `acp-agent.ts:360-396`）。适配 HEAD=WT。
- 适配状态：已对齐

### S11 客户端断开时清理
官方名称：`on_disconnect`
- 官方做什么：客户端断开时清理所有会话、后台任务、代理与遥测。
- 官方信号：`server.py:1729-1733`、`3774-3826`。
- 官方不做什么：不发送会话结束通知；不把清理结果回给客户端。
- Paseo 适配：适配器在 stdin 结束/关闭时终止内核并清理本地状态（`proxy.ts:145-215`）；Paseo 关闭运行时也按能力位决定 `session/close` 或直接杀进程（配套 `acp-agent.ts:2819-2870`）。适配 HEAD=WT。
- 适配状态：已对齐（生命周期层）

### S12 `session/set_model`（superseded）
官方名称：`session/set_model`
- 官方做什么：仍可切换模型；只记录选择，agent 在下一轮开始时重建。未知模型返回 `-32602`，`data` 带 `modelId` 与 `availableModels`。
- 官方信号：`server.py:2759-2858`、`2122-2180`。
- 官方不做什么：不在切换时重建运行中的 agent；不返回完整 configOptions（只返回空响应）。
- Paseo 适配：Paseo 优先用 `session/set_config_option`，失败才回退 `unstable_setSessionModel`（配套 `acp-agent.ts:2505-2555`）。适配 HEAD=WT。
- 适配状态：已对齐

### S13 模型切换延迟到下一轮
官方名称：模型切换应用
- 官方做什么：`set_config_option`/`set_model` 立即返回并更新会话选择；真正的 agent 重建发生在下一次 `prompt` 之前。
- 官方信号：`server.py:2318-2346`、`2785-2858`。
- 官方不做什么：不在切换 RPC 内启动推理；不保证已运行中的 turn 使用新模型。
- Paseo 适配：适配器透传；Paseo 收到成功回包后更新选择器，下一轮才由官方重建。适配 HEAD=WT。
- 适配状态：已对齐

### S14 认证方式切换时的活动会话迁移
官方名称：auth switch rebuild
- 官方做什么：真实认证方式变化时，重建所有活动会话到新认证；gateway 配置轮换时原地重建但不重新列 CCPA 模型。
- 官方信号：`server.py:3172-3190`、`3139-3158`、`2122-2180`。
- 官方不做什么：不发会话迁移通知；不保留旧认证下的模型 id 命名空间。
- Paseo 适配：适配器不干预；Paseo 若没有 authenticate 入口，无法在会话中触发。生产：未核实。
- 适配状态：有缺口

### S15 `GEMINI_HOME` 与会话存储位置
官方名称：`GEMINI_HOME`
- 官方做什么：所有会话、凭据、技能、app data 都在解析后的 Gemini home 下；设置环境变量可整体迁移。
- 官方信号：`PAR/paths.py:42-100,176-219`；`server.py:3661-3662`、`3915-3917`。
- 官方不做什么：不把会话写进工作区；不把 `GEMINI_HOME` 暴露给客户端。
- Paseo 适配：适配器不覆盖 `GEMINI_HOME`；Paseo 使用自己的 `PASEO_HOME` 做 daemon context 与技能发现（`context.ts:45-80`、`skill-commands.ts:108-190`）。适配 HEAD=WT。
- 适配状态：已对齐（两套 home 各管各的）

### S16 会话标记为完成/失败时的清理
官方名称：turn cleanup
- 官方做什么：每个 turn 结束都关闭未终结的工具调用；将已批准但未执行的 permission 帧标为 failed；清理本 turn 的 permission FIFO；观测 usage。
- 官方信号：`server.py:5786-5819`、`6295-6329`。
- 官方不做什么：不让工具调用永久停留在 `in_progress`；不把“已批准未执行”显示为成功。
- Paseo 适配：适配器透传工具终态；Paseo 映射 timeline（配套 `acp-agent.ts:3493-3541`）。适配 HEAD=WT。
- 适配状态：已对齐

---

## 四、配置选项

### C01 `Model` 选择器
官方名称：`Model`
- 官方做什么：`configOptions` 中发 `id:"model"`、`category:"model"`、`name:"Model"` 的 select；`currentValue` 是模型 family id 或具体模型 id；选项顺序沿用 CCPA/静态目录顺序。
- 官方信号：`PAR/config_options.py:170-208`、`339-347`；`server.py:3594-3601`。
- 官方不做什么：不改模型显示名大小写；不按字母重排；不保证每个会话有多个模型。
- Paseo 适配：适配器透传，不碰模型名称/顺序（`proxy.ts:584-586` 只加 mode meta）；Paseo 从 `configOptions` 派生模型目录（配套 `acp-agent.ts:3235-3260,3732-3740`）。适配 HEAD=WT。
- 适配状态：已对齐（源码级）

### C02 thinking family 折叠
官方名称：Model family grouping
- 官方做什么：同一 family 有 ≥2 个 thinking 变体时，`model` 选项只出现一个 family 项；具体变体由 `thinking_level` 选择。只有一个变体或 family id 与已提供模型 id 冲突时，保留普通模型项。
- 官方信号：`PAR/config_options.py:109-167`、`339-347`。
- 官方不做什么：不把单个变体折叠成 family；不为 gateway 声明项做 family 分组（`server.py:3603-3629`）。
- Paseo 适配：适配器透传；Paseo 把 `model` 选项展开为模型目录（配套 `acp-agent.ts:998-1030`）。适配 HEAD=WT。
- 适配状态：已对齐（源码级）

### C03 `Thinking Level` 选择器
官方名称：`Thinking Level`
- 官方做什么：当当前模型属于有 ≥2 变体的 family 时，发 `id:"thinking_level"`、`category:"thought_level"`、`name:"Thinking Level"` 的 select；选项按 `minimal/low/medium/high/xhigh/extra_high/max` 排序，未知级别排最后。
- 官方信号：`PAR/config_options.py:211-249`、`56-70`、`345-347`。
- 官方不做什么：不在没有 family 分组时发该选项；不发明档位。
- Paseo 适配：适配器透传；Paseo 保留官方名称、顺序、当前值，并为每个模型显示可用档位（配套 `acp-agent.ts:998-1030,2586-2650`）。适配 HEAD=WT。
- 适配状态：已对齐（源码级）

### C04 `Session Mode` 选择器
官方名称：`Session Mode`
- 官方做什么：发 `id:"mode"`、`category:"mode"`、`name:"Session Mode"` 的 select；顺序固定 `Default/default`、`Auto Edit/auto_edit`、`YOLO/yolo`，并附官方描述。
- 官方信号：`PAR/config_options.py:25-41`、`252-274`、`347`。
- 官方不做什么：不在 1.5.0 提供 plan 模式；不改名称大小写；不把未知模式静默降级。
- Paseo 适配：适配器只翻译已知别名，其他原值交官方；并给三个官方 mode 加 `_meta["paseo.dev/unattended"]`（`mode-map.ts:4-20,40-61`）。Paseo 保留官方显示名（配套 `acp-agent.ts:929-994`）。适配 HEAD=WT。
- 适配状态：已知差异

### C05 superseded `models` 字段
官方名称：`models`
- 官方做什么：除 `configOptions` 外仍返回旧 `SessionModelState`（`availableModels`、`currentModelId`），供未实现 configOptions 的客户端读取。
- 官方信号：`PAR/config_options.py:9-11`、`318-357`；`server.py:3754`、`4146`、`4248`。
- 官方不做什么：不保证 `models` 与 `configOptions` 的呈现粒度相同（`models` 保留扁平变体列表）。
- Paseo 适配：适配器透传；Paseo 优先 `configOptions`，`models` 作为回退（配套 `acp-agent.ts:3235-3260`）。适配 HEAD=WT。
- 适配状态：已对齐

### C06 superseded `modes` 字段
官方名称：`modes`
- 官方做什么：除 `configOptions` 外仍返回旧 `SessionModeState`（`availableModes`、`currentModeId`）。
- 官方信号：`PAR/config_options.py:348-357`；`server.py:3755`、`4147`、`4249`。
- 官方不做什么：不保证客户端优先读 `modes`；Zed 会直接丢弃该字段（注释在 `PAR/config_options.py:325-328`）。
- Paseo 适配：适配器透传；Paseo 从 configOptions 派生模式，`modes` 为回退（配套 `acp-agent.ts:3235-3260`）。适配 HEAD=WT。
- 适配状态：已对齐

### C07 `session/set_config_option`
官方名称：`session/set_config_option`
- 官方做什么：接受 `configId` 为 `model`、`thinking_level`、`mode`，值为字符串；返回**全量** `configOptions`，因为改一项可能改变其他项。
- 官方信号：RPC `session/set_config_option`；`server.py:2881-2964`；全量返回 `2962-2964`。
- 官方不做什么：不接受布尔值（`configId` 值必须是字符串，`server.py:2926-2930`）；不接受未知 id（`-32602`，`2951-2955`）。
- Paseo 适配：适配器透传并补 mode meta；Paseo 在每次选择后读取完整回包（配套 `acp-agent.ts:2708-2735,3539-3578`）。适配 HEAD=WT。
- 适配状态：已对齐

### C08 `thinking_level` 到具体模型的解析
官方名称：`thinking_level`
- 官方做什么：把档位解析为当前 family 的具体模型 id；family 不提供该档位时，切 family 取最近档位、同距倾向更高档；从无档位模型进入 family 取第一个变体。
- 官方信号：`PAR/config_options.py:360-431`；`server.py:2860-2872`、`2932-2948`。
- 官方不做什么：不把档位写成独立模型；不在档位不存在时静默保留旧档位（`-32602`）。
- Paseo 适配：适配器透传；Paseo 通过 `thinking_option` 事件更新（配套 `acp-agent.ts:3543-3578`）。适配 HEAD=WT。
- 适配状态：已对齐（源码级）

### C09 `session/set_mode`
官方名称：`session/set_mode`
- 官方做什么：校验 `modeId` 在三个官方模式内；同值直接成功；否则写 sidecar 并返回空响应。管理员的终端审批策略不锁模式，而在每个 exec 工具调用时执行。
- 官方信号：RPC `session/set_mode`；`server.py:2718-2757`。
- 官方不做什么：不接受未知模式（`-32602:"Unknown mode id"`，`server.py:2741-2744`）；不因 yolo 跳过管理员终端复核（`server.py:2750-2753`）。
- Paseo 适配：适配器翻译已知别名后透传；Paseo 优先 config option 写 mode（配套 `acp-agent.ts:2339-2460`）。适配 HEAD=WT。
- 适配状态：已对齐

### C10 未知 config id / 未知模式错误
官方名称：invalid params
- 官方做什么：未知 config id 返回 `-32602`；未知模式返回 `-32602`；不可用模型返回 `-32602` 并带可用模型列表。
- 官方信号：`server.py:2741-2744`、`2838-2848`、`2951-2955`。
- 官方不做什么：不静默降级；不返回 `resource_not_found`。
- Paseo 适配：适配器透传错误；Paseo 保留错误摘要（配套 `acp-agent.ts:360-396`）。适配 HEAD=WT。
- 适配状态：已对齐

### C11 模型不可用时的服务端自动替换
官方名称：model replacement
- 官方做什么：企业会话在每轮开始前重新列模型；当前模型消失时自动换到可用模型，发 `config_option_update`（全量配置），并最多一次发送替换说明正文。
- 官方信号：`server.py:2277-2316`、`2348-2388`；`config_option_update` 构造在 `PAR/config_options.py:299-315`。
- 官方不做什么：不在用户主动切换时发 `config_option_update`（只靠 set 回包）；不重复通知已被替换掉的同一模型（`_replaced_models_warned`，`server.py:2382-2386`）。
- Paseo 适配：适配器透传；Paseo `handleConfigOptionUpdate` 发出 model/mode/thinking 事件（配套 `acp-agent.ts:3543-3578`）。适配 HEAD=WT。
- 适配状态：已对齐（源码级；自动替换真实触发未核实）

### C12 `config_option_update` 只在服务端替换时出现
官方名称：`config_option_update`
- 官方做什么：只在服务端自行替换模型时发全量配置；用户 `set_config_option` 或 `set_model` 只返回响应，不发通知。
- 官方信号：发送点仅 `server.py:2357-2365`；用户切换响应 `server.py:2962-2964`。
- 官方不做什么：不在每个 turn 发配置快照；不在模式切换时发通知（模式切换靠响应）。
- Paseo 适配：适配器在 `session/update` 上补 mode meta 后透传（`proxy.ts:479-482`）；Paseo 消费该通知。适配 HEAD=WT。
- 适配状态：已对齐

### C13 认证方式决定模型命名空间
官方名称：auth-scoped model catalog
- 官方做什么：OAuth/business 走 CCPA 动态目录；API key/Agent Platform 走静态目录；gateway 走管理员声明目录。不同认证的模型 id 不互通。
- 官方信号：`PAR/model_selection.py:801-830`；`server.py:3481-3519`。
- 官方不做什么：不把另一认证下的模型 id 当作可用；恢复跨认证会话时自动换到可用模型（`server.py:3566-3579`）。
- Paseo 适配：适配器透传；Paseo 只消费目录并在切换失败时保留旧选择（配套 `acp-agent.ts:2505-2555`）。适配 HEAD=WT。
- 适配状态：已对齐（源码级）

### C14 模型目录失败时退化为单模型
官方名称：model catalog degradation
- 官方做什么：列模型失败时，会话只提供一个当前模型的单条目，而不是让会话恢复失败。
- 官方信号：`server.py:3580-3592`。
- 官方不做什么：不伪造完整目录；不把失败当 `session/new` 失败（new 仍会在初次列模型失败时失败，`server.py:3674-3678`）。
- Paseo 适配：适配器透传；Paseo 能接受单模型目录。适配 HEAD=WT。
- 适配状态：已对齐

### C15 `session/set_model` 的 superseded 日志
官方名称：superseded model RPC
- 官方做什么：记录一条日志说明客户端仍用旧字段发现模型；行为与新路径一致。
- 官方信号：`server.py:2778-2783`。
- 官方不做什么：不阻止调用；不返回错误。
- Paseo 适配：适配器不拦截；Paseo 仅在 config option 不存在时回退。适配 HEAD=WT。
- 适配状态：已对齐

### C16 配置值类型校验
官方名称：config value type
- 官方做什么：`set_config_option` 只接受字符串值；非字符串返回 `-32602`。
- 官方信号：`server.py:2926-2930`。
- 官方不做什么：不接受 boolean 配置；不把数字当字符串强转。
- Paseo 适配：适配器透传；Paseo 发送字符串。适配 HEAD=WT。
- 适配状态：已对齐

---

## 五、输入块

### P01 文本块
官方名称：`text`
- 官方做什么：接受 `session/prompt` 的 `text` 内容块，拼接后交给 SDK。
- 官方信号：`server.py:1271-1280`；`_parse_prompt` 在 `server.py:1249-1403`。
- 官方不做什么：不在 prompt 开始时回显用户文本；不发 `user_message_chunk`（只有 load 重放才发）。
- Paseo 适配：适配器透传；Paseo 发送 text（配套 `acp-agent.ts:3998-4003`）。适配 HEAD=WT。
- 适配状态：已对齐

### P02 文本中的官方斜杠命令
官方名称：builtin slash command
- 官方做什么：在 text 块中按 SDK `BuiltinSlashCommandName` 枚举识别 `/name`，把文本拆成普通字符串与 `SlashCommand` 对象；`/plan` 是其中之一。
- 官方信号：`server.py:1195-1213`、`1271-1280`。
- 官方不做什么：不把斜杠命令识别成模式切换；不为未枚举的自定义命令创建 `SlashCommand`。
- Paseo 适配：适配器透传文本，并追加 Paseo 技能命令（`skill-commands.ts:221-243`）。Paseo 把命令作为普通 prompt 发送（配套 `acp-agent.ts:3998-4003`）。适配 HEAD=WT。
- 适配状态：已知差异（Paseo 命令列表扩展）

### P03 图片块
官方名称：`image`
- 官方做什么：base64 解码后构造 SDK `Image`；解码/校验失败只告警并丢弃该块，不使整个 prompt 失败。
- 官方信号：`server.py:1305-1321`。
- 官方不做什么：不保证后端模型理解图片；不返回图片处理结果。
- Paseo 适配：适配器透传；Paseo 发送 image block（配套 `acp-agent.ts:4015-4018`）。适配 HEAD=WT。
- 适配状态：已对齐（源码级；真实图片推理未核实）

### P04 音频块
官方名称：`audio`
- 官方做什么：base64 解码后构造 SDK `Audio`；失败只告警并丢弃。
- 官方信号：`server.py:1322-1338`。
- 官方不做什么：不保证后端接受音频；不把音频转成文本。
- Paseo 适配：适配器透传；Paseo 不生成 audio block，上传音频走 `resource_link`（配套 `acp-agent.ts:4020-4035`）。适配 HEAD=WT。
- 适配状态：有缺口

### P05 `resource` 的文本形式
官方名称：`resource`（embedded context）
- 官方做什么：当 `resource.text` 存在时，拼成 `Embedded resource (<uri>):\n<text>`（无 uri 则纯 text）。
- 官方信号：`server.py:1339-1350`。
- 官方不做什么：不把文本 resource 当文件路径读取；不保留原始 URI 结构给模型。
- Paseo 适配：适配器透传；Paseo 只在带 `mimeType` 的文本块上发 resource（配套 `acp-agent.ts:4004-4014`）。适配 HEAD=WT。
- 适配状态：有缺口

### P06 `resource` 的 image/audio blob
官方名称：`resource` blob
- 官方做什么：当 `resource.blob` 的 MIME 以 `image/` 或 `audio/` 开头时，base64 解码为 SDK `Image`/`Audio`，uri 作为 description。
- 官方信号：`server.py:1350-1389`。
- 官方不做什么：不接受其他 MIME 的 blob；失败只告警并丢弃。
- Paseo 适配：适配器透传；Paseo 不发送 resource blob（配套 `acp-agent.ts:4004-4014`）。适配 HEAD=WT。
- 适配状态：有缺口

### P07 `resource` 的不支持 MIME
官方名称：unsupported resource blob
- 官方做什么：非 image/audio 的 blob 只记日志并丢弃该块，prompt 继续。
- 官方信号：`server.py:1390-1395`。
- 官方不做什么：不把二进制转成文本；不返回错误。
- Paseo 适配：适配器透传；Paseo 不会主动发这类块。适配 HEAD=WT。
- 适配状态：已对齐（Paseo 不触发）

### P08 `resource_link`
官方名称：`resource_link`
- 官方做什么：按 URI path 在服务器本地读文件，用 `sdk_types.from_file` 构造文档；读取或类型失败时退化为文件路径字符串，让模型用 `view_file` 自己读。
- 官方信号：`server.py:1281-1304`；MIME 重标记在 `server.py:1220-1246`。
- 官方不做什么：不从客户端上传内容；不保证远端客户端路径在服务器存在。
- Paseo 适配：适配器透传；Paseo 对 `uploaded_file` 在 `embeddedContext` 为真时发 `resource_link` file URI（配套 `acp-agent.ts:4020-4035`）。适配 HEAD=WT。
- 适配状态：已对齐（同一主机路径前提）

### P09 不支持的内容块
官方名称：unsupported prompt block
- 官方做什么：未知 `block.type` 只记 warning，跳过，不使 prompt 失败。
- 官方信号：`server.py:1396-1399`。
- 官方不做什么：不返回 `-32602`；不猜测块类型。
- Paseo 适配：适配器透传；Paseo 只生成已知类型（配套 `acp-agent.ts:3998-4048`）。适配 HEAD=WT。
- 适配状态：已对齐

### P10 prompt 的 `messageId`
官方名称：`messageId`
- 官方做什么：接收可选 `messageId`，仅用于每轮 telemetry 的 prompt id；没有时生成 UUID。它不写进会话正文，也不回显。
- 官方信号：`server.py:5503`、`5577-5582`。
- 官方不做什么：不把 `messageId` 作为文本回显；不用它做幂等去重。
- Paseo 适配：适配器透传；Paseo 每次 `startTurn` 生成 UUID（配套 `acp-agent.ts:2179-2205`）。适配 HEAD=WT。
- 适配状态：已对齐

### P11 `/logout` 在 prompt 解析前拦截
官方名称：`/logout` interception
- 官方做什么：只要所有 text 块拼起来恰为 `/logout`，就在 session 查找与 usage 命令之前执行注销。
- 官方信号：`server.py:5518-5521`；`PAR/logout.py:35-44`。
- 官方不做什么：不接受 `/logout ` 之外的其他文本；不把 `/logout` 交给模型。
- Paseo 适配：适配器透传；Paseo 命令列表包含官方命令。适配 HEAD=WT。
- 适配状态：有缺口（Paseo 无认证状态联动）

### P12 `/usage` 在 prompt 解析前拦截
官方名称：`/usage` interception
- 官方做什么：text 以 `/usage` 开头且后接空白或结束时，拦截并直接生成 token/配额报告；不触发 LLM。带参数时报错文本并 `end_turn`。
- 官方信号：`server.py:5532-5533`、`3385-3464`；`PAR/usage.py:18-35`。
- 官方不做什么：不对 API key/gateway/agent-platform 查配额，只显示“不适用”；真实的 quota 查询只对 `oauth-personal` / `oauth-business`。
- Paseo 适配：适配器透传；Paseo 把结果当 assistant message 显示，无专门配额 UI（配套 `acp-agent.ts:3363-3385`）。适配 HEAD=WT。
- 适配状态：有缺口

---

## 六、输出事件

### O01 正文 `agent_message_chunk`
官方名称：`agent_message_chunk`
- 官方做什么：把根 trajectory 的 `content_delta` 以 text 块实时发出；非根 trajectory（subagent）不发，避免两个流交错。
- 官方信号：`server.py:6029-6054`。
- 官方不做什么：不发 subagent 的 MODEL→USER 文本；不发 ERROR 状态的 MODEL→USER 文本（避免泄漏拒绝提示，`server.py:6022-6028`）。
- Paseo 适配：适配器经 `SystemMessageFolder` 折叠系统封套后透传（`system-message-fold.ts:60-110`）；Paseo 映射 assistant_message（配套 `acp-agent.ts:3363-3385`）。适配 HEAD=WT。
- 适配状态：已知差异（适配器会切分/重写系统文本段）

### O02 复用 `agent_message_chunk` 的操作性文本
官方名称：operational `agent_message_chunk`
- 官方做什么：官方没有独立通知通道，以下都用普通 `agent_message_chunk`：浏览器不可用/降级、SDK 错误文案、连接丢失、模型替换说明、引用来源、`/logout` 确认、`/usage` 报告。
- 官方信号：`server.py:5552-5575`、`5686-5709`、`5747-5767`、`5775-5785`、`2361-2376`、`5863-5872`、`3305-3313`、`3453-3462`。
- 官方不做什么：不给这些文本加 `_meta` 标记；不区分助手正文与系统提示；不发 JSON-RPC error。
- Paseo 适配：适配器只对官方 `SYSTEM_MESSAGE` 封套加 `paseo.dev/messageKind=system`（`system-message-fold.ts:93-109`）；其他操作性文本仍是普通正文，Paseo 会显示为助手消息。适配 HEAD=WT。
- 适配状态：已知差异（仅系统封套被标记，其余操作性文本无结构化身份）

### O03 思考摘要 `agent_thought_chunk`
官方名称：`agent_thought_chunk`
- 官方做什么：只对根 trajectory、非 ERROR、MODEL→USER 的 `thinking_delta` 发 thought 块。
- 官方信号：`server.py:6029-6044`。
- 官方不做什么：不凭空生成思考摘要；不发 subagent 思考；不发 ERROR 状态思考。
- Paseo 适配：适配器透传；Paseo 映射 reasoning（配套 `acp-agent.ts:3386-3390`）。适配 HEAD=WT。
- 适配状态：已对齐

### O04 历史思考摘要
官方名称：historical `agent_thought_chunk`
- 官方做什么：load 重放 `planner_response.thinking` 时发 `agent_thought_chunk`。
- 官方信号：`server.py:6523-6533`。
- 官方不做什么：不重放所有内部 thinking 字段；只重放 planner 的 `thinking`。
- Paseo 适配：适配器透传；Paseo 映射 reasoning。适配 HEAD=WT。
- 适配状态：已对齐（源码级）

### O05 工具开始 `tool_call`
官方名称：`tool_call`
- 官方做什么：新工具调用发 `ToolCallStart`，包含 `toolCallId`、`title`、`kind`、`content`、`locations`、`rawInput`、`status`、MCP `_meta`。需要审批的工具先以 `pending` 发出；自动批准的工具以 `in_progress` 发出。
- 官方信号：审批路径 `server.py:5119-5131`；执行路径 `server.py:6148-6162`。
- 官方不做什么：不省略 `toolCallId`（缺失时生成）；不保证所有工具都有 `kind`/`content`/`locations`。
- Paseo 适配：适配器透传；Paseo 映射 timeline（配套 `acp-agent.ts:3493-3541`）。适配 HEAD=WT。
- 适配状态：已对齐

### O06 工具进行中 `tool_call_update`
官方名称：`tool_call_update`（in_progress）
- 官方做什么：当执行步骤复用了之前 pending 的 permission 帧时，发 `tool_call_update` 把同一 `toolCallId` 从 `pending` 推进到 `in_progress`，并补 title/kind/content/locations/rawInput。未复用帧时直接发新的 `tool_call`。
- 官方信号：`server.py:6132-6162`。
- 官方不做什么：不创建第二个工具行；不把 pending 帧和 exec 帧分成两行（`server.py:5133-5137` 注释）。
- Paseo 适配：适配器透传；Paseo 合并工具快照（配套 `acp-agent.ts:3493-3541,4078-4110`）。适配 HEAD=WT。
- 适配状态：已对齐

### O07 工具终态 `tool_call_update`
官方名称：`tool_call_update`（completed/failed）
- 官方做什么：工具步骤进入 DONE/ERROR/CANCELED 时发终态；正常为 `completed`，错误/用户拒绝/被 `manage_task kill` 为 `failed`；`rawOutput` 与 `content` 按工具类型填充。
- 官方信号：`server.py:6164-6292`、`6295-6329`、`4937-4968`。
- 官方不做什么：不把非零退出码当工具错误（exec 仍 `completed`，`server.py:6257-6260`）；不让工具停在 `in_progress`。
- Paseo 适配：适配器透传；Paseo 映射工具状态。适配 HEAD=WT。
- 适配状态：已对齐

### O08 内部 MCP schema 读取隐藏
官方名称：internal MCP schema read
- 官方做什么：模型在调用 MCP 工具前会读 `<app_data_dir>/brain/<conversation>/mcp/<server>/<tool>.json`；官方把这种 `view_file`/`client_view_file` 读取从客户端事件流中隐藏，底层读取仍执行。
- 官方信号：`server.py:418-481`、`6077-6083`、`6220-6223`。
- 官方不做什么：不隐藏用户自己对同路径文件的读取；不隐藏写操作。
- Paseo 适配：适配器透传官方过滤后的流；Paseo 不额外处理。适配 HEAD=WT。
- 适配状态：已对齐

### O09 MCP 工具输出
官方名称：MCP tool output
- 官方做什么：MCP 工具终态时 `rawOutput` 放结果字符串，同时把同一文本包成 `content` 块；MCP 的工具名、原始参数和 `_meta` 在 pending/in_progress/terminal 三个阶段保持。
- 官方信号：`server.py:6281-6282`、`6088-6114`、`6239-6256`。
- 官方不做什么：不把 MCP 结果拆成 ACP 特有资源类型；不在结果 URI 时自动读取内容。
- Paseo 适配：适配器经 MCP 桥转发；Paseo 映射工具内容（配套 `acp-agent.ts:3493-3541`）。适配 HEAD=WT。
- 适配状态：已对齐（源码级）

### O10 `run_command` 结构化输出
官方名称：exec rawOutput
- 官方做什么：完成的 exec 工具在 `args` 里带 `exit_code`/`combined_output`，官方转成 `{commandLine, workingDir, exitCode, combinedOutput}`，并额外保留 `exit_code`/`formatted_output` 给 JetBrains。
- 官方信号：`server.py:126-164`、`6263-6266`。
- 官方不做什么：不在命令未完成时发结构化结果；不把非零退出码当失败状态。
- Paseo 适配：适配器透传；Paseo 工具快照保留 rawOutput（配套 `acp-agent.ts:3493-3541`）。适配 HEAD=WT。
- 适配状态：已对齐

### O11 `generate_image` 内联图片
官方名称：`generate_image` output
- 官方做什么：完成时 `rawOutput` 带 `imageName`/`imagePath`/`prompt`/`aspectRatio`；若图片文件可读，再发一个 `ImageContentBlock`（base64、MIME、`file://` URI）作为 `content`。
- 官方信号：`server.py:167-237`、`6267-6274`。
- 官方不做什么：不在图片路径无效时伪造图片内容；历史重放只给 rawOutput 字典，不重发内联图（`server.py:6475-6487`）。
- Paseo 适配：适配器透传；Paseo 渲染工具内容。适配 HEAD=WT。
- 适配状态：已对齐（源码级）

### O12 `search_web` 输出双重编码
官方名称：`search_web` output
- 官方做什么：完成时把 grounded summary 同时放进 `rawOutput` 和单个 text `content` 块，因为客户端渲染偏好不同。
- 官方信号：`server.py:250-259`、`6275-6280`。
- 官方不做什么：不在 in_progress 阶段发 summary（此时值为空，`server.py:252-255`）。
- Paseo 适配：适配器透传；Paseo 渲染工具内容。适配 HEAD=WT。
- 适配状态：已对齐

### O13 后台 exec 跨 turn 保持打开
官方名称：background exec
- 官方做什么：正常回合结束时，仍处于 active 的 exec 工具移到 `persisted_open_tool_calls`，不立即关闭；后续步骤完成时再发终态。
- 官方信号：`server.py:5631-5638`、`6195-6211`、`6224-6237`。
- 官方不做什么：不把后台 exec 当失败；不在切 turn 时丢工具行。
- Paseo 适配：适配器透传；Paseo 工具时间线可跨 turn 更新。适配 HEAD=WT。
- 适配状态：已对齐

### O14 `manage_task kill` 关闭被取消的后台工具
官方名称：`manage_task` kill
- 官方做什么：当工具步骤是 `manage_task(Action="kill", TaskId=...)` 且成功时，把匹配的后台工具（活动与持久化）标为 `failed`，`rawOutput` 为 `Killed by manage_task(<id>)`。
- 官方信号：`server.py:6175-6211`；id 匹配在 `server.py:262-279`。
- 官方不做什么：不把被杀工具当 completed；不自动杀未知 id。
- Paseo 适配：适配器透传；Paseo 显示失败。适配 HEAD=WT。
- 适配状态：已对齐

### O15 回合结束关闭残留工具
官方名称：turn-end tool sweep
- 官方做什么：无论正常、取消还是错误结束，都把仍 `in_progress` 的工具关闭；默认 `failed`，只有正常完成才把未关闭状态设为 `completed`。
- 官方信号：`server.py:5598-5601`、`5786-5791`、`6295-6329`。
- 官方不做什么：不留下一直旋转的工具行；不把崩溃回合的工具报成 completed。
- Paseo 适配：适配器透传；Paseo 显示终态。适配 HEAD=WT。
- 适配状态：已对齐

### O16 `usage_update` 上下文占用
官方名称：`usage_update`
- 官方做什么：发 `used` 与 `size`；`size` 由模型上下文窗口决定，未知时不发。新会话初始 `used=0`；恢复会话在首次模型调用前为未知，不伪造 0。
- 官方信号：`server.py:6394-6434`；`PAR/token_usage_tracker.py:35-126`、`PAR/model_selection.py:330-356`。
- 官方不做什么：不在窗口大小未知时猜分母；不在没有新模型调用时发 0 清除上下文条（`PAR/token_usage_tracker.py:105-113`）。
- Paseo 适配：适配器透传；Paseo `handleUsageUpdate` 发出 `usage_updated`（配套 `acp-agent.ts:3598-3615`）。适配 HEAD=WT。
- 适配状态：已对齐（源码级）

### O17 `PromptResponse.usage`
官方名称：`PromptResponse.usage`
- 官方做什么：返回本轮 turn 的 token 增量，字段为 `input_tokens`/`output_tokens`/`cached_read_tokens`/`cached_write_tokens`/`thought_tokens`/`total_tokens`；无正向增量时省略。
- 官方信号：`server.py:5820-5834`；`PAR/token_usage_tracker.py:128-221`。
- 官方不做什么：不返回跨轮累计；不把 0 增量当有效 usage。
- Paseo 适配：适配器透传；Paseo `mapACPUsage` 只取 `inputTokens`/`outputTokens`/`cachedInputTokens`，丢弃 `cachedWriteTokens`、`thoughtTokens`、`totalTokens`（配套 `acp-agent.ts:893-905`）。适配 HEAD=WT。
- 适配状态：有缺口

### O18 引用来源
官方名称：citation notice
- 官方做什么：BAIC 代理在 turn 中检测到引用时，turn 结束后以普通 `agent_message_chunk` 发出来源列表；ACP 没有引用原语。
- 官方信号：`server.py:5836-5874`。
- 官方不做什么：不发结构化 citation；不在流中逐条插入。
- Paseo 适配：适配器透传；Paseo 当普通正文显示（配套 `acp-agent.ts:3363-3385`）。适配 HEAD=WT。
- 适配状态：已知差异（官方限制导致无结构化引用）

---

## 七、权限与问答

### R01 工具审批请求
官方名称：`session/request_permission`
- 官方做什么：需要审批的工具先以 `tool_call(status="pending")` 公告，再由服务端向客户端发 `request_permission`；客户端回 `AllowedOutcome` 或 `DeniedOutcome`。
- 官方信号：`server.py:5119-5239`、`5271-5325`。
- 官方不做什么：不提供独立权限 RPC；不把审批结果当正文；不自动回答需要审批的工具（除模式/管理员策略）。
- Paseo 适配：适配器把内核的 permission 请求原样转给客户端，把客户端响应原样转回内核（`proxy.ts:490-494,592`）；Paseo `requestPermission` 生成单选动作（配套 `acp-agent.ts:2875-2938`）。适配 HEAD=WT。
- 适配状态：已对齐

### R02 审批选项集合
官方名称：permission options
- 官方做什么：普通工具给 `allow_always`/`allow`/`deny`；文件写工具、管理员强制复核的 exec、以及 ALWAYS_ASK 下的文件工具只给 `allow`/`deny`。
- 官方信号：`server.py:5154-5223`。
- 官方不做什么：不给写工具提供 `Allow Always`（会降级为 allow-once，`server.py:5156-5166`）；不把 `Allow Always` 持久化到 ALWAYS_ASK/终端复核路径（`5277-5317`）。
- Paseo 适配：适配器不改 options；Paseo 把每个 option 变成单选动作（配套 `acp-agent.ts:2875-2938,4381-4415`）。适配 HEAD=WT。
- 适配状态：已对齐

### R03 高风险审批警告
官方名称：`Allow Always (risky)`
- 官方做什么：exec/文件写/web 工具被归为高风险；`allow_always` 的显示名带 `(risky)`，并在 `_meta["agy.security.warning"]` 放 severity/risk/title/message。
- 官方信号：`server.py:314-321`、`5180-5213`。
- 官方不做什么：不把警告做成单独通知；不改变 option id。
- Paseo 适配：适配器透传 `_meta`；Paseo 目前只按 option 单选，不展示该 `_meta` 警告（配套 `acp-agent.ts:2875-2938`）。适配 HEAD=WT。
- 适配状态：有缺口

### R04 `Allow Always` 的缓存身份
官方名称：Allow Always scoped cache
- 官方做什么：exec 工具按**精确命令字符串**缓存；文件写工具永不缓存；其他工具按工具名缓存。缓存按 session 保存，并绑定 workspace。
- 官方信号：`server.py:87-123`、`5074-5088`、`5284-5303`；恢复时只接受同 workspace（`3963-3975`）。
- 官方不做什么：不对写工具缓存；不对缺失命令字符串的 exec 缓存；不在跨 workspace 恢复。
- Paseo 适配：适配器透传审批结果；Paseo 不理解缓存身份，只回 optionId。适配 HEAD=WT。
- 适配状态：已对齐（官方侧执行）

### R05 用户拒绝
官方名称：denied permission
- 官方做什么：客户端回 `DeniedOutcome`（或非 allow 选项）时，不执行工具，发 `tool_call_update(status="failed", rawOutput="Rejected by user")`，turn 继续。
- 官方信号：`server.py:5271-5275`、`4937-4968`。
- 官方不做什么：不把拒绝当 turn 取消；不把工具显示为 completed。
- Paseo 适配：适配器透传；Paseo 区分 selected/cancelled（配套 `acp-agent.ts:2737-2770`）。适配 HEAD=WT。
- 适配状态：已对齐

### R06 取消审批与拒绝审批的区别
官方名称：`cancelled` outcome
- 官方做什么：`DeniedOutcome` 的 `outcome="cancelled"` 与选择 `deny` 不同：前者是取消交互，后者是用户明确拒绝；官方对两者都关闭工具行，但只有拒绝写 `Rejected by user`。
- 官方信号：`server.py:5271-5275`、`5319-5325`。
- 官方不做什么：不把取消当 allow；不把取消当成功。
- Paseo 适配：适配器透传；Paseo `respondToPermission` 把无选项的取消发成 `{outcome:"cancelled"}`（配套 `acp-agent.ts:2737-2770`）。适配 HEAD=WT。
- 适配状态：已对齐

### R07 官方模式的服务端自动批准
官方名称：`Default` / `Auto Edit` / `YOLO`
- 官方做什么：`yolo` 自动批准所有工具；`auto_edit` 只自动批准文件编辑工具；`default` 不自动批准。管理员的终端复核与 ALWAYS_ASK 可以覆盖模式自动批准。
- 官方信号：`server.py:5063-5069`、`5028-5061`。
- 官方不做什么：不把模式名当权限策略之外的开关；不让 `yolo` 绕过管理员终端复核（`server.py:2750-2753`）。
- Paseo 适配：适配器把 `yolo` 标记为无人值守；Paseo 在 `yolo` 下自动选允许项，在 `default`/`auto_edit` 保留审批（配套 `acp-agent.ts:2875-2938,4418-4425`；`mode-map.ts:40-61`）。适配 HEAD=WT。
- 适配状态：已知差异（Paseo 用 `_meta` 决定无人值守；官方本身不消费该 `_meta`）

### R08 官方问答（`ask_question`）
官方名称：`ask_question`
- 官方做什么：没有独立问答 RPC；服务端发一个 dummy `tool_call`（`tool_call_id` 形如 `interaction_<8hex>`），再用 `request_permission` 呈现问题与选项；用户选择后关闭该工具行。
- 官方信号：`server.py:5381-5497`。
- 官方不做什么：不支持多选；不支持自由文本；不保证问题有 `kind`/`content`/`locations`（`server.py:5419-5428` 只带 title/raw_input/status）；不把问答当普通正文。
- Paseo 适配：适配器透传；Paseo 把 permission 卡当单选处理（配套 `acp-agent.ts:2875-2938,4444-4465`）。适配 HEAD=WT。
- 适配状态：已对齐（源码级；真实问答未核实）

### R09 问答选项的 kind 映射
官方名称：question option kind
- 官方做什么：选项 id 为 `deny`/`dont_trust`/`block`（大小写不敏感）时映射为 `reject_once`，其余映射为 `allow_once`。
- 官方信号：`server.py:5403-5414`。
- 官方不做什么：不提供 `allow_always` 问答选项；不把多个 allow 选项合并。
- Paseo 适配：适配器透传；Paseo 的 `isACPChooserRequest` 在重复 allow kind 时阻止自动批准（配套 `acp-agent.ts:4444-4465`）。适配 HEAD=WT。
- 适配状态：已对齐

### R10 问答被拒绝/取消
官方名称：question resolution
- 官方做什么：允许时返回选中的 `optionId`；拒绝时返回 `getattr(outcome,"option_id",None)`；取消返回 `None`。工具行 `completed` 或 `failed`，`rawOutput` 为 `Response received` / `Interaction cancelled`。
- 官方信号：`server.py:5472-5497`。
- 官方不做什么：不把拒绝当失败正文；不重试问题。
- Paseo 适配：适配器透传；Paseo 取消时回 `cancelled`。适配 HEAD=WT。
- 适配状态：已对齐

### R11 客户端 fs 回调工具
官方名称：`client_view_file` / `client_create_file` / `client_edit_file`
- 官方做什么：客户端声明 fs 能力后，官方把文件读取/创建/编辑变成回调客户端的工具，并在客户端写能力为真时禁用原生命令文件工具。
- 官方信号：`server.py:4347-4374`；工具实现在 `PAR/tools.py:305-557`。
- 官方不做什么：不在客户端未声明时调用；不把 fs 能力当 ACP 请求。
- Paseo 适配：Paseo 明确关闭 fs 能力（配套 `acp-agent.ts:455-463`），所以这些工具不会出现。适配 HEAD=WT。
- 适配状态：官方条件不满足

### R12 浏览器子代理与审批
官方名称：`chrome_devtools` browser subagent
- 官方做什么：只有企业 admin 启用且 `oauth-business` 时，注入 `chrome_devtools` MCP 与 browser subagent；启动前做 npx preflight；失败时跳过注入并发一次性提示；`evaluate_script` 按企业策略走审批。
- 官方信号：`server.py:4445-4529`、`5547-5575`、`5671-5715`；`PAR/browser_subagent.py:11-36,140-260,321-541`。
- 官方不做什么：不对非企业会话注入；不在 preflight 失败后反复注入同一会话；不把浏览器工具作为 ACP 能力位公布。
- Paseo 适配：适配器不注入浏览器；Paseo 只有通用工具/审批 UI。适配 HEAD=WT。
- 适配状态：官方条件不满足

### R13 hooks 与 workspace trust 审批
官方名称：workspace trust / hooks
- 官方做什么：读取全局与工作区 `hooks.json`；工作区未信任时，`load_hooks_config_async` 不传 `ask_user_fn` 就不弹信任询问，工作区 hooks 不加载；真正运行 hook 时用 `ask_user_callback` 发 `trust`/`dont_trust` 选项。
- 官方信号：`server.py:4607-4638`；`PAR/hooks.py:276-430`、`433-575`。
- 官方不做什么：不在 `session/new` 时弹 trust（`load_hooks_config_async` 无 `ask_user_fn`）；不把 trust 结果作为 ACP 独立事件。
- Paseo 适配：适配器透传 permission；Paseo 在 `yolo` 下自动选允许项，其他模式显示单选（配套 `acp-agent.ts:2875-2938,4418-4425`）。适配 HEAD=WT。
- 适配状态：有缺口（真实 hooks/trust 未核实）

### R14 待审批帧在回合结束时清扫
官方名称：pending permission sweep
- 官方做什么：turn 结束时，把已公告并允许但未收到执行步骤的 permission 帧标为 failed，`rawOutput="Tool call was approved but never executed."`。
- 官方信号：`server.py:5793-5819`。
- 官方不做什么：不让 permission 卡永久挂起；不把丢弃步骤当成功。
- Paseo 适配：适配器透传；Paseo 显示工具失败。适配 HEAD=WT。
- 适配状态：已对齐

---

## 八、命令

### M01 `available_commands_update` 的发送时机
官方名称：`available_commands_update`
- 官方做什么：在 new/load/resume 的会话响应排空后，异步发一次命令列表；发送前 `await asyncio.sleep(0)`，避免抢在会话响应之前。
- 官方信号：`server.py:5338-5379`、`3745-3748`、`4104`。
- 官方不做什么：不在每个 turn 重发；不把命令列表持久化；不提供命令执行结果的独立通道。
- Paseo 适配：适配器透传并追加技能命令；Paseo 缓存命令列表（配套 `acp-agent.ts:3431-3437`）。适配 HEAD=WT。
- 适配状态：已知差异（命令集合被扩展）

### M02 命令集合
官方名称：available commands
- 官方做什么：列出 SDK `BuiltinSlashCommandName` 的全部枚举值，再追加 `logout` 与 `usage`；`/plan` 有专用描述，其他内置命令用通用描述。
- 官方信号：`server.py:5344-5365`、`1195-1200`。
- 官方不做什么：不列技能为命令；不列 MCP 工具；不保证枚举之外的自定义命令。
- Paseo 适配：适配器保留官方命令，同名优先，再追加 Paseo 技能命令（`skill-commands.ts:193-243`）；Paseo 读 `availableCommands`（配套 `acp-agent.ts:3431-3437`）。适配 HEAD=WT。
- 适配状态：已知差异

### M03 `/plan`
官方名称：`/plan`
- 官方做什么：只是 prompt 文本中的内置斜杠命令，交给 SDK 的 `SlashCommand`；没有 plan 模式，没有 `plan` session update。官方描述说明它会生成实施计划并等待用户批准。
- 官方信号：`server.py:1195-1213`、`1271-1280`。
- 官方不做什么：不把 `/plan` 当模式；不发 `session/update` 的 `plan`；不提供 plan 审批 RPC。
- Paseo 适配：适配器透传 `/plan`；Paseo 命令列表可见，并保留通用 plan 事件映射（配套 `acp-agent.ts:3409-3411`），但官方 1.5.0 不会发 plan 事件。适配 HEAD=WT。
- 适配状态：已对齐（官方 `/plan` 命令）；通用 plan 事件属非官方扩展

### M04 `/usage`
官方名称：`/usage`
- 官方做什么：拦截文本前缀 `/usage`（大小写不敏感，后接空白或结束），不触发 LLM；生成 `### Session Usage` 与 `### Quota Limits` Markdown；带参数时报错文本并 `end_turn`。
- 官方信号：`server.py:5532-5533`、`3385-3464`；`PAR/usage.py:18-260`。
- 官方不做什么：不对 API key/gateway/agent-platform 查配额；不把报告做成结构化 usage 事件。
- Paseo 适配：适配器透传；Paseo 当正文显示，无专门配额 UI。适配 HEAD=WT。
- 适配状态：有缺口

### M05 `/logout`
官方名称：`/logout`
- 官方做什么：恰为 `/logout` 时注销并返回 `end_turn`；确认文本说明清除了哪些凭据，gateway 场景说明无可注销。
- 官方信号：`server.py:5518-5521`、`3292-3316`；`PAR/logout.py:35-87`。
- 官方不做什么：不把 `/logout` 交给模型；不在注销后保留活动会话（OAuth 连接）。
- Paseo 适配：适配器透传；Paseo 无认证状态联动。适配 HEAD=WT。
- 适配状态：有缺口

### M06 命令参数结构
官方名称：`AvailableCommand.input`
- 官方做什么：命令条目可带 `input.hint`；官方当前列出的命令没有专门 hint（`server.py:5354-5362` 只设 name/description）。
- 官方信号：`server.py:5354-5362`。
- 官方不做什么：不校验客户端是否发送命令参数；`/usage` 自己检查多余参数。
- Paseo 适配：适配器 `augmentAvailableCommands` 只处理 name/description；Paseo 读 `input?.hint`，官方无值则空字符串（配套 `acp-agent.ts:3431-3437`）。适配 HEAD=WT。
- 适配状态：已对齐

### M07 命令不可用时不会伪造
官方名称：command availability
- 官方做什么：命令列表只反映当前 SDK 枚举与两个内置命令；会话恢复时重新发同一列表。
- 官方信号：`server.py:5344-5379`、`4104`。
- 官方不做什么：不按技能目录动态增删官方命令；不隐藏 `/plan` 与 `/usage`。
- Paseo 适配：适配器追加技能命令；Paseo 合并展示。适配 HEAD=WT。
- 适配状态：已知差异

---

## 九、终态与错误

### E01 `end_turn`
官方名称：`end_turn`
- 官方做什么：默认成功终态；没有 SDK `stop_reason` 或无法映射时也回 `end_turn`。
- 官方信号：`server.py:5829-5834`；`_to_acp_stop_reason` 在 `server.py:1625-1653`。
- 官方不做什么：不保证 `end_turn` 一定伴随可见正文（空成功轮次是可能的）。
- Paseo 适配：适配器透传；工作树会在“无可见输出的成功轮次”上返回 `-32000` 空轮次错误（`errors.ts:25-41`、`proxy.ts:577-581`），HEAD 已有同样行为。Paseo 把 `end_turn` 映射 `turn_completed`（配套 `acp-agent.ts:3647-3652`）。适配 HEAD=WT。
- 适配状态：已知差异（适配器拒绝空成功轮次）

### E02 `max_tokens`
官方名称：`max_tokens`
- 官方做什么：SDK 的输入/输出/总 token 超限都映射为 `max_tokens`。
- 官方信号：`server.py:1633-1646`；返回在 `server.py:5829-5834`。
- 官方不做什么：不区分输入/输出/总超限；不附结构化 token 计数。
- Paseo 适配：适配器透传；Paseo 工作树把 `max_tokens` 映射 `turn_failed` 并带 code（配套 `acp-agent.ts:3620-3646`），HEAD 映射 `turn_completed`（HEAD `acp-agent.ts:3421-3443`）。适配 HEAD≠WT；生产旧客户端按 HEAD。
- 适配状态：有缺口（HEAD/生产）；工作树已改

### E03 `max_turn_requests`
官方名称：`max_turn_requests`
- 官方做什么：SDK 的模型调用次数/工具调用次数超限映射为 `max_turn_requests`。
- 官方信号：`server.py:1639-1646`。
- 官方不做什么：不说明是模型调用还是工具调用超限。
- Paseo 适配：同 E02。适配 HEAD≠WT；生产按 HEAD。
- 适配状态：有缺口（HEAD/生产）

### E04 `refusal`
官方名称：`refusal`
- 官方做什么：SDK 的 `QUOTA_EXHAUSTED` 映射为 `refusal`；正常带 response 时才出现。
- 官方信号：`server.py:1646`。
- 官方不做什么：不把配额错误做成 JSON-RPC 错误；不保证所有配额路径都走到这里。
- Paseo 适配：同 E02。适配 HEAD≠WT；生产按 HEAD。
- 适配状态：有缺口（HEAD/生产）

### E05 `cancelled`
官方名称：`cancelled`
- 官方做什么：取消路径显式返回 `stopReason:"cancelled"`；SDK 取消异常也会先发一条取消文本再 `cancelled`。
- 官方信号：`server.py:5716-5731`、`5826-5827`。
- 官方不做什么：不把取消当 `end_turn`；不保证取消后没有工具终态更新。
- Paseo 适配：适配器透传；工作树把“本地已取消但官方回 end_turn”改写为 `cancelled`（`proxy.ts:560-568`）；Paseo 映射 `turn_canceled`（配套 `acp-agent.ts:3621-3630`）。适配 HEAD≠WT。
- 适配状态：已对齐（工作树）；HEAD 已有 `end_turn` 改写

### E06 `-32602` invalid params
官方名称：`-32602`
- 官方做什么：未知模式、未知 config id、非字符串 config 值、不可用模型、未满足的认证方法/Vertex 配置、未知 auth method 都返回 `-32602`。
- 官方信号：`server.py:2741-2744`、`2838-2848`、`2926-2955`、`3027-3045`、`3099-3106`、`3160-3164`。
- 官方不做什么：不把参数错误伪装成 `-32603`；不返回成功。
- Paseo 适配：适配器透传；Paseo 保留错误摘要（配套 `acp-agent.ts:360-396`）。适配 HEAD=WT。
- 适配状态：已对齐

### E07 `-32002` resource not found
官方名称：`-32002`
- 官方做什么：会话 trajectory 缺失时返回 `-32002`，并带定位数据。
- 官方信号：`server.py:1140-1142`、`3917-3940`。
- 官方不做什么：不在 prompt 的 session 缺失时用同一错误（`prompt` 抛 `ValueError`，`server.py:5530-5531`，传输层通常表现为 `-32603`）。
- Paseo 适配：适配器透传；Paseo 保留 code/message/data 摘要。适配 HEAD=WT。
- 适配状态：已对齐（会话加载路径）；prompt 缺失路径属已知差异

### E08 `-32000` auth required
官方名称：`-32000`
- 官方做什么：未认证、已注销、API key 缺失到 `session/new` 时返回 `-32000`；已注销路径带 `data.reason="logged_out"`。
- 官方信号：`server.py:704-708`、`1059-1140`、`2728-2733`、`2916-2921`、`5524-5529`。
- 官方不做什么：不把认证错误做成普通正文；不在 `authenticate` 阶段抛 API key 缺失。
- Paseo 适配：适配器透传；Paseo 显示错误摘要但没有认证重开流程。适配 HEAD=WT。
- 适配状态：有缺口

### E09 上游错误以正文 + `end_turn` 出现
官方名称：SDK error message
- 官方做什么：SDK 执行/连接/验证异常时，把格式化后的错误文本发成 `agent_message_chunk`，然后仍按默认 `end_turn` 结束；连接丢失也发正文并 `end_turn`。
- 官方信号：`server.py:5732-5767`、`5768-5785`、`5829-5834`。
- 官方不做什么：不发 JSON-RPC error；不提供结构化 error class 或 HTTP 状态。
- Paseo 适配：适配器工作树用 pinned compat 读取 fenced terminal state，改回 `-32000` + `paseo.dev/kernelEvent.turn_failed`（`proxy.ts:568-575,651-664`、`kernel-terminal-state.ts`、`paseo_model_compat.py:609-650`）；HEAD 无此能力。Paseo 工作树消费 `turn_failed`（配套 `acp-agent.ts:2205-2232`），HEAD 按通用错误。适配 HEAD≠WT。
- 适配状态：非官方扩展（工作树）；HEAD/生产：有缺口

### E10 空成功轮次
官方名称：blank successful turn
- 官方做什么：允许 `PromptResponse(stopReason="end_turn")` 且没有可见正文；官方不把这种轮次当错误。
- 官方信号：`server.py:5829-5834`（没有空正文检查）。
- 官方不做什么：不补一条“无输出”的错误；不把空轮次改失败。
- Paseo 适配：适配器 HEAD/工作树都拒绝空成功轮次，返回 `-32000`（`errors.ts:34-41`、`proxy.ts:577-581`）。这是适配器补偿，不是官方信号。
- 适配状态：已知差异

---

## 十、官方本来就不发的信号

以下条目不是“官方能力缺口”，而是官方 1.5.0 明确不产生的协议信号或通用 ACP 能力。Paseo/适配器若实现，必须标为扩展，不能计入官方能力验收。

### N01 `plan` session update 与 plan 模式
官方名称：`plan`
- 官方做什么：没有。`/plan` 只是 prompt 斜杠命令（`server.py:1195-1213`、`1271-1280`）。
- 官方信号：无 `session/update` 的 `sessionUpdate:"plan"` 发送点；没有 `session/set_mode` 的 `plan` 值（`PAR/config_options.py:25-41`）。
- 官方不做什么：不发 plan 事件；不提供只读 plan 模式；不提供 plan 审批 RPC。
- Paseo 适配：适配器若收到 `plan` 会透传；Paseo 有通用 plan 映射（配套 `acp-agent.ts:3409-3411`）。这是通用 ACP 兼容，不是官方 1.5.0 能力。
- 适配状态：非官方扩展

### N02 `current_mode_update`
官方名称：`current_mode_update`
- 官方做什么：没有。用户切换模式只通过 `session/set_mode`/`set_config_option` 回包体现；服务端不主动发模式变更通知。
- 官方信号：`server.py` 无发送点；模式变更路径 `server.py:2718-2757`、`2949-2950`。
- 官方不做什么：不在自动策略改变模式时发通知；不把模式写进 `config_option_update` 之外的通知。
- Paseo 适配：适配器只处理 `config_option_update`；Paseo 代码有 `current_mode_update` 分支（配套 `acp-agent.ts:3400-3408`），但官方不会触发。适配 HEAD=WT。
- 适配状态：非官方扩展

### N03 `session_info_update` / 动态标题
官方名称：`session_info_update`
- 官方做什么：没有。`session/list` 标题固定为 `Session <8位>`（`server.py:3864-3866`）；没有改标题 RPC。
- 官方信号：`server.py` 无 `SessionInfoUpdate` 发送点；列表标题在 `server.py:3864-3866`。
- 官方不做什么：不生成动态标题；不更新时间戳；不发 `session_info_update`。
- Paseo 适配：适配器透传（不会出现）；Paseo 有 `handleSessionInfoUpdate`（配套 `acp-agent.ts:3584-3592`），但官方不触发。适配 HEAD=WT。
- 适配状态：非官方扩展

### N04 `session/close`
官方名称：`session/close`
- 官方做什么：没有声明也没有实现。initialize 的 `sessionCapabilities` 只有 `list`/`resume`/`additionalDirectories`（`server.py:2685-2691`）。
- 官方信号：无 `close` 能力位；`server.py` 无 `close_session` 实现。
- 官方不做什么：不返回成功；不能用 close 释放会话。
- Paseo 适配：适配器仅在客户端发来时转发，并在成功时释放技能 token（`proxy.ts:279-283,533-544`）；Paseo 只在能力位存在时调用 `unstable_closeSession`（配套 `acp-agent.ts:2842-2850`），官方未声明所以不调用。适配 HEAD=WT。
- 适配状态：非官方扩展

### N05 `session/delete`、`session/fork`、自定义 RPC
官方名称：delete/fork/custom
- 官方做什么：没有。`server.py` 只重写 initialize/authenticate/logout/new/load/resume/list/set_mode/set_model/set_config_option/prompt/cancel。
- 官方信号：无对应能力位与实现；未覆盖的方法只能落到 SDK 默认路由（通常 `-32601`），本文未实测。
- 官方不做什么：不删除会话；不 fork；不提供 `mcp.acp` 等扩展路由。
- Paseo 适配：适配器通用透传；Paseo 不依赖这些路由（配套 `acp-agent.ts:1428,1542,2054` 只读能力位）。适配 HEAD=WT。
- 适配状态：非官方扩展

### N06 客户端 `terminal/*`
官方名称：client terminal
- 官方做什么：没有调用。命令在 harness 内执行，不走客户端终端；官方文件工具也由 harness 执行。
- 官方信号：`server.py` 无 `terminal/create` 等调用；exec 路径在 `server.py:5618-5641`、`6263-6266`。
- 官方不做什么：不请求客户端开终端；不把命令输出委托给客户端终端。
- Paseo 适配：Paseo 声明 `terminal:true`（配套 `acp-agent.ts:455-463`），但官方不会调用；适配器不拦截 terminal 往返。适配 HEAD=WT。
- 适配状态：非官方扩展（客户端侧通用 ACP 能力）

### N07 全局排队 / 席位 / 冷却信号
官方名称：scheduling
- 官方做什么：没有 ACP 调度信号。官方 `cancel` 只取消当前 turn；`session/new` 与 `session/prompt` 都不发送排队状态。
- 官方信号：`server.py:3631-3757`、`5499-5834`、`3759-3772`。
- 官方不做什么：不发 queue position、seat、cooldown、start delay；不保证跨会话并发额度。
- Paseo 适配：适配器工作树/HEAD 已删除全局 Admission；独立会话直接派发，同一 session 拒绝重叠 prompt（`proxy.ts:348-353` 的 `session already has an active prompt`；README 的调度说明）。生产旧客户端未核实。
- 适配状态：非官方扩展（Paseo 侧不排队；官方本就不发）

### N08 重试计划信号
官方名称：model retry scheduled
- 官方做什么：没有 ACP 信号。重试由 Go harness 决定并写日志；官方 `server.py` 不解析、不发通知。
- 官方信号：`server.py` 无发送点；stderr 模板由 pinned harness 产生，不在官方 ACP 协议内。
- 官方不做什么：不告诉客户端“已计划重试”；不把 502 当重试计划。
- Paseo 适配：适配器工作树通过 pinned compat 解析 stderr，发 `model_retry_scheduled` 系统通知（`kernel-events.ts:14-99`、`kernel-event-tracker.ts:38-95`、`proxy.ts:602-616`）；HEAD 无此能力。Paseo 工作树显示通知（配套 `acp-agent.ts:197-360`），HEAD 无。生产无。
- 适配状态：非官方扩展

### N09 HTTP 状态进度信号
官方名称：backend HTTP error
- 官方做什么：没有 ACP 信号。SYSTEM ERROR step 里可能有 `http_code`，但官方不转成 ACP 通知。
- 官方信号：`server.py` 无发送点；官方错误仍走 `agent_message_chunk`（`server.py:5732-5767`）。
- 官方不做什么：不发 `backend_http_error`；不告诉客户端 HTTP 状态；不因 502 自动结束本轮。
- Paseo 适配：适配器工作树从 pinned SYSTEM ERROR step 提取 `http_code`，发 `backend_http_error` 通知（`paseo_model_compat.py:299-333`、`kernel-event-tracker.ts:70-90`、`proxy.ts:618-625`）；HEAD 无。Paseo 工作树显示 warning（配套 `acp-agent.ts:315-333`），HEAD 无。
- 适配状态：非官方扩展

### N10 终态 JSON-RPC 失败
官方名称：structured turn failure
- 官方做什么：没有。SDK 终态失败先发普通正文，最终仍 `end_turn`；`PromptResponse` 不会带错误码。
- 官方信号：`server.py:5732-5785`、`5829-5834`。
- 官方不做什么：不发 `-32000` 的 `turn_failed`；不发 error class；不发最后 HTTP 状态。
- Paseo 适配：适配器工作树读 fenced terminal state，返回 `-32000` + `paseo.dev/kernelEvent.turn_failed`（`kernel-terminal-state.ts:17-57,59-150`、`proxy.ts:568-575,651-664`、`paseo_model_compat.py:609-650`）；HEAD 无。Paseo 工作树消费 `turn_failed`（配套 `acp-agent.ts:2205-2232`），HEAD 按通用错误。
- 适配状态：非官方扩展

### N11 官方不隔离诊断正文
官方名称：diagnostic chunk
- 官方做什么：SDK 异常文本与连接丢失文本都走普通 `agent_message_chunk`（`server.py:5747-5767`、`5775-5785`）；官方没有“系统/诊断”标记。
- 官方信号：同上；没有 `_meta` 标记。
- 官方不做什么：不告诉客户端这段文本不是模型正文；不把它放到错误通道。
- Paseo 适配：适配器只对官方 `SYSTEM_MESSAGE` 封套加系统标记（`system-message-fold.ts:93-109`）；工作树 compat 会抑制 pinned 终止诊断 chunk（`paseo_model_compat.py:542-606`），非终止诊断仍可能显示为正文。适配 HEAD≠WT。
- 适配状态：已知差异（工作树部分抑制）；HEAD：有缺口

### N12 官方不伪造思考摘要
官方名称：thought synthesis
- 官方做什么：没有。只在 SDK 提供 `thinking_delta` 时发 `agent_thought_chunk`（`server.py:6035-6044`）；模型不出思考时没有事件。
- 官方信号：`server.py:6029-6044`。
- 官方不做什么：不生成摘要；不把正文转成思考；不把系统消息转成 thought。
- Paseo 适配：适配器不改写 thought；Paseo 只映射收到的 thought（配套 `acp-agent.ts:3386-3390`）。适配 HEAD=WT。
- 适配状态：已对齐（官方信号条件不满足时不发）

### N13 官方不做引用原语
官方名称：citation
- 官方做什么：没有结构化引用。引用以普通正文块在 turn 末尾发出（`server.py:5836-5874`）。
- 官方信号：`server.py:5863-5872` 使用 `AgentMessageChunk`。
- 官方不做什么：不发 citation 对象、链接数组或独立通知。
- Paseo 适配：适配器透传；Paseo 当普通正文。适配 HEAD=WT。
- 适配状态：已知差异（官方限制）

### N14 官方不做用量未知时的猜测
官方名称：usage denominator
- 官方做什么：模型上下文窗口未知时不发 `usage_update`（`server.py:6417-6421`）；恢复会话在首次模型调用前不伪造 `used=0`（`PAR/token_usage_tracker.py:63-75`）。
- 官方信号：同上。
- 官方不做什么：不猜 `size`；不清空客户端上下文条。
- Paseo 适配：适配器透传；Paseo 只在收到有效 used/size 时更新（配套 `acp-agent.ts:3598-3615`）。适配 HEAD=WT。
- 适配状态：已对齐

### N15 官方不做认证 UI / 交互式 OAuth 事件
官方名称：auth UI
- 官方做什么：只公布 authMethods；OAuth 登录在服务进程内进行，ACP 协议没有登录 URL、进度或账号资料事件。
- 官方信号：`server.py:2604-2676`、`3047-3108`；`main.py:65-88` 的 login 是独立 CLI 路径。
- 官方不做什么：不发登录 URL；不发账号切换事件；不把 token 发给客户端。
- Paseo 适配：适配器透传；Paseo 没有认证选择 UI。适配 HEAD=WT。
- 适配状态：有缺口（Paseo 侧）；官方本就不发

---

## 十一、适配 HEAD、工作树与生产旧客户端的关键差异

这一节只汇总跨能力的差异，不重复上面每条。

1. **模型目录补丁**：适配 HEAD 仍把非 Gemini 模型放回目录（`HEAD:ACP Connector/official-kernel/kernel-compat-rc01-recipe.ts:6-21`）；工作树删除该补丁，回到官方 `clientInfo` 白名单行为（当前 recipe 只剩 proxy 与 step-observer）。Paseo 客户端不伪造 clientInfo。生产：未核实。
2. **技能呈现补丁**：适配 HEAD 把内置技能呈现改为 `TOOL`（`HEAD:kernel-compat-rc01-recipe.ts:38-45`）；工作树删除该补丁，回到官方默认呈现。生产：未核实。
3. **终态与内核事件**：适配 HEAD 没有 `kernel-events.ts` / `kernel-event-tracker.ts` / `kernel-terminal-state.ts`，也没有 pinned compat 的 step observer（`HEAD:paseo_model_compat.py` 只有 `is_catalog_model` / `transform_request`）。工作树新增三文件、`run.ts` stderr 过滤、`proxy.ts` 的 `observeKernelEvent`/`turn_failed`/`blankTurn` 路径。生产旧客户端没有这些。
4. **stopReason 映射**：配套 HEAD 把 `max_tokens`/`max_turn_requests`/`refusal` 都映射 `turn_completed`（`HEAD:acp-agent.ts:3421-3443`）；配套工作树改为 `turn_failed` 并带 code（`acp-agent.ts:3620-3646`）。生产旧客户端按 HEAD。
5. **取消改写**：适配 HEAD 已把“本地已取消但官方回 end_turn”改写为 `cancelled`（`HEAD:proxy.ts:504-507`）；工作树保留并扩展了 kernel event/terminal state 清理。生产：未核实。
6. **空轮次拒绝**：适配 HEAD 与工作树都有 `blankTurnError`（`HEAD:proxy.ts:512`；当前 `proxy.ts:577-581`）；这是适配器补偿，不是官方能力。
7. **产品身份**：适配 HEAD 与工作树都用 `overlayProductIdentity` 覆盖 `agentInfo`（`proxy.ts:513-515`）；生产旧客户端未核实。

---

## 十二、没有从源码确认、因此不敢写进正文的点

以下内容本文没有把它当成已确认事实：

1. JSON-RPC 路由字符串本身不在 `server.py`。`initialize`、`session/new`、`session/load`、`session/resume`、`session/list`、`session/set_mode`、`session/set_model`、`session/set_config_option`、`session/prompt`、`session/cancel` 的名称来自 ACP v1 与 `server.py` 注释，不是从 `server.py` 字面抓到的。若 ACP Python SDK 对某个方法用了不同注册名（尤其 `set_model` 的 unstable 前缀），本文可能有一处偏差。
2. `/plan` 之外，`BuiltinSlashCommandName` 的完整枚举值与显示描述没有在可获得源码中展开；本文只说“SDK 内建命令 + `/logout` + `/usage`”，没有写全每一条命令名。
3. `PAR/model_selection.py` 的 `DEFAULT_MODEL_LIST`、`AGENT_PLATFORM_MODEL_LIST`、`DEFAULT_MODEL_METADATA_MAP` 具体模型 id 与上下文窗口值未展开；本文只确认目录来源与过滤规则，不确认具体模型名单。
4. `PAR/config_options.py` 的 thinking 变体表由 `model_selection.thinking_variants()` / `ccpa_thinking_variants()` 提供，具体 family 名称、档位显示名与映射表未逐项列出。
5. `session/list` 是否真的没有 `nextCursor` 字段，取决于 ACP SDK 的响应序列化默认值；`server.py:3883-3885` 只构造 `sessions`，本文据此写“不返回 cursor”，但没有在 wire 上实测。
6. `prompt` 对同一 session 并发调用的行为未确认。`server.py` 没有显式的“已有活动 turn”拒绝；适配器有 `session already has an active prompt` 的本地保护（`proxy.ts:348-353`）。官方是否串行、拒绝或交错，本文不写。
7. `session/close`、`session/delete`、`session/fork`、`mcp.acp` 等未实现方法的实际错误码依赖 ACP SDK 默认路由；本文只写“官方未声明/未实现”，没有实测 `-32601`。
8. `authenticate` 的 `data` 形状：除了 `-32000` 的 `data.reason="logged_out"`，其他认证错误是否带 `data` 未逐条确认。
9. `agentInfo.version` 的 `useragent.get_version()` 返回 `_version.__version__`，本文确认 `_version.py` 是 `1.5.0`；但生产安装是否同一版本未核实。
10. 生产旧客户端的版本与行为未核实。本文所有“生产”判断只表示“本轮未部署/未核实”，不是对生产行为的实测结论。
11. `PASEO_AGY_ACP_NATIVE_SYSTEM_CONTEXT=1` 的原生 append 真实路径未在真实账号上复验；本文只从 `context.ts:51-80` 与官方 `system_prompt.py` 读出条件。
12. `PAR/browser_subagent.py` 的 admin 触发条件与 `admin_controls_manager` 的具体策略字段未逐字段展开；本文只确认“企业 + admin 开启 + 非运行时禁用”的总条件。
13. 适配工作树的 kernel event / terminal state 真实 502/容量耗尽路径未在本次调研中复验；本文只从 `paseo_model_compat.py`、`kernel-events.ts`、`kernel-terminal-state.ts`、`proxy.ts` 读实现。
14. 官方 `skill` 发现只在本地执行，没有 ACP 列表或通知；本文不把 Paseo 技能命令、技能 MCP 或 `paseo.dev/*` 标记算作官方能力。
