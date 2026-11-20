# 官方 1.5.0 能力全表 · 调研席 B 独立底稿

> **这是调研席 B 的独立底稿，不是合并稿，不是验收证书。**
> 本文只从官方运行时与 harness 源码逐条取证，另起一路独立成文，未与调研席 A 的
> `2026-11-19-official-capability-catalog-a.md` 交叉合并，也未参与任何签核。
> 文中「已对齐 / 有缺口 / 已知差异」判断只表示「我在源码上看到的适配动作与官方行为的距离」，
> 不代替运行验收。**不得把本文当作 README 直接发布**；进 README 需要另一次合并与复核。

## 0. 版本、哈希、分支、工作树

| 项 | 值 |
|---|---|
| 官方产品 | `antigravity-acp`（`agentInfo.name`）／`Google Antigravity`（`title`） |
| 官方版本 | `1.5.0`（`_version.py:3`） |
| `server.py` SHA-256（运行时） | `c4a5909af7ba15079309a67012014d071c608ac920ab229f3a2344f21383e4fb` ✅ 与要求值一致 |
| `server.py` SHA-256（对照副本） | 同值（`/tmp/agy-audit-57c8.MDpA52/par-source/.../acp_server/server.py`，与运行时 `diff` 相同） |
| `local_connection.py` SHA-256 | `14423f2599693c818207049471a824b2eeef042dbe1946450df3a7080cb9a839`（运行时与 `google3/third_party/.../local/local_connection.py` 同值） |
| `main.py` SHA-256 | `4f423c0907ad2409e92e74201aa1d8e1ad1a09c1ea1776a249ae09d6786273e3`（两侧同值） |
| `proxy_agent_config.py` SHA-256 | `3a7ca6fa8937c67fa27c54f42ce66095687b735898536afc32e0dc970c4ae182`（两侧同值） |
| 适配器仓 | `/home/tiezbro/projects/paseo-agy-acp`，分支 `refactor/official-core-paseo-lightweight`，HEAD `3443b97d232955d90b3db0c7c180fb7fcded9942`；**工作树有未提交改动** |
| 配套仓 | `/home/tiezbro/projects/MAACS-agy-capabilities`，分支 `feat/antigravity-official-capabilities`，HEAD `b9726d2d379956ee38075c28d73ec66fb6f6d985`；**工作树有未提交改动** |
| 运行时解包 | `/tmp/agy150/src/`（`server.py`、`local_connection.py`、`proxy_agent_config.py`、`main.py`）与 `/tmp/agy150/sdk/`（6 个 SDK 侧文件） |
| 对照副本 | `/tmp/agy-audit-57c8.MDpA52/par-source/google3/...`（多出 `model_selection.py`、`client_info.py`、`hooks.py`、`tools.py`、`mcp_servers.py`、`browser_subagent.py`、`api_errors.py`、`usage.py`、`tier_info.py`、`token_usage_tracker.py`、`config_options.py`、`admin_controls_manager.py`、`terminal_sandbox.py`、`workspace_trust.py`、`settings.py` 等） |

取证方法说明（重要，影响行号可信度）：

- `model_selection.py`、`client_info.py`、`config_options.py`、`hooks.py`、`tools.py`、`mcp_servers.py`、`browser_subagent.py`、`api_errors.py`、`usage.py`、`tier_info.py`、`token_usage_tracker.py`、`admin_controls_manager.py`、`terminal_sandbox.py`、`workspace_trust.py`、`paths.py`、`system_prompt.py`、`request_meta.py`、`tool_filter.py`、`logout.py`、`session_store.py`、`settings.py`、`mcp_errors.py`、`ccpa_connection/quota_errors.py` **只存在于对照副本**，运行时目录未解包这些模块。下文引用这些文件的行号来自对照副本。
- `server.py`、`local_connection.py`、`proxy_agent_config.py`、`main.py` 两侧字节相同，行号可互换使用；下文一律用 `/tmp/agy150/src/server.py` 的行号。
- Go harness（`localharness`）、SDK 的 `google.antigravity` 包、`acp` schema 包**不在本次解包范围内**，凡涉及它们的行为，本文只写「源码里能看到的调用点」，不外推其内部实现。

本文的边界（先说清，避免被误读成建议）：

- 名称、顺序、模式、重试、取消由官方决定；本文只记录官方怎么定。
- 文中**不提出**把 Paseo 的 `clientInfo` 冒充成 `zed`／`xcode`／JetBrains 来换第三方模型。
- 文中**不提出**恢复任何全局排队机制。
- 文中**不写修复代码**，也不给补丁建议；只写缺口在哪一行。

---

## A. 模型与思考档

### A01. 内置模型目录（7 个族，按档位展开成具体 model id）
- 官方做什么：用 `_thinking_family()` 把一个族展开成 `<family>-<level>` 的若干具体 id，并给每个 id 挂 `ModelMetadata`（`base_model_id`、`thinking_level`、展示名、描述、`max_tokens`、`family_id`、`family_display_name`、`agent_platform_only`）。族的**书写顺序就是选择器优先级**，每族第一个变体是该族默认。被淘汰的 id 仍留在表里，因为恢复的会话会持久化 ACP model id，表里查不到就会把 id 当模型名直接发给后端。
- 官方信号：`model_selection.py:60-105`（`ModelMetadata`）；`model_selection.py:107-152`（`_thinking_family`、`ThinkingLevel` 名表）；`model_selection.py:119-178`（`DEFAULT_MODEL_METADATA_MAP`，7 族）；`model_selection.py:180-195`（`AGENT_PLATFORM_MODEL_LIST`、`DEFAULT_MODEL_LIST`）。
- 官方不做什么：不做动态发现（API key / Agent Platform 路径纯静态）；不按 `max_tokens` 排序；不隐藏「已淘汰但仍在表里」的 id。
- Paseo 适配：HEAD 与工作树都未改写该表，属于透传（数据来自官方进程，Paseo 只是渲染 `configOptions`）。
- 适配状态：已对齐

### A02. Agent Platform 专属模型
- 官方做什么：`gemini-4-carbon`、`gemini-4-argon` 带 `agent_platform_only=True`，只在 Agent Platform（原 Vertex AI）路径出现在列表里；`DEFAULT_MODEL_LIST` 会过滤掉它们。
- 官方信号：`model_selection.py:126-141`（两族的 `agent_platform_only=True`）；`model_selection.py:190-195`（过滤为 `DEFAULT_MODEL_LIST`）；`model_selection.py:313-328`（`get_default_model_id(agent_platform=True)` → `gemini-4-carbon-medium`）。
- 官方不做什么：不在 Gemini Developer API / API key 路径提供这两个族；不因为客户端请求就开放。
- Paseo 适配：未接（Paseo 侧没有 Agent Platform 认证入口，官方这条分支在 Paseo 上不可达）。
- 适配状态：官方条件不满足

### A03. API key 路径静态模型表
- 官方做什么：`DEFAULT_MODEL_LIST = AGENT_PLATFORM_MODEL_LIST` 去掉 `agent_platform_only` 后的静态列表；`current_model_id` 为空时落到 `get_default_model_id()`（默认 `gemini-3.8-flash-high`）。
- 官方信号：`model_selection.py:190-195`；`model_selection.py:313-328`；调用点 `server.py:3481-3520`、`server.py:1804-1806`。
- 官方不做什么：不发网络请求取模型；不读 CCPA；不受 `clientInfo` 的第三方开关影响（静态表全是 Gemini）。
- Paseo 适配：透传（Paseo 走 API key 时拿到的是静态表）。
- 适配状态：已对齐

### A04. `configOptions.model` 的「族折叠」规则
- 官方做什么：把同一族、且**当前至少有两个变体在列表里**的档位折叠成一个 `model` 条目（值 = `family_id`），并把档位拆到 `thinking_level`；只有一个变体、或族 id 本身也是列表里某个 model id（会让 `model` 值产生歧义）时不折叠，平铺成普通 model 条目。
- 官方信号：`config_options.py:109-158`（`_group_models`，三个不折叠条件）；`config_options.py:170-208`（`_model_option`）；`config_options.py:318-370`（`build_selection_state`，model → 可选 thought_level → mode 的顺序）。
- 官方不做什么：不再重新排序（顺序即官方优先级）；不隐藏同族其它档位的描述。
- Paseo 适配：透传（Paseo 读 `configOptions`，含 `category` 字段）。
- 适配状态：已对齐

### A05. `Thinking Level` 选择器
- 官方做什么：为**当前模型所在族**发一个 `category:"thought_level"` 的 select，`currentValue` 是当前档位，选项顺序 `minimal/low/medium/high/xhigh/extra_high/max`（未知档位排最后）。
- 官方信号：`config_options.py:52-72`（`THINKING_LEVEL_ID`、`_CATEGORY_THOUGHT_LEVEL`、`_LEVEL_ORDER`）；`config_options.py:211-249`（`_thinking_level_option`）；`server.py:3603-3629`（`_thinking_variants`：API key/Agent Platform 用内置表，OAuth 用 CCPA id 解析，gateway 一律不折叠）。
- 官方不做什么：不提供 replace/patch；不把档位做成独立 RPC；gateway 会话不做档位分组（管理端声明的条目必须原样渲染）。
- Paseo 适配：透传（Paseo 把 `configOptions` 原样呈给用户；配套仓工作树有 `acp-official-selection` fixture 覆盖选项面）。
- 适配状态：已对齐

### A06. CCPA 动态目录的取用规则
- 官方做什么：从 `fetchAvailableModels` 的 `agentModelSorts[].groups[].modelIds[]` 按顺序展平去重（模型可出现在多个 sort/group，取第一次位置）；`models` 里缺失详情的跳过并告警；`disabled` 的跳过并记日志（列出来但本套餐不可用，发出去会 404）。
- 官方信号：`model_selection.py:349-408`（`_parse_ccpa_response` 前半：maxTokens 采集、sort 展平、缺失跳过、disabled 跳过）。
- 官方不做什么：不重排（`agentModelSorts` 是策划过的优先级，不是白名单）；不猜缺失条目；不把 disabled 条目降级显示。
- Paseo 适配：透传（目录来自官方进程）。
- 适配状态：已对齐

### A07. CCPA 档位 id 的解析表与显示名剥离
- 官方做什么：先查 `_CCPA_LEGACY_VARIANTS`（`gemini-3.5-flash-extra-low`→low、`gemini-3-flash-agent`→high、`gemini-pro-agent`→high 等 5 条），再按尾部 `-<level>`（可带 `-effort` 后缀）解析；档位名表 `low/medium/high/xhigh/max` → `Low/Medium/High/Extra/Max`；族显示名去掉尾部 ` (<level>)` 或 ` (<level> thinking)`（大小写不敏感）。
- 官方信号：`model_selection.py:206-272`（`_CCPA_LEGACY_VARIANTS`、`_CCPA_LEVEL_NAMES`、`_parse_ccpa_variant`、`_family_display_name`）；`model_selection.py:275-311`（`ccpa_thinking_variants`）。
- 官方不做什么：不按显示名反推档位；不对无法解析的 id 造档位（原样平铺）。
- Paseo 适配：透传。
- 适配状态：已对齐

### A08. 模型切换的取值解析（族 → 具体 id）
- 官方做什么：`model` 值命中族时，保留当前档位（新族有该档就用它），否则取**最近的档位、同距取更高**；从无档位模型过来时取该族第一个变体（即推荐档位）。`thinking_level` 值必须是当前族提供的档位，否则 -32602。具体 model id 原样透传（客户端持久化的旧值仍可用）。
- 官方信号：`config_options.py:376-431`（`resolve_model_id`）；`config_options.py:350-374`（`_nearest_level_model_id`，`min(key=(abs(rank-wanted), -rank))`）；`server.py:2860-2872`（`_resolve_model_value`）。
- 官方不做什么：不模糊匹配族名；不因档位不可用而静默降级到别的族。
- Paseo 适配：透传。
- 适配状态：已对齐

### A09. 模型切换是「延迟重建」，不是同步换绑
- 官方做什么：`set_config_option`/`set_model` 只记录选择并立即返回，真正的 agent 重建发生在下一轮 `prompt` 的 `_maybe_apply_model_switch`；切换前先用会话缓存列表校验，未命中则重新列一次（缓存可能只是失败后的单模型兜底），仍不命中就 -32602 并回传 `availableModels`。
- 官方信号：`server.py:2785-2858`（`_apply_session_model`）；`server.py:2318-2346`（`_maybe_apply_model_switch`）；`server.py:2881-2965`（`set_config_option`，选项改动后返回全量 `configOptions`）。
- 官方不做什么：不在切换时打断正在流式输出的 turn；不在当前轮内换模型。
- Paseo 适配：透传（Paseo 的「切模型」是一次 RPC，重建在下一轮由官方完成）。
- 适配状态：已对齐

### A10. 服务端自动替换失效模型并通知
- 官方做什么：企业轮询发现会话当前模型不在 `available_models` 里时，改到「会话自身解析出的替代值」（CCPA 默认，否则列表第一个），重建 agent，发一条 `config_option_update`（全量），再发一条 `agent_message_chunk` 文案 `<旧 id> is no longer available. Using <新 id>.\n\n`（同一旧模型只提示一次，多会话共享）。
- 官方信号：`server.py:2277-2316`（`_maybe_replace_unavailable_model`）；`server.py:2348-2386`（`_announce_model_replacement`）；`model_selection.py:421-458`（`resolve_replacement`、`replacement_message`、结尾空行的理由：单换行在 markdown 里只是软换行）；`config_options.py:300-316`（`build_config_option_update`）。
- 官方不做什么：不发独立错误；不要求客户端确认；不逐会话重复提示同一模型。
- Paseo 适配：透传（`config_option_update` 与普通 chunk 都会到 Paseo；工作树另有 `kernelEvent` 通道，与本条无关）。
- 适配状态：已对齐

