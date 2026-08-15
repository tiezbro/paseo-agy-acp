# paseo-agy-acp Stage 3 Prompt Generation — Documentation RED（S3-PROMPT-GEN-RED-001）

状态：Prompt Writer 已先于候选 Prompt 落盘本 RED；本文件证明「缺少由 accepted immutable Stage 2 handoff 生成的 exact Stage 3 执行 Prompt 时，哪些执行信息无法可靠恢复」；本文件不执行 Stage 3，不写 canonical target。

`TASK_ID`：`stage3-prompt-writer`
`STAGE`：Stage 3 Prompt Generation（**非 Stage 3 执行**）
`TASK_TYPE`：Documentation RED + Stage 3 执行 Prompt authoring
`SELECTED_PRIMARY_SKILL`：`writing-for-agents`；`SELECTED_SUPPORTING_SKILLS`：`to-spec`（Generator 固定映射）
`SKILL_SOURCE_IDENTITY`：`mattpocock/skills@8b78b531ab965735c5dc74f6f7a219e1e37326df`；`/home/tiezbro/.agents/skills/writing-for-agents/SKILL.md` sha256 `a842323e664e5af104eac5c97ad22fda929ebeb62d81c501161ac1f6f482db58`；`/home/tiezbro/.agents/skills/to-spec/SKILL.md` sha256 `5d26479544b08048d3a8f79d937b39bc613a617f026b3fd083bafc1e99a7b811`
`DEPENDENCIES`：Generator admission passed；SKILL_INVENTORY Gate accepted；inventory `docs/design/receipts/STAGE3-PROMPT-GEN/skill-inventory.md` sha256 `e68e057cfc5ea3a60ba099a34ae77d2b9700ced70d26775ae2dcfd76238aee81`；Stage 2 immutable commit `78931bff95ecbd9868f9cfa83a281cbbbf1a60d8`
`ALLOWED_WRITE_SET`：`docs/design/receipts/STAGE3-PROMPT-GEN/documentation-red.md`、`docs/design/receipts/STAGE3-PROMPT-GEN/stage3-prompt-candidate.md`（本文件 = 前者）

---

## 0. Findings-first 摘要

1. **身份**：CHILD（`ParentAgentId=93287419-016e-4473-b3c8-7a0b0b248c2d`）；实际 runtime = `hermes` / `custom:deepseek-v4-flash` / `thinking=max` / `mode=dont_ask` / pending permissions=`0`（`paseo inspect` live 核验，§1）。与 brief 要求一致；不加载 thin selector、不委派、不自动编排。
2. **Baseline**：`main @ 78931bff95ecbd9868f9cfa83a281cbbbf1a60d8`，worktree/index clean，唯一 untracked = inventory receipt（允许）。无 `WORKTREE_DRIFT_UNRESOLVED`。
3. **Authority hash 全部 live 匹配**：Generator `9e2e8334…edcdd`、Scheme `d3b712ee…8a98d`、handoff `c88be84f…afc48`（blob `89c8abe0d82c4915cbf6748db15a9ff86a80c501`）、AGENTS.md `9bbd1e7b…19d8d`、8 份 Stage 2 artifacts 的 blob 与 whole-file SHA-256 全部匹配（§2）。无 `SHARED_SCHEME_MISSING` / `SCHEME_HASH_MISMATCH` / `STAGE2_HANDOFF_MISSING` / `HANDOFF_HASH_MISMATCH`。
4. **RED 结论（10 维度）**：没有由 accepted handoff 生成的 exact Stage 3 执行 Prompt 时，以下执行信息**无法可靠恢复**：Scheme/hash 绑定关系与准入裁决、Git baseline/generation parent/允许 worktree 态、唯一静态 task graph（含 T08 排除）、write/resource 冲突与串行化、RED/GREEN receipt 合同与六阶段验收证据顺序、Agent+Skill 合同（实现 Worker 模型 pin、调研候选、逐 task Skill 绑定、25 字段 hard-field briefs）、五角色分离与任务边界、最大安全并行调度协议、双审→唯一集成→唯一 packaging commit 的 exact-ref 链、release/terminal 边界与 ready-for-release 条件。逐维度论证见 §3。
5. **唯一 canonical target 提议**：`docs/design/v2.0.0.0-stage3-execution-prompt.md`（§4）——仓库内不存在任何既有 Stage 3 Prompt 或同义 truth source（`git grep` 零命中），该文件位于 tracked planning/control hierarchy（`docs/design/`），遵循既有 `v2.0.0.0-stage2-*` 命名族，不制造重复 authority。
6. **候选 Prompt 覆盖清单**：§5 将 EXACT_ACCEPTANCE 逐项映射到候选正文；候选不包含自身 digest、不包含未来 packaging commit OID、不预填 `READY_FRONTIER`、无占位/未解析变量/预测路径。
7. **写集纪律**：本任务的**唯一持久 repo 写入** = 上述两个 receipt 路径；另有一次**瞬时的仓库外越界写**（`/tmp/verify_s3_prompt.py`）——已发生并已触发 `WRITE_SET_VIOLATION`，经 Controller correction 后 bounded cleanup（删除 + 存在性核验）并**已关闭、无残留**（详见 §7.1）；未写 canonical target、源码、测试、Stage 2 artifacts、MAACS、`~/.agents`、`~/.paseo`、issue tracker、git index/refs。**`Stage 3 not started`**。

