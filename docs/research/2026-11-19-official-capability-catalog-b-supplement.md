# 席 B 对席 A 的协议面补充底稿

> **这是调研席 B 对调研席 A 的补充，不是合并稿，不是验收证书。**
> 席 B 的第一份底稿 `2026-11-19-official-capability-catalog-b.md` 按**运行族**取证（模型、过滤、模式、
> 工具、技能、MCP、hooks、浏览器、重试、用量、条件）；席 A 的
> `2026-11-19-official-capability-catalog-a.md` 按**协议面**取证（能力位、认证、会话 RPC、输入块、
> 输出事件、权限、命令、终态、负空间）。本文只补「A 有、B 没有」的那部分，**不重抄 A**，也不重抄 B。
> 两份底稿都未参与签核，也都没进 README。本文不提出把 Paseo 的 `clientInfo` 冒充成 `zed`／`xcode`／
> JetBrains，不提出恢复任何全局排队，不写修复代码。

## 0. 版本、哈希与仓库（与席 B 第一份一致，此处只列取值依据）

| 项 | 值 |
|---|---|
| 官方版本 | `1.5.0`（`/tmp/agy-audit-57c8.MDpA52/par-source/.../acp_server/_version.py:3`） |
| `server.py` SHA-256 | `c4a5909af7ba15079309a67012014d071c608ac920ab229f3a2344f21383e4fb`（运行时与对照副本同值） |
| `local_connection.py` | `14423f2599693c818207049471a824b2eeef042dbe1946450df3a7080cb9a839` |
| `main.py` | `4f423c0907ad2409e92e74201aa1d8e1ad1a09c1ea1776a249ae09d6786273e3` |
| `proxy_agent_config.py` | `3a7ca6fa8937c67fa27c54f42ce66095687b735898536afc32e0dc970c4ae182` |
| 主入口 | `/tmp/agy150/src/server.py`（下文 `server.py:` 一律指这份） |
| 对照副本 | `/tmp/agy-audit-57c8.MDpA52/par-source/google3/cloud/developer_experience/antigravity_extensions/acp_server/`（下文 `PAR/` 指这一份） |
| 适配器仓 | `/home/tiezbro/projects/paseo-agy-acp`，`refactor/official-core-paseo-lightweight`，HEAD `3443b97d232955d90b3db0c7c180fb7fcded9942`，**工作树有未提交改动** |
| 配套仓 | `/home/tiezbro/projects/MAACS-agy-capabilities`，`feat/antigravity-official-capabilities`，HEAD `b9726d2d379956ee38075c28d73ec66fb6f6d985`，**工作树有未提交改动** |

## 1. 本文的状态口径（先说清，后两个标签与 B 第一份用法不同）

状态仍只用五个：已对齐 / 有缺口 / 已知差异 / 官方条件不满足 / 非官方扩展。为了让「负空间」可判，
本文对后两个标签加一条明确规则：

- **官方条件不满足**：官方不提供该能力或协议信号，且 Paseo 与适配器都**没有**实现它。属于「官方本来就不发」，
  不是谁的缺口。
- **非官方扩展**：官方不提供，但 Paseo 或适配器**实现了**。这类必须标扩展，不能计入官方能力。

B 第一份的负空间是散在 I 族与 §M 里的，没有把「官方不发且两家都没实现」与「官方不发但 Paseo 已实现」
分开判，所以后两个标签在 B 第一份里含义偏松。本文按上面的规则重判；凡与 B 第一份不同，条内注明。

## 2. 不重复的部分（覆盖对照表）

下表说明本文**故意不写**的条目，以及为什么：

| A 的条目 | 已由 B 覆盖的条目 | 处理 |
|---|---|---|
| I10 `mcpCapabilities.http/sse` | B F01 | 不重复 |
| I14 `clientCapabilities.fs` | B C16 | 不重复 |
| I15 `clientInfo` 门控 | B B01/B02/B03 | 不重复 |
| C01–C16 配置选项 | B A01–A09 | 不重复 |
| S03 MCP 合并 | B F03/F06 | 不重复 |
| S09 `session/cancel` | B I08 | 不重复 |
| S10 `-32002` | B I10 | 不重复 |
| S13 模型切换延迟 | B A09 | 不重复 |
| S16 turn 清理 | B C18 | 不重复 |
| P02 文本内斜杠命令 | B E05 | 不重复 |
| O05–O07 工具三段 | B C06/D10 | 不重复 |
| O08 内部 MCP schema 隐藏 | B C17 | 不重复 |
| O09 MCP 输出 | B F08 | 不重复 |
| O11/O12 图片与搜索输出 | B D08 | 不重复 |
| R01 审批请求形状 | B C06 | 不重复 |
| R03 高风险警告 | B C07 | 不重复 |
| R04 `Allow Always` 缓存身份 | B C08 | 不重复 |
| R05/R06 拒绝与取消 | B C09 | 不重复 |
| R07 模式自动批准 | B C04/C05 | 不重复 |
| R08 问答复用 permission | B C10 | 不重复 |
| R09 问答 kind 映射 | B G10 | 不重复 |
| R11 客户端 fs 回调 | B C16 | 不重复 |
| R12 浏览器子代理 | B H01–H08 | 不重复 |
| R13 hooks/trust | B G01–G11 | 不重复 |
| R14 待审批帧清扫 | B C18 | 不重复 |
| M02 命令集合 | B E04 | 不重复 |
| M03 `/plan` 是斜杠命令 | B E05（部分） | 负空间另立一条（§11 补57），因为 B 只在 `/plan` 一条里提了一句 |
| M04/M05 `/usage`、`/logout` | B J03（`/usage`）；`/logout` 未覆盖 | `/usage` 不重复；`/logout` 另立（补23） |
| E01–E05 stopReason | B I09 | 不重复 |
| E06/E07/E08 错误码 | B I10 | 不重复 |
| E09 上游错误走正文 | B I04 | 不重复 |
| N08 重试信号 | B I01 | 不重复 |
| N09 HTTP 状态信号 | B I07 | 不重复 |
| N10 结构化终态失败 | B I04/I07 | 不重复 |
| N11 不隔离诊断正文 | B I04 | 不重复 |
| N14 不猜用量分母 | B J01 | 不重复 |

### 2.1 与 B 第一份结论不同的三处（以本文为准，理由在条内）

1. **`_meta.antigravity.tier`（A I11/A12）**：B J06 写「Paseo 是否展示 upgradeUri 未核实」。席 A 读配套仓
   得出 Paseo `applySessionState` 完全不读 `_meta`，本轮复核配套仓
   `acp-agent.ts:3235-3260`、`3732-3756` 仍未出现 `tier` 字样，因此本文把该能力判为**有缺口**（Paseo 侧），
   官方侧仍是已对齐。这条不另立条目，结论并入此处。
2. **高风险审批 `_meta` 的渲染（A R03）**：B C07 写「本文未核实」。配套仓
   `acp-agent.ts:2875-2938` 的 `requestPermission` 只按 option id 生成单选动作，不读
   `option._meta`，因此 **Paseo 不展示 `agy.security.warning`**，判**有缺口**（传输层对齐、呈现层未消费）。
3. **审批选项的不对称（A R02）**：B C06 只写「第三种按工具类决定」，没写**顺序**与**第三种出现的四个分支**。
   顺序在协议上有意义（客户端常默认选第一项），因此本文另立**补52**。

---

## 3. 初始化与能力位（补01–补11）

