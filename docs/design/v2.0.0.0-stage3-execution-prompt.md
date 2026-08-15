# paseo-agy-acp Stage 3 Development Closeout 执行 Prompt（S3-EXEC-001）

> **本 Prompt 的用途**：粘贴给一个**全新的顶层 Paseo Controller 会话**，启动 `paseo-agy-acp` 的 Stage 3 Development Closeout。Stage 1 已确认、Stage 2 已完成并 accepted；本会话**只授权 Stage 3**，不重开 Stage 1/2。
>
> **proposed canonical target**：`docs/design/v2.0.0.0-stage3-execution-prompt.md`（本文件是唯一 Stage 3 执行 Prompt；生成阶段不创建该 target，由 Generator 流程的 Single Integrator 在双审 accepted 后写入）。
>
> **完整性方案**：本文件由 accepted immutable Stage 2 handoff 生成；正文不嵌入自身 digest，不嵌入未来 packaging commit OID。generation parent = accepted Stage 2 commit `78931bff95ecbd9868f9cfa83a281cbbbf1a60d8`。本文件自身的 Git blob / whole-file SHA-256 由 packaging commit 之后的**外部 readback receipt** 绑定，不要求正文预先包含这些值。
>
> **本文件是执行 Prompt，不是执行行为**：生成阶段（Prompt Writer / Generator）不得执行本 Prompt 正文中的 Stage 3 动作；只有 fresh top-level 会话在完成 §1 准入并建立 §0 Goal 后才能执行。

---

## 0. 启动身份与唯一授权

- **cwd**：`/home/tiezbro/projects/paseo-agy-acp`。
- **会话类型**：全新顶层 Paseo Controller 会话（top-level；本 Prompt 不得由 child Agent 执行，也不得被用于委派链内部）。
- **Stage 边界**：Stage 1 已由用户确认（共同 Scheme `confirmed`）；Stage 2 已完成并 accepted（commit `78931bf`，8 份 artifacts 双审 approved、blocking findings=0）。本会话**只执行 Stage 3 Development Closeout**；禁止重跑、重写或重开 Stage 1/2。输入与 accepted 基线不一致时，返回 typed blocker `STAGE2_HANDOFF_REVISIONS_REQUIRED` 并停止，不得自行补规格。
- **persistent Goal**：建立一个只覆盖「paseo-agy-acp Stage 3 Development Closeout」的独立 persistent Goal；不得复用/重开已完成的 Stage 2 Goal，不得把 Goal 延伸到安装、Provider、生产或 release。Goal tooling 不可用时返回 `GOAL_MODE_UNAVAILABLE` 并停止。只有全部 Stage 3 nodes integrated、双审 accepted、Parallelism Review accepted、Critical=0、High=0 并形成本地选择性集成 commit 后才标记 complete。
- **Controller 角色**：supervisor-only。Controller 只做准入、Skill 选择、任务边界、调度、readback 和 accept/reject；不写实现、不审实现、不集成实现。

## 1. Authority 顺序与准入

### 1.1 Authority 顺序（冲突裁决固定顺序，低层不得覆盖高层）

```text
1. 用户最新明确决定与仓库安全规则（含本会话 Controller 澄清）
2. confirmed 共同 Scheme 的 live verified 内容
3. accepted Feature/Contract/Gate 与 immutable handoff（S2-HANDOFF-001）
4. 当前源码、Git、测试与可重复外部事实
5. paseo-agy-acp 项目方法（AGENTS.md、本 Prompt）
6. code-of-tiebro、COT-0059 与 Matt-derived Skills 的开发方法
```

聊天、Agent activity、旧 Committee 报告和 rejected alternatives 只作 provenance；任何事实回到仓库或 live source 验证。authority 冲突返回 `AUTHORITY_CONFLICT`，不能自行选边。

### 1.2 准入（只读核验；任一失败返回对应 typed blocker 并停止）

1. confirmed 共同 Scheme 仍是 `/home/tiezbro/projects/MAACS/docs/maacs-paseo-agy-acp-confirmed-scheme.md`，状态 `confirmed`，live SHA-256 = `d3b712ee5dd01029c66b0372a482f248a6f1ecbcf81572eb74d7b4ba5d98a98d`；缺失 → `SHARED_SCHEME_MISSING`；不一致 → `SCHEME_HASH_MISMATCH`。
2. Stage 2 accepted commit `78931bff95ecbd9868f9cfa83a281cbbbf1a60d8`、8 份 artifacts（§2.1 表）的 path/blob/SHA-256 可完整读取且一致；handoff 缺失 → `STAGE2_HANDOFF_MISSING`；漂移 → `HANDOFF_HASH_MISMATCH` 或 `STAGE2_HANDOFF_REVISIONS_REQUIRED`。
3. 当前 `paseo-agy-acp`：branch=`main`；**运行时 HEAD = Generator 流程的 packaging commit**（其**唯一 parent 必须 = generation parent `78931bff95ecbd9868f9cfa83a281cbbbf1a60d8`**，以 `git rev-parse HEAD^` 核验；packaging delta 只含 canonical Stage 3 Prompt `docs/design/v2.0.0.0-stage3-execution-prompt.md` 与 Generator 获准的控制证据，并与 post-commit 外部完整性 receipt 记录一致）；**index 干净、tracked worktree clean**。untracked 允许集（fail-closed）：**优先要求干净 worktree（untracked 为空）**——packaging commit 已包含 canonical Prompt 与全部获准控制证据；若 post-commit Generator 证据被有意保持 untracked，只允许**外部提供的 post-commit 完整性 receipt manifest 中逐条记录的路径与 SHA-256 值**，且全部路径必须约束在 `docs/design/receipts/STAGE3-PROMPT-GEN/` 之下（由 Controller 在准入时以该 manifest 外部核验；本 Prompt 正文不内嵌任何固定文件名清单、不内嵌任何 hash、不预写未来 packaging OID）；**untracked 非空但 manifest 缺失或 manifest 与实际 untracked 集不一致 → `WORKTREE_DRIFT_UNRESOLVED`**；manifest 之外任何 untracked 路径一律 → `WORKTREE_DRIFT_UNRESOLVED`。其他 HEAD/内容漂移且无新用户裁决 → `WORKTREE_DRIFT_UNRESOLVED`（HEAD/dirty 面）或 `STAGE2_HANDOFF_REVISIONS_REQUIRED`（immutable 内容/hash 面）。**本 Prompt 仅在 Generator 流程完成之后使用**：canonical target 已写入、packaging commit 已形成、post-commit 外部完整性 receipt 已生成。
4. handoff 的 coverage、`DEPENDENCY_DAG`（§2.2）、`WRITE_SET_MAP`（§2.3）、`RESOURCE_SET_MAP`（§2.4）、integration barriers（§2.5）、task briefs（§6）与 RED/GREEN contracts（§5）未漂移；`blocking ambiguity=0` 与 `unresolved blockers=none` 只能由双审 + 集成后的外部 receipt 证明，不在准入期声称。
5. 本会话是 top-level，且 Worker、Spec Reviewer、Quality Reviewer、Single Integrator、Controller 五角色可由不同 identity 执行；角色分离不可实现 → `ROLE_SEPARATION_UNAVAILABLE`。
6. handoff 已携带完整 Stage 3 Skill 映射（§4.2）与全部 approved fallback authority（本阶段无 fallback 声明；任何 Skill 缺失/漂移 → `SKILL_UNAVAILABLE`，任何未批准 fallback → `SKILL_FALLBACK_UNAPPROVED`，任何 Skill 与 authority/write-set 冲突 → `METHOD_AUTHORITY_CONFLICT`）。
7. 每个 delegated task 的 permission/mode 可从当前 Paseo 暴露的 live official options 映射且不扩大 write-set；无法映射 → `AGENT_MODE_UNAVAILABLE`。

## 2. Exact Immutable Inputs

### 2.1 绑定输入表（accepted commit + 8 artifacts + authority，全部 live 核验）

| 项 | exact path | Git blob（HEAD:path） | whole-file SHA-256 | 稳定身份 / 语义角色 |
| --- | --- | --- | --- | --- |
| generation parent / packaging commit 的唯一 parent（源码基线） | repo 历史 commit（**非运行时 HEAD**；会话运行时 HEAD = packaging commit，见 §1.2 step 3） | `78931bff95ecbd9868f9cfa83a281cbbbf1a60d8` | — | Stage 3 源码 baseline、branch `main`、packaging commit 的唯一 parent |
| confirmed 共同 Scheme | `/home/tiezbro/projects/MAACS/docs/maacs-paseo-agy-acp-confirmed-scheme.md` | （MAACS 仓库，不在本 repo） | `d3b712ee5dd01029c66b0372a482f248a6f1ecbcf81572eb74d7b4ba5d98a98d` | 唯一业务 authority，状态 `confirmed` |
| Stage 2 Controller Prompt（provenance） | `/home/tiezbro/projects/MAACS/docs/controller-prompts/PASEO_AGY_ACP_STAGE2_CONTROLLER_PROMPT.md` | — | `9f946e36e717547e5982eefcc37c188d236e48b3be495541bd12129f84207993` | Stage 2 方法 provenance |
| 仓库 instructions | `AGENTS.md` | — | `9bbd1e7b1bb7938cc3fd5922a1dcf9a036fa8639267d38789213f4fe9fc3198d` | GitNexus impact/detect_changes 规则 |
| Stage 2 handoff | `docs/design/v2.0.0.0-stage2-handoff.md` | `89c8abe0d82c4915cbf6748db15a9ff86a80c501` | `c88be84fa4c86c4c63921aaccd08f5f9c765dc896f1c35592f6cb0ee16fafc48` | `S2-HANDOFF-001`：唯一 canonical handoff（本 Prompt 的事实来源；不内嵌自身 digest，integrity 由 post-commit 外部 receipt 绑定） |
| 503 可行性 | `docs/design/v2.0.0.0-stage2-503-feasibility.md` | `33ace156c84c769f55608ba33e95012462cc1718` | `c742645666b456bd5f42602a407446f70cd55321a0d2be2da044f514cb27de19` | `S2-SPIKE-503-001`：trusted-503 typed-stop 依赖；锁定三元组 `SOURCE_FIELD_GAP`+`REAL_PROVIDER_REQUIRED`+`SOURCE_IDENTITY_UNKNOWN` |
| ACP source map | `docs/design/v2.0.0.0-stage2-acp-source-map.md` | `af5d58f021642276df6ca9fe9bcb33102ca1285c` | `f2ded52a47a73773efcbbf27b1d395ad6a9abba7e95b0bdd2516c3b0fe65f860` | `S2-RECON-ACP-001`：ACP Connector source/protocol/permission/process/terminal evidence |
| Admission source map | `docs/design/v2.0.0.0-stage2-admission-source-map.md` | `90b1c7c1fb8d7a465ba266bf2ff3dbc5dddaacc3` | `eee7e56c7ddaa09dc155cb92772298eb0b19710e88b336e16a3851546015fafb` | `S2-RECON-ADM-001R`：Admission source/schema/transaction/recovery/integration disposition |
| 架构 | `docs/design/v2.0.0.0-stage2-architecture.md` | `2a0028cbb60a54aff1fa85afb5d9ca78251f6be9` | `7989c043603a11e4b5d88073d8352509d9ffcf7f8c0d736d2b48149aff03eb54` | `S2-ARCH-001`：两 bounded contexts、唯一 seam、物理边界、v2 单次前向迁移、软排空状态机、runtime reaper |
| 领域模型 | `docs/design/v2.0.0.0-stage2-domain-model.md` | `37d96877c5b6d9f8506d209be4c3184532e4e0bf` | `3b6fabc9a862ed515ea5d39643fdeff6d83f15d0a079d3ea166377004183c12e` | `S2-DOMAIN-001`：domain vocabulary、entity/identity、完整状态机、事务/并发不变量、authority ownership |
| 测试合同 | `docs/design/v2.0.0.0-stage2-test-contracts.md` | `f17d726b38420c08ba6725bd4bfb6f502676fae4` | `51e8e3bab735919b2d3643d1212fe289c6de281da4404bde033709a8cb22ed2b` | `S2-TEST-001`：RED/GREEN seam 合同、receipt 规则、G1-G11、12 矩阵、六阶段验收顺序 |
| 规格 | `docs/design/v2.0.0.0-stage2-spec.md` | `b4f316b9b0cd58603258b916adce5810f4e8b5c2` | `3d90fe642f9322970c8e40e7a23b22228d62bfb3c52a5faac5a10960a9d03450` | `S2-SPEC-001`：唯一规格输入（S-01..S-50、F1-F7、C1-C6、G0-G11、静态 task graph、forbidden surfaces） |

覆盖重建规则：Stage 3 必须从上述 immutable 输入独立重建 coverage（§4 矩阵、F1-F7、C1-C6、G0-G11、每义务唯一 disposition 与 task binding）；hash 漂移或 blocker → `STAGE2_HANDOFF_REVISIONS_REQUIRED`。聊天和 Agent activity 只能作为 provenance。

**packaging commit 时序**：本 Prompt 的 packaging commit 由 Generator 流程的 Single Integrator 在写入后通过 readback 固定；正文**不得**包含、猜测或预留该未来 OID，也不得包含本文件自身的 Git blob / SHA-256（自引用使哈希自我失效）。会话启动时的运行时 HEAD 判定按 §1.2 step 3 的结构化规则执行（HEAD=packaging commit 且 `HEAD^`=generation parent `78931bf`、delta 仅 canonical Prompt 与获准控制证据、index 干净），不依赖该未来 OID。

### 2.2 静态 Stage 3 DEPENDENCY_DAG（唯一 frontier 权威）

本图是 Stage 3 Controller 计算 frontier 的**唯一静态权威**；§6 各 brief 的 `DEPENDENCIES` 字段必须逐项镜像下图入边，不得与本节并列形成第二张调度图。本 Prompt 不预填 `READY_FRONTIER`/`RUNNING_SET`/`REVIEW_SET`/`INTEGRATION_SET`/`BLOCKER_SET`。每条边 = 真实依赖（写面/资源冲突、schema/migration ordering、共享 seam、测试前提、typed gate）。

```text
T01 -> {T02,T04,T05,T07,T09,T11,T13,T17}
T17 -> {T18,T02}
T18 -> {T02,T06,T09,T14,T19}
T02 -> T03
T03 -> T06
T04 -> T15
T05 -> {T06,T15}
T06 -> T14
T07 -> T08
T09 -> T10 -> T12
T11 -> {T12,T15}
T13 -> {T06,T14,T15,T19}
T12 -> {T16,T19}
T14 -> T16
{T01,T02,T03,T04,T05,T06,T07,T09,T10,T11,T12,T13,T14,T15,T16,T17,T18,T19} -> {T20,T21}
```

**T08 disposition**：T08 是外部 typed-stop 分支（无 RED/READY/GREEN、无仓库实现写、排除于 `READY_FRONTIER`）。T20/T21 前驱集合是全部内部任务 T01..T19，**唯一排除 T08**，明确包含 T07 与 T15。`T07 -> T08` 保留；S2-SPEC-001 §10.1 与本图一致。

Review/integration 节点：

```text
{T01..T21 全部完成（green receipts + typed-blocked receipt）} -> {S3-REV-SPEC, S3-REV-QUAL}
{S3-REV-SPEC accepted, S3-REV-QUAL accepted} -> S3-INT-PHASE-CODE -> S3-INT-PHASE-DOCS
{S3-INT-PHASE-CODE, S3-INT-PHASE-DOCS} -> S3-INT-FINAL-COMMIT（唯一选择性集成 commit）
S3-INT-CONFLICT：条件 brief，仅真实 merge/rebase/content conflict 存在时适用；否则 inapplicable
```

无环性：所有边沿既有 DAG 前向推进；共享 `controller.ts` 写者严格为 `T02 -> T03 -> T06 -> T14`，`agent.ts` 写者严格包含 `T18 -> T09 -> T10`，`schema.ts` 只有 T18；加入 review/integration 节点后仍无环。共享写者由本节边串行化（§2.3/§2.5）。

### 2.3 WRITE_SET_MAP

规则：每个 Stage 3 task 的写集 = 其 ALLOWED_WRITE_SET（§6 每 brief 精确列出）+ 专属 receipt 目录（`docs/design/receipts/` 下以该 task TASK_ID 命名的子目录）。两个 task 不得写同一生产文件；共享文件只经 DAG 边串行（列于「冲突与串行化」）。

