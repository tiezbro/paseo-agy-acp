# 官方 Google Antigravity ACP Agent（antigravity-acp）模型目录缺口调查

**日期**: 2026-08-28
**目标**: Registry id `antigravity-acp`（官方发布物 `agy_acp_server_20260818_01_RC01`）
**问题**: 官方 ACP server 的 oauth-personal 会话只列出 11 个 Gemini 模型，且对 `claude-sonnet-4-6` / `gpt-oss-120b-medium` 返回 -32602“not available for the current authentication method”；而同账号的 Antigravity IDE 与 agy CLI 能列出并调用 Claude Sonnet/Opus 与 GPT-OSS。
**方法**: 只使用第一方证据——官方 PAR 二进制内嵌源码、本机协议实探（只读、token 不落盘不出现在本报告）、官方 Registry（agentclientprotocol/registry）发布物/PR/提交/每日 protocol matrix、官方文档与 changelog、官方 CDN 直查。二手内容仅作线索，结论均回到第一方证据。
**合规声明**: 本调查未输出任何 token / OAuth secret / cookie / 账号 PII（OAuth client secret 存在于官方源码中，本报告一律不复述）。为确认凭据边界，仅检查了两个凭据文件的结构键名并执行不泄露值的布尔相等性比较；未显示或记录任何凭据值。未修改代码、README、AGENTS.md、任何配置或 daemon。临时探针进程已全部清理；官方探针进程自行执行过正常的 OAuth token 刷新。

---

## 0. 结论摘要（TL;DR）

1. **根因是官方 ACP server 内核的一行本地目录过滤**，与认证方式无关：
   `model_selection.py` 解析 CCPA `fetchAvailableModels` 响应时，`if not ccpa_id.startswith("gemini"): continue` 把非 Gemini 模型从目录中剔除（A1）。
2. **-32602 是服务端本地校验的产物，不是后端或认证拒绝**：`server.py` 的 `_apply_session_model` 在把模型 id 发给 CCPA 之前，先拿本地已过滤目录做白名单校验，未命中即抛出 -32602，错误文案 “not available for the current authentication method” 是误导性措辞（A2/A3）。
3. **差异不来自 OAuth client/scope 或 raw entitlement**：官方 ACP server 的 OAuth client id 与 scope 从 agy CLI 常量复制，CCPA 端点也属于同一族；凭据存储彼此独立。2026-08-28 的隔离探针已直接证明 ACP User-Agent 下的 raw CCPA 响应包含完整 14 项，包括 Claude 4.6 与 GPT-OSS；本地 `startswith("gemini")` 过滤才把它们删除（A1/A4/A5/§9）。
4. **initialize clientInfo/capabilities、session/new 参数、ACP protocol version 均不改变目录**：protocolVersion=1 回显；clientInfo 只进 User-Agent；差分 4 组均返回同一 11 项（A6 + 用户差分）。
5. **不是 ID 映射问题**：ACP 缺失的 3 个模型 id（`claude-sonnet-4-6`、`claude-opus-4-6-thinking`、`gpt-oss-120b-medium`）与 CLI/官方文档列出的一致，本地有 `if not startswith("gemini")` 过滤为证，是“目录漏报 + 本地拒绝”组合（A1/A2/B4）。
6. **官方发布物处于“未跟进”状态而非“并行落后”**：Registry 自 2026-08-20 合并 PR #542 后唯一提交，manifest 仍固定 `20260818_01_RC01`；dl.google.com 在可猜测命名空间内无更新构建；同一时期 CLI 已到 1.1.22、IDE 到 2.5.5，产品文档对 Claude/GPT-OSS 的可用性有明确表格，但**没有任何 ACP 对齐/parity 声明**（A7/B2/B3/B5）。
7. **“半残”的解释（按证据强度排序）**: ① 首发最小能力（RC01、registry 1.0.0、提交单日完成、OAuth client id 源码注释 “decision pending”）——有直接第一方证据；② ACP 表面刻意只暴露 Gemini（过滤是有注释的显式代码）——有直接证据；③ 第三方模型许可/ToS 动机——**纯推断，无任何第一方声明**；④ 独立 OAuth entitlement——**已被 raw CCPA 14 项直接否定**。
8. **能安全尝试的验证与伪修复**：见 §7。关键点：`AGY_ACP_DEFAULT_MODEL=claude-sonnet-4-6` **无法绕过**（已实测，OAuth 路径被 CCPA default 覆盖）；手改 settings.json、传 session/new 参数、换 token 均为伪修复。

---

## 1. 本地可复核事实（独立复核记录）