### A11. 默认模型 id 与环境覆盖
- 官方做什么：`AGY_ACP_DEFAULT_MODEL` 优先，否则 API key 路径 `gemini-3.8-flash-high`、Agent Platform 路径 `gemini-4-carbon-medium`。
- 官方信号：`model_selection.py:313-328`。
- 官方不做什么：不在 `initialize` 里公布默认；不校验环境变量值是否在表内（值会原样作为选择）。
- Paseo 适配：未接（Paseo 不设该环境变量；适配器仓未见读取）。
- 适配状态：官方条件不满足（依赖运维注入，非客户端能力）

### A12. 上下文窗口大小的三级来源
- 官方做什么：先查 CCPA `fetchAvailableModels` 记录的 `maxTokens`，再查 gateway catalog 的 `max_tokens`，最后查内置表 `max_tokens`；**都查不到就返回 None 并告警，宁可不发 `usage_update` 也不猜分母**。
- 官方信号：`model_selection.py:330-368`（`get_context_window_size`）；`model_selection.py:349-360`（CCPA maxTokens 采集，要求 `int` 且非 bool 且 >0）；`model_selection.py:461-472`（gateway 条目采集）。
- 官方不做什么：不用模型名猜窗口；不发 `size=0`。
- Paseo 适配：透传（Paseo 拿到的 `usage_update.size` 就是这里算出来的；缺失时 Paseo 收不到该通知）。
- 适配状态：已对齐

### A13. 按认证方式换绑的图像模型
- 官方做什么：每会话除文本 target 外固定挂一个 IMAGE target：OAuth 用 `gemini-3.1-flash-image`，企业用 `gemini-3-pro-image`（显式指定，因为 SDK 默认注入的那个不是有效 BAIC experience），其余路径用 SDK 默认常量。
- 官方信号：`server.py:1177`（`_OAUTH_IMAGE_MODEL`）；`server.py:1182`（`_BUSINESS_IMAGE_MODEL`）；`server.py:4700-4726`、`server.py:4728-4760`（三处 `common_args["models"]`）；`server.py:4197-4207`（`_build_image_model_target`）。
- 官方不做什么：不把图像模型列进 `configOptions`（用户选不到，只由 `generate_image` 工具用）。
- Paseo 适配：透传（Paseo 侧只可能看到 `generate_image` 的工具调用）。
- 适配状态：已对齐

### A14. 网关模型目录（企业自带 AI Gateway）
- 官方做什么：`AGY_LLM_GATEWAY_MODELS` 优先，除非 `admin_settings.json` 设了 `models.list`/`models.listSource`；否则走四层目录 `model_discovery.get_model_catalog`。allowlist 里内置 id 保留元数据、基础 id 展开成全部变体、其余作为 custom 模型（受 `MAX_CUSTOM_MODELS` 限制）。gateway 会话**刻意不走** `_finalize_model_state` 的「自定义模型自补」逻辑，避免会话保留企业已撤回的模型。
- 官方信号：`model_selection.py:490-566`（`_allowlist_entries`、`_allowlist_entry`、`_gateway_fleet`）；`model_selection.py:589-620`（gateway 分支的注释与 `resolve_catalog`）；`server.py:4666-4700`（gateway auth 分支）。
- 官方不做什么：不在 gateway 路径调用 CCPA；不允许会话保留被撤回的模型。
- Paseo 适配：未接（Paseo 不设置 `auth.type=gateway`，也不读 `admin_settings.json`）。
- 适配状态：官方条件不满足

### A15. 会话级模型列表缓存与失败降级
- 官方做什么：模型列表每会话只取一次并缓存；取失败时**降级成只含当前模型的一条**（`description="Current model"`），而不是让会话不可用；恢复会话若缓存值与当前认证的命名空间不兼容，采用解析出的新值并告警。
- 官方信号：`server.py:3543-3601`（`_selection_state`）；`server.py:2874-2880`（`_relist_session_models`）；`server.py:4052-4074`（恢复时先解析再建 agent）。
- 官方不做什么：不因一次 CCPA 抖动把会话打死；不在每次选项变更时重新拉取。
- Paseo 适配：透传。
- 适配状态：已对齐

---

## B. 第三方过滤

### B01. `supports_third_party_models` 的七个客户端
- 官方做什么：只有这七个客户端之一为真时，CCPA 列表才保留非 Gemini 模型——`is_jetbrains`（JetBrains）、`is_jetbrains_air`（JetBrains Air，客户端报 `air-plugin:<ide>`）、`is_android_studio`（Android Studio）、`is_android_performance_analyzer`（Android Performance Analyzer）、`is_zed`（Zed）、`is_xcode`（Xcode）、`is_t3_code`（T3 Code）。文档字符串明确：第三方模型是「按客户端界面逐个开启」的，未识别客户端（以及根本没发 `clientInfo` 的客户端）保持 Gemini-only。
- 官方信号：`model_selection.py:33-57`（`supports_third_party_models`，7 个 or 条件）；`client_info.py:81-135`（各 `is_*` 属性）。
- 官方不做什么：**没有**任何可追加的白名单入口——没有环境变量、没有 `_meta` 键、没有 `settings.json` 字段、没有配置文件。名单是源码常量。
- Paseo 适配：`clientInfo.name` 是 `Paseo`，不落在任何判定前缀/等值里，因此官方只发 Gemini。适配器**已删掉**覆盖该过滤的兼容补丁（HEAD 的 `kernel-compat-rc01-recipe.ts` 里有 `rc01-model-selection-catalog` 把 `allow_third_party` 判断替换成 `is_catalog_model`；工作树把这两条 edit 整块删除，见 `git diff "ACP Connector/official-kernel/kernel-compat-rc01-recipe.ts"`）。`paseo_model_compat.py` 里的 `SUPPORTED_NON_GEMINI_MODEL_IDS` 与 `is_catalog_model()`（`assets/official-kernel-compat/rc01/paseo_model_compat.py:19-59`）在工作树已不再被任何 patch 注入 `model_selection.py`（`grep -rn "is_catalog_model"` 只剩测试与自身定义）。
- 适配状态：已知差异（官方行为如此，Paseo 不改写身份）

### B02. `clientInfo` 的判定原语
- 官方做什么：`name` 前缀匹配 `jetbrains.`、`air-plugin:`（后缀必须非空）、`android studio`、`android performance analyzer`；等值匹配 `xcode`、`zed`、`t3-code`；`_meta.platform` 等值匹配 `intellij` 另有 `is_intellij_platform`（只说明平台，不说明厂商）。全部大小写不敏感。字段缺失/非字符串一律空串，整体等于 `UNKNOWN`。
- 官方信号：`client_info.py:16-30`（7 个常量）；`client_info.py:44-78`（`_field`/`_text` 的宽容读取）；`client_info.py:81-135`（属性）；`client_info.py:138-162`（`UNKNOWN`、`parse`）。
- 官方不做什么：不读 `title`；不读 `version` 做能力判定；不对未知客户端报错。
- Paseo 适配：透传 `clientInfo.name="Paseo"`、`title`、`version`（`/tmp/agy-c13-c41.yFi4LTTz/results.json` 两侧均为 `{"name":"Paseo","version":"dev"}`）。
- 适配状态：已对齐

### B03. 过滤执行点：非 Gemini 一律丢弃
- 官方做什么：`_parse_ccpa_response` 里 `if not allow_third_party and not ccpa_id.startswith("gemini"): continue`，即非 Gemini 直接跳过，连详情都不读。
- 官方信号：`model_selection.py:30`（`_GEMINI_MODEL_ID_PREFIX = "gemini"`）；`model_selection.py:418-424`；两处调用 `model_selection.py:722`、`model_selection.py:792`（分别传 `supports_third_party_models(client)`）。
- 官方不做什么：不在过滤后再补回；不对被过滤项发任何通知或计数。
- Paseo 适配：HEAD 曾用补丁把这个判断改成 `is_catalog_model(ccpa_id)`；工作树已还原为官方判断（同上 `git diff`）。因此工作树行为与官方一致。
- 适配状态：已对齐（工作树）；已知差异（HEAD 的历史补丁，需注意 HEAD 与工作树不同）

### B04. 实测对照：两侧都是 0 个非 Gemini
- 官方做什么（实测记录）：`/tmp/agy-c13-c41.yFi4LTTz/results.json` 的 `official` 与 `adapter` 两侧 `session/new` 的 `model` 选项都是 `gemini-4-neon`、`gemini-4-argon`、`gemini-4-hydrogen`、`gemini-3.8-flash`（`rawOptionCount=4`），非 Gemini 数量为 0；两侧 `clientInfo` 均为 `Paseo`。
- 官方信号：`/tmp/agy-c13-c41.yFi4LTTz/results.json`（`sides[].models["session/new"][0].options`）。
- 官方不做什么：不因客户端是 Paseo 而报错或降级；不提示「你的客户端不支持某些模型」。
- Paseo 适配：与官方逐项相同（同一次记录里 `updates`、`commands` 前缀、`workspaceAfter` 均一致，见 B05/D02）。
- 适配状态：已对齐

### B05. `UNKNOWN` 客户端（无 `clientInfo`）的默认
- 官方做什么：ACP 允许 `clientInfo` 可选，认证也可能早于 `initialize`，所以 `UNKNOWN` 是连接的初始状态而不是错误；此时一律 Gemini-only。
- 官方信号：`client_info.py:138-145`；`server.py:2576-2583`（只在 `client_info` 为真时解析）。
- 官方不做什么：不对缺失块发拒绝；不在缺少身份时放宽。
- Paseo 适配：Paseo 总是发 `clientInfo`，该分支在 Paseo 上不出现（但「发什么名字」这件事是 B01 的全部）。
- 适配状态：已对齐

---

## C. 模式与权限

### C01. 三种会话模式，id 与顺序由官方定
- 官方做什么：`AVAILABLE_SESSION_MODES` 固定三项，顺序即显示顺序：`default`（Default，Default permission prompt flow）、`auto_edit`（Auto Edit，Auto-approve file edit tools）、`yolo`（YOLO，Auto-approve all tools）。同时出现在 `modes`（superseded）与 `configOptions` 的 `category:"mode"` 里。
- 官方信号：`config_options.py:25-44`（常量与顺序）；`config_options.py:252-278`（`_mode_option`）；`config_options.py:371-380`（`modes` 与 `configOptions` 同源生成）。
- 官方不做什么：不支持自定义模式；不支持 per-session 模式描述；不把模式做成按钮以外的形状。
- Paseo 适配：透传官方三 id；适配器另有 `mapToOfficialModeId()` 把旧别名（`accept-edits`、`dangerously-skip-permissions` 等）翻成官方 id，并给 `default`/`auto_edit`/`yolo` 额外打 `_meta["paseo.dev/unattended"]`（`ACP Connector/official-kernel/mode-map.ts:1-80`）。这是 Paseo 侧扩展，不改官方 id 集合。
- 适配状态：非官方扩展（扩展只加元数据与旧别名翻译）

### C02. 双面模式设置：`configOptions` 与 `session/set_mode`
- 官方做什么：两者都接受。`set_session_mode` 校验 id 属于 `AVAILABLE_SESSION_MODES`，**同值直接返回**（客户端改任一选项都会重发全部，IntelliJ 2026.2 每次换模型都重发），否则写 sidecar `{"mode_id": ...}`。`set_config_option(configId="mode")` 转调它。
- 官方信号：`server.py:2718-2757`；`server.py:2940-2944`（分派）。
- 官方不做什么：不因管理模式而锁死模式（注释明确：任何合法模式都接受，终端复核在每次 exec 调用处单独执行）。
- Paseo 适配：透传（`rewriteModeFields` 只翻译旧别名，见 `mode-map.ts:22-39`）。
- 适配状态：已对齐

### C03. 未知模式与未知选项的错误码
- 官方做什么：未知 mode id → `-32602 Unknown mode id: <id>`；未知 configId → `-32602 Unknown config option id: <id>`；非字符串 value → `-32602 Config option <id> expects a string value.`
- 官方信号：`server.py:2740-2745`；`server.py:2950-2956`；`server.py:2924-2930`。
- 官方不做什么：不忽略未知值；不做前缀/模糊匹配。
- Paseo 适配：透传错误（`mapToOfficialModeId` 只翻已知别名，未知值原样交给官方判定）。
- 适配状态：已对齐

### C04. `auto_edit` 只自动批文件类写工具
- 官方做什么：`auto_edit` 下仅当工具名属于 `AUTO_EDIT_TOOLS` 才直接放行；集合是 `client_create_file`、`client_edit_file`、`create_file`、`edit_file`、`write_file`、`replace_file_content`、`multi_replace_file_content`、`write_to_file`。
- 官方信号：`tools.py:16-25`；放行点 `server.py:5064-5070`。
- 官方不做什么：不自动批 exec；不自动批 web 工具；不自动批 MCP 工具。
- Paseo 适配：透传（Paseo 选中 `auto_edit` 后不再自己判权限）。
- 适配状态：已对齐