| task | 生产/测试写面 | receipt 写面 |
| --- | --- | --- |
| S3-T01 | `tests/admission-seats-contract.test.ts` | `docs/design/receipts/S3-T01/` |
| S3-T02 | `Admission Controller/controller.ts`（claim/assert durable policy；消费 T18 `policy_state`）、`tests/admission-policy-consistency.test.ts` | `docs/design/receipts/S3-T02/` |
| S3-T03 | `Admission Controller/controller.ts`（`beginSoftDrainTo1`/drain 完成）、`tests/admission-soft-drain.test.ts` | `docs/design/receipts/S3-T03/` |
| S3-T04 | `tests/admission-scheduling-contract.test.ts` | `docs/design/receipts/S3-T04/` |
| S3-T05 | `tests/admission-timeout-contract.test.ts` | `docs/design/receipts/S3-T05/` |
| S3-T06 | `Admission Controller/controller.ts`（消费 T18 owner schema；owner 绑定/`settleQueuedOwnerDeath`）、`ACP Connector/admission/startup-recovery.ts`、`tests/admission-owner-crash.test.ts` | `docs/design/receipts/S3-T06/` |
| S3-T07 | `tests/admission-503-classifier.test.ts` | `docs/design/receipts/S3-T07/` |
| S3-T08 | （无仓库实现写） | `docs/design/receipts/S3-T08/typed-blocked.txt` |
| S3-T09 | `ACP Connector/acp/agent.ts`（auth gate）、`ACP Connector/acp/authenticate.ts`、`ACP Connector/acp/auth/login.ts`、`ACP Connector/acp/auth/logout.ts`、`ACP Connector/acp/logout.ts`、`tests/admission-auth-gate.test.ts` | `docs/design/receipts/S3-T09/` |
| S3-T10 | `ACP Connector/acp/session/setup.ts`、`ACP Connector/acp/agent.ts`、`ACP Connector/agy/cli.ts`、`ACP Connector/acp/session/request-permission.ts`、`tests/admission-permission.test.ts` | `docs/design/receipts/S3-T10/` |
| S3-T11 | `tests/admission-dispatch-faultpoints.test.ts` | `docs/design/receipts/S3-T11/` |
| S3-T12 | `ACP Connector/agy/cli.ts`（生产接线）、`ACP Connector/agy/prompt-free-process.ts`、`ACP Connector/agy/dispatch-boundary.ts`、`tests/admission-production-dispatch.test.ts` | `docs/design/receipts/S3-T12/` |
| S3-T13 | `tests/admission-process-evidence-contract.test.ts` | `docs/design/receipts/S3-T13/` |
| S3-T14 | `Admission Controller/controller.ts`（`reapSuspects`/suspect）、`Admission Controller/process-evidence.ts`、`ACP Connector/admission/startup-recovery.ts`、`ACP Connector/admission/owner-instance.ts`、`tests/admission-reaper.test.ts` | `docs/design/receipts/S3-T14/` |
| S3-T15 | `tests/admission-race-contract.test.ts` | `docs/design/receipts/S3-T15/` |
| S3-T16 | `ACP Connector/acp/session/prompt.ts`（唯一 prompt-turn typed terminal 映射 owner）、`tests/admission-typed-terminal.test.ts` | `docs/design/receipts/S3-T16/` |
| S3-T17 | `tests/admission-schema-contract.test.ts`、`tests/admission-sqlite-contention.test.ts` | `docs/design/receipts/S3-T17/` |
| S3-T18 | `Admission Controller/schema.ts`（唯一 writer；VERSION=2/完整 `policy_state.policy_fingerprint`/owner/suspect 台账/迁移）、`Admission Controller/controller.ts`（迁移 + API rename）、`ACP Connector/admission/turn-coordinator.ts`（agentId）、`ACP Connector/acp/agent.ts`（agentId）、`tests/admission-schema-v2.test.ts` | `docs/design/receipts/S3-T18/` |
| S3-T19 | `tests/admission-native-process.test.ts` | `docs/design/receipts/S3-T19/` |
| S3-T20 | `package.json`（`validate:secrets` + 纳入 validate）、`scripts/verify-no-secrets.mjs`、`tests/secret-scan.test.ts` | `docs/design/receipts/S3-T20/` |
| S3-T21 | `README.md`、`README.zh-CN.md`、`CHANGELOG.md`、`docs/design/v2.0.0.0-admission-controller.md`（降级头部 + disposition 标注）、`tests/closeout-docs-contract.test.ts` | `docs/design/receipts/S3-T21/` |
| S3-REV-SPEC | 无生产写 | `docs/design/receipts/S3-REV-SPEC/`（verdict receipt） |
| S3-REV-QUAL | 无生产写 | `docs/design/receipts/S3-REV-QUAL/`（verdict receipt） |
| S3-INT-PHASE-CODE | 无内容修改；选择性暂存 accepted code refs（git index，仅 accepted 文件） | `docs/design/receipts/S3-INT-CODE/` |
| S3-INT-PHASE-DOCS | 无内容修改；选择性暂存 accepted docs refs（git index，仅 accepted 文件） | `docs/design/receipts/S3-INT-DOCS/` |
| S3-INT-FINAL-COMMIT | git index 选择性暂存（code + docs 两套 accepted refs 合入**一个**本地 commit） | `docs/design/receipts/S3-INT/`（commit + 外部 integrity receipt） |
| S3-INT-CONFLICT（条件） | 仅真实冲突时：冲突文件的有界 resolution（不得扩大内容） | `docs/design/receipts/S3-INT/` 下 `conflict-1.txt`、`conflict-2.txt` 等按序编号的 conflict receipt |

**显式共享写者冲突与串行化**：
- `Admission Controller/schema.ts`：唯一 writer=T18；T02/T06 只消费 schema。`Admission Controller/controller.ts` 的 T18 migration/API rename、T02 policy、T03 drain、T06 queued-owner、T14 reaper 由 `T18 -> T02 -> T03 -> T06 -> T14` 严格串行；reservation 保留到双审与集成完成。
- `ACP Connector/acp/agent.ts`（agentId rename + auth gate + permission）：`T18 -> T09 -> T10` 严格串行。
- `ACP Connector/agy/cli.ts`（权限修复 + 生产 dispatch）：T10→T12 串行。
- `ACP Connector/acp/session/prompt.ts`：仅 T16 写。
- 文档面（README/zh/CHANGELOG/旧 design）：仅 T21 写；T20 只写 package.json/scripts。
- receipt 目录按 TASK_ID 唯一；无跨 task 写冲突。

### 2.4 RESOURCE_SET_MAP

| 资源 | 可用性 | 约束 |
| --- | --- | --- |
| 仓库 read-only（`/home/tiezbro/projects/paseo-agy-acp`） | 全部 task | 写只限各自 ALLOWED_WRITE_SET |
| live source / tests / package scripts | 全部 task | 只读；结论须回 live source |
| GitNexus（`node .gitnexus/run.cjs`） | 全部 source-edit task | 只读 `query`/`context`/`impact`/`detect-changes`；改 symbol 前必须 `impact` |
| npm test / npm run validate | 全部 task | 只运行各自 brief 指定的命令；不 install/switch |
| `tests/helpers/admission-controller-child.mjs`（跨进程 child helper；live 路径，与 accepted ACP source map S2-RECON-ACP-001 引用的 exact path 一致） | T02/T03/T06/T14/T17/T18 | 跨进程 SQLite 证据 |
| fake agy native process + injected `/proc` readers | T12/T13/T14/T19 | native/process 证据；非真实 Provider |
| key-store/key-derivation fixtures | T17 affected | payload crypto 安全 regression |
| `AGY_ACP_STATE_DIR` 临时目录 | 相关 task | 仅测试用临时目录；不触碰生产 state dir |
| 真实 Provider / 生产 `127.0.0.1:6767` / install / network / release | **不可用** | 全部 task；违反 → `WRITE_SET_VIOLATION` |
| 委派 | **不可用** | Worker 是 leaf；禁止再委派 |

### 2.5 INTEGRATION_BARRIERS

串行验收屏障（前一阶段全绿才进入下一阶段；每次先 focused → affected → broad）。可串行的唯一理由：真实依赖、写面/资源冲突、shared schema/public contract、migration ordering、测试前提变化、Paseo/runtime capacity、typed safety blocker；不固定 wave 或 Agent 数量（Parallelism Review 由 Quality Review 的 `PARALLELISM_CONFORMANCE` 字段承担）。

```text
1. deterministic unit（regression）：T01/T04/T05/T07(负分类)/T11/T13/T15/T17(单进程)/T19
2. SQLite cross-process / fault / security：T02(G3)/T03(G4)/T06(G5)/T14(G6)/T17(contention)/T18(G2)
3. native helper / process evidence：T13/T19
4. fake agy full chain：T09(G1)/T10(G7)/T12(G8)/T16(G9)/T19
5. full validation / GitNexus：T20(G10)/T21(G11) + `npm run validate` 全绿 + `detect_changes` 只影响预期 scope + 各 task impact receipt 归档
6. isolated Paseo `6768` single canary（临时 `PASEO_HOME`、非生产端口）
```

**T08 排除**：S3-T08（trusted-503）不进入任何阶段；typed blocked，排除于 `READY_FRONTIER`。T20/T21 等待全部内部 T01..T19，唯一排除 T08，明确包含 T07 与 T15。真实 Antigravity Provider、exact install/switch、生产 `6767`、push/tag/deploy/release 不属于本 Stage。

### 2.6 Rejected alternatives / decision rationale 的 repository provenance pointers

- `S2-HANDOFF-001` §16（备选与裁决表）：多 ticket 文件、issue-tracker publish、F7 expand–contract、T08 保留在前驱集、27 字段计数、软排空 v1 内扩展、无 provenance 的 trusted-503、生产 dispatch 只留 inline hooks、强制 skip 权限、重启恢复、「unresolved blockers=none」提前声称。
- `S2-SPIKE-503-001` §5/§6（prototype 与 rejected evidence；重开两条件）。
- `S2-ARCH-001` §15（14 项禁止恢复项 + 已删除测试清单）。
- `S2-DOMAIN-001` §11（forbidden concepts / forbidden recovery）。

## 3. 仓库与业务边界

- **只能修改** handoff 授权的 `paseo-agy-acp` files（§2.3 写集）；不得写 MAACS、code-of-tiebro、Paseo、`~/.paseo`、`~/.agents`（`~/.agents` 唯一例外 = required pinned Matt-derived Skill 确认缺失时由 bounded Installer 全局安装，随后由不同 Agent 核验 exact installed path、pinned source commit、file hash 以及所有非目标路径零写入；本阶段 Inventory 已确认 14 项 `AVAILABLE=YES`，预期不触发）。
- **两源码功能区**：`ACP Connector/`（协议/执行侧，package 入口 `dist/ACP Connector/agent.js`/`main.js` 属此区）与 `Admission Controller/`（账号级队列/席位内核）。`src/` 不存在；`scripts/verify-import-boundaries.mjs` 强制单向依赖（`Admission Controller/` 对 `ACP Connector/` 反向 import = 0）。唯一跨区组合入口 = `ACP Connector/acp/agent.ts:644-718` 的 `composeAcpRuntime`。唯一执行链：`TurnScheduler.claim -> turnAdmissionAdapter -> AdmissionTurnCoordinator.admit -> AdmissionController(enqueue/admit/lease/terminal) -> TurnDispatchBoundary -> AgyCliSession.prompt -> StreamPoller/Translator/conversation SQLite -> ACP v1/v2 session.update + exactly-one terminal`。
- **业务合同完整继承**（共同 Scheme §4.1-§4.7，live 核验后生效）：
  - 席位：默认共享池 3、显式 3 正常、唯一整体降级 1、`2/4/5/0/负数/非整数` fail closed、同池共享（换模型/多开不扩容量）、多 Connector policy 一致拒绝、`3 -> soft_draining_to_1 -> steady(max_active_turns=1)` 软排空（不杀 active、零新接纳、`activeLeaseCount()===0` 原子完成）。
  - 队列：session 本地单 turn 顺序先于账号队列；durable request/agent key（canonical `agent_id`/`agentId`）/model/时间/加密 payload；oldest-eligible + per-agent fairness（fairness key = 启动可信 `PASEO_AGENT_ID`）；30 分钟 timeout 与 payload 删除同事务；cooldown/cancel/timeout/dead owner 不堵 eligible；排队进度纯观察。
  - 账号：每账号独立 `AGY_ACP_STATE_DIR`；无伪造账号指纹；enabled 时 v1/v2 login/logout fail closed；换号 = 停止接收 → 排空 → 停机 → 独立 state dir 启动；disabled 保持 legacy。
  - 503/失败：只有可信 Antigravity 503 capacity 证据（`UNAVAILABLE`/`MODEL_CAPACITY_EXHAUSTED`）才记 `provider_capacity` 并 30s cooldown；429/quota/auth/permission/timeout/transport 独立分类且永不写 capacity cooldown；Connector 无外层业务 prompt 自动重试。**trusted-503 保持 external typed stop**（§2.1 S2-SPIKE-503-001 三元组）。
  - terminal/恢复：v1/v2 对 queue_timeout/cancel/provider_failure/recovery_required 各发**恰好一个**真实 typed terminal，失败绝不 `end_turn`；heartbeat 过期只标 suspect；槽位回收需 connector/child/pgrp/descendant/PID-reuse 完整证据链；不确定 prompt 零自动重放；`recovery_required` 保持可见；三次不确定不永久烧满 3 席且不靠重启。
  - 数据与物理边界（C2）：`<AGY_ACP_STATE_DIR>/runtime.sqlite`（0600）是唯一 durable state authority，Admission 拥有 schema 与全部 Admission 业务行，Connector 区 `SQLiteSessionStore` 只读写 `sessions` 行；`admission.key` 是唯一密钥文件；enabled 时不生成 `sessions.json` 双写；禁第二 DB 文件、shadow 文件、outbox/claim/replay 表；v2 表台账（`schema_migrations`/`turn_requests`/`leases`/`cooldowns`/`turn_payloads`/`lease_process_identities`/`start_history`/`policy_state`/`queued_owner_instances`/`events`）与 `sessions` 十列布局不动、`turn_requests.foreignKeys=[]`、`ADMISSION_SCHEMA_VERSION=2`、pre-DDL `sqlite_version()>=3.25` 硬闸、单条 `parent_id -> agent_id` RENAME。
  - legacy 与禁止恢复：legacy ACP/SQLite/`StreamPoller`/`Translator`/权限/取消/history 路径保留；唯一在线输出路径；`sessions` 由 Connector 区 `SQLiteSessionStore` 消费、Admission 不改其语义列。
- **禁止恢复面**（必须保持 absent）：controller outbox、delivery claim、custom ACK、terminal reconnect replay、client route fencing、第二 live SQLite→ACP 输出、shadow/live parity、custom request identity、manual requeue、recovery claim、exact-conversation binder、startup-permit 子系统、大型 migration 框架、第三源码区、第二 Scheme、强制 `dangerously-skip-permissions`、policy 不升版本方案、MAACS ledger/supervisor/runtime synchronizer/Stage 2 门禁（S-44..S-50 的 FORBIDDEN 行）。
- **保护用户与 unrelated changes**：不 reset/stash/clean；不触碰用户未授权文件；commit 前 `detect_changes` 并只选择性暂存本任务文件。

## 4. Agent 与 Skill 合同

### 4.1 实现 Worker 固定

- 实现及 bounded repair Worker **固定**使用 `codex/gpt-5.5` 和 `xhigh`，**不得静默替换**；不可用时 typed stop（`AGENT_MODE_UNAVAILABLE`）。
- permission/mode：最新用户授权要求所有委派使用当前 Provider live 官方选项里的**无人值守最大权限**（Codex 为 `full-access`）；permission/mode 必须来自每个 task 的明确授权与当前 Paseo 暴露的官方选项，不得硬编码、不得扩大 `ALLOWED_WRITE_SET`/`FORBIDDEN_SURFACES`。
- 每次委派创建后必须核验 actual provider/model/thinking/mode/pending permissions；字段与授权不一致或出现权限请求 → `AGENT_MODE_UNAVAILABLE`；无静默替换。

### 4.2 完整 Stage 3 Skill/task 映射（与 handoff §13 一致，逐项对照；缺项/未绑定/fallback 无 authority → `STAGE2_HANDOFF_REVISIONS_REQUIRED`）

| task kind | primary | supporting | 唯一绑定 task |
| --- | --- | --- | --- |
| implementation | `implement` | `tdd` | —（本 stage 无独立绑定；integration conflict 除外） |
| red-green implementation | `tdd` | `implement` | S3-T02/T03/T06/T09/T10/T12/T14/T16/T18/T20 |
| green regression / test-evidence | `tdd` | `implement` | S3-T01/T04/T05/T07/T11/T13/T15/T17/T19（tdd RED 步 inapplicable；生产源码写集为空；receipt = green regression evidence） |
| external typed dependency gate | `diagnosing-bugs` | `triage` | S3-T08（无 RED/READY/GREEN；无仓库实现写） |
| task context / bilingual docs closeout | `writing-for-agents` | （无） | S3-T21（docs contract test 是 acceptance input） |
| Spec Review | `code-review` | `to-spec` | S3-REV-SPEC |
| Quality Review | `code-review` | `codebase-design` | S3-REV-QUAL |
| ordinary code Single Integration | `implement` | `code-review` | S3-INT-PHASE-CODE、S3-INT-FINAL-COMMIT |
| ordinary documentation Single Integration | `writing-for-agents` | `code-review` | S3-INT-PHASE-DOCS |
| integration conflict | `resolving-merge-conflicts` | `code-review` | S3-INT-CONFLICT（条件；inapplicable unless real conflict） |
| domain invariant / architecture-sensitive change | `domain-modeling`+`wizard` / `codebase-design`+`improve-codebase-architecture` | — | 本 stage 无独立 task；不静默删除——若 Stage 3 执行中某 task 的 impact 判定为 architecture-sensitive，Controller 必须先上报并按此映射拆分/增补 task（记录 authority）。拆分/增补产生的新 task 必须携带**完整 25 字段 brief**，并在记录 authority 下**显式更新** §2.2 DAG 与 §2.3 write-set 之后才允许进入 `READY_FRONTIER`；任何此类变更都不得静默进行 |

**ordinary code/documentation integration 与 actual conflict integration 的选择条件**：S3-INT-PHASE-CODE / S3-INT-PHASE-DOCS / S3-INT-FINAL-COMMIT 为 ordinary integration（`implement`+`code-review` 或 `writing-for-agents`+`code-review`）；仅当 `git status`/merge 出现真实 merge/rebase/content conflict 时，冲突面才适用 S3-INT-CONFLICT（`resolving-merge-conflicts`+`code-review`），否则记录 inapplicable。Single Integrator 保持唯一身份，code 与 docs 为两个有序 phase，最终**一个**选择性集成 commit。

### 4.3 调研/审查候选（live 核验 exact provider identity；不得静默替换）

