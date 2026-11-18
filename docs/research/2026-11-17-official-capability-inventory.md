# 官方 agy_acp_server 1.5.0 能力盘点

日期：2026-11-17（America/Los_Angeles）。只读研究，不修改产品代码、生产配置或账号；不提交、不推送、不委派。

本文只描述**官方 ACP 服务端**公开能力与实作，不判断 Paseo 当前是否已支持；需要 Paseo 侧核对的项目统一放在第 19 节。

## 0. 结论摘要

- 官方独立分发 `antigravity-acp` 当前版本为 **1.5.0**（官方 Registry CDN 与 GitHub registry 均一致）。本地 `/tmp/agy-acp-150-audit/official.zip` 的 SHA-256 与 Registry 的 linux-x86_64 条目完全一致，可视为已核验官方 1.5.0 产物。
- 官方 server 实作 **12 个公开 ACP 接口（11 个请求 + 1 个通知）**：`initialize`、`authenticate`、`logout`、`session/new`、`session/load`、`session/resume`、`session/list`、`session/set_mode`、`session/set_model`（superseded）、`session/set_config_option`、`session/prompt`、`session/cancel`（notification）。
- **`session/close` 不是“base SDK 默认空操作”**：ACP SDK 协议声明了 `close_session` 和 `sessionCapabilities.close`，但官方 server 既不声明也不实作；路由层对未实作的非 optional 路由返回 **-32601 Method not found**。`session/delete`、`session/fork`、`providers/*`、`nes/*`、`document/*`、`mcp/message`、`ext_method` 同理。
- 能力声明中，`loadSession`、`session/list`、`session/resume`、`additionalDirectories`、`logout`、`mcp.http`/`mcp.sse`、`prompt.image`/`prompt.audio`/`prompt.embeddedContext` 均为 `true`；`mcp.acp` 未声明，`session.close`/`delete`/`fork` 未声明。
- **没有原生 `plan` session mode。** 独立 1.5.0 只有 `default`、`auto_edit`、`yolo` 三种会话模式；`/plan` 是提示词层的内建 slash command（生成计划并等待批准），不是 `session/set_mode` 的取值。未知 mode 直接 **-32602 Invalid params**。官方 Antigravity CLI 1.5.0 的 release notes 另行声明 `agy acp` 提供 `default`、`accept-edits`、`plan` 三种模式——那是**另一个实现/另一个分发物**，不能直接当作本 1.5.0 PAR 的行为。
- **第三方模型过滤是官方 1.5.0 的硬限制。** OAuth consumer/business 的 CCPA 模型列表中，非 `gemini*` 模型只对固定客户端白名单开放（JetBrains、JetBrains Air、Android Studio、Android Performance Analyzer、Zed、Xcode、T3 Code）；未识别客户端或未发送 `clientInfo` 的客户端只看到 Gemini。官方 CLI 1.5.1 changelog 明确说 `agy acp` 已改为“向所有 ACP 客户端提供账号可用的全部模型”，再次证明 1.5.0 的过滤是产品行为，不是解析 bug。
- **`systemPrompt` 只有 append。** 能力位声明 `_meta.antigravity.systemPrompt.append = true`；服务端只从 `session/new|load|resume` 的 `_meta.antigravity.systemPrompt.append` 提取字符串并追加给 harness。没有替换模式、没有逐轮更新 RPC、没有 ext 方法。
- **音频/资源确实被消费，但有边界。** `_parse_prompt` 实际处理 `text`、`resource_link`、`image`、`audio`、`resource` 五种 block；音频/图片会 base64 解码后传给 SDK。解码失败只记 warning 并丢弃该 block，不回错误。`resource_link` 是服务端本地按路径读文件（`from_file`），读不到时退化为把原始路径字符串交给模型，不是通过客户端读取。
- **交互问答没有独立 ACP 原语，也没有 `_meta` 结构。** 官方把每个问题渲染成一次 `session/request_permission`：`tool_call.title` 承载问题文本，`options[]` 承载选项，`kind` 只在 `allow_once`/`reject_once` 之间二选一。协议返回结果只能选一个 `optionId`（`AllowedOutcome`）或返回 `cancelled`（`DeniedOutcome`，没有 `optionId` 字段）。SDK 的 `AskQuestionEntry.is_multi_select` 被忽略，多选不支持（官方 TODO b/524989454）。没有自由文本“Other”。

## 1. 版本与证据基线

| 项目 | 值 | 证据 |
| --- | --- | --- |
| 官方 Registry 版本 | `antigravity-acp` 1.5.0 | 2026-11-17 实时拉取 `https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json`；`https://raw.githubusercontent.com/agentclientprotocol/registry/main/antigravity-acp/agent.json` |
| 官方 linux-x86_64 归档 | `agy-acp-server-1.5.0-linux-x86_64.zip` | 本地 `/tmp/agy-acp-150-audit/official.zip`，274,069,093 bytes |
| 归档 SHA-256 | `36f373e8948edf1727b39c7d62b5722d6a4474bdfd72b04ad3d6def571808c9f` | 与 Registry `distribution.binary.linux-x86_64.sha256` 完全一致 |
| 解包 PAR | `/tmp/agy-acp-150-audit/runtime/agy_acp_server.par` | SHA-256 `8a35f63dd2284e3790a1d97dd0cb2236057c55a0c598b26f3bde022b843d5c04` |
| PAR 内 `_version.py` | `__version__ = "1.5.0"` | PAR `google3/cloud/developer_experience/antigravity_extensions/acp_server/_version.py` |
| 官方 server 源码 | `server.py` 6651 行 | 解包为 `/tmp/agy-acp-150-audit/server-0.py`；SHA-256 `c4a5909af7ba15079309a67012014d071c608ac920ab229f3a2344f21383e4fb`，与 PAR 内 `server.py` 一致 |
| 捆绑 ACP SDK | schema ref `schema-v1.23.0`，协议版本 1 | PAR `google3/third_party/py/acp/meta.py:1-2,50` |
| 运行入口 | `main.py`，`acp.run_agent(agent, use_unstable_protocol=True)` | PAR `main.py:138-140` |

说明：官方 Registry 索引的 `version: "1.0.0"` 是 Registry 文档 schema 版本，不是 agent 版本；`agents[].version` 才是 `1.5.0`。

本文所有 `server.py:NNN` 均指上述已核验的 1.5.0 PAR 内源码；`config_options.py`、`model_selection.py` 等同理，均为 PAR 内同名模块。PAR 可直接用 `zipfile` 读取。

**范围外**：父任务提到的本机 CLI 依赖 `@getpaseo/server@0.16.0` 是 Paseo 侧客户端/服务端版本，不是 Google 的 `agy_acp_server` 版本；本文不把它当作官方 ACP 服务端版本证据。

## 2. 公开 ACP 方法总表

ACP SDK 的 agent 方法面来自 `meta.py:3-33`（29 个），但“协议有声明”不等于“本 server 实作”。本 server 通过 `Agent` protocol 建路由；具体方法缺失时路由返回 -32601（`acp/router.py:61-65,150-152,235-237`）。

