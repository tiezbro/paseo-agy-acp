# 官方内核与轻量 Paseo 适配迭代

2026-11-17，用户确认删除排队和启动间隔，保留官方 agy-acp 内核及完整 Paseo 适配。
实施分支为 `refactor/official-core-paseo-lightweight`，从 `d5258a1` 分出。
是否合并 main 由最终落地结果决定；本分支不自动发布或切换生产。

## 补充验收目标：官方能力完整接入

用户于本轮明确要求：官方内核当前全部能力都需要适配到 Paseo；出现语义或产品冲突时共同决策。
精简对象是重复实现和无必要的中间层，不能以减少代码为理由删除、降级或隐藏官方能力。

以官方 ACP Registry 实时核验的 1.5.0 为本轮能力目标（分支托管 pins 已升级，生产未切换）。
“全部”包括条件式能力：账号、模型、认证方式、管理员策略与客户端能力协商允许时，应可在
Paseo 中使用；不代表绕过官方策略或让每个模型支持所有输入类型。

每项能力分别核验：官方声明和实现、适配器双向协议、Paseo 调用及状态、用户入口及展示、
真实运行证据。仅透传或模拟内核测试通过，不记作完整适配完成。
未知模式、扩展字段及新增事件不应因本地白名单而被静默替换；官方错误应原样返回。

能力矩阵、冲突及实施边界见 [全能力适配核对](../research/2026-11-17-paseo-capability-parity.md)。
无冲突缺口可以直接修复；改变权限语义、模型目录策略或需要跨仓库产品变更的事项先形成
具体方案，与用户共同决策。合并 main、发布及生产切换仍以最终验收和用户决定为准。

## 所有权与删除范围

- 官方内核：认证、模型目录及执行、工具、推理、重试、会话历史与恢复。
- Paseo：Agent/workspace 生命周期、编排、审批与界面。
- 适配器：ACP 传输、产品身份、daemon context、模式映射、MCP 协议兼容、技能发现和资源读取、取消及必要关闭清理。

整个 `Admission Controller/`、`ACP Connector/admission/` 和 `admission-fence.ts`
已删除，包括全局 FIFO、席位、启动间隔、冷却、租约、心跳、回收、队列加密和专用 SQLite。
删除其专用 CLI、原生 npm 依赖、测试、压力脚本和模型记账缓存；不是保留禁用开关。
旧变量不再读取；官方会话数据库和历史不会被删除。历史调查保留为研究收据。

保留单会话一个活动 prompt 的约束。不同会话直接派发，取消只标记对应会话；本地已取消但
官方返回 `end_turn` 时统一为 `cancelled`，明确的 JSON-RPC 错误和 `_meta` 保留。

同一连接的 `session/new` 按序绑定早到的命令更新，因为这些更新缺少 request id。
这是协议关联边界，没有账户级席位或时间间隔；不同 connector 和 prompt 不受该序列限制。
安装锁保护下载/解压/原子替换，取消确认超时保护进程回收，均不属于被删除的请求调度。

## 适配能力与验收依据

| 能力 | 自动验收 |
| --- | --- |
| 独立会话并发、无账本、遗留配置无效 | `tests/proxy-direct-dispatch.test.ts`，12 个会话在任何终态回包前全部到达内核 |
| 同会话互斥、取消语义、RPC 错误 | `tests/official-kernel-protocol-regression.test.ts` |
| 模型、thinking 配置、许可、历史、load/resume | `tests/paseo-client-compat.test.mjs`，锁定真实 Paseo 客户端 |
| daemon 空闲回收、恢复、独立 Agent 并发与取消 | `tests/paseo-daemon-compat.test.mjs`，真实 0.14 核心及模拟内核 |
| 原生 context 协商、技能正文与资源、MCP | `tests/official-kernel-capabilities-integration.test.ts` 及原有 MCP/技能套件 |
| 背压、EOF、TERM/KILL、清理 | `tests/proxy-real-backpressure-close.test.ts` 及生命周期套件 |
| 真实内核短请求对照 | `scripts/compare-kernel.mjs`，同模型 native/adapter 两组，异常停止、不自动重试 |

新增直接派发回归先在旧实现失败（预期 12 个请求，实际 0），删除后通过。
测试中的内核并发不代表 Google 后端实际推理并发或账号额度上限。

## 真实实验