---

## 1. Identity 与 runtime 核验（identity-first）

| 项 | 值 | 核验 |
| --- | --- | --- |
| `PASEO_AGENT_ID` | `c07b51f6-5cd7-43e9-ad8c-be084eb4293c` | `printenv` ✓ |
| Name | `S3 Execution Prompt Writer` | `paseo inspect --json` ✓ |
| `ParentAgentId` | `93287419-016e-4473-b3c8-7a0b0b248c2d` | **CHILD** ✓（不加载 thin selector、不自动编排、不委派） |
| Provider / Model | `hermes` / `custom:deepseek-v4-flash` | 与 Generator 候选 `hermes/custom:deepseek-v4-flash` + max 一致 ✓ |
| Thinking | `max` | ✓ |
| Mode | `dont_ask`（Paseo live official option：default/accept_edits/dont_ask 之一） | ✓ 未硬编码扩大 |
| `PendingPermissions` | `[]`（0） | ✓ |
| Status / Cwd | `running` / `/home/tiezbro/projects/paseo-agy-acp` | ✓ |
| 委派 | 本 Worker 是 leaf；`RESOURCE_SET` 委派不可用 | 未委派 ✓ |

## 2. Authority hash-first 核验（live）

| 项 | exact path | 绑定值 | live 实测 | 结果 |
| --- | --- | --- | --- | --- |
| Stage 3 Prompt Generator | `/home/tiezbro/projects/MAACS/docs/controller-prompts/PASEO_AGY_ACP_STAGE3_PROMPT_GENERATOR.md` | `9e2e8334289fe4be546303687daeb28903c58be72c19c4ad40738648686edcdd` | 同 | ✓ |
| confirmed 共同 Scheme | `/home/tiezbro/projects/MAACS/docs/maacs-paseo-agy-acp-confirmed-scheme.md` | `d3b712ee5dd01029c66b0372a482f248a6f1ecbcf81572eb74d7b4ba5d98a98d` | 同；状态 `confirmed` | ✓ |
| Stage 2 handoff | `docs/design/v2.0.0.0-stage2-handoff.md` | whole-file `c88be84fa4c86c4c63921aaccd08f5f9c765dc896f1c35592f6cb0ee16fafc48`；blob `89c8abe0d82c4915cbf6748db15a9ff86a80c501` | 同 | ✓ |
| AGENTS.md | `AGENTS.md` | `9bbd1e7b1bb7938cc3fd5922a1dcf9a036fa8639267d38789213f4fe9fc3198d` | 同 | ✓ |
| S2-SPIKE-503-001 | `docs/design/v2.0.0.0-stage2-503-feasibility.md` | blob `33ace156c84c769f55608ba33e95012462cc1718`；sha256 `c742645666b456bd5f42602a407446f70cd55321a0d2be2da044f514cb27de19` | 同 | ✓ |
| S2-RECON-ACP-001 | `docs/design/v2.0.0.0-stage2-acp-source-map.md` | blob `af5d58f021642276df6ca9fe9bcb33102ca1285c`；sha256 `f2ded52a47a73773efcbbf27b1d395ad6a9abba7e95b0bdd2516c3b0fe65f860` | 同 | ✓ |
| S2-RECON-ADM-001R | `docs/design/v2.0.0.0-stage2-admission-source-map.md` | blob `90b1c7c1fb8d7a465ba266bf2ff3dbc5dddaacc3`；sha256 `eee7e56c7ddaa09dc155cb92772298eb0b19710e88b336e16a3851546015fafb` | 同 | ✓ |
| S2-ARCH-001 | `docs/design/v2.0.0.0-stage2-architecture.md` | blob `2a0028cbb60a54aff1fa85afb5d9ca78251f6be9`；sha256 `7989c043603a11e4b5d88073d8352509d9ffcf7f8c0d736d2b48149aff03eb54` | 同 | ✓ |
| S2-DOMAIN-001 | `docs/design/v2.0.0.0-stage2-domain-model.md` | blob `37d96877c5b6d9f8506d209be4c3184532e4e0bf`；sha256 `3b6fabc9a862ed515ea5d39643fdeff6d83f15d0a079d3ea166377004183c12e` | 同 | ✓ |
| S2-SPEC-001 | `docs/design/v2.0.0.0-stage2-spec.md` | blob `b4f316b9b0cd58603258b916adce5810f4e8b5c2`；sha256 `3d90fe642f9322970c8e40e7a23b22228d62bfb3c52a5faac5a10960a9d03450` | 同 | ✓ |
| S2-TEST-001 | `docs/design/v2.0.0.0-stage2-test-contracts.md` | blob `f17d726b38420c08ba6725bd4bfb6f502676fae4`；sha256 `51e8e3bab735919b2d3643d1212fe289c6de281da4404bde033709a8cb22ed2b` | 同 | ✓ |
| SKILL_INVENTORY receipt | `docs/design/receipts/STAGE3-PROMPT-GEN/skill-inventory.md` | `e68e057cfc5ea3a60ba099a34ae77d2b9700ced70d26775ae2dcfd76238aee81` | 同 | ✓ |
| branch / HEAD | — | `main` / `78931bff95ecbd9868f9cfa83a281cbbbf1a60d8` | 同；`git status --porcelain` 仅 inventory untracked | ✓ |

