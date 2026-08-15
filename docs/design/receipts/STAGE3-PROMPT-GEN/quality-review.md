# paseo-agy-acp Stage 3 Prompt Generation — 独立 Formal Quality Review（S3-PROMPT-GEN-REV-QUAL-001）

状态：独立 Quality Review 已完成。本文件只审查生成的 Stage 3 执行 Prompt 候选；**`Stage 3 not started`**；未执行任何 Stage 3 动作；未修改任何被审文件。

`TASK_ID`：`S3-PROMPT-GEN-REV-QUAL-001`
`STAGE`：Stage 3 Prompt Generation（**非 Stage 3 执行**）
`TASK_TYPE`：independent formal Quality Review（CHILD；不委派、不加载 thin selector）
`SELECTED_PRIMARY_SKILL`：`code-review`
`SELECTED_SUPPORTING_SKILLS`：`codebase-design`、`writing-for-agents`
`SKILL_SOURCE_IDENTITY`：`mattpocock/skills@8b78b531ab965735c5dc74f6f7a219e1e37326df`（inventory receipt 证明三项 AVAILABLE=YES）

---

## 0. Findings-first 摘要

1. **BLOCKING（阻断，必须修订）**：候选 §1.2 step 3（stage3-prompt-candidate.md:40）与 §6.0 `EXACT_GIT_BASELINE`（:262）把未来 Stage 3 会话的运行时 HEAD 精确钉死为 generation parent `78931bf`，但候选自身（§2.1 :52/:67、§9 :1165-1167）与 Generator（§5）都规定 Prompt 只存在于 Generator 流程 Single Integrator 写入后的**packaging commit** 中，且用户在该 commit 之后才启动新会话。Stage 3 启动时 HEAD = packaging commit ≠ `78931bf` → 准入 step 3 触发 `WORKTREE_DRIFT_UNRESOLVED` 自拒；即使准入放行，每个 task 的 §6.0 fresh readback 也会以 `STAGE2_HANDOFF_REVISIONS_REQUIRED` 自停。**这是自我拒绝死锁**。修复合同见 FINDINGS F-01。
2. **MEDIUM（必须修订）**：候选 §1.2 step 3 允许 `docs/design/receipts/` 下**任意** untracked 内容通过准入，未钉 exact ownership/hash。receipts 目录是 Stage 3 证据面；必须在准入时枚举并钉住生成期 receipts 的精确集合与 hash，其余任何 untracked → `WORKTREE_DRIFT_UNRESOLVED`。修复合同见 F-02。
3. **MEDIUM（必须修订，RED 文本真实性）**：Documentation RED §0.7（documentation-red.md:23）声称「本任务只写上述两个 receipt 路径」、§2（:59）声称 `WRITE_SET_VIOLATION` 不适用，但 RED §7.1（:136-142）如实记录了瞬时 `/tmp/verify_s3_prompt.py` 越界写及其 bounded cleanup。§0.7/§2 的绝对化表述与 §7.1 事实矛盾。真实修复 = 将 §0.7/§2 改为「一次瞬时越界写已发生、已被 bounded cleanup 删除并核验、已关闭」，而非「不适用」；修正后 METHOD_CONFORMANCE 可通过（偏差已披露、有界、已核验归零、不影响候选正文）。见 F-03。
4. **LOW（建议修订）**：候选 §4.2 末行（:220）允许 architecture-sensitive impact 时「拆分/增补 task」。经裁决为**合法条件 Skill 绑定**（与 accepted handoff §13 末行逐字一致，触发条件 = 真实 impact 判定 + Controller 上报 + 记录 authority），**不构成**对 §2.2 静态 DAG 的非法变更；建议补一句「新 task 须携带完整 25 字段 brief 并在记录 authority 下显式更新 DAG/write-set」。见 F-04。
5. **LOW（信息）**：§2.1 表行 1（:52）把 `78931bf` 标注为「repo HEAD」——只在生成阶段成立，packaging commit 之后不成立；并入 F-01 修复。`composeAcpRuntime` 锚点 `agent.ts:644-718` 与 live 645 行差 1（继承自 accepted handoff §1.4，范围性引用，非阻断）。其余 line 锚点（controller.ts:1613-1615、runtime-config.ts:129-146、setup.ts:44-49、agent.ts:480-489、cli.ts:535-539、cli.ts:1132-1142）逐一 live 核验**全部命中**。见 F-05。
6. **通过项（非 findings）**：27 briefs × 25 字段全部齐备无缺失/重复；§2.2 DAG 与 handoff §8 / S2-SPEC-001 §10.1 逐边一致、无环、共享写者全由 DAG 边串行化、T08 排除语义正确（T20/T21 前驱 = T01..T19 唯一排除 T08，明确含 T07/T15）；frontier 模拟 9 波全部无写面冲突；§7.3 未启动记录 6 字段、§7.4 Parallelism Review 8 字段全齐；§5 的 GitNexus impact/detect-changes 命令与全部 RED 命令在仓库工具链上**语法可执行**（`-r/--repo` 选项存在；package.json scripts 存在；`validate:secrets` 缺失正是 T20 的预期 RED）；`<AGY_ACP_STATE_DIR>` 是规范环境变量路径模板（Scheme §4.1/§4.4、live runtime-config.ts:57/121/124 三处一致），非未解析占位符；候选不含 TBD/TODO/占位/自 digest/未来 OID（11 个 40-hex token 全部为已知权威值）。