- `pi/MindStackLab-opencode-go/deepseek-v4-flash` + `max`；
- `codex/gpt-5.6-luna` + `max`；
- `hermes/custom:deepseek-v4-flash` + `max`。

只读调研或失败诊断可从三个已批准候选中 live 选择；单个不可用时可换另一个已批准候选，全部不可用时 typed stop。每次委派先核验当前 Paseo 暴露的 exact provider identity 与可用性。permission/mode 逐 task 从 live official options 按 authority 选择，无法映射时 typed stop。

### 4.4 Skill 来源与读取规则

- 全部所需 Skills 为全局 pinned Matt-derived Skills，唯一批准来源 `mattpocock/skills@8b78b531ab965735c5dc74f6f7a219e1e37326df`，全局安装路径 = `/home/tiezbro/.agents/skills/` 下以 Skill 名称命名的目录内的 `SKILL.md`（Inventory 已逐项核验 path + source commit + sha256 + 可读 + 可委派，14 项 `AVAILABLE=YES`，无 fallback 声明）。
- **每个 delegated task 行动前必须完整读取** selected primary + supporting `SKILL.md` 并逐项报告执行证据（installed path + source commit + SHA-256 + 逐项 executed/inapplicable）；一个 task 一个 primary、最多两个 supporting。
- 缺失/漂移 → `SKILL_UNAVAILABLE`；未批准 fallback → `SKILL_FALLBACK_UNAPPROVED`；Skill 物理行为与 authority/write-set 冲突 → `METHOD_AUTHORITY_CONFLICT`，不为了形式服从 skill 而扩大权限。

### 4.5 身份分离

- Worker、Spec Reviewer、Quality Reviewer、Single Integrator、Controller 五角色 identity 分离；同一 artifact 的 Worker 不得审查或集成自身输出；Integrator 不能补写未审实现、创建新业务方案或实质改写 accepted output。

## 5. GitNexus、TDD 与 review 通用规则（每个实现 task 必须）

1. 修改 symbol 前运行 upstream impact analysis（`node .gitnexus/run.cjs impact --repo paseo-agy-acp`，impact 参数为待改 symbol 名）并报告 blast radius；
2. HIGH/CRITICAL blast radius 先报告 Stage 3 Controller 并扩大回归（`tests/acp-server.test.ts`、`tests/acp-runtime-wiring.test.ts`、`tests/queue-steer.test.ts`、`tests/cli.test.ts` 全链），按 task blocker 处理；
3. 先执行**真实 RED** 并保存失败 receipt（RED 只在**未修改 live HEAD** 上真实行为失败；exit code 非 0 或断言失败匹配预期；禁止「测试文件缺失」作 RED；**禁止 mutation-as-RED**（项目 authority 覆盖 skill 示例）；禁止 source-string-only/mock-only/health-check 验收）；
4. **minimal GREEN**（只实现 brief 指定的最小行为；不扩大写集）；
5. GREEN-preserving refactor（保留不变量）；
6. 回归：focused（对该任务回归测试文件运行 `npm test --` 并附加该文件路径）→ affected（同 seam 既有测试）→ architecture（`npm run validate:architecture`）→ broad（`npm run validate`）；
7. commit 前执行 `detect_changes`（`node .gitnexus/run.cjs detect-changes --repo paseo-agy-acp`），只选择性暂存本任务文件；
8. 交给独立 Spec Reviewer 与 Quality Reviewer；任一不 accepted 都返工并重新双审；
9. 只有 dual-review accepted exact ref 才能交给唯一 Single Integrator；
10. Integrator 验证 current main、按依赖顺序集成、运行 integration regressions 并回报 exact commit/files/hashes。

Receipt 规则（S2-TEST-001 §5.0/§7）：receipt 文件写入 `docs/design/receipts/` 下以该任务 TASK_ID 命名的子目录（各 task 的 TASK_ID 见 §6.1-§6.27 与 §2.3 表）；receipt 文件名按序为 `red-1.txt`、`red-2.txt`、`green-1.txt`、`green-2.txt`、`typed-blocked.txt` 等；内容 = 完整命令、exit code、关键输出 3-5 行、UTC 时间戳；RED receipt 附 `git rev-parse HEAD`（未修改 live HEAD 证明）；secret/生产地址写 `<REDACTED>`。诊断循环（意外红/绿）：观察 → 假设（≥3）→ 实验（单变量），禁止先改实现；确认真实行为后决定升级 blocker。

## 6. Stage 3 Task Briefs（27 个 task；每个恰好 25 个硬字段）

### 6.0 Common Task Contract（所有 task 共用字段值；每 brief 显式列出全部 25 个字段名，共享值以本节为准）

- `STAGE`：`3`
- `EXACT_GIT_BASELINE`：repo `/home/tiezbro/projects/paseo-agy-acp`；branch `main`；**immutable 源码/权威基线（generation parent）= accepted Stage 2 commit `78931bff95ecbd9868f9cfa83a281cbbbf1a60d8`**（handoff §12.0 所记内部参考 HEAD `2229353676ada1531c95763eca4a3a25fccdbed3` 已被该 accepted commit 取代）。**运行时 HEAD ≠ 该基线**：正常启动时 HEAD = Generator 流程 packaging commit，其唯一 parent 必须 = 上述 generation parent（结构核验见 §1.2 step 3；packaging commit 自身 OID 由 post-commit 外部完整性 receipt 绑定，本 Prompt 不预写）。**任务启动时必须 fresh readback**（cwd/branch/HEAD/`HEAD^` parent 链/index/dirty ownership）；HEAD 不在 §1.2 step 3 允许集且无新用户裁决 → typed stop `WORKTREE_DRIFT_UNRESOLVED`；immutable 基线或权威哈希漂移 → `STAGE2_HANDOFF_REVISIONS_REQUIRED`。
- `AUTHORITY_PATHS_AND_HASHES`（base，每 brief 追加 task 特定 sibling）：confirmed Scheme `/home/tiezbro/projects/MAACS/docs/maacs-paseo-agy-acp-confirmed-scheme.md` @ `d3b712ee5dd01029c66b0372a482f248a6f1ecbcf81572eb74d7b4ba5d98a98d`；Stage 2 Controller Prompt @ `9f946e36e717547e5982eefcc37c188d236e48b3be495541bd12129f84207993`；AGENTS.md @ `9bbd1e7b1bb7938cc3fd5922a1dcf9a036fa8639267d38789213f4fe9fc3198d`；handoff `S2-HANDOFF-001`（path `docs/design/v2.0.0.0-stage2-handoff.md`；不内嵌自身 digest；integrity 由 post-commit 外部 receipt 绑定）；8 份 sibling 按 path + stable identity + semantic role（§2.1 表，含 blob 与 sha256）。
- `FORBIDDEN_SURFACES`：本 task ALLOWED_WRITE_SET 之外的全部仓库路径（含其他 task 文件、sibling Stage 2 artifacts）；MAACS、code-of-tiebro、`~/.paseo`、`~/.agents`；git index/refs（S3-INT-* 除外）；真实 Provider/登录/模型探测；生产 `127.0.0.1:6767`；install/switch/network/（除本 brief 明确测试命令外）build/commit/push/tag/deploy/release；禁止恢复面（§3 清单：outbox/delivery claim/custom ACK/terminal replay/client route fence/second live SQLite→ACP/shadow parity/custom request identity/manual requeue/recovery claim/exact-conversation binder/startup-permit/大型 migration 框架/第三源码区/强制 `dangerously-skip-permissions`/policy 不升版本方案）。
- `RESOURCE_SET`：§2.4 表；仓库只读、GitNexus 只读、live source、npm test runner、child-process helper、fake agy/injected readers、临时 state dir；无委派、无真实 Provider、无网络。
- `METHOD_CONFORMANCE_EVIDENCE`：报告 selected primary/supporting `SKILL.md` 的 installed path + source commit + SHA-256（§4.4 来源），逐项 executed/inapplicable；未委派；无越权写；SKILL.md 缺失/漂移 → `SKILL_UNAVAILABLE`。
- `REVIEW_ASSIGNMENT_CONSTRAINT`（base）：Worker ≠ Spec Reviewer ≠ Quality Reviewer ≠ Single Integrator；同一 task 的 Worker 不得审查或集成自身输出。Spec Review 核对 Scheme coverage/边界/合同/task acceptance/forbidden surfaces；Quality Review 核对可执行性/测试真实性/依赖-写集-资源冲突/角色分离/最大安全并行。GitNexus `impact` 返回 HIGH/CRITICAL → 先上报 Stage 3 Controller 并扩大回归至 `tests/acp-server.test.ts`、`tests/acp-runtime-wiring.test.ts`、`tests/queue-steer.test.ts`、`tests/cli.test.ts` 全链。
- 通用 RED/GREEN 规则（S2-TEST-001 §5.0/§7，见 §5）：RED 只在**未修改 live HEAD** 上真实行为失败（exit code 非 0 或断言失败匹配预期）；禁「测试文件缺失」作 RED；**禁 mutation-as-RED**（项目 authority 覆盖 skill 示例）；禁 source-string-only/mock-only/health-check 验收。receipt 文件写入 `docs/design/receipts/` 下以该任务 TASK_ID 命名的子目录，receipt 文件名按序为 `red-1.txt`/`green-1.txt`/`typed-blocked.txt` 等；内容 = 完整命令、exit code、关键输出 3-5 行、UTC 时间戳；RED receipt 附 `git rev-parse HEAD`；secret/生产地址写 `<REDACTED>`。
- 通用 `EXACT_ACCEPTANCE` 尾部条款：focused → affected → architecture（`npm run validate:architecture`）→ broad（`npm run validate`）；commit 前 `detect_changes` + 只选择性暂存本任务文件；不预填/不修改任何运行态 frontier 集合。
- `TYPED_BLOCKERS`（通用集）：`STAGE2_HANDOFF_REVISIONS_REQUIRED`、`AUTHORITY_CONFLICT`、`SCHEME_HASH_MISMATCH`、`WORKTREE_DRIFT_UNRESOLVED`、`SKILL_UNAVAILABLE`、`SKILL_FALLBACK_UNAPPROVED`、`METHOD_AUTHORITY_CONFLICT`、`ROLE_SEPARATION_UNAVAILABLE`、`AGENT_MODE_UNAVAILABLE`、`WRITE_SET_VIOLATION`、`BLOCKING_AMBIGUITY_REMAINS`（每 brief 追加 task 特定值）。

### 6.1 S3-T01 — seat/default/invalid 回归

| 字段 | 值 |
| --- | --- |
| TASK_ID | `S3-T01` |
| STAGE | `3` |
| TASK_TYPE | green regression / test-evidence（非实现；生产源码写集为空） |
| BUSINESS_OBLIGATION | S-05 默认 3 / S-06 显式 3 正常 / S-07 非法值 fail closed；场景 1/3 |
| SELECTED_PRIMARY_SKILL | `tdd` |
| SELECTED_SUPPORTING_SKILLS | `implement` |
| SKILL_SELECTION_REASON | 回归测试作者 = 测试 seam 工作；tdd 提供 seam-disciplined test authoring；tdd 的 RED 步显式 inapplicable（测试必须在未修改 live HEAD 上通过）；implement 支持仅在回归揭示真实缺陷时按诊断循环升级 |
| SKILL_SOURCE_IDENTITY | `mattpocock/skills@8b78b531ab965735c5dc74f6f7a219e1e37326df`；`/home/tiezbro/.agents/skills/tdd/SKILL.md`、`/home/tiezbro/.agents/skills/implement/SKILL.md`（启动时核验 path+commit+hash） |
| SKILL_REQUIRED_STEPS | 完整读取两份 SKILL.md；按 S2-TEST-001 §5.0 通用规则在 pre-agreed seam（`parseAdmissionRuntimeConfig` + `admitNext`）编写并运行回归；tdd RED 步不适用；每断言期望值来自 Scheme 常量（3/1/非法集）与 S2-ARCH-001 exact names，禁止 tautological 断言 |
| SKILL_EXPECTED_OUTPUT | 新回归文件 + green regression receipts（§6.0 格式） |
| SKILL_FORBIDDEN_SHORTCUTS | 不写生产源码；不把 missing-test-file 当 RED；不 mutation-as-RED；不 mock-only/implementation-coupled 断言 |
| SKILL_COMPLETION_CRITERIA | 两条 green receipt 存在且断言通过未修改 live HEAD |
| METHOD_CONFORMANCE_EVIDENCE | §6.0 通用 |
| DEPENDENCIES | none（可最先启动） |
| EXACT_GIT_BASELINE | §6.0 |
| AUTHORITY_PATHS_AND_HASHES | §6.0 base + S2-ARCH-001/S2-SPEC-001/S2-TEST-001（path+identity+role） |
| ALLOWED_WRITE_SET | `tests/admission-seats-contract.test.ts` + `docs/design/receipts/S3-T01/` |
| FORBIDDEN_SURFACES | §6.0 |
| RESOURCE_SET | §2.4 |
| EXACT_ACCEPTANCE | green-1：policy `2/4/5/0/-1/1.5` + env 覆盖 → live HEAD 抛错（`validatePolicy` controller.ts:1613-1615、`parsePolicyOverride` runtime-config.ts:129-146）；green-2：3 active + 第 4 请求 → `admitNext` null、state 保持 `queued`；focused/affected/broad 绿 |
| TYPED_BLOCKERS | §6.0 通用集（无 task 特定） |
| RED_RECEIPT_CONTRACT | 不适用——无 RED（tdd RED 步 inapplicable under project authority；测试必须在未修改 live HEAD 上通过） |
| GREEN_EVIDENCE_CONTRACT | `npm test -- tests/admission-seats-contract.test.ts`；receipt `green-1.txt`/`green-2.txt` |
| REVIEW_ASSIGNMENT_CONSTRAINT | §6.0；本 task review-only（Spec Review 核对矩阵映射；Quality Review 核对断言真实性） |
| INTEGRATION_TARGET | regression receipts → 验收第 1 阶段 barrier；accepted refs 供双审与 Single Integrator 集成 |

### 6.2 S3-T02 — durable policy 一致性（G3）

| 字段 | 值 |
| --- | --- |
| TASK_ID | `S3-T02` |
| STAGE | `3` |
| TASK_TYPE | red-green implementation（source-changing；RED→minimal GREEN→refactor） |
| BUSINESS_OBLIGATION | S-06/S-08/S-09 共享池 3/1 语义、同池共享、durable policy 不一致拒绝 opener；F1/G3 |
| SELECTED_PRIMARY_SKILL | `tdd` |
| SELECTED_SUPPORTING_SKILLS | `implement` |
| SKILL_SELECTION_REASON | Controller 澄清（handoff §2.4-3）：改源码 RED→GREEN 任务固定 tdd + implement |
| SKILL_SOURCE_IDENTITY | 同 §6.1 |
| SKILL_REQUIRED_STEPS | 完整读取 SKILL.md；RED 先于 GREEN（未修改 live HEAD 上真实行为失败）；消费 T18 已创建的完整 `policy_state.policy_fingerprint`，minimal GREEN 只实现 `claimDurablePolicy`/`assertDurablePolicyMatch` controller 逻辑；refactor 保留不变量；按 §6.0 通用规则 |
| SKILL_EXPECTED_OUTPUT | RED receipt → minimal GREEN（消费 T18 schema 的 durable policy claim/match）→ GREEN receipt |
| SKILL_FORBIDDEN_SHORTCUTS | 不得修改 `schema.ts`/migration；不得在 v1 内扩展 policy 状态；不得本地 max/min merge；不得静默替换 policy；不触碰 `sessions` |
| SKILL_COMPLETION_CRITERIA | 双进程 mismatch 拒绝（进程 B 打开同库不同 policy 必须 fail closed）；`policy_fingerprint` = HMAC 规范元组；台账 v2 |
| METHOD_CONFORMANCE_EVIDENCE | §6.0 |
| DEPENDENCIES | S3-T01、S3-T17、S3-T18（v2 schema 先建 `policy_state`） |
| EXACT_GIT_BASELINE | §6.0 |
| AUTHORITY_PATHS_AND_HASHES | §6.0 base + S2-ARCH-001（§11.3 durable policy）/S2-SPEC-001（C2）/S2-TEST-001（G3） |
| ALLOWED_WRITE_SET | `Admission Controller/controller.ts`、`tests/admission-policy-consistency.test.ts` + receipts |
| FORBIDDEN_SURFACES | §6.0 |
| RESOURCE_SET | §2.4（含 `tests/helpers/admission-controller-child.mjs` 跨进程） |
| EXACT_ACCEPTANCE | RED-1：live HEAD 上 B 以 `assertDurablePolicyMatch(policy1)` 打开 A 已 `claimDurablePolicy(policy3)` 的 DB 成功（当前无对比）→ 断言「B 必须拒绝启动」红；GREEN 后反向断言同场景拒绝 |
| TYPED_BLOCKERS | §6.0 通用集 + `AdmissionRuntimeError`（policy mismatch 呈型） |
| RED_RECEIPT_CONTRACT | 命令 `npm test -- tests/admission-policy-consistency.test.ts`；预期失败 = B 成功打开（断言拒绝红）；receipt `red-1.txt`（附 HEAD） |
| GREEN_EVIDENCE_CONTRACT | 同命令通过；receipt `green-1.txt`；focused/affected/broad |
| REVIEW_ASSIGNMENT_CONSTRAINT | §6.0；impact target `AdmissionController`（HIGH,12）、`parseAdmissionRuntimeConfig`（HIGH,4）→ 先上报 + broad regression |
| INTEGRATION_TARGET | 验收第 2 阶段（SQLite cross-process）；accepted refs → 双审 → Single Integrator |

### 6.3 S3-T03 — 软排空（G4）