```bash
npm run build
node scripts/compare-kernel.mjs --run --kernel /absolute/path/agy_acp_server.par --model MODEL_ID --concurrency 4 --groups adapter,native
node scripts/compare-kernel.mjs --run --kernel /absolute/path/agy_acp_server.par --model MODEL_ID --concurrency 3 --groups adapter --cancel-after-ms 1000
```

不加 `--run` 只显示帮助。每组全部建会话后提交固定短请求，拒绝工具权限，不保存正文或
原始错误；使用同一账号额度与官方会话存储。工具结束后清理自建进程组，不操作生产 daemon。

## 合并条件与尚待事项

本轮合并评估要求构建、类型、完整回归、锁定版本 Paseo 客户端、架构与秘密扫描通过，
并记录真实内核并发/取消结果、异常和范围。不能用删除测试后的数量下降当作质量退化，
也不能把单次短文本成功当成所有模型、工具和长任务都已验收。

分支托管 pins 已更新为官方 1.5.0；六个平台归档按 Registry 固定 SHA-256，Linux x64 补丁前像已重核。原升级要求仍需
校验各平台产物与现有模型兼容补丁，不由实验路径隐式修改生产。

上游将 429 等终止错误编码为普通正文加 `end_turn` 的问题尚未解决。已有工具输出时，
空轮次检查无法可靠判断这种终止；不得扫描任意模型正文猜测成功/失败。
实时 thinking 链路仍需同轮原生帧、ACP、Paseo 对照。适配器透传已发送摘要，不制造摘要。

部署时清理生产包装器和 provider 中旧 `AGY_ACP_ADMISSION_*`、`AGY_ACP_STATE_DIR` 配置。
先结束旧 connector 再考虑归档旧账本；本轮不删除任何生产数据。切换、回滚与合并由实测决定。

## 本分支首轮验证收据

- `npm run validate`：TypeScript、构建、35 个测试文件共 287 项、架构检查、秘密扫描以及 live-config 4 项全部通过。
- `npm run test:paseo-provider`：Linux 2/2，通过无身份及遗留环境配置场景。
- `npm run test:paseo-client`：真实 Paseo 0.13.2 客户端 4/4，0.14.0 客户端与 daemon 核心 7/7。
- 历史脱敏映射 89 项通过。修正旧 CI 对 CHANGELOG 的整文件冻结：允许顶部追加，历史段落仍逐字相同；追加内容也进行秘密扫描。新增回归先红后绿。
- 官方 1.5.0、`gemini-3.8-flash-high`：适配器四路 4/4 成功（61.605 秒），原生四路 4/4 成功（109.493 秒）；两组均无工具调用、无思考摘要帧。
- 同一内核与模型的适配器三路运行中取消：3/3 返回 `cancelled`，组耗时 1.916 秒（含取消前 1 秒等待）。

真实实验均只做一轮，不证明提速比例、持续吞吐、全部模型/工具或 UI 验收通过。
脱敏固定字段收据：`../research/2026-11-17-lightweight-runtime-results.json`。
生产未切换；非取消终止错误语义及完整能力入口、UI/长任务验收仍待后续工作。
GitNexus 旧索引的变更分析为 CRITICAL（整模块删除涉及大量旧执行流程），新增文件由源码与进程测试补充审查。

## 配套客户端的模式与系统信息协议

配套源码工作树：`/home/tiezbro/projects/MAACS-agy-capabilities`，分支 `feat/antigravity-official-capabilities`。

- 官方模式／mode config选项的 `_meta["paseo.dev/unattended"]` 为布尔值。`yolo=true`，`default/auto_edit=false`，未知模式保留原值与元数据。new/load/resume、配置回包和配置通知使用同一处理。
- Paseo 只读取显式布尔值，不通过名字猜测权限。按官方确认的当前模式自动批准；true允许问答，优先allow_always，再allow_once；没有允许项返回cancelled。false保留人工审批，不受旧auto_accept覆盖。未提供该扩展的provider沿用原行为。
- 系统封套仍是 `agent_message_chunk`，附 `_meta["paseo.dev/messageKind"]="system"`。配套客户端生成info通知；原生thought保持不变。旧客户端不识别标记时保留可读正文。
- 这些是Paseo适配扩展，不冒充官方原生字段，不自动改变官方模式或管理员限制。已发布客户端只通过传输回归，不代表已具备新展示与模式策略。
