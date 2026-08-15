# paseo-agy-acp Stage 3 Prompt Generation — Independent Formal Spec Review Receipt（S3-PROMPT-GEN-REV-SPEC-001）

状态：本文件是 Spec Reviewer 对候选 Stage 3 执行 Prompt 的独立 formal review receipt。**只读审查，未执行 Stage 3，未修改任何候选/RED/inventory/Stage 2/源码/测试/MAACS/`~/.agents`/`~/.paseo`/git index/refs。** 唯一写入 = 本文件。

`TASK_ID`：`S3-PROMPT-GEN-REV-SPEC-001`
`STAGE`：Stage 3 Prompt Generation（**非 Stage 3 执行**）
`TASK_TYPE`：independent formal Spec Review（Generator-fixed：primary `code-review` + supporting `to-spec`）
`SELECTED_PRIMARY_SKILL`：`code-review`（`/home/tiezbro/.agents/skills/code-review/SKILL.md`，sha256 `9cf46653dd9c710ea1e6c22423caf31a794c88773bc94bdaa23140277f470442`）
`SELECTED_SUPPORTING_SKILLS`：`to-spec`（`/home/tiezbro/.agents/skills/to-spec/SKILL.md`，sha256 `5d26479544b08048d3a8f79d937b39bc613a617f026b3fd083bafc1e99a7b811`）
`SKILL_SOURCE_IDENTITY`：`mattpocock/skills@8b78b531ab965735c5dc74f6f7a219e1e37326df`；两份 SKILL.md 均在行动前完整读取；live hash 与 skill-inventory 绑定一致
`DEPENDENCIES`：Stage 2 accepted commit `78931bff95ecbd9868f9cfa83a281cbbbf1a60d8`；SKILL_INVENTORY Gate accepted（`skill-inventory.md` @ `e68e057cfc5ea3a60ba099a34ae77d2b9700ced70d26775ae2dcfd76238aee81`）；Documentation RED @ `8c6418c8cb76d9bb9de3a11e56a937b3130acabfe379f9ac47f297896e0af0ca`；Candidate @ `5f3b04089b14b24231d15242197007f7d40c650cdbbc0c35f77692f52504fb19`
`EXACT_GIT_BASELINE`：repo `/home/tiezbro/projects/paseo-agy-acp`，branch `main`，HEAD `78931bff95ecbd9868f9cfa83a281cbbbf1a60d8`，tracked/index clean，唯一 untracked = `docs/design/receipts/`（Prompt-generation receipt 目录）
`ALLOWED_WRITE_SET`：`docs/design/receipts/STAGE3-PROMPT-GEN/spec-review.md`（本文件）only

---

## 0. Findings-first 摘要

1. **[HIGH-1] 阻断性自相矛盾：候选准入要求未来 Stage 3 会话 HEAD=`78931bf`，但 canonical Prompt 只存在于其父为 `78931bf` 的后续 packaging commit 中。** 候选 §1.2 step 3、§2.1 表第 1 行、§6.0 `EXACT_GIT_BASELINE` 均绑定「会话启动时 HEAD=78931bf」。但 Generator 流程规定 canonical target 由 Single Integrator 在双审 accepted 后写入并创建本地 packaging commit（Generator「Single Integration 与 Documentation GREEN」：packaging commit 的 parent = generation parent `78931bf`），用户随后在 `cwd=/home/tiezbro/projects/paseo-agy-acp` 启动新顶层 Stage 3 会话时仓库 HEAD 必然是 packaging commit 而非 `78931bf`。按候选正文自己的准入规则，会话将确定性失败于 §1.2 step 3（`WORKTREE_DRIFT_UNRESOLVED`），且 §6.0 使每个 task 的 fresh readback 都以 `STAGE2_HANDOFF_REVISIONS_REQUIRED` 停止。**阻断性执行矛盾 → 单一路径修复（见 FINDINGS F1 与 §2.1 修复判词）。**
2. **[MED-2] Documentation RED §0.7/§2 的写集声明与其自身 §7.1 记录矛盾。** RED §0.7「本任务只写上述两个 receipt 路径」与 §2「`WRITE_SET_VIOLATION`…均不适用」与 §7.1 如实记录的瞬时 `/tmp/verify_s3_prompt.py` 越界写不一致。真实终态 = 发生过一次 `WRITE_SET_VIOLATION` 类瞬时偏差、已 bounded cleanup 并验证删除（本 Reviewer live 核验 `/tmp/verify_s3_prompt.py` 不存在）、已在 §7.1 披露；修复 = 改写 RED §0.7 与 §2 blocker 行措辞，不waive（见 FINDINGS F2）。
3. **[MED-3] §1.2 step 3 的 untracked 准入是目录通配符，过宽。** 「唯一允许的 untracked = `docs/design/receipts/` 下已存在的 receipts」未 pin 精确文件集；packaging commit 已含获准控制证据时 untracked 应为空或精确集合。修复 = pin 精确 untracked 集合（见 FINDINGS F3，与 F1 同一次 §1.2 step 3 改写）。
4. **[LOW-4] 候选 §5 第 6 条 `npm test -- <文件>` 含尖括号占位 token**（verbatim 继承自 accepted S2-TEST-001:167，但违反 Generator「无占位 token」与 literal-scan 纪律）→ 需改写成无尖括号措辞（见 FINDINGS F4）。
5. **[RESOLVED-5] `<AGY_ACP_STATE_DIR>` 是已解析的规范 env-var 路径模板，不是未解析占位符。** 与 accepted handoff §6 C2 `runtime.sqlite` 条款 verbatim 一致（handoff:226、handoff:337、Scheme §4.1/§4.4 同源）；按 stage3-prompt-generation 纪律保留（见 FINDINGS F5）。
6. **覆盖重建总体结果**：除 F1-F4 外，candidate 对「confirmed Scheme → immutable Stage 2 handoff → generated Prompt」的 coverage 重建完整——27 个 brief × 25 硬字段全部在场且与 handoff §12 逐字段一致；sole DAG、WRITE_SET_MAP、RESOURCE_SET_MAP、INTEGRATION_BARRIERS、Skill/task 映射与 handoff §8/§9/§10/§11/§13 逐行 diff 为零；六阶段验收顺序、T08 typed-stop 排除、五角色分离、实现 Worker pin（`codex/gpt-5.5`+`xhigh`）、三个调研候选、最大安全并行协议、terminal 边界全部一致；全部 authority 哈希（Generator/Scheme/AGENTS/handoff/8 artifacts/inventory/RED/candidate/S2 Controller Prompt/14 skills）live 核验匹配；无自引用 digest、无未来 packaging OID、无 `READY_FRONTIER` 预填、无 TBD/TODO/FIXME/XXX。
7. **`Stage 3 not started`**；本 Review 未执行任何 Stage 3 动作，未写 canonical target，未触碰 git index/refs；等待 Writer 按 F1-F4 修复后重新双审。