### C05. `yolo` 全放行，但有两类例外
- 官方做什么：`yolo` 直接 `return True`，**除非** `always_ask_file`（企业 ALWAYS_ASK 且目标在工作区外）或 `exec_requires_review`（企业终端策略要求逐条复核）。
- 官方信号：`server.py:5064-5069`（`yolo` 直接 `return True`）；`server.py:5018-5032`（`always_ask_file`、`exec_requires_review` 的构造，两者在 `yolo` 之前判定）。
- 官方不做什么：不让 `yolo` 越过企业「每次复核」策略；不让 `yolo` 越过工作区外的 ALWAYS_ASK。
- Paseo 适配：透传（`mode-map.ts:53-57` 只标 `paseo.dev/unattended=yolo`，不参与权限判定）。
- 适配状态：已对齐

### C06. 工具审批的请求形状
- 官方做什么：先发 `tool_call`（`status:"pending"`，带 `title`、`kind`、`content`、`locations`、`raw_input`，MCP 调用另带 `_meta.mcp`），再发 `session/request_permission`；选项恒有 `allow`(allow_once)、`deny`(reject_once)，第三种按工具类决定。
- 官方信号：`server.py:5118-5132`（先发 `tool_call`，`status:"pending"`）；`server.py:5132-5145`（记录待对账帧）；`server.py:5173-5224`（选项构造）；`server.py:5226-5290`（`request_permission`）。
- 官方不做什么：不在 `request_permission` 里发 `toolCallId` 与后续执行共享 id（注释说明：策略路径不给共享 id，只能按工具名 + FIFO 对账）。
- Paseo 适配：透传（适配器不重写 `request_permission`；Paseo 侧 UI 是 Paseo 自己的事）。
- 适配状态：已对齐

### C07. 高风险工具的 `Allow Always (risky)` 与注入告警
- 官方做什么：exec/文件写/web 三类算高风险。exec 与 web 提供第三种选项 `allow_always`，名称 `Allow Always (risky)`，并在 `_meta["agy.security.warning"]` 里带 `severity:"high"`、`risk:"prompt_injection"`、`title`、`message`；web 与 exec 的措辞不同（web 按工具在整个会话内缓存，exec 按精确命令缓存）。
- 官方信号：`server.py:314-321`（`_is_high_risk_tool`）；`server.py:5186-5224`（两套 warning message 与 `agy.security.warning` 的形状）。
- 官方不做什么：不给文件写工具提供 `allow_always`（写了也不会持久化，等于静默降级）；不隐藏告警依赖（客户端忽略 `_meta` 仍看到 `(risky)` 字面）。
- Paseo 适配：透传 `_meta`；Paseo 是否渲染该警示属 Paseo 侧，本文未核实。
- 适配状态：已对齐（协议侧）；渲染未核实

### C08. `Allow Always` 的签名范围与持久化
- 官方做什么：签名 = 工具名 + 参数摘要（`_allow_always_signature`）；只对「可缓存」的调用持久化到 sidecar（`allowed_tool_calls` + `allowed_tools_workspace`），恢复会话时**只在同一工作区**才恢复，旧格式 `allowed_tools`（list[str]）刻意忽略并重新询问。
- 官方信号：`server.py:87-125`（`_allow_always_signature`）；`server.py:5277-5310`（`allow_always` 处理与 sidecar 写入）；`server.py:323-330`（序列化）；`server.py:3960-3978`（恢复时的同工作区绑定）。
- 官方不做什么：不跨工作区复用；不给写工具与「每次复核」的 exec 缓存；不对不可缓存调用伪造持久化（只本次放行并记日志）。
- Paseo 适配：透传（Paseo 发 `optionId:"allow_always"` 时官方才缓存）。
- 适配状态：已对齐

### C09. `deny` 与「取消」是两种结果
- 官方做什么：`AllowedOutcome(optionId="deny")` 表示用户选了拒绝项；`DeniedOutcome(outcome="cancelled")` 表示取消。两者都会关掉已宣告的 tool_call（`_reject_tool_call`），但语义不同。
- 官方信号：`server.py:5321-5328`（`_permission_handler` 的 allow/deny 分流）；`server.py:5495-5497`（`DeniedOutcome` 走取消分支）；`server.py:4937-4968`（`_reject_tool_call`）。
- 官方不做什么：不把 cancel 当 deny 回报；不留下 pending 帧。
- Paseo 适配：透传（配套仓工作树在 `acp-agent.ts` 侧区分，本文不引其行号）。
- 适配状态：已对齐

### C10. `ask_question` 自确认（不被 permission 预拦）
- 官方做什么：`safe_defaults(handler)` 会给 `ask_user("*")` 通配，导致 `ask_question` 先被问一次「Run ask_question?」。官方在策略表头部插入 `allow("ask_question")`（具体 allow 优先级高于通配），让「用户回答」本身就是确认。渲染上是一次 `request_permission` + 一个 dummy `tool_call_id`（`interaction_<8hex>`）。
- 官方信号：`server.py:4392-4396`（插入 allow 的位置与「具体 allow 高于通配」的机制）；`server.py:5381-5497`（`_ask_user_handler`：发 `tool_call` pending → `request_permission` → 发 `tool_call_update` completed/failed → 返回 option id）。
- 官方不做什么：不提供多选（TODO b/524989454 明说未支持）；不发明独立 RPC。
- Paseo 适配：透传（Paseo 看到的是普通权限请求）。
- 适配状态：已对齐

### C11. `read_url_content` 被显式降级为需审批
- 官方做什么：`safe_defaults()` 把它当只读给 `ALLOW`；官方在策略头部插一条 `ask_user("read_url_content")`，理由：抓任意 URL 是把不可信远端内容拉进上下文（提示注入面），应与 `search_web` 同级确认。
- 官方信号：`server.py:4409-4427`。
- 官方不做什么：不禁用该工具（除非 gateway 路由要求，见 C16）；不区分 URL 来源。
- Paseo 适配：透传。
- 适配状态：已对齐

### C12. 终端命令：官方不锁模式，改在每次 exec 调用复核
- 官方做什么：管理端终端策略**不**限制可选模式（`auto_edit`/`yolo` 仍可选）；要求复核时，在 exec 工具调用处强制：`yolo` 被绕过、`Allow Always` 缓存被绕过、只给 Allow/Deny 两个选项。
- 官方信号：`server.py:2750-2754`（模式不锁的注释）；`server.py:5028-5032`（`exec_requires_review`）；`server.py:5178-5179`（只给 Allow/Deny 两项）；`server.py:5284-5310`（客户端硬发 `allow_always` 时只本次放行、不缓存）。
- 官方不做什么：不把终端策略做成模式；不隐藏 exec 工具。
- Paseo 适配：透传（Paseo 选 `yolo` 时若官方策略要求复核，官方仍会弹）。
- 适配状态：已对齐

### C13. OS 沙箱（exebox）能力探测与前向传递
- 官方做什么：macOS（Seatbelt）、Windows 直接视为支持；Linux 需探测 `/proc/sys/kernel/unprivileged_userns_clone` 与 `/proc/sys/user/max_user_namespaces` 两个开关（`functools.cache`）；仅当管理端 `sandbox_mode` 开且主机支持时，把 `enable_sandbox=True` 传给 harness。`PROCEED_IN_SANDBOX` 在沙箱不可用时**回落为复核**，不降级成无沙箱放行。
- 官方信号：`terminal_sandbox.py:32-80`（探测）；`terminal_sandbox.py:82-119`（`terminal_requires_review` 的回落）；`terminal_sandbox.py:121-146`（`terminal_sandbox_active`）；`terminal_sandbox.py:148-176`（`terminal_sandbox_auto_proceed`）；`server.py:4569-4571`（`RunCommandConfig(enable_sandbox=...)`）。
- 官方不做什么：不在非企业路径启用沙箱；不把沙箱当权限替代（权限与沙箱是两个独立开关）。
- Paseo 适配：未接（该分支仅企业 entitlement 可达，Paseo 侧不触发）。
- 适配状态：官方条件不满足

### C14. 工作区外文件访问策略（DENY / ALWAYS_ASK / NOT_ENFORCED）
- 官方做什么：企业路径下按 `outside_workspace_file_access_policy` 生成策略：命名的 14 个文件工具各挂 `deny` 与 `ask_user` 两条（谓词实时读管理端值，改策略不必重建 agent），再加 `"*"` 通配覆盖 MCP 文件工具与 exec 命令；`UNSPECIFIED` 归一化为 DENY。非企业路径生成空列表，改由官方自己的 `_view_file_scope_policy` 把 `view_file` 限制在 `allowed_dirs`（cwd + additionalDirectories + GEMINI_HOME + 技能目录），原因是 harness 内建 containment 还额外放行系统临时目录与 memory 路径。
- 官方信号：`server.py:347-372`（`_OUTSIDE_WORKSPACE_FILE_TOOLS` 14 项与注释）；`server.py:1967-2048`（`_build_file_access_policies`）；`server.py:519-546`（`_view_file_scope_policy`）；`server.py:4432-4444`（非企业路径挂 `_view_file_scope_policy` 的位置与 b/533482056）。
- 官方不做什么：不对工作区内调用加限制；不把 DENY/ASK 做成一次性的（实时读值）；不依赖 SDK 的 `file_tools()`（它漏掉 list/search/find）。
- Paseo 适配：未接（企业 entitlement 分支）。
- 适配状态：官方条件不满足

### C15. exec 的越界判定是「命令 token 扫描」
- 官方做什么：`run_command`/`shell` 的目标路径藏在 `CommandLine` 里，官方用 token 级启发式判断是否越界：拆分命令、解析路径 token（含 `~`、相对路径、`..`）、与工作区根比较；文档明确这是 best-effort。
- 官方信号：`server.py:564-626`（`_command_accesses_outside_workspace`）；`server.py:628-662`（`_resolve_command_path_token`）；`server.py:664-741`（`_call_accesses_outside_workspace`，把路径参数键与命令扫描合起来）。
- 官方不做什么：不声称完备（注释直说 best-effort）；不阻止 shell 内动态拼接的路径。
- Paseo 适配：未接（企业分支）；Paseo 侧无等价判定。
- 适配状态：官方条件不满足

### C16. 客户端文件工具只在客户端声明 FS 能力时注入
- 官方做什么：`clientCapabilities.fs.read_text_file` 为真时注入 `client_view_file`；`write_text_file` 为真时注入 `client_create_file`、`client_edit_file`，**同时禁用内建 `create_file`/`edit_file`**（避免双重实现）；内建 `view_file` 始终保留（行号输出是模型训练过的格式）。这三个工具不受 `enabledTools`/`disabledTools` 管（它们不是内建工具）；写工具的审批由 harness 预处理钩子统一做，工具自己不得再查权限，否则同一次 create/edit 会弹两次。
- 官方信号：`server.py:4341-4347`（过滤不覆盖 `client_*` 的理由）；`server.py:4347-4390`（按 `read_text_file`/`write_text_file` 分别注入，写工具不自行复核权限）；`server.py:4303-4312`（内建 `view_file` 保留的理由）；`tool_filter.py:1-20`（过滤只管内建）。
- 官方不做什么：不在客户端未声明能力时注入；不在工具内部再判一次权限。
- Paseo 适配：透传（Paseo 声明哪些 FS 能力由 Paseo 决定；适配器不修改 `clientCapabilities`）。
- 适配状态：已对齐

### C17. 内部 MCP schema 读取对客户端隐身
- 官方做什么：当一次 `view_file`/`client_view_file` 的目标正好落在当前会话已缓存的 MCP schema 文件上、且路径不是 create/edit/list/search 类工具时，判定为「内部读取」，不下发到客户端流，并跨步记住该 id（后续终态发射的参数可能被剥离，不再重新宣告）。
- 官方信号：`server.py:403-480`（`_MCP_SCHEMA_READ_TOOLS`、`_is_internal_mcp_schema_read`）；`server.py:6076-6086`（`hidden_tool_calls` 的使用与理由 b/542702128）。
- 官方不做什么：不隐藏写/改类工具（避免遮住变更面）；不隐藏其它 `view_file`。
- Paseo 适配：透传（这些调用根本不会到达 Paseo）。
- 适配状态：已对齐

### C18. 未闭合 tool_call 的兜底与权限帧对账
- 官方做什么：turn 结束时把仍 `in_progress` 的工具调用统一收尾——正常结束记 `completed`，异常/取消记 `failed`；因策略路径无共享 id，用（工具名 + FIFO）把权限帧与执行步对账成同一行；已批准但没等到执行步的权限框会以 `failed` 关闭并写明「approved but never executed」。
- 官方信号：`server.py:6295-6330`（`_close_open_tool_calls`）；`server.py:5909-5960`（`_resolve_permission_frame`）；`server.py:5794-5834`（turn 末清扫，b/542364503）；`server.py:5132-5145`（`pending_permission_frames` 入队，b/542330425）。
- 官方不做什么：不让客户端出现永久 pending 的框；不把未执行算成成功。
- Paseo 适配：透传。
- 适配状态：已对齐

---

## D. 工具

### D01. 内建工具是「allowlist 反推」而不是 denylist
- 官方做什么：用 `enabled_tools=[t for t in BuiltinTools.default() if t not in disabled]` 构造，并额外补 `ASK_QUESTION`（`default()` 不含它，且 `enabled_tools` 与 `disabled_tools` 互斥，这是唯一开启方式）。这样 SDK 以后新增的内建工具会自动启用。
- 官方信号：`server.py:4555-4566`（`enabled_builtin_tools` 与 `ASK_QUESTION` 补入）。
- 官方不做什么：不逐个列举内建工具；不使用 `disabled_tools` 字段。
- Paseo 适配：透传（Paseo 不发工具过滤时得到官方默认全集）。
- 适配状态：已对齐