| 字段 | 值 |
| --- | --- |
| TASK_ID | `S3-T03` |
| STAGE | `3` |
| TASK_TYPE | red-green implementation |
| BUSINESS_OBLIGATION | S-10 精确 `3 -> soft_draining_to_1 -> steady(max_active_turns=1)`：零新接纳、不杀 active、`activeLeaseCount()===0` 原子完成；F1/G4 |
| SELECTED_PRIMARY_SKILL | `tdd` |
| SELECTED_SUPPORTING_SKILLS | `implement` |
| SKILL_SELECTION_REASON | Controller 澄清（handoff §2.4-3） |
| SKILL_SOURCE_IDENTITY | 同 §6.1 |
| SKILL_REQUIRED_STEPS | 完整读取 SKILL.md；RED 先于 GREEN；minimal GREEN = `beginSoftDrainTo1(owner, now)` 原子置 `drain_state='soft_draining_to_1'`、拒新接纳、active 不 kill、queued 保持；完成 = `activeLeaseCount()===0` 原子置 `'steady'`+`max_active_turns=1`+journal `policy_drain_completed`；`drain_state` 仅允许两值 |
| SKILL_EXPECTED_OUTPUT | RED receipt → minimal GREEN → GREEN receipt；跨进程时间线 |
| SKILL_FORBIDDEN_SHORTCUTS | 不得 kill active；不得把 `drain_state` 写为数值 1；不得单值排空态；不得本地扩容量；已 steady(1) 时调用 = 幂等 no-op |
| SKILL_COMPLETION_CRITERIA | 软排空全流程断言绿；第二 opener `assertDurablePolicyMatch` 观察同一元组 |
| METHOD_CONFORMANCE_EVIDENCE | §6.0 |
| DEPENDENCIES | S3-T02 |
| EXACT_GIT_BASELINE | §6.0 |
| AUTHORITY_PATHS_AND_HASHES | §6.0 base + S2-ARCH-001（§17-5）/S2-DOMAIN-001（§6.1）/S2-TEST-001（G4） |
| ALLOWED_WRITE_SET | `Admission Controller/controller.ts`、`tests/admission-soft-drain.test.ts` + receipts |
| FORBIDDEN_SURFACES | §6.0 |
| RESOURCE_SET | §2.4（跨进程） |
| EXACT_ACCEPTANCE | RED-1：live HEAD 无 `beginSoftDrainTo1`/`drain_state` → 「切换接受、drain 期零新接纳、active 不动、queued 保持、原子完成、B 同观」红；GREEN 后全绿 |
| TYPED_BLOCKERS | §6.0 通用集 |
| RED_RECEIPT_CONTRACT | 命令 `npm test -- tests/admission-soft-drain.test.ts`；receipt `red-1.txt` |
| GREEN_EVIDENCE_CONTRACT | 同命令通过；receipt `green-1.txt`；focused/affected/broad |
| REVIEW_ASSIGNMENT_CONSTRAINT | §6.0；impact target `AdmissionController`/`hasSeatCapacity`（HIGH 预期）→ 上报 + broad |
| INTEGRATION_TARGET | 验收第 2 阶段；accepted refs → 双审 → Single Integrator |

### 6.4 S3-T04 — 调度/公平/start gate 回归

| 字段 | 值 |
| --- | --- |
| TASK_ID | `S3-T04` |
| STAGE | `3` |
| TASK_TYPE | green regression / test-evidence |
| BUSINESS_OBLIGATION | S-13/S-16/S-19（+S-11 相关）oldest-eligible、owner-only、单 start/2s、progress 观察；F2/F3 |
| SELECTED_PRIMARY_SKILL | `tdd` |
| SELECTED_SUPPORTING_SKILLS | `implement` |
| SKILL_SELECTION_REASON | Controller 澄清（handoff §2.4-3，green regression 绑定） |
| SKILL_SOURCE_IDENTITY | 同 §6.1 |
| SKILL_REQUIRED_STEPS | 完整读取 SKILL.md；seam = `markStarting`/`selectEligibleRequest`/`orderedQueuedRequests`（public boundary）；green-only；期望值来自 Scheme 常量 |
| SKILL_EXPECTED_OUTPUT | 新回归文件 + 三条 green receipts |
| SKILL_FORBIDDEN_SHORTCUTS | 不写生产源码/不碰 policy；不把 F7 迁移前字段名写成终态（T18 后改用 `agent_id`） |
| SKILL_COMPLETION_CRITERIA | 三回归绿：间隔 <2000ms 第二次 `markStarting` 抛错；active agent 的 queued 让位 idle agent（B 先 admit）；同 agent FIFO `enqueued_at ASC, request_id ASC` |
| METHOD_CONFORMANCE_EVIDENCE | §6.0 |
| DEPENDENCIES | S3-T01 |
| EXACT_GIT_BASELINE | §6.0 |
| AUTHORITY_PATHS_AND_HASHES | §6.0 base + S2-SPEC-001（C1）/S2-TEST-001（M2） |
| ALLOWED_WRITE_SET | `tests/admission-scheduling-contract.test.ts` + receipts |
| FORBIDDEN_SURFACES | §6.0 |
| RESOURCE_SET | §2.4 |
| EXACT_ACCEPTANCE | 三条 green receipts；F7 关联：T18 完成后本矩阵断言改用 `agent_id`/`agentId`（属 T18 的 affected 验证） |
| TYPED_BLOCKERS | §6.0 通用集 |
| RED_RECEIPT_CONTRACT | 不适用（无 RED） |
| GREEN_EVIDENCE_CONTRACT | `npm test -- tests/admission-scheduling-contract.test.ts`；receipt `green-1/2/3.txt` |
| REVIEW_ASSIGNMENT_CONSTRAINT | §6.0；impact target `markStarting`（LOW,1）、`completeLiveTurn`（LOW,2）、`AdmissionTurnCoordinator`（LOW,18） |
| INTEGRATION_TARGET | 验收第 1 阶段；accepted refs → 双审 → 集成 |

### 6.5 S3-T05 — timeout/payload/eligibility 回归

| 字段 | 值 |
| --- | --- |
| TASK_ID | `S3-T05` |
| STAGE | `3` |
| TASK_TYPE | green regression / test-evidence |
| BUSINESS_OBLIGATION | S-12/S-17/S-15（eligibility 面）30 分钟 timeout + payload 同事务删除；F2 |
| SELECTED_PRIMARY_SKILL | `tdd` |
| SELECTED_SUPPORTING_SKILLS | `implement` |
| SKILL_SELECTION_REASON | Controller 澄清（handoff §2.4-3） |
| SKILL_SOURCE_IDENTITY | 同 §6.1 |
| SKILL_REQUIRED_STEPS | 完整读取 SKILL.md；seam = `expireQueued`/`selectEligibleRequest`；green-only |
| SKILL_EXPECTED_OUTPUT | 新回归文件 + 两条 green receipts |
| SKILL_FORBIDDEN_SHORTCUTS | 不碰 crypto/schema；不 mutation-as-RED |
| SKILL_COMPLETION_CRITERIA | timeout 终态 + `turn_payloads` 0 行（同事务）；cooldown/cancel/timeout 旧请求被跳过、后续 eligible 仍 admit |
| METHOD_CONFORMANCE_EVIDENCE | §6.0 |
| DEPENDENCIES | S3-T01 |
| EXACT_GIT_BASELINE | §6.0 |
| AUTHORITY_PATHS_AND_HASHES | §6.0 base + S2-SPEC-001（C2）/S2-TEST-001（M3） |
| ALLOWED_WRITE_SET | `tests/admission-timeout-contract.test.ts` + receipts |
| FORBIDDEN_SURFACES | §6.0 |
| RESOURCE_SET | §2.4 |
| EXACT_ACCEPTANCE | green-1：enqueue now=0 deadline=30min、admitNext now=31min → `queue_timeout` 且 payload 0 行；green-2：不可运行旧请求不堵后续 admit |
| TYPED_BLOCKERS | §6.0 通用集 |
| RED_RECEIPT_CONTRACT | 不适用（无 RED） |
| GREEN_EVIDENCE_CONTRACT | `npm test -- tests/admission-timeout-contract.test.ts`；receipt `green-1/2.txt` |
| REVIEW_ASSIGNMENT_CONSTRAINT | §6.0 |
| INTEGRATION_TARGET | 验收第 1 阶段；accepted refs → 双审 → 集成 |

### 6.6 S3-T06 — queued-owner 有界处置（G5）

| 字段 | 值 |
| --- | --- |
| TASK_ID | `S3-T06` |
| STAGE | `3` |
| TASK_TYPE | red-green implementation |
| BUSINESS_OBLIGATION | S-15/S-18 queued-owner durable 绑定 + verified-exit 有界 `cancelled`（reason=`queued_owner_dead`）处置、同事务删 payload、不 replay、不堵 eligible；F2/G5 |
| SELECTED_PRIMARY_SKILL | `tdd` |
| SELECTED_SUPPORTING_SKILLS | `implement` |
| SKILL_SELECTION_REASON | Controller 澄清（handoff §2.4-3） |
| SKILL_SOURCE_IDENTITY | 同 §6.1 |
| SKILL_REQUIRED_STEPS | 完整读取 SKILL.md；RED 先于 GREEN（live HEAD dead owner 堵队至 30min）；消费 T18 已创建的 queued-owner 列/表；minimal GREEN：enqueue 同事务写 owner record/reference，`settleQueuedOwnerDeath` 在进程证据 gone 时写 `cancelled` + reason/event `queued_owner_dead`、同事务删 payload、释放队列位置；零重放 |
| SKILL_EXPECTED_OUTPUT | RED receipt → minimal GREEN → GREEN receipt；跨进程 owner-crash 时间线 |
| SKILL_FORBIDDEN_SHORTCUTS | 不得修改 `schema.ts`/migration；不得等 30 分钟兜底；不得 replay；不得把 agent key 当 process liveness；不得级联删除请求（证据删除非级联） |
| SKILL_COMPLETION_CRITERIA | verified owner exit + no-dispatch proof 后原 request 成为 `cancelled(reason=queued_owner_dead)`，每 turn 恰好一个 cancel terminal；后续请求在有界时间内可 admit；payload 已删；零重放；eligibility 不变 |
| METHOD_CONFORMANCE_EVIDENCE | §6.0 |
| DEPENDENCIES | S3-T03、S3-T05、S3-T13、S3-T18（DAG 串行 + v2 owner 列/表先建） |
| EXACT_GIT_BASELINE | §6.0 |
| AUTHORITY_PATHS_AND_HASHES | §6.0 base + S2-ARCH-001（§17-3）/S2-DOMAIN-001（queued-owner）/S2-TEST-001（G5/M3） |
| ALLOWED_WRITE_SET | `Admission Controller/controller.ts`、`ACP Connector/admission/startup-recovery.ts`、`tests/admission-owner-crash.test.ts` + receipts |
| FORBIDDEN_SURFACES | §6.0 |
| RESOURCE_SET | §2.4（child helper 跨进程） |
| EXACT_ACCEPTANCE | RED-1：live HEAD child enqueue 后 SIGKILL，queued 请求堵至 30min（无 owner 列/表/`settleQueuedOwnerDeath`）→ 断言「verified exit 后原 request 在有界时间内成为 `cancelled(reason=queued_owner_dead)` + exactly one cancel terminal + payload 同事务删/移除队列占位 + 后续 eligible 可 admit + 零重放」红；GREEN 后全绿 |
| TYPED_BLOCKERS | §6.0 通用集 |
| RED_RECEIPT_CONTRACT | 命令 `npm test -- tests/admission-owner-crash.test.ts`；receipt `red-1.txt` |
| GREEN_EVIDENCE_CONTRACT | 同命令通过；receipt `green-1.txt`；focused/affected/broad |
| REVIEW_ASSIGNMENT_CONSTRAINT | §6.0；impact target `recoverExitedAdmissionSeats`（HIGH,3）、`enqueueWithPayload`（查询后升级）→ 上报 + broad |
| INTEGRATION_TARGET | 验收第 2 阶段；accepted refs → 双审 → Single Integrator |

### 6.7 S3-T07 — 独立结构化失败分类器回归（负分类）

| 字段 | 值 |
| --- | --- |
| TASK_ID | `S3-T07` |
| STAGE | `3` |
| TASK_TYPE | green regression / test-evidence（结构化分类器 + 负 cooldown 矩阵） |
| BUSINESS_OBLIGATION | S-23/S-24 七类独立分类；429/auth/permission/timeout/transport 永不写 capacity cooldown；F5/G9 |
| SELECTED_PRIMARY_SKILL | `tdd` |
| SELECTED_SUPPORTING_SKILLS | `implement` |
| SKILL_SELECTION_REASON | Controller 澄清（handoff §2.4-3）；本 task 是内部完成屏障的可执行负分类证据（§2.4-2） |
| SKILL_SOURCE_IDENTITY | 同 §6.1 |
| SKILL_REQUIRED_STEPS | 完整读取 SKILL.md；seam = `classifyProviderFailure` 纯函数 + `setCapacityCooldown` 负矩阵；输入为**结构化合成输入**（非 fake 文本）；green-only |
| SKILL_EXPECTED_OUTPUT | 新回归文件 + 两条 green receipts |
| SKILL_FORBIDDEN_SHORTCUTS | 不得扩展 `failureFromAgyError` 自由文本为 trusted 识别；不得改 controller cooldown 语义；不得用 fake stderr 声称真实 503 |
| SKILL_COMPLETION_CRITERIA | `{httpStatus:503,code:"UNAVAILABLE"}`/`{503,"MODEL_CAPACITY_EXHAUSTED"}` → provider_capacity；`{503,"QUOTA_EXHAUSTED"}`、`{429}`、`{401}`、`{403}`、`{timeout:true}`、`{502}` → 非 capacity 且 `cooldowns` 无新行 |
| METHOD_CONFORMANCE_EVIDENCE | §6.0 |
| DEPENDENCIES | S3-T01 |
| EXACT_GIT_BASELINE | §6.0 |
| AUTHORITY_PATHS_AND_HASHES | §6.0 base + S2-SPIKE-503-001（锁定三元组）/S2-SPEC-001（F5/C3）/S2-TEST-001（M4） |
| ALLOWED_WRITE_SET | `tests/admission-503-classifier.test.ts` + receipts |
| FORBIDDEN_SURFACES | §6.0 |
| RESOURCE_SET | §2.4 |
| EXACT_ACCEPTANCE | green-1 分类矩阵全绿；green-2 负 cooldown 矩阵（非 capacity 写入后 `cooldowns` 无新行） |
| TYPED_BLOCKERS | §6.0 通用集 |
| RED_RECEIPT_CONTRACT | 不适用（无 RED） |
| GREEN_EVIDENCE_CONTRACT | `npm test -- tests/admission-503-classifier.test.ts`；receipt `green-1/2.txt` |
| REVIEW_ASSIGNMENT_CONSTRAINT | §6.0；impact target `classifyProviderFailure`（LOW,3）、`setCapacityCooldown`（查询后升级） |
| INTEGRATION_TARGET | 验收第 1 阶段 + 内部完成屏障依赖（T20/T21 前驱）；accepted refs → 双审 → 集成 |

### 6.8 S3-T08 — trusted-503 外部依赖门（typed stop）

| 字段 | 值 |
| --- | --- |
| TASK_ID | `S3-T08` |
| STAGE | `3` |
| TASK_TYPE | external typed dependency gate（非实现；无 RED/READY/GREEN；无仓库实现写） |
| BUSINESS_OBLIGATION | S-22 唯一外部 disposition：`SOURCE_FIELD_GAP` + `REAL_PROVIDER_REQUIRED` + `SOURCE_IDENTITY_UNKNOWN` 保持开放；F5/G9 |
| SELECTED_PRIMARY_SKILL | `diagnosing-bugs` |
| SELECTED_SUPPORTING_SKILLS | `triage` |
| SKILL_SELECTION_REASON | Controller 澄清（handoff §2.4-3）固定绑定；任务唯一可执行内容是核验外部失败证据链是否闭合并正确记录 typed-blocked；无代码可循环，skill 的 red-capable loop 步骤 inapplicable under project authority（记录） |
| SKILL_SOURCE_IDENTITY | `mattpocock/skills@8b78b531ab965735c5dc74f6f7a219e1e37326df`；`/home/tiezbro/.agents/skills/diagnosing-bugs/SKILL.md`、`/home/tiezbro/.agents/skills/triage/SKILL.md`（启动时核验） |
| SKILL_REQUIRED_STEPS | 完整读取 SKILL.md；复核 S2-SPIKE-503-001 锁定结论与重开条件；确认无 trusted-503 RED/READY/regex/phrase 归一化/fake-binary truth 声称被创建；写 typed-blocked receipt |
| SKILL_EXPECTED_OUTPUT | `docs/design/receipts/S3-T08/typed-blocked.txt`（三元组 + 重开条件） |
| SKILL_FORBIDDEN_SHORTCUTS | 不得把 typed-blocked 变成 RED/READY/实现任务；不得写仓库实现/测试/合同；不得把 `429`/transport 测试误标为 trusted-503 证据；负分类不开 capacity cooldown |
| SKILL_COMPLETION_CRITERIA | typed-blocked receipt 存在且 gate 措辞完整；排除于 `READY_FRONTIER`；T20/T21 依赖不含本 task（§2.2） |
| METHOD_CONFORMANCE_EVIDENCE | §6.0 |
| DEPENDENCIES | S3-T07 |
| EXACT_GIT_BASELINE | §6.0 |
| AUTHORITY_PATHS_AND_HASHES | §6.0 base + S2-SPIKE-503-001（唯一 gate authority） |
| ALLOWED_WRITE_SET | `docs/design/receipts/S3-T08/typed-blocked.txt` only |
| FORBIDDEN_SURFACES | §6.0（本 task 无任何仓库实现写） |
| RESOURCE_SET | §2.4（只读；不运行 Provider） |
| EXACT_ACCEPTANCE | 三元组逐字记录；重开条件 = S2-SPIKE-503-001 §6 两项之一（pinned source/call-path 或授权隔离观测）形成 receipt 前不得重开；无 unresolved blockers=none 声称 |
| TYPED_BLOCKERS | `SOURCE_FIELD_GAP`、`REAL_PROVIDER_REQUIRED`、`SOURCE_IDENTITY_UNKNOWN`（保持开放；非内部歧义） |
| RED_RECEIPT_CONTRACT | 不适用（无 RED；无 GREEN；receipt = `typed-blocked.txt`） |
| GREEN_EVIDENCE_CONTRACT | 不适用（gate 关闭；无 GREEN） |
| REVIEW_ASSIGNMENT_CONSTRAINT | §6.0；Spec Review 核对三元组与重开条件与 S2-SPIKE-503-001 一致 |
| INTEGRATION_TARGET | 无集成 ref；typed-blocked receipt 作为 Stage 3 完整性输入（不进入 READY/不阻塞内部路径） |