---

## 1. Identity 与 runtime 核验（identity-first，start 与 terminal 各一次）

| 项 | 值 | 核验 |
| --- | --- | --- |
| `PASEO_AGENT_ID` | `3fbe1d07-1e38-455d-becc-a146bb4fb0b0` | `printenv` ✓（start 与 terminal 一致） |
| Name | `S3 Prompt Formal Spec Review` | `paseo inspect --json` ✓ |
| `ParentAgentId` | `93287419-016e-4473-b3c8-7a0b0b248c2d` | **CHILD** ✓ —— 不加载 thin selector、不自动编排、不委派（遵守 CHILD 规则） |
| Provider / Model | `hermes` / `custom:deepseek-v4-flash` | 属于 Generator 三个已批准调研候选之一 ✓ |
| Thinking | `max` | ✓ |
| Mode | `dont_ask`（Paseo live official option：default/accept_edits/dont_ask） | ✓ 未硬编码扩大 |
| `PendingPermissions` | `[]`（0） | ✓ |
| Status / Cwd | `running` / `/home/tiezbro/projects/paseo-agy-acp` | ✓ |
| 委派 | leaf；`RESOURCE_SET` 委派不可用 | 未委派 ✓ |

## 2. Authority hash-first 核验（live，全量）

| 项 | exact path | 绑定值 | live 实测 | 结果 |
| --- | --- | --- | --- | --- |
| Stage 3 Prompt Generator | `/home/tiezbro/projects/MAACS/docs/controller-prompts/PASEO_AGY_ACP_STAGE3_PROMPT_GENERATOR.md` | `9e2e8334289fe4be546303687daeb28903c58be72c19c4ad40738648686edcdd` | 同 | ✓ |
| confirmed Scheme | `/home/tiezbro/projects/MAACS/docs/maacs-paseo-agy-acp-confirmed-scheme.md` | `d3b712ee5dd01029c66b0372a482f248a6f1ecbcf81572eb74d7b4ba5d98a98d` | 同；状态 `confirmed` | ✓ |
| AGENTS.md | `AGENTS.md` | `9bbd1e7b1bb7938cc3fd5922a1dcf9a036fa8639267d38789213f4fe9fc3198d` | 同 | ✓ |
| Stage 2 handoff | `docs/design/v2.0.0.0-stage2-handoff.md` | whole-file `c88be84fa4c86c4c63921aaccd08f5f9c765dc896f1c35592f6cb0ee16fafc48`；blob `89c8abe0d82c4915cbf6748db15a9ff86a80c501` | 同 | ✓ |
| S2-SPIKE-503-001 | `docs/design/v2.0.0.0-stage2-503-feasibility.md` | blob `33ace156c84c769f55608ba33e95012462cc1718`；sha256 `c742645666b456bd5f42602a407446f70cd55321a0d2be2da044f514cb27de19` | 同 | ✓ |
| S2-RECON-ACP-001 | `docs/design/v2.0.0.0-stage2-acp-source-map.md` | blob `af5d58f021642276df6ca9fe9bcb33102ca1285c`；sha256 `f2ded52a47a73773efcbbf27b1d395ad6a9abba7e95b0bdd2516c3b0fe65f860` | 同 | ✓ |
| S2-RECON-ADM-001R | `docs/design/v2.0.0.0-stage2-admission-source-map.md` | blob `90b1c7c1fb8d7a465ba266bf2ff3dbc5dddaacc3`；sha256 `eee7e56c7ddaa09dc155cb92772298eb0b19710e88b336e16a3851546015fafb` | 同 | ✓ |
| S2-ARCH-001 | `docs/design/v2.0.0.0-stage2-architecture.md` | blob `2a0028cbb60a54aff1fa85afb5d9ca78251f6be9`；sha256 `7989c043603a11e4b5d88073d8352509d9ffcf7f8c0d736d2b48149aff03eb54` | 同 | ✓ |
| S2-DOMAIN-001 | `docs/design/v2.0.0.0-stage2-domain-model.md` | blob `37d96877c5b6d9f8506d209be4c3184532e4e0bf`；sha256 `3b6fabc9a862ed515ea5d39643fdeff6d83f15d0a079d3ea166377004183c12e` | 同 | ✓ |
| S2-SPEC-001 | `docs/design/v2.0.0.0-stage2-spec.md` | blob `b4f316b9b0cd58603258b916adce5810f4e8b5c2`；sha256 `3d90fe642f9322970c8e40e7a23b22228d62bfb3c52a5faac5a10960a9d03450` | 同 | ✓ |
| S2-TEST-001 | `docs/design/v2.0.0.0-stage2-test-contracts.md` | blob `f17d726b38420c08ba6725bd4bfb6f502676fae4`；sha256 `51e8e3bab735919b2d3643d1212fe289c6de281da4404bde033709a8cb22ed2b` | 同 | ✓ |
| SKILL_INVENTORY receipt | `docs/design/receipts/STAGE3-PROMPT-GEN/skill-inventory.md` | `e68e057cfc5ea3a60ba099a34ae77d2b9700ced70d26775ae2dcfd76238aee81` | 同 | ✓ |
| Documentation RED | `docs/design/receipts/STAGE3-PROMPT-GEN/documentation-red.md` | `8c6418c8cb76d9bb9de3a11e56a937b3130acabfe379f9ac47f297896e0af0ca` | 同 | ✓ |
| Candidate | `docs/design/receipts/STAGE3-PROMPT-GEN/stage3-prompt-candidate.md` | `5f3b04089b14b24231d15242197007f7d40c650cdbbc0c35f77692f52504fb19` | 同 | ✓ |
| Stage 2 Controller Prompt（provenance） | `/home/tiezbro/projects/MAACS/docs/controller-prompts/PASEO_AGY_ACP_STAGE2_CONTROLLER_PROMPT.md` | `9f946e36e717547e5982eefcc37c188d236e48b3be495541bd12129f84207993` | 同 | ✓ |
| branch / HEAD | — | `main` / `78931bff95ecbd9868f9cfa83a281cbbbf1a60d8` | 同；`git status --porcelain` 仅 `?? docs/design/receipts/` | ✓ |