| # | 项目 | 结论 | 证据 |
|---|------|------|------|
| L1 | agy CLI 1.1.17 `agy models` | **14 项**：11 Gemini + `claude-sonnet-4-6`(Claude Sonnet 4.6 Thinking) + `claude-opus-4-6-thinking`(Claude Opus 4.6 Thinking) + `gpt-oss-120b-medium`(GPT-OSS 120B Medium) | 本机实测，2026-08-28（输出见 §3-E3） |
| L2 | 官方 build 标识 | `agy_acp_server_20260818_01_RC01`；`_version.py` 唯一版本串；`sha256` 见 PIN.txt（注册文件） | 官方 PAR 内嵌 `_version.py:3`；本地 opt 目录 `PIN.txt` |
| L3 | 官方 server `initialize` | protocolVersion=1 回显；agentInfo name=`antigravity-acp`/version=RC01；auth_methods=[oauth-personal, oauth-business, gemini-api-key, agent-platform]；capabilities={loadSession, auth(logout), sessionCapabilities(list,resume), promptCapabilities(image,audio,embeddedContext), mcpCapabilities(http,sse)} | 本机协议实探，2026-08-28（§3-E1） |
| L4 | `authenticate(oauth-personal)` | 成功（现有缓存凭据自动刷新，无交互） | 本机协议实探 |
| L5 | `session/new`（oauth-personal 认证后） | **11 项 model**，configOptions 与 legacy `models` 字段一致；currentModelId=gemini-3.7-flash-high；目录为**实时 CCPA 数据**（含静态表没有的 gemini-3-flash-agent/gemini-pro-agent/gemini-3.5-flash-extra-low） | 本机协议实探；与静态 `DEFAULT_MODEL_METADATA_MAP` 对照 |
| L6 | `session/set_config_option(model=claude-sonnet-4-6)` | `-32602` “Model 'claude-sonnet-4-6' is not available for the current authentication method.”，data.availableModels=11 个 gemini | 本机协议实探 |
| L7 | `session/set_config_option(model=gpt-oss-120b-medium)` | 同上 -32602 | 本机协议实探 |
| L8 | `session/set_model(model=claude-sonnet-4-6)`（legacy） | 同样 -32602（代码路径同 L6，`set_session_model` → `_apply_session_model`） | 主线程差分 + `server.py:2192-2216` 代码路径一致 |
| L9 | `AGY_ACP_DEFAULT_MODEL=claude-sonnet-4-6` 注入 | **无效**：session/new 仍 11 项 gemini、current=gemini-3.7-flash-high、set_config_option 仍 -32602。OAuth 路径 `_parse_ccpa_response` 用 CCPA 的 defaultAgentModelId 覆盖了环境变量指定值 | 本机协议实探（probe 2） |
| L10 | initialize 差分 | 默认参数 / `clientInfo={name,version}` / 自定义 capabilities 等多组差分 → 同一 11 项目录 | 主线程差分（4 组）；本机复现其中 2 组 |
| L11 | 原始 CCPA 响应捕获 | 隔离 runfiles 探针在 `_parse_ccpa_response` 过滤前，仅通过协议诊断字段输出模型 ID/公开 metadata；raw 目录为 14 项，明确包含 Claude Sonnet/Opus 4.6 与 GPT-OSS 120B。未输出 token、账号标识或 prompt | 见 §9 |
| L12 | 运行态 | 探针期间无其他 agy_acp_server 实例运行；`~/.gemini/antigravity-acp/` 存在 settings.json（49B，auth.type=oauth-personal，来自此前 canary）与 acp_token 文件（仅确认真实存在，内容未读） | `ps`、`ls`（文件名已脱敏） |
| L13 | 官方 zed 文档给出的 settings.json schema | `auth.type ∈ {oauth-personal, oauth-business, gemini-api-key, agent-platform}` + `gcp.{project,location}` —— 与源码 schema 完全一致 | 官方文档（§5-F4） |

---

## 2. 方法与本机环境边界

- 官方发布物为 Python zipapp（PAR，ELF launcher + 内嵌 zip，非 stripped，带 debug_info）。zip 内直接包含**未编译的 `google3` 源码**，因此无需 strings 反推——`model_selection.py` 等文件原样可读（这也独立确认了主线程“strings 可恢复源文”的判断，且更直接）。
- 本机 DNS 为沙箱 catch-all；`antigravity.google` 直连被沙箱拦截（curl/webfetch 均失败），改用 exa 服务端抓取官方页面；`github.com`/`api.github.com`/`raw.githubusercontent.com`/`*.googleapis.com`/`dl.google.com` 实测可达。
- 探针协议帧：NDJSON over stdio（官方 `acp` SDK `run_agent(use_unstable_protocol=True)`，`main.py:96`），JSON-RPC 2.0。
- 全部探针只读：服务端自行加载既有缓存凭据（OAuth 自动刷新属官方二进制自身运行时行为），客户端脚本从不接触凭据文件，也不输出任何 Authorization 内容。

---

## 3. 第一方证据链

### A 类：本机官方二进制（源码级，最强）

**A1. 目录过滤的根因（决定性）**
`PAR: google3/cloud/developer_experience/antigravity_extensions/acp_server/model_selection.py:149-205`（`_parse_ccpa_response`）：

```python
# Line 165-168:
for ccpa_id in ordered_model_ids:
    # Only include models that start with "gemini".
    if not ccpa_id.startswith("gemini"):
        continue
```