---

## 1. 运行时元组（start 与 terminal 两次核验，`paseo inspect` live）

| 项 | start 实测 | terminal 实测 |
| --- | --- | --- |
| `PASEO_AGENT_ID` | `2780a357-e398-466c-8bf5-1d05a329c529` | 同（未变） |
| Name | `S3 Prompt Formal Quality Review` | 同 |
| `ParentAgentId` | `93287419-016e-4473-b3c8-7a0b0b248c2d` → **CHILD** | 同（CHILD；不委派、不加载 selector） |
| Provider / Model | `hermes` / `custom:deepseek-v4-flash` | 同（与 Generator 候选 `hermes/custom:deepseek-v4-flash`+max 一致） |
| Thinking | `max` | 同 |
| Mode | `dont_ask`（live official option 之一） | 同 |
| `PendingPermissions` | `[]`（0） | 同 |
| Cwd | `/home/tiezbro/projects/paseo-agy-acp` | 同 |
| 委派 | 未委派（leaf；RESOURCE_SET 委派不可用） | 未委派 |

## 2. Hash-first 核验（全部 live 实测，与绑定值一致）

| 文件 | 绑定值 | live 实测 |
| --- | --- | --- |
| Generator（MAACS） | `9e2e8334289fe4be546303687daeb28903c58be72c19c4ad40738648686edcdd` | 一致 |
| confirmed Scheme（MAACS） | `d3b712ee5dd01029c66b0372a482f248a6f1ecbcf81572eb74d7b4ba5d98a98d` | 一致；状态 `confirmed` |
| Stage 2 handoff（whole-file） | `c88be84fa4c86c4c63921aaccd08f5f9c765dc896f1c35592f6cb0ee16fafc48` | 一致 |
| Stage 2 handoff（Git blob） | `89c8abe0d82c4915cbf6748db15a9ff86a80c501` | `git ls-files --stage` 一致 |
| AGENTS.md | `9bbd1e7b1bb7938cc3fd5922a1dcf9a036fa8639267d38789213f4fe9fc3198d` | 一致 |
| Stage 2 Controller Prompt（MAACS） | `9f946e36e717547e5982eefcc37c188d236e48b3be495541bd12129f84207993` | 一致 |
| S2-SPIKE-503-001 blob / sha | `33ace156…` / `c7426456…` | 一致 |
| S2-RECON-ACP-001 blob / sha | `af5d58f0…` / `f2ded52a…` | 一致 |
| S2-RECON-ADM-001R blob / sha | `90b1c7c1…` / `eee7e56c…` | 一致 |
| S2-ARCH-001 blob / sha | `2a0028cb…` / `7989c043…` | 一致 |
| S2-DOMAIN-001 blob / sha | `37d96877…` / `3b6fabc9…` | 一致 |
| S2-TEST-001 blob / sha | `f17d726b…` / `51e8e3ba…` | 一致 |
| S2-SPEC-001 blob / sha | `b4f316b9…` / `3d90fe64…` | 一致 |
| skill-inventory receipt | `e68e057cfc5ea3a60ba099a34ae77d2b9700ced70d26775ae2dcfd76238aee81` | 一致 |
| documentation-red receipt | `8c6418c8cb76d9bb9de3a11e56a937b3130acabfe379f9ac47f297896e0af0ca` | 一致 |
| 候选 Prompt | `5f3b04089b14b24231d15242197007f7d40c650cdbbc0c35f77692f52504fb19` | 一致 |