### D02. 客户端工具过滤（`enabledTools` / `disabledTools`）
- 官方做什么：从 `_meta.antigravity` 读（旧客户端可用 `_meta.agy`，仅对这两个键兼容）。`enabledTools` 是允许列表——**不在其中的全部禁用**，`[]` 等于全禁；`disabledTools` 是拒绝列表，与允许列表同时存在时做减法；省略字段表示「无意见」并保留服务端默认；已持久化的过滤用 `{"disabledTools": []}` 清除（省略 block 是「无意见」，会恢复持久化的值）。过滤只作用于 AGY 内建工具，不管 `client_*` 与 MCP 工具。
- 官方信号：`tool_filter.py:56-136`（`ToolFilterConfig` 的 docstring 与 `to_dict`/`from_dict`/`from_request_kwargs`）；`tool_filter.py:137-165`（`resolve_disabled_builtins` 两种 case）；`request_meta.py:23-49`（`_meta.agy` 兼容读取）；`server.py:3680`、`server.py:3981-3994`（new/restore 的读取优先级：客户端 → 热恢复旧会话 → sidecar）。
- 官方不做什么：不读 `enabled_tools` 等下划线拼写；不对 MCP/客户端工具生效；不在未知名字上猜。
- Paseo 适配：透传（适配器不改写 `_meta.antigravity` 的这两个键；`context.ts` 只额外合并 `systemPrompt.append`）。
- 适配状态：已对齐

### D03. 工具名匹配契约：精确、无别名、无枚举名
- 官方做什么：只接受 `BuiltinTools` 的**值**（`run_command`、`view_file`、`create_file`、`edit_file`、`list_directory`、`search_directory`、`find_file`、`ask_question`、`start_subagent`、`generate_image`、`search_web`、`read_url_content`、`finish` 等），只容忍首尾空白；`RUN_COMMAND` 这类枚举名不认；不认识的名字记 warning 后跳过，不猜。
- 官方信号：`tool_filter.py:25-53`（`_tool_name_to_builtin` 的契约说明）；`tool_filter.py:148-152`、`tool_filter.py:155-165`（两处 warning）。
- 官方不做什么：不做大小写折叠；不做前缀匹配。
- Paseo 适配：透传（Paseo 侧发什么名字由 Paseo 决定；适配器不翻译工具名）。
- 适配状态：已对齐

### D04. 客户端 `view_file` 的输出格式（行号、分页、限额）
- 官方做什么：输出前加一段固定前言（「每行前带 `<行号>: `，改动原文件时要去掉行号、冒号和前导空格」），正文按 `800 行` 与 `45 KiB` 双限额裁剪，超限时附「这不是完整文件，需要再调一次」的说明；单文件上限 `100 MiB`；二进制拒绝并提示「磁盘上的图片/PDF/音视频可用内建 view_file」；超长行截断时另附说明。
- 官方信号：`tools.py:74-121`（`_LINE_NUMBER_PREAMBLE`、三种 note、`_MAX_VIEW_FILE_BYTES`、`_MAX_LINES_PER_VIEW`、`_MAX_BYTES_PER_VIEW`、`_file_too_large_message`、`_binary_file_message`）；`tools.py:176-254`（行范围解析与 `_fit_view_byte_budget`）；`tools.py:256-303`（`_format_view_file_output`）。
- 官方不做什么：不返回不带行号的裸内容；不在一次调用里返回超限内容。
- Paseo 适配：透传（Paseo 看到的是 `raw_output` 文本）。
- 适配状态：已对齐

### D05. 拒绝「把行号抄回文件」的编辑
- 官方做什么：`client_edit_file` 等工具在写入前检测内容里是否带 `<数字>:` 前缀，命中则拒绝并提示去掉行号（因为模型常把 view 的输出原样回写）。
- 官方信号：`tools.py:125-160`（`_reject_copied_line_numbers`）；`tools.py:98`（前缀正则）。
- 官方不做什么：不静默剥离行号（会改坏内容）；不把它当成功。
- Paseo 适配：透传（Paseo 只是把工具结果展示出来）。
- 适配状态：已对齐

### D06. `tool_call` 的 `kind` 推断与位置/内容提取
- 官方做什么：MCP 调用一律 `kind="other"`（并带 `_meta.mcp`）；`run_command`/`shell`→`execute`；`AUTO_EDIT_TOOLS`→`edit`；`FILE_READ_TOOLS`→`read`；`read_url_content`→`fetch`；`SEARCH_TOOLS`→`search`；其余 `other`。同时抽出 `locations`（受影响文件）与 `content`（diff/文本），MCP 调用会先「拆包」成 `ServerName/ToolName/Arguments` 形状。
- 官方信号：`tools.py:705-738`（`infer_tool_kind`）；`tools.py:558-665`（`unwrap_mcp_tool_call`）；`tools.py:764-830`（`extract_tool_locations`）；`tools.py:860-...`（`extract_tool_content`）；调用点 `server.py:5155-5162`、`server.py:6110-6130`。
- 官方不做什么：不发明 ACP 之外的 kind；不为了 UI 改工具名。
- Paseo 适配：透传。
- 适配状态：已对齐

### D07. `run_command` 的 `rawOutput` 双拼写兼容
- 官方做什么：执行输出对象里同时给 `exitCode` 与 `exit_code`、`combinedOutput` 与 `formatted_output`，注释写明「needed for Jetbrain」；`workingDir`、`commandLine` 也在。`exit_code` 是 optional，无法确定时字段不出现。
- 官方信号：`server.py:282-313`（`_run_command_proto_output`）；`server.py:126-166`（`_exec_tool_raw_output`）。
- 官方不做什么：不统一成单一拼写；不伪造未知退出码。
- Paseo 适配：透传（Paseo 读 `rawOutput`）。
- 适配状态：已对齐

### D08. `generate_image` / `search_web` 的输出摘要形态
- 官方做什么：`generate_image` 走专用输出构造（图片产物走工具输出通道）；`search_web` 额外提供 `_search_web_summary(args)` 做简短摘要用于展示标题。
- 官方信号：`server.py:167-239`（`_generate_image_tool_output`）；`server.py:250-261`（`_search_web_summary`）。
- 官方不做什么：不在正文里重复整段搜索结果；不把图片塞进 `agent_message_chunk`。
- Paseo 适配：透传（Paseo 是否需要专门渲染图片产物属 Paseo 侧，本文未核实）。
- 适配状态：已对齐（协议侧）；渲染未核实

### D09. 子 agent（`start_subagent`）与工具过滤的耦合
- 官方做什么：`start_subagent` 被过滤掉时 `enable_subagents=False`；浏览器子 agent 因此也不注入。
- 官方信号：`server.py:4453-4458`（`subagents_enabled`）；`server.py:4566-4571`（`enable_subagents=subagents_enabled`）；`server.py:4528-4531`（该情形下的日志）。
- 官方不做什么：不在子 agent 被禁时保留浏览器的半套能力。
- Paseo 适配：透传。
- 适配状态：已对齐

### D10. 工具调用的流式生命周期
- 官方做什么：从 `agent.conversation.receive_steps()` 驱动（而不是 `response.chunks`，因为后者没有终态 ToolResult）：新调用发 `tool_call`（`status:"in_progress"`），终态发 `tool_call_update`（带 `raw_output`）；ERROR step 先把所有打开的工具调用刷成 `failed`。
- 官方信号：`server.py:5585-5600`（走 `receive_steps` 的理由与 `hidden_tool_calls` 初始化）；`server.py:6023-6040`（ERROR step 不流正文）；`server.py:5962-6030`（ERROR 先刷开着的调用）；`server.py:6162-6293`（终态分支）。
- 官方不做什么：不在 `chunks` 上做生命周期（会永久 pending）。
- Paseo 适配：透传。
- 适配状态：已对齐

---

## E. 技能

### E01. 技能目录的发现顺序（5 组路径，顺序固定）
- 官方做什么：`resolve_skills_paths()` 返回固定顺序：`<GEMINI_HOME>/config/skills`、项目 `.gemini/skills`、`<GEMINI_HOME>/antigravity-cli/skills`、项目 `.agents/skills/`（项目项对 `cwd` 与每个 `additionalDirectories` 各展开一次）。两个全局目录跟随解析后的 GEMINI_HOME，不是 `$HOME`——因为结果同时喂给 allowed_dirs 与 workspace roots。
- 官方信号：`server.py:1468-1510`；`paths.py:176-195`（`global_skills_paths` 的两个来源与顺序）；`server.py:4297`（调用点）。
- 官方不做什么：不扫描 `.paseo/skills`、`.codex/skills`、`.claude/skills`；不递归子目录；不读 `skills.json` 声明。
- Paseo 适配：透传官方 5 组；适配器另在 `discoverSkillCommands()` 里自己扫 `.paseo/skills`、`.agents/skills`、`.codex/skills`、`.claude/skills`、`.gemini/skills`、`skills` 与四份 `skills.json`（`ACP Connector/official-kernel/skill-commands.ts:150-200`）。这与官方技能发现是两套互不替代的机制：官方那套决定**模型能用哪些技能**，适配器那套只决定**斜杠命令列表**。
- 适配状态：非官方扩展（斜杠命令）；官方技能发现本身已对齐

### E02. 预置系统技能由官方写入工作区，官方不设呈现模式
- 官方做什么：内置技能（如 `skills/system/run-workflow/SKILL.md`）由官方/harness 在会话建立时写入工作区；**官方 1.5.0 的 `server.py` 完全不出现 `presentation_mode` 或 `SkillsConfig`**（`grep -n "presentation_mode\|SkillsConfig" /tmp/agy150/src/server.py` 无匹配），呈现方式由官方与 harness 决定，ACP 侧没有任何开关。
- 官方信号：`server.py` 全文（无该符号）；`server.py:4297`（技能路径只作为 `skills_paths` 传入）；实测记录 `/tmp/agy-c13-c41.yFi4LTTz/results.json` 两侧 `workspaceAfter` 都含 `skills/system/run-workflow/SKILL.md`，两侧该文件 SHA-256 同为 `82ed7c2e93d79fd95a01188c78539b6987f4c2a2dfc49c3b8991bebbe8925bf8`。
- 官方不做什么：不提供 `SkillsConfig.TOOL` 这类改写入口；不发任何技能相关的 session update。
- Paseo 适配：适配器**已删掉**旧补丁 `skills-tool-presentation`（HEAD 的 `kernel-compat-rc01-recipe.ts` 里把它写成 `harness_config.skills_config.presentation_mode = localharness_pb2.SkillsConfig.TOOL`；工作树该 edit 已整块删除，同一位置换成只读的 `paseo-step-observer`）。删掉后两侧写入同一份 `SKILL.md`、同一哈希。
- 适配状态：已对齐（工作树）；已知差异（HEAD 的历史补丁）

### E03. 技能目录同时进入 allowed_dirs 与 workspace roots
- 官方做什么：`allowed_dirs = [abs_cwd, *additional, abs(GEMINI_HOME), *abs(skills_dirs)]`，同时 `skills_paths` 单独传给 harness，`workspaces` 只含 `[cwd, *additional]`（技能目录不进 workspaces，只进 allowed_dirs 与 hooks 的 `workspace_paths`）。
- 官方信号：`server.py:4331-4335`（`allowed_dirs`）；`server.py:4687`、`server.py:4704`（`workspaces` 与 `skills_paths` 分开传）；`server.py:4610-4614`（hooks 的 `workspace_paths` 含 skills）。
- 官方不做什么：不把技能目录当会话工作区；不因此扩大写权限边界（文件策略仍按 roots 计算）。
- Paseo 适配：透传。
- 适配状态：已对齐

### E04. 斜杠命令只有官方三条，没有技能命令
- 官方做什么：`available_commands_update` 的内容 = `BuiltinSlashCommandName` 的全部成员（1.5.0 实测只有 `plan`）+ `logout` + `usage`。只带 `name` 与 `description`，不带技能。
- 官方信号：`server.py:5344-5379`（`_send_available_commands_update`）；`server.py:1195-1213`（`_DESCRIPTION_BY_COMMAND`、`_CMD_MAP`、`_CMD_PATTERN`）；`logout.py:39-42`；`usage.py:48-51`；实测 `/tmp/agy-c13-c41.yFi4LTTz/results.json` 的 `official.commands = [["plan","logout","usage"]]`。
- 官方不做什么：不从磁盘发现命令；不发布技能；不支持客户端注册命令。
- Paseo 适配：适配器在 `proxy.ts:448-476` 拦下该通知，用 `augmentAvailableCommands()` 追加技能命令（实测 official `["plan","logout","usage"]` vs adapter `["plan","logout","usage","audit-c41-yfi4lttz"]`）。**这是 Paseo 扩展，不是呈现模式差异。**
- 适配状态：非官方扩展

### E05. `/plan` 只是 prompt 文本里的斜杠命令
- 官方做什么：prompt 文本按 `_CMD_PATTERN` 切分，命中内置命令名就换成 SDK 的 `SlashCommand(name=...)` 对象（与普通文本混在一个序列里）。`/plan` 的说明是「先生成实现计划产物并等待用户批准」。官方**不发** `session/update` 的 plan 类更新。
- 官方信号：`server.py:1249-1300`（`_parse_prompt` 的 text 分支）；`server.py:1195-1200`（`/plan` 的描述）；`server.py:1202-1213`（模式与映射）。
- 官方不做什么：不实现 plan mode；不发 plan 事件；不把 plan 当会话状态。
- Paseo 适配：透传（Paseo 侧如果自行渲染 plan，属 Paseo 扩展；本文未核实其实现）。
- 适配状态：已对齐（官方侧）