| 方法（wire） | SDK 定义 | 本 server 实作 | 行号 | 说明 |
| --- | --- | --- | --- | --- |
| `initialize` | `interfaces.py` | 是 | `server.py:2576` | 返回能力、认证方法、agentInfo |
| `authenticate` | 是 | 是 | `server.py:2966` | 4 种标准方法 + 条件 gateway |
| `logout` | 是 | 是 | `server.py:3193` | 清凭据并拆除活跃会话 |
| `session/new` | 是 | 是 | `server.py:3631` | 创建会话，返回 configOptions/models/modes/_meta |
| `session/load` | 是 | 是 | `server.py:4209` | 恢复并**重放历史** |
| `session/resume` | 是 | 是 | `server.py:4112` | 恢复但**不重放历史** |
| `session/list` | 是 | 是 | `server.py:3828` | 有 `cursor` 形参但忽略，无分页 |
| `session/set_mode` | 是 | 是 | `server.py:2718` | 仅 default/auto_edit/yolo |
| `session/set_model` | 是（SDK 标记 unstable） | 是（superseded） | `server.py:2759` | 仍工作；引导客户端用 configOptions |
| `session/set_config_option` | 是 | 是 | `server.py:2881` | model/thinking_level/mode |
| `session/prompt` | 是 | 是 | `server.py:5499` | 流式 session/update；返回 stopReason/usage |
| `session/cancel` | notification | 是 | `server.py:3759` | 调用 SDK cancel；不关闭会话 |
| `session/delete` | 是（SDK 协议声明） | **否** | — | SDK `schema.py` 有 delete 能力；本 server 未声明/未实作 → -32601 |
| `session/fork` | 是（unstable） | **否** | — | → -32601 |
| `session/close` | 是（SDK 协议声明） | **否** | — | 见 2.1 节；→ -32601，不是空操作 |
| `providers/list`、`set`、`disable` | 是（unstable） | **否** | — | → -32601 |
| `nes/start`、`suggest`、`accept`、`reject`、`close` | 是（unstable） | **否** | — | → -32601 |
| `document/didOpen`、`didChange`、`didClose`、`didSave`、`didFocus` | 是（unstable notification） | **否** | — | → 路由不存在 |
| `mcp/message`（agent 方向） | 是（unstable） | **否** | — | 服务端不使用 MCP-over-ACP |
| `ext_method` / `ext_notification` | 是 | **否** | — | 无扩展方法处理器 |

补充：

- `main.py:140` 设置了 `use_unstable_protocol=True`，因此 `session/set_model`、`providers/*`、`nes/*` 等 unstable 路由不会被“unstable 开关”拒绝；但它们仍因 `AgyAdapter` 未实作而返回 -32601。
- `on_connect`/`on_disconnect` 是连接生命周期钩子，不是 RPC（`server.py:1726-1733`）。
- `cleanup(session_id=None)` 是内部清理函数，不是 ACP 方法（`server.py:3774`）。

### 2.1 `session/close` 能力边界（重点）

事实链：

1. ACP SDK 的 `Agent` protocol 声明 `close_session`，没有 `optional=True`（`acp/interfaces.py:470-471`）。
2. SDK schema 有 `SessionCloseCapabilities` 和 `SessionCapabilities.close`（`acp/schema.py:786,3189-3196`）。
3. 官方 server 的 `initialize` 只声明 `sessionCapabilities.list`、`resume`、`additionalDirectories`，**没有 `close`**（`server.py:2685-2691`）。
4. `AgyAdapter` 没有 `close_session` 方法（对 `server.py` 全文检索无 `def close_session`）。
5. 路由构建时找不到处理器 → `Route.handle` 对非 optional 路由抛 `RequestError.method_not_found`（`acp/router.py:61-65`），即 JSON-RPC **-32601**。

因此：**官方 1.5.0 既不声明也不实作 `session/close`；客户端调用会得到 Method not found，而不是“成功但无操作”。** 按 ACP 能力协商的客户端（例如 Paseo 0.16）在 `sessionCapabilities.close` 未声明时不会发 `session/close` RPC，而是直接关闭子进程；这是协议正确的 fallback，不应算作当前缺陷。只有无条件发送 `session/close` 的客户端才会收到 -32601。官方 server 唯一的会话级终止手段是：

- `session/cancel`（notification）：只取消当前 turn，不释放会话（`server.py:3759-3772`）；
- `logout`：清凭据并拆除所有活跃会话（`server.py:3193+`、`3239+`）；
- 客户端断开：`on_disconnect` → `cleanup()`（`server.py:1729-1733,3774-3827`）；
- 重新 `session/resume`/`load` 同一 session 时，旧会话栈被就地关闭（`server.py:3942-3957`）。

官方 Antigravity CLI 1.5.10 changelog 提到 `agy acp` 在“关闭会话”时停止子代理/后台任务，说明 **CLI 自己的 ACP 实现可能有 close 语义**；但这不是本 1.5.0 PAR 的源码，不能混同。此项列入待验/冲突（第 16、17 节）。

## 3. `initialize` 能力与认证方法

`server.py:2576-2716` 返回：

```json
{
  "protocolVersion": "<客户端发来的值原样回显>",
  "agentCapabilities": {
    "loadSession": true,
    "auth": { "logout": {} },
    "sessionCapabilities": {
      "list": {},
      "resume": {},
      "additionalDirectories": {}
    },
    "promptCapabilities": {
      "image": true,
      "audio": true,
      "embeddedContext": true
    },
    "mcpCapabilities": {
      "http": true,
      "sse": true
    },
    "_meta": {
      "antigravity": {
        "tier": true,
        "systemPrompt": { "append": true }
      }
    }
  },
  "agentInfo": {
    "name": "antigravity-acp",
    "title": "Google Antigravity",
    "version": "1.5.0"
  },
  "authMethods": [ ... ]
}
```

要点：

- **`protocolVersion` 是原样回显**（`server.py:2677-2678`），不校验、不协商、不升级。客户端发 1 就回 1；发不支持的值也照回。这是“声明与实作”的一个细节，不能理解为服务端做了版本协商。
- `loadSession=true` 对应 `session/load`（`server.py:4209`）。
- `sessionCapabilities` 只有 list/resume/additionalDirectories；没有 `close`、`delete`、`fork`。
- `promptCapabilities` 三项全 true，`_parse_prompt` 确实消费五类 block（第 11 节）。
- `mcpCapabilities` 只声明 http/sse；stdio 是 ACP 默认能力，不需要位；`acp` 未声明（SDK 默认 false），实际也不支持 MCP-over-ACP（第 9 节）。
- `_meta.antigravity.tier=true` 表示响应会带 tier 元数据；`systemPrompt.append=true` 表示只支持追加式系统提示。
- `authMethods` 顺序与条件（`server.py:2604-2676`）：
  1. `oauth-personal` — “Log in with Google”
  2. `oauth-business` — “Log in with Gemini Enterprise”
  3. `gemini-api-key` — “Gemini API key”
  4. `agent-platform` — “Gemini Enterprise Agent Platform”（旧 id `vertex-ai` 仍接受并归一化）
  5. `gateway` — 条件追加：`clientCapabilities.auth._meta.gateway == true` **且** 环境变量 `AGY_ACP_ENABLE_GATEWAY_AUTH` 启用 **且** 企业策略未禁止。策略 `REQUIRED` 时反而清空所有 authMethods；策略 `FORBIDDEN` 时去掉 gateway。gateway 方法带 `_meta.gateway = {"protocol":"google","restartRequired":"false"}`。
- 标准四种方法**不带** `_meta`；官方注释明确不给 IntelliJ 提示，避免其自带 key（b/543993211）。

## 4. `configOptions` 与 mode/model/thinking

`config_options.py` 是唯一 wire 形状来源。

### 4.1 三种 option

| option id | category | 类型 | 何时出现 | 行号 |
| --- | --- | --- | --- | --- |
| `model` | `model` | select | 总是 | `config_options.py:170-208` |
| `thinking_level` | `thought_level` | select | 当前 model 属于一个“有 ≥2 个变体”的 family 时 | `config_options.py:211-249` |
| `mode` | `mode` | select | 总是 | `config_options.py:252-274` |