**14 项必需 Skill 的 live sha256 与 inventory `SOURCE_HASH` 全量一致**（tdd `5e6b9c16…`、implement `6d3fd9e8…`、diagnosing-bugs `b9339b09…`、triage `91e2817e…`、writing-for-agents `a842323e…`、code-review `9cf46653…`、to-spec `5d264795…`、codebase-design `a8d50aba…`、resolving-merge-conflicts `c7c9ba81…`、research `af378829…`、wayfinder `d33e2141…`、domain-modeling `9617041d…`、wizard `7fb2b4ba…`、improve-codebase-architecture `7b76f01b…`）。`code-review`/`to-spec` 两份本 Review 已完整读取。无 `SHARED_SCHEME_MISSING`/`SCHEME_HASH_MISMATCH`/`STAGE2_HANDOFF_MISSING`/`HANDOFF_HASH_MISMATCH`/`WORKTREE_DRIFT_UNRESOLVED`（当前态）/`SKILL_UNAVAILABLE`/`SKILL_FALLBACK_UNAPPROVED`/`METHOD_AUTHORITY_CONFLICT`/`ROLE_SEPARATION_UNAVAILABLE`/`AGENT_MODE_UNAVAILABLE`。`WRITE_SET_VIOLATION`：见 FINDINGS F2（RED 自身记录问题，非本 Review 触发）。