---

## F. MCP

### F01. MCP 能力位
- 官方做什么：`initialize` 里 `mcpCapabilities={http:true, sse:true}`；stdio 是 ACP 默认能力，不单独声明。
- 官方信号：`server.py:2697-2700`。
- 官方不做什么：不声明 `acp`/`websocket` 传输；不声明工具级能力。
- Paseo 适配：透传（适配器把官方能力位原样给 Paseo，见 `kernel.ts` 侧的 initialize 处理，未逐行核）。
- 适配状态：已对齐

### F02. 客户端 `mcpServers` 的三种传输
- 官方做什么：`McpServerStdio`（`command`/`args`/`env`）、`McpServerHttp`（`url`/`headers`）、`McpServerSse`（`url`/`headers`，**映射成 `McpStreamableHttpServer`**）；其它类型返回 None（静默丢弃）。
- 官方信号：`mcp_servers.py:56-114`（`to_sdk_mcp_config`）。
- 官方不做什么：不把 sse 当独立传输保留；不对未知类型报错。
- Paseo 适配：适配器把 `headers` 归一化成数组（`mcp-rewrite.ts:22-49`），并把 http(s) 目标经本地桥转发（`mcp-protocol-bridge.ts`，本次未逐行核）。
- 适配状态：已对齐（协议形状）；桥接细节未核

### F03. 全局 `mcp_config.json` 与客户端服务器合并
- 官方做什么：读 `<GEMINI_HOME>/config/mcp_config.json`（支持 `{"mcpServers": {...}}` 与直接映射两种形状；`command` → stdio，`url` → http；`sse` 不识别）。合并时**客户端同名覆盖全局**并记 log。
- 官方信号：`mcp_servers.py:160-232`（`parse_mcp_config_file`、`load_global_mcp_configs`）；`mcp_servers.py:234-263`（`merge_mcp_servers`，`merged[name] = client`）。
- 官方不做什么：不合并同名服务器的字段（整条覆盖）；不校验 command 是否存在。
- Paseo 适配：透传（Paseo 不写该全局文件；适配器不读写它）。
- 适配状态：已对齐

### F04. `eagerMcpServers` 与单条 `forceAllToolsEager`
- 官方做什么：两种粒度——会话级 `_meta.antigravity.eagerMcpServers`（ACP v1 客户端用，因为 v1 的 `McpServer` 模型没有 `_meta`），单条 `{"_meta":{"antigravity":{"forceAllToolsEager":true}}}`（ACP v2 客户端用）。命中即 `force_all_tools_eager=True`，工具原生进 prompt，而不是走 `call_mcp_tool` + 磁盘 schema。
- 官方信号：`mcp_servers.py:27-34`（两个 `_meta` 键与 TODO(saxenaankita) 的背景）；`mcp_servers.py:90-108`（两种来源的判定）；`mcp_servers.py:116-131`（会话级解析）；`server.py:3681-3684`、`server.py:3995-3999`（new/restore 读取，**不持久化**，每次 load/resume 由客户端重发）。
- 官方不做什么：不持久化 eager 名单；不按工具粒度配置（TODO 里说明长期方向）。
- Paseo 适配：透传（适配器不改写 `_meta.antigravity` 的该键）。
- 适配状态：已对齐

### F05. `mcpMaxOutputBytes`
- 官方做什么：会话级 `_meta.antigravity.mcpMaxOutputBytes`，必须是正整数（bool 与非正整数记 warning 后忽略，回到 harness 默认），经 `CapabilitiesConfig.mcp_max_output_bytes` 传入；`None` 表示保持 harness 默认。
- 官方信号：`mcp_servers.py:35`、`mcp_servers.py:133-158`；`server.py:4563-4565`。
- 官方不做什么：不对单条服务器生效；不把非法值当 0。
- Paseo 适配：透传。
- 适配状态：已对齐

### F06. 企业 MCP 管控：全禁与允许列表
- 官方做什么：`mcp_enabled=false` 时**丢弃全部客户端 MCP**（在 `_create_agent_config` 里做，所以重建也生效），并记一条可观测日志；否则合并后过「Allowed server configuration」允许列表：空允许列表=全允许，`chrome_devtools`/`chrome-devtools` 是内建旁路项，允许项保留管理端 command/args/url 覆盖，结构损坏的 allowlist **fail-closed**（全丢，旁路除外）。
- 官方信号：`server.py:4271-4294`（disable 分支 + allowlist 调用）；`mcp_servers.py:265-307`（`apply_admin_allowlist`）；`admin_controls_manager.py:63-70`（旁路集合）；`admin_controls_manager.py:459-500`（`filter_mcp_servers` 的 fail-closed 说明）。
- 官方不做什么：不在非企业路径过滤；不让 disable 与 allowlist 互相覆盖（disable 优先）。
- Paseo 适配：未接（企业 entitlement 分支）。
- 适配状态：官方条件不满足

### F07. MCP 加载失败的用户文案
- 官方做什么：从异常文本里认出「某个 MCP server 初始化失败」，抽出服务器名与原因，拼成纯文本（不是 markdown）：「The MCP server '<name>' failed to initialize: <reason>. Fix the MCP server, or remove it from your configuration and start a new session, to continue.」并把 Go 的多层错误折成单行 `<outer>: <inner>`。
- 官方信号：`mcp_errors.py:53-80`（`mcp_load_failed_message`）；`mcp_errors.py:82-95`（`_tidy_reason`）；`mcp_errors.py:46-51`（`_REMEDY`）；调用点 `server.py:5754`。
- 官方不做什么：不重试加载；不自动移除出错的 server。
- Paseo 适配：透传（文案作为 `agent_message_chunk` 到 Paseo）。
- 适配状态：已对齐

### F08. `call_mcp_tool` 调度与包装 `_meta`
- 官方做什么：非 eager 的 MCP 工具经 `call_mcp_tool` 调度，参数是 `{ServerName, ToolName, Arguments}` 外层包；权限请求与工具流都把外层拆成「展示名 + 干净的 rawInput + `_meta.mcp`」，执行步可能只有内层参数（靠 `server_name` 或已保存的帧元数据还原）。
- 官方信号：`tools.py:50`（`MCP_DISPATCH_TOOL_NAME`）；`tools.py:558-665`（拆包）；`server.py:5163-5180`（权限侧）；`server.py:6100-6145`（流侧，含 `mcp_frames` 回退）。
- 官方不做什么：不对 eager 服务器绕这一层；不丢 MCP 标题。
- Paseo 适配：透传。
- 适配状态：已对齐

### F09. 客户端同名服务器与内建浏览器冲突
- 官方做什么：注入 `chrome_devtools` 前，把客户端/全局里同名条目剔除，内建浏览器配置胜出。
- 官方信号：`server.py:4486-4490`（先剔除同名客户端条目，再追加内建浏览器 MCP）。
- 官方不做什么：不重命名客户端条目；不合并两者。
- Paseo 适配：透传。
- 适配状态：已对齐

---

## G. hooks 与信任

### G01. 五个 hook 事件
- 官方做什么：`PreToolUse`、`PostToolUse`、`PreInvocation`、`PostInvocation`、`Stop`。前两者是 `list[Group]`（组里带 `matcher` 与 `hooks[]`），后三者是 `list[Handler]` 直接挂在事件键下。
- 官方信号：`hooks.py:196-229`（归一化时的事件清单与两种结构）；`hooks.py:240-262`（合并时的事件清单）；`hooks.py:141-156`（相对命令路径解析时的事件清单）。
- 官方不做什么：不支持其它事件名（未列出的键被忽略）；不支持 `Notification`/`SubagentStop` 这类扩展事件。
- Paseo 适配：未接（适配器不读写 hooks 配置；hooks 由官方进程自己加载）。
- 适配状态：已对齐（Paseo 不介入）

### G02. 配置位置与合并顺序
- 官方做什么：全局 `<GEMINI_HOME>/config/hooks.json`；工作区 4 个候选点目录 `.agents`、`.agent`、`_agents`、`_agent` 下的 `hooks.json`。合并顺序：工作区在前、全局在后；`enabled` 由全局覆盖；每个 handler 的相对命令（`./`、`../`）按所在文件目录解析成绝对路径；`enabled:false` 的 hook 组整体过滤掉。
- 官方信号：`hooks.py:273-290`（点目录与全局路径）；`hooks.py:310-360`（`load_hooks_config` 的三步与顺序）；`hooks.py:127-166`（路径解析）；`hooks.py:365-431`（异步版：先做信任判定）。
- 官方不做什么：不从 `settings.json` 读 hooks；不支持项目根以外的 hooks 文件；不做逐会话覆盖。
- Paseo 适配：已对齐（Paseo 不介入；工作区 `.agents/hooks.json` 若存在会被官方读取，前提是工作区被信任）。
- 适配状态：已对齐

### G03. 旧格式兼容（`hooks.BeforeTool`）
- 官方做什么：若文件顶层是 `{"hooks": {"BeforeTool": [...]}}`，归一化成一条名为 `default` 的 hook 组，映射到 `PreToolUse`。
- 官方信号：`hooks.py:186-200`。
- 官方不做什么：不兼容更多旧键；不把旧格式合并进新格式的其它事件。
- Paseo 适配：不适用（Paseo 不写 hooks）。
- 适配状态：已对齐

### G04. hook 执行协议
- 官方做什么：`shlex.split` 后 `create_subprocess_exec`，把 JSON 写到 stdin，读 stdout 的 JSON；超时默认 30 秒（handler 可用 `timeout` 覆盖）；非零退出码 → 记 error 并视为「失败」；stdout 空 → 视为 `{}`；非 dict 的 JSON → 视为失败。cwd 是工作区根。
- 官方信号：`hooks.py:26-113`（`run_hook_command_async`）。
- 官方不做什么：不重试；不合并 stderr；不把超时当成功。
- Paseo 适配：不适用。
- 适配状态：已对齐

### G05. `PreToolUse` 的决策语义
- 官方做什么：stdin 载荷 `{toolCall:{name,args}, stepIdx, conversationId, workspacePaths, transcriptPath, artifactDirectoryPath}`；`matcher` 是正则（`*`/空=全匹配，非法正则记错并视为不匹配）。返回里认两种形状：`{allowTool: bool, denyReason}` 或 `{decision:"deny"|..., reason}`；`allowTool` 非 bool 时按字符串 `"true"` 判真。**执行失败（None）视同拒绝**并给「External hook '<name>' failed to execute.」。
- 官方信号：`hooks.py:475-573`；`hooks.py:116-125`（`match_tool`）；`hooks.py:519-540`（stdin 形状）；`hooks.py:545-573`（结果解析与失败即拒）。
- 官方不做什么：不因 hook 报错而放行；不把 `ask` 当独立决策（非 deny 即 allow）。
- Paseo 适配：不适用（Paseo 不注入 hook）。注意：这类拒绝会以 MODEL→USER 的 ERROR step 出现，官方 `_stream_live_step` 刻意不把它当正文流出去（`server.py:6023-6036`）。
- 适配状态：已对齐

### G06. `PostToolUse`
- 官方做什么：stdin 载荷 `{stepIdx, error, conversationId, workspacePaths, transcriptPath, artifactDirectoryPath}`；返回值不改变工具结果（只用于观测/记录），执行失败仅记日志。
- 官方信号：`hooks.py:615-662`。
- 官方不做什么：不因 post hook 失败回滚工具；不改写工具输出。
- Paseo 适配：不适用。
- 适配状态：已对齐

### G07. `PreInvocation`
- 官方做什么：stdin 载荷 `{invocationNum, initialNumSteps, conversationId, workspacePaths, transcriptPath, artifactDirectoryPath}`；结果里若带 `injectSteps`，**明确不支持**并记 warning 后忽略。hook 执行失败只记 error，继续本轮。
- 官方信号：`hooks.py:705-781`（含 `injectSteps` 的 warning）；`hooks.py:753-760`（stdin）。
- 官方不做什么：不支持轨迹注入；不因 pre-invocation 失败阻断本轮。
- Paseo 适配：不适用。
- 适配状态：已对齐

### G08. `PostInvocation` 的终止能力
- 官方做什么：stdin 同上（`invocationNum`/`initialNumSteps`）；若返回 `terminationBehavior == "terminate"`，抛 `RuntimeError("Terminated by post-invocation hook ...")` 终止；`injectSteps` 同样不支持。这是 hooks 里唯一能主动结束执行的能力。
- 官方信号：`hooks.py:821-876`（`terminate` 分支与 `injectSteps` warning）。
- 官方不做什么：不提供「继续但改内容」；不支持注入。
- Paseo 适配：不适用（该 RuntimeError 会被 `prompt()` 的 `except RuntimeError` 捕成「连接不可恢复」文案，`server.py:5796-5806`，语义上是个已知粗糙点）。
- 适配状态：已对齐（官方行为）；文案语义偏差已记录为观察

### G09. `Stop`（会话结束）
- 官方做什么：会话结束时触发，stdin `{executionNum:1, terminationReason:"session_end", error:"", conversationId, ...}`；返回 `decision:"continue"` **明确不支持**并记 warning 忽略。触发前会重读一次工作区 hooks（若存在）。
- 官方信号：`hooks.py:909-955`（含 `decision=="continue"` 的 warning）。
- 官方不做什么：不支持恢复执行；不在 Stop 里改终态。
- Paseo 适配：不适用。
- 适配状态：已对齐

