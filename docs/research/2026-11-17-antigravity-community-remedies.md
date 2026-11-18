# Antigravity 慢请求、静默中断与思考可见性：社区方案核验

调查日期：2026-11-17 America/Los_Angeles；公开页面状态核验至 2026-11-18 UTC。
范围：官方文档、官方 GitHub release/issue/讨论、oh-my-pi 的公开 issue/PR，以及本机已冻结的运行证据。不是互联网所有讨论的穷尽枚举。主控复核并整理下列可追溯来源；没有把尚未核实的论坛猜测纳入结论。

> 后续核验更新：独立 `agy_acp_server` 的Registry当前版本为1.5.0，官方归档已下载并校验SHA-256摘要；本机仍是1.4.5。优先路线改为评估同产品线1.5.0升级，CLI1.5.10仅保留后备对照。详见 `2026-11-17-kernel-150-adapter-repair-plan.md`；下表的本机基线仍有效。

## 先明确适用版本

| 对象 | 本次核验 | 适用边界 |
| --- | --- | --- |
| 本机 paseo-agy-acp | 2.8.1，HEAD d5258a1 | 当前实际适配器 |
| 本机独立官方内核 | agy_acp_server 1.4.5 | 当前生产链路，不等于 CLI 1.4.5 |
| Google Antigravity CLI | 最新 release 1.5.10，published_at=2026-11-17T05:41:11Z | 2026-11-16 21:41:11 PST；CLI 自 1.5.0 提供 agy acp，是隔离比较候选，尚未替换本机内核 |
| Paseo | 本轮运行基线 0.16.0 | 不能把本报告当作已完成客户端升级或修复 |

CLI 1.5.10 release [S1] 与 changelog [S2] 已核实。相同版本数字不能跨独立 ACP、CLI、IDE 混用；本轮没有证明新 CLI 与现有权限、工具桥、会话恢复及兼容补丁完全等价。

## 本机已有证据

详情见同目录 `2026-11-17-task-latency-interruption-diagnosis.md`：

- 指定 Agent ba59e0fa 的冻结窗口中，Admission 仅 6ms；13 次模型生成合计 609.874s，13 次工具执行合计 4.089s。两次隐藏 502 后恢复，不能叫进程崩溃。
- 冻结的 14 个近期会话中 11 个出现 HTTP 错误；错误步骤含 57 条 502、19 条 503、1 条 429。这不是任务失败率或供应商总体故障率。
- Agent 781499a6 原生记录最后是应展示的 429 `Individual quota reached`，但 Admission completed，Paseo 重放只有用户输入和一次 Read。错误丢失的具体边界尚需同轮原始 ACP 帧确认。
- 较新的独立思考快照包含 14 个会话、1027 个 planner_response，thinking/raw_thinking 全空；指定会话此次为22条。不能与前一冻结窗口混算。详见 `2026-11-17-antigravity-thinking-visibility.md`。

## 公开报告与真实修复状态

| 来源 | 日期、版本、核验时状态 | 观察／修复 | 对本机的意义 |
| --- | --- | --- | --- |
| 官方仓库 #1246 [S3] | 2026-10-14；CLI 1.3.5；Open | 用户报告 hi 耗时2–5分钟，Flash low/medium/high均有503和等待 | 与本机表现相近；是用户报告，不能独自证明本机502来自哪一跳 |
| 官方仓库 #1300 [S4] | 2026-10-20；CLI 1.3.14；Open | 用户日志有503、约5分钟stream idle timeout；另有60秒流空闲超时日志 | 说明超时与服务不可用可能叠加；不能把它当作本机独立内核已确认的超时配置 |
| 官方仓库 #1018 [S5] | 2026-09-14；最初CLI1.2.2；Open | 最初额度耗尽反复重试至print-timeout，exit0；作者10月1日在1.2.14复测6.8秒结束、exit3、仅1条error_message，主症状消失 | 这是已有社区复测的历史改善；作者推测1.2.13修复但未bisect，仍提出retryable:true可疑。不能只引用旧报告声称今天未修 |
| 官方仓库 #1570 [S6] | 2026-11-15；主体1.5.9、评论复现1.5.8；Open | ACP provider失败后用普通agent_message_chunk输出错误，再返回end_turn；客户端误判成功 | 与本机错误语义问题高度相关，但传输丢失机制是否相同仍待核验；新CLI并不天然保证解决此问题 |
| 官方仓库 #1581 [S7] | 2026-11-16；CLI1.5.9；Open | 用户报告ask_question未完成时session/load，后续回答问题的prompt出现无回复end_turn | 特定交互／恢复路径，不能当成本机所有空结束的原因；无已发布、明确针对该issue的修复证据 |
| 官方仓库 #1309 [S8] | 2026-10-21；独立agy_acp_server1.4.1；Open | 独立JSON-RPC测试：Gemini3.8 Flash/high，正文103个chunk、思考0个 | 与Paseo无关的独立复现线索；旧版本报告不证明本机1.4.5没有发送代码 |
| OMP #19319 [S9] | 2026-11-15；omp18.20.2 / agy1.5.9；Open | 作者A/B：简短提示成功、完整工具描述请求429；重试文本又被误判为thinking loop | 社区个案及作者归因，未在本机复现；不能用它推翻本机明确的Individual quota reached，也不建议据此删安全提示 |
| OMP #19388 [S10] | 2026-11-16；omp18.20.3 / agy1.5.9；Open | 作者称额度UI有余额；短标题生成成功、主请求429；重试提示作为assistant文本出现 | 第二个客户端侧观察；UI额度不等于已排除所有限流、服务端策略或计量差异 |
| OMP PR #19382 [S11] | 核验时Open、未合并 | 提议将CLI输出的额度错误转为429 provider failure，避免普通成功回复 | 可参考目标语义，不能称为已发布修复；也不应把任意模型文本正则直接当本项目可信错误来源 |