Skills（本审查实际读取，hash 与 inventory §4 一致）：code-review `9cf46653…`、codebase-design `a8d50aba…`、writing-for-agents `a842323e…`。三份 SKILL.md 均完整读取（executed）；issue-tracker 发布等步骤在本任务 authority 下 inapplicable。

Git baseline：branch `main`；HEAD `78931bff95ecbd9868f9cfa83a281cbbbf1a60d8`；`git status --porcelain` 仅 `?? docs/design/receipts/`（允许的 receipts 目录）。无 `WORKTREE_DRIFT_UNRESOLVED`。

---

## SPEC_CONFORMANCE

候选对 accepted handoff 的转写 fidelity 经**逐项机器核验**：§2.2 DAG 与 handoff §8 / S2-SPEC-001 §10.1 逐边一致（14 行边集全同）；§2.3 WRITE_SET_MAP 与 handoff §9 逐行一致；§2.4 RESOURCE_SET_MAP 与 §10 一致；§2.5 INTEGRATION_BARRIERS 与 §11 一致；§4.2 Skill/task 映射与 handoff §13 逐行一致；27 个 brief（T01..T21 + REV-SPEC/REV-QUAL + INT-PHASE-CODE/DOCS/FINAL-COMMIT/CONFLICT）各恰好 25 个命名字段、无缺失、无重复；各 brief `DEPENDENCIES` 与 §2.2 入边逐项镜像（含 T20/T21 = 全部内部 T01..T19 唯一排除 T08、S3-REV-* 前驱 = 全部完成 + T08 typed-blocked receipt、S3-INT-* 链与 §2.2 review/integration 节点一致）；§8.1 六阶段验收顺序与 handoff §11 一致；§2.1 绑定输入表 11 行全部 live hash/blob 命中；handoff 内部参考 HEAD `2229353` 的 supersede 处理正确（§6.0 :262）。无删减、无越界、无第二 authority（§2.2 明确「唯一静态权威」且 brief DEPENDENCIES 不得构成第二张图）。业务合同继承（§3）与 Scheme §4.1-§4.7 逐条对应，无新增或改写义务。

结论：SPEC_CONFORMANCE = **pass-with-findings**（F-01/F-02 属准入/基线字段的可执行性缺陷，非 coverage 缺陷；spec 覆盖本身完整）。

## QUALITY_CONFORMANCE