该函数先把 CCPA 响应的 `agentModelSorts` 拍平成有序 id 列表，然后**只保留 `gemini` 前缀的 id** 再对照 `models` 详情生成 ACP 目录。也就是说：CCPA 对消费者账号可返回的 claude/gpt-oss 模型在到达 ACP 客户端之前就被服务端本地丢弃。函数注释（122-148 行）与 `agentModelSorts`（“CCPA 从人工维护列表构建的策划优先级序”）说明目录本身是从后端动态来的，过滤是 ACP 侧叠加的二次过滤。

**A2. -32602 的抛出位置（决定性）**
`PAR: acp_server/server.py:2250-2280`（`_apply_session_model`）：

```python
# 2250-2257 注释（节选）:
# ...The OAuth branch of _create_agent_config forwards the id LITERALLY to the
# CCPA proxy ... so a synthetic id ... would 404. Reject an id that is not
# advertised for the active auth instead of building a doomed agent.
# 2258-2261:
available_models = self._list_available_models(model_selection.get_default_model_id())
valid_model_ids = {m.model_id for m in available_models.available_models}
if model_id not in valid_model_ids:
    # 2270-2280:
    raise acp_exceptions.RequestError(
        code=-32602,  # Invalid params
        message=(f"Model {model_id!r} is not available for the current authentication method."),
        data={"modelId": model_id, "availableModels": sorted(valid_model_ids)})
```

拒绝发生在**任何后端调用之前**：白名单 = 已被 A1 过滤后的 11 个 gemini。错误文案把“不在 [ACP 本地] 广告目录中”表述成“当前认证方法不可用”，实际与认证方法无关。

**A3. 同一函数同时服务 set_model 与 set_config_option**
`server.py:2192-2216`（`set_session_model`，注释“superseded session/set_model”）→ 直接调用 `_apply_session_model`；`server.py:2364-2365`（`set_config_option`，config_id=="model"）→ 同样调用 `_apply_session_model`。两条路径行为一致（L6/L7/L8 实测确认）。

**A4. OAuth client/scope 复用 CLI 常量，但凭据存储独立**
`PAR: acp_server/ccpa_connection/oauth_manager.py:39-55`：

```python
# The client ID and secret are copied from the Go Antigravity CLI constants
# (.../code_assist_client/constants.go;l=12-15...) and are used for internal
# testing purposes. A decision on the final client ID is pending.
_DEFAULT_CLIENT_ID = "1071006060591-…"      # 与 Go CLI 常量相同（后缀省略）
_DEFAULT_SCOPES = [cloud-platform, userinfo.email, aicode]
_KEYCHAIN_ACCOUNT = "antigravity-acp"       # 与 CLI 的 "antigravity" 区分，避免互踩
```

结论：源码明确声称复用 CLI 的 OAuth client 常量和 scope 集合，但凭据文件/钥匙串条目独立（`paths.py:59-60,121-123`：`~/.gemini/antigravity-acp/acp_token.json`）。这排除了“我们误用了另一组公开 client/scope”这一解释；源码本身不能证明 raw surface 同构，但 §9 的隔离捕获已经直接完成该证明。

**A5. CCPA 端点同一族**
`ccpa_client.py:37` `DEFAULT_CCPA_BASE_URL = "https://cloudcode-pa.googleapis.com"`；`onboard.py:16` `_PROD_DAILY_ENDPOINT = "https://daily-cloudcode-pa.googleapis.com"`——消费者 onboarding 会把端点解析到 daily-cloudcode-pa，与 agy CLI 此前实测使用的 `daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels`（旧调研 docs/research/antigravity-network-endpoints.md E2）为同一主机与同一 RPC。请求体消费者路径不带 location/entitlement（`ccpa_client.py:238-246`），与 CLI 一致。

**A6. initialize 不改变目录**
`server.py:2079-2161`：`protocol_version` 原样回显；`client_capabilities` 只缓存 `fs`；`client_info` 只用于 User-Agent 归属（`useragent.py:55-94`：`antigravity/acp/{version} (… host_path={client_surface}/{surface_version}; …)`）。`session/new`（`server.py:2701-2795`）模型目录唯一来源是 `_list_available_models(get_default_model_id())`（2745-2750），无协议参数可影响目录。

**A7. 无任何可启用 Claude/GPT-OSS 的官方通道（本 build 内）**
- 环境变量全集（源码 grep，`os.environ.get` 全量）：`AGY_ACP_DEFAULT_MODEL`、`AGY_ACP_ENABLE_OAUTH`（legacy，已发警告“不再选择认证方式”，`server.py:844-867`）、`GEMINI_API_KEY`、`GOOGLE_API_KEY`（agent-platform）、`AGY_ACP_CCPA_BASE_URL`、`AGY_ACP_CCPA_PROJECT`（仅 @google.com 内部账号）、`GEMINI_HOME`、`ANTIGRAVITY_HARNESS_PATH`、`OAUTHLIB_RELAX_TOKEN_SCOPE`（oauthlib 调试）——**没有**模型目录放宽开关。
- settings.json schema 仅 `auth.type` / `gcp.{project,location}`（`settings.py:44-46`），多余 key 直接告警忽略。
- `AGY_ACP_DEFAULT_MODEL` 在 OAuth 路径被 `_parse_ccpa_response` 的 CCPA `defaultAgentModelId` 覆盖（`model_selection.py:190-203`；L9 实测）。“Custom model” 自追加（`_finalize_model_state`，223-235）在 OAuth 路径因 190-203 的解析落不到非 gemini 值上，不会出现。
- `set_config_option` 值类型强制 string、`config_id` 白名单 model/mode（`server.py:2358-2372`）。
- 认证方法全集：`oauth-personal` / `oauth-business` / `gemini-api-key` / `agent-platform`（`server.py:647-653,2106-2132`）——四种方法下目录都经同一 `_parse_ccpa_response`（消费者/GE 路径共用，`model_selection.py:361-393`）或同一静态 Gemini 表（API key 路径，`model_selection.py:102-109`、`DEFAULT_MODEL_METADATA_MAP` 32-99，仅 11 个 Gemini）。