## 3. 逐项 adjudication（EXACT_ACCEPTANCE 第 5 条）

### 5a. §1.2 step 3 / §2.1 / §6.0 要求未来会话 HEAD=`78931bf` vs packaging commit 时序 —— **阻断性自相矛盾，VERDICT 受影响**

**证据**：
- Candidate §1.2 step 3（candidate:40）：`branch=main，HEAD=78931bff…，index 干净；唯一允许的 untracked = docs/design/receipts/ 下已存在的 receipts`，否则 `WORKTREE_DRIFT_UNRESOLVED`。
- Candidate §2.1 表第 1 行（candidate:52）：`accepted Stage 2 commit / generation parent | repo HEAD | 78931bff…` —— 把「repo HEAD」与 `78931bf` 等同。
- Candidate §6.0（candidate:262）：`accepted Stage 2 commit / generation parent 78931bff…；任务启动时必须 fresh readback（cwd/branch/HEAD/index/dirty ownership）；与绑定值漂移且无新用户裁决 → typed stop STAGE2_HANDOFF_REVISIONS_REQUIRED`。
- Generator（Generator:281）：canonical target 由 Single Integrator 写入后创建「本地 packaging commit」，且「packaging commit 只能通过写入后的 readback 固定，不能要求 Prompt 正文预先包含它自己的 commit OID」（Generator:153 同旨：不得嵌入未来 packaging OID）。
- Generator「本次完成标准」（Generator:299-309）：packaging commit 在 Generator 流程内形成，然后才「启动新 Stage 3 顶层会话」。

**判定**：是阻断性自相矛盾。canonical Prompt 文件只存在于 packaging commit 中（其 parent = generation parent `78931bf`）；用户按候选 §9「启动方式」在 `cwd=/home/tiezbro/projects/paseo-agy-acp` 启动新会话时，仓库 HEAD 必然是该 packaging commit，不可能同时等于 `78931bf`。候选正文自己的准入 step 3 与每个 task 的 baseline 条款都会把合法的 packaging-commit 状态误判为漂移并 typed stop——即「按候选规定启动会话」在结构上必然失败。`BLOCKING_AMBIGUITY_REMAINS` 类执行矛盾成立。

**单一路径修复判词（唯一 disposition）**：把「HEAD 必须等于 78931bf」改写为「HEAD 必须是 Generator 流程的 packaging commit 或 78931bf 本身」的结构性准入，同时保留 generation parent 绑定与不预写未来 OID 纪律：
1. §1.2 step 3 改为：`branch=main；HEAD = Generator 流程 packaging commit（其 parent 必须 = generation parent 78931bf，以 git rev-parse HEAD^ 核验），或 HEAD=78931bf（packaging 前的等价态）；index 干净；untracked = 精确 pin 的集合（见 F3）。其他漂移 → WORKTREE_DRIFT_UNRESOLVED。`；
2. §2.1 表第 1 行「repo HEAD」格改为 `generation parent / packaging commit 的 parent`，值仍为 `78931bf`，并在注释中写明「会话 HEAD 为 packaging commit，其 parent 必须等于本值」；
3. §6.0 `EXACT_GIT_BASELINE` 改为：`accepted Stage 2 commit / generation parent 78931bf；会话 HEAD = packaging commit（parent=78931bf）；任务启动 fresh readback 时核验 HEAD 的 parent 链 = 78931bf 且 index 干净`，漂移判定同前。
4. 正文仍不得嵌入 packaging commit 的未来 OID（保持现有正确做法）；packaging commit 身份由 post-commit 外部 readback receipt 绑定（保持）。
此修复不改变任何 task、DAG、写集或 acceptance 内容——只修正准入的 HEAD 判定，是**单一路径**。

### 5b. RED §0.7/§2「只写两个 receipt 路径 / WRITE_SET_VIOLATION 不适用」 vs RED §7.1 瞬时 /tmp 写 —— **真实终态与精确修复**

**证据**：RED §0.7（red:23）「本任务只写上述两个 receipt 路径」；RED §2（red:59）「`WRITE_SET_VIOLATION`…均不适用」；RED §7.1（red:136-142）如实记录验证阶段曾创建 `/tmp/verify_s3_prompt.py`（不在 ALLOWED_WRITE_SET），已 `rm -f` 并验证删除，且该偏差仅用于发现候选缺失 `runtime.sqlite` 表述（已修复）。

**判定**：真实终态 = 发生过一次 `WRITE_SET_VIOLATION` 类**瞬时偏差**（仓库外 /tmp 一次性脚本），**bounded cleanup 已完成且本 Reviewer live 核验 `/tmp/verify_s3_prompt.py` 不存在（`ls` no such file）**；偏差已如实披露于 §7.1，未留下任何持久越界写。因此：
- 「只写上述两个 receipt 路径」作为对**持久 repo 写面**的陈述成立，但作为对**全部写入**的陈述不成立——必须限定措辞；
- 「`WRITE_SET_VIOLATION` 不适用」不成立——偏差**确实发生**过，只是已清理核验；正确措辞是「`WRITE_SET_VIOLATION`：瞬时 /tmp 偏差已发生并已 bounded cleanup + 验证删除（§7.1），不构成未清理的写集违规」。