- model option 的 `currentValue` 在有 family 时用 family id，否则用具体 model id。
- thinking_level 的取值来自 `ModelVariant.level`，排序 `minimal, low, medium, high, xhigh, extra_high, max`（`config_options.py:58-66`）。
- 每次 `session/set_config_option` 的响应都返回**完整的** configOptions（`server.py:2962-2964`），因为改一个 option 可能影响其他 option。
- 切换 `model` family 时保留当前 thinking level；新 family 没有该 level 时取最接近的，平局取更高；从无 level 的 model 过来时取新 family 的第一个变体（`config_options.py:376-431`）。
- 服务端自己因模型下架而替换模型时，发 `config_option_update` 通知（`server.py:2348-2387`，`config_options.py:299-315`）。用户主动 `set_config_option` 时不额外发通知，只靠响应带全量。
- `models` 和 `modes` 两个 superseded 字段仍随 new/load/resume 返回（`server.py:3751-3757,4143-4149,4246-4251`；`config_options.py:277-357`）。

### 4.2 模式集合与未知值

- 只有三种：`default`、`auto_edit`、`yolo`（`config_options.py:25-41`）。
- `session/set_mode` 对未知 mode 返回 **-32602** `Unknown mode id: ...`（`server.py:2738-2744`）。
- `session/set_config_option` 对未知 config id 返回 **-32602** `Unknown config option id: ...`（`server.py:2951-2955`）；对非字符串值返回 **-32602**（`server.py:2926-2930`）。
- **没有 `plan` mode。** `plan` 只出现在：
  - SDK 的 `BuiltinSlashCommandName.PLAN = "plan"`；
  - `_DESCRIPTION_BY_COMMAND` 对 `/plan` 的描述：“Plan carefully before executing a task (generates an implementation plan artifact and awaits user approval)”；
  - `_parse_prompt` 把文本里的 `/plan` 解析成 `sdk_types_module.SlashCommand(name=PLAN)`。
  - 证据：`server.py:1195-1213,1249-1280`。
- 因此：客户端若把 `plan` 作为 `session/set_mode` 的 modeId 发送，官方 1.5.0 会报 -32602；若在 prompt 文本里发 `/plan`，才会走 slash command。
- 官方 CLI 1.5.0 release notes 说 `agy acp` 有 `default`、`accept-edits`、`plan` 三种 session modes（`google-antigravity/antigravity-cli` 1.5.0）。这与本 PAR 的三模式集合**不一致**；属于不同分发物/不同实现的冲突证据，不能直接把 CLI 的行为写进独立 server 契约。详见第 16 节。

## 5. `session/update` 流

服务端发出的 update 类型（全部经 `self._client.session_update`）：

| `sessionUpdate` | 何时 | 关键字段 | 行号 |
| --- | --- | --- | --- |
| `agent_message_chunk` | 模型正文增量、错误文本、logout/usage/浏览器/引用提示、模型替换说明 | `content: TextContentBlock` | 多处，见下 |
| `agent_thought_chunk` | 模型 thinking 增量（仅根 trajectory 的 MODEL→USER 且非 ERROR） | `content: TextContentBlock` | `server.py:6029-6044` |
| `user_message_chunk` | **仅 `session/load` 历史重放**：user_input | `content: TextContentBlock` | `server.py:6513-6522` |
| `tool_call`（`ToolCallStart`） | 工具开始（权限前 pending，执行中 in_progress）；历史重放时直接 completed | `toolCallId,title,kind,content,locations,rawInput,status,_meta` | `server.py:5119-5132,5419-5428,6149-6162,6601-6614` |
| `tool_call_update`（`ToolCallProgress`） | 工具终态/权限帧推进/交互问答结束/未闭合清理 | `toolCallId,title,kind,content,locations,status,rawInput,rawOutput,_meta` | 多处 |
| `available_commands_update` | 新会话创建后、load/resume 后 | `availableCommands[]` | `server.py:5344-5379,3748,4104` |
| `usage_update` | 每次观察到新的模型调用 token 增量 | `used,size` | `server.py:6394-6434` |
| `config_option_update` | 仅服务端自动替换不可用模型时 | `configOptions[]`（全量） | `server.py:2361-2366` |

**未发出的 update**（虽然 ACP schema 有）：

- `plan` / `agent_plan_update` / `agent_plan_removed`：无任何发送点。规划只通过 `/plan` slash command 和工具产物体现。
- `current_mode_update`：无。模式变化只体现在 `set_config_option`/`set_mode` 的响应里。
- `session_info_update`：无。`session/list` 标题固定为 `Session <8位>`（`server.py:3864-3866`）。
- compaction 相关 update：无。`StepType.COMPACTION` 在 SDK 枚举中存在，但 `_stream_live_step` 只处理 thinking/content/tool calls，历史重放只处理 user_input/planner_response/tool call。
- `notice`：无。

**`agent_message_chunk` 的复用点**（说明它不总是“模型正文”）：

- 模型正文增量：`server.py:6045-6054`
- SDK 取消消息：`5716-5730`
- SDK 执行/连接/校验错误、MCP 加载失败、额度耗尽、浏览器失败：`5732-5767`
- 浏览器不可用/降级通知：`5547-5575,5686-5709`
- `/logout` 确认：`3307-3316`
- `/usage` 结果/参数错误：`3426-3463`
- 引用来源提示（仅 BAIC business）：`5863-5874`
- 模型被替换说明：`2369-2380`

这意味着：客户端不能把 `agent_message_chunk` 当作“可信的模型文本”而不看上下文；官方 1.5.0 把多类系统/错误信息也塞进同一通道。这与父任务诊断中“错误只能变成普通 assistant 文本”的观察一致。

**历史重放**（`session/load` 专属）：

- `user_input` → `user_message_chunk`
- `planner_response.thinking` → `agent_thought_chunk`
- `planner_response.modified_response || response` → `agent_message_chunk`
- `metadata.tool_call` → `tool_call`（status 直接 `completed`）+ `tool_call_update`（completed/failed）
- MCP 工具保留 `_meta` 与 content blocks；`search_web` 输出也按 content 渲染
- 证据：`server.py:6503-6651`

**历史重放不做的事**：不重放 usage、不重放 plan、不重放 compaction、不重放浏览器通知。

## 6. 客户端请求与功能协商

服务端**实际调用**的客户端方法只有：

| 客户端方法 | 用途 | 条件 | 行号 |
| --- | --- | --- | --- |
| `session/update`（notification） | 所有上述流 | 总是 | 多处 |
| `session/request_permission` | 工具审批、交互问答、workspace trust | 需要用户审批时 | `server.py:5226-5239,5431-5440` |
| `fs/read_text_file` | `client_view_file` 工具读客户端文件 | 仅当 `clientCapabilities.fs.readTextFile == true` | `server.py:4347-4360`；`tools.py:305-420` |
| `fs/write_text_file` | `client_create_file` / `client_edit_file` 写客户端文件 | 仅当 `clientCapabilities.fs.writeTextFile == true` | `server.py:4361-4378`；`tools.py:421-580` |

服务端**不调用**：

- `terminal/create`、`terminal/output`、`terminal/wait_for_exit`、`terminal/kill`、`terminal/release`：全文无调用点。命令执行在本地 harness 内完成，不借用客户端终端。
- `mcp/connect`、`mcp/disconnect`、`mcp/message`：服务端不使用 MCP-over-ACP。
- `elicitation/create`、`elicitation/complete`：不使用；交互问答走 permission（第 12 节）。

客户端能力读取方式：

- `initialize` 读取 `clientCapabilities.fs` 并缓存，用于决定是否注册 `client_view_file` / `client_create_file` / `client_edit_file`（`server.py:2584-2585,4347-4378`）。
- `initialize` 还读取 `clientCapabilities.auth._meta.gateway`：只有它为真时，`gateway` 认证方法才可能出现在 `authMethods` 中（还要叠加环境变量与企业策略；`server.py:2646-2652`）。
- `clientInfo` 被解析为 `ClientInfo(name,title,version,platform)`；`_meta.platform` 也读取（`client_info.py:61-162`）。用途是 User-Agent 和第三方模型白名单。
- 除上述 `fs`、`auth._meta.gateway`、`clientInfo._meta.platform` 外，没有读取其它能力位；`clientCapabilities.terminal` 明确未使用。