### 补01 `initialize` 的协议版本回显
- 官方做什么：把客户端发来的 `protocolVersion` 原样放进 `InitializeResponse.protocolVersion`；不校验、不改写、不协商。同时读 `clientCapabilities.fs` 与 `clientInfo`，据此定后续能力与 User-Agent，并把 User-Agent 回灌到已经惰性创建的 OAuth／企业授权管理器与遥测。
- 官方信号：`server.py:2576-2601`（参数与两处读取）；`server.py:2596-2597`（`protocol_version=protocol_version`）。
- 官方不做什么：不因版本不匹配拒绝连接；不在运行中二次协商；不在响应里另造版本号。
- Paseo 适配：适配器透传 `initialize` 的全部字段，只覆盖 `agentInfo`（`proxy.ts:515`）；Paseo 发自己的 `PROTOCOL_VERSION`。HEAD 与工作树一致。
- 适配状态：已对齐

### 补02 `loadSession` 能力位
- 官方做什么：`agentCapabilities.loadSession=true`，声明支持 `session/load` 并在 load 时重放历史。
- 官方信号：`server.py:2679-2680`。
- 官方不做什么：不声明 load 的分页或增量重放；不承诺每个内部步骤都产生事件（见补27/补28）。
- Paseo 适配：Paseo 读该位，为真时走 `session/load`，否则才退 `resume`（配套 `acp-agent.ts:2086-2104`）。
- 适配状态：已对齐

### 补03 `auth.logout` 能力位
- 官方做什么：`agentCapabilities.auth.logout` 声明 `logout` 可用；源码注释写明「Clients MUST NOT call `logout` unless this is advertised」。
- 官方信号：`server.py:2678-2682`。
- 官方不做什么：不公布默认认证方法；不在能力位里暗示账号已登录。
- Paseo 适配：适配器透传该能力位；配套仓全文件没有 `authenticate`／`logout` 调用（`grep -c "\"authenticate\"\|'authenticate'\|\"logout\""` 得 0），Paseo 也没有注销入口。
- 适配状态：有缺口

### 补04 `sessionCapabilities.list`
- 官方做什么：声明 `session/list`；实现枚举 `<gemini_home>/antigravity-acp/conversations` 下的 `.db`。
- 官方信号：`server.py:2685-2687`。
- 官方不做什么：不声明分页；实现**忽略** `cursor` 且不返回 `nextCursor`（补30）。
- Paseo 适配：Paseo 只在能力位存在时调 `listSessions`，并按 `nextCursor` 循环；官方不返回时自然结束（配套 `acp-agent.ts:1420-1450`）。
- 适配状态：已对齐

### 补05 `sessionCapabilities.resume`
- 官方做什么：声明支持恢复会话但**不重放历史**；`session/resume` 返回配置、模型、模式与 tier。
- 官方信号：`server.py:2686-2687`；实现 `server.py:4112-4149`。
- 官方不做什么：不在 resume 时发 `user_message_chunk`、planner 文本或工具历史。
- Paseo 适配：因官方 `loadSession=true` 优先，Paseo 在官方能力下**永远不会**选 resume（配套 `acp-agent.ts:2086-2104`）。这是能力可达性问题，不是实现错误。
- 适配状态：有缺口

### 补06 `sessionCapabilities.additionalDirectories`
- 官方做什么：声明 new/load/resume 接受额外工作区根；三个入口都读该参数。
- 官方信号：`server.py:2688-2690`；读取点 `server.py:3689-3692`（new）、`3959-3963`（restore）、`4118`（resume）、`4215`（load）。
- 官方不做什么：不在客户端省略时隐式恢复旧目录（load/resume 省略即**清除**，`server.py:3901-3903` 的 docstring 明确这是 ACP v1 语义）。
- Paseo 适配：Paseo 先查能力位再带该参数（配套 `acp-agent.ts:2050-2062`）；适配器透传。
- 适配状态：已对齐

### 补07 `promptCapabilities.image`
- 官方做什么：声明接受 `session/prompt` 的 `image` 块；base64 解码成 SDK `Image`，失败只告警并丢弃该块。
- 官方信号：`server.py:2692-2695`；解析 `server.py:1305-1321`。
- 官方不做什么：不保证后端模型理解图片；不因解码失败让整个 prompt 失败。
- Paseo 适配：Paseo 发 `{type:"image",data,mimeType}`（配套 `acp-agent.ts:4015-4018`）；适配器透传。
- 适配状态：已对齐

### 补08 `promptCapabilities.audio`
- 官方做什么：声明接受 `audio` 块；解码成 SDK `Audio`，失败只告警并丢弃。
- 官方信号：`server.py:2692-2695`；解析 `server.py:1322-1338`。
- 官方不做什么：不保证后端接受音频；不把音频转文本。
- Paseo 适配：Paseo 不生成 `audio` 块，上传音频走 `resource_link`（配套 `acp-agent.ts:4020-4035`）。能力被声明但从不使用。
- 适配状态：有缺口

### 补09 `promptCapabilities.embeddedContext`
- 官方做什么：声明接受 `resource` 块（内嵌文本或 image/audio blob）。
- 官方信号：`server.py:2692-2695`；解析 `server.py:1339-1395`。
- 官方不做什么：不接受任意 MIME 的 blob（非 image/audio 直接丢弃）。
- Paseo 适配：Paseo 只在带 `mimeType` 的文本块上转 `resource`，普通文本仍走 `text`（配套 `acp-agent.ts:4004-4014`）；blob 形式不发。
- 适配状态：有缺口

### 补10 `_meta.antigravity.systemPrompt.append`
- 官方做什么：在 initialize 的能力 meta 里声明 `systemPrompt.append=true`，表示 new/load/resume 接受 `_meta.antigravity.systemPrompt.append` **字符串**追加到系统提示；没有替换语义，也没有逐轮更新 RPC。
- 官方信号：`server.py:2701-2707`（声明）；`PAR/system_prompt.py:11-45`（提取，只认 `append` 字符串）；注入点 `server.py:3687`（new）、`4006`（restore）。
- 官方不做什么：不提供 `replace`；不接受非字符串；不在 prompt 轮次里重读该值（是**会话快照**，不是逐轮开关）。
- Paseo 适配：适配器在 initialize 时读该能力位并存成 `#nativeSupported`（`context.ts:49-56` 的 `observeInitialize`），但默认**不用**它：默认路径是每轮从 Paseo daemon 读追加文本并前置成文本块（`context.ts:14-25,82-86`）；只有 `PASEO_AGY_ACP_NATIVE_SYSTEM_CONTEXT=1` 时才改用官方原生 append（`context.ts:59-72`）。这是有意的改写：官方是会话快照，Paseo 需要逐轮动态。
- 适配状态：已知差异（适配器默认不用原生 append；用了才对齐）

### 补11 `agentInfo` 官方身份
- 官方做什么：返回 `name:"antigravity-acp"`、`title:"Google Antigravity"`、`version=<包版本>`。
- 官方信号：`server.py:2710-2715`；版本来源 `PAR/useragent.py:43-45` 读 `_version.__version__`。
- 官方不做什么：不提供改名 RPC；不把版本写进其它响应。
- Paseo 适配：适配器把 `agentInfo` 覆盖成 `agy-acp` / `paseo-agy-acp (official Antigravity ACP kernel)` / 适配器包版本（`proxy.ts:515` 调 `overlayProductIdentity`，`identity.ts:3-16`）。B 第一份 §0 表格里的 `antigravity-acp` 是**官方原值**，线上 Paseo 看到的是覆盖值。
- 适配状态：已知差异

---

## 4. 认证条件链（补12–补23）

### 补12 `Log in with Google`（`oauth-personal`）
- 官方做什么：公布第一个认证方法，id `oauth-personal`；选择后在 `authenticate` 内完成交互登录或刷新，并解析项目 ID。该方法是唯一会走 CCPA 动态模型目录与 CCPA 配额查询的路径。
- 官方信号：`server.py:2604-2612`（公布，顺序第一）；`server.py:692`（id 常量）；分派 `server.py:3047-3051`。
- 官方不做什么：不在 initialize 时登录；不在 `authenticate` 回包里返回 token 或账号资料。
- Paseo 适配：适配器透传公布列表；Paseo 无认证选择 UI，也不发 `authenticate`（配套仓 0 处调用）。官方允许跳过 authenticate 而在 `session/new` 触发登录，所以 Paseo 仍能建会话。
- 适配状态：有缺口