### 6.9 S3-T09 — enabled auth gate（G1）

| 字段 | 值 |
| --- | --- |
| TASK_ID | `S3-T09` |
| STAGE | `3` |
| TASK_TYPE | red-green implementation |
| BUSINESS_OBLIGATION | S-20/S-21/S-37 Admission enabled 时 v1/v2 四个 auth 入口 fail closed；disabled legacy 保持；F4/C6/G1 |
| SELECTED_PRIMARY_SKILL | `tdd` |
| SELECTED_SUPPORTING_SKILLS | `implement` |
| SKILL_SELECTION_REASON | Controller 澄清（handoff §2.4-3） |
| SKILL_SOURCE_IDENTITY | 同 §6.1 |
| SKILL_REQUIRED_STEPS | 完整读取 SKILL.md；RED 先于 GREEN（live HEAD 四入口无 gate）；minimal GREEN：enabled 时 `authenticate`/`loginAuth`/`logout`/`logoutAuth` 抛 typed Admission-enabled error；disabled 分支零改动 |
| SKILL_EXPECTED_OUTPUT | RED receipt → minimal GREEN → GREEN receipt（enabled + disabled regression） |
| SKILL_FORBIDDEN_SHORTCUTS | 不得修改 disabled legacy auth 行为；不得以「存在 gate 文件」代替行为断言 |
| SKILL_COMPLETION_CRITERIA | enabled 四调用全部 fail closed；disabled 同序列 legacy 行为保持（现有 auth.test/acp-server.test 绿） |
| METHOD_CONFORMANCE_EVIDENCE | §6.0 |
| DEPENDENCIES | S3-T01、S3-T18（`agent.ts` rename 先于 auth gate） |
| EXACT_GIT_BASELINE | §6.0 |
| AUTHORITY_PATHS_AND_HASHES | §6.0 base + S2-RECON-ACP-001（F3）/S2-ARCH-001（§17-8）/S2-TEST-001（G1/M5） |
| ALLOWED_WRITE_SET | `ACP Connector/acp/agent.ts`、`ACP Connector/acp/authenticate.ts`、`ACP Connector/acp/auth/login.ts`、`ACP Connector/acp/auth/logout.ts`、`ACP Connector/acp/logout.ts`、`tests/admission-auth-gate.test.ts` + receipts |
| FORBIDDEN_SURFACES | §6.0 |
| RESOURCE_SET | §2.4 |
| EXACT_ACCEPTANCE | RED-1：enabled 四调用成功放行 → 「全部 fail closed」红；green-1：disabled 同序列 legacy 保持 |
| TYPED_BLOCKERS | §6.0 通用集 |
| RED_RECEIPT_CONTRACT | 命令 `npm test -- tests/admission-auth-gate.test.ts`；receipt `red-1.txt` |
| GREEN_EVIDENCE_CONTRACT | 同命令通过（enabled RED→GREEN + disabled regression）；receipt `green-1.txt` |
| REVIEW_ASSIGNMENT_CONSTRAINT | §6.0；impact target `authenticate`/`loginAuth`/`logoutAuth`/`handleLogout`（MEDIUM） |
| INTEGRATION_TARGET | 验收第 4 阶段（fake agy full chain）；accepted refs → 双审 → Single Integrator |

### 6.10 S3-T10 — permission 链修复（G7）

| 字段 | 值 |
| --- | --- |
| TASK_ID | `S3-T10` |
| STAGE | `3` |
| TASK_TYPE | red-green implementation |
| BUSINESS_OBLIGATION | S-35 删除三处强制 `dangerously-skip-permissions`；交互权限面板可达；唯一 fencing seam = `AgyAdmissionDispatchBoundary`（`TurnDispatchBoundary`）；permission-key PTY 写非业务写；F4/C4/G7 |
| SELECTED_PRIMARY_SKILL | `tdd` |
| SELECTED_SUPPORTING_SKILLS | `implement` |
| SKILL_SELECTION_REASON | Controller 澄清（handoff §2.4-3） |
| SKILL_SOURCE_IDENTITY | 同 §6.1 |
| SKILL_REQUIRED_STEPS | 完整读取 SKILL.md；RED 先于 GREEN（live HEAD 强制 skip/拒绝交互权限）；minimal GREEN：删 `setup.ts:44-49`/`agent.ts:480-489`/`cli.ts:535-539` 三处强制；`runInteractivePrompt` 可达；fence 只在首次业务写；**不新增任何新接口/新 seam/新写集** |
| SKILL_EXPECTED_OUTPUT | RED receipt → minimal GREEN → GREEN receipt |
| SKILL_FORBIDDEN_SHORTCUTS | 不得新增平行深接口；不得把 permission 决策移入 Admission；不得把 permission-key 写计为业务 dispatch；不得触碰 Admission Controller 状态机 |
| SKILL_COMPLETION_CRITERIA | `default`/`accept-edits`/`plan` 任一模式在 enabled 下可达权限面板；`session/request_permission` 可用；业务写恰好一次且 fenced；key 写不计数 |
| METHOD_CONFORMANCE_EVIDENCE | §6.0 |
| DEPENDENCIES | S3-T09 |
| EXACT_GIT_BASELINE | §6.0 |
| AUTHORITY_PATHS_AND_HASHES | §6.0 base + S2-RECON-ACP-001（§4.4）/S2-ARCH-001（§8.5/§17-1）/S2-TEST-001（G7/M5） |
| ALLOWED_WRITE_SET | `ACP Connector/acp/session/setup.ts`、`ACP Connector/acp/agent.ts`、`ACP Connector/agy/cli.ts`、`ACP Connector/acp/session/request-permission.ts`、`tests/admission-permission.test.ts` + receipts |
| FORBIDDEN_SURFACES | §6.0 |
| RESOURCE_SET | §2.4 |
| EXACT_ACCEPTANCE | RED-1：enabled + 非 skip 模式经 `buildSession→AgyCliSession.prompt→runInteractivePrompt` 被强制 skip/抛 `admission_requires_prompt_free_print_mode` → 「权限面板可达、key 写非业务写、业务写一次且 fenced」红；GREEN 后全绿 |
| TYPED_BLOCKERS | §6.0 通用集 |
| RED_RECEIPT_CONTRACT | 命令 `npm test -- tests/admission-permission.test.ts`；receipt `red-1.txt` |
| GREEN_EVIDENCE_CONTRACT | 同命令通过；receipt `green-1.txt`；focused/affected（auth/acp-server/runtime-wiring/cli/queue-steer）/broad |
| REVIEW_ASSIGNMENT_CONSTRAINT | §6.0；impact target `composeAcpRuntime`（LOW,2）、`buildSession`/`runPromptCommand`/`runInteractivePrompt`（HIGH 预期）→ 上报 + 扩大回归 |
| INTEGRATION_TARGET | 验收第 4 阶段；accepted refs → 双审 → Single Integrator |

### 6.11 S3-T11 — dispatch fault-point 回归

| 字段 | 值 |
| --- | --- |
| TASK_ID | `S3-T11` |
| STAGE | `3` |
| TASK_TYPE | green regression / test-evidence |
| BUSINESS_OBLIGATION | S-25/S-16 fault points 原子性、零重放、`writeAttempts<=1`；F3/C4 |
| SELECTED_PRIMARY_SKILL | `tdd` |
| SELECTED_SUPPORTING_SKILLS | `implement` |
| SKILL_SELECTION_REASON | Controller 澄清（handoff §2.4-3） |
| SKILL_SOURCE_IDENTITY | 同 §6.1 |
| SKILL_REQUIRED_STEPS | 完整读取 SKILL.md；seam = `recordProcessIdentity`/`commitDispatchIntent`/`TurnDispatchBoundary` + `faultInjection`；green-only |
| SKILL_EXPECTED_OUTPUT | 新回归文件 + 两条 green receipts |
| SKILL_FORBIDDEN_SHORTCUTS | 无源码编辑；回归证明缺陷时按诊断循环升级 blocker（不静默修源码） |
| SKILL_COMPLETION_CRITERIA | fault 后 `not_recorded/transaction_fault`、lease 保持 `starting`、identity 行 0；stale fence `beforePromptWrite` 抛错不写；`afterPromptWrite` 后 payload 删、state=active、二次 `run()` 返回同 result（spawns/writes=1） |
| METHOD_CONFORMANCE_EVIDENCE | §6.0 |
| DEPENDENCIES | S3-T01 |
| EXACT_GIT_BASELINE | §6.0 |
| AUTHORITY_PATHS_AND_HASHES | §6.0 base + S2-SPEC-001（C4）/S2-TEST-001（M6） |
| ALLOWED_WRITE_SET | `tests/admission-dispatch-faultpoints.test.ts` + receipts |
| FORBIDDEN_SURFACES | §6.0 |
| RESOURCE_SET | §2.4 |
| EXACT_ACCEPTANCE | green-1 fault 注入断言；green-2 fence/once-only 断言 |
| TYPED_BLOCKERS | §6.0 通用集 |
| RED_RECEIPT_CONTRACT | 不适用（无 RED） |
| GREEN_EVIDENCE_CONTRACT | `npm test -- tests/admission-dispatch-faultpoints.test.ts`；receipt `green-1/2.txt` |
| REVIEW_ASSIGNMENT_CONSTRAINT | §6.0 |
| INTEGRATION_TARGET | 验收第 1 阶段；accepted refs → 双审 → 集成 |

### 6.12 S3-T12 — 生产 Pipe dispatch 接线（G8）

| 字段 | 值 |
| --- | --- |
| TASK_ID | `S3-T12` |
| STAGE | `3` |
| TASK_TYPE | red-green implementation |
| BUSINESS_OBLIGATION | S-25/S-36 生产 `runPromptCommand` 改走 `AgyPromptFreeDispatchBoundary.run`：spawnPromptFree→persistProcessIdentity→recheckCancellation→commitDispatchIntent→writeInitialPrompt 全同步；`accepted→markActive`、`blocked/dispatch_ambiguous→markDispatchAmbiguous`；`writeAttempts<=1` 零重放；PTY 写经同一 fence；F3/C4/G8 |
| SELECTED_PRIMARY_SKILL | `tdd` |
| SELECTED_SUPPORTING_SKILLS | `implement` |
| SKILL_SELECTION_REASON | Controller 澄清（handoff §2.4-3） |
| SKILL_SOURCE_IDENTITY | 同 §6.1 |
| SKILL_REQUIRED_STEPS | 完整读取 SKILL.md；RED 先于 GREEN（live HEAD `cli.ts:1132-1142` 已有 inline hooks，但无 accepted/ambiguous 三态结果映射）；minimal GREEN = 生产接线 + 三态映射 + 信号/descendant cleanup 一致 |
| SKILL_EXPECTED_OUTPUT | RED receipt → minimal GREEN → GREEN receipt（active/blocked/dispatch_ambiguous/partial-write/EOF/signal/descendant 各断言） |
| SKILL_FORBIDDEN_SHORTCUTS | 不得新增第二输出路径/新接口/新写集；不得绕过现有 fence 或丢失三态结果；不得 retry；`NO_CORRECT_TEST_SEAM` 预案（S2-TEST-001 §5.6）：无注入 seam 可红时先建 seam 再 RED，不发明 implementation-coupled source-string RED |
| SKILL_COMPLETION_CRITERIA | 生产路径业务写 attempts≤1、零重放、accepted→markActive、ambiguous/blocked→markDispatchAmbiguous；PTY 路径权限通过后 fenced 写 |
| METHOD_CONFORMANCE_EVIDENCE | §6.0 |
| DEPENDENCIES | S3-T10、S3-T11 |
| EXACT_GIT_BASELINE | §6.0 |
| AUTHORITY_PATHS_AND_HASHES | §6.0 base + S2-RECON-ACP-001（production dispatch gap）/S2-ARCH-001（§10/§17-2）/S2-TEST-001（G8/M6） |
| ALLOWED_WRITE_SET | `ACP Connector/agy/cli.ts`、`ACP Connector/agy/prompt-free-process.ts`、`ACP Connector/agy/dispatch-boundary.ts`、`tests/admission-production-dispatch.test.ts` + receipts |
| FORBIDDEN_SURFACES | §6.0 |
| RESOURCE_SET | §2.4（fake agy native process） |
| EXACT_ACCEPTANCE | RED-1：fake-agy + `AgyCliSession.prompt`（生产入口）驱动 → 「业务写 ≤1、零重放、三态映射」红；GREEN 后全绿 |
| TYPED_BLOCKERS | §6.0 通用集 + `NO_CORRECT_TEST_SEAM`（仅真实 seam 缺失时） |
| RED_RECEIPT_CONTRACT | 命令 `npm test -- tests/admission-production-dispatch.test.ts`；receipt `red-1.txt` |
| GREEN_EVIDENCE_CONTRACT | 同命令通过；receipt `green-1.txt`；focused/affected（agy-dispatch/prompt-free/prompt-free-canary/cli）/broad |
| REVIEW_ASSIGNMENT_CONSTRAINT | §6.0；impact target `AgyCliSession.prompt`/`runPromptCommand`（HIGH 预期）、`AgyPromptFreeDispatchBoundary`（LOW,28）→ 上报 + 扩大回归 |
| INTEGRATION_TARGET | 验收第 4 阶段；accepted refs → 双审 → Single Integrator |

### 6.13 S3-T13 — process identity/startup recovery 回归

| 字段 | 值 |
| --- | --- |
| TASK_ID | `S3-T13` |
| STAGE | `3` |
| TASK_TYPE | green regression / test-evidence |
| BUSINESS_OBLIGATION | S-27 完整 process evidence 元组、PID reuse fail closed、启动期释放；F6/C5/G6 |
| SELECTED_PRIMARY_SKILL | `tdd` |
| SELECTED_SUPPORTING_SKILLS | `implement` |
| SKILL_SELECTION_REASON | Controller 澄清（handoff §2.4-3） |
| SKILL_SOURCE_IDENTITY | 同 §6.1 |
| SKILL_REQUIRED_STEPS | 完整读取 SKILL.md；seam = `observeLinuxProcessIdentity`/`releaseExitedRecoverySeat`（注入 readers）；green-only |
| SKILL_EXPECTED_OUTPUT | 新回归文件 + 两条 green receipts |
| SKILL_FORBIDDEN_SHORTCUTS | 不把 PID 存在/缺失单独当证据；不把「重启 Connector」当验收路径 |
| SKILL_COMPLETION_CRITERIA | 相同 startTimeTicks 不同 bootId → `pid_reused`；connector gone + child gone + pgrp empty → 启动期释放 |
| METHOD_CONFORMANCE_EVIDENCE | §6.0 |
| DEPENDENCIES | S3-T01 |
| EXACT_GIT_BASELINE | §6.0 |
| AUTHORITY_PATHS_AND_HASHES | §6.0 base + S2-DOMAIN-001（§7）/S2-TEST-001（M7） |
| ALLOWED_WRITE_SET | `tests/admission-process-evidence-contract.test.ts` + receipts |
| FORBIDDEN_SURFACES | §6.0 |
| RESOURCE_SET | §2.4（injected `/proc` readers） |
| EXACT_ACCEPTANCE | green-1 `pid_reused` 断言；green-2 启动期释放断言 |
| TYPED_BLOCKERS | §6.0 通用集 |
| RED_RECEIPT_CONTRACT | 不适用（无 RED） |
| GREEN_EVIDENCE_CONTRACT | `npm test -- tests/admission-process-evidence-contract.test.ts`；receipt `green-1/2.txt` |
| REVIEW_ASSIGNMENT_CONSTRAINT | §6.0；impact target `observeLinuxProcessIdentity`（HIGH,5）→ 上报 + broad |
| INTEGRATION_TARGET | 验收第 1/3 阶段；accepted refs → 双审 → 集成 |

### 6.14 S3-T14 — heartbeat suspect + runtime reaper（G6）

