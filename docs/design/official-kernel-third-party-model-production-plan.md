# 官方 Antigravity ACP 第三方模型本机生产修复计划

状态：开发前方案冻结（2026-08-28）

目标：在不恢复旧 CLI-backed backend、不重新分发 Google 专有构件的前提下，为当前 Linux x86_64 RC01 官方 ACP kernel 提供显式 opt-in 的本机兼容修复，使 raw CCPA 实际返回的 Claude 4.6 与 GPT-OSS 120B 在 Paseo 中可发现、可选择、可推理并可使用工具。

## 1. 四高验收轴

- **高鲁棒**：所有输入 hash 和目标源文件 preimage 必须匹配；未知版本、未知模型、半完成 staging、损坏 receipt、缺失 harness 均 fail closed；支持原子激活和快速回滚。
- **高性能**：agent 启动时不 hash 1.5 GiB PAR；只校验小型 receipt 和 patched Python 源文件。并发按当前 Admission policy 配置验收，不把默认值 8 写成限制。
- **高灵活**：模型兼容信息集中在一个 profile；官方 binary 路径仍由现有 `PASEO_AGY_ACP_OFFICIAL_BIN` 控制；默认行为保持官方 kernel，可显式切换、回滚或在 Google 发布修复版后停用。
- **高质量**：模块接口小而完整；每个开发包有契约测试、独立质检、最小提交和远程备份；真实 kernel 验收与 CI fake 分层；证据不含凭据、账号信息或完整请求体。

## 2. 已确认事实

### 2.1 官方输入 pin

| 输入 | SHA-256 |
|---|---|
| `agy_acp_server.par` | `46b5925100903a23e0ec7da8b8a218c224494dfffeb3fd30fcd84e91acbc8b07` |
| `localharness_external` | `8a8d8efc8dcf1f8cb87db6c932957ecf14684cd7d71ee5670b5515c16a685404` |
| `model_selection.py` preimage | `2dabcfcbb7e165cdd4fb73e05c08a8b01230837d818f39a0a13cd3cfbca87b71` |
| `ccpa_connection/proxy_server.py` preimage | `e350a8c7bef2d9e3616c6980774527d100137275bec5da147781e87f587012de` |
| `server.py` 官方对照（不得修改） | `8ede74f3cec50e0a76796ef1af91840bab16b7ee36664a2499f07d3119013d7b` |

### 2.2 已通过的隔离协议结果

1. ACP User-Agent 下 raw CCPA 目录为 14 项，包含：
   - `claude-sonnet-4-6`
   - `claude-opus-4-6-thinking`
   - `gpt-oss-120b-medium`
2. parser 只保留 raw 目录实际返回且本地 profile 支持的三个非 Gemini ID 后，`session/new` 原生返回 14 项，无超时。
3. `server.py` 恢复为官方 preimage 后，Claude 仍可选择并推理。官方 `_apply_session_model` 会动态重读完整目录，不需要静态白名单补丁。
4. Claude Sonnet、Claude Opus Thinking、GPT-OSS 均完成真实推理并返回 `end_turn`。
5. Claude 与 GPT 均完成同一 session 内连续两次 `view_file` 工具回合；Claude 精确返回两个未知 marker。
6. Claude warm `session/resume` 后仍返回 14 项，`currentValue` 保持 `claude-sonnet-4-6`，恢复后的第二次工具回合成功。
7. GPT reasoning 使用 `agent_thought_chunk`，最终内容使用 `agent_message_chunk`；无需新增 thought 分流转换。
8. raw 目录不存在的伪模型仍由官方动态校验返回 `-32602`，不会到达 backend。

## 3. 冻结后的唯一架构

### 3.1 不采用的方案

- 不恢复 2.0.0.2 CLI-backed backend。
- 不在 TypeScript `OfficialKernelProxy` 中伪造 catalog overlay。
- 不修改 `server.py` 或追加静态 model whitelist。
- 不把修改后的 PAR、ELF、runfiles 或 harness 放进 Git/npm/release。
- 不提交含 Google 专有源码上下文的 unified diff。
- 不修改 GPT thought/final ACP 事件。
- 不在 agent 启动热路径重新 hash 1.5 GiB PAR。

### 3.2 Kernel 兼容 profile

仓库新增自有 Python 模块，例如：

`assets/official-kernel-compat/rc01/paseo_model_compat.py`

它是一个深模块，只公开三个接口：

```python
SUPPORTED_NON_GEMINI_MODEL_IDS
is_catalog_model(model_id: str) -> bool
transform_request(model_id: str, body: dict) -> dict
```

实现集中负责：

- 三个已验证模型的 profile；
- CCPA metadata 对应的输出上限；
- `parametersJsonSchema -> parameters`；
- 递归移除 `$schema`；
- 为完整历史中的 `functionCall` / `functionResponse` 生成确定性配对 ID；
- GPT-OSS generation config 最小化；
- Gemini 和未知模型 identity fast path。