### 补13 `Log in with Gemini Enterprise`（`oauth-business`）
- 官方做什么：公布企业登录方法 id `oauth-business`；`authenticate` 内完成登录并解析许可（license）。该路径决定 tier 来源、BAIC 配额、管理员管控是否生效、浏览器子代理是否注入。
- 官方信号：`server.py:2613-2617`；分派 `server.py:3053-3060`；许可错误文案 `server.py:1145-1174`。
- 官方不做什么：不提供企业项目／许可选择 RPC；项目与位置来自 `settings.json` 的 `gcp` 块。
- Paseo 适配：适配器透传；Paseo 无认证入口，因此企业路径在 Paseo 上不可达（连带 B 第一份 K03/H01 的整族都不触发）。
- 适配状态：有缺口

### 补14 `Gemini API key`（`gemini-api-key`）与 `_meta` 供钥的四种拼写
- 官方做什么：公布 `gemini-api-key` 方法。key 可由客户端 `_meta` 的 `api-key`／`apiKey`／`api_key` 三个**外层条目**提供，外层是对象时再认 `apiKey`／`api_key`／`api-key`／`key` 四个**内层字段**；都没有才回退环境变量 `GEMINI_API_KEY`。initialize 刻意**不发** `_meta` 提示，因为那会让 IntelliJ 塞自己的 key（b/543993211），但 `authenticate` 仍读客户端不请自来的 key。
- 官方信号：`server.py:2604-2606`（不发 hint 的注释）；`server.py:2618-2622`（公布）；`server.py:738-740`（两个拼写表）；解析 `server.py:3062-3095`。
- 官方不做什么：不在 initialize 要求 key；不校验 key 有效性形态之外的东西。
- Paseo 适配：适配器透传公布列表与 `_meta`；Paseo 不发 `authenticate`，key 是否可用取决于宿主环境（若宿主未设 `GEMINI_API_KEY`，错误被推迟到 `session/new`，见补20）。
- 适配状态：有缺口

### 补15 `Gemini Enterprise Agent Platform`（`agent-platform`）
- 官方做什么：公布 `agent-platform` 方法（前身 Vertex AI）；凭据优先级是 `GOOGLE_API_KEY`，或 `GOOGLE_CLOUD_PROJECT` + `GOOGLE_CLOUD_LOCATION`，或 `settings.json` 的 `gcp` 块。
- 官方信号：`server.py:2623-2632`；分派 `server.py:3097-3108`；变量名 `server.py:711-713`。
- 官方不做什么：缺配置时在 `authenticate` 直接返回 `-32602`（不是 `-32000`）；不在 initialize 校验凭据。
- Paseo 适配：适配器透传；Paseo 无认证入口，且该路径的 `agent_platform_only` 模型（B A02）也不可达。
- 适配状态：有缺口

### 补16 `vertex-ai` 旧 id 归一化
- 官方做什么：仍接受旧 id `vertex-ai`，归一到 `agent-platform`；但公布列表**只给规范 id**，避免一个方法出现两个按钮。
- 官方信号：`server.py:697-698`（两个常量）；`server.py:732-733`（别名表）；解析 `server.py:743-748`；公布处注释 `server.py:2623-2624`。
- 官方不做什么：不把 `vertex-ai` 作为第二个 authMethod 公布。
- Paseo 适配：适配器把 `authenticate` 原样转发（`proxy.ts` 通用转发路径），不参与 id 归一化；Paseo 不调用。
- 适配状态：已对齐

### 补17 `AI API Gateway` 的三重门
- 官方做什么：三个条件**同时**成立才公布 `gateway` 方法：① 客户端在 `clientCapabilities.auth._meta.gateway` 传真；② 环境开关 `AGY_ACP_ENABLE_GATEWAY_AUTH` 开启；③ 企业策略未禁止。公布时带 `_meta.gateway.protocol="google"`。策略只有三种结果：`REQUIRED` 时**清空全部 authMethods**（因为策略会自动完成认证，客户端不该再选），`FORBIDDEN` 时撤下 gateway（其余四种保留），否则追加 gateway。
- 官方信号：`server.py:2634-2676`（三重门与三种策略处置，逐跳 `getattr`/`isinstance` 防御）；`server.py:948-990`（`REQUIRED` 下 `_infer_auth_state` 自动认证）。
- 官方不做什么：不对未 opt-in 的客户端公布；不在未设 env 时启用；gateway 不写 `settings.json` 的 `auth.type`（所以 logout 对它是空操作，见补22）。
- Paseo 适配：Paseo 的 `BASE_ACP_CLIENT_CAPABILITIES` 没有 `auth._meta.gateway`（配套 `acp-agent.ts:455-461`），第一道门就不满足，整条链在 Paseo 上不可达。
- 适配状态：官方条件不满足

### 补18 `authenticate` 的方法分派与切换时的会话迁移
- 官方做什么：按 `methodId` 分派四种标准方法（含旧 id 归一化）；成功后记住认证类型。**真实认证方式变化**时重建所有活动会话到新认证；gateway 配置轮换是另一条路（原地重建、不重列 CCPA 模型）。
- 官方信号：`server.py:2966-3191`（分派主体）；`server.py:3172-3190`（调用迁移）；`server.py:2122-2180`（`_rebuild_sessions_for_auth_change`）；`server.py:3139-3158`（gateway 轮换专用重建）。
- 官方不做什么：不在迁移时发通知；不保留旧认证下的模型 id 命名空间（旧 id 会被替换，见 B A10）。
- Paseo 适配：适配器双向透传；Paseo 无 `authenticate` 入口，因此这条迁移在 Paseo 上只能被外部环境变化触发（例如宿主换 key），无法由 UI 触发。
- 适配状态：有缺口

### 补19 API key 缺失延迟到 `session/new`
- 官方做什么：API key 缺失时 `authenticate` **仍然成功返回**，只是清空旧认证状态；真正的 `-32000` 推迟到 `session/new`，文案指向设置 `GEMINI_API_KEY`。源码注释写明原因：Zed 会丢弃 `authenticate` 抛的错误，用户就看不到任何提示。
- 官方信号：`server.py:3080-3092`（成功返回 + 延时理由）；`server.py:1128-1134`（文案构造）；`server.py:1059-1140`（`_auth_required_error`）。
- 官方不做什么：不在 `authenticate` 抛 API key 缺失；不把该详情塞进 `data`（只给 message）。
- Paseo 适配：适配器不改时序；Paseo 若从不调 `authenticate`，就只会在 `session/new` 看到这条错误——这正是官方设计给「不实现认证 UI 的客户端」的路径，行为一致。
- 适配状态：已对齐

### 补20 `auth_required` 的 `data.reason`
- 官方做什么：需要认证或已注销时返回 `-32000`；已注销路径额外带 `data={"reason":"logged_out"}`，客户端据此重开账号选择器。消息文本来自 `logout.LOGGED_OUT_MESSAGE`。
- 官方信号：`server.py:704-708`（`_AUTH_REQUIRED_CODE` 与 `_INVALID_PARAMS`）；`server.py:2728-2733`（`set_mode` 路径的 `data.reason`）；同型点 `2916-2921`（`set_config_option`）、`5524-5529`（`prompt`）。
- 官方不做什么：不用 `resource_not_found` 表示已注销；不在其它认证错误里也塞 `reason`。
- Paseo 适配：传输层保留 `code`/`message`/`data`；Paseo 的 `summarizeACPRequestError` 会把 `data` 拼进摘要（配套 `acp-agent.ts:360-396`），但**没有**按 `reason="logged_out"` 重开认证 UI 的分支。
- 适配状态：有缺口

