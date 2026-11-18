# Antigravity 思考可见性：本机证据与官方能力边界

调查日期：2026-11-17 America/Los_Angeles；联网核验至 2026-11-18 UTC。
本机基线：paseo-agy-acp 2.8.1 / HEAD d5258a1；独立官方 agy_acp_server 1.4.5 兼容内核。

## 结论

原生并非完全不支持思考显示。当前安装的官方内核支持发送 `agent_thought_chunk`，本项目透传该事件，Paseo 接收后映射为 `reasoning`。但近期样本的原生持久化模型响应没有思考文本，不能只修 UI 就期待出现内容。

高思考强度、是否返回可展示思考摘要、客户端是否展示摘要，是三个不同条件。Google Gemini 官方文档明确区分 thought summaries 与完整内部推理；不能承诺能看到完整内部推理。当前官方页面已重定向到 AI Studio 的 Interactions API 文档，使用 `thinking_summaries` 控制摘要；其文档仅证明该 API 能力，不证明当前 Antigravity 独立 ACP 内核开放同名配置，也不能把 API 参数直接复制到本机配置。

## 本机核验

1. 活跃内核：`/home/tiezbro/.local/opt/paseo-agy-acp-kernel-compat/releases/1.4.5-7e7019c8989c-compat-v1-75d81ff43f2a-083ba3f99cb3`。提取的源码 `/tmp/agy-server.py:6115`：非错误、根 trajectory、MODEL→USER 的 `thinking_delta` 转为 `agent_thought_chunk`。
2. `/tmp/agy-server.py:6698`：历史重放对非空 `planner_response.thinking` 生成同类事件。
3. `/home/tiezbro/projects/paseo-agy-acp/ACP Connector/official-kernel/system-message-fold.ts:65`：原生思考不改写，保留事件顺序。
4. `/home/tiezbro/.local/lib/node_modules/@getpaseo/cli/node_modules/@getpaseo/server/dist/server/server/agent/providers/acp-agent.js:2354`：将 `agent_thought_chunk` 映射为 timeline `reasoning`。
5. 2026-11-18T01:55:41Z 保存的第二轮快照：14 个会话、1027 个 planner_response；`thinking` 和 `raw_thinking` 非空计数均为 0，`thinking_redacted` 均为 false，均未记录 thinking_duration。指定 Agent `ba59e0fa-af92-4ea4-b62b-2f996ce6ad92` 的 22 个 planner_response 也全部为空。证据：`/tmp/paseo-agy-acp-diagnosis-20261117/thinking-counts.json`。

此快照比第一轮延迟调查更新。第一轮指定会话统计的 13 次生成和第二轮的 22 次不是同一冻结时点，不能混算。快照中的模型字段来自当前会话元数据，不能替代每一历史请求实际使用的模型／思考档位。

**边界：** 持久化为空不能完全证明实时 ACP 从未发送思考；目前没有同一轮原始 ACP 帧与原生流逐条对照。因此可以排除“协议或代码根本没有支持”，尚不能断言是 Google 后端、SDK 转换或持久化哪一处导致本次没有摘要。

## 公开证据

- ACP Prompt Turn 规范包含 `agent_thought_chunk`：https://agentclientprotocol.com/protocol/prompt-turn
- Gemini Thinking 文档区分加密内部状态 `signature` 和可为空的 `summary`，说明 `thinking_summaries` 配置影响摘要：https://ai.google.dev/gemini-api/docs/thinking
- Antigravity CLI changelog 的 1.4.5 明确描述可折叠／展开 thoughts，说明官方 CLI UI 确实支持显示思考：https://github.com/google-antigravity/antigravity-cli/blob/main/CHANGELOG.md
- 官方 CLI 1.5.10 release：https://github.com/google-antigravity/antigravity-cli/releases/tag/1.5.10

CLI 和独立 `agy_acp_server` 是不同交付物；即使版本号都出现 1.4.5，也不能把其中一方的改动当作另一方已具备的能力。

## 与当前现象直接对应的社区报告

官方仓库 issue #1309（2026-10-21 创建，核验时仍 Open）针对独立 `agy_acp_server 1.4.1`、Gemini 3.8 Flash，以独立 JSON-RPC 脚本测试 high 思考档，观察到正文 103 个 chunk、思考 0 个 chunk。它说明类似现象不只发生在 Paseo；不过这是旧内核的用户报告，不能证明 1.4.5 没有发送代码，也不能据此确定此次的根因。当前安装 1.4.5 的源码确实存在上述发送路径。来源：https://github.com/google-antigravity/antigravity-cli/issues/1309

## 推荐后续验证与产品行为

- 在隔离环境，对同一轮记录原生 step、ACP `session/update`、Paseo timeline，关联同一 session/turn，并只保留脱敏后的事件类型、计数和时间。若原生有 thinking 而 ACP 没有，定位内核映射；若 ACP 有而 timeline 无，定位 Paseo；若上游为空，继续检查模型与配置支持。
- 分别记录“等待模型”“正在重试”“工具执行中”和可信终止错误。没有可展示摘要时，显示真实运行阶段及耗时，不能把工具日志或自行生成的说明冒充模型思考。
- 思考显示修复与错误结束修复分别验收。可见摘要并不能治愈后端 502/503，也不能保证低延迟。

本次仅新增研究文档；未改产品代码，未启动新的模型请求，未切换内核或发布。