**A8. OAuth client 处于过渡态（源码注释）**
`oauth_manager.py:42-43`：client id “copied from the Go CLI constants” 且 “used for internal testing purposes. A decision on the final client ID is pending.” —— 官方对本次发布的工程状态自述，支持“首发/过渡”解释。

### B 类：官方 Registry 与 protocol matrix（第一方仓库）

**B1. 发布物 manifest 固定 RC01**
`agentclientprotocol/registry → antigravity-acp/agent.json`：`version: "1.0.0"`、`license: proprietary`、`website: https://antigravity.google/docs/ide/extensions`；五平台二进制 URL 全部指向 `agy_acp_server_20260818_01_RC01`（linux-x86-64 附 `args: ["--uid="]`；mac/windows 无 uid 参数）。启动参数全集 = 仅 `--uid=`（linux）。

**B2. 合并后无任何更新**
- PR #542 “Add Google Antigravity agent”：`created 2026-08-20T13:22:42Z`、`merged 2026-08-20T15:08:18Z`、`+40/-0`、仅 `agent.json` + `icon.svg` 两个文件。
- 该路径唯一 commit `a3d294f480`（2026-08-20T15:08:17Z）；此后仓库全量搜索 `agy_acp_server` 仅此一处。
- 该 PR 的 CI 为 manifest/单元类测试（`.github/workflows/tests/*`：build_registry/protocol_matrix/registry_utils/update_versions/verify_agents 共 5 个测试文件；`verify_agents.py` 属静态加载与启动校验——主线程观测到 121/121 全绿）；**不包含登录态模型目录断言**。

**B3. 每日 protocol matrix 从未覆盖登录态目录**
`.protocol-matrix/latest.json`（probedAt 2026-08-27T16:32:34Z）中 antigravity-acp 条目：
`initialize: success`、`protocolVersion: 1`、`agentInfoVersion: agy_acp_server_20260818_01_RC01`、`authMethods: ["agent"]`、`sessionNew: auth_required (-32000)`、`methodProbes: session/set_model → auth_required`、capabilities `{loadSession:true, sessionList:true, sessionFork:false, sessionResume:true, sessionStop:false, setModel:false}`、`setModelSignal: false`。矩阵跑批不登录 → `session/new` 只到 Authentication required，**模型目录在官方矩阵中从未被观测**，因此 11 项漏报不会被矩阵发现。

**B4. 官方文档中的模型枚举与 CLI 一致（ID 映射验证）**
- `https://antigravity.google/docs/models/`：模型表包含 `Claude Sonnet 4.6 (thinking)`、`Claude Opus 4.6 (thinking)`、`GPT-OSS-120b`，个人三档计划（Free/Google AI Plus/Pro/Ultra）✅，**Enterprise ❌**。
- `https://antigravity.google/docs/cli/headless/`：`agy models` 输出示例含 `claude-sonnet-4-6  Claude Sonnet 4.6 (Thinking)` —— 与 L1 实测、与 ACP 缺失的 id 完全同串。→ 不是 ID 映射/拼写问题。

**B5. 产品滚动与 ACP 发布物时序**
- CLI changelog（google-antigravity/antigravity-cli 官方仓库，raw 拉取）：最新条目 **1.1.22**（`/model <name>` 等）；**通篇无 Claude/GPT-OSS 出现**（第三方模型静默加入，无公告条目）。
- 官方 changelog 页（antigravity.google/changelog，经 exa 抓取）：Antigravity 桌面端 2.11.0 (2026-08-26)、2.10.0 (08-24)、2.9.1 (08-20)…（“New versions are rolled out gradually…”）；**无 ACP server 条目、无 ACP parity 声明**。
- IDE 版本 2.5.5：Google AI Developers Forum 官方人员回复（2026-08-14，“the latest version of Antigravity IDE is 2.5.5, while the VSCode OSS version is 1.107.0”）；AUR `antigravity-ide 2.5.5-1` 上游源为 Google 官方 CDN。与 ACP RC01（08-18 构建）同周，但注册表 08-20 合并后冻结。
- dl.google.com 直查：RC01 构件 HTTP 206（存在；与 PIN.txt 中官方 zip URL 完全一致）；猜测命名 `…_20260825_01_RC01`、`…_20260818_02_RC01` 均 404（在可猜测命名空间内无 hidden channel；猜测有限，见 §8-②）。