### 补21 `logout` RPC：只清当前 flavor
- 官方做什么：清除**当前认证方式**对应的凭据、重置认证状态、拆除所有活动会话。API key／Agent Platform 连接没有可清凭据时保持连接可用（返回 false 而不是报错）。
- 官方信号：`server.py:3193-3207`（`logout`）；`server.py:3239-3290`（`_clear_all_credentials`）；`server.py:3209-3212`（`_active_auth_method` 先取再清的理由）。
- 官方不做什么：**不清除另一种 OAuth 方式的凭据**（例如企业登录不会顺手清个人 token）；gateway 不写 `settings.json` 的 `auth.type`，所以对 gateway 明确是空操作（`server.py:3226-3237` 的日志与理由）。
- Paseo 适配：适配器透传 `logout`；Paseo 无注销调用或 UI（配套仓 0 处）。生产旧客户端同。
- 适配状态：有缺口

### 补22 `/logout` 命令
- 官方做什么：prompt 的 text 块拼起来**恰为** `/logout` 时，在 session 查找之前拦截（所以会话已拆也能注销），执行注销、发一行确认正文、返回 `end_turn`。确认文本会说明清除了哪些凭据；gateway 场景说明没有可注销的东西。
- 官方信号：`server.py:5518-5521`（拦截点与顺序注释）；`server.py:3292-3316`（`_handle_logout_command`）；`PAR/logout.py:35-44`（`is_logout_prompt`）、`PAR/logout.py:29-31`（命令描述）、`PAR/logout.py:46-87`（确认文本）。
- 官方不做什么：不接受 `/logout` 之外的文本；不把注销结果做成独立通知；不把 `/logout` 交给模型。
- Paseo 适配：适配器把 `/logout` 当普通 prompt 透传，不拦截；Paseo 的命令列表里能出现它（官方会公布），但点下去只是发一条 prompt，认证状态 UI 不联动（配套 `acp-agent.ts:3431-3437` 只消费命令列表）。
- 适配状态：有缺口

### 补23 认证 UI 与交互式 OAuth 事件
- 官方做什么：**只有** authMethods 公布。OAuth 登录在服务进程内完成（浏览器回调走本机），ACP 协议层没有登录 URL、进度、账号资料或切换事件。
- 官方信号：`server.py:2604-2676`（只有方法列表）；`server.py:3047-3108`（登录在 `authenticate` 内同步完成）；`main.py:65-88` 的 login 是**独立 CLI** 路径，不是 ACP。
- 官方不做什么：不发登录 URL；不发账号切换事件；不把 token 发给客户端。
- Paseo 适配：适配器透传；Paseo 没有认证选择 UI。按第 1 节规则，这条属于「官方本就不提供 + Paseo 也未实现」。
- 适配状态：官方条件不满足

---

## 5. 会话 RPC（补24–补34）

### 补24 `session/new` 的响应形状
- 官方做什么：展开 `~`、要求已认证、初始化企业管控、预建 trajectory DB、列模型、合并 MCP、构建 SDK agent、写 sidecar，然后返回 `sessionId`（UUID）、**同时**三套选择状态（`configOptions` 与 superseded 的 `models`、`modes`）、以及 `_meta.antigravity.tier`。响应入队后才异步补发 `usage_update` 与 `available_commands_update`。
- 官方信号：`server.py:3631-3757`；返回体 `server.py:3751-3757`；UUID `server.py:3664`；两个延后任务 `server.py:3745-3748`。
- 官方不做什么：不在 new 里发模型正文；不把 MCP 或技能列表作为独立响应字段；不把历史当响应数组返回。
- Paseo 适配：适配器补 `cwd`、daemon context、技能 MCP，其余透传（`proxy.ts:286-307`）；Paseo 读 `sessionId` 与 `configOptions`。
- 适配状态：已对齐

### 补25 `additionalDirectories` 的规范化与「省略即清除」
- 官方做什么：展开 `~`、`abspath`、按序去重、排除 `cwd`；非法项（非字符串、空白、含 NUL、相对路径、文件系统根、已存在的非目录文件）**只告警并跳过**，不让 `session/new` 失败。
- 官方信号：`server.py:1406-1466`（`_normalize_additional_directories` 与其 docstring）；调用点 `3689-3692`（new）、`3959-3963`（restore）。
- 官方不做什么：不因单个坏目录失败；**不在 load/resume 省略时恢复旧值**——`_restore_session` 的 docstring 明确「omitting this field or passing an empty sequence clears any previously stored roots」。
- Paseo 适配：适配器原样透传；Paseo 在能力位存在时发送数组（配套 `acp-agent.ts:2050-2062`），不复用旧值。
- 适配状态：已对齐

### 补26 `session/load` 恢复并重放历史
- 官方做什么：恢复会话上下文、初始化 agent，然后从 SQLite trajectory 读步骤并**逐条重放**；响应返回配置与 tier，不返回历史数组。
- 官方信号：`server.py:4209-4251`（load）；`server.py:3887-4110`（`_restore_session`）；重放主体 `server.py:6503-6651`。
- 官方不做什么：不重放 usage、plan、compaction、浏览器通知；不保证每一步都产生事件。
- Paseo 适配：适配器透传并补 cwd／技能 MCP；Paseo 在 `loadSession=true` 时走 load，`replayingHistory` 期间把历史事件灌进持久化时间线（配套 `acp-agent.ts:2086-2095`）。
- 适配状态：已对齐

### 补27 历史重放的事件形状
- 官方做什么：三种历史步骤各有固定形状：`user_input` → `user_message_chunk`（纯文本）；`planner_response` → 先 `agent_thought_chunk`（`thinking`）再 `agent_message_chunk`（`modified_response` 优先，否则 `response`）；工具步骤 → 先 `tool_call` 且 **`status` 直接是 `completed`**，再 `tool_call_update` 带输出与最终状态。
- 官方信号：`server.py:6503-6651`（三个分支）；工具段 `6600-6651`。
- 官方不做什么：重放时**不发** `usage_update`；历史 `generate_image` **不**重发内联图片块（只给 rawOutput 字典）；不把被拒绝的工具重放成 `completed`。
- Paseo 适配：适配器透传；Paseo 的 `handleUserMessageChunk`／`translateSessionUpdate` 消费这些事件（配套 `acp-agent.ts:3380-3460`）。
- 适配状态：已对齐

### 补28 `session/resume`
- 官方做什么：恢复上下文但**不重放历史**；返回 `configOptions`、`models`、`modes`、tier。模型列表失败时：热恢复可保留已有模型，冷恢复失败。
- 官方信号：`server.py:4112-4149`；热恢复降级 `server.py:4035-4051`。
- 官方不做什么：不发 `user_message_chunk` 或工具历史；不要求客户端声明 load 能力。
- Paseo 适配：同补05——官方 `loadSession=true` 时 Paseo 不选 resume（配套 `acp-agent.ts:2086-2104`）。
- 适配状态：有缺口

### 补29 `session/list`
- 官方做什么：枚举 `<gemini_home>/antigravity-acp/conversations` 下的 `.db`；从 sidecar 读 `cwd` 与附加目录（缺失时回退 `gemini_home`）；标题**固定**为 `Session <id 前 8 位>`；可按 cwd 过滤。
- 官方信号：`server.py:3828-3885`；标题 `server.py:3864-3866`；cwd 回退注释 `3858-3861`；常量 `PAR/session_store.py:32-34`。
- 官方不做什么：**忽略 `cursor`**（`server.py:3842`）；不返回 `nextCursor`；不生成动态标题；不返回更新时间。
- Paseo 适配：适配器透传；Paseo 循环 `nextCursor`，官方不返回时结束（配套 `acp-agent.ts:1420-1450`）。
- 适配状态：已对齐