**重要**：`session/request_permission` 没有能力位，官方默认客户端必须实现。服务端没有 try/except 包裹这个调用；如果客户端返回 JSON-RPC 错误或断开，异常会上抛到 harness/外层，可能表现为工具失败或 turn 错误。精确条件：

- `yolo`：`_permission_handler` 对**所有工具**直接返回 True，不发 permission（但交互问答和 workspace trust 不走工具处理器，仍会发 permission）。
- `auto_edit`：只对 `AUTO_EDIT_TOOLS`（文件写/编辑类）自动返回 True；exec、web、读取等其它工具仍发 permission。
- `default`：所有需要审批的工具都发 permission。
- 交互问答（`ask_question`）与 workspace trust：无论 mode 如何都走 `session/request_permission`，因为它们在 `_ask_user_handler` 中直接调用，不受 `_permission_handler` 的 mode 分支控制。
- 因此，客户端完全不实现 permission 时，只有 `yolo` 的工具调用能继续；`auto_edit` 只覆盖编辑类工具，问答/信任/其它工具仍不可用。

## 7. 认证

### 7.1 方法 id 与条件

| id | 显示名 | 凭据来源 | 特点 |
| --- | --- | --- | --- |
| `oauth-personal` | Log in with Google | 交互式 OAuth（CCPA） | 可无 authenticate，在 `session/new` 触发登录（`server.py:3466-3479`） |
| `oauth-business` | Log in with Gemini Enterprise | 交互式 OAuth + license/project/location（BAIC） | 需要 `settings.json` 的 `gcp.project`/`gcp.location` 或管理员配置；仅此模式有 admin controls（`server.py:3536-3541,4711-4735`） |
| `gemini-api-key` | Gemini API key | 客户端 `_meta` key 或环境变量 `GEMINI_API_KEY` | key 缺失时 `authenticate` **仍返回成功**，错误推迟到 `session/new` 的 auth_required（b/555674644）（`server.py:3080-3092`） |
| `agent-platform` | Gemini Enterprise Agent Platform | `GOOGLE_API_KEY`，或 `GOOGLE_CLOUD_PROJECT`+`GOOGLE_CLOUD_LOCATION`，或 `settings.json` gcp.* | 旧 id `vertex-ai` 接受并归一化（`server.py:694-702,732-734,746-748`） |
| `gateway` | AI API Gateway | `_meta.gateway = {baseUrl, headers}` 或管理员配置 | 环境变量 + 客户端能力位 + 企业策略三重门控；per-connection，不持久化（`server.py:2604-2676,3110-3158`） |

### 7.2 `_meta` 认证结构

- API key：`_meta["api-key"]`、`_meta["apiKey"]`、`_meta["api_key"]`，值可以是字符串，或对象内嵌 `apiKey`/`api_key`/`api-key`/`key`（`server.py:736-760,3065-3079`）。
- Gateway：`_meta.gateway = { "baseUrl": "...", "headers": {"Authorization": "Bearer ..."} }`（`gateway/gateway.py:139-200`）。header 值在日志里 redact（`server.py:2986-2991`）。

### 7.3 认证状态推断与注销

- 客户端可以跳过 `authenticate`；`settings.json` 的 `auth.type` 可在 `session/new` 被 `_infer_auth_state` 采用（`server.py:2389-2408,3466-3479`；`settings.py:47-68`）。
- `logout` 声明在 `agentCapabilities.auth.logout`（`server.py:2681-2684`）；实现清除凭据、恢复未认证、拆除活跃会话（`server.py:3193-3290`）。`/logout` slash command 等价，且在 session lookup 之前处理（`server.py:5518-5521,3292-3316`）。
- 注销后，`session/new`、`prompt`、`set_config_option`、`set_mode` 都返回 **-32000 auth_required**，`data.reason="logged_out"`（`server.py:706-707,2437-2450,2728-2733,2916-2921,5524-5529`）。

### 7.4 错误码

| 码 | 含义 | 例子 | 行号 |
| --- | --- | --- | --- |
| `-32000` | auth_required | 未选择认证、已注销、Gemini Enterprise license 失败 | `server.py:707,1134-1135,2550-2566` |
| `-32002` | resource_not_found | 未知 session、恢复时找不到 trajectory | `server.py:1142,3926-3940` |
| `-32602` | invalid params | 未知 mode/config、非字符串 config 值、不支持的 auth 方法、gateway 策略拒绝 | `server.py:2741-2744,2926-2955,3027-3045,3160-3164` |
| `-32601` | method not found | 未实作的 ACP 路由（close/delete/fork/providers/nes/...） | `acp/router.py:61-65` |
| `-32603` | internal error | `prompt` 对未知 session 抛 `ValueError` 时由传输层映射 | `server.py:5530-5531` |

## 8. 命令（slash commands）

`available_commands_update` 在 new/load/resume 后异步发送（`server.py:5338-5379,3748,4104`）。命令集合：

| 命令 | 来源 | 行为 | 行号 |
| --- | --- | --- | --- |
| `/plan` | `BuiltinSlashCommandName.PLAN` | 生成实现计划 artifact 并等待用户批准（描述），作为 `SlashCommand` 传给 SDK | `server.py:1195-1213` |
| `/logout` | `logout.py` | 清凭据、拆除会话、返回 end_turn | `server.py:3292-3316` |
| `/usage` | `usage.py` | 拦截，不触发 LLM；返回 token/配额文本，end_turn | `server.py:3385-3464` |

没有 `/init`、`/compact`、`/help`、`/clear` 等其它命令；SDK 枚举只有 `PLAN`（PAR `google/antigravity/types.py`）。

`/usage` 细节：

- 读取会话累计 token（prompt/completion/thinking/cached，见 `token_usage_tracker.py`）。
- 仅 `oauth-business` 查 BAIC `FetchQuotaStatus`，`oauth-personal` 查 CCPA `RetrieveUserQuotaSummary`；其它 auth 方法跳过配额并显示“不适用”（`server.py:3318-3383,3401-3411`）。
- 带参数时返回用法错误文本（`server.py:3420-3435`）。
- 不会以 `stopReason` 之外的错误码失败；总是 end_turn。

## 9. MCP

### 9.1 客户端传入的 MCP server

`session/new|load|resume` 的 `mcpServers` 支持：

- stdio：`McpServerStdio`（command/args/env）
- HTTP：`McpServerHttp`（url/headers）
- SSE：`McpServerSse`（url/headers）
- **不支持** ACP MCP（`McpServerAcp`）：`to_sdk_mcp_config` 只接受 Stdio/Http/Sse，其它返回 None（`mcp_servers.py:56-113`）。
- 能力位只声明 http/sse；`mcp.acp` 未声明（`server.py:2697-2700`）。

### 9.2 合并与管理员控制

- 全局配置：`<gemini_home>/config/mcp_config.json`；支持 `{"mcpServers": {...}}` 或直接对象；文件不存在/解析失败只告警（`mcp_servers.py:160-231`）。
- 合并优先级：客户端同名覆盖全局（`mcp_servers.py:234-262`）。
- 企业 admin controls（仅 `oauth-business` 且已解析 manager）：
  - 可整体禁用 MCP：丢弃所有自定义 server，日志可见（`server.py:4270-4282`）。
  - 可 allowlist：未列出的 server 被丢弃，列出的可被管理员 command/args/url 覆盖；空 allowlist 表示允许全部；畸形 allowlist fail closed（`mcp_servers.py:265-306`）。
  - 浏览器内建 MCP 不受自定义 MCP 禁用影响（见第 15.4 节）。

### 9.3 eager/lazy 与输出