typed blocker 状态：**`WRITE_SET_VIOLATION`——一次瞬时的仓库外越界写（`/tmp/verify_s3_prompt.py`）已发生并已触发**，经 Controller correction 后 bounded cleanup（删除 + 存在性核验）完成，**已关闭、无残留越界写**（§7.1）；其余 blocker（`SHARED_SCHEME_MISSING`/`SCHEME_HASH_MISMATCH`/`STAGE2_HANDOFF_MISSING`/`HANDOFF_HASH_MISMATCH`/`WORKTREE_DRIFT_UNRESOLVED`/`SKILL_UNAVAILABLE`/`SKILL_FALLBACK_UNAPPROVED`/`METHOD_AUTHORITY_CONFLICT`/`ROLE_SEPARATION_UNAVAILABLE`/`AGENT_MODE_UNAVAILABLE`/`BLOCKING_AMBIGUITY_REMAINS`）均不适用。

## 3. RED 论证：缺少 exact Stage 3 执行 Prompt 时无法可靠恢复的执行信息

论证规则：对每个维度给出「唯一可靠恢复来源」与「不可靠来源」；只要该维度的执行合同只存在于聊天/Agent 记忆/旧文档/Generator 的生成期上下文中，而未由 Prompt 从 immutable handoff 固定，则该维度视为**不可可靠恢复**。手写/凭记忆复述的 DAG、写集、briefs 与合同必然发生漂移，且漂移无法与 accepted 基线区分。

