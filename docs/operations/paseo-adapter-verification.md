# Paseo 适配器验收

本文区分自动契约验证与作者本地验收，记录 `2.7.1` 补丁准备范围。
以下跨主机结果均为**作者本地验收，未纳入 CI**；原始环境证据未公开，维护者尚未独立复现。
本地报告不是已验证的产品保证。作者本地验收使用源码提交
`37a278d`、Paseo `0.13.2` 和官方内核 `1.4.3`；2026-10-28（UTC+8）又以该提交加
Admission 事务争锁修补完成完整跨主机复测。
源码提交的本地观察不能直接视为 npm 发布包已经验证或已包含所有后续补丁。
测试依赖固定与 CI 信任边界见[真实客户端供应链说明](paseo-client-supply-chain.md)。

## 验证层次与当前结果

| 层次 | 使用的组件 | 已验证范围 | 范围限制 |
| --- | --- | --- | --- |
| 隔离自动测试 | 适配器、隔离内核、本地 MCP 服务 | 协议、技能资源、排队、取消与关闭 | 不使用 Google 账号或真实 daemon |
| 真实客户端契约 | 固定 `@getpaseo/server@0.13.2` 的 `ACPAgentClient`、隔离内核 | 新建、模型切换、许可、加载、恢复、MCP 透传 | 本地服务模拟远端工具 |
| 作者本地跨主机（未纳入 CI） | 两个 Linux VM、两个 Paseo daemon、官方内核及已登录账号 | Gemini / Claude 委派与两轮回传；Gemini 取消、禁用连接错误及重连后继续 | 作者报告修补版本轮零锁错误、零任务重试；未公开原始环境证据 |
| 尚待专项验收 | UI、双账号、其他系统及旧版本 | 见下文手工清单 | 不从上述结果推定通过 |

复现步骤、代理配置和实测记录见[跨主机端到端验收](paseo-cross-host-e2e.md)。

## 隔离自动验收

在项目根目录运行：

```bash
npx vitest run tests/official-kernel-observability.test.ts tests/official-kernel-lifecycle-integration.test.ts tests/official-kernel-capabilities-integration.test.ts tests/paseo-proxy-lifecycle.test.ts tests/official-kernel-smoke-script.test.ts
```

`official-kernel-lifecycle-integration` 启动真实 Node.js 子进程作为 fake kernel，通过管道运行代理的 NDJSON 协议，覆盖冷启动 `session/load`、`session/resume`、权限拒绝响应、等待权限时取消、进程退出和监听器清理。它不启动 Paseo daemon，也不访问真实账号。

`official-kernel-capabilities-integration` 进一步验证 proxy 的原生 context 能力协商与会话绑定、旧内核动态兼容路径，以及经 proxy 注册后的真实本地 MCP endpoint 读取技能资源。它也检查无 Admission 的取消和空轮次失败只产生一个准确终态诊断。

`official-kernel-observability` 使用可注入时钟检查排队节流、能力协商、旧客户端兼容和阶段耗时。`paseo-proxy-lifecycle` 覆盖排队反馈不会掩盖内核空轮次等代理行为。

`official-kernel-smoke-script` 启动严格校验握手的隔离内核，验证手动冒烟脚本发送的是 `clientCapabilities`，并与 Paseo 的文件和终端能力声明一致。

### 固定版本真实 Paseo 客户端契约

CI 在独立目录安装 `@getpaseo/server@0.13.2`，使用其真实 `ACPAgentClient` 运行以下套件。该依赖只用于测试，不加入产品依赖，也不启动 daemon 或访问 Google 账号。缺少依赖或版本不符会直接失败，不会跳过。

```bash
node scripts/verify-paseo-client-lock.mjs
npm ci --prefix tests/fixtures/paseo-client --ignore-scripts --no-audit --no-fund --registry=https://registry.npmjs.org/
npm run test:paseo-client
```

已有独立安装时，可将 `PASEO_COMPAT_CLIENT_ROOT` 指向能解析 `@getpaseo/server` 的安装根目录。测试仍严格检查版本为 `0.13.2`。

`paseo-client-compat.test.mjs` 通过真实客户端、适配器子进程和隔离内核验证新建会话、冷启动加载与恢复、历史读取、`session/set_model`、许可拒绝、等待许可时取消，以及关闭后内核和 MCP 资源释放。

跨主机用例使用本地 MCP 测试服务模拟远端委派工具，验证工具目录、目标主机参数、认证头、会话头、查询参数和协议版本降级。它验证适配器的透传边界，不证明真实的多主机连接或远端 agent 已完成端到端验收。

上述自动测试不证明真实 UI、官方内核或账号隔离已经完成端到端验收。作者报告的真实 daemon 与官方内核本地跨主机观察单独记录在指南中，未纳入 CI；完整 UI、双账号隔离、Paseo `0.12.0` 和其他操作系统仍待验收。

## 排队反馈与诊断

客户端在 `initialize` 中声明 `clientCapabilities.session.notices: {}` 时，排队与执行提示使用 ACP v1 `session/update` 的 `notice`，带 `severity: info`、标题和说明。未声明时使用 `agent_thought_chunk` 兼容旧客户端。反馈只描述实际已知状态，不算作官方内核输出；内核未输出内容的空轮次仍应报错。