### 补30 会话 sidecar 元数据
- 官方做什么：在 `<session>.meta` 保存 `cwd`、`additional_directories`、`mode_id`、`tool_filter`、`allowed_tool_calls` + `allowed_tools_workspace`；load/resume 只恢复**同 workspace** 的 Allow Always，旧格式 `allowed_tools`（list[str]）刻意忽略并要求重新授权。
- 官方信号：`server.py:3736-3743`（new 写入）；`server.py:4097-4103`（restore 写入）；`server.py:3959-3975`（restore 读取与同 workspace 绑定）；`PAR/session_store.py:81-113`。
- 官方不做什么：不把 sidecar 当 ACP 响应字段；不跨 workspace 复用授权；不迁移旧格式授权。
- Paseo 适配：适配器不读 sidecar；Paseo 用自己的持久化恢复 `_meta` 与 session 参数（配套 `provider-config.ts:6-9`、`acp-agent.ts` 的 sessionParameters）。两套存储各管各的，不混用。
- 适配状态：已对齐

### 补31 客户端断开时的清理
- 官方做什么：`on_disconnect` 记一条日志，然后清掉所有会话、后台任务、代理与遥测，并把 `_client` 置 None。
- 官方信号：`server.py:1729-1733`（`on_disconnect`）；`server.py:3774-3826`（`cleanup`）。
- 官方不做什么：不发会话结束通知；不把清理结果回给客户端（此时已经没有客户端）。
- Paseo 适配：适配器在 stdin 结束／关闭时终止内核并清理本地状态（`proxy.ts:145-215`）；Paseo 关闭运行时按能力位决定 `session/close` 或直接杀进程（配套 `acp-agent.ts:2819-2870`）。
- 适配状态：已对齐

### 补32 `session/set_model`（superseded）
- 官方做什么：仍可切模型；只记录选择，agent 在下一轮重建；成功返回**空响应**（不带 configOptions）。未知模型返回 `-32602`，`data` 带 `modelId` 与 `availableModels`（排序后的列表），文案说明是「当前认证方式下不可用」。
- 官方信号：`server.py:2759-2858`；错误块 `server.py:2836-2850`；空响应 `server.py:2856-2857`；下一轮重建 `server.py:2318-2346`。
- 官方不做什么：不在切换时重建运行中的 agent；不返回完整配置；不把不可用模型静默忽略。
- Paseo 适配：Paseo 优先 `session/set_config_option`，失败才回退该 RPC（配套 `acp-agent.ts:2505-2555`）；适配器透传。
- 适配状态：已对齐

### 补33 认证方式切换时的活动会话迁移
- 官方做什么：真实认证方式变化时，把所有活动会话重建到新认证；gateway 配置轮换走另一条路（原地重建，且**不**重新列 CCPA 模型，因为 gateway 不用 CCPA）。
- 官方信号：`server.py:2122-2180`（`_rebuild_sessions_for_auth_change`）；`server.py:3172-3190`（触发点）；`server.py:3139-3158`（gateway 专用重建与「NOT `_rebuild_sessions_for_auth_change`」的注释）。
- 官方不做什么：不发迁移通知；不保留旧认证下的模型 id 命名空间。
- Paseo 适配：适配器不干预；Paseo 无 `authenticate` 入口，无法主动触发。
- 适配状态：有缺口

### 补34 `GEMINI_HOME` 与会话存储位置
- 官方做什么：所有会话、凭据、技能、app data、hooks、trust 文件都在解析后的 Gemini home 下：`$GEMINI_HOME` 非空则用它，否则 `~/.gemini`；`~` 会被展开（避免创建字面 `~` 目录）。`config/skills` 是与其他 Gemini 面共享的，`antigravity-acp/` 是本服务私有的。
- 官方信号：`PAR/paths.py:42`（环境变量名）、`PAR/paths.py:68-92`（`gemini_home_is_explicit`／`gemini_home`）；`PAR/paths.py:94-100`（`config_dir`／`acp_dir`）；调用点 `server.py:3661-3662`、`3915-3917`。
- 官方不做什么：不把会话写进工作区（`app_data_dir` 的注释明确因此不用 cwd）；不把 `GEMINI_HOME` 暴露给客户端。
- Paseo 适配：适配器不覆盖 `GEMINI_HOME`；Paseo 用自己的 `PASEO_HOME` 做 daemon context 与技能发现（`context.ts:45-80`、`skill-commands.ts:108-190`）。两套 home 并行，官方读技能目录时只认自己的。
- 适配状态：已对齐

---

## 6. 输入块（补35–补43）

### 补35 文本块
- 官方做什么：接受 `text` 块，把各块文本拼起来交给 SDK；命中内置斜杠命令名时换成 `SlashCommand` 对象（B E05 已写）。
- 官方信号：`server.py:1271-1280`（text 分支）；`_parse_prompt` 主体 `server.py:1249-1403`。
- 官方不做什么：**不在 prompt 开始时回显用户文本**；不发 `user_message_chunk`（该事件只在 load 重放时出现，见补27）。
- Paseo 适配：适配器透传；Paseo 发 text 块（配套 `acp-agent.ts:3998-4003`）。Paseo 自己在本地渲染用户消息，不依赖官方回显。
- 适配状态：已对齐

### 补36 图片块
- 官方做什么：`image` 块 base64 解码后构造 SDK `Image`；解码／校验失败只告警并**丢弃该块**，prompt 继续。
- 官方信号：`server.py:1305-1321`。
- 官方不做什么：不因坏图让整个 prompt 失败；不返回图片处理结果。
- Paseo 适配：适配器透传；Paseo 发 `{type:"image",data,mimeType}`（配套 `acp-agent.ts:4015-4018`）。
- 适配状态：已对齐

### 补37 音频块
- 官方做什么：`audio` 块同样解码成 SDK `Audio`，失败只告警并丢弃。
- 官方信号：`server.py:1322-1338`。
- 官方不做什么：不把音频转文本；不保证后端接受。
- Paseo 适配：Paseo 不生成 `audio` 块（配套 `acp-agent.ts:4020-4035` 用 `resource_link` 代替）。能力位声明存在但无生产者。
- 适配状态：有缺口

### 补38 `resource` 的文本形式
- 官方做什么：`resource.text` 存在时拼成 `Embedded resource (<uri>):\n<text>`（没有 uri 就是纯 text）。
- 官方信号：`server.py:1339-1350`。
- 官方不做什么：不把文本 resource 当文件路径去读；不把原始 URI 结构留给模型（已被拼成一行前缀）。
- Paseo 适配：Paseo 只在带 `mimeType` 的文本块上发 resource（配套 `acp-agent.ts:4004-4014`），普通文本走 `text`，因此这条路径覆盖面上窄。
- 适配状态：有缺口

### 补39 `resource` 的 image/audio blob
- 官方做什么：`resource.blob` 的 MIME 以 `image/` 或 `audio/` 开头时，base64 解码成 SDK `Image`／`Audio`，URI 作为 description。
- 官方信号：`server.py:1350-1389`。
- 官方不做什么：不接受其他 MIME 的 blob；失败只告警并丢弃。
- Paseo 适配：Paseo 不发 `resource` blob（配套 `acp-agent.ts:4004-4014`）。
- 适配状态：有缺口

### 补40 不支持的 resource MIME
- 官方做什么：非 image/audio 的 blob 只记日志、丢弃该块，prompt 继续。
- 官方信号：`server.py:1390-1395`。
- 官方不做什么：不把二进制转文本；不返回 `-32602`。
- Paseo 适配：Paseo 不会主动发这类块，路径不被触发。
- 适配状态：已对齐