| # | 维度 | 不可可靠恢复的内容 | 唯一可靠来源（immutable） | 为什么 handoff/artifacts 单独存在不足以执行 |
| --- | --- | --- | --- | --- |
| R1 | Scheme / hash 绑定与准入裁决 | 哪些 hash 必须一致、不一致时返回哪个 typed blocker、准入的只读核验顺序与「漂移即停」规则；Stage 1 已 confirmed/Stage 2 已完成/本次只授权 Stage 3 的会话级事实 | Scheme（path+sha256）、handoff §1.2、本 Prompt §2 | handoff 是 Stage 2 交付物，不是会话启动合同；fresh 会话没有「必须逐项核验哪些值、用哪个 blocker 停下」的执行指令，chat 中的历史核验不是 durable evidence |
| R2 | Git baseline / generation parent / 允许 worktree 态 | 以哪个 commit 为 generation parent（accepted commit `78931bf`）、branch、允许的 dirty 集合（既有 receipts）、fresh readback 义务、漂移处置；packaging commit 是生成后 readback 固定的未来 OID，正文不得预写 | handoff §1.3/§12.0、accepted commit、本 Prompt §2 | fresh 会话无法从 handoff 推断「当前 HEAD 就是 accepted commit、packaging commit 尚未产生」这一时序事实；没有 Prompt 固定则可能把 2229353（handoff 内部参考 HEAD）误当 accepted commit |
| R3 | 静态 task graph（sole DAG）与 T08 排除 | 精确边集（`T01->{T02,T04,T05,T07,T09,T11,T13,T17}` 等 14 条边）、T20/T21 前驱 = 全部内部 T01..T19 唯一排除 T08、T08 为 external typed stop 且排除于 `READY_FRONTIER`、shared-writer 串行（`T18->T02->T03->T06->T14`、`T18->T09->T10`）、`schema.ts` 唯一 writer T18 | handoff §8（sole frontier authority）、S2-SPEC-001 §10.1、本 Prompt §2.2 | DAG 存在但「这是唯一调度权威、brief 的 DEPENDENCIES 必须镜像、不得生成第二张图」的裁决只在 handoff §8 内；执行会话需要把边集当作可计算 frontier 的输入并持续维护，缺少 Prompt 则调度行为不可复现 |
| R4 | write / resource 冲突与串行化 | 每 task 精确生产/测试写面 + receipt 写面（21+6 行 WRITE_SET_MAP）、共享写者冲突与 reservation 保留到双审/集成、RESOURCE_SET_MAP 的可用性约束（无真实 Provider、无 6767、无委派、无网络）、违反 → `WRITE_SET_VIOLATION` | handoff §9/§10、S2-ARCH-001 §8/§11、本 Prompt §2.3/§2.4 | 冲突矩阵以「哪个 task 可以写哪个文件、哪个是唯一 writer」的精确形式存在；凭记忆推断写集必然产生重叠或遗漏，且无法与 accepted 值区分 |
| R5 | RED/GREEN receipt 合同与验收证据顺序 | 每个实现 task 的精确 RED 命令、预期失败断言、`red-<n>.txt`/`green-<n>.txt`/`typed-blocked.txt` 格式（含 HEAD 附件、`<REDACTED>`）、禁止 mutation-as-RED/禁止 missing-file RED、六阶段验收顺序（deterministic → SQLite 跨进程/fault/security → native → fake agy → full validation/GitNexus → isolated 6768）、focused/affected/architecture/broad 定义 | handoff §12/§15、S2-TEST-001 §5-§7、本 Prompt §5/§6/§8 | RED 断言文本（例如「B 成功打开 policy1 库→红」）是逐 task 精确的；没有 Prompt 嵌入则 fresh Worker 不知道要在哪个 seam 上以哪个断言制造真实行为失败 |
| R6 | Agent + Skill 合同 | 实现 Worker 固定 `codex/gpt-5.5`+`xhigh` 且不得静默替换；三个调研候选；permission/mode 来自 live official options 且不扩大写集；逐 task primary+supporting Skill 绑定（T01..T21、REV-SPEC/REV-QUAL、INT-*）；Skill 来源 pin `mattpocock/skills@8b78b531…`；行动前完整读取并报告 method evidence | handoff §13/§14、Generator「Agent 和 Skill」、本 Prompt §4 | Skill 绑定是 27 个 brief 的硬字段；Fresh 会话若没有 Prompt 中的映射表，就无法知道 T01 该用 `tdd`+`implement`、T08 用 `diagnosing-bugs`+`triage`、T21 用 `writing-for-agents`（无 supporting）——这些是 accepted 裁决，不是可推导事实 |
| R7 | 五角色分离与任务边界 | Worker/Spec Reviewer/Quality Reviewer/Single Integrator/Controller 身份分离；Worker 不得审查/集成自身输出；同一 artifact 的 dual review；Integrator 不得补写/重构；条件 brief（S3-INT-CONFLICT）仅在真实冲突时适用 | handoff §12.22-§12.27/§14、Generator「Controller 与 Agent 合同」、本 Prompt §4/§6 | 「哪些身份必须分离、谁能暂存 git index、谁能 commit」是执行期约束；缺少 Prompt 则 fresh Controller 无法知道自己必须是 supervisor-only，也无法知道 delegation 的身份约束 |
| R8 | 最大安全并行调度协议 | `READY_FRONTIER`/`RUNNING_SET`/`REVIEW_SET`/`INTEGRATION_SET`/`BLOCKER_SET` 的维护与不预填；每个 scheduling event fresh readback 并排除 dependency/write/resource/semantic/schema/migration/pending-review/pending-integration 冲突；Worker 完成立即释放资源并重算 frontier；reservation 保留；未启动 ready task 的 5 字段记录；Parallelism Review 8 字段输出；无正当理由的关键路径串行 → `revisions-required`；不固定 wave/Agent 数量 | handoff §8/§11、Generator「最大安全并行」、S2-SPEC-001 §10、本 Prompt §7 | 调度协议是运行期行为合同，handoff 只提供静态输入；「立即并行委派全部安全 ready tasks」「立即重算」等规则只存在于 Generator（生成期文档），必须由执行 Prompt 固化，否则并行度取决于会话运气而非合同 |
| R9 | 双审 → 唯一集成 → 唯一 packaging commit 的 exact-ref 链 | 只有 dual-review accepted 的 exact refs 才能交给 Single Integrator；code/docs 两 phase 由同一 Integrator 执行但最终**一个**选择性集成 commit；commit 前 `detect_changes`；post-commit 外部完整性 receipt 绑定 commit/blob/SHA；不 push；打包 commit OID 只能由写入后 readback 固定，不得预写 | handoff §8/§12.24-§12.27、Generator「Single Integration 与 Documentation GREEN」、本 Prompt §7/§9 | 「何时可以暂存、谁能 commit、commit 后由谁生成 receipt」无法从 handoff 单独推导；尤其是「Prompt 正文不得包含自身未来 commit OID」的时序约束需要 Prompt 自述 |
| R10 | release / terminal 边界与 ready-for-release 条件 | 六阶段验收以 isolated 6768 结束；真实 Antigravity/install/生产 6767/push/tag/deploy/release 均需新授权；source/tests/candidate/install/provider/production/release 分别报告、不互替；ready-for-release 仅当全部 nodes integrated + 双审 accepted + Parallelism Review accepted + Critical=0 + High=0；README/README.zh-CN/CHANGELOG/design 更新是行为变更 task 而非 release 授权 | Scheme §7.2/§8、handoff §11/§15、Generator「验收与 terminal」、本 Prompt §8 | terminal 条件（特别是「Development Closeout 的 ACCEPT 不冒充已安装/已上线/已发布」）是执行会话必须持续遵守的边界；缺少 Prompt 则会话可能在本地 commit 后误报为可发布 |