### G10. 交互 hook（`ask_question` 的传输层）
- 官方做什么：`ExternalOnInteractionHook` 把 SDK 的交互请求逐问题转成一次 ACP 权限请求（选项 id → `PermissionOption`），任一问题被取消则整体 `cancelled=True`。
- 官方信号：`hooks.py:961-1006`；`server.py:5397-5425`（问题选项到 `PermissionOption` 的映射，`deny/dont_trust/block` → `reject_once`，其余 `allow_once`）。
- 官方不做什么：不支持多选；不支持一次问多问合并成一个 UI 框（虽然 SDK 可以是多问题，ACP 侧逐问）。
- Paseo 适配：透传。
- 适配状态：已对齐

### G11. 工作区信任（workspace trust）
- 官方做什么：只有状态 `trusted` 才加载工作区 hooks。状态未知时，若客户端能应答，就用一次 ACP 权限请求问「Do you trust the authors of this workspace to execute automated agent hooks?」，选项「Trust Workspace / Don't Trust」；肯定的回答集合包含 `trust/allow/allow_once/allow_always/yes`，否定的包含 `deny/dont_trust/dont trust/don't trust/don't_trust/block/reject/no`；其它（含超时）记为「本轮抑制」并加入进程内 `_dismissed_workspace_prompts`，不写文件。状态存 `<GEMINI_HOME>/antigravity-acp/trusted_workspaces.json`（`{"trusted":[], "untrusted":[]}`，原子写，损坏时改名备份）。环境变量 `AGY_ACP_DISABLE_WORKSPACE_TRUST=1|true|yes` 可整体关闭信任检查。
- 官方信号：`workspace_trust.py:17-41`（env 开关与状态类型）；`workspace_trust.py:56-103`（读取与损坏处理）；`workspace_trust.py:105-140`（原子写）；`workspace_trust.py:141-227`（状态读写与清理）；`hooks.py:365-431`（询问与抑制逻辑）；`hooks.py:326-338`（不信任时的抑制日志）。
- 官方不做什么：不在未信任时「静默加载」；不把「不信任」当成永久拒绝（写进 untrusted）；不把全局 hooks 纳入信任（只有工作区 hooks 需要）。
- Paseo 适配：透传（Paseo 会收到那次权限请求，回答什么由用户决定）。
- 适配状态：已对齐

---

## H. 浏览器

### H01. 注入条件：企业专属，且默认关闭
- 官方做什么：仅 `oauth-business`（已解析许可证的企业会话）且管理端 `browser_enabled` 为真时注入；其它认证路径一律不注入（personal OAuth、Agent Platform、API key 都没有管理策略可查，也避免把 npx 依赖与失败面带到那些路径）。`browser_allowed()` 在无策略时返回 **False**（与 `mcp_allowed` 的 True 相反）。
- 官方信号：`browser_subagent.py:131-156`（`is_enabled`）；`admin_controls_manager.py:866-876`（`browser_allowed` 的 False 语义）；`server.py:4445-4452`（`subagents_enabled` 与 `browser_enabled` 的构造）。
- 官方不做什么：不在非企业路径「尽力尝试」；不因客户端请求而开启。
- Paseo 适配：未接（Paseo 不是企业 path，官方不会注入）。
- 适配状态：官方条件不满足

### H02. `chrome_devtools` MCP 的定义
- 官方做什么：`name="chrome_devtools"`，命令 `npx`，参数 `-y`、`chrome-devtools-mcp@>=1`、`--no-usage-statistics`、`--no-performance-crux`；**刻意不用** `@latest`（公司镜像的 `dist-tags.latest` 卡在 bin-less 的 `0.0.1`），也不用 `--autoConnect`/`--browserUrl`/`--wsEndpoint`（让 MCP 自己拉起 Chrome，零配置）。服务端不打包任何浏览器二进制，唯一前置是 PATH 上的 Node.js。
- 官方信号：`browser_subagent.py:60-98`（常量与理由）；`browser_subagent.py:245-286`（`build_mcp_server`）。
- 官方不做什么：不打包浏览器；不连用户已开的调试 Chrome；不发统计。
- Paseo 适配：未接（企业分支）。
- 适配状态：官方条件不满足

### H03. 浏览器 JS 执行策略
- 官方做什么：`javascript_execution_policy` 三态作用于**唯一一个**任意 JS 工具 `evaluate_script`：`DISABLED` 从工具面剔除（`disabled_tools=["evaluate_script"]`）；`REQUEST_REVIEW` 保留工具但把 `chrome_devtools/evaluate_script` 挂成需要 ACP 权限提示的策略目标；`NOT_ENFORCED` 不限制。`UNSPECIFIED` 归一化为 `DISABLED`。其它浏览器工具（navigate/click/screenshot/DOM/网络读）不执行页面作者的 JS，不受此策略管。
- 官方信号：`browser_subagent.py:46-50`（策略目标常量）；`browser_subagent.py:158-180`（`js_policy`）；`browser_subagent.py:227-243`（`requires_js_review`）；`browser_subagent.py:276-283`（DISABLED 时剔除）；`server.py:4498-4505`（请求复核时插 `ask_user` 规则，前插以压过 `safe_defaults` 的只读 allow）。
- 官方不做什么：不把策略做成工具过滤（`DISABLED` 走 MCP 的 `disabled_tools`，不是 `enabledTools`）；不审计其它浏览器工具。
- Paseo 适配：未接。
- 适配状态：官方条件不满足

### H04. 浏览器导航允许列表（网络层）
- 官方做什么：管理端 `browser_actuation_allowed_urls` 非空时，每条转成一个 URLPattern 并作为 `--allowedUrlPattern` 传入：只有 origin 的条目覆盖整个 origin（`https://host/*`），带路径的覆盖该路径及其后代（`https://host/path*`），裸主机默认补 `https`。空=不限制（proto 默认）。要求 Chrome 149+。
- 官方信号：`browser_subagent.py:182-225`（`allowed_urls` 与 `_to_url_pattern`）；`browser_subagent.py:270-274`（拼进启动参数）。
- 官方不做什么：不做正则/通配语法；不在服务端二次校验导航（网络层拦截）。
- Paseo 适配：未接。
- 适配状态：官方条件不满足

### H05. 启动前预检（npm 元数据探针）
- 官方做什么：注入前（在线程里，避免阻塞事件循环）用一次 `npm view chrome-devtools-mcp bin` 判断该包能否被 npx 跑起来——检查的是 `bin` 字段而不仅是版本，因为被 bin-less 版本骗过的场景真实存在。超时 8 秒，结果缓存 300 秒（TTL 而非进程级缓存，过期凭据修好或坏掉都能恢复）。预检失败就**跳过注入**、存一条一次性通知，让会话仍可用（否则 MCP 握手失败会被 harness 当致命错误，整个 prompt 都失败）。
- 官方信号：`browser_subagent.py:100-107`（超时/TTL/包名/缓存变量）；`browser_subagent.py:321-425`（`preflight_launcher`）；`browser_subagent.py:427-478`（`_classify_npm_failure`）；`server.py:4476-4495`（跳过注入、把通知暂存到 `_browser_notices`，b/548412678）。
- 官方不做什么：不因预检失败让会话创建失败；不无限重试探针。
- Paseo 适配：未接。
- 适配状态：官方条件不满足

### H06. 运行时失败的降级与单次重试
- 官方做什么：预检通过但运行时 MCP 起不来时，把该会话钉为「浏览器关闭」（`_browser_disabled_sessions`），给用户一条降级通知，重建 agent 并在同一轮重试一次；重试后仍失败就走普通错误。重建时若该会话已被钉住，不再重复注入同一个注定失败的启动器。失效时清空预检缓存，让下一个会话重新探测。
- 官方信号：`server.py:4456-4466`（`browser_runtime_disabled` 与 b/548412678）；`server.py:5660-5720`（`AntigravityExecutionError` 分支）；`server.py:4516-4528`（已钉住时的日志）；`browser_subagent.py:502-523`（`degraded_message`）；`browser_subagent.py:315-319`（`reset_preflight_cache`）。
- 官方不做什么：不无限重试；不在重试时换启动器。
- Paseo 适配：未接。
- 适配状态：官方条件不满足

### H07. 浏览器子 agent 的定义
- 官方做什么：`SubagentConfig(name="browser", description=..., system_instructions=...)`，`AgentBehavior.AUTONOMOUS`，允许工具白名单只含 `VIEW_FILE`、`SEARCH_DIR`、`FIND_FILE`、`FINISH`；`chrome_*` 工具在本 SDK 是 agent 全局的，所以不必列，而 `START_SUBAGENT` 不在白名单里 → 浏览器子 agent 不能嵌套。
- 官方信号：`browser_subagent.py:288-313`；`browser_subagent.py:113-129`（描述与 system instructions）。
- 官方不做什么：不让子 agent 再开子 agent；不给它写文件能力。
- Paseo 适配：未接。
- 适配状态：官方条件不满足

### H08. 浏览器错误的专用文案
- 官方做什么：两类识别——`is_browser_mcp_failure`（执行期启动失败，走「已降级」文案）与 `execution_error_message`（其它浏览器错误，抽出可读原因）；两者都非空时优先于通用错误渲染。
- 官方信号：`browser_subagent.py:525-559`；`server.py:5743-5756`（文案选择链）。
- 官方不做什么：不把浏览器错误混成通用 API 错误文案。
- Paseo 适配：未接。
- 适配状态：官方条件不满足

---

## I. 重试与错误

### I01. 「计划重试」只有一个信号源：harness 日志
- 官方做什么：计划重试**不通过 ACP 发出任何信号**。官方只把 Go harness 的一行日志转成 Python logging：`Encountered retryable api error. retrying in <duration>`（1.5.0 harness 在 `planner_generator.go:359` 每个重试计划打一行，`local_connection.py::_drain` 把每行转成 stdlib logging 记录）。普通 502 **不是**计划重试；重试是 harness 侧的决策与执行，ACP 只是旁观者。
- 官方信号：`local_connection.py:144-163`（`build_retry_config_proto`，仅当调用方给了 `RetryConfig` 才构造 proto）；`local_connection.py:1355-1358`（把 retry proto 挂进 harness config）；`/tmp/agy-audit-57c8.MDpA52/AUDIT.md`（实测：真 harness 在 `planner_generator.go:359` 决定 4 秒后重试，SDK `local_connection.py:553` 实际转发）。
- 官方不做什么：不发 `session/update`；不发 JSON-RPC error；不告知客户端「已计划重试」。
- Paseo 适配：HEAD 无（不识别该日志）。工作树：`paseo_model_compat.py` 用正则 `Encountered retryable api error\. retrying in (?P<delay>...)` 解析该日志模板，转成 kernel event（`assets/official-kernel-compat/rc01/paseo_model_compat.py:245-252`、`:470-509`、`:653-666`），connector 侧 `kernel-events.ts:41-94` 出 `model_retry_scheduled`，配套仓工作树显示 `kernel_model_retry_scheduled` 通知。生产旧客户端无此通道。
- 适配状态：有缺口（仅工作树；HEAD 与生产旧客户端都没有）

### I02. 官方从不注入自己的 `RetryConfig`
- 官方做什么：`_create_agent_config` 构造 `LocalAgentConfig`/`ProxyAgentConfig` 时不传 `retry_config`，`ProxyAgentConfig` 只是把调用方给的 `self.retry_config` 透传（默认 None）。因此 `build_retry_config_proto` 返回 None，harness 用**自己的默认**重试策略。也就是说重试次数、退避、哪些错误算可重试，都不由 ACP server 决定。
- 官方信号：`proxy_agent_config.py:132`（`retry_config=self.retry_config`）；`local_connection.py:144-163`（空配置返回 None）；`server.py:4677-4709`（`common_args` 里没有任何 retry 键）。
- 官方不做什么：不覆盖 harness 默认；不把重试参数暴露成 ACP 选项。
- Paseo 适配：不改写（工作树只读观察该决策，不替换策略）。
- 适配状态：已对齐

### I03. 连接断开的「重建并重试一次」
- 官方做什么：上一轮致命/取消可能让 localharness 死掉、websocket 以 1000 关闭，而 SDK 的 send 路径不包装它，所以下一轮 `agent.chat` 会抛裸 `websockets.ConnectionClosed`。官方重建一次 agent（新 harness + 新 websocket，历史从持久化轨迹重放）并重试本轮；**只允许一次**，第二次关闭就降级成干净文案。
- 官方信号：`server.py:5596-5616`（注释与 `rebuilt_once`）；`server.py:5624-5640`（`while True` 里的 `chat` 与步流）；`server.py:5653-5670`（`ConnectionClosed` 分支）；`server.py:5776-5795`（第二次关闭 → `_send_connection_lost_message`）。
- 官方不做什么：不无限重建；不把重建失败暴露成 -32603。
- Paseo 适配：透传（Paseo 只会看到重建后的正常 turn，或一条「连接丢失」文案）。
- 适配状态：已对齐

