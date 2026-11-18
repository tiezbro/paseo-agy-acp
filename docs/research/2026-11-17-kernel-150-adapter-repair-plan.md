> 后续决定：用户于 2026-11-17 确认彻底删除 Admission。下文保留原阶段判断和实验收据，当前实施以 [轻量适配器方案](../operations/lightweight-adapter.md) 为准。

# 独立 ACP 内核 1.5.0 核验与 Paseo 适配层修复计划

日期：2026-11-17 America/Los_Angeles；核验时UTC为2026-11-18。工作区 `/home/tiezbro/projects/paseo-agy-acp`，HEAD `d5258a1`，适配器2.8.1。本轮执行版本检查、只读源码／运行记录分析及修复规划；不代表已升级或修复。

## 1. 独立内核确有更新

官方 ACP Registry 当前 antigravity-acp 是 **1.5.0**。提交 `655791de14720cb08eaa9753f39ec0095f04fa2c` 于 `2026-11-13T00:24:45Z`（洛杉矶11月12日16:24:45）将1.4.5更新到1.5.0。此为Registry登记时间，不冒充Google最初上传时间。

来源：
- https://raw.githubusercontent.com/agentclientprotocol/registry/main/antigravity-acp/agent.json
- https://github.com/agentclientprotocol/registry/commit/655791de14720cb08eaa9753f39ec0095f04fa2c

已从Registry指向的Google CDN下载Linux x86_64归档到 `/tmp/agy-acp-150-audit/official.zip`，274069093字节；SHA-256与Registry完全一致：
`36f373e8948edf1727b39c7d62b5722d6a4474bdfd72b04ad3d6def571808c9f`。

PAR内嵌 `_version.py` 为1.5.0，PAR摘要：`8a35f63dd2284e3790a1d97dd0cb2236057c55a0c598b26f3bde022b843d5c04`；external harness摘要：`13dca92307524722a3434cd50baba3f33502d71a24f804f03ee2efbd18b6017d`。

本机生产仍是1.4.5兼容内核。没有执行下载的二进制，没有切换入口、登录或发起新模型请求。修复路线调整为优先升级同一独立ACP产品线；CLI1.5.10保留为后备对照，不再作为首选迁移目标。

## 2. 新版解决了什么，尚不能证明什么

直接比较官方1.4.5与1.5.0的PAR源码：

- `server.py` 的主要可见改动包括将用量统计提取为 `token_usage_tracker`、调整恢复会话时的用量基线，以及客户端文件读取工具的native view_file能力传递。
- 1.5.0 `server.py:5740` 附近仍将部分SDK失败转换为普通 `AgentMessageChunk`；`:5828` 附近仍默认 `stop_reason=end_turn`。因此没有依据说升级自动修好本机终止错误语义。
- 思考增量的发送条件及历史thinking重放路径未在server.py差异中改变，不能承诺升级必然出现思考摘要。
- PAR中另有大量依赖／生成文件更新，external harness二进制也变化；仅比较Python控制层不足以断言底层延迟／重试完全没变，仍需隔离运行对照。
- 本地 `kernel-compat-pins.ts`、`ensure-managed-kernel.ts`、`spawn.ts` 和准备脚本默认值仍固定1.4.5。只把新版文件放到磁盘不会完成产品升级。
- 兼容目标中，`proxy_server.py`、`proxy_agent_config.py` 的摘要与旧版一致；`model_selection.py` 和 `server.py` 改变。模型过滤替换锚点在新版仍唯一命中，但不等于补丁已完整通过或运行兼容。

源码比较证据：`/tmp/agy-acp-150-audit/server.diff`、`server-145.py`、`server-0.py`、`changed-members.json`、`registry.json`。保留旧版本与回滚入口，不能只更新摘要绕过兼容核验。

## 3. 排队是否拖慢了这批任务

通过只读SQLite事件日志，用现有派生HMAC在内存中关联请求，未输出密钥或提示内容。对原先14个会话当前保存的全部28轮请求取入队→获准执行时间：

| 指标 | 结果 |
| --- | ---: |
| 请求数／成功关联数 | 28 / 28 |
| 最短／中位／最长排队 | 2ms / 5ms / 1621ms |
| 超过1秒／超过60秒 | 1 / 0 |