profile 只决定“本地转换能力”。模型还必须真实出现在当前账号 raw CCPA 目录中，才会进入 ACP catalog。因此同时满足：

`raw entitlement AND local compatibility profile`

### 3.3 对专有 runfiles 的最小 marker 修改

prepare 工具先校验目标源文件 preimage hash，然后执行无 fuzz 的最小 marker 修改：

1. `model_selection.py`
   - 注入一条对自有模块的 import；
   - 将 Gemini-only 判断改为调用 `is_catalog_model`；
   - 不新增 raw 目录没有的模型。
2. `ccpa_connection/proxy_server.py`
   - 注入同一自有模块 import；
   - 在取得 request model/body 后调用 `transform_request`；
   - 保留官方 token 注入、CCPA 调用和 response unwrap。
3. `server.py`
   - 必须保持官方 SHA-256，不修改。

仓库只保存：自有模块、pin、marker 规则和 patch orchestrator。marker 规则使用最小唯一字符串和目标 hash，不保存传统 diff 上下文。

### 3.4 本机 patch lifecycle

新增深模块 `OfficialKernelCompatLifecycle`，外部接口限制为：

```ts
prepare(options): Promise<PreparedKernel>
verify(options): Promise<VerificationResult>
activate(options): Promise<ActivationResult>
rollback(options): Promise<ActivationResult>
status(options): Promise<KernelCompatStatus>
cleanup(options): Promise<CleanupResult>
```

实现隐藏：

- 输入文件 regular-file/symlink/owner/mode 检查；
- PAR、external harness 和两个目标源文件 preimage hash；
- 官方 `--unpack_par_and_exit`；
- 兼容模块复制与 marker 修改；
- postimage hash；
- receipt schema；
- staging、fsync、atomic rename 和 symlink swap；
- single-writer lock；
- idempotency、previous/current、rollback 和 cleanup。

默认安装根：

`~/.local/opt/paseo-agy-acp-kernel-compat/`

目录必须为当前用户所有且 mode `0700`。内容寻址版本示例：

`rc01-46b592510090-compat-v1/`

receipt 为 `0600`，不得包含账号、token、cookie、prompt 或完整 CCPA 响应。准备后的 runfiles 设为只读/可执行的最小权限，避免误写。

### 3.5 显式 wrapper，不改变默认 spawn 语义

prepare 工具生成独立 wrapper。wrapper：

- 解析自身真实目录；
- 校验 receipt 与三个小型 patched 文件 postimage hash；
- 设置 `ANTIGRAVITY_HARNESS_PATH`、`PYTHONDONTWRITEBYTECODE=1` 和外部 host 所需 importer 环境；
- 执行 unpack 后的 `agy_acp_server --uid=`。

现有 `spawn.ts` 不负责 patch 发现。生产切换仍使用现有接口：

`PASEO_AGY_ACP_OFFICIAL_BIN=/absolute/path/to/generated-wrapper`

未设置该值或指向官方 wrapper 时，行为与当前 2.1.0.0 完全一致。

## 4. 安全与许可边界

硬事实：Registry 将 Antigravity binary 标记为 `proprietary`，仓库没有公开 server 源码。

本轮只允许：

- 用户已合法取得的官方构件在本机自解包；
- 用户本机生成、保存和运行 patched copy；
- 公开仓库保存自有兼容模块、hash 和本地 orchestrator；
- 明确标注 operator-applied、local-only、非 Google 官方修复。

本轮禁止：

- 上传或重新打包 patched binary/runfiles；
- npm 包含 Google 文件；
- 从工具自动抓取或转发凭据；
- 绕过 Google OAuth、entitlement 或 quota；
- 把技术可行性描述为 Google 已授权。

个人本地修改是否完全符合 Google 当前 ToS 仍属于法律不确定性。实现必须显式 opt-in，并在 Google 发布修复构件后优先退回官方版本。

## 5. 验收分层

### 5.1 确定性 CI

不使用真实 Google 构件或凭据：

- pin schema、hash mismatch、size mismatch；
- symlink、wrong owner、wrong mode、非 regular file；
- marker 缺失、重复 marker、preimage 不匹配；
- fake self-unpacker 的 prepare/verify/activate/rollback/cleanup；
- 注入失败时 `current` 不改变；
- double prepare 零写入；
- receipt mode 与内容脱敏；
- stale official hash 拒绝；
- 自有 Python compat 模块的 request transform golden tests；
- Gemini/未知模型 identity path；
- complex schema、双 `parameters*` 字段、深层 `$schema`；
- sequential/repeated/parallel tool-call ID fixtures；
- package manifest 确认不包含 proprietary artifacts。

### 5.2 隔离真实 kernel