**精确修复**：改写 RED §0.7 为「唯一持久 repo 写入 = 上述两个 receipt 路径；另有一次瞬时的 `/tmp/verify_s3_prompt.py` 越界写，已 bounded cleanup 并验证删除（§7.1），无残留越界写；未写 canonical target/源码/测试/Stage 2 artifacts/MAACS/`~/.agents`/`~/.paseo`/issue tracker/git index/refs」；改写 RED §2 blocker 行为上述正确措辞。**不因 cleanup 已发生而 waive**——RED 的总结性声明必须与其自身 §7.1 一致（Generator「如实记录」纪律）。

### 5c. 「允许任何 untracked `docs/design/receipts/` 内容」是否过宽 —— **过宽，MED**

§1.2 step 3 用目录通配符 `docs/design/receipts/ 下已存在的 receipts` 作为准入白名单，未 pin 精确文件集：任何他人/遗留文件落进该目录都会被误准入；而 packaging commit 已包含获准控制证据后，合法 untracked 应为空或精确集合。修复：pin 精确集合，例如「untracked 只允许 `docs/design/receipts/STAGE3-PROMPT-GEN/` 下 inventory/RED/candidate 三份（及本 review 的 spec-review receipt），packaging commit 已包含它们时 untracked 必须为空；其余任何 untracked → `WORKTREE_DRIFT_UNRESOLVED`」。与 F1 同一次 §1.2 step 3 改写完成。

### 5d. `<AGY_ACP_STATE_DIR>` 是已解析规范路径模板，不是未解析占位符 —— **RESOLVED，无问题**

候选 §3 C2（candidate:193）`<AGY_ACP_STATE_DIR>/runtime.sqlite` 与 accepted handoff §6 C2（handoff:226）verbatim 一致；handoff §10 RESOURCE_SET_MAP（handoff:337）与 Scheme §4.1/§4.4 使用同一 env-var 名。按 stage3-prompt-generation 纪律，「canonical env-var path templates（如 `<AGY_ACP_STATE_DIR>/runtime.sqlite`）在 accepted artifacts 中 verbatim 出现，移除反而破坏 fidelity」——该 token 是**已解析的规范环境变量路径模板**（运行时由 `AGY_ACP_STATE_DIR` 环境变量解析），非未解析占位符。保留正确。

## 4. EXACT_ACCEPTANCE 逐项核验

