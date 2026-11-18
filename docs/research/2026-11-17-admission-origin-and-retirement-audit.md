> 后续决定：用户于 2026-11-17 确认彻底删除 Admission。下文保留原阶段判断和实验收据，当前实施以 [轻量适配器方案](../operations/lightweight-adapter.md) 为准。

# Admission 排队起源、当前作用与退役条件审计

日期：2026-11-17 America/Los_Angeles；联网核验UTC为2026-11-18。仓库 `/home/tiezbro/projects/paseo-agy-acp`，HEAD `d5258a1`，适配器2.8.1。本次仅研究和修订计划，没有修改产品代码、生产入口或队列，没有执行模型并发实验。

## 结论

用户关于起因的回忆得到仓库历史支持：先在旧 `shindgew/agy-acp` 衍生路线遇到多Agent并发故障，再加入跨进程Admission缓解。正式旧策略是3个active turn、1个启动许可和2秒启动间隔。不过，目前找不到足以重新独立验证“第4个必失败”的原始本地运行矩阵；3是当时选定的运行保护值，不能提升为当前Google官方ACP硬上限。

2026-08-23切换官方内核时，旧PTY/SQLite抓取执行链已删除，默认策略已提高到8/8/2秒。原始限制的适用前提已经改变。保留队列需要新的收益证据，不能用“目前排队很快”代替必要性论证，也不能仅凭旧起因消失就认定整个持久化恢复机制都可以删除。

## 1. 历史证据链

| 时间／提交 | 已核实事实 | 证据与边界 |
| --- | --- | --- |
| 2026-08-06 `b44bd3d` | 初始项目是 `shindgew/agy-acp` 的社区衍生；PTY启动 `agy --print --conversation ... --sandbox`，读取SQLite并翻译ACP | 该提交README。旧第三方适配器、原生CLI、当前独立官方ACP必须分开 |
| 2026-08-09 `7b95d42` | 最早Admission草案默认1个active、1个start；更高值另验 | `git show 7b95d42:docs/design/v2.0.0.0-admission-controller.md` §3；因此并非每版草案都是3 |
| v2.0正式方案 | 默认3个active、1个start、2000ms间隔、30分钟排队上限、30秒容量冷却；旧parser仅允许active=1或3 | `docs/design/v2.0.0.0-stage2-spec.md:90,167`；`git show 29495fd^:"Admission Controller/runtime-config.ts"` |
| 2026-08-17 `b16aaac` | 专门修正动因归属：本地先遇到同账号多Agent故障，社区issue仅佐证 | `CHANGELOG.md:438-453`及该提交README差异；不能改写成“照社区帖子加队列” |
| 2026-08-23 `29495fd` | 删除旧抓取内核，转向官方ACP；保留Admission；默认放宽8/8/2秒；席位和启动数允许任意安全整数>=1 | `CHANGELOG.md:365-410`；`Admission Controller/policy-limits.ts:1-12` |
| 2026-10-28 `5bb8b82`／v2.7.1 | 修复Admission自己的SQLite读后升级写事务争锁错误，改用BEGIN IMMEDIATE | `CHANGELOG.md:23-35`；`Admission Controller/controller.ts:1412-1415`；`tests/admission-sqlite-contention.test.ts:191`起 |

外仓库 `/home/tiezbro/projects/MAACS/docs/maacs-paseo-agy-acp-confirmed-scheme.md` 保留旧3+1确认方案，属于当时设计依据。本轮不改历史合同或验收收据。当前运行默认以当前源码和入口为准。

## 2. 社区issue #573究竟证明什么

一手来源：`https://github.com/google-antigravity/antigravity-cli/issues/573`，通过GitHub REST API重新读取正文。创建于2026-07-09，核验时仍Open。

报告环境是macOS Apple Silicon、`agy 1.1.0`、Gemini 3.1 Pro High。作者报告：单独运行成功；3个agy自身并行也成功；与codex、opencode、grok三种较长时间运行的CLI共同运行时9/9挂起，错峰5秒仍失败。

因此该issue描述的是特定CLI环境下的并行负载故障，没有建立“Antigravity账户最多3个模型请求”的硬限制，更没有测试当前Linux独立 `agy_acp_server`。作者的启动／握手资源争用解释也是推测。它既不能替代本地历史复现，也不能否定用户当时确实遇到的故障。