### 补41 `resource_link`
- 官方做什么：按 URI 的 path 在**服务端本地**读文件，用 `sdk_types.from_file` 构造文档；读取或类型失败时退化为文件路径字符串，让模型自己用 `view_file` 去读。还有一处 MIME 重标记（不支持的文档类型被改写）。
- 官方信号：`server.py:1281-1304`（`resource_link` 分支）；`server.py:1220-1246`（`_retag_unsupported_document_mime`）。
- 官方不做什么：不从客户端上传通道取内容；不保证远端客户端的路径在服务端存在（这正是退化成路径字符串的原因）。
- Paseo 适配：Paseo 对 `uploaded_file` 在 `embeddedContext` 为真时发 `resource_link` 的 `file://` URI（配套 `acp-agent.ts:4020-4035`）；适配器透传。前提是 Paseo 与内核同主机。
- 适配状态：已对齐

### 补42 不支持的内容块
- 官方做什么：未知 `block.type` 只记 warning、跳过，不使 prompt 失败。
- 官方信号：`server.py:1396-1399`。
- 官方不做什么：不返回 `-32602`；不猜块类型。
- Paseo 适配：Paseo 只生成已知类型（配套 `acp-agent.ts:3998-4048`）。
- 适配状态：已对齐

### 补43 prompt 的 `messageId`
- 官方做什么：接收可选 `messageId`，只用于每轮 telemetry 的 prompt id（并作为 BAIC 代理的 `X-Aicode-Prompt-Id` 追踪头）；没有时生成 UUID。它不写进会话正文、不回显、不做幂等去重。
- 官方信号：`server.py:5503`（参数）；`server.py:5577-5582`（记录与 UUID 回退）。
- 官方不做什么：不把它当文本回显；不用它去重同一 prompt 的重复提交。
- Paseo 适配：适配器透传；Paseo 每轮 `startTurn` 生成 UUID（配套 `acp-agent.ts:2179-2205`）。
- 适配状态：已对齐

---

## 7. 输出事件（补44–补50）

### 补44 正文只对根 trajectory 发
- 官方做什么：`agent_message_chunk` 只在 `step.source==MODEL`、`step.target==USER`、`status != ERROR`、**且 `parent_trajectory_id` 为空**时发 `content_delta`。子 agent 的正文不发，避免两条流交错；ERROR 状态的 MODEL→USER 文本也不发（那通常是「用户拒绝了工具」这类面向模型的回执，发出去会泄漏成助手正文的开头）。
- 官方信号：`server.py:6025-6032`（四条件）；`server.py:6047-6056`（`AgentMessageChunk`）。
- 官方不做什么：不发 subagent 文本；不发 ERROR 状态的 MODEL→USER 文本。
- Paseo 适配：适配器经系统封套折叠后透传（`system-message-fold.ts:60-110`）；Paseo 映射成 assistant message（配套 `acp-agent.ts:3363-3385`）。
- 适配状态：已对齐

### 补45 操作性文本的完整清单（全部复用 `agent_message_chunk`）
- 官方做什么：以下八类文本**都**走普通 `agent_message_chunk`，没有独立通道、没有 `_meta` 标记：① 浏览器不可用／降级通知 ② SDK 终端错误文案 ③ 连接丢失 ④ 重建失败 ⑤ 模型替换说明 ⑥ 引用来源 ⑦ `/logout` 确认 ⑧ `/usage` 报告。B 第一份 I04 只点了 ②③④ 这一类。
- 官方信号：`server.py:5552-5575`（浏览器）②；`5733-5767`（SDK 错误）；`5775-5785`（连接丢失）；`2361-2376`（模型替换）；`5836-5874`（引用）；`3305-3313`（logout）；`3453-3462`（usage）。
- 官方不做什么：不给这些文本加 `_meta` 身份标记；不把助手正文与系统提示分开；不发 JSON-RPC error。
- Paseo 适配：适配器只对官方 `<SYSTEM_MESSAGE>` 封套加 `paseo.dev/messageKind=system`（`system-message-fold.ts:124`），其余七类仍是普通正文，Paseo 一律显示成助手消息。工作树 compat 另外抑制固定的终止诊断 chunk（B I04），但那只覆盖 ② 的一部分。
- 适配状态：已知差异

### 补46 实时思考摘要 `agent_thought_chunk`
- 官方做什么：与正文同一组门条件，只是取 `step.thinking_delta`；只对根 trajectory、非 ERROR、MODEL→USER 发。
- 官方信号：`server.py:6035-6046`。
- 官方不做什么：**不凭空生成思考摘要**——模型不吐 `thinking_delta` 就没有任何事件，也没有「把正文转成思考」的降级路径。
- Paseo 适配：适配器透传；Paseo 映射成 reasoning（配套 `acp-agent.ts:3386-3390`）。B 第一份完全没有这一族。
- 适配状态：已对齐

### 补47 历史思考摘要
- 官方做什么：load 重放 `planner_response.thinking` 时发 `agent_thought_chunk`，然后才发正文。
- 官方信号：`server.py:6523-6534`。
- 官方不做什么：只重放 planner 的 `thinking`；不重放其它内部 thinking 字段。
- Paseo 适配：适配器透传；Paseo 映射 reasoning。
- 适配状态：已对齐

### 补48 后台 exec 跨 turn 保持打开
- 官方做什么：回合**正常完成**时，仍 active 的 exec 工具不关闭，而是移入 `persisted_open_tool_calls`；后续步骤完成时再发终态。异常／取消路径则走统一清扫（B C18）。
- 官方信号：`server.py:5631-5639`（移入持久化注册表，注释写明只在干净完成时做）；`server.py:6195-6213`（持久化调用的终态与 kill 处理）。
- 官方不做什么：不把后台 exec 当失败；不在切 turn 时丢掉工具行。
- Paseo 适配：适配器透传；Paseo 的时间线允许跨 turn 更新同一 `toolCallId`（配套 `acp-agent.ts:3493-3541`）。
- 适配状态：已对齐

### 补49 `manage_task` kill 关闭被取消的后台工具
- 官方做什么：当某工具步骤是 `manage_task(Action="kill", TaskId="task-<n>")` 且执行成功时，把匹配的**活动与持久化**后台工具都标 `failed`，`rawOutput="Killed by manage_task(<id>)"`。id 匹配规则：`task_id` 必须以 `task-` 开头，去掉前缀后的步号要与 `tool_call_id` 相等（`"31"`）或作为其尾部（`"main:31"`）。
- 官方信号：`server.py:6175-6213`（活动与持久化两处关闭）；`server.py:262-279`（`_match_tool_call_id_to_task_id`）。
- 官方不做什么：不把被杀工具当 completed；不在 `task_id` 不匹配时猜。
- Paseo 适配：适配器透传；Paseo 显示失败终态。
- 适配状态：已对齐

### 补50 引用来源通知
- 官方做什么：BAIC 代理在流中途检测到引用，官方的处理是**攒到 turn 末尾**一次性以普通 `agent_message_chunk` 发一段来源列表。攒的理由写在 docstring 里：中途发会与模型自己的流式文本交错，且一轮会有多次推理，只有末尾能合并展示。
- 官方信号：`server.py:5836-5874`（`_send_citation_notice`，含「ACP has no citation primitive」）。
- 官方不做什么：不发结构化 citation 对象、链接数组或独立通知；不在流中逐条插入。
- Paseo 适配：适配器透传；Paseo 当普通正文显示（配套 `acp-agent.ts:3363-3385`）。这是官方限制导致的无结构化引用。
- 适配状态：已知差异

---

## 8. 权限选项的不对称（补51–补52）