使用临时 home、独立端口和 production fingerprint guard：

1. prepare 真实 RC01，并验证原始输入与 postimage receipt；
2. initialize/auth cached/session-new 原生 14 项；
3. 三模型最小文本推理；
4. Claude/GPT 两轮顺序工具；
5. warm resume 后目录、current model 和工具；
6. unknown model `-32602`；
7. 复杂工具 schema、并行/重复同名工具；
8. cancel、timeout、503/quota 分类；
9. MCP、支持的 media 输入；
10. wrapper SIGTERM/SIGKILL 与子进程清理；
11. 回滚到官方 wrapper 后目录恢复为官方行为，再重新激活 compat；
12. 测试结束后 production daemon fingerprint 和 `/tmp` 均不变。

### 5.3 配置驱动的并行验收

并行度从实际 policy 读取：

- `AGY_ACP_ADMISSION_MAX_ACTIVE_TURNS`
- `AGY_ACP_ADMISSION_MAX_CONCURRENT_STARTS`
- `AGY_ACP_ADMISSION_MIN_START_INTERVAL_MS`
- Paseo 当前 parallel queue 配置

`8` 只用于“默认值是否仍为 8”的单元测试，不作为上限。

每组配置验证：

- active lease 不超过配置值；
- concurrent start 不超过配置值；
- surplus 正确排队且位置推进；
- cancel/timeout/503 后 seat、payload 和 cooldown 正确回收；
- connector、kernel child 和 process group 退出后无资源泄漏；
- sanitized event journal 与 queue snapshot 能解释每次状态变化。

至少覆盖低并行、非对称 active/start、当前生产配置和高于默认值的配置。

### 5.4 受控本机生产切换

真实 apply 前必须新增独立 audit work package。通过后：

1. 记录但不泄露当前 wrapper、kernel hash、daemon fingerprint 和 Admission policy；
2. 保留当前 `/home/tiezbro/.local/bin/agy-acp` 可执行回滚副本；
3. 原子更新生产 wrapper 的 `PASEO_AGY_ACP_OFFICIAL_BIN` 到 generated wrapper；
4. 不改变并行队列配置；
5. 用新 Paseo agent 验证 14 项目录；
6. 对三个模型执行最低配额的文本 smoke；
7. Claude/GPT 各执行一个只读工具回合；
8. 验证 thought/final、stop reason、Admission journal 和进程回收；
9. 执行一次回滚演练并确认官方路径可恢复；
10. 重新激活 compat，完成最终生产 smoke。

## 6. 开发包与提交纪律

### P0 调研与计划

- 本文档与调查报告纠正。
- 独立 audit 通过后提交并推送。

### P1 Compat profile 与 Python transform

文件所有权：`assets/official-kernel-compat/**`、对应 fixture/tests。

验收：纯 transform、identity path、schema、tool ID、GPT generation。

### P2 Pin、patch lifecycle 与 CLI

文件所有权：新的 lifecycle/pin 模块、prepare CLI、fake unpacker/tests。

验收：hash、权限、atomicity、idempotency、rollback、stale refusal、receipt。

因涉及本机可执行构件和持久目录，必须有独立 security/audit work package。

### P3 Packaging 与显式 wrapper

文件所有权：`package.json`、package-content tests、wrapper template。

验收：npm tarball 不含 proprietary 文件；官方默认路径无行为变化。

### P4 隔离生产验收工具

文件所有权：新的 model parity probe、canary/stress 扩展、脱敏 evidence writer。

验收：动态 policy、真实 14 项、三模型、工具、resume、cancel、cleanup。

### P5 文档与操作手册

与当前工作区已有 README/文章改动协同，不覆盖用户内容。记录 opt-in、空间需求、风险、回滚和官方 takeover。

### P6 真实隔离验收

不提交 Google 构件，只提交脱敏 receipt/evidence 摘要。任何失败先回到对应开发包修复并重新质检。

### P7 本机生产 apply 与验收

先做独立 pre-apply audit，再修改外部生产 wrapper。完成后提交脱敏生产验收证据并推送。

每个开发包遵循：

1. 独立 worktree 和明确文件所有权；
2. implementation child 不 commit、不 push；
3. 独立 audit child 检查 spec、代码、安全、测试和范围；
4. FAIL 必须返工并复审；
5. PASS 后由顶层主控以 `tiezbro` 作者创建最小提交；
6. 立即推送 GitHub `origin`，确认 CI 和 Forgejo pull mirror；
7. 才能开始依赖该提交的下一包。

## 7. 停止条件

完成 P0-P7 后停在“本机生产修复已生效、验收证据齐备、具备发版条件”的状态。

本轮不执行：

- version bump；
- CHANGELOG release entry；
- tag / GitHub Release；
- npm publish；
- beta/stable release；
- Registry PR；
- patched Google 构件公开分发。