### C 类：二手线索（仅线索，不作结论依据）

- `joel-jcs/antigravity-acp`（GitHub，受 agy CLI 桥接项目）：自述“Google FAQ 点名 Claude Code/OpenClaw/OpenCode 通过第三方工具驱动 agy 属 ToS 违规模式”——提示三方模型在 ACP 表面可能另有政策考量，但属第三方转述，无第一方 ACP 声明。
- `tccpc/opencode-antigravity-auth`（GitHub，API 规格挖掘）：给出 `claude-sonnet-4-6 / claude-opus-4-6-thinking / gpt-oss-120b-medium` 的网关模型 id 表，与官方文档/CLI 一致，仅作 id 一致性旁证。
- `discuss.ai.google.dev` 帖子（2026-02）：模型身份/后台子代理使用 Gemini 的官方回复——“无论主模型选择如何，子代理自动使用 Gemini 模型” —— 与“ACP 面只用 Gemini”的产品取向有一致性，但非 ACP 直接证据。
- 第三方博客（sabaoon.dev 等）对模型阵容的公开梳理，仅佐证三方模型为高调特性（官方发布博客 2025-11-18 亦明确 “Access to Google's Gemini 3, Anthropic's Claude Sonnet 4.5 …, and OpenAI's GPT-OSS … offering developers model optionality”）。

---

## 4. 关键协议观测（脱敏实录，2026-08-28）

`initialize`（AUTH 前）：
```
protocol_version: 1
agent_info: {name: antigravity-acp, title: Google Antigravity, version: agy_acp_server_20260818_01_RC01}
auth_methods: [oauth-personal, oauth-business, gemini-api-key, agent-platform]
capabilities: [auth, loadSession, mcpCapabilities, promptCapabilities, sessionCapabilities]
```

`authenticate(methodId=oauth-personal)` → OK（非交互；缓存凭据自动续期）

`session/new`（cwd=临时目录, mcpServers=[]）→
```
models(configOptions == legacy models 字段，11 项):
  gemini-3.7-flash-high / -medium / -low
  gemini-3.6-flash-high / -medium / -low
  gemini-3-flash-agent
  gemini-3.5-flash-low / gemini-3.5-flash-extra-low
  gemini-pro-agent
  gemini-3.1-pro-low
currentModelId: gemini-3.7-flash-high
```

`session/set_config_option(configId=model, value=claude-sonnet-4-6)` →
```
code: -32602
message: Model 'claude-sonnet-4-6' is not available for the current authentication method.
data: {modelId: claude-sonnet-4-6, availableModels: [11 个 gemini id（升序）]}
```
`value=gpt-oss-120b-medium` → 同上。

`session/set_model(model=claude-sonnet-4-6)` → 同上（主线程差分）。

`AGY_ACP_DEFAULT_MODEL=claude-sonnet-4-6` 注入后重跑前述序列 → 目录/currentModel/-32602 完全不变（L9）。

对照组：`agy models`（本机 CLI 1.1.17）→ 14 项，含上述 3 个三方模型。

---

## 5. 六个问题的逐项裁决

### Q1 官方 ACP 构建是否落后于 IDE/agy？Registry 是否有新版/hidden channel？

**裁决：发布物“冻结”，非“落后”**。Registry 唯一版本 RC01（08-18 构建），08-20 合并后零更新（B2）；dl.google.com 猜测命名空间内无新构件（B5，404）；matrix 确认运行的就是 RC01（B3）。同期 CLI 推进到 1.1.22、IDE 推进到 2.5.5、产品功能持续滚动（B5）——ACP 发布物是**产品滚动中未被跟进的首发快照**。hidden channel 无证据：Registry 是 ACP 分发与版本声明的官方单一来源（Zed 官方文档明示 registry 为受支持安装渠道，§5-F4），且 code 内 build id 自洽（版本串/UA/矩阵一致）。
证据强度：B（一手，枚举有界）。

### Q2 oauth-personal 与 IDE/agy 是否不同 client/scope/product context？模型按 auth method 过滤？

**裁决：否，且已直接验证**。OAuth client id 从 CLI 常量复制（A4）、scope 集合相同（A4）、CCPA 端点族与 RPC 相同（A5）。隔离探针在 ACP User-Agent 下捕获到过滤前的 14 项 raw 目录，三项非 Gemini 与 CLI 完全一致；随后官方代码执行**本地 `gemini` 前缀过滤**（A1），才形成用户看到的 11 项。原始 -32602 仍发生在本地白名单校验，未触达模型后端（A2）。
证据强度：A。

### Q3 initialize clientInfo/capabilities、session/new 参数、ACP protocol version 是否改变目录？

**裁决：否**。protocolVersion=1 回显原值（A6）；clientInfo 仅进 UA（A6）；capabilities 仅缓存 fs（A6）；session/new 无模型相关参数（A6）；差分 4 组不变（L10）。ACP 客户端若要影响目录，唯一输入是 `AGY_ACP_DEFAULT_MODEL`——且实测失效（L9）。settings.json 无模型 key（A7）。
证据强度：A。