**RED 判词**：上述 10 个维度中，R1-R10 的**可执行合同**（准入裁决、调度协议、Skill 绑定、receipt 格式、集成链、terminal 条件）只存在于「Generator 生成期上下文 + accepted handoff」的组合中；handoff 与 8 份 artifacts 是 immutable 事实面，但**不是** fresh 顶层 Controller 的启动合同。没有由 accepted handoff 生成的 exact Stage 3 执行 Prompt，fresh 会话将：(a) 无法区分 accepted 值与会话内推断值；(b) 无法执行最大安全并行与 reservation 语义；(c) 无法获得逐 task 25 字段 hard-field 合同；(d) 无法获得五角色分离与唯一集成链；(e) 无法在正确时点停止（terminal 边界）。因此 exact Prompt 的生成是必要且不可省略的。`BLOCKING_AMBIGUITY_REMAINS` 不适用——本 RED 只证明「缺少 Prompt 不可执行」，不产生规格歧义。

## 4. 唯一 canonical target 提议

- 现状核验：`git ls-files` 全部 tracked 文件仅含 `docs/PASEO_LOCAL_CHANGES.md`、`docs/design/v2.0.0.0-*` 与 AGENTS/README/CHANGELOG/package 等；`git grep -il "stage.?3"` 零命中（除 stage2 文件自身）；`docs/design/receipts/` 仅含本 generation 的 receipt。**不存在既有 canonical Stage 3 Prompt target，不存在同义 truth source**，故按 Generator「选择唯一 canonical target」执行「不存在时在 tracked planning/control hierarchy 中提出唯一文件」。
- **提议的唯一 canonical target**：`docs/design/v2.0.0.0-stage3-execution-prompt.md`
- 理由：
  1. 位于 `paseo-agy-acp` 的 tracked planning/control hierarchy（`docs/design/`），与 8 份 accepted Stage 2 artifacts 同目录、同 `v2.0.0.0-` 版本族、同 `-stageN-` 命名约定，语义邻接（Stage 3 执行 Prompt 是 Stage 2 artifacts 的下游消费者）；
  2. 仓库内无第二处可承担该身份的文件（无 `controller-prompts/` 目录、无其他 prompt 文件），MAACS 只持有 Generator（Scheme §6.5 明确区分 Generator 与执行 Prompt 两类文件），写入 MAACS 被 Generator 禁止；
  3. 单文件、单 authority：候选 Prompt 将声明「本文件是 Stage 3 执行 Prompt 的唯一 canonical target」，与 Generator 的「不得制造重复 authority」要求一致；
  4. 该文件在 Generation 阶段**不创建**（`FORBIDDEN_SURFACES`：不得写 proposed canonical target），由 Generator 流程的 Single Integrator 在双审 accepted 后写入。