1. **Scheme 覆盖重建**：候选 §3 完整继承席位/队列/账号/503/terminal/恢复/legacy/禁止恢复合同并逐条引 Scheme §4.1-§4.7；§2.6 rejected alternatives/decision rationale provenance pointers（handoff §16/SPIKE §5-6/ARCH §15/DOMAIN §11）在场；27 briefs × 25 硬字段（含 `RED_RECEIPT_CONTRACT`/`GREEN_EVIDENCE_CONTRACT`/`REVIEW_ASSIGNMENT_CONSTRAINT`/`INTEGRATION_TARGET`）与 handoff §12 逐字段一致（脚本核验 27/27 全 25 字段）。无义务/feature/contract/gate/evidence/task brief 遗漏（除 F1-F4 外无 material change）。
2. **唯一 canonical target**：`docs/design/v2.0.0.0-stage3-execution-prompt.md` 唯一（`git ls-files` 无任何 stage3/execution-prompt 文件；RED §4 论证成立；候选头部声明「唯一 Stage 3 执行 Prompt」；生成阶段未创建该 target）——**不构成第二 authority**；与本 repo 无其他 Prompt truth source、与 MAACS 五份 canonical manifest（Scheme §6.5）无重叠。✓
3. **exact immutable inputs / generation parent / packaging 时序 / 新会话 baseline / branch/worktree 准入 / 无自引用**：inputs 全量 live 匹配（§2）；generation parent = `78931bf` 正确；packaging commit 由 readback 固定、正文不预写未来 OID（候选:67 明示）✓；**未来新会话 baseline 判定存在 F1 阻断性矛盾**；branch/worktree 准入存在 F1/F3；无自引用 commit/digest（候选不含自身或 RED 的 sha256；RED 亦不含；40-hex token 全部解析为已知绑定：skill pin `8b78b531…`×10、accepted commit `78931bf`×5、superseded `2229353…`×1（显式标注被取代）、8 个 sibling/handoff blob——零未来/猜测 OID）。✓
4. **sole DAG / maps / barriers / 27 briefs / Skill bindings / modes / 角色分离 / RED-GREEN / reviews / integration / scheduler / parallelism / terminal**：
   - DAG 边集、WRITE_SET_MAP、RESOURCE_SET_MAP、INTEGRATION_BARRIERS、Skill/task 映射与 handoff §8/§9/§10/§11/§13 **逐行 diff 为零**（§2.2/§2.3/§2.4/§2.5/§4.2 与 handoff 原文仅内部引用重映射，skill 允许）；S2-SPEC-001 §10.1 与 handoff §8 边集一致；无环（共享写者 `T18→T02→T03→T06→T14`、`T18→T09→T10`、`schema.ts` 唯一 writer T18）。✓
   - 27 briefs：T01-T21 + REV-SPEC/REV-QUAL/INT-PHASE-CODE/INT-PHASE-DOCS/INT-FINAL-COMMIT/INT-CONFLICT = 27；每 brief 25 字段；每 brief `DEPENDENCIES` 语义镜像 DAG 入边（T20/T21=全部内部 T01..T19 唯一排除 T08；REV-* 依赖 T01..T07、T09..T21 + T08 receipt；INT 链 `REV-SPEC+REV-QUAL → PHASE-CODE → PHASE-DOCS → FINAL-COMMIT`；INT-CONFLICT 条件）。✓
   - Skill 绑定：red-green=`tdd`+`implement`（T02/T03/T06/T09/T10/T12/T14/T16/T18/T20）、green regression=`tdd`+`implement`（T01/T04/T05/T07/T11/T13/T15/T17/T19）、T08=`diagnosing-bugs`+`triage`、T21=`writing-for-agents`（无 supporting）、REV-SPEC=`code-review`+`to-spec`、REV-QUAL=`code-review`+`codebase-design`、INT code/final=`implement`+`code-review`、INT docs=`writing-for-agents`+`code-review`、INT-CONFLICT=`resolving-merge-conflicts`+`code-review`——与 handoff §13 及 Generator 映射一致。✓
   - modes：实现 Worker 固定 `codex/gpt-5.5`+`xhigh` 不得静默替换（§4.1）；permission/mode 来自 live official options 且不扩大 write-set；调研三候选 `pi/MindStackLab-opencode-go/deepseek-v4-flash`/`codex/gpt-5.6-luna`/`hermes/custom:deepseek-v4-flash` 各 +max。✓
   - 五角色分离（§4.5）、真实 RED/GREEN 规则（§5：未修改 live HEAD 真实行为失败、禁 missing-file RED、禁 mutation-as-RED、receipt 格式含 HEAD 附件与 `<REDACTED>`）、六阶段验收顺序（§8.1 = handoff §11 逐行一致，isolated 6768 收尾）、ready-for-release 条件（§8.2：全部 nodes integrated + 双审 accepted + Parallelism accepted + Critical=0 + High=0）、事实层分离（§8.3）、README/文档任务边界（§8.4）。✓
   - scheduler：`DEPENDENCY_DAG`/`WRITE_SET_MAP`/`RESOURCE_SET_MAP`/`READY_FRONTIER`/`RUNNING_SET`/`REVIEW_SET`/`INTEGRATION_SET`/`BLOCKER_SET` 定义与不预填（§7.1）、fresh readback 每 scheduling event（§7.2）、立即释放与重算、reservation 保留、未启动记录 5 字段（§7.3）、Parallelism Review 8 字段（§7.4）——与 Generator「最大安全并行」逐项一致；无固定 wave/Agent 数量。✓
   - terminal：真实 Antigravity/install/6767/push/tag/deploy/release 需新授权、不属于 Development Closeout（§8.3）；T08 typed-blocked 排除于 READY_FRONTIER 且不阻塞内部完成路径。✓
5. **adjudications**：见 §3（F1 阻断、F2/F3 MED、F4 LOW、F5 resolved）。
6. **MEDIUM/HIGH/可执行矛盾 → VERDICT=revisions-required**：F1（HIGH，可执行矛盾）+ F2（MED）+ F3（MED）→ **VERDICT=revisions-required**；不因 F2 的 cleanup 已发生而 waive。
7. **receipt 输出字段**：本文件包含全部七个顶层字段（见下）。

## 5. 候选完整性扫描（literal）

- Banned tokens（TBD/TODO/FIXME/XXX）：候选与 RED 均为 **0**。✓
- 尖括号 token：候选仅 `<AGY_ACP_STATE_DIR>`（accepted 规范 env-var 模板，保留正确）、`<REDACTED>`（强制红action标记）、`<文件>`（F4，需改写）。RED 含 `<REDACTED>`。✓（除 F4）
- `READY_FRONTIER`：候选仅在定义/排除语境出现（§7.1 `= 计算值`、T08 排除、REV-QUAL 检查项），**无 `{T0x}` 预填**。✓
- 自/兄弟 digest：候选不含自身 sha256（`5f3b0408…`）亦不含 RED sha256（`8c6418c8…`）；RED 同样不含（计数 0/0）。✓
- 40-hex token：全部解析为已知绑定（见 §4.3）；`2229353…` 显式标注「已被该 accepted commit 取代」。✓
- 字段行计数：27 briefs × 25 字段（脚本核验，无缺/无增）。✓
- 转写 diff：DAG/maps/barriers/skill 映射与 handoff 逐行一致（§4.4）。✓
- `git status --porcelain`：仅 `?? docs/design/receipts/`；HEAD/branch 未变。✓