### Q4 Claude/GPT-OSS 是目录漏报、ID 映射问题，还是 set_config_option 阶段真实拒绝？

**裁决：目录漏报（本地）+ 本地校验拒绝，后端从未被触达**。漏报根因 = `startswith("gemini")` 过滤（A1）；拒绝 = `_apply_session_model` 对过滤后白名单的本地校验（A2），注释自证“在把 id 原样转发给 CCPA proxy 之前拒绝”（A2 2250-2257）。ID 映射无问题：ACP 缺失的 id 与 CLI、官方 headless 文档逐字一致（B4）。-32602 不是认证方法拒绝，措辞是误导（A2）。
证据强度：A（“后端从未被触达”由代码路径证明）。

### Q5 官方发布“半残”的合理解释（分别找证据）

| 假设 | 证据 | 判定 |
|---|---|---|
| 实验/首发最小能力 | RC01 命名；registry 1.0.0；PR 单日 +40 行；oauth client “decision pending” 源码注释（A8）；无矩阵登录态覆盖（B3）；无 changelog 条目（B5） | **直接证据支持（最强）** |
| feature rollout（分层放量） | 官方 changelog 页明示 “New versions are rolled out gradually…”（B5），但**无任何 ACP 相关 rollout 声明/公告** | 泛化表述，无 ACP 指向；不足以解释 |
| 第三方模型限制 | docs/models 表：Claude/GPT-OSS **Enterprise ❌ / 个人计划 ✅**（B4）——三方模型有计划的 entitlement 差异；CLI changelog 对三方模型完全沉默（B5）；C 类线索（ToS 桥接警告） | 存在 entitlement 事实，但**无 ACP 专属限制声明**；过滤作用于一切 plan（A1/A7），故不足以完全解释 |
| 独立 OAuth entitlement | ① docs 表个人计划含三方模型（B4）；② ACP 复用 CLI client/scope 并访问同端点族（A4/A5）；③ 隔离探针直接取得 ACP surface 的完整 raw 14 项（L11） | **已否定** |

综合裁决：**首发最小能力 + ACP 表面刻意 Gemini-only 的本地实现**是第一方证据可支撑的解释；第三方模型许可/ToS 动机是仅有的两条推断路径（过滤为何存在），无第一方声明，务必不上报为事实。

### Q6 能安全尝试的修复/验证，与伪修复

见 §7。

---

## 6. 硬编码事实 vs 推断（上报时务必区分）

**硬编码事实（第一方，可复现）**
1. 官方 ACP server 在任何 auth method 下，模型目录 = CCPA 响应 ∩ `startswith("gemini")`。（A1）
2. 对目录外模型 id 的任何 `set_model`/`set_config_option` 调用在本地返回 -32602，错误文案固定。（A2/A3）
3. ACP OAuth client/scope 常量复用 CLI 值并访问同一 CCPA 端点族；凭据存储独立。隔离探针进一步直接证明该账号的 ACP raw surface 返回完整 14 项。（A4/A5/L11）
4. initialize/clientInfo/capabilities/protocolVersion=1 不改变目录。（A6）
5. Registry 版本固定 RC01，合并后零更新；矩阵未登录态，未覆盖该行为。（B1/B2/B3）
6. 官方文档模型表个人计划含 Claude/GPT-OSS、Enterprise 不含；CLI/headless 文档 id 与 ACP 缺失者一致。（B4）
7. `AGY_ACP_DEFAULT_MODEL` 在 oauth-personal 下被 CCPA default 覆盖，不可作为绕过。（L9 + A1）

**推断（无第一方声明，禁止作为事实上报）**
I1. 过滤动机 = 第三方模型在 ACP（第三方编辑器可编程调用）表面的许可/ToS 顾虑，或首发 UI/entitlement 未就绪（纯推断）。
I2. -32602 文案属于误导性措辞而非刻意契约（推断：文案与实现不符是事实，意图不可知）。
I3. 官方会逐步对齐 ACP 目录与 CLI/IDE（无任何承诺）。

---

## 7. 能安全尝试的修复/验证 与 不能做的伪修复

### 可以安全尝试（不改配置/daemon/认证状态）
1. ✅ **协议重放**（本次已完成）：直接驱动官方 PAR 复现 11 项与 -32602，作为基线。
2. ✅ **原始目录观测探针**（已完成）：在官方 launcher 解包出的隔离 runfiles 中，于 parser 过滤前把模型 ID/公开 metadata 临时放入 ACP model description，再从 `session/new` 协议响应读取。没有代理 Authorization，也未落盘或输出 token、cookie、账号标识和 prompt。
3. ✅ **更新监视**：`gh api "repos/agentclientprotocol/registry/commits?path=antigravity-acp/agent.json"` + dl.google.com 命名探查（本文给出方法），在官方发布新 RC 后第一时间重放 L3-L7。
4. ✅ **对照基线**：`agy models`（CLI）与官方 docs/models 表随时复核目录差异是否收敛。
5. ✅ **如需三方模型，走官方支持面**：使用 agy CLI / Antigravity IDE（同账号可直接用 Sonnet/Opus/GPT-OSS）；或用第三方 ACP 桥（如 joel-jcs/antigravity-acp，注意其自述的 ToS 风险提示，属用户决策）。