| 字段 | 值 |
| --- | --- |
| TASK_ID | `S3-T14` |
| STAGE | `3` |
| TASK_TYPE | red-green implementation |
| BUSINESS_OBLIGATION | S-26/S-28/S-29 heartbeat 过期只标 suspect；`reapSuspects(now, readers)` 确定性有界覆盖 queued/admitted/starting-before-identity/dispatch_intent-active-after-identity/recovery_required；验证退出释放本地 seat、`recovery_required` 保持可见、零重放、不依赖重启；三次 recovery 不烧满 3 席；F6/G6 |
| SELECTED_PRIMARY_SKILL | `tdd` |
| SELECTED_SUPPORTING_SKILLS | `implement` |
| SKILL_SELECTION_REASON | Controller 澄清（handoff §2.4-3） |
| SKILL_SOURCE_IDENTITY | 同 §6.1 |
| SKILL_REQUIRED_STEPS | 完整读取 SKILL.md；RED 先于 GREEN（live HEAD 无 suspect/reaper，运行期席位不恢复）；minimal GREEN：v2 `leases.suspect_since`/`suspect_reason`（允许值 `heartbeat_expired`/`identity_unverifiable`）+ `reapSuspects`（connector/child/pgrp 证据链；`same/unverifiable` 保留；完整 gone/empty 释放）+ 无重启运行期恢复 |
| SKILL_EXPECTED_OUTPUT | 两条 RED receipts → minimal GREEN → GREEN receipt（跨进程） |
| SKILL_FORBIDDEN_SHORTCUTS | 不得 time/PID-only 释放；不得以重启 Connector 作为验收路径；不得把 heartbeat 超时当死亡证明 |
| SKILL_COMPLETION_CRITERIA | 三个 recovery_required + 验证退出 → 有界间隔后容量恢复；heartbeat 过期仅 suspect 不释放 |
| METHOD_CONFORMANCE_EVIDENCE | §6.0 |
| DEPENDENCIES | S3-T06、S3-T13、S3-T18（v2 suspect 列先建） |
| EXACT_GIT_BASELINE | §6.0 |
| AUTHORITY_PATHS_AND_HASHES | §6.0 base + S2-ARCH-001（§17-4）/S2-DOMAIN-001（§7.2）/S2-TEST-001（G6/M7） |
| ALLOWED_WRITE_SET | `Admission Controller/controller.ts`、`Admission Controller/process-evidence.ts`、`ACP Connector/admission/startup-recovery.ts`、`ACP Connector/admission/owner-instance.ts`、`tests/admission-reaper.test.ts` + receipts |
| FORBIDDEN_SURFACES | §6.0 |
| RESOURCE_SET | §2.4（跨进程 + injected readers） |
| EXACT_ACCEPTANCE | RED-1：三 recovery + 验证退出 + 不重启 → `admitNext` 仍 null（三席烧满）→ 「容量有界恢复、recovery_required 保持可见、payload 已删、零重放」红；RED-2：heartbeat 过期未验证 → 「仅 suspect 不释放」红；GREEN 后全绿 |
| TYPED_BLOCKERS | §6.0 通用集 |
| RED_RECEIPT_CONTRACT | 命令 `npm test -- tests/admission-reaper.test.ts`；receipt `red-1.txt`/`red-2.txt` |
| GREEN_EVIDENCE_CONTRACT | 同命令通过；receipt `green-1.txt`；focused/affected/broad |
| REVIEW_ASSIGNMENT_CONSTRAINT | §6.0；impact target `heartbeat`/`listRecoverableDispatches`/`markExecutionRecoveryRequired`/`releaseExitedRecoverySeat`（HIGH 预期）、`observeLinuxProcessIdentity`（HIGH,5）→ 上报 + broad |
| INTEGRATION_TARGET | 验收第 2 阶段；accepted refs → 双审 → Single Integrator |

### 6.15 S3-T15 — cancel/steer/disconnect/heartbeat 竞态回归

| 字段 | 值 |
| --- | --- |
| TASK_ID | `S3-T15` |
| STAGE | `3` |
| TASK_TYPE | green regression / test-evidence（cross-process exactly-once 锁定） |
| BUSINESS_OBLIGATION | S-30/S-34 竞态单 dispatch/单 terminal/无永久占席；S-11 session 单 turn；F6/C3 |
| SELECTED_PRIMARY_SKILL | `tdd` |
| SELECTED_SUPPORTING_SKILLS | `implement` |
| SKILL_SELECTION_REASON | Controller 澄清（handoff §2.4-3） |
| SKILL_SOURCE_IDENTITY | 同 §6.1 |
| SKILL_REQUIRED_STEPS | 完整读取 SKILL.md；seam = queue-steer + admission 集成 + `completeTurn`；green-only；cancel exactly-once 是 regression/verification（非 speculative RED） |
| SKILL_EXPECTED_OUTPUT | 新回归文件 + 三条 green receipts |
| SKILL_FORBIDDEN_SHORTCUTS | 不预写「may double-terminal」RED；不保留「测试绿任务仍强制」措辞；不写源码；意外红 → §6.0 诊断循环后升级 blocker |
| SKILL_COMPLETION_CRITERIA | heartbeat 抛 `LeaseFenceError` 后 `markExecutionRecoveryRequired` 被调；queued cancel 与 admit 并发单终态；steer 与 disconnect 并发无重复 dispatch/无永久占席 |
| METHOD_CONFORMANCE_EVIDENCE | §6.0 |
| DEPENDENCIES | S3-T04、S3-T05、S3-T11、S3-T13 |
| EXACT_GIT_BASELINE | §6.0 |
| AUTHORITY_PATHS_AND_HASHES | §6.0 base + S2-DOMAIN-001（§5.3）/S2-TEST-001（M8） |
| ALLOWED_WRITE_SET | `tests/admission-race-contract.test.ts` + receipts |
| FORBIDDEN_SURFACES | §6.0 |
| RESOURCE_SET | §2.4 |
| EXACT_ACCEPTANCE | 三条 green receipts（cross-process exactly-once） |
| TYPED_BLOCKERS | §6.0 通用集 |
| RED_RECEIPT_CONTRACT | 不适用（无 RED；cancel 双终态未证明处 = deterministic verification dependency） |
| GREEN_EVIDENCE_CONTRACT | `npm test -- tests/admission-race-contract.test.ts`；receipt `green-1/2/3.txt` |
| REVIEW_ASSIGNMENT_CONSTRAINT | §6.0；impact target `AdmissionTurnCoordinator`（LOW,18）、`completeLiveTurn`（LOW,2） |
| INTEGRATION_TARGET | 验收第 1 阶段；accepted refs → 双审 → 集成 |

### 6.16 S3-T16 — v1/v2 typed terminal（G9）

| 字段 | 值 |
| --- | --- |
| TASK_ID | `S3-T16` |
| STAGE | `3` |
| TASK_TYPE | red-green implementation |
| BUSINESS_OBLIGATION | S-31/S-32/S-33 v1/v2 对 queue_timeout/cancel/provider_failure/recovery_required 各发**恰好一个**真实 typed terminal；失败绝不 `end_turn`；terminal 后立即释放；idle 零占席；F5/C3/G8 |
| SELECTED_PRIMARY_SKILL | `tdd` |
| SELECTED_SUPPORTING_SKILLS | `implement` |
| SKILL_SELECTION_REASON | Controller 澄清（handoff §2.4-3） |
| SKILL_SOURCE_IDENTITY | 同 §6.1 |
| SKILL_REQUIRED_STEPS | 完整读取 SKILL.md；RED 先于 GREEN（live HEAD v2 failure handler `emitTerminal("end_turn")`、v1 抛 RPC error）；唯一 production owner=`ACP Connector/acp/session/prompt.ts`。minimal GREEN：v2 每 turn 恰好一个 idle `state_update`，开放字符串 `stopReason` 输出 `end_turn|cancelled|queue_timeout|provider_failure|recovery_required`；v1 每 turn 恰好一个 `PromptResponse`，success=`end_turn`，cancel=`cancelled`+`_meta["agy-acp/turnTerminal"]={version:1,code:"cancelled"}`，其余三类失败=`refusal`+matching typed meta；不新增第二输出路径 |
| SKILL_EXPECTED_OUTPUT | 两条 RED receipts → exact v1/v2 minimal GREEN → GREEN receipts（含 cancel exactly-once regression、release/idle regression） |
| SKILL_FORBIDDEN_SHORTCUTS | provider_failure 测试仅用 429/transport（绝不 unresolved 503）；不得新增 outbox/replay；不得把 raw RPC throw 当 terminal contract |
| SKILL_COMPLETION_CRITERIA | v2 单 idle `state_update` 与 v1 单 `PromptResponse` tuple 精确匹配；四类失败每类一个 typed terminal 且非 `end_turn`；已知失败无 raw RPC throw；cancel exactly-once；terminal 后立即释放；空闲 session 0 lease、0 resident process |
| METHOD_CONFORMANCE_EVIDENCE | §6.0 |
| DEPENDENCIES | S3-T12、S3-T14 |
| EXACT_GIT_BASELINE | §6.0 |
| AUTHORITY_PATHS_AND_HASHES | §6.0 base + S2-RECON-ACP-001（F4）/S2-ARCH-001（§17-7）/S2-TEST-001（G8/M9） |
| ALLOWED_WRITE_SET | `ACP Connector/acp/session/prompt.ts`、`tests/admission-typed-terminal.test.ts` + receipts |
| FORBIDDEN_SURFACES | §6.0 |
| RESOURCE_SET | §2.4 |
| EXACT_ACCEPTANCE | RED-1 v2 三类失败以 `end_turn` 呈现 → 红；RED-2 v1 无 typed terminal（裸 RPC error）→ 红；green-1 cancel exactly-once；green-2 release；green-3 idle 零占席 |
| TYPED_BLOCKERS | §6.0 通用集 |
| RED_RECEIPT_CONTRACT | 命令 `npm test -- tests/admission-typed-terminal.test.ts`；receipt `red-1.txt`/`red-2.txt` |
| GREEN_EVIDENCE_CONTRACT | 同命令通过；receipt `green-1/2/3.txt`；focused/affected（queue-steer/acp-server/admission-turn-coordinator）/broad |
| REVIEW_ASSIGNMENT_CONSTRAINT | §6.0；impact target `completeTurn`/`v2TerminalEmitter`/`admit`（HIGH 预期）→ 上报 + 扩大回归 |
| INTEGRATION_TARGET | 验收第 4 阶段；accepted refs → 双审 → Single Integrator |

### 6.17 S3-T17 — v1 schema guard + SQLite 事务回归

| 字段 | 值 |
| --- | --- |
| TASK_ID | `S3-T17` |
| STAGE | `3` |
| TASK_TYPE | green regression / test-evidence |
| BUSINESS_OBLIGATION | S-38/S-39（v1 面）schema integrity guard、unexpected-table 拒绝、SQLite contention/busy/rollback/fault；F7/C2/G2 |
| SELECTED_PRIMARY_SKILL | `tdd` |
| SELECTED_SUPPORTING_SKILLS | `implement` |
| SKILL_SELECTION_REASON | Controller 澄清（handoff §2.4-3） |
| SKILL_SOURCE_IDENTITY | 同 §6.1 |
| SKILL_REQUIRED_STEPS | 完整读取 SKILL.md；seam = `assertAdmissionSchemaIntegrity`/`transaction`/`recheckDispatchIdentityAfterContention`/`faultInjection`；green-only |
| SKILL_EXPECTED_OUTPUT | 新回归文件 ×2 + 两条 green receipts |
| SKILL_FORBIDDEN_SHORTCUTS | 不改变 v2 shape；不碰 crypto/key-store 实现 |
| SKILL_COMPLETION_CRITERIA | 合法 v1 DB 通过、插入禁表/删列/关 FK → `SchemaIntegrityError`；child 持锁期间有界重试；fault 后全回滚 |
| METHOD_CONFORMANCE_EVIDENCE | §6.0 |
| DEPENDENCIES | S3-T01 |
| EXACT_GIT_BASELINE | §6.0 |
| AUTHORITY_PATHS_AND_HASHES | §6.0 base + S2-ARCH-001（§11.4）/S2-TEST-001（M10） |
| ALLOWED_WRITE_SET | `tests/admission-schema-contract.test.ts`、`tests/admission-sqlite-contention.test.ts` + receipts |
| FORBIDDEN_SURFACES | §6.0 |
| RESOURCE_SET | §2.4（child helper + fault injection） |
| EXACT_ACCEPTANCE | green-1 guard 断言；green-2 contention/fault 断言；affected（schema/fault-security/process/sqlite-session-store/acp-runtime-wiring）保持绿 |
| TYPED_BLOCKERS | §6.0 通用集 |
| RED_RECEIPT_CONTRACT | 不适用（无 RED） |
| GREEN_EVIDENCE_CONTRACT | `npm test -- tests/admission-schema-contract.test.ts tests/admission-sqlite-contention.test.ts`；receipt `green-1/2.txt` |
| REVIEW_ASSIGNMENT_CONSTRAINT | §6.0；impact target `assertAdmissionSchemaIntegrity`（只读；LOW） |
| INTEGRATION_TARGET | 验收第 1/2 阶段；accepted refs → 双审 → 集成 |

### 6.18 S3-T18 — v2 单次前向迁移 + F7 canonical rename（G2）

| 字段 | 值 |
| --- | --- |
| TASK_ID | `S3-T18` |
| STAGE | `3` |
| TASK_TYPE | red-green implementation（schema/migration） |
| BUSINESS_OBLIGATION | S-14/S-39/S-48；`schema.ts` 与全部 v2 DDL 唯一 writer；`ADMISSION_SCHEMA_VERSION=2`；pre-DDL `sqlite_version()>=3.25` 硬闸；单条 `ALTER TABLE turn_requests RENAME COLUMN parent_id TO agent_id`；完整 singleton `policy_state`（含 `policy_fingerprint TEXT NOT NULL`）、`queued_owner_instances`、owner/suspect 列；`turn_requests.foreignKeys=[]`、queued-owner 值引用非 FK；sessions 不动；v1→v2 只前向、v1 Connector 拒 v2 DB、回滚永不恢复旧命名、**无双命名终态**；API `parentId→agentId` 同步 rename；F7/C2/G2 |
| SELECTED_PRIMARY_SKILL | `tdd` |
| SELECTED_SUPPORTING_SKILLS | `implement` |
| SKILL_SELECTION_REASON | Controller 澄清（handoff §2.4-3） |
| SKILL_SOURCE_IDENTITY | 同 §6.1 |
| SKILL_REQUIRED_STEPS | 完整读取 SKILL.md；RED 先于 GREEN（live v1 DB 无 v2 shape、API 仍 `parentId`）；minimal GREEN 按 S2-ARCH-001 §11.2 顺序：硬闸 → BEGIN/foreign_keys=ON → 单 RENAME → ADD owner 列 → 部分索引 → ADD suspect 列 → CREATE `queued_owner_instances` 与完整 `policy_state`（显式 `policy_fingerprint TEXT NOT NULL`）→ 台账 v2 → COMMIT → `assertAdmissionSchemaIntegrity`（v2 白名单）；API rename 同步；任一 DDL/guard 失败抛 typed `AdmissionMigrationError`、v1 原样 |
| SKILL_EXPECTED_OUTPUT | RED receipt → minimal GREEN → GREEN receipts（v2 shape + 反向验证 v1 读 v2 拒绝） |
| SKILL_FORBIDDEN_SHORTCUTS | 无 rebuild fallback、无迁移框架、无 downgrade、无 dual-name 终态；`parent_id`/`parentId` 永非 alias；sessions 布局零改动；不预写占位 commit hash |
| SKILL_COMPLETION_CRITERIA | v2 shape 断言全绿（`agent_id` 无 `parent_id`、完整 `policy_state.policy_fingerprint` singleton、`queued_owner_instances`、suspect 列、`MIGRATIONS=[v1,v2]`、`ADMISSION_SCHEMA_VERSION=2`、sessions 布局 diff 空）；v1 Connector 打开 v2 DB 拒绝；API rename 全绿 |
| METHOD_CONFORMANCE_EVIDENCE | §6.0 |
| DEPENDENCIES | S3-T17 |
| EXACT_GIT_BASELINE | §6.0 |
| AUTHORITY_PATHS_AND_HASHES | §6.0 base + S2-ARCH-001（§11/§17-9）/S2-DOMAIN-001（§10.1 F7）/S2-TEST-001（G2/M10） |
| ALLOWED_WRITE_SET | `Admission Controller/schema.ts`、`Admission Controller/controller.ts`、`ACP Connector/admission/turn-coordinator.ts`、`ACP Connector/acp/agent.ts`、`tests/admission-schema-v2.test.ts` + receipts |
| FORBIDDEN_SURFACES | §6.0 |
| RESOURCE_SET | §2.4（child helper + 真实 SQLite 版本检测） |
| EXACT_ACCEPTANCE | RED-1：v2 shape + `EnqueueRequest.agentId` 断言在 live v1 DB 上红；GREEN 后 v2 断言全绿、sessions layout diff 空、v1 读 v2 拒绝（反向验证，GREEN 后执行，receipt `green-1.txt`） |
| TYPED_BLOCKERS | §6.0 通用集 + `AdmissionMigrationError`/`SchemaIntegrityError`（typed） |
| RED_RECEIPT_CONTRACT | 命令 `npm test -- tests/admission-schema-v2.test.ts`；receipt `red-1.txt` |
| GREEN_EVIDENCE_CONTRACT | 同命令通过；receipt `green-1.txt`；focused/affected/broad |
| REVIEW_ASSIGNMENT_CONSTRAINT | §6.0；impact target `AdmissionController`（HIGH,12）、`assertAdmissionSchemaIntegrity`、`EnqueueRequest`/`RequestRow`/`admit`（MEDIUM）→ 上报 + broad |
| INTEGRATION_TARGET | 验收第 2 阶段；accepted refs → 双审 → Single Integrator；migration reservation 保留至集成完成 |

### 6.19 S3-T19 — native Pipe/EOF/signal/descendant 回归