## 6. Method Conformance Evidence（code-review / to-spec 逐项）

| Skill / 步骤 | 执行 / 不适用 | authority reason |
| --- | --- | --- |
| `code-review` — 固定点（fixed point）pin | **executed**：固定点 = Stage 2 accepted commit `78931bf`（generation parent）+ 8 份 immutable artifacts + Generator；live 全量哈希核验（§2） | 任务 authority 固定；非 branch diff review，而是「confirmed Scheme → handoff → generated Prompt」重建式 Spec Review |
| `code-review` — Standards 轴 | **executed（适配）**：以 Generator 全部硬性要求（准入/输入/边界/Agent-Skill/并行/验收）、AGENTS.md、Scheme §6.3-§6.5 为 standards source，逐项核对候选 | 候选是 Prompt 文档而非代码；standards = 方法 authority 合同 |
| `code-review` — Spec 轴 | **executed（适配）**：以 confirmed Scheme + immutable handoff 为 spec source，重建 coverage（§4.1/§4.4）；发现 F1（执行矛盾）、F2（RED 声明矛盾）、F3（准入过宽）、F4（占位 token） | 「spec」= 业务义务与手off 合同 |
| `code-review` — 并行 sub-agent 双轴 | **inapplicable under project authority**：本 Worker 是 CHILD leaf，委派不可用（RESOURCE_SET）；按 Generator 固定映射由单一 Spec Reviewer 内联完成双轴并分开报告 | Generator「Controller 与 Agent 合同」五角色分离；本任务即独立 Spec Reviewer 身份 |
| `code-review` — issue-tracker / 用户访谈 | **inapplicable under project authority**：外部 tracker 未授权；Stage 1 已 confirmed，不访谈 | 同 Generator 明示 |
| `to-spec` — 本地综合 / seam / 测试合同方法 | **executed（适配）**：用 seam/测试合同方法核对候选 §5/§6 的 RED/GREEN seam 合同与六阶段验收（handoff §12.0/§15、S2-TEST-001 合同） | Generator 明示 to-spec 只执行本地综合、seam 与测试合同方法 |
| `to-spec` — issue-tracker publish / `ready-for-agent` label | **inapplicable under project authority** | 同 Generator 明示 |
| 其他 | 未委派；未安装/切换；未运行 Provider/6767/network/build/test；未写 git index/refs；未 push/tag/deploy/release；未创建任何临时文件（本 Review 全部检查为 read-only 命令） | RESOURCE_SET 只读 + 本 receipt 单一写入 |

## 7. Write-set 证明与 Terminal Boundary

- 唯一写入：`docs/design/receipts/STAGE3-PROMPT-GEN/spec-review.md`（本文件）。
- 本文件不嵌入自身 digest；whole-file SHA-256 由外部（本 Reviewer 最终响应）在写入后计算并报告，不写入文件。
- 写入后 `git status --porcelain` 应仍只显示 `?? docs/design/receipts/`（目录内新增本文件），HEAD/branch 不变。
- 未写：candidate、RED、inventory、Stage 2 artifacts、源码、测试、package、README/CHANGELOG、MAACS、`~/.agents`、`~/.paseo`、issue tracker、git index/refs、canonical target、/tmp。
- **`Stage 3 not started`**：本 Review 只读审查 + 单一 receipt 写入；未执行任何 Stage 3 task；等待 Writer 按 F1-F4 修复后重新双审。

---

# 七个顶层字段（Generator 要求）