- 双审建议核对项：命名族一致性、与既有 stage2 artifacts 无命名冲突、与 MAACS 五份 canonical manifest（Scheme §6.5）无重叠、`docs/PASEO_LOCAL_CHANGES.md` 不受影响。

## 5. 候选 Prompt 覆盖清单（EXACT_ACCEPTANCE 逐项映射）

| EXACT_ACCEPTANCE 项 | 候选正文落点 |
| --- | --- |
| exact cwd / 新顶层 / Stage3-only persistent Goal | §0 |
| Scheme + 8 artifacts paths/blobs/sha256 + accepted commit + generation parent | §1/§2（含 §2.1 表） |
| 无未来 packaging OID | §2.1 注（packaging commit 由 readback 固定，正文不预写） |
| 两源码功能区 / seam / 全部业务合同 | §3 |
| 完整 task Skill 映射与 task-specific modes | §4（含 §4.2 逐 task 绑定表、mode 授权规则） |
| 实现 Worker `codex/gpt-5.5` + `xhigh` 不替换 | §4.1 |
| 三个调研候选 | §4.3 |
| impact 先于 symbol 编辑 / 真实 RED / minimal GREEN / refactor / regressions / staged detect / dual review / sole integration | §5 |
| exact sole DAG / write / resource / barriers / briefs | §2.2/§2.3/§2.4/§2.5 + §6（27 briefs） |
| READY/RUNNING/REVIEW/INTEGRATION/BLOCKER 集合与立即 frontier 重算 | §7 |
| Parallelism Review 字段 | §7.4 |
| 六阶段验收以 isolated 6768 结束 | §8.1 |
| T08 typed external stop 排除于内部完成前驱集 | §2.2 注 + §8.1 |
| README/README.zh-CN/CHANGELOG/design task | §6.21（S3-T21） |
| source/tests/candidate/install/provider/production/release 分离 | §8.3 |
| ready-for-release 仅全部 nodes + reviews + Critical0 + High0 | §8.2 |
| 本生成任务不执行 Stage 3 | 候选头部声明 + 本 RED §8 |

候选正文同时满足 Generator 的「生成流程」要求：自包含单文件、由 fresh context 启动、可从 immutable 输入独立重建 coverage、无 TBD/TODO/占位/未解析变量/预测路径/`READY_FRONTIER` 预填、正文不含自身 digest。

## 6. Method Conformance Evidence（writing-for-agents / to-spec 逐项）