上下文负载：109KB/27-brief 由 Generator 强制完整性（「将 Stage 2 handoff 的全部 RED/验收矩阵原样转成可执行 task acceptance，不得删减」+ 25 硬字段 × 27 brief + DAG/maps/barriers/合同全量内嵌）直接决定，非 sprawl；信息层级（§0-§5 步骤、§6 27 brief 为 in-file 合同、§7-§9 调度/terminal）符合 writing-for-agents 层级规则。无 TBD/TODO/占位 token；无预测路径；无自 digest/未来 OID。所有命令具体可执行（§5 impact/detect-changes 命令经 CLI `--help` 语法核验；全部 RED 命令的脚本/文件存在性核验；`validate:secrets` 缺失恰为 T20 预期 RED）。line 锚点 live 核验 6/6 命中（1 处 1 行差继承自 handoff，见 F-05）。五角色分离、leaf 限制、模型/mode 规则、双审→唯一集成链完整。**阻断缺陷 = F-01 运行时 HEAD 死锁**（fresh 会话无法通过准入且每个 task 基线自停），**F-02 准入 untracked 面未钉 hash**。

结论：QUALITY_CONFORMANCE = **revisions-required**（F-01 为可执行自拒死锁，属阻塞性执行矛盾）。

## METHOD_CONFORMANCE

本审查方法证据：三项 skill 完整读取并报告；CHILD 身份 start/terminal 双核验；未委派；唯一写入 = 本 receipt 路径；未触碰候选/RED/inventory/Stage2/source/tests/index/refs/MAACS/`~/.agents`/`~/.paseo`；未 build/test/provider/6767/network/install/commit；未生成任何 Stage 3 正文。**对生成流程（RED）的方法裁决**：RED §7.1 的瞬时越界写已如实披露并有界纠正（rm + 核验 + 无残留），但 RED §0.7/§2 的「只写两个 receipt 路径」「WRITE_SET_VIOLATION 不适用」绝对化表述与 §7.1 事实矛盾，须按 F-03 修正后方可声称方法完全合规；修正后 METHOD_CONFORMANCE **可以通过**（偏差披露、有界、归零、不影响候选正文与合同；skill 步骤证据本身无缺陷）。

结论：METHOD_CONFORMANCE = **pass-after-correction（F-03 文本真实性修复为前置条件）**。

## PARALLELISM_CONFORMANCE

§2.2 静态 DAG 无环（21 节点拓扑序完整）；共享写者全部由 DAG 边串行化：controller.ts `T18→T02→T03→T06→T14`、agent.ts `T18→T09→T10`、cli.ts `T10→T12`、schema.ts 唯一写者 T18、prompt.ts 唯一写者 T16、文档面唯一写者 T21、package.json/scripts 唯一写者 T20、startup-recovery.ts `T06→T14`；frontier 模拟 9 波（T01 → T04/T05/T07/T11/T13/T17 → T08/T15/T18 → T02/T09 → T03/T10 → T06/T12 → T14/T19 → T16 → T20/T21）每波写面两两不相交 = 最大安全 frontier；T08 排除语义正确（出现在 T07→T08 边后作为自身 receipt 任务，永不进入 T20/T21 前驱、不阻塞内部完成路径）；§7.2 调度合同（fresh readback、立即并行、立即释放/重算、reservation 保留至双审/集成或明确 abandoned、未启动 ready task 6 字段记录、无固定 wave/Agent 数量）与 Generator「最大安全并行」逐项一致；§7.4 Parallelism Review 8 字段（PARALLELISM_CONFORMANCE / READY_TASKS_OBSERVED / TASKS_LAUNCHED / TASKS_DEFERRED / VALID_DEFER_REASONS / UNJUSTIFIED_SERIALIZATION / BOUNDARY_RELEASE_LATENCY / FRONTIER_RECOMPUTE_EVENTS）全部存在；无理由串行 → `revisions-required` 条款在位。

结论：PARALLELISM_CONFORMANCE = **pass**（无发现）。

---

## FINDINGS（按严重度排序，path:line）

### F-01 — BLOCKING：运行时 HEAD 钉死 generation parent，与 packaging commit 时序自相矛盾 → 准入/任务基线自拒死锁