- 会话级 `_meta.antigravity.eagerMcpServers`：名称列表或逗号分隔字符串（`mcp_servers.py:31,116-130`）。
- 单 server `_meta.antigravity.forceAllToolsEager: true`（ACP v2 客户端可用；v1 用会话级列表）（`mcp_servers.py:56-90`）。
- `_meta.antigravity.mcpMaxOutputBytes`：正整数，控制 MCP 工具结果内联上限（`mcp_servers.py:35,133-157`）。
- 非 eager 工具经 `call_mcp_tool` envelope 调用；服务端会把 envelope 解包，`rawInput` 同时给出扁平参数和 `arguments` 嵌套（`tools.py:558-660`）。
- MCP 工具调用的 `_meta` 形状：`{"mcp": {"tool": "<tool>", "server": "<server?>"}, "is_mcp_tool_call": true}`（`tools.py:627-635`）。
- 内部 MCP schema 读取（读 schema 文件）被识别并**不发给客户端**（`server.py:418-482,6077-6083`）。
- MCP 加载失败有专门错误文案（`mcp_errors.py`）；浏览器 MCP 失败另有降级路径（第 15.4 节）。

## 10. 技能与 hooks

### 10.1 技能目录

`resolve_skills_paths(cwd, additional_directories)` 返回（`server.py:1468-1513`）：

1. `<gemini_home>/config/skills`
2. 每个项目目录（cwd + additionalDirectories）下的 `.gemini/skills`
3. `<gemini_home>/antigravity-cli/skills`
4. 每个项目目录下的 `.agents/skills`

这些目录同时进入 `allowed_dirs` 和 harness 的 `skills_paths`（`server.py:4330-4335,4704`）。**没有技能列表 RPC、没有技能变化通知**；发现与加载由 harness 完成。

### 10.2 Hooks

- 全局：`<gemini_home>/config/hooks.json`
- 工作区：`<cwd>/.agents/hooks.json`、`.agent`、`_agents`、`_agent`（`hooks.py:273-292`）
- 工作区 hooks 只有在 workspace trust 为 `trusted` 时才加载；`unknown` 时通过 permission 问题询问“Trust Workspace / Don't Trust”；`AGY_ACP_DISABLE_WORKSPACE_TRUST` 可绕过（`hooks.py:328-430`；`workspace_trust.py`）。
- 事件：PreToolUse、PostToolUse、PreInvocation、PostInvocation、Stop（`hooks.py:433,575,664,782,879`）。
- 这些是官方产品能力，但不是 ACP 公开方法。

## 11. 图像、音频、嵌入资源（实际解析，重点）

`_parse_prompt`（`server.py:1249-1403`）对 `session/prompt` 的每个 block 按 `type` 分支：

| ACP block type | 实际处理 | 结果 | 行号 |
| --- | --- | --- | --- |
| `text` | 拆分 `/plan` 等内建命令；普通文本拼接 | `str` 或字符串片段 | `1271-1280` |
| `resource_link` | `urlparse` 取 path + unquote → `sdk_types_module.from_file(path)`；`application/json` 重标为 `text/plain` | SDK Document；失败（`ValueError`/`OSError`）时**退回原始路径字符串** | `1281-1304`；MIME 重标 `1220-1246` |
| `image` | base64 解码 → `sdk_types_module.Image(data, mime_type)` | 传给 SDK；解码/校验失败**只记 warning 并丢弃该 block** | `1305-1321` |
| `audio` | base64 解码 → `sdk_types_module.Audio(data, mime_type)` | 传给 SDK；解码/校验失败**只记 warning 并丢弃该 block** | `1322-1338` |
| `resource`（embedded resource） | 有 `text` → 格式化字符串 `Embedded resource (uri):\n<text>`；有 `blob` 且 `image/*` → sdk Image；`audio/*` → sdk Audio；其它 MIME → warning 丢弃 | 文本/Image/Audio | `1339-1395` |
| 其它 | warning `Unsupported prompt block type received` | 静默忽略 | `1396-1399` |

进一步结论：

- **image、audio、resource_link、embedded resource 都不是“只 advertise 不消费”**；它们在 `_parse_prompt` 中都有实际分支。
- 但“消费”不等于“保证后端接受”：服务端不校验模型/账号是否支持音频；不支持时由 SDK/后端报错，通常在 turn 的错误路径体现。
- **没有 prompt block 大小上限**；大图/大音频直接 base64 解码进内存。解码失败不会让整个 prompt 失败，而是丢弃该 block，模型只看到剩余内容。
- `resource_link` 的关键语义：它**不是把客户端资源引用原样传给模型**，而是由**服务端进程**按 URI path 读本地文件。客户端在远端、文件只在客户端侧时，`from_file` 会失败，最终模型看到的是路径字符串，而不是文件内容。这是与“客户端资源链接”直觉最大的偏差。
- `resource_link` 的 `file://` URI 会被转成 path；非 `file://` 的 URI（http 等）会被 `urlparse` 取 path，可能得到一个不存在的本地路径 → 退化路径字符串。
- `embedded resource` 的 `text` 部分会拼成字符串，不保留结构化 uri/text 分离；blob 只支持 image/audio，其它类型（如 application/pdf）被丢弃。注意：`resource_link` 走 `from_file` 时 PDF 可被 SDK 识别为 Document；但 `embedded resource` 的 PDF blob 不会。
- 多模态 block 的 `description`：`image`/`audio` 分支传 `description=None`；`resource_link` 传 `block.description`；embedded blob 传 `uri` 作为 description。

## 12. 交互问答与权限（单选事实，重点）

### 12.1 工具权限

`_permission_handler`（`server.py:4996-5325`）：

1. 发 `tool_call`（`ToolCallStart`），status `pending`，带完整 tool 元数据；MCP 工具带 `_meta`。
2. 发 `session/request_permission`，`toolCall` 是同一 id 的 `ToolCallUpdate`，status `pending`。
3. 选项：
   - 一般：`allow_always`、`allow`、`deny`
   - 文件写工具、ALWAYS_ASK 文件、终端强制审查：只有 `allow`、`deny`
   - 高风险（exec/web）：`allow_always` 带 `_meta["agy.security.warning"]`，并显示 “Allow Always (risky)”
4. 结果：
   - `AllowedOutcome` + `option_id == "allow"` → 允许本次
   - `AllowedOutcome` + `option_id == "allow_always"` → 允许并按签名缓存（文件名/命令/通配）——文件写、ALWAYS_ASK、终端审查会降级为仅本次
   - 其它 `AllowedOutcome` option_id（包括 `"deny"`）→ `_reject_tool_call`
   - `DeniedOutcome`（`outcome:"cancelled"`）→ `_reject_tool_call`
5. “Allow Always” 持久化到 sidecar 的 `allowed_tool_calls` + `allowed_tools_workspace`，只对同一 workspace 恢复（`server.py:5284-5306`；恢复 `3963-3975`）。

### 12.2 交互问答 / ask_question

官方**没有** ACP elicitation 或专门的 question 方法；走 `_ask_user_handler`（`server.py:5381-5497`）：

- 输入来自 SDK 的 `AskQuestionInteractionSpec.questions[]`，每项 `{question, options[], is_multi_select}`（PAR `google/antigravity/types.py`；`hooks.py:967-1006`）。
- 对每个 question：
  - 生成 `tool_call_id = "interaction_<8hex>"`。
  - 发 `ToolCallStart`：`title=question`，`raw_input={}`，`status="pending"`；**没有 `_meta`**。
  - 调 `session/request_permission`：`toolCall` 同一 id，`title=question`，`raw_input={}`，`status="pending"`；options 是 SDK 选项的一一映射：
    - `option_id = opt.id`
    - `name = opt.text`
    - `kind = "reject_once"` 当 id 小写为 `deny`/`dont_trust`/`block`；否则 `allow_once`
  - 等待客户端返回一个 `optionId`；返回后发 `ToolCallProgress`：
    - `status="completed"` + `raw_output="Response received"`（AllowedOutcome）
    - `status="failed"` + `raw_output="Interaction cancelled"`（其它）
  - 返回 `option_id`，或 `None`（取消）。