## 3. 切换官方后，超3并发是否验证过

发布记录说，10-agent派发和隔离6路yolo压力没有复现旧抓取挂起。这支持当时已经不再把3当作当前上限，但证据强度必须限定：

- 本轮找到发布说明与现存压力脚本，未定位到对应完整原始运行收据；不编造实际并发高水位。
- 10个Agent被派发，不等于10个模型请求同时运行；工具阶段、启动节流和席位等待都会影响实际重叠。
- `scripts/isolated-official-kernel-stress.sh:114-118,175` 要求请求数大于席位数，且强制开启Admission。它验证排队推进，不能证明关闭Admission后的稳定性。
- 6/10路记录不能证明无限并发，也不能证明保留Admission仍有收益。

## 4. 当前代码实际怎么排队

当前路径：`OfficialKernelProxy.#handlePrompt` → `AdmissionTurnCoordinator.admit` → SQLite入队和许可 → `issueAdmittedOfficialPromptWrite` → 官方 `session/prompt` → 结束结算／恢复状态。

1. **作用范围是一次完整turn。** 席位覆盖模型、工具、重试直至prompt结束；不会每次工具调用后重新排队。慢模型会持续占席，满8席后新turn可能排很久；30分钟是等待上限，不是固定延迟。来源：`ACP Connector/admission/turn-coordinator.ts:126-190`。
2. **8/8不等于8个同时起跑。** `hasDispatchCapacity` 和 `markStarting` 对整个共享账本检查最近启动时间，仍强制至少2秒间隔。空闲、无额外等待时，第8个同批请求相对第1个仅启动节流就至少延后14秒。这是策略推导，不是现场计时。来源：`Admission Controller/controller.ts:661-679,1779-1796`。
3. **代码原本支持关闭。** `createOfficialAdmission` 只在显式true/1时创建runtime。关闭时proxy直接转发，单session活跃请求检查仍在。来源：`ACP Connector/official-kernel/admission-fence.ts:38-65`、`proxy.ts:352-389`。
4. **生产入口覆盖外部开关。** 本机 `/home/tiezbro/.local/bin/agy-acp:2-5` 直接export true、8、8、2000。仅在外面加 `AGY_ACP_ADMISSION_ENABLED=false` 无法完成关闭实验；应使用独立入口或直接调用适配器，验证子进程最终配置，生产入口保持不动。
5. **2秒下限不能靠环境改成0。** `Admission Controller/runtime-config.ts:78-83`拒绝小于2000ms；压力脚本也拒绝。底层controller策略验证允许非负间隔，但产品入口不允许。因此单独测“队列开启、无启动节流”需要先准备隔离实验配置路径，不能把Admission整层关闭的结果全归因于2秒间隔。
6. **账户共享依赖部署约定。** 账本按同机同用户的 `AGY_ACP_STATE_DIR/official-kernel` 聚合，不是Google账户自动发现／云端限流。相同账号必须显式共用目录，不同账号分目录；其他主机或直接调用原生内核的请求不在这个账本内。来源：`docs/operations/admission.md:14-15,38-40`、`admission-fence.ts:6-7`。
7. **未发现两层业务FIFO都在执行。** 当前proxy复用旧文件中的TurnClaim/raceClaim，不实例化TurnScheduler；同session第二个活跃prompt直接拒绝。另有session/new串行化，解决早期事件缺request id的cwd绑定，不是全局账户排队。来源：`proxy.ts:4,335-359`及当前源码引用检索。

## 5. 适配层成本和风险