| 字段 | 值 |
| --- | --- |
| TASK_ID | `S3-T19` |
| STAGE | `3` |
| TASK_TYPE | green regression / test-evidence |
| BUSINESS_OBLIGATION | S-36 native Pipe+EOF、SIGTERM/SIGKILL、descendant cleanup；F3/C5/G8 |
| SELECTED_PRIMARY_SKILL | `tdd` |
| SELECTED_SUPPORTING_SKILLS | `implement` |
| SKILL_SELECTION_REASON | Controller 澄清（handoff §2.4-3） |
| SKILL_SOURCE_IDENTITY | 同 §6.1 |
| SKILL_REQUIRED_STEPS | 完整读取 SKILL.md；seam = `AgyCliSession.prompt` + fake-agy + 注入 readers；green-only |
| SKILL_EXPECTED_OUTPUT | 新回归文件 + 三条 green receipts |
| SKILL_FORBIDDEN_SHORTCUTS | 不新增输出路径；不用真实 Provider |
| SKILL_COMPLETION_CRITERIA | Pipe+EOF 正常终态非 hang；SIGTERM → typed error + seat 释放；SIGKILL → 无重复 dispatch（recovery_required 而非重试）；descendant 残留可识别（pgrp/session） |
| METHOD_CONFORMANCE_EVIDENCE | §6.0 |
| DEPENDENCIES | S3-T12、S3-T13、S3-T18 |
| EXACT_GIT_BASELINE | §6.0 |
| AUTHORITY_PATHS_AND_HASHES | §6.0 base + S2-ARCH-001（§10）/S2-TEST-001（M11） |
| ALLOWED_WRITE_SET | `tests/admission-native-process.test.ts` + receipts |
| FORBIDDEN_SURFACES | §6.0 |
| RESOURCE_SET | §2.4（fake agy + native `/proc`） |
| EXACT_ACCEPTANCE | green-1/2/3 三断言全绿 |
| TYPED_BLOCKERS | §6.0 通用集 |
| RED_RECEIPT_CONTRACT | 不适用（无 RED） |
| GREEN_EVIDENCE_CONTRACT | `npm test -- tests/admission-native-process.test.ts`；receipt `green-1/2/3.txt` |
| REVIEW_ASSIGNMENT_CONSTRAINT | §6.0；impact target `AgyCliSession`（查询后升级）、`AgyPromptFreeDispatchBoundary`（LOW,28） |
| INTEGRATION_TARGET | 验收第 3/4 阶段；accepted refs → 双审 → 集成 |

### 6.20 S3-T20 — secret scan / validation（G10）

| 字段 | 值 |
| --- | --- |
| TASK_ID | `S3-T20` |
| STAGE | `3` |
| TASK_TYPE | red-green implementation（tooling/validation，不改源码逻辑） |
| BUSINESS_OBLIGATION | S-03/S-21/S-34/S-40/S-44/S-46/S-47/S-49 架构边界与 `npm run validate` 全链、secret scan 纳入；G10 |
| SELECTED_PRIMARY_SKILL | `tdd` |
| SELECTED_SUPPORTING_SKILLS | `implement` |
| SKILL_SELECTION_REASON | Controller 澄清（handoff §2.4-3，source-changing 工具任务） |
| SKILL_SOURCE_IDENTITY | 同 §6.1 |
| SKILL_REQUIRED_STEPS | 完整读取 SKILL.md；RED 先于 GREEN（live HEAD 无 `validate:secrets` script）；minimal GREEN：`scripts/verify-no-secrets.mjs` + `validate:secrets` + 纳入 `npm run validate`；fixture 密钥可检出（内置 fixture，不产生真实密钥） |
| SKILL_EXPECTED_OUTPUT | RED receipt → minimal GREEN → GREEN receipt；`npm run validate` 全绿含 secret scan |
| SKILL_FORBIDDEN_SHORTCUTS | 不改源码逻辑；不写真实密钥 fixture；不把 health-check 当验收 |
| SKILL_COMPLETION_CRITERIA | `npm run validate:secrets` 存在且检出 fixture 密钥；`npm run validate` 全绿（test + architecture + secrets） |
| METHOD_CONFORMANCE_EVIDENCE | §6.0 |
| DEPENDENCIES | S3-T01、S3-T02、S3-T03、S3-T04、S3-T05、S3-T06、S3-T07、S3-T09、S3-T10、S3-T11、S3-T12、S3-T13、S3-T14、S3-T15、S3-T16、S3-T17、S3-T18、S3-T19（全部内部 T01..T19，唯一排除 external typed-stop T08） |
| EXACT_GIT_BASELINE | §6.0 |
| AUTHORITY_PATHS_AND_HASHES | §6.0 base + S2-ARCH-001（§13 F18）/S2-TEST-001（G10/M12） |
| ALLOWED_WRITE_SET | `package.json`、`scripts/verify-no-secrets.mjs`、`tests/secret-scan.test.ts` + receipts |
| FORBIDDEN_SURFACES | §6.0 |
| RESOURCE_SET | §2.4 |
| EXACT_ACCEPTANCE | RED-1：`npm run validate:secrets` 报 `Missing script` → 「存在可用 secret scan 且检出 fixture 密钥」红；GREEN 后 validate 全绿 |
| TYPED_BLOCKERS | §6.0 通用集 |
| RED_RECEIPT_CONTRACT | 命令 `npm run validate:secrets`；receipt `red-1.txt` |
| GREEN_EVIDENCE_CONTRACT | `npm run validate`；receipt `green-1.txt` |
| REVIEW_ASSIGNMENT_CONSTRAINT | §6.0；无 symbol impact（script）；Spec Review 核对 G10 范围 |
| INTEGRATION_TARGET | 验收第 5 阶段；accepted refs → 双审 → Single Integrator |

### 6.21 S3-T21 — 双语文档/旧 authority 收口（G11）

| 字段 | 值 |
| --- | --- |
| TASK_ID | `S3-T21` |
| STAGE | `3` |
| TASK_TYPE | bilingual documentation closeout（不改源码行为） |
| BUSINESS_OBLIGATION | S-41（F8 处置）：README/README.zh-CN 当前链接旧 design，CHANGELOG 当前保留 stale Admission/schema assertions；三面须与 Scheme 一致并引用 Scheme + Stage 2 artifacts；`docs/design/v2.0.0.0-admission-controller.md` 降级为 historical design input 并逐条款标注 disposition；不产生第二份 authority；G11 |
| SELECTED_PRIMARY_SKILL | `writing-for-agents` |
| SELECTED_SUPPORTING_SKILLS | （无 supporting skill；Controller 澄清 handoff §2.4-3 固定） |
| SKILL_SELECTION_REASON | Controller 澄清（handoff §2.4-3）唯一绑定；文档为 Agent/人消费的可执行材料，writing-for-agents 的 context pointers/information hierarchy/completion criteria 规则适用；其 docs contract 测试是 acceptance input，不是第二个 primary |
| SKILL_SOURCE_IDENTITY | `mattpocock/skills@8b78b531ab965735c5dc74f6f7a219e1e37326df`；`/home/tiezbro/.agents/skills/writing-for-agents/SKILL.md`（启动时核验） |
| SKILL_REQUIRED_STEPS | 完整读取 SKILL.md；RED 先于 GREEN（live README/README.zh-CN 链接旧 design；CHANGELOG 含 stale Admission/schema assertions；旧 design 自封「已确认」）；minimal GREEN：三面文档更新（引用 Scheme + Stage 2 artifacts，CHANGELOG 与 v2 migration/policy/recovery/terminal 合同一致）+ 旧 design 头部降级 + 逐条款 disposition 标注；docs contract test 通过 |
| SKILL_EXPECTED_OUTPUT | RED receipt → minimal GREEN → GREEN receipt |
| SKILL_FORBIDDEN_SHORTCUTS | 不写第二份 authority；不改源码/测试行为；不把 disposition 标注写为「全部保留」 |
| SKILL_COMPLETION_CRITERIA | README/README.zh-CN 不再链接旧 authority 且改指 Scheme + Stage 2 artifacts；CHANGELOG 不再包含 stale Admission/schema assertions，并与最终 v2 合同一致；旧 design 无「最终方案/已确认」措辞；docs contract 测试绿 |
| METHOD_CONFORMANCE_EVIDENCE | §6.0 |
| DEPENDENCIES | S3-T01、S3-T02、S3-T03、S3-T04、S3-T05、S3-T06、S3-T07、S3-T09、S3-T10、S3-T11、S3-T12、S3-T13、S3-T14、S3-T15、S3-T16、S3-T17、S3-T18、S3-T19（全部内部 T01..T19，唯一排除 external typed-stop T08） |
| EXACT_GIT_BASELINE | §6.0 |
| AUTHORITY_PATHS_AND_HASHES | §6.0 base + S2-ARCH-001（§16 F8）/S2-TEST-001（G11/M12） |
| ALLOWED_WRITE_SET | `README.md`、`README.zh-CN.md`、`CHANGELOG.md`、`docs/design/v2.0.0.0-admission-controller.md`、`tests/closeout-docs-contract.test.ts` + receipts |
| FORBIDDEN_SURFACES | §6.0 |
| RESOURCE_SET | §2.4 |
| EXACT_ACCEPTANCE | RED-1：README/README.zh-CN 仍链接旧 design；CHANGELOG 保留 stale Admission/schema assertions；旧 design 自封已确认 authority，三组 live 事实使文档合同红；GREEN 后三组断言全绿且 `npm run validate` 保持绿 |
| TYPED_BLOCKERS | §6.0 通用集 |
| RED_RECEIPT_CONTRACT | 命令 `npm test -- tests/closeout-docs-contract.test.ts`；receipt `red-1.txt`（行为/文档合同失败，非 missing test file） |
| GREEN_EVIDENCE_CONTRACT | 同命令通过；receipt `green-1.txt` |
| REVIEW_ASSIGNMENT_CONSTRAINT | §6.0；文档无 symbol impact；Spec Review 核对无第二 authority |
| INTEGRATION_TARGET | 验收第 5 阶段；accepted refs → 双审 → Single Integrator（docs phase） |

### 6.22 S3-REV-SPEC — Spec Review

| 字段 | 值 |
| --- | --- |
| TASK_ID | `S3-REV-SPEC` |
| STAGE | `3` |
| TASK_TYPE | Spec Review（独立身份，非实现 Worker） |
| BUSINESS_OBLIGATION | 逐项核对共同 Scheme coverage、边界、合同、task acceptance、forbidden surfaces、§2.2 sole-frontier DAG 与所有 brief dependencies；输出七字段 verdict |
| SELECTED_PRIMARY_SKILL | `code-review` |
| SELECTED_SUPPORTING_SKILLS | `to-spec` |
| SKILL_SELECTION_REASON | Controller Prompt 已 pin（Spec Review = code-review + to-spec） |
| SKILL_SOURCE_IDENTITY | `mattpocock/skills@8b78b531ab965735c5dc74f6f7a219e1e37326df`；`/home/tiezbro/.agents/skills/code-review/SKILL.md`、`/home/tiezbro/.agents/skills/to-spec/SKILL.md`（启动时核验） |
| SKILL_REQUIRED_STEPS | 完整读取 SKILL.md；以 Scheme/handoff/七 sibling 为基准逐 task 核对；确认 S2-SPEC-001 §10.1 与本 §2.2 相同、T20/T21 前驱集合完整且只排除 T08；核对 25 字段完整性、schema/terminal sole ownership 与 503 三元组措辞 |
| SKILL_EXPECTED_OUTPUT | verdict receipt（`SPEC_CONFORMANCE`/`QUALITY_CONFORMANCE`/`METHOD_CONFORMANCE`/`PARALLELISM_CONFORMANCE`/`FINDINGS`/`AFFECTED_SCOPE`/`VERDICT`） |
| SKILL_FORBIDDEN_SHORTCUTS | 不修代码/不写实现；不把 chat 当证据；`revisions-required`/`failed` → 返回原 Worker 或 bounded repair Worker 后重新双审 |
| SKILL_COMPLETION_CRITERIA | 每个 Scheme 义务唯一 disposition 可追溯；无 blocking ambiguity=0 断言被伪造；VERDICT 明确 |
| METHOD_CONFORMANCE_EVIDENCE | §6.0 |
| DEPENDENCIES | T01..T07、T09..T21 全部完成 + T08 typed-blocked receipt（T08 不进入 READY/GREEN） |
| EXACT_GIT_BASELINE | §6.0 |
| AUTHORITY_PATHS_AND_HASHES | §6.0 base + 七 sibling（path+identity+role） |
| ALLOWED_WRITE_SET | `docs/design/receipts/S3-REV-SPEC/`（verdict receipt）only |
| FORBIDDEN_SURFACES | §6.0（review 只读） |
| RESOURCE_SET | §2.4（只读） |
| EXACT_ACCEPTANCE | VERDICT ∈ {approved, revisions-required, failed}；FINDINGS 逐条绑定 Scheme 条款/task ID；approved 才进入 Quality Review/集成 |
| TYPED_BLOCKERS | §6.0 通用集 |
| RED_RECEIPT_CONTRACT | 不适用（review 无 RED） |
| GREEN_EVIDENCE_CONTRACT | 不适用；验收证据 = verdict receipt |
| REVIEW_ASSIGNMENT_CONSTRAINT | Reviewer ≠ 任何实现 Worker ≠ Integrator；不审查自身输出（reviewer 未写实现，天然满足） |
| INTEGRATION_TARGET | approved verdict → S3-REV-QUAL 并行完成 → S3-INT-* |

### 6.23 S3-REV-QUAL — Quality Review

| 字段 | 值 |
| --- | --- |
| TASK_ID | `S3-REV-QUAL` |
| STAGE | `3` |
| TASK_TYPE | Quality Review（独立身份，非实现 Worker） |
| BUSINESS_OBLIGATION | 核对可执行性、测试真实性（RED 真实行为失败、无 mutation-as-RED）、依赖/写集/资源冲突、角色分离、最大安全并行可行性、剩余歧义；PARALLELISM_CONFORMANCE 检查 ready task 是否被无理由串行 |
| SELECTED_PRIMARY_SKILL | `code-review` |
| SELECTED_SUPPORTING_SKILLS | `codebase-design` |
| SKILL_SELECTION_REASON | Controller Prompt 已 pin（Quality Review = code-review + codebase-design） |
| SKILL_SOURCE_IDENTITY | `mattpocock/skills@8b78b531ab965735c5dc74f6f7a219e1e37326df`；`/home/tiezbro/.agents/skills/code-review/SKILL.md`、`/home/tiezbro/.agents/skills/codebase-design/SKILL.md`（启动时核验） |
| SKILL_REQUIRED_STEPS | 完整读取 SKILL.md；逐 task 核对 RED/GREEN 合同可执行、写集/资源集无冲突、DAG 无环、无 `READY_FRONTIER` 预填、无「重启恢复」验收路径、无 speculative 双终态声称 |
| SKILL_EXPECTED_OUTPUT | verdict receipt（同 §6.22 七字段格式） |
| SKILL_FORBIDDEN_SHORTCUTS | 不修代码；不按 Agent 数量判定并行性（只查真实串行理由）；不伪造 PARALLELISM_CONFORMANCE |
| SKILL_COMPLETION_CRITERIA | 每 task 可在一个 fresh context 执行；blocking edges 与冲突 maps 无环且可计算 frontier；internal blocking ambiguity=0 |
| METHOD_CONFORMANCE_EVIDENCE | §6.0 |
| DEPENDENCIES | T01..T07、T09..T21 全部完成 + T08 typed-blocked receipt；与 S3-REV-SPEC 独立并行，无 reviewer 间前驱边 |
| EXACT_GIT_BASELINE | §6.0 |
| AUTHORITY_PATHS_AND_HASHES | §6.0 base + 七 sibling |
| ALLOWED_WRITE_SET | `docs/design/receipts/S3-REV-QUAL/`（verdict receipt）only |
| FORBIDDEN_SURFACES | §6.0（review 只读） |
| RESOURCE_SET | §2.4（只读） |
| EXACT_ACCEPTANCE | VERDICT ∈ {approved, revisions-required, failed}；FINDINGS 绑定 task ID；approved 才进入集成 |
| TYPED_BLOCKERS | §6.0 通用集 |
| RED_RECEIPT_CONTRACT | 不适用 |
| GREEN_EVIDENCE_CONTRACT | 不适用；验收证据 = verdict receipt |
| REVIEW_ASSIGNMENT_CONSTRAINT | Reviewer ≠ 任何实现 Worker ≠ Integrator |
| INTEGRATION_TARGET | 双审均 approved → S3-INT-PHASE-CODE |

### 6.24 S3-INT-PHASE-CODE — Single Integration（代码 phase）