- **单选是协议硬约束**：`RequestPermissionResponse.outcome` 是 `AllowedOutcome`（一个 `optionId`）或 `DeniedOutcome`（只有 `outcome:"cancelled"`，**没有 optionId 字段**）。`PermissionOption.kind` 也只用于提示，不能一次返回多个。
- `AskQuestionEntry.is_multi_select` 被忽略：`ExternalOnInteractionHook.run` 对每个 question 只调一次 `ask_user_fn`，构造 `QuestionResponse(selected_option_ids=[selected_id])`（`hooks.py:983-1006`）。官方 TODO 明确“Support multi-select interactions if ACP protocol supports it”（b/524989454，`server.py:5401-5402`）。
- 没有自由文本输入：`raw_input={}`，客户端只能从给定 options 选一个；不能返回自定义字符串。
- 取消语义：`DeniedOutcome` → `None` → hook 返回 `cancelled=True`（`hooks.py:995-1002`）。选 `deny` 选项则是 `AllowedOutcome(optionId="deny")` → 作为选中答案返回，不是“取消”。
- workspace trust 也复用同一路径，选项 id 为 `trust` / `dont_trust`（`hooks.py:390-424`）。

### 12.3 对客户端的影响

- 客户端若把问答 UI 实现成多选、或期望 `_meta` 带问题结构，官方 1.5.0 无法满足；只能在 permission 的 `title`+`options` 上渲染单选。
- 客户端若对 `DeniedOutcome` 返回自定义 `optionId`，schema 会拒绝（`DeniedOutcome` 没有该字段）；必须用 `AllowedOutcome` 返回选中的 option（包括 deny 选项）。
- 客户端必须实现 `session/request_permission`。`yolo` 只会让工具处理器跳过 permission；`auto_edit` 只覆盖文件编辑类工具；交互问答与 workspace trust 在任何 mode 下都必须经过 permission。因此不能靠 `auto_edit` 当作“全自动/无需审批”模式。

## 13. 附加目录

- 能力位：`sessionCapabilities.additionalDirectories = {}`（`server.py:2685-2691`）。
- 接受位置：`session/new`、`session/load`、`session/resume` 的 `additionalDirectories`（`server.py:3631-3637,4112-4119,4209-4216`）。
- 规范化（`_normalize_additional_directories`，`server.py:1406-1465`）：
  - 必须是字符串、非空、无 NUL；
  - 必须绝对路径（先展开 `~`）；
  - 拒绝文件系统根；
  - 已存在但不是目录 → 跳过；
  - 去重、保持顺序、排除 cwd；
  - 任何非法项只 warning，不失败会话创建。
- 用途：加入 `workspaces`、`allowed_dirs`、skills 搜索、hooks 的 workspace paths（`server.py:4330-4335,4692,4610-4614`）。
- 持久化：写入 sidecar `additional_directories`（`server.py:3736-3743,4097-4103`）；`session/list` 返回（`server.py:3867-3880`）。
- 恢复语义：按 ACP v1，省略或空数组会**清空**已存根目录，不隐式恢复（`server.py:3901-3903` 注释；`4097-4103` 用 resolved 值覆盖）。

## 14. 持久化与恢复

### 14.1 路径

`GEMINI_HOME`（默认 `~/.gemini`）决定一切（`paths.py:42-89`）：

| 路径 | 用途 |
| --- | --- |
| `<home>/settings.json` | 跨 surface 共享设置 |
| `<home>/antigravity-acp/settings.json` | 本 server 私有设置（auth.type、gcp.*、telemetry） |
| `<home>/config/` | 跨 surface 全局配置（hooks、skills） |
| `<home>/antigravity-cli/skills/` | 读取 CLI 用户技能（只读） |
| `<home>/antigravity-acp/conversations/` | `<sessionId>.db`（SQLite trajectory）+ `<sessionId>.meta`（sidecar JSON） |
| `<home>/antigravity-acp/brain/` | harness 每会话产物（通过 `app_data_dir`） |
| `<home>/antigravity-acp/telemetry.log` | 本地 JSONL telemetry |
| `<home>/antigravity-acp/trusted_workspaces.json` | workspace trust |
| `<home>/artifacts/` | hooks artifact 临时目录 |

### 14.2 创建与写入

- `new_session`：先鉴权、初始化 admin controls、确保目录、预创建空 trajectory 文件（`server.py:3657-3672`）；模型列表失败直接抛错（`3674-3678`）。
- sidecar 写入：`cwd`、`additional_directories`、`tool_filter`（`server.py:3736-3743`）。
- `mode_id` 单独写 sidecar（`server.py:2756`）。
- `allowed_tool_calls` + `allowed_tools_workspace` 在 Allow Always 时写（`server.py:5291-5301`）。
- 崩溃/重建：`_rebuild_session_agent` 用同一 trajectory 重建（`server.py:2065-2121`）。

### 14.3 列表/恢复/重放

- `session/list`：扫描 `*.db`，忽略 cursor；`sessionId` 来自文件名，`title` 固定 `Session <前8位>`，`cwd` 来自 sidecar（缺失则 `gemini_home`），`additionalDirectories` 来自 sidecar（`server.py:3828-3885`）。
- `session/resume`：恢复上下文、模型、mode、tool filter、MCP、systemPrompt、additionalDirectories，**不重放历史**（`server.py:4112-4149,3887-4110`）。
- `session/load`：先 restore，再逐条 `load_session_steps` + `_stream_historical_step` 重放（`server.py:4209-4251`）。
- 冷恢复要求 trajectory 文件存在；否则 **-32002** `Session not found in the current GEMINI_HOME`，data 里带 `sessionId`/`geminiHome`/`expectedPath`/`details`（`server.py:3918-3940`）。
- 恢复时若旧 session 还活着，先 `stack.aclose()` 旧栈（`server.py:3942-3957`）。
- 恢复时剥离 thought signatures：重写 `*.db` 内 `thinking_signature`/`thought_signature`，以及 planner response 的旧 `signature`（`server.py:4583-4599`；`session_store.py:196-295`）。
- 恢复后 usage 基线：`on_session_restored`；若已有 token 历史，context tokens 变为 `None`（未知），直到下一次模型调用（`server.py:4106-4108`；`token_usage_tracker.py:57-74`）。

### 14.4 turn 恢复与取消

- 连接在 turn 中关闭（`websockets.ConnectionClosed`）：`_rebuild_session_agent` 一次并重试该 turn；第二次仍关闭则发清理消息并结束 turn（`server.py:5642-5660,5768-5785`）。
- SDK 取消（`AntigravityCancelledError`）：发取消文本，`cancelled=True`，返回 `stopReason:"cancelled"`（`server.py:5716-5731,5826-5827`）。
- `session/cancel` 只调用 `agent.conversation.cancel()`（若 agent 已启动），不释放会话、不杀后台任务（`server.py:3759-3772`）。
- 客户端断开/进程结束：`on_disconnect` → `cleanup()`，关闭所有 session stack、取消后台任务、停 admin controls/telemetry（`server.py:1729-1733,3774-3827`）。
- **没有** `session/close`、`session/delete`、`session/fork`；需要销毁会话只能依赖断开/注销/重新 resume 同一 id（见 2.1）。

## 15. 用量、停止原因、退出与浏览器

### 15.1 用量

- `PromptResponse.usage`：每个 turn 的 token 分解（`server.py:5820-5834`；`token_usage_tracker.py:116-217`）。
- `usage_update`：`used`（当前上下文占用）+ `size`（模型上下文窗口）；由 `get_context_window_size` 决定，未知则不发送（`server.py:6394-6434`）。
- 新的 session 初始 context=0；restored session 在首次模型调用前可能是未知（不发 0）。
- `/usage` 额外提供配额信息（仅 OAuth personal/business）（第 8 节）。