排队等待时间来自 Admission 的快照。重复状态默认每 5 秒最多更新一次，队列位置或执行状态变化可以立即更新。没有新等待时间的相同快照不重复发送。

在 provider 的环境变量中设置 `AGY_ACP_DIAGNOSTICS=1` 可启用结构化 stderr 诊断，默认关闭。记录阶段、相对耗时及经过散列的请求和会话关联 ID；不记录 prompt、令牌、headers 或用户正文。stdout 保持 ACP NDJSON。诊断开关变更后运行 `paseo reload` 并启动新 agent。

## 真实 Paseo 手工验收

先用 `paseo-agy-acp --doctor` 查看只读 JSON 安装状态；只检查本地内核可执行文件及托管内核收据，`ready: false` 时退出码为 `1`。认证和 daemon 状态明确为 `not_checked`，不会登录、下载或启动内核。需要安装或校验托管内核时，显式运行 `paseo-agy-acp --prepare-kernel`；正常协议启动应保持 stdout 为 NDJSON。

按当前 [Paseo 自定义 provider 文档](https://paseo.sh/docs/custom-providers) 修改 provider 后运行 `paseo reload`。修改对后续启动生效，已有 agent 进程继续使用启动时配置。无需为应用 provider 配置一律重启生产 daemon。

在明确授权的测试环境中依次验证，并保留实际版本、命令和结果：

1. 创建新 agent，再加载和恢复已有会话，确认 workspace 与会话 ID 正确。
2. 发起需要工具许可的请求，选择拒绝，确认请求收敛且未执行工具。
3. 再发起请求，在等待许可和排队时分别取消，确认没有后续执行或永久等待。
4. 用两个独立 provider 登录目录检查账号隔离；不要读取或展示凭据。
5. 创建包含 `SKILL.md` 和资源文件的测试技能，让内核实际读取正文与资源，核对返回内容；仅看到 slash command 不算读取验收。
6. 修改 provider 环境，运行 `paseo reload`，检查新 agent 生效、已有进程不被意外修改。
7. 关闭测试 agent，检查代理、内核及 MCP bridge 资源释放。

作者报告 2026-10-27 曾在本地独立测试 daemon 中覆盖真实跨主机创建、后续消息、运行中取消、provider 代理环境热加载、连接恢复及关闭清理。两轮结果通过 VM 上的随机标记和实际文件独立核对；取消测试还确认了测试子进程退出。

上述清单中的冷启动加载与恢复、许可拒绝、等待许可及排队时取消、双账号隔离、真实技能资源读取和 UI 操作仍需专项验收。跨主机运行中出现过 ACP `database is locked`（`-32000`），重试后恢复。后续已复现并修复适配器 Admission 的延迟事务升级写锁竞争；入队、激活、结算三项回归测试在旧实现下均失败、修补后通过。2026-10-28（UTC+8）的修补版完整复测还覆盖了真实隧道断开、自动重连及同一远端代理续跑，两端日志零锁错误、零轮次失败，Admission 无失败或待恢复状态，任务未重试；详见[锁错误排查](paseo-cross-host-e2e.md#database-is-lockedadmission-事务争锁)。本次使用独立 A 端 daemon 和专用 VM，生产 A 端 daemon 配置未修改。

取消已派发的请求后，默认最多等待内核确认 30 秒；可用 `AGY_ACP_CANCEL_TIMEOUT_MS` 配置正整数毫秒超时。内核不确认、输入 EOF 或流错误会进入关闭流程，先发送 SIGTERM，2 秒后仍未退出则发送 SIGKILL。

## 托管内核安装恢复

安装使用托管内核目录同级的 `.install-lock` 锁目录；回收死 PID 时还使用 `.install-lock.reaper` 互斥目录。等待安装锁最多 180 秒，下载最多 120 秒，解压最多 60 秒。已确认 owner PID 不存在时可自动回收。owner 缺失、损坏或 reaper 崩溃后残留时保持 fail-closed；超时后应先确认没有活跃安装进程，再手工清理对应锁目录，不能把未知 owner 当成死进程。

下载在独立 stage 中完成 SHA 和 pins 校验，再通过目录 rename 提交。成功后只清理旧空目录；非空旧目录保留为随机 `.install-*.previous` 路径，并在 stderr 提示，留待人工检查。

## Daemon context 的两种模式

默认模式使用既有封套逐轮桥接 daemon context，保留运行中修改和删除 context 的语义。原生模式只传递 daemon 原文。设置 `PASEO_AGY_ACP_NATIVE_SYSTEM_CONTEXT=1` 后，仅在官方内核明确声明 `agentCapabilities._meta.antigravity.systemPrompt.append: true` 时使用原生 system context；旧内核继续兼容路径。

原生模式在新建、加载或恢复会话时捕获固定快照。之后修改 context 需要重新加载会话；provider 环境变量变更则先运行 `paseo reload` 并启动新 agent。两种重新加载操作的作用不同。