- **SPEC_CONFORMANCE**：`NOT_CONFORMANT — revisions required`。Scheme→handoff→Prompt 覆盖重建本身完整（27×25 字段、DAG/maps/barriers/映射逐行一致、全部哈希匹配），但 F1（HEAD 准入执行矛盾）与 F3（untracked 准入过宽）违反 Generator「准入」「exact immutable inputs」与「packaging 时序」合同，候选按自身规定无法在 packaging commit 之后的 fresh 会话通过准入。
- **QUALITY_CONFORMANCE**：`NOT_CONFORMANT — revisions required`。可执行性/上下文负载/信息层级/角色分离/模型-Skill 精度/任务边界/TDD 真实性/并行协议/terminal 条件整体达标（§4.4 逐项），但 F1 使「从 fresh 顶层会话启动」这一核心可执行性前提在结构上失败；F2 是控制证据（RED）真实性缺陷。
- **METHOD_CONFORMANCE**：`CONFORMANT`。code-review + to-spec 两份 SKILL.md 完整读取（hash 匹配）；逐项 executed/inapplicable 记录（§6）；未委派；无越权写；runtime tuple start/terminal 两次核验一致（CHILD、hermes/custom:deepseek-v4-flash、max、dont_ask、0 pending）。
- **PARALLELISM_CONFORMANCE**：`CONFORMANT`。候选 §7 完整转录 Generator 最大安全并行协议（8 集合、fresh readback、立即释放/重算、reservation 保留、未启动 5 字段记录、Parallelism Review 8 字段）；sole DAG 唯一权威、无环、无第二调度图；T08 正确排除；无固定 wave/Agent 数量；未发现无合法理由的串行化设计。
- **FINDINGS**：
  - **F1 [HIGH] 阻断**：candidate §1.2 step 3（candidate:40）、§2.1 表第 1 行（candidate:52）、§6.0（candidate:262）要求未来 Stage 3 会话 HEAD=`78931bf`，与「canonical Prompt 只存在于 parent=`78931bf` 的 packaging commit、会话启动时 HEAD=packaging commit」结构性矛盾 → 按候选自身准入必然 typed stop。修复：§1.2 step 3 / §2.1 / §6.0 改为结构性 HEAD 准入（HEAD=packaging commit 且 `HEAD^`=generation parent `78931bf`，或 HEAD=`78931bf` 的 packaging 前等价态；不预写未来 OID，packaging commit 身份由 post-commit readback receipt 绑定）。
  - **F2 [MED]**：RED §0.7（red:23）「只写上述两个 receipt 路径」与 §2（red:59）「`WRITE_SET_VIOLATION` 不适用」与其自身 §7.1 记录的瞬时 `/tmp/verify_s3_prompt.py` 越界写不一致。真实终态 = 瞬时偏差已发生、已 bounded cleanup 且 live 验证删除、已披露；修复 = 改写 RED §0.7 与 §2 措辞为「唯一持久 repo 写面 = 两个 receipt 路径；瞬时 /tmp 偏差已发生并已清理核验（§7.1）」与「`WRITE_SET_VIOLATION`：瞬时偏差已发生并已 bounded cleanup + 验证删除，不构成未清理违规」。不 waive。
  - **F3 [MED]**：§1.2 step 3 untracked 准入为目录通配符（`docs/design/receipts/ 下已存在的 receipts`）过宽；修复 = pin 精确集合（`STAGE3-PROMPT-GEN/` 下 inventory/RED/candidate/spec-review receipt；packaging commit 已含时 untracked 为空），与 F1 同一次改写。
  - **F4 [LOW]**：候选 §5 第 6 条（candidate:249）`npm test -- <文件>` 尖括号占位 token（verbatim 继承 S2-TEST-001:167）；修复 = 改写为无尖括号措辞（如「`npm test --` 该回归测试文件」），满足 Generator「无占位 token」与 literal-scan 纪律。
  - **F5 [RESOLVED]**：`<AGY_ACP_STATE_DIR>` 是 accepted artifacts 中 verbatim 出现的规范 env-var 路径模板（handoff:226/337、Scheme §4.1/§4.4），已解析、非未解析占位符；保留正确。
- **AFFECTED_SCOPE**：
  - Candidate：§1.2 step 3（F1+F3）、§2.1 表第 1 行与注（F1）、§6.0 `EXACT_GIT_BASELINE`（F1）、§5 第 6 条（F4）。候选 §2.2-§2.6、§3、§4、§5 其余、§6 全部 27 briefs、§7、§8、§9 不受影响（转写零 diff）。
  - Documentation RED：§0.7、§2 blocker 行（F2，措辞修复）；§7.1 内容正确保留。
  - 不涉及：Stage 2 artifacts、源码/测试、inventory receipt、MAACS、git index/refs、canonical target。
- **VERDICT**：`revisions-required`。触发项：F1（HIGH，可执行/结构性矛盾）+ F2（MED）+ F3（MED），按 EXACT_ACCEPTANCE #6 任一 MEDIUM/HIGH 或可执行矛盾即 revisions-required；F2 的 cleanup 已完成不构成 waive 理由。修复后须由同一批独立 Spec/Quality Reviewer 重新执行完整双审（Generator「独立双审」：任何 revisions-required 都返回 Writer 修订后重新双审）。

---

*本 receipt 由独立 Spec Reviewer（CHILD，`3fbe1d07-1e38-455d-becc-a146bb4fb0b0`）在 `main @ 78931bf`、tracked/index clean、唯一 untracked=`docs/design/receipts/` 的现场只读核验后写入；全部 hash 为 live 计算；`Stage 3 not started`。*