### 15.2 停止原因

`_to_acp_stop_reason`（`server.py:1625-1652`）：

| SDK StopReason | ACP stopReason |
| --- | --- |
| `UNSPECIFIED` | `end_turn` |
| `MAX_INPUT_TOKENS_EXCEEDED` / `MAX_OUTPUT_TOKENS_EXCEEDED` / `MAX_TOTAL_TOKENS_EXCEEDED` | `max_tokens` |
| `MAX_MODEL_CALLS_EXCEEDED` / `MAX_TOOL_CALLS_EXCEEDED` | `max_turn_requests` |
| `QUOTA_EXHAUSTED` | `refusal` |
| 取消路径 | `cancelled`（显式设置） |
| 执行/连接/校验错误 | 通常仍 `end_turn`（错误文本以 `agent_message_chunk` 发送） |

**语义注意**：额度耗尽/执行错误如果走 `except` 分支发送文本，`response` 为 None，最终 stopReason 仍是 `end_turn`（`server.py:5829-5831`）。只有 SDK 正常返回带 `QUOTA_EXHAUSTED` 的 response 才会是 `refusal`。这正好解释了“错误结束却显示 completed/end_turn”的可能来源；客户端不能只看 stopReason 判断成功。

### 15.3 退出

- 没有 ACP `exit` 方法。
- 进程退出：stdin 关闭/连接断开 → `on_disconnect` → `cleanup()`；`main.py:139-143` 在 `run_agent` 结束后再 `cleanup()`。
- 模型层“结束”工具：SDK `BuiltinTools.FINISH`（“Finish the conversation and return structured output”）默认启用（`BuiltinTools.default()` 排除 `ASK_QUESTION` 和 deprecated 列表；`server.py:4555-4564` 会补回 `ASK_QUESTION`）。它的实际 turn 终止语义由 SDK/harness 决定，服务端没有专门分支；列入待验。
- `manage_task(Action="kill")` 会取消对应后台任务并把相关 tool call 以 `failed` 关闭（`server.py:6175-6211`）。

### 15.4 浏览器

`browser_subagent.py` + `server.py:4439-4540,5547-5715`：

- **仅 `oauth-business` + 企业 admin control `browser_enabled`** 时注入；consumer/API key/agent-platform/gateway 默认没有浏览器。
- 通过 `npx chrome-devtools-mcp@>=1` 启动本地 MCP server（需要 Node.js/npx）；服务端不捆绑浏览器二进制。
- MCP server 名 `chrome_devtools`，工具命名空间 `chrome_devtools/<tool>`；subagent 名 `browser`，模型通过 `start_subagent`（SDK 的 `INVOKE_SUBAGENT`）使用。
- 启动前 preflight：npm metadata 探针，失败则跳过注入并给一次性通知（`browser_subagent.unavailable_message`）。
- 运行中失败：禁用该 session 的浏览器、发降级通知、重建 agent 并重试 turn 一次（`server.py:5661-5715`）。
- JS 执行策略：`evaluate_script` 受 `javascript_execution_policy` 控制；`REQUEST_REVIEW` 时走 permission（`server.py:4492-4504`）。
- 允许 URL 列表：admin 控制。
- 客户端可用 `disabledTools: ["invoke_subagent"]`（或旧 `start_subagent`）关闭子代理，从而关闭浏览器注入；也可用 `disabledTools: ["generate_image"]` 等关闭其他内建工具。

## 16. 声明与实作差异 / 重点冲突证据

### 16.1 `plan` mode / unknown mode

| 事实 | 证据 |
| --- | --- |
| 独立 1.5.0 只有 `default`/`auto_edit`/`yolo` | `config_options.py:25-41` |
| 未知 mode → -32602 `Unknown mode id` | `server.py:2738-2744` |
| `/plan` 是 slash command，不是 mode | `server.py:1195-1213,1249-1280` |
| 官方 CLI 1.5.0 release notes 声明 `agy acp` 有 `default`/`accept-edits`/`plan` session modes | `google-antigravity/antigravity-cli` release 1.5.0 |
| 官方 CLI 1.5.10 changelog 提到 `agy acp` 关闭会话、取消后停止子代理/后台任务 | CLI changelog 1.5.10 |

**冲突点**：如果 Paseo 把 `plan` 当作 mode 发送，独立 1.5.0 会拒绝；如果 Paseo 的 UI 依赖 ACP plan updates 渲染计划，独立 1.5.0 不会发。CLI 的 `agy acp` 可能有原生 plan mode，但不在本 PAR，无法用本证据证明其 wire 形状。

### 16.2 第三方模型过滤

| 事实 | 证据 |
| --- | --- |
| 非 Gemini 模型只对固定客户端白名单开放 | `model_selection.py:33-54,418-422` |
| 白名单：JetBrains、JetBrains Air、Android Studio、Android Performance Analyzer、Zed、Xcode、T3 Code | `model_selection.py:46-54` |
| 未识别/无 clientInfo → Gemini-only | `client_info.py:138-141`；`model_selection.py:382-384,418-422` |
| CCPA `disabled` 模型跳过 | `model_selection.py:432-440` |
| CLI 1.5.1 改为“向所有 ACP 客户端提供账号可用全部模型” | CLI changelog 1.5.1 |

**冲突点**：Paseo 若以自身 clientInfo 名称连接 OAuth consumer/business，且名称不在白名单，官方 1.5.0 只返回 Gemini，第三方模型（Claude/GPT 等）不会出现。这不是配置问题，是官方产品过滤逻辑。CLI 1.5.1 的策略变化只说明官方后来在 CLI 上放宽，不等于独立 1.5.0 会放宽。

### 16.3 `systemPrompt` 动态能力

| 事实 | 证据 |
| --- | --- |
| 能力位只声明 append | `server.py:2701-2708` |
| 只从 `_meta.antigravity.systemPrompt.append` 提取字符串 | `system_prompt.py:13-43` |
| 仅 new/load/resume 读取；作为 `system_instructions` 传给 harness | `server.py:3687,4006,4707-4708` |
| 没有 replace 模式 | `system_prompt.py:39-43` 对非 `{append: str}` 形式 warning 并忽略 |
| 没有逐轮更新 RPC / ext_method | 全文无 `ext_method`；`set_config_option` 只接受 model/thinking_level/mode |

**冲突点**：如果 Paseo 需要在会话进行中动态更新系统上下文，官方 1.5.0 没有对应 ACP 通道；只能在每次 new/load/resume 时追加。若 Paseo 期望“替换”或“结构化 system prompt”，官方只支持追加字符串，且会忽略其他形状。

### 16.4 `session/close` 边界

见 2.1。结论：未声明、未实作、-32601；不是空操作。按 ACP 能力协商的客户端在 `sessionCapabilities.close` 未声明时不会发送该 RPC，而是关闭子进程；这是正确 fallback，不是当前缺陷。只有无条件发送 close 的客户端才会失败。若客户端需要会话级资源回收，可用 cancel（只停 turn）、logout（清凭据）、断开连接，或由上层进程管理生命周期。

### 16.5 交互问答单选取向

见第 12 节。结论：问答没有独立 ACP 原语，走 permission；单选、无自由文本、无多选、无 `_meta` 结构。客户端若期望多选/自由文本/结构化问题，官方 1.5.0 不支持。

### 16.6 音频/resource 解析边界

见第 11 节。结论：都实际消费；但 `resource_link` 是服务端本地读文件，不是客户端资源直传；解码失败静默丢弃；音频后端接受度取决于模型/账号，服务端不校验。

## 17. 待验 / 无法确认项

以下项目在本次只读证据范围内**不能确认**，不应写成官方 1.5.0 的事实：

