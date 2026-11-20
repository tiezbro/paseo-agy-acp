# 席 A 对席 B 的补充：运行面有、协议面 A 稿没有的能力

这是调研席 A 对席 B `2026-11-19-official-capability-catalog-b.md` 的补充，不是合并稿，不是验收证书。A 稿 `2026-11-19-official-capability-catalog-a.md` 已写的条目这里不重复；这里只收 B 稿有、A 稿没有的运行面能力，以及用户点名的 `policy.safe_defaults` 叠加、`AdminControls.allowed_models`、计划重试日志边界、SDK 默认工具表与 `safe_defaults` 具体允许项。

版本与边界沿用 A 稿：官方 `antigravity-acp` 1.5.0，`/tmp/agy150/src/server.py` SHA-256 `c4a5909af7ba15079309a67012014d071c608ac920ab229f3a2344f21383e4fb`。B 稿引用的运行时模块存在于对照副本的 `PAR/`；本文引用 `/tmp/agy-audit-57c8.MDpA52/par-source/google3/.../acp_server/` 下的同哈希解包。SDK 的 `policy.py` 与 `types.py` 不在 `PAR/acp_server/`，本轮从同一 1.5.0 release 的 runfiles 读到：

- `R/google3/third_party/py/google/antigravity/hooks/policy.py`
- `R/google3/third_party/py/google/antigravity/types.py`

其中 `R=/tmp/agy-audit-57c8.MDpA52/state/releases/1.5.0-8a35f63dd228-compat-v1-ea865a786680-aad1b9cfe5d0/agy_acp_server.runfiles/`。这两份文件补上了 B 稿文末「SDK 默认工具表」和「safe_defaults 具体允许项」的缺口；下文直接写确认结果，不再把它们留在未确认。

状态只用五个：已对齐、有缺口、已知差异、官方条件不满足、非官方扩展。

适配器仓与配套仓的 HEAD/工作树状态同 A 稿：适配器 HEAD `3443b97`、工作树有未提交改动；配套 HEAD `b9726d2`、工作树有未提交改动；生产旧客户端未切换、未核实。

---

## 一、`policy.safe_defaults` 之上的叠加规则

### A-S01 `policy.safe_defaults` 的基线允许项
官方名称：`safe_defaults`
- 官方做什么：`safe_defaults(handler)` 先生成 `BuiltinTools.read_only()` 与 `BuiltinTools.deprecated()` 的逐项 `allow`，再加一条 `ask_user("*", handler=handler)` 通配。因此基线明确允许的是 `view_file`、`read_url_content`、`schedule`、`finish`（read-only 四项）以及 `list_directory`、`search_directory`、`find_file`（deprecated 三项）；其余工具落到通配询问。
- 官方信号：`R/google3/third_party/py/google/antigravity/hooks/policy.py:464-480`；`R/.../google/antigravity/types.py:564-603,653-681`；`server.py:4384` 调用 `policy.safe_defaults(handler)`。
- 官方不做什么：不在基线里允许 `create_file`、`edit_file`、`run_command`、`ask_question`、`invoke_subagent`、`run_workflow`、`generate_image`、`search_web`；这些走 `ask_user("*")`。也不把 `list_directory`/`search_directory`/`find_file` 放进模型可见的默认工具集（`default()` 已排除它们），但策略层仍允许它们，供 `enabledTools` 显式开启时使用。
- Paseo 适配：适配器不改写 `policies`；Paseo 只会看到官方由此产生的 `session/request_permission`。适配 HEAD=WT。
- 适配状态：已对齐