### 补51 审批选项的顺序与第三种选项的出现条件
- 官方做什么：选项**顺序固定**，且第三种永远排第一：
  - `allow_always` 存在时：`[allow_always, allow, deny]`
  - 不存在时：`[allow, deny]`
  `allow_always` 在**四个分支**里被省掉：① 工具属于 `AUTO_EDIT_TOOLS`（文件写/建）② `always_ask_file`（企业 ALWAYS_ASK 且目标在工作区外）③ `exec_requires_review`（企业终端策略要求逐条复核）④ 无 `_allow_always_signature`（写工具与缺 `CommandLine` 的 exec）时客户端仍硬发——此时只本次放行、**不持久化**。
  读工具与其它工具拿到的是**不带 `(risky)` 的普通 `Allow Always`**；高风险工具（exec／web）拿到带告警的 `Allow Always (risky)`。
- 官方信号：`server.py:5173-5231`（三个分支的选项构造与顺序）；`server.py:5277-5318`（`allow_always` 的缓存与「downgraded to allow-once」降级日志）。
- 官方不做什么：不给写工具提供可持久化的 `Allow Always`（写了也不缓存，等于静默降级，所以干脆不给）；不接受客户端自定义 option id；不在选项里塞 `kind` 之外的语义。
- Paseo 适配：适配器不改 `options`（`proxy.ts` 的 permission 转发是原样双向）；Paseo 把每个 option 变成单选动作（配套 `acp-agent.ts:2875-2938`）。顺序由官方定，Paseo 不重排。
- 适配状态：已对齐（协议侧）；`_meta` 警告的呈现见 §2.1 第 2 条

### 补52 问答结果的三种终局与文案
- 官方做什么：dummy 工具行的终态由 outcome 类型决定，`rawOutput` 只有两种固定文案：允许 → `completed` + `Response received`；拒绝／取消 → `failed` + `Interaction cancelled`。返回值：`AllowedOutcome` → 选中的 `option_id`；`DeniedOutcome` → `getattr(outcome,"option_id",None)`（取不到就是 None）；其它 → `None`。
- 官方信号：`server.py:5474-5497`（终态与文案）；`server.py:5490-5497`（返回值三分支）。
- 官方不做什么：不把拒绝当失败正文（文案是「交互取消」，不是错误原因）；不重试问题；不分多选。
- Paseo 适配：适配器透传；Paseo 取消时回 `{outcome:"cancelled"}`（配套 `acp-agent.ts:2737-2770`），拿到的是 `None`，与官方语义一致。
- 适配状态：已对齐

---

## 9. 命令面（补53–补54）

### 补53 `available_commands_update` 的发送时机
- 官方做什么：在 new/load/resume 的**响应已入队**之后，用后台任务异步发一次；发送前 `await asyncio.sleep(0)` 把控制权交回事件循环，确保 `NewSessionResponse` 先被排空送出，命令通知不会抢在响应之前到。每个会话只在建立／恢复时发一次，不在每轮重发，也不落盘。
- 官方信号：`server.py:5338-5354`（调度 + `sleep(0)` 与理由）；`server.py:3745-3748`（new 的调用点）；`server.py:4104`（restore 的调用点）。
- 官方不做什么：不在每个 turn 重发；不持久化命令列表；不提供「命令执行结果」的独立通道（`/usage`、`/logout` 的结果都是普通正文）。
- Paseo 适配：适配器在该通知上追加技能命令后透传（`proxy.ts:448-476`）；Paseo 缓存整份列表（配套 `acp-agent.ts:3431-3437`）。时序差异（Paseo 可能先收到响应再收到命令）正是官方用 `sleep(0)` 想要的顺序。
- 适配状态：已对齐（+ 命令集合扩展，见 B E04）

### 补54 `AvailableCommand.input` 恒缺省
- 官方做什么：构造 `AvailableCommand` 时**只填 `name` 与 `description`**，从不填 `input`（schema 支持 `input.hint`，但 1.5.0 一条都不用）。`/usage` 的多余参数由 `/usage` 自己检查并报错，不靠 `input` 声明。
- 官方信号：`server.py:5355-5363`（唯一的构造点，只有两个字段）；`server.py:3455-3460`（`/usage` 自查参数）。
- 官方不做什么：不声明参数提示；不校验客户端是否发送命令参数。
- Paseo 适配：适配器 `augmentAvailableCommands` 只处理 `name`/`description`（`skill-commands.ts:193-243`）；Paseo 读 `input?.hint`，官方无值则为空字符串（配套 `acp-agent.ts:3431-3437`）。
- 适配状态：已对齐

---

## 10. 终态（补55）

### 补55 空成功轮次是合法结果
- 官方做什么：`PromptResponse(stopReason="end_turn")` 可以**没有可见正文**——官方没有任何「空正文检查」，SDK 没给 response 时直接走默认 `end_turn`，甚至不做 `_send_citation_notice` 之外的处理。
- 官方信号：`server.py:5826-5834`（取消分支之外只有 `stop_reason` 计算与返回，无空正文判断）。
- 官方不做什么：不补一条「无输出」的错误；不把空轮次改失败；不发 JSON-RPC error。
- Paseo 适配：适配器**拒绝**空成功轮次——`proxy.ts:577-581` 在 `shouldRejectBlankTurn` 为真时把响应换成 `blankTurnError(message.id)`（`errors.ts:38`），即一个 `-32000` 失败。HEAD 与工作树都有此行为。这是适配器补偿，不是官方信号。
- 适配状态：已知差异

---

## 11. 官方本来就不发的信号（补56–补62）

本节按第 1 节规则判：官方不提供且 Paseo／适配器**实现了**的判「非官方扩展」；两者都没有的判「官方条件不满足」。

### 补56 `plan` session update 与 plan 模式
- 官方做什么：没有。`/plan` 只是 prompt 文本里的内置斜杠命令，交给 SDK 的 `SlashCommand`（B E05 已写）。`server.py` 全文没有任何 `sessionUpdate:"plan"` 的发送点，`AVAILABLE_SESSION_MODES` 也没有 plan 值。
- 官方信号：`grep -c "plan"` 在 `server.py` 只命中一处描述字符串 `server.py:1198`；模式表 `PAR/config_options.py:25-44`。
- 官方不做什么：不发 plan 事件；不提供只读 plan 模式；不提供 plan 审批 RPC。
- Paseo 适配：Paseo 有通用 `plan` 分支（配套 `acp-agent.ts:3409-3411` → `mapPlanToTimeline`），官方永远不会触发它。
- 适配状态：非官方扩展

### 补57 `current_mode_update`
- 官方做什么：没有。模式变化只通过 `session/set_mode`／`set_config_option` 的**响应**体现；服务端不主动发模式变更通知，连服务端自动替换模型时也只发 `config_option_update`（B A10）。
- 官方信号：`grep -c "current_mode_update\|CurrentModeUpdate"` 在 `server.py` 为 **0**；模式写入路径 `server.py:2754-2756`、`2949-2950`。
- 官方不做什么：不在自动策略改变模式时发通知；不把模式塞进 `config_option_update`（那是另一条）。
- Paseo 适配：Paseo 有 `current_mode_update` 分支与 `handleCurrentModeUpdate`（配套 `acp-agent.ts:3412`），官方不会触发。
- 适配状态：非官方扩展

### 补58 `session_info_update` 与动态标题
- 官方做什么：没有。`session/list` 的标题恒为 `Session <8位>`（补29）；没有改标题 RPC，也不返回 `updatedAt`。
- 官方信号：`grep -c "session_info_update\|SessionInfoUpdate"` 在 `server.py` 为 **0**；标题生成 `server.py:3864-3866`。
- 官方不做什么：不生成动态标题；不发 `session_info_update`；不更新时间戳。
- Paseo 适配：Paseo 有 `handleSessionInfoUpdate`，会读 `title` 与 `updatedAt`（配套 `acp-agent.ts:3584-3592`），官方不会触发，所以 Paseo 侧标题只能来自本地推断。
- 适配状态：非官方扩展