| 字段 | 值 |
| --- | --- |
| TASK_ID | `S3-INT-PHASE-CODE` |
| STAGE | `3` |
| TASK_TYPE | ordinary code Single Integration phase（唯一 Single Integrator 身份，phase 1/2） |
| BUSINESS_OBLIGATION | 只把 dual-review accepted 的 exact code refs 选择性暂存并验证；不补写、不重构、不扩大内容；为唯一最终 commit 准备 code 侧 |
| SELECTED_PRIMARY_SKILL | `implement` |
| SELECTED_SUPPORTING_SKILLS | `code-review` |
| SKILL_SELECTION_REASON | Controller Prompt 已 pin（ordinary code Single Integration = implement + code-review）；implement 提供 commit/staging 纪律，code-review 提供 staging 前自检 |
| SKILL_SOURCE_IDENTITY | `mattpocock/skills@8b78b531ab965735c5dc74f6f7a219e1e37326df`；`/home/tiezbro/.agents/skills/implement/SKILL.md`、`/home/tiezbro/.agents/skills/code-review/SKILL.md`（启动时核验） |
| SKILL_REQUIRED_STEPS | 完整读取 SKILL.md；核对双审 verdict receipts；`detect_changes` 验证只影响预期 symbol/flow；选择性暂存 accepted code 文件；保护用户与 unrelated changes；**不 commit**（最终 commit 在 S3-INT-FINAL-COMMIT） |
| SKILL_EXPECTED_OUTPUT | 暂存清单 + `detect_changes` receipt + phase receipt |
| SKILL_FORBIDDEN_SHORTCUTS | 不补写/重构/扩大内容；不 commit；不 push；不触碰 docs refs（属 phase 2）；不 stage 未 accepted 文件 |
| SKILL_COMPLETION_CRITERIA | 暂存集 = 双审 accepted code refs 精确集合；`detect_changes` 无意外 scope |
| METHOD_CONFORMANCE_EVIDENCE | §6.0 |
| DEPENDENCIES | S3-REV-SPEC accepted、S3-REV-QUAL accepted |
| EXACT_GIT_BASELINE | §6.0 |
| AUTHORITY_PATHS_AND_HASHES | §6.0 base + 双审 verdict receipts（path） |
| ALLOWED_WRITE_SET | git index（仅选择性暂存 accepted code 文件）+ `docs/design/receipts/S3-INT-CODE/` |
| FORBIDDEN_SURFACES | §6.0（除上述 index 暂存外） |
| RESOURCE_SET | §2.4 + `detect_changes` |
| EXACT_ACCEPTANCE | phase receipt 列明暂存文件全集；与双审 accepted refs 一一对应 |
| TYPED_BLOCKERS | §6.0 通用集 + `WRITE_SET_VIOLATION`（非 accepted 文件暂存） |
| RED_RECEIPT_CONTRACT | 不适用 |
| GREEN_EVIDENCE_CONTRACT | 不适用；验收证据 = detect_changes receipt + 暂存清单 |
| REVIEW_ASSIGNMENT_CONSTRAINT | Integrator ≠ 任何 Worker/Reviewer；同一 identity 执行 code + docs 两 phase（handoff §2.4-3） |
| INTEGRATION_TARGET | → S3-INT-PHASE-DOCS → S3-INT-FINAL-COMMIT（唯一 commit） |

### 6.25 S3-INT-PHASE-DOCS — Single Integration（文档 phase）

| 字段 | 值 |
| --- | --- |
| TASK_ID | `S3-INT-PHASE-DOCS` |
| STAGE | `3` |
| TASK_TYPE | ordinary documentation Single Integration phase（唯一 Single Integrator 身份，phase 2/2） |
| BUSINESS_OBLIGATION | 只把 dual-review accepted 的 exact docs refs（README/zh/CHANGELOG/旧 design）选择性暂存并验证；不补写、不重构；为唯一最终 commit 准备 docs 侧 |
| SELECTED_PRIMARY_SKILL | `writing-for-agents` |
| SELECTED_SUPPORTING_SKILLS | `code-review` |
| SKILL_SELECTION_REASON | Controller Prompt 已 pin（ordinary documentation Single Integration = writing-for-agents + code-review） |
| SKILL_SOURCE_IDENTITY | `mattpocock/skills@8b78b531ab965735c5dc74f6f7a219e1e37326df`；`/home/tiezbro/.agents/skills/writing-for-agents/SKILL.md`、`/home/tiezbro/.agents/skills/code-review/SKILL.md`（启动时核验） |
| SKILL_REQUIRED_STEPS | 完整读取 SKILL.md；核对双审 verdict receipts；`detect_changes` 验证 docs scope；选择性暂存 accepted docs 文件；保护用户与 unrelated changes；**不 commit**（最终 commit 在 S3-INT-FINAL-COMMIT） |
| SKILL_EXPECTED_OUTPUT | 暂存清单 + phase receipt |
| SKILL_FORBIDDEN_SHORTCUTS | 不补写文档内容；不 commit；不 push；不 stage 未 accepted 文件 |
| SKILL_COMPLETION_CRITERIA | 暂存集 = 双审 accepted docs refs 精确集合 |
| METHOD_CONFORMANCE_EVIDENCE | §6.0 |
| DEPENDENCIES | S3-INT-PHASE-CODE |
| EXACT_GIT_BASELINE | §6.0 |
| AUTHORITY_PATHS_AND_HASHES | §6.0 base + 双审 verdict receipts |
| ALLOWED_WRITE_SET | git index（仅选择性暂存 accepted docs 文件）+ `docs/design/receipts/S3-INT-DOCS/` |
| FORBIDDEN_SURFACES | §6.0（除上述 index 暂存外） |
| RESOURCE_SET | §2.4 + `detect_changes` |
| EXACT_ACCEPTANCE | phase receipt 列明暂存文件全集；与双审 accepted refs 一一对应 |
| TYPED_BLOCKERS | §6.0 通用集 + `WRITE_SET_VIOLATION` |
| RED_RECEIPT_CONTRACT | 不适用 |
| GREEN_EVIDENCE_CONTRACT | 不适用；验收证据 = 暂存清单 |
| REVIEW_ASSIGNMENT_CONSTRAINT | 同一 Single Integrator 身份执行（phase 1 后 phase 2） |
| INTEGRATION_TARGET | → S3-INT-FINAL-COMMIT（唯一 commit） |

### 6.26 S3-INT-FINAL-COMMIT — 唯一选择性集成 commit

| 字段 | 值 |
| --- | --- |
| TASK_ID | `S3-INT-FINAL-COMMIT` |
| STAGE | `3` |
| TASK_TYPE | ordinary code Single Integration（最终选择性集成 commit；**一个** commit，非两个） |
| BUSINESS_OBLIGATION | 把 code + docs 两 phase 的 dual-review accepted exact refs 合入**一个**本地选择性集成 commit；`detect_changes` 通过；只选择性暂存 accepted 文件；保护用户与 unrelated changes；生成 post-commit 外部完整性 receipt |
| SELECTED_PRIMARY_SKILL | `implement` |
| SELECTED_SUPPORTING_SKILLS | `code-review` |
| SKILL_SELECTION_REASON | commit/staging 机制属 implementation/integration 纪律（implement：「Commit your work to the current branch」），code-review 支撑 staging 前核对；handoff §2.4-3 固定 |
| SKILL_SOURCE_IDENTITY | `mattpocock/skills@8b78b531ab965735c5dc74f6f7a219e1e37326df`；`/home/tiezbro/.agents/skills/implement/SKILL.md`、`/home/tiezbro/.agents/skills/code-review/SKILL.md`（启动时核验） |
| SKILL_REQUIRED_STEPS | 完整读取 SKILL.md；两 phase 暂存清单合并核对；commit 前 `detect_changes`（只影响预期 symbol/flow）；选择性暂存 → `git commit`（本地 main）；回报 exact commit、paths、Git blobs、SHA-256；生成外部完整性 receipt；**不 push** |
| SKILL_EXPECTED_OUTPUT | 唯一本地 commit + 外部完整性 receipt（accepted commit/blob/artifact SHA）+ commit receipt |
| SKILL_FORBIDDEN_SHORTCUTS | 不 push/tag/deploy/release；不 stage 未 accepted 文件；不补写/重构；不得把「本地 commit」伪装成「已安装/已上线/已发布」 |
| SKILL_COMPLETION_CRITERIA | 一个 commit 包含全部 accepted refs；`detect_changes` 无意外 scope；receipt 记录 commit/paths/blobs/SHA |
| METHOD_CONFORMANCE_EVIDENCE | §6.0 |
| DEPENDENCIES | S3-INT-PHASE-CODE、S3-INT-PHASE-DOCS |
| EXACT_GIT_BASELINE | §6.0（Stage 3 集成基线以 Stage 3 现场 readback 为准） |
| AUTHORITY_PATHS_AND_HASHES | §6.0 base + 双审 verdict receipts + 两 phase receipts |
| ALLOWED_WRITE_SET | git index/refs（仅本任务选择性暂存与**一个**本地 commit）+ `docs/design/receipts/S3-INT/` |
| FORBIDDEN_SURFACES | §6.0（push/tag/deploy/release/install/生产 6767/真实 Provider 除外；index 权限仅限本任务） |
| RESOURCE_SET | §2.4 + `detect_changes` + git |
| EXACT_ACCEPTANCE | 唯一 commit；exact commit hash + paths + Git blobs + SHA-256 进入 receipt；`detect_changes` 通过；无 push |
| TYPED_BLOCKERS | §6.0 通用集 + `WRITE_SET_VIOLATION` + `MULTIPLE_PHYSICAL_DISPOSITIONS`（若出现两个 commit 意图） |
| RED_RECEIPT_CONTRACT | 不适用 |
| GREEN_EVIDENCE_CONTRACT | 不适用；验收证据 = commit receipt + detect_changes receipt + 外部完整性 receipt |
| REVIEW_ASSIGNMENT_CONSTRAINT | 同一 Single Integrator 身份；不与 Worker/Reviewer 重合 |
| INTEGRATION_TARGET | Stage 3 Development Closeout 输入；post-commit 外部完整性 receipt 是唯一 durable integrity binding |

### 6.27 S3-INT-CONFLICT — integration conflict（条件 brief）

| 字段 | 值 |
| --- | --- |
| TASK_ID | `S3-INT-CONFLICT` |
| STAGE | `3` |
| TASK_TYPE | integration conflict（**条件适用**：仅真实 merge/rebase/content conflict 存在时；否则 inapplicable 并在方法证据记录） |
| BUSINESS_OBLIGATION | 真实冲突时做有界 resolution：只合并 dual-review accepted refs 的冲突面，不扩大内容；无冲突时记录 `resolving-merge-conflicts` 冲突步骤 inapplicable，按项目 exact-ref 验证/选择性集成步骤执行 |
| SELECTED_PRIMARY_SKILL | `resolving-merge-conflicts` |
| SELECTED_SUPPORTING_SKILLS | `code-review` |
| SKILL_SELECTION_REASON | Controller Prompt 已 pin（integration conflict = resolving-merge-conflicts + code-review）；仅真实冲突时加载 |
| SKILL_SOURCE_IDENTITY | `mattpocock/skills@8b78b531ab965735c5dc74f6f7a219e1e37326df`；`/home/tiezbro/.agents/skills/resolving-merge-conflicts/SKILL.md`（启动时核验） |
| SKILL_REQUIRED_STEPS | 仅当 `git status`/merge 显示真实冲突时执行 skill 冲突流程；resolution 后重新验证该文件行为；无冲突 → 记录 inapplicable |
| SKILL_EXPECTED_OUTPUT | conflict receipt（冲突文件、resolution、重新验证）或 inapplicable 记录 |
| SKILL_FORBIDDEN_SHORTCUTS | 不得为形式服从 skill 而扩大权限/内容；不得用 conflict brief 绕过双审 |
| SKILL_COMPLETION_CRITERIA | 冲突文件 resolution 后双审 accepted refs 语义不变 |
| METHOD_CONFORMANCE_EVIDENCE | §6.0 |
| DEPENDENCIES | S3-INT-FINAL-COMMIT 准备期间发现真实冲突时 |
| EXACT_GIT_BASELINE | §6.0 |
| AUTHORITY_PATHS_AND_HASHES | §6.0 base |
| ALLOWED_WRITE_SET | 冲突文件（有界 resolution）+ `docs/design/receipts/S3-INT/` |
| FORBIDDEN_SURFACES | §6.0 |
| RESOURCE_SET | §2.4 + git |
| EXACT_ACCEPTANCE | 无冲突 → inapplicable 记录；有冲突 → resolution 后重新验证通过 |
| TYPED_BLOCKERS | §6.0 通用集 |
| RED_RECEIPT_CONTRACT | 不适用 |
| GREEN_EVIDENCE_CONTRACT | 不适用；验收证据 = conflict receipt / inapplicable 记录 |
| REVIEW_ASSIGNMENT_CONSTRAINT | 同一 Single Integrator 身份 |
| INTEGRATION_TARGET | resolution 并入唯一最终 commit |

## 7. 最大安全并行调度

### 7.1 运行态集合（本 Prompt 不预填；由 Controller 持续维护）

```text
DEPENDENCY_DAG      = §2.2（静态、唯一权威）
WRITE_SET_MAP       = §2.3
RESOURCE_SET_MAP    = §2.4
READY_FRONTIER      = 计算值（所有 prerequisites accepted 的 ready tasks）
RUNNING_SET         = 已委派未完成的 tasks
REVIEW_SET          = 已完成、待 Spec/Quality 双审的 tasks
INTEGRATION_SET     = 双审 accepted、待 Single Integrator 集成的 tasks
BLOCKER_SET         = typed blockers 与依赖门的开放项
```

### 7.2 调度合同

1. 每个 scheduling event 都做 fresh readback（cwd/branch/HEAD/index/dirty ownership + 各 task receipt 状态）；
2. 从唯一 DAG（§2.2）计算所有 prerequisites accepted 的 ready tasks，排除 dependency、write/resource/semantic/schema/migration 与仍在 pending-review/pending-integration 的 reservation 冲突；
3. 将全部其余安全 ready tasks **立即并行委派**（不等待固定 wave；不固定 Agent 数量；Agent 数量不是验收指标）；
4. Worker 完成后**立即释放 Agent/CPU/test execution resource** 并立刻重算 frontier；write/semantic/schema/migration reservation 保留到 dual review、integration 或 exact ref 明确 abandoned；
5. 只有真实 dependency、写面/资源冲突、shared schema/public contract、migration ordering、测试前提变化、Paseo/runtime capacity 或 typed safety blocker 可以串行；
6. 存在无合法理由的关键路径串行时 → `revisions-required`（由 Quality Review 的 `PARALLELISM_CONFORMANCE` 判定）。

### 7.3 未启动 ready task 记录（每个未启动 ready task 必须记录）

```text
TASK_ID
READY_AT
NOT_LAUNCHED_REASON
CONFLICTING_TASK
CONFLICTING_BOUNDARY
NEXT_REEVALUATION_TRIGGER
```

### 7.4 Parallelism Review（独立评审必须输出）

```text
PARALLELISM_CONFORMANCE
READY_TASKS_OBSERVED
TASKS_LAUNCHED
TASKS_DEFERRED
VALID_DEFER_REASONS
UNJUSTIFIED_SERIALIZATION
BOUNDARY_RELEASE_LATENCY
FRONTIER_RECOMPUTE_EVENTS
```

## 8. 验收与 terminal

### 8.1 六阶段验收顺序（前一阶段全绿才进入下一阶段；每次先 focused → affected → broad）

```text
1. deterministic unit（regression）：T01/T04/T05/T07(负分类)/T11/T13/T15/T17(单进程)/T19
2. SQLite cross-process / fault / security：T02(G3)/T03(G4)/T06(G5)/T14(G6)/T17(contention)/T18(G2)
3. native helper / process evidence：T13/T19
4. fake agy full chain：T09(G1)/T10(G7)/T12(G8)/T16(G9)/T19
5. full validation / GitNexus：T20(G10)/T21(G11) + `npm run validate` 全绿 + `detect_changes` 只影响预期 scope + 各 task impact receipt 归档
6. isolated Paseo `6768` single canary（临时 `PASEO_HOME`、非生产端口）
```

- 将 Stage 2 handoff 的全部 RED/验收矩阵**原样**转成可执行 task acceptance，不得删减（§6 各 brief EXACT_ACCEPTANCE 即转换结果）。
- **T08 排除**：S3-T08 不进入任何阶段；typed blocked；T20/T21 前驱 = 全部内部 T01..T19，唯一排除 T08，明确包含 T07 与 T15。`unresolved blockers=none` 与 accepted verdicts 只能由双审 + 集成后的外部 receipt 证明。

### 8.2 ready-for-release 条件

只有以下全部成立才能形成 `ready-for-release` handoff，且该 handoff 只是 Development Closeout 完成声明，不等于已安装/已上线/已发布：

- 全部 Stage 3 nodes（T01..T21 含 T08 typed-blocked receipt + S3-REV-SPEC + S3-REV-QUAL）integrated；
- 六阶段验收全部通过（含 isolated 6768 canary）；
- Parallelism Review accepted；
- Critical=0、High=0（无未关闭的 HIGH/CRITICAL impact 或 blocker）。

### 8.3 事实层分离（不得互替）

完成时**分别报告**：source complete、tests、candidate（build 产物）、installation、real provider、production 与 release；Development Closeout 的 ACCEPT 不能冒充已安装、已上线或已发布。真实 Antigravity 单请求、exact candidate、安装、生产 6767、push、tag、deploy 和 release 均需**新的明确授权**，不属于本 Stage。

### 8.4 README/文档任务边界

更新 README、README.zh-CN、CHANGELOG 和设计文档（S3-T21）是**行为变更的 task**（按 §6.21 执行 RED/GREEN 与双审），不是 release 授权；文档更新本身不得被当作安装/发布证据。

## 9. 完成标准与使用说明

- **启动方式**：在 `cwd=/home/tiezbro/projects/paseo-agy-acp` 的新顶层 Paseo Controller 会话中粘贴本文件全文。**本 Prompt 仅在 Generator 流程完成后使用**：canonical target（`docs/design/v2.0.0.0-stage3-execution-prompt.md`）已由 Single Integrator 写入、packaging commit 已形成、post-commit 外部完整性 receipt 已生成；启动时 HEAD = packaging commit（唯一 parent = generation parent `78931bf`），按 §1.2 step 3 结构化准入核验。先完成 §0 Goal 与 §1 准入，再进入 §2-§8 执行。
- **本会话完成时返回**：全部 task/review/integration 的 exact receipts 路径；唯一集成 commit（commit hash + paths + Git blobs + SHA-256，由外部 receipt 绑定）；Spec/Quality/Method/Parallelism verdicts；六阶段验收证据；`ready-for-release` 状态或剩余 blockers；release boundary 与剩余风险。
- **本 Prompt 的验收**：任何 `revisions-required`/`failed` 都回到对应 Worker/Writer 修订并重新双审；GREEN 全部通过前不得宣称 Stage 3 完成；本 Prompt 的 packaging 由 Generator 流程完成，本 Prompt 正文不包含自身 digest 或 packaging commit OID。