### A-S02 政策优先级：具体拒绝 > 具体询问 > 具体允许 > 通配
官方名称：policy precedence
- 官方做什么：五个优先级桶依次为 Specific Deny > Specific Ask > Specific Allow > Wildcard Deny > Wildcard Ask > Wildcard Allow；同一桶内先匹配先返回。`enforce()` 的排序键先按工具目标范围（具体 0、server/* 1、全局 * 2），再按决策（DENY 0、ASK_USER 1、APPROVE 2）。这就是 `ask_question` 的具体 allow 能压过 `ask_user("*")`、`read_url_content` 的具体 ask 能压过 `safe_defaults` 的具体 allow 的机制。
- 官方信号：`R/.../google/antigravity/hooks/policy.py:19-31`；`R/.../google/antigravity/hooks/policy.py:934-942`；`server.py:4385-4418` 的注释。
- 官方不做什么：不按列表书写顺序决定优先级；不让通配规则压过具体规则；不把 `ask` 当 `deny`。
- Paseo 适配：适配器不重排、不改写 `policies`；Paseo 只消费最终 permission 请求。适配 HEAD=WT。
- 适配状态：已对齐

### A-S03 `ask_question` 的 allow 覆盖
官方名称：`ask_question` policy override
- 官方做什么：`safe_defaults` 的 `ask_user("*")` 会先把 `ask_question` 预拦成「Run ask_question?」；官方在策略表头插入具体 `policy.allow("ask_question")`，让用户回答本身成为确认，避免双重询问。只有 `ask_question` 未被 `enabledTools`/`disabledTools` 禁用时才插入。
- 官方信号：`server.py:4385-4398`；`R/.../google/antigravity/types.py:501-681` 的 `ASK_QUESTION` 常量；`PAR/tools.py` 不参与该策略。
- 官方不做什么：不为 `ask_question` 再发一次 permission 预拦；不改变问答本身的 dummy `tool_call` + `request_permission` 形状（A 稿 R08 已记）。
- Paseo 适配：A 稿 R08 已记问答协议形状；本条只补 `safe_defaults` 预拦被 allow 覆盖。适配器透传，Paseo 只看到真正的问题 permission。适配 HEAD=WT。
- 适配状态：已对齐

### A-S04 `read_url_content` 的 ask 覆盖
官方名称：`read_url_content` policy override
- 官方做什么：`read_url_content` 被 `BuiltinTools.read_only()` 归类为只读，`safe_defaults` 会给它具体 `allow`，默认无提示。官方在其上插入具体 `ask_user("read_url_content")`，理由是把任意 URL 的内容拉进上下文是提示注入面，应与 `search_web` 同级确认。具体 ask 压过具体 allow，列表顺序不影响结果。
- 官方信号：`server.py:4399-4418`；`R/.../google/antigravity/types.py:564-573`；`R/.../google/antigravity/hooks/policy.py:19-31`。
- 官方不做什么：不禁用 `read_url_content`（除非 gateway 路由要求，A 稿未覆盖该 gateway 分支）；不按 URL 来源区分；不把 `search_web` 的询问改成允许。
- Paseo 适配：适配器不改策略；Paseo 会收到该工具的实际 permission 请求。适配 HEAD=WT。
- 适配状态：已对齐

### A-S05 非管理员的 `view_file` 边界
官方名称：`view_file` scope policy
- 官方做什么：非管理员会话在 `safe_defaults` 之上前置一条 `_view_file_scope_policy(allowed_dirs)`，用具体 `deny("view_file", when=outside)` 把原生 `view_file` 限制在 `allowed_dirs` 内。`allowed_dirs` 为 cwd、additionalDirectories、`GEMINI_HOME`、技能目录；保留这条是因为 harness 内建 containment 还会额外放行系统临时目录与 memory 路径。
- 官方信号：`server.py:519-546`；`server.py:4331-4335`；`server.py:4431-4437`。
- 官方不做什么：不在管理员会话套用这条（管理员边界由下面的文件访问策略承担）；不阻止工作区内读取；不对无路径调用报错。
- Paseo 适配：适配器不改策略；Paseo 只消费 permission/工具结果。适配 HEAD=WT。
- 适配状态：已对齐

### A-S06 管理员的 outside-workspace 文件策略
官方名称：outside-workspace file access policy
- 官方做什么：企业路径按 `outside_workspace_file_access_policy` 生成两套规则：对 14 个命名文件工具各挂 `deny` 与 `ask_user`（谓词实时读管理端值，改策略不必重建 agent），再对 `"*"` 挂一条通配 `deny`/`ask_user`，覆盖 MCP 文件工具与 exec 命令。`DENY` 阻止，`ALWAYS_ASK` 每次询问，`NOT_ENFORCED` 不限制；`UNSPECIFIED` 归一化为 `DENY`。管理员会话不再挂 `_view_file_scope_policy`，并关闭 harness 内建 workspace containment，让这套策略成为权威。
- 官方信号：`server.py:347-372`（14 个工具与注释）；`server.py:1967-2048`（`_build_file_access_policies`）；`server.py:4423-4437`；`server.py:4692-4693`（`disable_builtin_workspace_containment` 与 `workspaces`）。
- 官方不做什么：不对工作区内调用加限制；不把策略做成一次性的（实时读值）；不依赖 SDK `file_tools()`（它漏掉 list/search/find）。
- Paseo 适配：该分支只在已解析企业许可证的 `oauth-business` 会话生效；Paseo 当前没有企业策略入口，官方不会走到。适配 HEAD=WT。
- 适配状态：官方条件不满足

### A-S07 exec 的越界判定是命令 token 扫描
官方名称：exec outside-workspace detection
- 官方做什么：`run_command`/`shell` 的目标路径藏在 `CommandLine` 字符串里，官方用 `shlex.split` 拆 token，跳过 `argv[0]`，只检查参数；绝对路径、`~`/`$HOME` 展开、相对路径按 `Cwd`（回退 workspace）解析，再与所有 root 比较。`--flag=value` 会检查 `=` 后的值，裸 `-flag` 跳过。无法解析时 fail-open 返回 False。
- 官方信号：`server.py:564-626`；`server.py:628-662`；`server.py:664-741`；`server.py:1967-2048` 的调用侧。
- 官方不做什么：不把命令二进制 `argv[0]` 当文件访问；不声称完备，注释明确 env 间接、`sh -c`、编码等可绕过；不让静态扫描替代终端复核或 OS 沙箱。
- Paseo 适配：该判定只在管理员 outside-workspace 策略里被调用；Paseo 无企业分支。适配 HEAD=WT。
- 适配状态：官方条件不满足

### A-S08 浏览器 `evaluate_script` 的复核叠加
官方名称：`chrome_devtools/evaluate_script` policy
- 官方做什么：企业浏览器只对唯一一个任意 JS 工具 `evaluate_script` 应用 `javascript_execution_policy`：`DISABLED` 从 MCP 工具面剔除；`REQUEST_REVIEW` 保留工具但在策略表头插 `ask_user("chrome_devtools/evaluate_script", handler)`，压过 `safe_defaults` 的只读 allow；`NOT_ENFORCED` 不加规则。`UNSPECIFIED` 归一化为 `DISABLED`。其它浏览器工具不受这条策略管。
- 官方信号：`server.py:4492-4504`；`PAR/browser_subagent.py:46-50,158-180,227-243,276-283`；`PAR/admin_controls_manager.py` 的 JS policy 归一化。
- 官方不做什么：不把策略做成 `enabledTools`（`DISABLED` 走 MCP 的 `disabled_tools`）；不审计 navigate/click/screenshot/DOM/网络读；不在非企业路径注入浏览器。
- Paseo 适配：A 稿 R12 已记浏览器子代理总体；本条只补 `evaluate_script` 的 policy 叠加。Paseo 侧不触发企业浏览器。适配 HEAD=WT。
- 适配状态：官方条件不满足

---

## 二、AdminControls 与执行面

### A-D01 `AdminControls.allowed_models` 已解析但 `server.py` 零调用
官方名称：`allowed_models`
- 官方做什么：`fetch_config` 把顶层 `allowedModels` 解析成 `tuple[str, ...]`，`AdminControls.is_model_allowed()` 与 `AdminControlsManager.is_model_allowed()` 都实现，支持把 `projects/.../models/xxx` 归一化成最后一段再与 ACP model id / base model id 比对，空元组表示全部允许。**但 1.5.0 的 `server.py` 没有任何地方调用 `is_model_allowed`，也没有任何地方读 `allowed_models`。**
- 官方信号：`PAR/admin_controls_manager.py:120-137`（归一化）；`PAR/admin_controls_manager.py:338-360`（解析）；`PAR/admin_controls_manager.py:370-395`（`AdminControls.is_model_allowed`）；`PAR/admin_controls_manager.py:815-828`（管理器版）；`server.py` 全文无 `allowed_models`/`is_model_allowed` 命中。
- 官方不做什么：不按允许列表过滤 `configOptions`；不拒绝不在列表里的模型切换；不把该策略传给 harness。这是官方自身未接线，不是 Paseo 的缺口。
- Paseo 适配：Paseo 不读企业策略；适配器透传官方目录。适配 HEAD=WT。
- 适配状态：官方条件不满足

### A-D02 Admin controls 的适用门与 Safe Defaults
官方名称：AdminControls
- 官方做什么：只有 `oauth-business` 且业务认证管理器同时持有 `user_tier`、`project`、`location` 时，AdminControls 才适用。初始 `FetchConfig` 遇 5xx/408/429 或纯网络错误时回落 `AdminControls.safe_defaults()`（MCP 禁用、终端要求复核、工作区外访问 always ask、沙箱关、浏览器关、JS 关、allowed_models 与 mcp_allowlist 为空）；遇 401/403、其它 4xx、token/许可失败时阻断会话创建。
- 官方信号：`PAR/admin_controls_manager.py:719-736`（适用门）；`PAR/admin_controls_manager.py:292-320`（Safe Defaults）；`PAR/admin_controls_manager.py:741-805`（阻断 vs 回落）；`server.py:3660` 的初始化调用。
- 官方不做什么：不在非 entitlement 会话上套用；不把 `allowed_models` 的缺省当“全禁”（空 tuple 是全允许）；不在 transient 失败时阻断会话。
- Paseo 适配：Paseo 无企业 entitlement 分支，官方不会进入。适配 HEAD=WT。
- 适配状态：官方条件不满足

### A-D03 `-32001` 管理员策略校验错误
官方名称：`-32001`
- 官方做什么：企业管理员策略无法验证时返回 `-32001`；401/403 映射为 `admin_controls_permission_denied`，其它非 transient 4xx 映射为 `admin_controls_verification_failed`，`data.reason` 对应两个原因之一。消息里带项目名，便于用户找管理员。
- 官方信号：`PAR/admin_controls_manager.py:82-92`；`PAR/admin_controls_manager.py:1006-1040`；`server.py:3660` 的初始化路径。
- 官方不做什么：不复用 `-32000` 认证错误；不在 transient 失败时发 `-32001`（走 Safe Defaults）；不把 IAM 详情塞进数据字段。
- Paseo 适配：适配器透传错误码与 `data`；Paseo 的 `summarizeACPRequestError` 会保留 code/message/data 摘要，但没有企业策略 UI。适配 HEAD=WT。
- 适配状态：官方条件不满足

### A-D04 OS 沙箱（exebox）探测与前向传递
官方名称：exebox / `RunCommandConfig.enable_sandbox`
- 官方做什么：macOS（Seatbelt）与 Windows 视为支持；Linux 探测 `/proc/sys/kernel/unprivileged_userns_clone` 与 `/proc/sys/user/max_user_namespaces`，任一为 0 则不支持。仅企业会话、`sandbox_mode` 开且主机支持时，把 `enable_sandbox=True` 传给 harness。`PROCEED_IN_SANDBOX` 在沙箱不可用时回落为逐条复核，不降级成无沙箱放行。
- 官方信号：`PAR/terminal_sandbox.py:32-119`（探测与 review 回落）；`PAR/terminal_sandbox.py:121-176`（sandbox active / auto proceed）；`server.py:4563-4573`（`RunCommandConfig(enable_sandbox=...)`）。
- 官方不做什么：不在非企业路径启用沙箱；不把沙箱当权限替代（权限与沙箱是两个独立开关）；不在 Linux 未探测到 user namespace 时假设可用。
- Paseo 适配：该分支只在企业 entitlement 可达，Paseo 不触发。适配 HEAD=WT。
- 适配状态：官方条件不满足

---

## 三、工具与 MCP

### A-T01 `BuiltinTools.default()` 的确切成员表
官方名称：`BuiltinTools.default()`
- 官方做什么：枚举全部 `BuiltinTools`（`list_directory`、`search_directory`、`find_file`、`view_file`、`create_file`、`edit_file`、`run_command`、`ask_question`、`invoke_subagent`、`run_workflow`、`generate_image`、`search_web`、`read_url_content`、`schedule`、`finish`），排除 `ASK_QUESTION` 与三个 deprecated 工具（`list_directory`/`search_directory`/`find_file`）。因此默认集为 `view_file`、`create_file`、`edit_file`、`run_command`、`invoke_subagent`、`run_workflow`、`generate_image`、`search_web`、`read_url_content`、`schedule`、`finish`。
- 官方信号：`R/.../google/antigravity/types.py:501-681`；`server.py:4555-4568` 用 `default()` 反推 `enabled_tools`，再补 `ASK_QUESTION`。
- 官方不做什么：不把 `ask_question` 放进 `default()`；不把 deprecated 三项放进默认集；不使用 `disabled_tools` 字段（`enabled_tools` 与它互斥）。
- Paseo 适配：适配器不改工具表；Paseo 不传工具过滤时得到上述默认集 + `ask_question`。适配 HEAD=WT。
- 适配状态：已对齐

### A-T02 `enabledTools` / `disabledTools`
官方名称：tool filter
- 官方做什么：从 `_meta.antigravity` 读（旧客户端 `_meta.agy` 只兼容这两个键）。`enabledTools` 是允许列表，不在其中的内建工具全禁用，`[]` 全禁；`disabledTools` 是拒绝列表，与允许列表同时存在时做减法；省略字段表示“无意见”并保留服务端默认；已持久化过滤用 `{"disabledTools": []}` 清除。只作用于 AGY 内建工具，不管 `client_*` 与 MCP 工具。
- 官方信号：`PAR/tool_filter.py:56-165`；`PAR/request_meta.py:23-49`；`server.py:3680`、`3981-3994`。
- 官方不做什么：不读 `enabled_tools` 等下划线拼写；不对 MCP/客户端工具生效；不在未知名字上猜。
- Paseo 适配：适配器不改写这两个键（`context.ts` 只额外合并 `systemPrompt.append`）；Paseo Provider 设置页原样保存 `_meta`。适配 HEAD=WT。
- 适配状态：已对齐

### A-T03 工具名匹配契约
官方名称：builtin tool name matching
- 官方做什么：只接受 `BuiltinTools` 的值（`run_command`、`view_file`、`create_file`、`edit_file`、`list_directory`、`search_directory`、`find_file`、`ask_question`、`invoke_subagent`、`run_workflow`、`generate_image`、`search_web`、`read_url_content`、`schedule`、`finish`），仅容忍首尾空白；`RUN_COMMAND` 枚举名不认；未知名字记 warning 后跳过。
- 官方信号：`PAR/tool_filter.py:25-53`；`PAR/tool_filter.py:137-165`。
- 官方不做什么：不做大小写折叠、别名、前缀匹配；不把 MCP 工具名当内建工具。
- Paseo 适配：适配器不翻译工具名；Paseo 侧发什么名字由 Paseo 决定。适配 HEAD=WT。
- 适配状态：已对齐

### A-T04 客户端 `view_file` 的输出格式与限额
官方名称：`view_file` output
- 官方做什么：输出前加固定前言（每行前带 `<行号>: `，改原文件时要删掉行号、冒号和前导空格）；正文按 800 行与 45 KiB 双限额裁剪；单文件上限 100 MiB；超限给“不是完整文件”的说明；超长行另给截断说明；二进制拒绝并提示磁盘上的图片/PDF/音视频可用内建 `view_file`。
- 官方信号：`PAR/tools.py:74-121`；`PAR/tools.py:176-303`；`PAR/tools.py:305-557` 的客户端工具实现。
- 官方不做什么：不返回不带行号的裸内容；不在一次调用里返回超限内容；不把二进制当文本。
- Paseo 适配：适配器透传；Paseo 只显示 `raw_output` 文本。适配 HEAD=WT。
- 适配状态：已对齐

### A-T05 拒绝把行号抄回文件
官方名称：copied line-number rejection
- 官方做什么：`client_create_file`/`client_edit_file` 等写入前检测内容是否带 `<数字>:` 前缀；当至少 80% 的非空行、且至少 3 行带递增行号时，拒绝并提示删掉行号、冒号和前导空格，避免把 `view_file` 输出原样写回。
- 官方信号：`PAR/tools.py:98`（前缀正则）；`PAR/tools.py:125-160`（`_reject_copied_line_numbers`）；`PAR/tools.py:421-557` 的写入工具。
- 官方不做什么：不静默剥离行号；不把它当成功；不误伤 YAML 整数键（要求行号递增且步长 1 占多数）。
- Paseo 适配：适配器透传；Paseo 只显示工具结果。适配 HEAD=WT。
- 适配状态：已对齐

### A-T06 `start_subagent` 与工具过滤的耦合
官方名称：`invoke_subagent` / `start_subagent`
- 官方做什么：`start_subagent`（真实枚举名 `invoke_subagent`，`start_subagent` 是 deprecated alias）被过滤掉时 `enable_subagents=False`；浏览器子 agent 因此也不注入，即使企业 admin 打开了浏览器。
- 官方信号：`server.py:4445-4458`；`server.py:4566-4572`；`server.py:4528-4531`；`R/.../google/antigravity/types.py:501-560,653-681`。
- 官方不做什么：不在子 agent 被禁时保留浏览器的半套能力；不把 deprecated alias 当独立工具。
- Paseo 适配：适配器透传工具过滤；Paseo 不特别处理子 agent。适配 HEAD=WT。
- 适配状态：已对齐

### A-T07 `eagerMcpServers` 与 `forceAllToolsEager`
官方名称：`eagerMcpServers` / `forceAllToolsEager`
- 官方做什么：两种粒度——会话级 `_meta.antigravity.eagerMcpServers`（ACP v1 客户端用）与单条 `_meta.antigravity.forceAllToolsEager=true`（ACP v2 客户端用）。命中即 `force_all_tools_eager=True`，工具直接进 prompt，而不是走 `call_mcp_tool` + 磁盘 schema。eager 名单不持久化，load/resume 由客户端重发。
- 官方信号：`PAR/mcp_servers.py:27-34,90-131`；`server.py:3681-3684`、`3995-3999`。
- 官方不做什么：不持久化 eager 名单；不提供工具级 eager（TODO 里说明长期方向）；不把 eager 当权限许可。
- Paseo 适配：适配器不改写 `_meta`；Paseo Provider 设置页原样保存。适配 HEAD=WT。
- 适配状态：已对齐

### A-T08 `mcpMaxOutputBytes`
官方名称：`mcpMaxOutputBytes`
- 官方做什么：会话级 `_meta.antigravity.mcpMaxOutputBytes` 必须是正整数（bool 与非正整数记 warning 后忽略），经 `CapabilitiesConfig.mcp_max_output_bytes` 传给 harness；`None` 保持 harness 默认（文档为 4096 字节）。
- 官方信号：`PAR/mcp_servers.py:35,133-158`；`server.py:4563-4565`。
- 官方不做什么：不对单条服务器生效；不把非法值当 0；不保证 harness 一定按该值截断（传参点可确认，harness 行为未展开）。
- Paseo 适配：适配器透传 `_meta`；Paseo 设置页可保存。适配 HEAD=WT。
- 适配状态：已对齐

### A-T09 MCP 加载失败的用户文案
官方名称：MCP load failure message
- 官方做什么：从异常文本识别 `MCP load failed for <name>: <reason>`，抽出服务器名与原因，折叠 Go 多层错误的换行与 ` : `，生成纯文本（非 markdown）：“The MCP server '<name>' failed to initialize: <reason>. Fix the MCP server, or remove it from your configuration and start a new session, to continue.” 这是终态文案链里优先于通用 API 错误的一档。
- 官方信号：`PAR/mcp_errors.py:53-95`；`server.py:5747-5757` 的文案选择链。
- 官方不做什么：不重试加载；不自动移除出错的 server；不把非 MCP 错误套用这段文案。
- Paseo 适配：适配器透传该普通 `agent_message_chunk`；Paseo 当正文显示。适配 HEAD=WT。
- 适配状态：已对齐

---

## 四、模型目录

### A-M01 内置静态模型目录（7 族）
官方名称：built-in model catalog
- 官方做什么：`DEFAULT_MODEL_METADATA_MAP` 固定 7 族：`gemini-4-carbon`（Medium/High/Low，Agent Platform only）、`gemini-4-argon`（High/Medium/Low，Agent Platform only）、`gemini-3.8-flash`、`gemini-3.7-flash`、`gemini-3.6-flash`、`gemini-3.5-flash`（均 High/Medium/Low）、`gemini-3.1-pro`（High/Low，base `gemini-3.1-pro-preview`）。每族第一个变体是该族默认；被淘汰的 id 仍留在表里，供恢复会话的持久化 id 使用。
- 官方信号：`PAR/model_selection.py:60-195`；`server.py:3481-3520`。
- 官方不做什么：不按 `max_tokens` 排序；不改写族顺序；不隐藏已淘汰但仍在表里的 id。
- Paseo 适配：适配器不改模型表；Paseo 只渲染 `configOptions`。适配 HEAD=WT。
- 适配状态：已对齐

### A-M02 Agent Platform 专属模型与 API key 过滤
官方名称：`agent_platform_only`
- 官方做什么：`gemini-4-carbon`、`gemini-4-argon` 只在 Agent Platform 路径进入列表；`DEFAULT_MODEL_LIST` 过滤掉这两个族。API key 路径默认 `gemini-3.8-flash-high`，Agent Platform 默认 `gemini-4-carbon-medium`；`AGY_ACP_DEFAULT_MODEL` 可覆盖默认值，且不校验值是否在表内。
- 官方信号：`PAR/model_selection.py:126-141,180-195,313-328`；`server.py:3481-3520`。
- 官方不做什么：不在 Gemini Developer API/API key 路径提供这两个族；不因客户端请求就开放；不在 initialize 公布默认模型。
- Paseo 适配：Paseo 无 Agent Platform 认证入口；该分支在 Paseo 上不可达。适配 HEAD=WT。
- 适配状态：官方条件不满足

### A-M03 CCPA 目录的顺序、disabled 与旧档位解析
官方名称：CCPA model catalog
- 官方做什么：按 `agentModelSorts[].groups[].modelIds[]` 顺序展平去重（模型可出现在多个 sort/group，取第一次位置）；`models` 缺详情的跳过并告警；`disabled` 的跳过并记日志（列出但本套餐不可用，发出去会 404）。档位先查 `_CCPA_LEGACY_VARIANTS` 5 条旧 id，再按尾部 `-<level>`（可带 `-effort`）解析；显示名去掉尾部 ` (<level>)` 或 ` (<level> thinking)`。
- 官方信号：`PAR/model_selection.py:206-311,349-408`。
- 官方不做什么：不重排（`agentModelSorts` 是策划过的优先级）；不猜缺失条目；不把 disabled 降级显示。
- Paseo 适配：适配器透传；Paseo 只消费目录。适配 HEAD=WT。
- 适配状态：已对齐

### A-M04 按认证方式换绑的图像模型
官方名称：image model target
- 官方做什么：每会话除文本 target 外固定挂一个 IMAGE target：OAuth 用 `gemini-3.1-flash-image`，企业用 `gemini-3-pro-image`，其余路径用 SDK 默认；图像模型不列入 `configOptions`，只由 `generate_image` 工具使用。
- 官方信号：`server.py:1177-1182`；`server.py:4197-4207`；`server.py:4700-4760`。
- 官方不做什么：不让用户选图像模型；不把图像 target 显示成文本模型。
- Paseo 适配：适配器透传；Paseo 只可能看到 `generate_image` 的工具调用与输出。适配 HEAD=WT。
- 适配状态：已对齐

### A-M05 网关模型目录
官方名称：gateway model catalog
- 官方做什么：`AGY_LLM_GATEWAY_MODELS` 优先，除非 `admin_settings.json` 设了 `models.list`/`models.listSource`；否则走四层 `model_discovery.get_model_catalog`。allowlist 里内置 id 保留元数据、基础 id 展开成全部变体、其余作为 custom 模型（受 `MAX_CUSTOM_MODELS` 限制）。gateway 会话刻意不走 `_finalize_model_state` 的自补逻辑，避免保留企业已撤回的模型。
- 官方信号：`PAR/model_selection.py:488-630`；`server.py:4666-4700`（gateway auth 分支）。
- 官方不做什么：不在 gateway 路径调用 CCPA；不允许会话保留被撤回模型；不把 gateway 目录与 CCPA 目录合并。
- Paseo 适配：Paseo 不设置 `auth.type=gateway`，也不读 `admin_settings.json`；官方不会进入。适配 HEAD=WT。
- 适配状态：官方条件不满足

---

## 五、技能、hooks、重试与错误

### A-K01 官方技能发现路径
官方名称：skills paths
- 官方做什么：`resolve_skills_paths()` 固定顺序返回 `<GEMINI_HOME>/config/skills`、项目 `.gemini/skills`、`<GEMINI_HOME>/antigravity-cli/skills`、项目 `.agents/skills/`；项目项对 `cwd` 与每个 `additionalDirectories` 各展开一次。两个全局目录跟随解析后的 `GEMINI_HOME`，不是 `$HOME`。
- 官方信号：`server.py:1468-1510`；`PAR/paths.py:176-195`；`server.py:4297`。
- 官方不做什么：不扫描 `.paseo/skills`、`.codex/skills`、`.claude/skills`；不递归子目录；不读 `skills.json` 声明；不发技能列表通知。
- Paseo 适配：官方 5 组路径由官方自己消费；适配器另扫 Paseo/Codex/Claude 目录只用于追加斜杠命令（`skill-commands.ts:108-243`），两套机制互不替代。适配 HEAD=WT。
- 适配状态：已对齐

### A-K02 技能目录进入 `allowed_dirs` 与 hooks 的 workspace paths
官方名称：skills allowed dirs
- 官方做什么：`allowed_dirs = [abs_cwd, *additional, abs(GEMINI_HOME), *abs(skills_dirs)]`；`skills_paths` 单独传给 harness；`workspaces` 只含 `[cwd, *additional]`，技能目录不进会话工作区；hooks 的 `workspace_paths` 含技能目录。
- 官方信号：`server.py:4331-4335`；`server.py:4692,4704`；`server.py:4610-4614`。
- 官方不做什么：不把技能目录当写权限边界；不因此扩大 `workspaces`。
- Paseo 适配：适配器不改变官方技能路径；Paseo 自己的技能 MCP 是扩展。适配 HEAD=WT。
- 适配状态：已对齐

### A-K03 hook 执行协议与失败即拒绝
官方名称：external hooks
- 官方做什么：`shlex.split` 后 `create_subprocess_exec`，JSON 写 stdin，读 stdout JSON；超时默认 30 秒（handler 可覆盖）；非零退出码、非 dict JSON、执行失败都视为失败。`PreToolUse` 的 `matcher` 是正则（`*`/空=全匹配，非法正则=不匹配）；返回 `allowTool` 或 `decision:"deny"`；**执行失败（None）视同拒绝**并给 “External hook '<name>' failed to execute.”。`PostInvocation` 的 `terminationBehavior=="terminate"` 是唯一能主动结束执行的能力；`injectSteps` 在 Pre/PostInvocation 都被明确忽略。
- 官方信号：`PAR/hooks.py:26-113`；`PAR/hooks.py:116-125`；`PAR/hooks.py:475-573`；`PAR/hooks.py:705-781`；`PAR/hooks.py:821-876`。
- 官方不做什么：不重试 hook；不因 post hook 失败回滚工具；不支持轨迹注入；不把 `ask` 当独立决策（非 deny 即 allow）。
- Paseo 适配：适配器不读写 hooks；官方自己加载执行。Paseo 只会在 hook 触发权限时看到 `request_permission`（A 稿 R13 已记信任询问）。适配 HEAD=WT。
- 适配状态：已对齐

### A-K04 workspace trust 的持久化与环境开关
官方名称：workspace trust
- 官方做什么：只有 `trusted` 才加载工作区 hooks；`unknown` 时用一次 ACP 权限请求问 “Do you trust the authors…”，选项 Trust Workspace / Don't Trust；肯定集合含 `trust/allow/allow_once/allow_always/yes`，否定集合含 `deny/dont_trust/dont trust/don't trust/don't_trust/block/reject/no`；其它（含超时）记为本轮抑制并加入进程内 `_dismissed_workspace_prompts`，不写文件。状态存 `<GEMINI_HOME>/antigravity-acp/trusted_workspaces.json`（`{"trusted":[],"untrusted":[]}`，原子写，损坏时改名备份）；`AGY_ACP_DISABLE_WORKSPACE_TRUST=1|true|yes` 可整体关闭。
- 官方信号：`PAR/workspace_trust.py:17-41,56-227`；`PAR/hooks.py:365-431`。
- 官方不做什么：不在未信任时静默加载；不把“不信任”当永久拒绝；不把全局 hooks 纳入信任。
- Paseo 适配：适配器透传该 permission；Paseo 用户回答 trust/dont_trust。适配 HEAD=WT。
- 适配状态：已对齐

### A-R01 计划重试的唯一日志源与 502 边界
官方名称：model retry scheduled
- 官方做什么：计划重试**没有 ACP 信号**。`local_connection.py` 的 stderr reader 把 harness 每一行原样转成 `logging.info("harness stderr: %s", line)`；harness 的 `planner_generator.go:359` 在决定重试时打印 `Encountered retryable api error. retrying in <duration>`。普通 502 只是 HTTP 失败，不是这条日志，也不是计划重试；重试次数、退避和可重试错误由 harness 默认策略决定。A 稿 N08 已记“没有 ACP 信号”，本条只补唯一信号源与 502 边界。
- 官方信号：`local_connection.py:541-559`（stderr 逐行转发，尤其 `:553`）；`local_connection.py:144-163`（仅当调用方给 `RetryConfig` 才构造 proto）；`local_connection.py:1355-1358`；`server.py` 无重试通知发送点。
- 官方不做什么：不发 `session/update`；不发 JSON-RPC error；不告诉客户端“已计划重试”；不把普通 502 当计划重试。
- Paseo 适配：A 稿 N08 已记适配器工作树解析该日志并发 `model_retry_scheduled`；HEAD 与生产旧客户端无。适配工作树的正则只认 `Encountered retryable api error\. retrying in (?P<delay>…)`（`assets/official-kernel-compat/rc01/paseo_model_compat.py:245-252`）。适配 HEAD≠WT。
- 适配状态：非官方扩展

### A-R02 `RetryConfig` 不由官方 server 注入
官方名称：harness default retry
- 官方做什么：`_create_agent_config` 构造 `LocalAgentConfig`/`ProxyAgentConfig` 时不传 `retry_config`；`ProxyAgentConfig` 只把调用方给的 `self.retry_config` 透传（默认 None）；`build_retry_config_proto` 在空配置时返回 None。因此 harness 使用自己的默认重试策略，ACP server 不覆盖、不暴露。
- 官方信号：`proxy_agent_config.py:132`；`local_connection.py:144-163`；`server.py:4670-4710` 的 `common_args` 无 retry 键。
- 官方不做什么：不覆盖 harness 默认；不把重试参数做成 ACP 选项；不让客户端改重试策略。
- Paseo 适配：适配器工作树只读观察重试决策，不替换策略；HEAD 不观察。适配 HEAD≠WT。
- 适配状态：已对齐

### A-R03 连接断开的“重建并重试一次”
官方名称：connection rebuild retry
- 官方做什么：上一轮致命/取消可能让 localharness 死掉、websocket 以 1000 关闭；下一轮 `agent.chat` 抛裸 `websockets.ConnectionClosed`。官方重建一次 agent（新 harness + 新 websocket，历史从持久化 trajectory 重放）并重试本轮；只允许一次，第二次关闭就发“Agent connection was lost and could not be re-established: …”普通正文并结束本轮，不把裸异常当 `-32603`。
- 官方信号：`server.py:5596-5616`；`server.py:5624-5670`；`server.py:5768-5785`。
- 官方不做什么：不无限重建；不把重建失败暴露成 JSON-RPC error；不丢弃历史。
- Paseo 适配：适配器透传；Paseo 只看到正常重试后的轮次或连接丢失正文。适配 HEAD=WT。
- 适配状态：已对齐

### A-R04 终态异常的四级文案选择链
官方名称：terminal error copy chain
- 官方做什么：SDK 终态异常先记完整异常到日志，再按顺序选文案：浏览器专用 → MCP 加载失败 → 配额耗尽 → 通用 API 净化文案；选中哪条就作为一条普通 `agent_message_chunk` 发给客户端，不是 JSON-RPC error，随后默认 `end_turn`。
- 官方信号：`server.py:5732-5767`；`server.py:5743-5757`；`server.py:5829-5834`；`server.py:1625-1653` 的默认 `end_turn`。
- 官方不做什么：不发 JSON-RPC error；不把原始异常文本（含 `Details: [...]`）直接给客户端；不区分“错误正文”与“模型正文”的通道。
- Paseo 适配：A 稿 E09 已记通道与工作树 fenced terminal state；本条只补四级文案链。适配工作树会抑制 pinned 终止诊断正文，HEAD 只透传。适配 HEAD≠WT。
- 适配状态：已知差异

### A-R05 API 错误的净化规则
官方名称：API error sanitization
- 官方做什么：Go harness 把整段 `google.rpc.Status`（含 `Details: [map[@type:...]]`，可能带内部 `DebugInfo`）塞进异常。官方用正则取 `Error <code>, Message: <msg>, Status: <STATUS>` 的公开 message；没有匹配就剥掉任何 `, Details: [...]` 块再包成 “Agent execution error: …”。唯一例外是 `ErrorInfo` 里后端附带的用户动作链接：`VALIDATION_REQUIRED` 的 `validation_url`、`appeal_url` 且 `uiMessage=="true"`，且只接受 https 且主机为 `google.com` 或其子域。
- 官方信号：`PAR/api_errors.py:32-175`。
- 官方不做什么：不展示非 Google 域链接；不展示 DebugInfo；不翻译错误码；不泄露原始 Details。
- Paseo 适配：适配器透传净化后的文本；Paseo 不再二次净化。适配 HEAD=WT。
- 适配状态：已对齐

### A-R06 配额耗尽的专用文案
官方名称：quota exhausted message
- 官方做什么：针对 `ErrorInfo` 的 `QUOTA_EXHAUSTED` 形状（CCPA 个人配额计量路径；文案选择链本身不按 auth 分支，只有该错误形状会命中）重写文案；按 b/543949364 的措辞（这个界面不做升级推销），尽量解析 `quotaResetDelay`/`quotaResetTimeStamp`（支持 Go duration 字面量如 `119h36m35.41909833s`），生成纯文本 “Usage Limit Reached / You have reached your current quota for this period.”。
- 官方信号：`PAR/ccpa_connection/quota_errors.py:14-66,69-147`；`server.py:5755` 的文案选择链。
- 官方不做什么：不主动对其它认证方式查配额；这段文案只看错误形状，不按 auth 分支；不展示升级链接；不把配额查询失败当 `/usage` 失败。
- Paseo 适配：适配器透传该正文；Paseo 当普通消息显示。适配 HEAD=WT。
- 适配状态：已对齐

---

## 六、仍未确认

1. **Go harness `planner_generator.go:359` 的原文与打印频率**：官方 Python 解包里只能确认 `local_connection.py:541-559` 逐行转发 stderr；`planner_generator.go` 不在解包内。`Encountered retryable api error. retrying in <duration>` 这个模板来自 B 稿引用的 `/tmp/agy-audit-57c8.MDpA52/AUDIT.md` 与适配器工作树的 compat 正则，不是本轮亲眼读到的 Go 源码；也不能确认每个重试计划恰好打印一次。
2. **harness 默认重试策略的具体数值**：能确认 server 不注入 `RetryConfig`（`proxy_agent_config.py:132`、`local_connection.py:144-163`），但 harness 的默认次数、退避、可重试错误集合不在解包内。
3. **`forceAllToolsEager` 在 harness 内的实际效果**：能确认官方把它转成 `force_all_tools_eager=True` 并传给 SDK，但 harness 如何把工具变成 native prompt 工具不在解包内；本轮只确认传参契约。
4. **`mcpMaxOutputBytes` 的 harness 默认值 4096 字节**：来自 `types.py` 的 `CapabilitiesConfig` 文档注释，不是 harness 实现；实际截断行为未核实。

（B 稿文末原先列出的“SDK 默认工具表”和“safe_defaults 具体允许项”已由本轮 `R/.../types.py:501-681` 与 `R/.../hooks/policy.py:464-480` 确认，因此不再留在未确认。B 稿的 `http_code` 也已在 `/tmp/agy150/sdk/event_processor.py:308-311,448-449` 确认存在，不再列入未确认。）
