# 历史 PR 回归核查

2026-11-21 对照 `maomomo-eth` 发起并合入的 8 个 PR，检查当前 2.9.2 工作分支。核查结合原始 PR 差异、合并后修改及现有行为测试；未合入的 PR #13 已由 #14 替代，当前 PR #24 作为修复交付入口。

## 逐项结果

| 历史 PR | 原修复行为 | 当前结果与证据 |
| --- | --- | --- |
| [#10](https://github.com/tiezbro/paseo-agy-acp/pull/10) | OAuth 链接及时显示、粘贴回调、仅允许本机 HTTP 回调 | 行为保留；`official-kernel.test.ts` 与 `login-stderr.test.ts` 验证回调和最终认证结果。 |
| [#14](https://github.com/tiezbro/paseo-agy-acp/pull/14) | 系统封套边界、carousel 展开、后台正文独立消息 ID | 边界及正文隔离保留；`system-message-*`、`carousel-unroll`、`message-identity` 回归覆盖分块、引用、围栏、取消与结束。后续版本明确将系统封套改为带 system 元数据的独立文本消息，当前继续保留该展示方式。 |
| [#17](https://github.com/tiezbro/paseo-agy-acp/pull/17) | stderr 授权提示、跨分块处理、避免重复回调 | 行为保留；`login-stderr.test.ts` 覆盖两个输出流及认证失败。 |
| [#18](https://github.com/tiezbro/paseo-agy-acp/pull/18) | 技能通过工具呈现，避免向工作区写入内置技能文件 | 确认回归：`f5d1546` 删除补丁和行为测试。本轮恢复补丁，保留新版步骤观察器，并补回执行配置方法及缺失标记拒绝测试。 |
| [#19](https://github.com/tiezbro/paseo-agy-acp/pull/19) | UTF-8、取消时序、连续轮次、动态上下文、MCP、安装锁与资源关闭 | 原有协议、上下文、MCP、技能读取和关闭测试保留；发现连续轮次新增竞态，见下文。Admission 专属代码与模型跟踪由 `e19d09f` 明确移除，当前保留直接派发设计。 |
| [#20](https://github.com/tiezbro/paseo-agy-acp/pull/20) | SQLite 争锁与锁定 Paseo 客户端契约 | SQLite 随 Admission 整体移除，没有现存争锁调用路径；不恢复已移除的调度。客户端精确锁、完整性校验和隔离安装仍保留，版本扩展至 0.13.2、0.14.0、0.16.0。 |
| [#22](https://github.com/tiezbro/paseo-agy-acp/pull/22) | 历史资料脱敏、89 条证据映射与只读校验 | 校验保留；当前 PR 已通过第二父提交保留冻结快照，供完整历史 checkout 验证。发布说明允许前置追加，冻结历史不变，完整文件仍扫描。 |
| [#23](https://github.com/tiezbro/paseo-agy-acp/pull/23) | 空白输出、会话关闭 token 隔离、三平台普通 provider、验收配置脱敏 | 内容形态与关闭竞态回归保留；动态上下文及技能权限在 close 失败后保留。配置筛选、脱敏和 finally 清理模块与原合并版本相同。三平台契约仍在 CI。Admission 身份策略随调度移除而退出产品路径。 |

## 本轮修复

### 技能文件自动生成

原修复 `e70d027` 在构建 harness 配置后设置 `SkillsConfig.TOOL`。`f5d1546` 将该编辑替换为步骤观察器编辑，官方内核因此恢复默认的文件呈现。当前同时保留模型目录、技能呈现和步骤观察器三项适配。

新增测试独立验证技能呈现标记缺失时拒绝发布；执行补丁后的 Python 配置方法，确认启用及禁用状态、用户技能路径、数据目录与模型配置保持原值。缓存测试覆盖“已有模型补丁但缺少技能补丁”的版本，要求重新准备内核。

这项兼容补丁仅覆盖托管 Linux x86_64 内核。直接指定其他官方可执行文件或其他平台下载包，不据此声称具有相同的技能呈现保护。修复不会删除工作区已有的技能文件。

本机还使用真实官方 1.5.0 内核做了前后对照：分别启动旧配方 `648d11fd65e2` 和新配方 `aad1b9cfe5d0` 的完整性校验包装器，以真实 Paseo 客户端身份执行 `initialize` 和 `session/new`，各自使用独立空工作目录。旧配方生成 `skills/system/run-workflow/SKILL.md`；新配方目录保持为空，两者均返回 6 个模型。未发送生成请求，也未修改用户原有技能文件。临时进程和本轮创建的测试目录已清理。这是本机验收，未纳入 CI。

### 连续轮次的旧收尾误伤新状态

PR #19 要求终态交付前释放会话占用，让客户端能立即开始下一轮。`f5d1546` 新增内核事件状态后，在异步 `finally` 中无条件按 session 清理状态。当客户端收到上一轮终态后立即发送下一轮，旧 `finally` 会清除新轮次的通知跟踪及失败围栏。

修复前的隔离复现中，第二轮已有明确失败围栏，却收到成功的 `end_turn`。现在只有仍持有该会话 claim 的轮次才能在异步收尾中清理；已收到内核响应的轮次在交付终态前同步清理。回归分别覆盖上一轮成功、取消、错误，并验证第二轮的 HTTP 503 通知和终止失败均保留。

### 交叉评审补强：本地取消后的同步续轮

GPT-6.1 与 Gemini 3.8 独立审查并交叉复核后，确认一项非阻塞 P3：尚未派发的 prompt 被本地取消时，两条路径均先输出 `cancelled`，再由 `finally` 释放 claim。同进程客户端在终态回调中同步发送下一轮，会被误判为已有活动 prompt；尚未证明真实 Paseo 外部 stdio 或 UI 可触发。

两条路径现在都在回包前按 claim 所有权同步清理取消计时器、事件与失败围栏，再释放 claim；旧 `finally` 使用相同所有权判断，不能清理下一轮。已派发请求仍等待内核取消回执，普通本地错误仍经过 `finally` 后交由外层回包。

新增三项回归分别覆盖上下文准备中取消、准备完成后派发前取消、上下文失败。在首轮终态回调同栈发送第二轮，确认首轮只交付一次终态、仅第二轮实际派发；额外重叠请求被拒绝后，第二轮的 HTTP 503 通知与终止失败围栏仍有效。

## 验证方式与范围

- 产品测试：`npm test -- --maxWorkers=1`。
- 架构与敏感信息：`npm run validate:architecture`、`npm run validate:secrets`。
- 配置筛选与清理：`node --test tests/paseo-live-config.test.mjs`。
- 锁定客户端：`npm run test:paseo-client`。
- 普通 provider：`npm run test:paseo-provider`；macOS、Windows 由 PR 的原生 CI runner 执行。
- 冻结证据：`node scripts/verify-repository-redaction.mjs`，需要可达的完整历史。

本轮本地验证结果：产品测试 44 个文件、374/374 项通过；客户端契约依次为 5/5、8/8、5/5；Linux provider 2/2；配置清理 4/4；架构、敏感信息扫描与全部 89 条脱敏映射通过。补强前首轮产品测试曾有一个既有脚本用例触发 1 秒请求超时，该文件单独复测 16/16、完整复跑 371/371 均通过；本次补强后的完整测试首轮通过，未放宽超时或断言。

隔离测试不代表官方账号模型生成、完整 UI 或其他平台官方内核的专项验收。生产 daemon 无需重启；旧进程仍使用其已加载的代码。首次准备新兼容目录可能需要数分钟，准备完成后再进行 provider 诊断。