社区报告的存在、状态和具体用户日志是可核验事实；报告作者对服务端容量、账户路由、提示词指纹等原因的解释仍是其推断。论坛参与者的回复不能在未确认身份时称为Google官方结论。

## 官方1.5.10有哪些直接相关改动

已发布的release [S1] 记载：

1. 区分临时速率／容量等待与硬额度问题：模型要求的等待不超过4分钟时允许重试；spend-cap、prepaid-balance、weekly quota错误立即停止。4分钟是支持的单次重试等待范围，不是整轮最大预算。
2. 高思考响应静默超过5分钟时，旧行为会取消并从头重启；现在等待10分钟才判定静默响应停滞。这是避免误取消，不是把真实生成延迟降到10分钟以内的保证，更不是建议把所有超时一律加倍。
3. agy acp 在轮次结束后被后台任务／子任务唤醒时，会及时转发回复、工具和权限请求；取消／关闭时也处理残留后台任务。这只对涉及这些场景的任务有直接意义。

历史changelog [S2] 还记录CLI1.4.5支持展开thoughts、1.4.6展示重试次数／倒计时、1.4.11区分error/interrupted/print_timeout、1.5.0新增agy acp。它们说明已有产品处理思路，不构成独立ACP1.4.5已经包含这些修复的证据。

## 可执行方案与验收

| 优先级 | 建议 | 依据与验收 |
| --- | --- | --- |
| P0 | 可信终止错误穿透到Paseo，并区分成功／失败／用户取消 | 对照本机781499a6及[S6]。从SDK/内核结构化事件取错误；即使先执行过工具，后续模型失败也不能仅因sawVisibleOutput=true而完成。不要要求所有成功轮次必须有最终文字。验收应包含工具后429、无工具失败、用户取消、正常工具结束 |
| P0 | 重试可见并有总预算 | 对照本机隐藏502及[S1][S2][S3]。展示错误类别、尝试次数、下次等待、已用时间及停止原因。临时限流按可信retry delay退避，硬额度停止；只延长超时会延长无反馈等待 |
| P1 | 对CLI1.5.10进行隔离对照，而后再决定迁移 | 同账户／模型、固定简短提示和工具任务，交错比较当前独立内核与新CLI，记录首输出、总耗时、重试、终止语义。握手成功不能替代真实推理成功。另验权限、取消、恢复、MCP工具和本地兼容补丁 |
| P1 | 补全模型阶段观测 | 单独记录Admission等待、模型请求、重试退避、工具执行、最终停止原因。已有610s对4s的证据说明优化shell不是当前最主要方向；仍需同轮原始帧定位错误到底在哪层丢失 |
| P1 | 思考摘要逐层对齐 | ACP支持agent_thought_chunk [S12]；本机内核和Paseo已有代码路径。抓同轮原生thinking_delta→ACP事件→timeline。若上游为空，展示真实运行阶段；不伪造推理。API的摘要开关不代表Antigravity开放同名配置 [S13] |
| P2 | 再减少简单任务决策轮数，做思考档位／MCP负载对照 | 仅作为性能实验。不能预设low必然修复503，也不能把OMP提示词个案当本机根因；本轮未执行这些在线对照 |

## 仍未解决的缺口

- 未定位本机502来自Google后端、中间代理还是网络；公开相似报告无法替代同轮请求证据。
- 未确定最终原生错误丢在SDK流、ACP实时映射还是历史重放；新CLI的类似问题仍Open。
- 原生持久化思考为空不严格等于实时流从未包含摘要；缺同轮原始帧证据。
- 未找到可直接、无兼容验证地替换现有独立内核的已验证修复包；也没有本机迁移后的运行结果。
- 未实施代码修复、生产升级、模型推理探针、daemon重启或发布。仓库产出仅研究文档；委派的健康记录与产品修复不同。

## 来源

- [S1] https://github.com/google-antigravity/antigravity-cli/releases/tag/1.5.10
- [S2] https://github.com/google-antigravity/antigravity-cli/blob/main/CHANGELOG.md
- [S3] https://github.com/google-antigravity/antigravity-cli/issues/1246
- [S4] https://github.com/google-antigravity/antigravity-cli/issues/1300
- [S5] https://github.com/google-antigravity/antigravity-cli/issues/1018
- [S6] https://github.com/google-antigravity/antigravity-cli/issues/1570
- [S7] https://github.com/google-antigravity/antigravity-cli/issues/1581
- [S8] https://github.com/google-antigravity/antigravity-cli/issues/1309
- [S9] https://github.com/can1357/oh-my-pi/issues/19319
- [S10] https://github.com/can1357/oh-my-pi/issues/19388
- [S11] https://github.com/can1357/oh-my-pi/pull/19382
- [S12] https://agentclientprotocol.com/protocol/prompt-turn
- [S13] https://ai.google.dev/gemini-api/docs/thinking （核验时重定向至AI Studio Interactions API页面，使用thinking_summaries；不等同于当前Antigravity配置接口）