| Skill / 步骤 | 执行 / 不适用 | authority reason |
| --- | --- | --- |
| `writing-for-agents` — context pointers | **executed**：候选以 path+stable identity+semantic role 引用 8 份 immutable artifacts，并把 pointer 触发条件写成准入核验步骤；RED §3 论证 pointer 缺失即不可恢复 | 候选 Prompt 是 fresh 会话的启动文档，pointer 措辞决定其是否可靠触达 handoff/scheme |
| `writing-for-agents` — information hierarchy | **executed**：候选把 in-file steps（准入、调度、terminal 步骤）与 in-file reference（DAG/maps/briefs）分节；sibling 材料按 disclosed pointer 引用；不缓存环境可查信息（package.json scripts 等留给环境） | 27 briefs 是 in-file reference 中必须完整保留的硬字段合同，不得摘要 |
| `writing-for-agents` — steps & completion criteria | **executed**：每个调度事件、每 task acceptance、ready-for-release 条件均为可检查、穷尽的 completion criterion；「未双审/未集成不得声称 accepted」显式写入 | 防 premature completion：双审 accepted 前不进入集成，集成前不进入 canary |
| `writing-for-agents` — leading words | **executed**：沿用 `RED`/`GREEN`、`typed stop`、`fence`、`no replay`、`sole frontier authority`、`READY_FRONTIER` 等既有词汇，不造新词 | 与 Scheme/handoff 词汇一致，减少语义漂移 |
| `writing-for-agents` — pruning / single source of truth | **executed**：DAG/maps/barriers/briefs 只从一个 immutable 来源（handoff）转写并 pin；不复制 sibling 整文件 digest；不重复 Scheme 全文（以 pointer + 继承清单引用） | 防止第二张调度图、第二份业务合同 |
| `to-spec` — 本地综合 / seam / 测试合同方法 | **executed（适配）**：候选 §2.5 继承 S2-TEST-001 的 seam 与 RED/GREEN receipt 合同；§6 briefs 保留每 task 的 seam 与断言 | Generator 明示 to-spec 只执行本地综合、seam 与测试合同方法 |
| `to-spec` — issue-tracker publish / `ready-for-agent` label | **inapplicable under project authority** | Generator 明示外部 tracker 发布未授权；本项目唯一交付 = 仓库内 receipt 文件 |
| `to-spec` — 访谈用户 | **inapplicable under project authority** | Generator「SKILL_FORBIDDEN_SHORTCUTS」：不访谈用户；Stage 1 已 confirmed |
| 其他 | 未委派；未安装/切换 Connector；未运行 Provider/6767/network/build/test；未写 git index/refs；未 push/tag/deploy/release | RESOURCE_SET 只读 + 两处 bounded Markdown 写入 |

## 7. 写集与扫描纪律

- 唯一写入：`docs/design/receipts/STAGE3-PROMPT-GEN/documentation-red.md`（本文件）、`docs/design/receipts/STAGE3-PROMPT-GEN/stage3-prompt-candidate.md`。
- 两文件均不嵌入自身 digest；whole-file SHA-256 由本 Worker 在最终响应中外部报告（写入后计算，不写入文件）。
- 候选正文扫描项（写入后执行，见终报）：TBD/TODO/占位 token/未解析变量/`READY_FRONTIER` 预填/猜测 commit/过期 baseline/缺失 task ID 或硬字段；本文件与候选均不含 banned token 正文。
- 终报前 `git status --porcelain` 应只显示 inventory receipt + 本两文件（三个 untracked receipt 文件）。

### 7.1 写集偏差与 bounded cleanup 记录（Controller correction，如实记录）

- **瞬时偏差**：验证阶段曾创建临时脚本 `/tmp/verify_s3_prompt.py`（仓库外路径，用于一次性扫描）。该路径不属于本任务 `ALLOWED_WRITE_SET`（仅两个 receipt 文件）；Controller 已指出该偏差并下达 correction。
- **bounded cleanup**：已执行 `rm -f /tmp/verify_s3_prompt.py`，并验证该路径不再存在（`ls` 报 no such file；见本 Worker 终报中的删除核验输出）。
- **无其他越界写**：除该瞬时临时文件外，未创建或修改任何其他仓库外/仓库内非授权路径；未触碰 Stage 2 artifacts、源码、测试、package、README/CHANGELOG、MAACS、`~/.agents`、`~/.paseo`、git index/refs。
- **后续验证方式**：全部剩余检查改为纯只读 in-command 命令（grep/sha256sum/搜索，不创建任何文件），不再写临时脚本。
- **该偏差的用途与处置**：临时脚本运行结果仅用于发现并修复候选正文缺失 `runtime.sqlite` 单文件 durable authority 表述（已在候选 §3 补入 C2 数据与物理边界条款）；偏差本身不改变本 RED 结论、候选正文合同或双审输入。
- **持久写面澄清**：本任务的唯一持久 repo 写入始终为上述两个 receipt 文件；该偏差是仓库外瞬时的、已清理并核验删除的，不改变持久写面声明。