### I04. 终态异常的四级文案选择链
- 官方做什么：SDK 终态异常（`AntigravityExecutionError`/`AntigravityConnectionError`/`AntigravityValidationError`）先记完整异常到日志，再按顺序选文案：浏览器专用 → MCP 加载失败 → 配额耗尽 → 通用 API 净化文案；选中哪条就作为一条普通 `agent_message_chunk` 发给客户端，**不是 JSON-RPC error**，随后本轮以默认 `end_turn` 结束。
- 官方信号：`server.py:5733-5762`（catch 与文案链）；`server.py:4578-4584`（`_to_acp_stop_reason` 的默认分支决定了没有 response 时是 `end_turn`）。
- 官方不做什么：不发 JSON-RPC error；不把原始异常文本（含 `Details: [...]`）直接给客户端；不区分「错误正文」与「模型正文」的通道（两者都是 `agent_message_chunk`）。
- Paseo 适配：HEAD 无隔离。工作树：在已固定的可信异常处理调用点标出/抑制诊断正文（`paseo_model_compat.py` 的 `_SDK_TERMINAL_TEMPLATE`、`_CONNECTION_LOST_TEMPLATE`、`_REBUILD_FAILED_TEMPLATE`），保留正常模型正文与既有终态。**该隔离已用当前 compat `a7676978` 复验通过，仍是未提交工作树。** 生产旧客户端仍可能把 502 或容量错误显示成模型正文。
- 适配状态：有缺口（工作树已修，未提交、未进生产）

### I05. 上游诊断正文的净化规则（API 错误）
- 官方做什么：Go harness 会把整段 `google.rpc.Status`（含 `Details: [map[@type:...]]`，可能带内部 `DebugInfo`/`GeminiApiDebugInfo`）塞进异常字符串。官方用正则取出 `Error <code>, Message: <msg>, Status: <STATUS>` 里的公开 message；没有匹配就剥掉任何 `, Details: [...]` 块再包成「Agent execution error: ...」。唯一例外是把 `google.rpc.ErrorInfo` 里后端附带的用户动作（`VALIDATION_REQUIRED` 的 `validation_url`、`appeal_url` 且 `uiMessage=="true"`）追加成一行可点链接，且**只接受 https 且主机是 google.com 或其子域**。
- 官方信号：`api_errors.py:32-52`（三个正则）；`api_errors.py:55-91`（`_ErrorAction` 与两个动作）；`api_errors.py:94-100`（`_is_google_https_url`）；`api_errors.py:155-175`（`format_execution_error`）。
- 官方不做什么：不展示非 Google 域链接；不展示 DebugInfo；不翻译错误码。
- Paseo 适配：透传（净化后的文本到 Paseo；Paseo 侧不再二次净化）。
- 适配状态：已对齐

### I06. 配额耗尽的专用文案
- 官方做什么：只对 `oauth-personal` 计量（CCPA 路径）。从 `ErrorInfo` 的 `QUOTA_EXHAUSTED` 认出该错误，按 b/543949364 的措辞**重写**（因为这个界面不做升级推销，所以不编辑原文本而是重写），并尽量解析 `quotaResetDelay`/`quotaResetTimeStamp`（支持 Go duration 字面量如 `119h36m35.41909833s`）。
- 官方信号：`ccpa_connection/quota_errors.py:14-50`（正则与单位表）；调用点 `server.py:5755`。
- 官方不做什么：不对其它认证方式套用；不展示升级链接。
- Paseo 适配：透传。
- 适配状态：已对齐

### I07. HTTP 错误状态没有 ACP 通道
- 官方做什么：HTTP 层面失败时，`server.py` 里没有任何把状态码发成 ACP 通知的代码路径；可观测的只有（a）harness stderr 的日志行、（b）SDK 抛出的终态异常字符串、（c）上面 I04 的文案链。
- 官方信号：`server.py` 全文无 `http_code`/状态码通知构造；`server.py:5726-5762`（唯一的终态出口）。
- 官方不做什么：不发「HTTP 502」这类结构化通知。
- Paseo 适配：工作树的 `paseo_model_compat.py` 从 SDK SYSTEM error step 里读 HTTP 状态并上报 kernel event（`_HARNESS_STDERR_TEMPLATE` 等模板）；HEAD 无。
- 适配状态：有缺口（工作树提供，官方无）

### I08. 取消
- 官方做什么：`session/cancel` 是 notification，只取消当前 turn：找到会话就 `agent.conversation.cancel()`，找不到只记 warning 就返回。取消后 SDK 抛 `AntigravityCancelledError`，官方把它转成一条 `agent_message_chunk`（正文是异常文本）并记 `cancelled=True`，最终 `PromptResponse.stop_reason="cancelled"`。会话本身不释放。
- 官方信号：`server.py:3759-3772`（`cancel`）；`server.py:5722-5741`（取消分支）；`server.py:5815-5820`（返回 `cancelled`）。
- 官方不做什么：不释放会话；不发 JSON-RPC error；不保证取消立即生效（取决于 SDK）。
- Paseo 适配：透传（适配器转发 `session/cancel`；工作树另有「决策后取消」复验记录，见 `/tmp/agy-audit-57c8.MDpA52/AUDIT.md` 的 cancel 用例）。
- 适配状态：已对齐

### I09. stopReason 映射表
- 官方做什么：SDK → ACP 固定映射：`UNSPECIFIED`→`end_turn`；`MAX_INPUT_TOKENS_EXCEEDED`/`MAX_OUTPUT_TOKENS_EXCEEDED`/`MAX_TOTAL_TOKENS_EXCEEDED`→`max_tokens`；`MAX_MODEL_CALLS_EXCEEDED`/`MAX_TOOL_CALLS_EXCEEDED`→`max_turn_requests`；`QUOTA_EXHAUSTED`→`refusal`；字符串若是合法 ACP 值原样返回；其余 `end_turn`。
- 官方信号：`server.py:1625-1653`。
- 官方不做什么：不发明新 stopReason；不把未知值当错误。
- Paseo 适配：透传（配套仓工作树在 `promptWasCancelled` 且 `end_turn` 时做本地改写，属 Paseo 侧补齐，不是官方行为）。
- 适配状态：已对齐（官方侧）

### I10. 错误码族
- 官方做什么：`-32000` 需要认证（含注销后继续用旧会话、`auth_required`）、`-32001` 企业管控校验失败（`admin_controls_verification_failed` 或 `admin_controls_permission_denied`）、`-32002` 资源不存在（会话/轨迹）、`-32602` 参数非法（未知模式/未知选项/值类型/模型不可用/不支持的方法）。
- 官方信号：`server.py:75`、`server.py:707`；`admin_controls_manager.py:82-92`（`-32001` 与两个 reason）；`server.py:2757-2770`、`server.py:2905-2932`（`-32000`/`-32002`/`-32602` 用法）。
- 官方不做什么：不复用 HTTP 码；不在 -32603 里塞业务信息（连接类错误已改成干净文案）。
- Paseo 适配：透传错误码（Paseo 侧如何映射 UI 属 Paseo）。
- 适配状态：已对齐

---

## J. 用量与 tier

### J01. 上下文占用 `usage_update`
- 官方做什么：每轮结束（以及切换模型、恢复会话）读一次主轨迹累计用量，算出「本次上下文占用」增量并发 `usage_update{used,size}`。分母来自 A12 的三级来源，未知就不发。读之前先 `await asyncio.sleep(0)`，让 WebSocket 读循环把紧跟在 StepUpdate 后的 UsageUpdate 吃进来，否则会读到旧值并把两次模型调用累加。零增量不发（会把客户端的上下文条清空）。
- 官方信号：`server.py:6363-6392`（`_observe_usage` 与那条 sleep 的理由）；`server.py:6394-6435`（`_report_context_usage`）；`token_usage_tracker.py:76-115`（`on_current_usage_updated` 的增量与零值处理）；`token_usage_tracker.py:148-169`（`_tokens_in_memory`：`total` 优先，否则 prompt+candidates+thoughts）。
- 官方不做什么：不猜分母；不发 0；不在每次 token 变化时发（只在观察到新值时）。
- Paseo 适配：透传（Paseo 的上下文占用条吃这个通知）。
- 适配状态：已对齐

### J02. `PromptResponse.usage` 的每轮增量
- 官方做什么：每轮响应带 `usage`，是「本轮开始时的累计」与「当前累计」之差；若当前小于开始（例如上下文被压缩），返回 None 而不是负数。`input_tokens` 是**净未缓存**输入（prompt 减去 cached），`output_tokens` 含 thinking，`cached_write_tokens` 恒 0（TODO b/580701726 尚未打通）。
- 官方信号：`token_usage_tracker.py:116-146`（`on_turn_started`、`get_current_turn_usage`）；`token_usage_tracker.py:171-217`（`_to_acp_usage` 的字段语义与 TODO）。
- 官方不做什么：不把 cached 重复计进 input；不在压缩后发负数。
- Paseo 适配：透传。
- 适配状态：已对齐

### J03. `/usage` 命令在服务端拦截，不触发模型
- 官方做什么：prompt 文本以 `/usage` 开头（后面必须是结尾或空白）时，官方在会话查找之后、agent 调用之前拦截，读当前用量、查配额、拼一段 markdown（`### Session Usage` + `### Quota Limits`）作为一条 `agent_message_chunk` 发回，并直接 `end_turn`。带参数则回「/usage takes no arguments, got ...」。设计意图是零延迟、零 token 成本。
- 官方信号：`server.py:3385-3462`（`_handle_usage_command`）；`server.py:5532-5533`（拦截点：`is_usage_prompt` → 直接返回）；`usage.py:19-46`（`is_usage_prompt`/`usage_prompt_arguments`）；`usage.py:206-272`（`format_usage_message`）；`usage.py:78-204`（`_format_limits`：`remainingFraction` 优先，其次 `remainingAmount`，都没有则 `Available`；`disabled` 桶显示 Disabled）。
- 官方不做什么：不调模型；不在非 OAuth 路径查配额（显示「Not applicable for current authentication method.」）；不打升级推销。
- Paseo 适配：透传（Paseo 把这段 markdown 当普通正文渲染）。
- 适配状态：已对齐