### 伪修复 / 明确不可做
1. ❌ `AGY_ACP_DEFAULT_MODEL=claude-sonnet-4-6` —— **已实测无效**（L9）。不可对外宣称“可用环境变量绕过”。
2. ❌ 在 settings.json 中加 `model`/`models` key —— schema 白名单拒绝并告警（settings.py:44-46）。
3. ❌ 在 session/new 传模型参数 —— 协议无此参数，schema 严格校验（本调查实测缺失字段直接 -32602 拒绝）。
4. ❌ **只删除过滤并重打包 PAR** —— 隔离验证证明这不够：第三方模型还需要输出上限、tool schema、tool call id 和 GPT generation config 兼容；修改后的专有构件也不能冒充官方原件或随 npm 分发。
5. ❌ 复用 CLI 的 oauth token 文件给 ACP server —— 官方 ACP 自带独立凭据存储且拒绝异源凭据复用（本地 PIN.txt 已记录此发现），读取/搬运 token 也违反本调查红线。
6. ❌ 自建 OAuth client / 换账号 —— 过滤在服务端本地、与账号无关（A1/A7）；且不改变官方发布物行为。

---

## 8. 可上报的最小证据包（附：给 Registry 维护者/Google 的复现）

**标题建议**：`antigravity-acp (agy_acp_server_20260818_01_RC01): model catalog under oauth-personal omits claude-* / gpt-oss-* advertised to the same account via agy CLI — local gemini-only filter, misleading -32602 message`

**复现步骤**（全部第一方构件）：
1. 从 ACP Registry 安装 `antigravity-acp` v1.0.0（RC01），按官方 Zed 文档（Install from Registry → Search Antigravity → Install）启动。
2. ACP `authenticate(methodId="oauth-personal")`（同账号已通过 agy CLI 可用三方模型的个人 Google 账号）。
3. `session/new`（cwd 任意，mcpServers=[]）→ 观察 `configOptions/model.options` 仅 11 个 gemini id。
4. 对照：同一账号 `agy models`（CLI ≥1.1.17）→ 14 项，含 `claude-sonnet-4-6`、`claude-opus-4-6-thinking`、`gpt-oss-120b-medium`。
5. `session/set_config_option(configId="model", value="claude-sonnet-4-6")` → `-32602 Model 'claude-sonnet-4-6' is not available for the current authentication method.`

**证据行**（供维护者定位）：
- `acp_server/model_selection.py:166-168` —— 目录过滤根因（`startswith("gemini")`）。
- `acp_server/server.py:2250-2280` —— 本地白名单校验与 -32602 抛出点（在后端调用之前）。
- `acp_server/ccpa_connection/oauth_manager.py:39-55` —— client/scope 常量从 CLI 复制；用于排除 client/scope 配错，不用于声称 raw entitlement 必然相同。
- `acp_server/model_selection.py:32-109` —— 静态表（API-key 路径）亦仅 Gemini。
- Registry `.protocol-matrix/latest.json` —— 矩阵未登录，未覆盖该行为；建议矩阵增加登录态目录断言。

**期望行为**：ACP 目录与同账号 CLI/IDE 对齐（14 项），或在官方文档中明确声明“ACP 表面仅支持 Gemini 模型”。

---

## 9. 隔离补丁验证（不部署，2026-08-28）

验证对象是 RC01 官方 PAR 通过 `--unpack_par_and_exit` 产生的 `/tmp` runfiles 副本，并使用同一发行 zip 中、hash 与 PIN 一致的 `localharness_external`。原始 PAR、生产 wrapper、Paseo daemon 和认证配置均未修改；没有分发修改后的 Google 构件。

### 直接证据

1. parser 过滤前的 CCPA raw 目录为 **14 项**，包括 `claude-sonnet-4-6`、`claude-opus-4-6-thinking`、`gpt-oss-120b-medium`。
2. raw metadata 明确给出 `apiProvider`、`modelProvider`、`maxOutputTokens`、`thinkingBudget`、内部 `model` 与 `vertexModelId`。Claude 输出上限为 64000，GPT-OSS 为 32768。
3. 仅删除 Gemini 前缀过滤并不足以工作：RC01 仍以 `GeminiAPIEndpoint` 生成请求，固定 `maxOutputTokens=65535`，工具使用 `parametersJsonSchema` 且 function call/response 没有关联 ID。
4. 在独立副本中让 parser 只保留 raw 目录实际返回且兼容表支持的三个非 Gemini ID 后，`session/new` 稳定原生返回 14 项。把 `server.py` 恢复为官方 preimage 后，Claude 仍能选择并推理，证明 `_apply_session_model` 的动态目录校验已经足够，静态三模型白名单补丁是冗余的。
5. GPT reasoning 与最终内容分别使用 `agent_thought_chunk` 和 `agent_message_chunk`；此前探针递归拼接所有 `text` 才造成“thought 混入最终答案”的假象。

### 最小兼容补丁