### 7.2 Bounded repair round 记录（S3-PROMPT-GEN-REPAIR-001，dual revisions-required 后）

- 触发：独立 Spec Review（`docs/design/receipts/STAGE3-PROMPT-GEN/spec-review.md` @ `f9b67ab6628f8a3a787ca6b54600490a5b98681cd7e80485071b19bd2f167d5c`）与 Quality Review（`docs/design/receipts/STAGE3-PROMPT-GEN/quality-review.md` @ `31e08fa63546d067bab46d9fa7928c88ac51e88889afc8a1b7958e6b9404679e`）均 `revisions-required`；两份 receipt 已完整读取（immutable revisions-required 证据，未编辑、未删除）。
- 修复（单一 consolidated repair，仅改候选与本 RED）：
  - F1/阻断（Spec F1 + Qual F-01）→ R1：候选 §1.2 step 3、§2.1 表行 1、§2.1 packaging 时序注、§6.0 `EXACT_GIT_BASELINE`、§9 启动方式改为「immutable generation parent `78931bf` 与运行时 HEAD（Generator packaging commit，唯一 parent=generation parent）分离」的结构化准入；packaging 前以 HEAD=`78931bf` 粘贴启动显式标注为**非 canonical 退化情形**；27 个 brief 经共享 §6.0 条款级联生效；不预写未来 packaging OID、不内嵌自身 digest。
  - F2/收窄（Spec F3 + Qual F-02）→ R2：候选 §1.2 step 3 untracked 准入由目录通配符改为精确 fail-closed 规则（packaging 后优先干净 worktree；若生成期 receipts 必须保持 untracked，只允许精确枚举的五个路径且 SHA-256 与 post-commit 外部完整性 receipt 一致（外部核验，正文不内嵌 hash）；其余 → `WORKTREE_DRIFT_UNRESOLVED`）。
  - F3/真实性（Spec F2 + Qual F-03）→ R3：本 RED §0.7 与 §2 如实改为「一次瞬时仓库外 `/tmp` 越界写已发生、已触发 `WRITE_SET_VIOLATION`、经 Controller correction 后 bounded cleanup 并核验删除、已关闭、无残留」；§7.1 保持并补持久写面澄清；不 waive。
  - F4/占位（Spec F4）→ R4：候选 §5 第 6 条的旧 focused-test 文件参数占位写法（`npm test --` 后跟尖括号文件参数的形式）已移除，改为具体无占位措辞（「对该任务回归测试文件运行 `npm test --` 并附加该文件路径」）；候选已修复。
  - F-04/条件 task（Qual F-04）→ R5：候选 §4.2 architecture-sensitive 条件映射补「新 task 必须携带完整 25 字段 brief，并在记录 authority 下显式更新 §2.2 DAG 与 §2.3 write-set 后才允许进入 `READY_FRONTIER`；任何此类变更不得静默进行」。
  - R6（live 路径归一化，双审遗漏项）：候选 §2.4 资源行与 S3-T02 brief 的 child helper 路径归一化为 live `tests/helpers/admission-controller-child.mjs`（与 accepted ACP source map S2-RECON-ACP-001 引用的 exact path 一致）；非业务合同/DAG 变更。
- 未变更：§2.2 DAG、§2.3 WRITE_SET_MAP、§2.5 barriers、27 briefs 的 25 字段内容（除 R6 路径归一化）、Skill/task 映射、调度协议、terminal 条件、全部 authority 哈希绑定。
- 终态：候选与本 RED 全文重读、外部 sha256 重算、literal scans 复跑（banned tokens / 尖括号 token / `READY_FRONTIER` 预填 / 自 digest / 40-hex 清单 / 27×25 字段计数）；`Stage 3 not started`。

## 8. Terminal Boundary

- 本任务只产出：本 RED + 候选 Prompt + 方法证据；**`Stage 3 not started`**；未写 canonical target（`docs/design/v2.0.0.0-stage3-execution-prompt.md` 由 Generator 流程的 Single Integrator 在双审 accepted 后创建）；未执行任何 Stage 3 task；等待 Controller 双审裁决。
- 剩余风险（如实记录）：候选 Prompt 的双审（Spec/Quality）、packaging commit 与外部完整性 receipt 均属 Generator 流程后续步骤，不在本任务内；候选正文对 handoff 的转写（27 briefs 的字段值）已逐字段对齐，但最终以双审 + readback 为准。