1. **CLI `agy acp` 的独立实现细节**：CLI release notes 声明 `plan` mode、`accept-edits` mode、`session/resume` 不重放、终端登录、1.5.1 放宽模型过滤、1.5.10 关闭会话清理后台任务等。但 CLI 的 ACP server 源码不在本 PAR；其 wire 形状未核验。`0.16.0` 是 Paseo 侧版本号，不属于官方 ACP 服务端，不能作为 CLI 或官方 server 的版本证据。
2. **并发/steering 语义**：独立 1.5.0 `prompt()` 没有显式的 per-session 串行锁；`agent.chat` 是否支持“turn 进行中再发 prompt 进行 steering”由 SDK/harness 决定，服务端没有文档化保证。CLI 1.5.0 release notes 声称 `agy acp` 支持 steering，但不能外推到本 PAR。
3. **`finish` 工具的 turn 终止语义**：`BuiltinTools.FINISH` 默认启用，但服务端没有专门处理；实际是结束 turn、结束会话还是仅返回结构化输出，需要实测/读 SDK。
4. **音频/图片的后端接受矩阵**：服务端会传，SDK/模型是否接受取决于 auth 方法、模型、账号；本次未逐一验证。
5. **`resource_link` 对远程客户端的实际表现**：代码明确是服务端本地读文件；但不同客户端发送的 URI 形状（file://、绝对路径、编码）未逐一验证。
6. **`session/request_permission` 客户端错误处理**：服务端无 try/except；客户端返回错误/断连时的最终 turn 语义未实测。
7. **`session/load` 历史重放的边界**：只重放 user_input/planner_response/tool_call；compaction、usage、plan、浏览器通知不重放；对客户端 UI 的影响需实测。
8. **`protocolVersion` 回显**：服务端原样回显；客户端发不支持版本时的行为未定义（无校验）。客户端应自行检查。
9. **`_meta` 的非官方拼写**：除 `_meta.antigravity`（及 legacy `_meta.agy` 的 `enabledTools`/`disabledTools`）外，其他命名空间/拼写不被读取；其他客户端可能发送的变体未验证。
10. **`session/list` 的 `title`**：固定 `Session <8位>`，不支持用户标题；`cursor` 忽略；大数据量下的性能未测。
11. **`logout` 对 gateway 的行为**：gateway 不写 settings.json，logout 只清连接态；`logout.confirmation` 的 gateway 文案与实现需按代码路径核对（`logout.py:55-70`）。
12. **`usage_update.size` 的来源**：取决于 `model_selection.get_context_window_size` 对当前模型的已知表；未知模型可能不发 usage_update。

## 18. 证据索引

### 18.1 官方产物

- Registry（live）：`https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json`
- Registry（GitHub）：`https://raw.githubusercontent.com/agentclientprotocol/registry/main/antigravity-acp/agent.json`
- 官方归档：`/tmp/agy-acp-150-audit/official.zip`（SHA-256 `36f373e8…`）
- 解包 PAR：`/tmp/agy-acp-150-audit/runtime/agy_acp_server.par`
- 官方 server：`/tmp/agy-acp-150-audit/server-0.py`（SHA-256 `c4a5909a…`）
- 旧版对照：`/tmp/agy-acp-150-audit/server-145.py`（1.4.5）
- 差异：`/tmp/agy-acp-150-audit/server.diff`

### 18.2 关键源码行（模块清单）

| 主题 | 文件:行 |
| --- | --- |
| initialize 能力/认证方法 | `server.py:2576-2716` |
| mode 集合/未知 mode | `config_options.py:25-41`；`server.py:2738-2744` |
| configOptions 构建 | `config_options.py:170-357` |
| set_config_option | `server.py:2881-2964` |
| authenticate / logout | `server.py:2966-3290` |
| new/list/resume/load | `server.py:3631-4251` |
| prompt/流式/错误/停止原因 | `server.py:5499-5834` |
| `_parse_prompt` 五类 block | `server.py:1249-1403` |
| 权限处理器 | `server.py:4996-5325` |
| 交互问答 | `server.py:5381-5497`；`hooks.py:967-1006` |
| available commands | `server.py:5344-5379` |
| usage update | `server.py:6394-6434`；`token_usage_tracker.py` |
| 历史重放 | `server.py:6503-6651` |
| 持久化 | `session_store.py`；`paths.py:197-227` |
| MCP | `mcp_servers.py`；`server.py:4270-4295` |
| 技能 | `server.py:1468-1513` |
| hooks/trust | `hooks.py:273-430`；`workspace_trust.py` |
| 浏览器 | `browser_subagent.py`；`server.py:4439-4540,5547-5715` |
| 模型过滤 | `model_selection.py:33-54,382-468` |
| systemPrompt | `system_prompt.py:1-44` |
| 第三方 clientInfo | `client_info.py:61-162` |
| tier `_meta` | `tier_info.py:26-35` |
| ACP 路由/未实作 | `acp/router.py:61-65,150-152,235-237` |
| ACP Agent protocol | `acp/interfaces.py:260-475` |
| ACP schema 能力位 | `acp/schema.py:5582-5835,3140-3260,668-730` |

## 19. Paseo 侧核对清单（本文不判定现状）

建议 Paseo 逐项核对，避免把“官方有”误当成“Paseo 已支持”：

1. `session/close`：Paseo 0.16 已按 `agentCapabilities.sessionCapabilities.close` 协商；官方 1.5.0 未声明，因此 Paseo 不发 RPC、直接关闭子进程。该路径协议正确，不应直接当当前缺陷；只需确认没有无条件发送 close 的分支（那会收到 -32601）。
2. `plan` mode：Paseo 是否把 `plan` 作为 `session/set_mode` 发送？是否依赖 ACP plan update 渲染？官方独立 1.5.0 两者都不提供。
3. 第三方模型：Paseo 的 `clientInfo.name` 是否在官方白名单？不在则 OAuth 路径只看到 Gemini；Paseo 是否接受这一限制？
4. `systemPrompt`：Paseo 是否需要在会话中动态替换/更新？官方只支持 new/load/resume 的 append。
5. 交互问答：Paseo 是否实现 `session/request_permission` 的单选 UI？是否期望多选/自由文本/`_meta`？官方都不支持。
6. 权限：Paseo 是否正确区分 `AllowedOutcome(optionId="deny")` 与 `DeniedOutcome(outcome="cancelled")`？前者是“选择 deny 选项”，后者是“取消”；官方对 `DeniedOutcome` 取不到 optionId。
7. 音频/图片：Paseo 是否实际发送 audio/image/resource block？官方会消费，但 `resource_link` 是服务端本地读文件；Paseo 是否发送 file:// 还是客户端私有 URI？
8. `fs` 能力：Paseo 是否声明 `fs.readTextFile`/`fs.writeTextFile`？声明后官方会注册 `client_view_file`/`client_create_file`/`client_edit_file`，并禁用原生 create/edit（`server.py:4347-4378`）。
9. 终端：官方不调用客户端 terminal；Paseo 若实现 terminal 能力，官方不会使用。
10. MCP-over-ACP：官方不声明 `mcp.acp`、不实作 `mcp/message`；Paseo 若依赖 ACP MCP 通道，需要改为 stdio/http/sse。
11. 历史重放：`session/load` 会重放 user/assistant/tool，Paseo 是否会重复渲染？`session/resume` 不重放，Paseo 是否按预期使用？
12. usage：`usage_update` 只有 used/size；Paseo 是否期望 cost/其他字段？
13. stopReason：官方错误路径常以 `end_turn` 结束并只发文本；Paseo 是否只依赖 stopReason 判断成功？
14. 版本：官方 `agentInfo.version` 为 1.5.0；Paseo 是否把它与自身 `@getpaseo/server@0.16.0` 混淆？