### J04. 配额查询的两个后端
- 官方做什么：`oauth-business` 走 BAIC `fetch_quota_status`（项目/位置/`user_tier`/license location）；`oauth-personal` 走 CCPA `retrieve_user_quota_summary`（需要 project_id，未 onboard 则报「User not onboarded (no project ID)」）；其它认证方式直接跳过。任一路失败都把异常文本降级成「Unable to retrieve quota status (...)`」，不让 `/usage` 失败。
- 官方信号：`server.py:3318-3383`（`_fetch_quota_data`）；`server.py:3385-3400`（business 分支的前置检查）。
- 官方不做什么：不在 API key/gateway/agent-platform 上强行查；不因配额查询失败而中断命令。
- Paseo 适配：透传（Paseo 只在 OAuth 账号上有这段内容）。
- 适配状态：已对齐

### J05. 会话累计用量的读取路径
- 官方做什么：从 `agent.conversation` 读主轨迹（`_main_trajectory_usage`）的累计 `UsageMetadata`；无 conversation 或读失败都返回 None（不抛）。恢复会话时把读到的值灌进 tracker 作为基线，避免把历史算进第一轮。
- 官方信号：`server.py:1597-1624`（`_main_trajectory_usage`）；`server.py:6331-6362`（`_read_current_usage`）；`server.py:4102-4105`（恢复时 `on_session_restored`）。
- 官方不做什么：不读子 agent 轨迹；不持久化自己的计数（以轨迹为准）。
- Paseo 适配：透传。
- 适配状态：已对齐

### J06. tier 元数据 `_meta.antigravity.tier`
- 官方做什么：`initialize` 的能力位里声明 `_meta.antigravity.tier=true` 与 `_meta.antigravity.systemPrompt.append=true`；在 `authenticate`、`session/new`、`session/load`、`session/resume` 的响应里带 `_meta.antigravity.tier = {name, id, upgradeUri}`。tier 为空（`name` 与 `id` 都空）时整段 `_meta` 省略。企业路径取 license 的 `tier_display_name`/`user_tier`；personal 路径取 OAuth manager 的 `tier_info`；其余方法返回空。
- 官方信号：`tier_info.py:8-36`（`TierInfo.is_empty`、`to_dict` 的嵌套形状）；`server.py:2700-2708`（能力位）；`server.py:3521-3542`（`_get_tier_info`、`_tier_metadata`）；`server.py:3191`、`server.py:3756`、`server.py:4148`、`server.py:4250`（四处挂载点）。
- 官方不做什么：不在空 tier 时发空对象；不提供配额数值（tier 只有名字/id/升级链接）。
- Paseo 适配：透传（Paseo 是否展示 upgradeUri 属 Paseo 侧）。
- 适配状态：已对齐

---

## K. 官方条件不满足的能力（汇总，避免误读为缺口）

### K01. 第三方模型目录
- 官方做什么：只对 7 个客户端开启（B01）；无追加白名单入口；Paseo 的 `clientInfo.name="Paseo"` 不在名单内，官方恒发 Gemini-only。
- 官方信号：`model_selection.py:33-57`；`model_selection.py:418-424`；实测 `/tmp/agy-c13-c41.yFi4LTTz/results.json` 两侧非 Gemini 数量均为 0。
- 官方不做什么：不为未知客户端提供任何升级路径。
- Paseo 适配：适配器已删除覆盖过滤的补丁（工作树），接受官方行为；`SUPPORTED_NON_GEMINI_MODEL_IDS` 仅剩 proxy 侧请求变换用途。
- 适配状态：官方条件不满足

### K02. 浏览器子代理（全套 H01–H08）
- 官方做什么：仅 `oauth-business` + 管理端 `browser_enabled`。
- 官方信号：`browser_subagent.py:131-156`；`admin_controls_manager.py:866-876`。
- 官方不做什么：不在其它路径注入。
- Paseo 适配：未接。
- 适配状态：官方条件不满足

### K03. 企业管理员管控全套（C13–C15、F06、H*）
- 官方做什么：只在「已解析 GE 许可证」的会话上生效（`admin_controls_applicable` 要求 `user_tier` 与 project/location 齐备）；`FetchConfig` 拉取，5 分钟后台轮询，`5xx/408/429` 与网络错误回落 Safe Defaults，`401/403` 与其它 4xx 阻断会话创建（`-32001`），重建会话时才重放「已烤进 agent」的策略（MCP/浏览器/沙箱），文件访问与终端策略则每次调用实时读。
- 官方信号：`admin_controls_manager.py:25-30`（300 秒轮询与「刻意不做 TTL 缓存」）；`admin_controls_manager.py:225-320`（`AdminControls` 字段与 `safe_defaults`）；`admin_controls_manager.py:292-320`（Safe Defaults 的取值）；`admin_controls_manager.py:741-760`（阻断 vs 回落）；`server.py:2182-2260`（`_maybe_refresh_admin_controls_for_turn` 的三类重建条件）。
- 官方不做什么：不在非 entitlement 会话上「尽量套用」；不在策略变更时无条件重建（只有 MCP/浏览器/沙箱变化才重建）。
- Paseo 适配：未接。
- 适配状态：官方条件不满足

### K04. AI API Gateway 认证
- 官方做什么：三重条件同时成立才出现：`AGY_ACP_ENABLE_GATEWAY_AUTH` 为真、客户端在 `clientCapabilities.auth._meta.gateway` 显式opt-in、且 `admin_settings.json` 策略没把它禁掉/强制掉。若策略是 REQUIRED，则 `initialize` **一个认证方法都不公布**（策略已自动认证，`_infer_auth_state` 在 session/new 解析）。
- 官方信号：`server.py:2634-2680`（条件构造与三种策略处置）；`gateway/gateway.py:18-36`（env gate）；`server.py:948-990`（`_infer_auth_state` 的 REQUIRED 分支）。
- 官方不做什么：不在未opt-in时公布；不在未设 env 时启用；不把 gateway 写进 `settings.json`（`logout` 对 gateway 明确「没有可登出的东西」）。
- Paseo 适配：未接。
- 适配状态：官方条件不满足

### K05. Agent Platform 专属模型（A02）
- 官方做什么：仅 Agent Platform 认证路径。
- 官方信号：`model_selection.py:126-141`、`model_selection.py:190-195`。
- 官方不做什么：不在其它路径出现。
- Paseo 适配：未接。
- 适配状态：官方条件不满足

### K06. CCPA 动态目录 / 配额 / tier 的 OAuth 前提
- 官方做什么：`oauth-personal` 才有动态目录与 CCPA 配额；`oauth-business` 才有 BAIC 配额与 license tier。
- 官方信号：`model_selection.py:700-730`（OAuth 分支才 `fetch_available_models`）；`server.py:3341-3383`（两路配额）。
- 官方不做什么：不在 API key 路径联网取目录。
- Paseo 适配：透传（Paseo 走哪个认证由用户在 Paseo 里选）。
- 适配状态：官方条件不满足

### K07. 图像模型的分支差异（A13）
- 官方做什么：按认证方式换绑，OAuth/企业各一个，其余用 SDK 默认。
- 官方信号：`server.py:1177`、`server.py:1182`、`server.py:4700-4760`。
- 官方不做什么：不让用户选图像模型。
- Paseo 适配：透传。
- 适配状态：官方条件不满足

### K08. 官方自身未接线：管理端模型允许列表
- 官方做什么：`AdminControls.allowed_models` 会被解析、存进冻结数据类，`AdminControls.is_model_allowed()` / `AdminControlsManager.is_model_allowed()` 也实现了（支持把 `projects/.../models/xxx` 归一化成最后一段再比对）。**但 `server.py` 全文没有任何地方调用 `is_model_allowed`，也没有任何地方读 `allowed_models`**（`grep -rn "is_model_allowed\|allowed_models" *.py` 的命中全部在 `admin_controls_manager.py` 内）。也就是说 1.5.0 的 ACP server 解析了这条企业策略却没有执行它。
- 官方信号：`admin_controls_manager.py:123-137`（`normalize_model_id`）；`admin_controls_manager.py:370-395`（`AdminControls.is_model_allowed`）；`admin_controls_manager.py:815-828`（管理器版）；`server.py`（无引用）。
- 官方不做什么：不按允许列表过滤 `configOptions`；不拒绝不在列表里的模型切换。
- Paseo 适配：不适用（Paseo 侧无企业策略）。
- 适配状态：官方条件不满足（官方自身未接线；不是 Paseo 的缺口）

### K09. 工作区 hooks 需要信任
- 官方做什么：`trusted` 才加载；`unknown` 会问一次；`AGY_ACP_DISABLE_WORKSPACE_TRUST` 可整体关闭。
- 官方信号：`hooks.py:365-431`；`workspace_trust.py:17-41`。
- 官方不做什么：不在未信任时加载。
- Paseo 适配：透传（Paseo 会收到那次信任询问）。
- 适配状态：官方条件不满足

### K10. 计划重试对客户端完全不可见（I01）
- 官方做什么：只在 harness 日志里。
- 官方信号：`/tmp/agy-audit-57c8.MDpA52/AUDIT.md`；`local_connection.py:144-163`、`local_connection.py:1355-1358`。
- 官方不做什么：不发 ACP 信号。
- Paseo 适配：工作树解析日志模板并上报（未提交）。
- 适配状态：官方条件不满足

---

## L. 统计

按上文 `### 编号` 逐条计数（不含本节与第 0 节）：

| 运行族 | 条数 |
|---|---|
| A 模型与思考档（A01–A15） | 15 |
| B 第三方过滤（B01–B05） | 5 |
| C 模式与权限（C01–C18） | 18 |
| D 工具（D01–D10） | 10 |
| E 技能（E01–E05） | 5 |
| F MCP（F01–F09） | 9 |
| G hooks 与信任（G01–G11） | 11 |
| H 浏览器（H01–H08） | 8 |
| I 重试与错误（I01–I10） | 10 |
| J 用量与 tier（J01–J06） | 6 |
| K 官方条件不满足（K01–K10） | 10 |
| **合计** | **107** |

（K 族是对前面各族的条件性重述，因此存在与 A–J 的内容重叠；不另做「去重后条数」的估算，避免给出一个没有定义的数。）

按 5 个状态标签归并（把括注并入主标签）：

| 适配状态 | 条数 |
|---|---|
| 已对齐 | 73 |
| 官方条件不满足 | 25 |
| 有缺口 | 3 |
| 已知差异 | 3 |
| 非官方扩展 | 3 |
| **合计** | **107** |

「有缺口」的 3 条全部集中在 I01（计划重试）、I04（终态诊断正文隔离）、I07（HTTP 错误状态），且都只在**未提交工作树**里成立；HEAD 与生产旧客户端都没有。
「已知差异」的 3 条是 B01（第三方模型名单）、B03（过滤执行点的 HEAD 历史补丁）、E02（`SkillsConfig.TOOL` 的 HEAD 历史补丁）。其中 B03 与 E02 在正文里同时标了「已对齐（工作树）」，本表按 **HEAD**（即会发出去的那个提交）计入「已知差异」；若按工作树计，这两条应移入「已对齐」，则分布为 已对齐 75 / 官方条件不满足 25 / 有缺口 3 / 已知差异 1 / 非官方扩展 3。两种读法都在这里写明，避免下游只抄一张表而丢掉工作树与 HEAD 的区别。

---

## M. 我没有从源码确认、因此不敢写进正文的点

以下每一条我都明确「不知道」，而不是用推断填上。写进正文会把不确定当事实，所以单列在这里。

1. **`BuiltinTools.default()` 的确切成员表。** `google.antigravity` 包不在解包范围内。正文只列了在 `server.py`/`tools.py`/`tool_filter.py` 里**逐个出现过的**工具名（`view_file`、`create_file`、`edit_file`、`list_directory`、`search_directory`、`find_file`、`SEARCH_DIR`、`run_command`、`shell`、`search_web`、`read_url_content`、`ask_question`、`start_subagent`、`generate_image`、`finish`、`call_mcp_tool`），不能保证这就是全集，也不知道哪些是 `default()` 自带、哪些要显式补。
2. **`policy.safe_defaults(handler)` 的具体允许项。** 我只看到官方在它上面叠了 `ask_question`、`read_url_content`、`client_view_file`、文件访问与浏览器 JS 复核这几条，并读到注释说它「给只读工具 ALLOW、其余落到 `ask_user("*")` 通配」。它到底枚举了哪些只读工具、优先级分桶的确切规则，我没看到实现。
3. **Go harness 的 `planner_generator.go:359`。** harness 二进制与 Go 源码都不在解包范围内。正文里这一行号与「每个重试计划打一行」的说法，来自 `/tmp/agy-audit-57c8.MDpA52/AUDIT.md` 的既有取证记录与 `local_connection.py` 的转发注释，不是我这次亲眼读到的 Go 源码。`local_connection.py:553` 同理（引用自 AUDIT.md）。
4. **SDK SYSTEM error step 里的 `http_code` 字段。** 正文 I07 只说「`server.py` 没有发出状态码的路径」——这是我能确认的。`http_code` 是否存在、叫什么，来自适配器工作树的解析代码与 AUDIT.md，不在官方解包源码里。
5. **`/plan` 的 plan 产物与「等待用户批准」的真实行为。** `server.py` 只把它翻成 `SlashCommand(name=PLAN)`，产物生成与批准流程在 SDK/harness 里。正文只写了「官方不发 plan 事件」这一条可确认的事实。
6. **OAuth 登录的交互细节。** `oauth/oauth_manager.py`、`macos_keychain.py`、`credential_manager.py` 我只看了文件存在，没读内容。正文只写了「`authenticate` 会触发交互登录」「有 `_LOGIN_TIMEOUT_SECONDS` 这个量」这类从 `server.py` 注释放可读到的信息，没写浏览器回调端口、token 存储形状、keychain 行为。
7. **`ccpa_connection/` 与 `baic_connection/` 的内部。** 除了 `quota_errors.py`，这两个包我只在 import 与调用点层面读过（`fetch_available_models`、`retrieve_user_quota_summary`、`fetch_quota_status`、`fetch_config` 的签名与用途）。端点 URL、重试、鉴权头、错误码，未读。
8. **`gateway/` 包除 `auth_enabled()` 之外的部分。** `resolution.py`、`admin_settings.py`、`model_discovery.py`、`model_catalog.py` 没读。正文 A14 只写了 `server.py`/`model_selection.py` 里可见的调用契约（谁优先、谁不做自补），没写 `admin_settings.json` 的字段形状。
9. **`AUTH_METHOD_API_KEY` 的字面量。** 我读到的 `server.py:692` 在本次会话里被工具替换成了占位符（`gemini-api-key` 形态）。从 `server.py:883`、`:944`、`:1076`、`:1100`、`:1124` 的文档字符串可以确认这个 id 是 `gemini-api-key`，但**我没有直接看到那一行的字面量**，所以正文一律写 `gemini-api-key` 并在此标注来源是通过注释间接确认的。
10. **`session_store` sidecar 的完整键集。** 我确认了 `cwd`、`additional_directories`、`mode_id`、`tool_filter`、`allowed_tool_calls`、`allowed_tools_workspace` 六个键在写入侧，但没穷举读取侧是否还有其它键（`read_sidecar_metadata` 只被部分调用点读过）。
11. **`tools.py` 里 `make_client_view_file`/`make_client_create_file`/`make_client_edit_file` 的逐行实现。** 我读了它们的签名、`defer_scope` 语义与限额常量，没读完整的路径校验与返回结构，因此正文 C16/D04 只写「注入条件」与「输出格式层面的常量」，没写它们各自的参数约定。
12. **`telemetry.py` 的事件表。** 我只看到 `record_inference_resolved`、`record_inference_interaction`、`enqueue_event` 等接口名与 `BaicTelemetryDispatcher` 的启动条件（`initialize` 里 `start()`），没读事件字段与上报目标。正文没有把 telemetry 作为能力条目列出——这不代表它不存在，只代表我没取证。
13. **`acp` schema 包的字段语义。** `Usage` 各字段的官方定义、`PermissionOption.kind` 的取值集合、`ToolCallStatus` 的枚举，我都按 `server.py` 的用法描述，没读 schema 源码。
14. **Paseo 侧（配套仓）的渲染与投影行为。** 正文凡涉及「Paseo 如何显示」的地方，只写了我在适配器仓（`ACP Connector/official-kernel/*.ts`）里读到的线路行为；配套仓 `maacs-app/`、`paseo/packages/*` 的投影、timeline、通知渲染，除工作树 `git status` 列出的文件名外，我没读实现，正文统一标「未核实」。
15. **`acp-agent.ts` 等生产客户端在旧版本上的实际表现。** 正文说「生产旧客户端仍可能把 502 显示成模型正文」，依据是 `docs/research/2026-11-19-official-capability-ledger.md` 的记录与我读到的官方无隔离事实，不是我复现的。
16. **`mcp-protocol-bridge.ts` 与 `skill-mcp.ts` 的桥接细节。** 我知道适配器把 http(s) MCP 经本地桥转发、把技能暴露成 MCP，但没读这两个文件的实现，正文 F02/E01 因此只写了「协议形状对齐」与「这是扩展」。
17. **HTTP 502 场景下 4 秒后端点收到第二个请求这一现象**，我引用的是 AUDIT.md 的实测记录，不是本次我自己的运行结果（本席禁发真实推理）。