这是本轮较新的28轮快照，不是第一轮冻结步骤窗口。历史完成的lease会释放，不能只连接当前leases表计算历史等待；本次使用保留的events关联。证据：`/tmp/agy-acp-150-audit/admission-event-waits.json`。

本机持久化策略：8个active席位、8个并发启动席位、最小启动间隔2000ms、最大排队1800000ms、容量冷却30000ms，drain_state=steady。本次快照cooldowns表为空。

结论：Admission具有真实的限速成本，但这批请求没有显著排队。它在整轮 `session/prompt` 派发前取得席位，不在每个模型思考／工具调用之间重复排队。排队最长30分钟是上限，不是每轮默认等待30分钟。不能用删除Admission来解释或解决本次模型阶段的分钟级延迟。

## 4. 适配层逐项判断

| 逻辑 | 是否在当前路径 | 影响与判断 | 处理 |
| --- | --- | --- | --- |
| Admission共享账户队列 | 是，可配置关闭 | 有席位／启动间隔／冷却成本；本样本实测很小。它负责不同Paseo进程共享账户，和单会话互斥不同 | 原始3+1依据随内核切换已改变；作为待验证的可选保护层，比较开关后的可靠性收益及成本，不因排队快就保留 |
| 同步SQLite、轮询、心跳、回收 | 是 | 100ms排队轮询、2秒心跳、1秒reaper；better-sqlite3的busy_timeout=5000会同步等待。派发争用检查最多500轮并含Atomics.wait；持续争用可能造成事件循环停顿，目前无本机发生证据 | 给锁争用／取消响应／事件循环延迟建独立压测；500次重查还包含每次事务锁等待，必须验证总墙钟预算；持久化恢复单独评估 |
| 旧TurnScheduler队列 | 当前proxy未实例化整个scheduler | 当前proxy只复用TurnClaim/raceClaim；同session活跃请求被拒绝，没有证据存在“旧FIFO再排一次” | 根据导入图清理真正不可达代码，避免仅凭文件存在判断双重排队 |
| session/new串行化 | 是，同一个proxy内 | 为早期无request id的事件绑定正确cwd；仅影响同proxy并发建会话，不能解释启动后的每轮模型慢 | 保留直到有等价关联方法，不在本次先删 |
| 错误／空轮次保护 | 是 | 有工具输出便绕过空轮次保护；普通end_turn又被coordinator记为completed | P0修复可信终止错误语义，不能仅用“有无最终文字”判断 |
| daemon上下文逐轮注入 | 默认是 | 每轮读取并前置上下文，增加输入内容；指定Agent当前metadata为2518字符。显式重试sleep最多480ms，另加文件搜索／I/O，不能将480ms说成总耗时上限 | 区分稳定系统上下文与动态轮次信息，测重复量与模型耗时；保留动态更新语义 |
| 原生systemPrompt.append模式 | 已有可选能力 | `PASEO_AGY_ACP_NATIVE_SYSTEM_CONTEXT=1`支持会话快照；不能直接替代所有动态上下文 | 隔离对照，需验会话期间上下文更新、恢复和权限规则 |
| skills MCP及HTTP协议桥 | 是 | 增加工具声明／一层转发；能力兼容有实际用途，尚无其主导本次长延迟的证据 | 按双方能力去重，分别测建会话时间和工具往返；保留技能可发现、可读取和会话隔离 |
| 非Gemini模型兼容转换 | 代码在路径内 | transform_request对Gemini直接返回原对象，不修改其thinking配置；没有重试／sleep | 保留有用兼容；随1.5.0重验模型清单和第三方工具调用 |
| 系统消息／carousel转换 | 是 | 特定前缀需缓冲以识别完整片段；原生thinking事件透传，不改写 | 测正文首片延迟、半截前缀和结束flush；不先假设吞掉思考 |
| 取消确认超时 | 是 | 默认30秒仅在收到cancel后等待内核确认，超时关闭该连接；不是普通请求运行30秒超时 | 保留取消边界并验多session影响，不能错误当作任务总超时调整 |

源码位置（仓库根目录 `/home/tiezbro/projects/paseo-agy-acp`）：
- `ACP Connector/admission/turn-coordinator.ts:25,125,156,195`
- `ACP Connector/admission/runtime.ts:21,49,74`
- `Admission Controller/runtime-config.ts:33`；`Admission Controller/controller.ts:489,1413,1444`
- `ACP Connector/official-kernel/proxy.ts:255,275,335,352,424,618`
- `ACP Connector/official-kernel/context.ts:61`；`ACP Connector/acp/session/paseo-context.ts:5,57`
- `ACP Connector/official-kernel/system-message-fold.ts:65,143`
- `assets/official-kernel-compat/rc01/paseo_model_compat.py:49`