- 在 `model_selection.py` 中只允许 raw CCPA 已公告且本地兼容 profile 支持的三个非 Gemini ID 保留在原生目录；不增加 raw 目录不存在的模型。
- 按 CCPA metadata clamp `generationConfig.maxOutputTokens`。
- 将工具 schema 的 `parametersJsonSchema` 转为 `parameters`，递归移除 Gemini `Schema` proto 不接受的 `$schema`。
- 为 `functionCall` / `functionResponse` 注入成对、确定性的 ID，使 Anthropic 转换能生成关联的 `tool_use` / `tool_result`。
- 对 GPT-OSS 删除不兼容的 Gemini generation 字段，仅保留其 32768 输出上限；medium reasoning 已编码在目录 ID 中。
- 保持官方 `server.py` 不变；不在 Paseo TypeScript proxy 中伪造 catalog overlay。

### 端到端结果

| 模型 | 纯文本 | 工具 / session |
|---|---|---|
| Claude Sonnet 4.6 | 原生 14 项目录后 `set_config_option → prompt → end_turn`，精确返回 `PATCHED_ACP_OK` | 同一 session 连续两次 `view_file`，精确返回两个未知 marker；warm `session/resume` 后仍为 14 项、current model 保持 Claude，并再次完成工具回合 |
| Claude Opus 4.6 Thinking | `set_config_option → prompt → end_turn`，精确返回 `PATCHED_ACP_OK` | 未单独测试工具 |
| GPT-OSS 120B Medium | 原生 14 项目录后 `set_config_option → prompt → end_turn`，最终答案包含 `PATCHED_ACP_OK` | 同一 session 连续两次调用工具并返回两个未知 marker；thought/message ACP 事件分离正确 |
| 不存在的伪模型 | N/A | `session/set_config_option` 仍返回本地 `-32602`，没有触达 backend |

结论：账号与 CCPA backend 确实允许官方 ACP 路径执行三种模型；RC01 缺少的是目录过滤修正和第三方 provider 请求兼容层。native 14 项目录本身可用，不需要 adapter catalog overlay。该实验足以证明可修复性，但尚不等于完整生产验收。

## 10. 剩余未知 / 生产缺口

1. **功能覆盖**：尚未完成冷进程 `session/load`、取消、MCP、图片/音频、写工具权限及真实 503/配额错误验收；warm `session/resume` 已通过。
2. **协议转换完整性**：顺序多轮和重复同名工具已通过；复杂 JSON Schema、同一步并行/乱序同名工具仍需契约测试。
3. **配置驱动并行与资源回收**：需按实际 Paseo parallel queue 与 Admission policy 组合测试，不能把默认值 8 当作上限；还需验证 cancel/timeout/503 后 seat、payload、cooldown、kernel child 和 process group 回收。
4. **许可与产品策略**：技术成功不等于 Google 明确授权修改/分发专有 ACP 构件；过滤动机仍无第一方声明。公开仓库只能提供本地 orchestrator、自有兼容模块和 hash，不能分发 patched Google artifact。
5. **dl.google.com 隐藏构建与更新时间表**：目录不可枚举，Registry 后续更新无公开承诺；唯一可观测信号是 registry 提交与 matrix 快照（§7-3）。
6. **Enterprise / API-key / agent-platform 路径**：未逐一实跑；docs 表显示 Enterprise 本就不含第三方模型。

## 11. 附：本机证据文件清单

| 文件 | 用途 |
|---|---|
| `~/.local/opt/agy-acp-server-agy_acp_server_20260818_01_RC01/agy_acp_server.par`（官方 zipapp；sha256=46b5…8b07） | 源码与实测对象 |
| `~/.local/opt/agy-acp-server-agy_acp_server_20260818_01_RC01/PIN.txt` | 此前 canary 记录（auth/模型数等） |
| `~/.local/opt/agy-acp-server-agy_acp_server_20260818_01_RC01/agy-acp-server-canary` | 官方 wrapper（`--uid=` 启动） |
| `agentclientprotocol/registry` → `antigravity-acp/agent.json`、`.github/workflows/*`（live 直达） | Registry 第一方证据 |
| `agentclientprotocol/registry/.protocol-matrix/latest.json` | 每日矩阵（2026-08-27 快照） |
| `google-antigravity/antigravity-cli` CHANGELOG（raw 直拉） | CLI 1.1.22 与三方模型沉默 |
| `antigravity.google/docs/models`、`/docs/cli/headless`、`/docs/ide/extensions/zed`、`/changelog`（exa 抓取，沙箱直连受限） | 官方文档 |
| 本机 `agy` 1.1.17 实测输出 | 14 项对照 |
| [ACP Registry issue #554](https://github.com/agentclientprotocol/registry/issues/554) | 已上报的最小复现与隔离验证 follow-up |

**隔离实验边界**：临时副本、patch 和探针位于 `/tmp/agy-acp-model-probe-20260828` 与 `/tmp/agy-acp-model-probe-full-catalog`；未部署、未修改原始安装或 daemon。仓库内只更新本报告并新增开发计划，没有加入 runtime patch 或 Google 构件。