- 位置：stage3-prompt-candidate.md:40（§1.2 step 3）；:262（§6.0 `EXACT_GIT_BASELINE`）；:52（§2.1 表行 1）；:67（§2.1 packaging 时序注）；:1165-1167（§9 启动方式）。Generator：PASEO_AGY_ACP_STAGE3_PROMPT_GENERATOR.md:281（packaging commit 由 Single Integrator 创建）。
- 事实链：Generator 流程在双审 accepted 后由 Single Integrator 写入 canonical target 并创建本地 packaging commit（parent = `78931bf`）；用户随后才启动新顶层会话（候选 §9:1165）。因此 Stage 3 启动时 HEAD = packaging commit ≠ `78931bf`。候选 §1.2 step 3 却要求 `HEAD=78931bf… 其他漂移 → WORKTREE_DRIFT_UNRESOLVED`，§6.0 要求每个 task fresh readback 与绑定值一致否则 `STAGE2_HANDOFF_REVISIONS_REQUIRED`。两条规则在该真实启动状态下**必然自拒**，Stage 3 无法开始；若用户回退到 `78931bf` 工作树则候选文件不存在，同样死锁。
- 判定：阻断（EXACT_ACCEPTANCE #1「admission、generation parent、runtime HEAD 与 worktree 规则不得 deadlock 或 self-reject」违反）。
- **修复合同（单一可执行修复）**：将 §1.2 step 3 与 §6.0 的 HEAD 判定改为**结构化允许集**，不依赖未来 OID：
  1. HEAD = packaging commit：`git rev-parse HEAD^` == `78931bf` 且 `git diff --stat 78931bf HEAD` 的 tree delta 仅限 canonical Prompt 文件 `docs/design/v2.0.0.0-stage3-execution-prompt.md` 与获准 receipts（与 Generator 外部完整性 receipt 记录一致）；
  2. 或 HEAD = `78931bf`（仅当用户明确在 packaging 前以粘贴方式启动的退化情形）；
  3. 其余任何 HEAD/dirty 状态 → `WORKTREE_DRIFT_UNRESOLVED`；内容（非 HEAD）漂移 → `STAGE2_HANDOFF_REVISIONS_REQUIRED`。
  同步：§2.1 表行 1 的「repo HEAD」标注改为「generation parent / 源码 baseline（packaging 的 parent）」；§6.0 明示「源码/权威基线 = `78931bf`，运行时 HEAD 允许集见 §1.2 step 3」。
- 候选不得（也不会）内嵌 packaging commit OID——修复只要求结构判定，不要求预知未来 OID。

### F-02 — MEDIUM：准入允许 receipts 目录下任意 untracked 内容，未钉 exact ownership/hash

- 位置：stage3-prompt-candidate.md:40（§1.2 step 3「唯一允许的 untracked = docs/design/receipts/ 下已存在的 receipts」）。
- 事实：receipts 目录是 Stage 3 全任务证据面（§2.3 每 task 专属 receipt 子目录）；「已存在的 receipts」未枚举、未钉 hash，等于放行任意 pre-existing untracked 内容（含伪造/陈旧证据或中断运行的残留）。
- 判定：准入完整性缺陷（EXACT_ACCEPTANCE #1「worktree 规则不得 self-reject」的反面——此处是过宽而非过窄，但同属未精确界定 allowed untracked 集）。
- **修复合同**：§1.2 step 3 显式枚举生成期 untracked 允许集 = `docs/design/receipts/STAGE3-PROMPT-GEN/` 下已存在的生成期 receipts（skill-inventory.md、documentation-red.md、stage3-prompt-candidate.md、spec-review.md、quality-review.md）并以 Generator 外部 receipt 绑定的 SHA-256 核验；其余任何 untracked 路径 → `WORKTREE_DRIFT_UNRESOLVED`。可与 F-01 修复合并为同一准入步骤的修订。

### F-03 — MEDIUM：RED §0.7/§2 绝对化写集声明与 §7.1 记录的瞬时越界写矛盾（真实性修复）