## 5. 分批修复计划与完成标准

### A：独立内核1.5.0兼容升级准备

文件范围：`kernel-compat-pins.ts`、`ensure-managed-kernel.ts`、`spawn.ts`、`scripts/prepare-official-kernel-compat.mjs`及相应版本／测试资料。只有经源码差异核验需要时才改recipe和模型兼容模块。

先验证旧pin会拒绝新版，再建立1.5.0 pin/profile；在独立state目录prepare/verify。验收包含初始化、目录／模型、权限、工具、取消、会话恢复，以及既有非Gemini兼容。对比同模型、同输入的原生1.4.5／1.5.0，再比较通过适配器的1.5.0。发布与生产activate是后续独立步骤；本轮尚未执行。

### B：P0错误结束与重试可见性

文件范围：`official-kernel/errors.ts`、`proxy.ts`、`observability.ts`、`admission/turn-coordinator.ts`。若现有官方协议没有可信错误事件，先定义最小内核侧结构化扩展；当前serverControl明确标记不可patch，不能未经设计直接放开全部server.py修改。

先写会经过真实proxy/coordinator的失败用例：工具成功后终止429、持续502/503最终失败、正常工具结束、用户取消、恢复失败。修复后，失败原因在UI可见、Admission不记completed，且不重复派发已执行的写操作。临时重试与硬额度分开，记录次数、等待和总预算。历史记录复核只能证明旧问题存在，不能代替新代码验收。

### C：P1适配成本与去重

原始排队起因属于旧shindgew/agy-acp与PTY/SQLite执行链；2026-08-23切换官方内核时已放宽8/8。不能以“本样本排队成本低”证明继续保留的必要性。完整历史与证据边界见 `2026-11-17-admission-origin-and-retirement-audit.md`。

固定1.5.0后，用同任务交错测原生、适配器Admission关闭、适配器Admission开启三组；先1/3/4并发，再按观测扩到6/8。保留实际活跃turn峰值；Agent数量不等于模型并发。短任务、工具任务和长任务分别记录成功、错误、静默结束、取消及冷启动、排队、首输出、模型、工具、重试与总耗时。稳定上下文原生append另作单因素比较。

实验准备有两个具体前提：生产 `/home/tiezbro/.local/bin/agy-acp` 写死开启与8/8/2000配置，外部false会被覆盖，必须用独立入口；当前env parser拒绝启动间隔小于2000ms，因此测“保留队列但移除节流”需隔离实验配置，不能直接设0。隔离本地账本不会隔离同账号云端额度，应避免生产流量与对照组互相污染。本轮没有执行在线压力测试。

若关闭在目标负载内无可靠性回归，且开启没有可测保护收益，则考虑生产部署默认关闭，保留可选开关，再逐步拆除持久化队列复杂度；若有收益，按观测选择最小有效限制。单session互斥、取消、背压、可信错误传播及必要恢复语义独立验收。锁争用若造成事件循环卡顿，则给同步热路径加统一总等待预算并验证取消响应。上下文和MCP去重保留动态指令与工具权限行为。旧代码删除另列提交，不与错误修复混在一起。

### D：P1思考与状态验收

对齐同轮原生thinking_delta→ACP agent_thought_chunk→Paseo reasoning。上游为空时展示真实阶段和耗时；不能制造思考文本。思考可见性和模型低延迟分别验收。

## 6. 影响范围与本轮产出

GitNexus本轮上游预查：OfficialKernelProxy有2个直接依赖、1组受影响流程，LOW；AdmissionTurnCoordinator有2个直接依赖、2组流程，LOW；PaseoSessionContext有2个直接依赖、1组流程，LOW。此前MCP索引存在新鲜度警告，因此以上为图导航结果，不是生产风险低的保证；实际改具体方法前需再次按符号分析并核对源码及调用点。

本轮新增此计划，并在上轮社区报告补上独立1.5.0优先路线。其他旧调查文档保留。没有修改产品代码或生产配置，没有新推理探针、提交、推送、发布或生产切换。临时下载及脱敏证据在 `/tmp/agy-acp-150-audit/`。