### 补59 `session/close`
- 官方做什么：没有。initialize 的 `sessionCapabilities` 只有 `list`／`resume`／`additionalDirectories` 三项（`server.py:2685-2690`），没有 `close`；`server.py` 也没有 `close_session` 实现。
- 官方信号：能力位 `server.py:2685-2690`；`grep -n "close_session"` 无匹配。
- 官方不做什么：不返回成功；不能用它释放会话；释放只能靠 `logout`／断开连接（补21、补31）。
- Paseo 适配：适配器**转发** `session/close`，并在成功时释放技能 token（`proxy.ts:279-283,533-544`）；Paseo 只在能力位存在时调用，官方未声明所以不调用。适配器实现了这条协议形状，官方没有。
- 适配状态：非官方扩展

### 补60 `session/delete`、`session/fork`、其它自定义 RPC
- 官方做什么：没有。`server.py` 只实现 initialize／authenticate／logout／new／load／resume／list／set_mode／set_model／set_config_option／prompt／cancel。
- 官方信号：`grep -n "delete_session\|fork_session"` 无匹配；能力位 `server.py:2679-2708`。
- 官方不做什么：不删除会话；不 fork；不提供 `mcp.acp` 之类扩展路由。
- Paseo 适配：适配器只做通用转发，不合成这些方法；Paseo 不依赖（只按能力位决定是否调用）。
- 适配状态：官方条件不满足

### 补61 客户端 `terminal/*`
- 官方做什么：没有调用。命令在 harness 内执行，官方也不请求客户端开终端、不把命令输出委托给客户端终端。文件工具同理由 harness 或客户端 fs 回调（B C16）执行，与 `terminal/*` 无关。
- 官方信号：`grep -n "terminal/create\|terminal/output\|terminal/wait\|terminal_release"` 在 `server.py` 无匹配；exec 路径 `server.py:5618-5641`、`6263-6266`。
- 官方不做什么：不请求客户端终端；不使用 ACP 的终端能力位。
- Paseo 适配：Paseo 在 `BASE_ACP_CLIENT_CAPABILITIES` 里**声明 `terminal:true`**（配套 `acp-agent.ts:455-461`），官方这一侧永远不消费。
- 适配状态：官方条件不满足

### 补62 全局排队／席位／冷却信号
- 官方做什么：没有 ACP 调度信号。`session/new` 与 `session/prompt` 都不发排队位置、席位、冷却或启动延迟；`session/cancel` 只取消当前 turn（B I08）。
- 官方信号：`server.py:3631-3757`（new）、`5499-5834`（prompt）、`3759-3772`（cancel）三处都没有调度类发送点。
- 官方不做什么：不保证跨会话并发额度；不告诉客户端「被排队」或「还要等多久」。
- Paseo 适配：适配器 HEAD 与工作树都**已删除**全局 Admission；独立会话直接派发，只保留「同一 session 拒绝重叠 prompt」的本地保护（`proxy.ts:352` 抛 `session already has an active prompt`）。这条是官方负空间，不构成恢复排队的理由。
- 适配状态：官方条件不满足

---

## 12. 统计

### 12.1 分组条数

| 分组 | 条目 | 条数 |
|---|---|---|
| §3 初始化与能力位 | 补01–补11 | 11 |
| §4 认证条件链 | 补12–补23 | 12 |
| §5 会话 RPC | 补24–补34 | 11 |
| §6 输入块 | 补35–补43 | 9 |
| §7 输出事件 | 补44–补50 | 7 |
| §8 权限选项不对称 | 补51–补52 | 2 |
| §9 命令面 | 补53–补54 | 2 |
| §10 终态 | 补55 | 1 |
| §11 官方负空间 | 补56–补62 | 7 |
| **合计** | 补01–补62 | **62** |

### 12.2 状态分布（逐条核对，以本节为准）

| 状态 | 条数 | 条目 |
|---|---|---|
| 已对齐 | 31 | 补01、02、04、06、07、16、19、24、25、26、27、29、30、31、32、34、35、36、40、41、42、43、44、46、47、48、49、51、52、53、54 |
| 有缺口 | 17 | 补03、05、08、09、12、13、14、15、18、20、21、22、28、33、37、38、39 |
| 已知差异 | 5 | 补10、11、45、50、55 |
| 官方条件不满足 | 5 | 补17、23、60、61、62 |
| 非官方扩展 | 4 | 补56、57、58、59 |
| **合计** | **62** | |

交叉核对：正文 `### 补NN` 标题 62 个，`- 适配状态：` 62 行，两数列举相加 62，无未标注条目。

「有缺口」里 6 条（补03、12、13、14、21、22）全部是同一根因：**Paseo 没有认证 UI，也不发
`authenticate`／`logout`**。这条根因一并解释了 B 第一份里 K03（企业管控）、K04（gateway）、
H01–H08（浏览器）为何整族不可达，不是八处独立缺口。

「已知差异」5 条（补10、11、45、50、55）都是**适配器有意补偿**：系统提示改逐轮前置、
`agentInfo` 改写、操作性文本只标记系统封套、拒绝空成功轮次。这些是 Paseo 侧实现，不应当计入
官方能力验收。

## 13. 我没有确认、因而不写进正文的点

1. **JSON-RPC 路由名。** `server.py` 里没有路由字符串；`session/new`、`session/load` 这些名字来自 ACP v1 与注释，不是我抓到的字面量。若 SDK 注册名有偏差（尤其 `set_model` 的 unstable 前缀），本文与席 A 会一起错。
2. **`BuiltinSlashCommandName` 的完整枚举。** 1.5.0 实测发布出来的是 `plan`／`logout`／`usage`（`/tmp/agy-c13-c41.yFi4LTTz/results.json`），但枚举全量未展开，本文不宣称只有三条。
3. **`session/list` 的 `nextCursor` 是否真的不在 wire 上。** `server.py:3883-3885` 只构造 `sessions`，我据此写「不返回 cursor」，没有抓包。
4. **`session/close`、`delete`、`fork` 等未实现方法的实际错误码。** 依赖 SDK 默认路由，通常 `-32601`，我没有实测。
5. **`authenticate` 除 `logged_out` 之外的 `data` 形状。** 只确认了 `data.reason="logged_out"` 这一处，其它认证错误是否带 `data` 未逐条确认。
6. **OAuth 登录的交互细节。** `PAR/oauth/`、`macos_keychain.py`、`credential_manager.py` 我只看了文件存在与 `server.py` 的调用点，没读实现；补23 的「浏览器回调走本机」是从 `server.py:3047-3051` 的注释推的，不是读代码得出的端口与回调路径。
7. **`manage_task` 工具本身的参数契约。** 我只从 `server.py:6175-6213` 看到它被当作 `Action="kill"` + `TaskId="task-<n>"` 解析，工具自身的 schema 在 SDK 里，未读。
8. **后台 exec 的终态由谁触发。** 补48 只写「后续步骤完成时再发终态」，具体是 harness 主动推还是 SDK 在下一轮吐 step，我没有确认。
9. **`_retag_unsupported_document_mime` 的具体改写规则。** 读了它的调用位置与意图注释，没逐行读映射表。
10. **`overlayProductIdentity` 覆盖后的实际取值。** 我只读了 `identity.ts:3-16` 的形状与 `proxy.ts:515` 的调用；线上 Paseo 实际看到的产品名未在真实会话里核对。
11. **Paseo 侧对 `session/load` 历史的时间线归并质量。** 我只读到 `replayingHistory` 分支存在，没读它如何避免与实时事件交错。
12. **生产旧客户端行为。** 与席 A 同：本轮未切换，所有「生产」判断只表示「本轮的改动没进生产」，不是对生产行为的实测。
13. **配额与 tier 在真实账号上的取值。** 本文只写协议形状（`name`／`id`／`upgradeUri`），没写任何真实 tier 名或配额数字。