- 位置：documentation-red.md:23（§0.7「本任务只写上述两个 receipt 路径」）；:59（§2「WRITE_SET_VIOLATION 均不适用」）；:136-142（§7.1 记录 `/tmp/verify_s3_prompt.py` 瞬时创建、Controller correction、`rm -f` + 存在性核验）。
- 判定：§7.1 的披露与纠正本身是诚实的、有界的、已核验归零，未影响候选正文/合同；但 §0.7/§2 的绝对化表述与 §7.1 事实直接矛盾，属于 receipt 文本不真实（不可仅在 §0.7 声称「只写两个路径」的同时在 §7.1 承认第三个瞬时路径）。
- **修复合同**：将 §0.7/§2 改为如实表述：「一次瞬时越界写（`/tmp/verify_s3_prompt.py`，仓库外）已发生，经 Controller correction 后 bounded cleanup（删除 + 存在性核验），无残留；`WRITE_SET_VIOLATION` 已触发并关闭；其余写集合规」。修正后 METHOD_CONFORMANCE 可通过（方法步骤证据本身无缺陷，偏差披露/有界/归零）。
- 注：本 Reviewer 无 RED 编辑权（FORBIDDEN_SURFACES），此修复由 Generator 流程的 RED 属主执行，并作为候选 revisions-required 的一个组成部分。

### F-04 — LOW：§4.2 architecture-sensitive「拆分/增补 task」= 合法条件 Skill 绑定，非 DAG 非法变更（单一处置）

- 位置：stage3-prompt-candidate.md:220（§4.2 末行）。
- 事实：该行与 accepted handoff §13 末行（v2.0.0.0-stage2-handoff.md:1194）**逐字一致**；触发条件 = 真实 impact 判定为 architecture-sensitive；动作前置 = Controller 必须上报 + 记录 authority；§2.2 仍为「唯一静态权威」且不预填运行态集合。Generator 本身（PASEO_AGY_ACP_STAGE3_PROMPT_GENERATOR.md:180）即要求此映射。
- **单一处置：合法**——是继承自 accepted authority 的条件 Skill 绑定，不是对静态 DAG/task graph 的静默变更；「上报 + 记录 authority」双闸门保证任何实际拆分/增补都须经 Controller 与可追溯 authority，不构成「非法 mutate accepted static DAG」。**建议（非阻断）**：补一句「拆分/增补产生的新 task 必须携带完整 25 字段 brief，并在记录 authority 下显式更新 DAG/write-set 后才会进入 READY_FRONTIER」，以消除唯一剩余措辞歧义。

### F-05 — LOW（信息）：两处标注性偏差，均不影响可执行性

- 位置：stage3-prompt-candidate.md:52（§2.1 表行 1「repo HEAD」标注，packaging 后不成立——并入 F-01 修复）；:186（§3 `composeAcpRuntime` 锚点 `agent.ts:644-718`，live 函数声明在 645，继承自 accepted handoff §1.4 的 1 行差；范围性引用、impact target 为 symbol 名而非行号，非阻断）。
- 其余 6 组 line 锚点 live 核验全部命中：controller.ts:1613-1615（maxActiveTurns 校验）、runtime-config.ts:129-146（parsePolicyOverride）、setup.ts:44-49 / agent.ts:480-489 / cli.ts:535-539（三处强制 skip 闸门）、cli.ts:1132-1142（inline hooks）。

### F-06 — 已核验为无问题的裁定项（记录备查，不构成 finding）