| 项目 | 证据 | 结论 |
| --- | --- | --- |
| 本批历史排队 | 前轮冻结14会话当前28轮events关联：中位5ms，最大1621ms；指定任务首轮6ms | 本样本分钟级模型耗时不能归因于入队等待；不证明高负载下无影响或队列仍必要 |
| 同步SQLite | `controller.ts:489`设busy_timeout=5000，`:1415`使用同步immediate事务 | 争锁会阻塞代理事件循环，可能影响输出转发和取消；当前样本未证实发生 |
| 争用重查预算 | `controller.ts:25-26,1445-1458`最多500次，每轮含同步事务及2ms Atomics.wait | 不是“最多500×2ms≈1秒”：每轮事务自身也可能等待锁，缺少统一墙钟预算。应独立构造持续锁争用测试，不能把源码风险报成已复现分钟卡顿 |
| 心跳／回收 | `turn-coordinator.ts:156-164`；`admission/runtime.ts:22,49-52,74-83` | 活跃turn维持心跳，每个runtime定时回收；规模扩大时增加数据库竞争，属于需测的维护成本 |
| 恢复语义 | 派发不确定／心跳失败会留下recovery_required，正常成功释放lease | 移除队列同时移除持久化证据和恢复行为；需逐项拆分，不能声称现有无队列分支与所有恢复保证等价 |
| 错误分类 | `proxy.ts:425-431`；`turn-coordinator.ts:181-183` | 上游普通end_turn可能把原生终止错误记为completed。属于P0独立问题；关闭队列不能自动修好对用户的错误传播 |
| 维护规模 | Admission Controller 7个TS文件4729行；connector/admission 6个TS文件1088行 | 共13文件5817物理行，含注释／空行，不含测试，也不是CPU开销指标；足以需要审查复杂度收益 |

此前历史一致性检查已发现工具输出后原生429却被记completed；该检查只能证明历史不一致。10月已修的SQLITE_BUSY问题同样不能冒充当前复现。

## 6. 调整后的修复与减负路线

1. **先准备官方1.5.0兼容升级。** 本轮重新读取ACP Registry仍为1.5.0；生产独立内核为此前核验的1.4.5。新版并不自动证明错误语义或thinking已修好。版本与队列对照分开，避免同时改因素。
2. **P0修错误结束。** 可信终止错误必须显示、正确结算，临时重试与硬额度分开；无论队列开关都要验，不能自动重放可能已执行写操作的业务prompt。
3. **把全局Admission定位为待验证的可选保护层。** 固定新版内核、账号、模型、输入、权限与工具；比较原生、适配器关闭、适配器开启；从1/3/4并发开始，按观测扩至6/8。启动间隔另作单因素实验。
4. **证明实际重叠并保留原始收据。** 记录prompt派发／结束区间和实际活跃turn峰值；若模型请求并发不可观测，明确只验证turn并发。统计正确完成、429/502/503、静默结束、首输出、模型／工具／重试耗时、排队、取消延迟和进程残留。短回复之外覆盖工具及较长任务。组别交错重复；少量成功不证明一般稳定。
5. **隔离本地状态不等于隔离云端额度。** 各组运行时分开，避免共用同一账号的生产流量污染；不自动执行大规模在线压力测试。临时新入口必须确认开关生效。
6. **用收益决定保留策略。** 若关闭在目标负载下没有增加失败，且开队列只增加等待／维护负担，则考虑生产部署默认关闭，保留紧急可选开关。若只需要并发上限，先拆开并发限制、启动节流和持久化恢复，选最小有效组合。若开启显著减少失败，则按测得阈值设置，不再继承旧3或现8作为永恒标准。
7. **最后清理死代码。** 删除未被当前路径使用的旧scheduler部分；单session互斥、取消传播、背压、可信错误、必要恢复语义独立保留／替代。删除工作另做影响分析和针对性测试。

方案修正：原先“排队成本低就保留”缺少必要性证明，已改为“验证保护收益后决定”。本轮完成条件是历史证据链、现行成本／边界和可执行对照方案；不宣称已经完成升级或生产修复。

## 7. 证据索引

- 上游Registry：`https://raw.githubusercontent.com/agentclientprotocol/registry/main/antigravity-acp/agent.json`。
- 本地任务延迟报告：`docs/research/2026-11-17-task-latency-interruption-diagnosis.md`。
- 版本与修复计划：`docs/research/2026-11-17-kernel-150-adapter-repair-plan.md`。
- 前轮events关联快照：`/tmp/agy-acp-150-audit/admission-event-waits.json`；临时文件不是永久产品收据。
- GitNexus用于当前执行路径导航，历史判断以git对象和当前源码为准；图索引不作为完整调用或线上行为证明。