- 7e：§5 `node .gitnexus/run.cjs impact --repo paseo-agy-acp <symbol>` 与 `detect-changes --repo paseo-agy-acp` 语法可执行（CLI `impact [options] [target]` / `detect-changes [options]` 均含 `-r, --repo`；AGENTS.md 亦使用同一调用面）；全部 RED 命令（`npm test -- <file>`、`npm run validate:architecture`、`npm run validate`、`npm run validate:secrets` 的预期 Missing-script 失败）可执行。
- 7f：`<AGY_ACP_STATE_DIR>` 为规范环境变量路径模板（Scheme §4.1:87、§4.4:124；live `Admission Controller/runtime-config.ts:57/121/124`），非未解析占位符。
- 7c 侧证：候选 §1.2 step 3 已允许 receipts 目录但需按 F-02 钉集合；「未解析变量/占位 token」扫描零命中；候选 11 个 40-hex token 全部为已知权威值，无自 digest、无未来 OID 猜测。

---

## AFFECTED_SCOPE

- **阻断**：候选 §1.2 step 3、§6.0 EXACT_GIT_BASELINE、§2.1 表行 1（F-01）；全部 27 个 brief 的 `EXACT_GIT_BASELINE` 字段值（引用 §6.0，随 F-01 修复级联）。
- **必须修订**：候选 §1.2 step 3 untracked 允许集（F-02）；Documentation RED §0.7/§2 表述（F-03，RED 属主执行）。
- **建议修订**：候选 §4.2 末行补一句（F-04，非阻断）。
- **不受影响**：§2.2 DAG、§2.3 WRITE_SET_MAP、§2.4 RESOURCE_SET_MAP、§2.5 barriers、§4.2 Skill 映射、27 briefs 的 25 字段内容、§5 通用规则、§7 调度协议、§8 terminal/六阶段、§9 完成标准（全部核验通过）。
- **未触碰**：候选正文、RED、inventory、Stage 2 artifacts、源码、测试、git index/refs、MAACS、`~/.agents`、`~/.paseo`、issue tracker、Provider、生产 6767、网络。

---

## VERDICT

**revisions-required**

理由：F-01 是阻塞性可执行矛盾（候选在自身定义的 packaging-commit 启动时序下必然自拒：准入 `WORKTREE_DRIFT_UNRESOLVED` + 每 task `STAGE2_HANDOFF_REVISIONS_REQUIRED`），违反 EXACT_ACCEPTANCE #1 的「不得 deadlock 或 self-reject」；F-02/F-03 为必须一并修订的准入收窄与 receipt 真实性修复。F-04/F-05 非阻断。修订后须重新执行完整 Spec/Quality 双审（Generator §4 流程），不得仅声明修复。

**修订范围清单（Writer 修订后回审）**：
1. F-01 修复合同（结构化 HEAD 允许集 + §2.1 标注 + §6.0 基线语义）——阻塞项，全部 27 brief 的 EXACT_GIT_BASELINE 引用随之生效；
2. F-02 修复合同（receipts untracked 精确集合 + hash 钉定）；
3. F-03 修复合同（RED §0.7/§2 如实表述，RED 属主执行）；
4. F-04 建议补句（非阻断，可并入）。

---

## 写集证明（本审查）

- **唯一写入文件**：`/home/tiezbro/projects/paseo-agy-acp/docs/design/receipts/STAGE3-PROMPT-GEN/quality-review.md`（本文件）。
- 写入后 `sha256sum` 与 `git status --porcelain`（应仍仅为 `?? docs/design/receipts/`）见本 Reviewer 最终响应（外部 readback，不写入文件）。
- 未写：候选、RED、inventory、Stage 2 artifacts、源码、测试、git index/refs、MAACS、code-of-tiebro、`~/.agents`、`~/.paseo`、/tmp、任何其他路径。未执行：build/test/provider/6767/network/install/switch/commit/push/tag/deploy/release；未委派。

## Terminal Boundary

- **`Stage 3 not started`**。本审查未执行、未批准、未启动任何 Stage 3 动作；未生成 Stage 3 正文；候选在 Generator 流程的 Spec/Quality 双审 accepted 前不得由 Single Integrator 写入 canonical target。修订（F-01/F-02/F-03）完成后须重新双审。
