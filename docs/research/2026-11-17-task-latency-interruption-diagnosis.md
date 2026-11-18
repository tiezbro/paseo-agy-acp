# 2026-11-17 paseo-agy-acp 任务慢与中断诊断

## 结论

存在两组已证实的问题：模型链路频繁出现 502/503，个别任务还遭遇 429 额度耗尽；运行状态与错误展示又没有完整反映底层结果，形成长时间静默运行、无回复结束的体验。不能把全部耗时归因于适配器启动、Admission 排队或 shell 执行。

本轮只做调查，不修改产品代码、生产配置或运行任务。未执行新的模型推理探针，未重启 daemon，未提交或发布。

## 基线与证据范围

- 工作树 `/home/tiezbro/projects/paseo-agy-acp`，HEAD `d5258a1`，调查前跟踪文件干净。
- 实际 daemon：`srv_2sMjq2mQzK4x`，宿主机 `H007-tiezbro-dev`，独立运行的 Paseo `0.16.0`。
- 实际入口 `/home/tiezbro/.local/bin/agy-acp`，安装包 `/home/tiezbro/.local/opt/paseo-agy-acp-2.8.1/node_modules/paseo-agy-acp`。
- 活跃兼容内核：`/home/tiezbro/.local/opt/paseo-agy-acp-kernel-compat/releases/1.4.5-7e7019c8989c-compat-v1-75d81ff43f2a-083ba3f99cb3`。检查了该版本实际 server.py 与原始 1.4.5 归档一致。
- 取按最近用户输入/创建时间排序的 14 个 paseo-agy-acp 会话，含多轮任务；不能将会话创建到归档的跨度当成单轮执行时间。
- 冻结步骤范围存于 `/tmp/agy-diagnose-evidence.json`；分析期间活跃任务仍会产生新步骤，本文不是最终任务完成状态。
- 原生记录：`/home/tiezbro/.gemini/antigravity-acp/conversations/<sessionId>.db`，以 SQLite 只读连接读取，并用实际内核的 `trajectory_pb2.Step` 解码。
- Admission：`/home/tiezbro/.local/state/paseo-agy-acp/production-official-8/official-kernel/runtime.sqlite`，只读。
- Paseo 活动：`get_agent_activity` / `paseo logs`；daemon 日志 `/home/tiezbro/.paseo/daemon.log`。
- GitNexus 已本地重新索引成功，但 MCP 仍报告落后 50 个提交，因此图查询仅导航，结论以实际源码和安装产物为准。重索引自动改写的 AGENTS.md 已恢复，未留下规则修改。

## 指定案例：ba59e0fa-af92-4ea4-b62b-2f996ce6ad92

任务：安装 logo-design skill。模型 `gemini-4-argon-high`；原生会话 `81c2af28-83c2-442c-bc59-7808f7da5695`。

以下时间均为 UTC；对应用户所在 America/Los_Angeles 的 2026-11-17 下午。

| 事件 | 时间/耗时 |
| --- | --- |
| 入队 | 2026-11-18 01:22:55.807 |
| 获得 Admission 执行席位 | 01:22:55.813，等待 6 ms |
| 原生用户输入 | 01:22:55.939 |
| 最后一次工具输出（首次调查看到的） | 01:31:55.963 |
| 第一次隐藏重试错误 | 01:33:36.884，HTTP 502 |
| 第二次隐藏重试错误 | 01:36:39.619，HTTP 502 |
| 随后继续读取文件 | 01:37:55.846 |

截至冻结的 idx=28，约 15 分钟跨度：13 个 planner response 的 `created_at → finished_generating_at` 合计 609.874 秒；13 个工具的 `started_at → completed_at` 合计 4.089 秒。工具参数生成属于前者，不能误算为工具执行。错误与下一次恢复之间还有约 4 分 44 秒间隔；这是失败请求/重试相关的墙钟等待，不能细分成纯退避 sleep 与网络等待。

两次原生错误均包含 `Error 502 ... Failed to connect to backend API`，模型侧说明为 `The model is currently unreachable.`，并且 `should_show_user=false`。所以用户看不到重试，但任务后来确实继续了。这段现象是静默重试，不能报告成进程已崩溃。

模型还进行了多轮路径搜索、save_skill、目录复制和脚本检查。多轮决策叠加每次几十秒乃至约 116 秒的生成等待，会放大简单任务的总耗时；这些动作不能全部归为 shell 卡顿。

## 近期样本

14 个会话里 11 个出现 HTTP 后端错误。按原生 ERROR_MESSAGE 步骤计，共识别 57 条 502、19 条 503、1 条 429。该统计不是失败任务数，也不是供应商总体故障率；恢复成功的会话也可能包含重试错误。另有未计入上述 HTTP 分类的错误步骤。

| Agent 前缀 | 任务 | 观察 |
| --- | --- | --- |
| ba59e0fa | 安装 logo-design | 冻结范围内 2 次 502，恢复后继续读文件 |
| 781499a6 | B4a1 详情布局归一化 | 5 次 502、1 次 503，最终 429；只做了 1 次读文件 |
| b1420cc4 | B3 行模型 | 5 次 502、6 次 503；记录取消，不能认定为自发崩溃 |
| 17d6f972 | B5 catalog / Argon medium | 5 次 502、6 次 503；记录取消 |
| 5f1ef999 | B5 catalog / Argon high | 16 次 502、3 次 503，多轮会话 |
| 8eb7af20 | Git 面板数据适配 / Flash | 2 次 503，说明不局限于 Argon |
| 4575038f | hello | 无工具、未记 HTTP 错误；Admission 单轮约 107.3 秒，原生生成约 105.4 秒 |

当前模型选择与历史请求实际模型可能不同。例如 hello 的 Admission 请求是 `gemini-4-argon-medium`，不能以后来状态中的 high 替代历史模型。

## 错误结束与完成状态不一致

`781499a6-40f2-4c39-a81c-961f19f5276f` 原生会话 `6a63ac2c-85be-482e-9d6a-7a5e1af18d98`：

- Admission 入队至 terminal 约 763.804 秒（12 分 44 秒），最终 state=`completed`。
- 最终原生 idx=9 是 ERROR_MESSAGE，`should_show_user=true`，HTTP 429，包含 `Individual quota reached` 和当时的重置倒计时。
- Paseo 活动重建只显示用户任务和一次 Read，没有最终答复或额度错误说明。
- 这是历史额度事实，不能据此断言账户现在仍无额度，也不能由此解释其他会话所有 502。

只读复核命令：

```bash
python3 /tmp/paseo-agy-acp-diagnosis-20261117/check.py --check
```

已执行并返回 AssertionError：原生可见终止错误与 Admission completed 并存。此检查重放历史证据，证明观察到的状态不一致；它不是新一次在线故障复现，也不能用旧数据库证明将来修复已通过。

## 对应代码缺口

1. `ACP Connector/official-kernel/errors.ts:13` 将 tool_call / tool_call_update 视为可见输出；`:36` 的空轮次保护只检查“完全没有可见输出”。实际安装包验证：一次 tool_call 后，`shouldRejectBlankTurn({stopReason:'end_turn'}, true)` 返回 false。该保护不会发现“读过文件、模型随后失败、没有最终回复”的情况。不能简单要求所有正常轮次必须有文字，应识别真实终止错误。
2. `ACP Connector/official-kernel/proxy.ts:495` 在任意可见工具输出后设置 `sawVisibleOutput=true`；`:618` 才检查上述空轮次条件。
3. `ACP Connector/official-kernel/proxy.ts:424` 附近只在 JSON-RPC failure 时抛出 `officialResponseError`；其余响应除 cancelled 外统一映射为 end_turn。结构化 failure 的分类逻辑本身存在，但不会自动识别隐藏的原生错误。
4. 官方 1.4.5 `server.py:5817` 附近把部分 SDK 异常转成普通 assistant 文本；`:5909` 默认 stop_reason=end_turn；`:6069` 等位置主要处理工具失败和 MODEL→USER 文本，没有完整的 retry/error 状态展示通道。结合原生错误的隐藏标志，能够解释重试期间没有通知；历史终止错误到底丢在 SDK 流、ACP live 转换还是历史 replay，尚需同一轮原始 ACP 帧来完全划清。
5. `ACP Connector/official-kernel/proxy.ts:254` 是取消后的 30 秒确认超时，不能误称为正常请求超时。当前 prompt 路径等待内核响应，未见对应的有界静默重试策略。
6. `ACP Connector/official-kernel/observability.ts:55` 的诊断字段覆盖启动、排队、首输出和轮次终止，默认关闭，缺少模型重试次数、后端状态码和逐次请求等待指标。现有排队反馈只解释 Admission 等待，解释不了获准执行后的静默。

## 修复优先级

1. **先修错误语义和可见性。** 从可信内核事件传递 429/502/503、重试状态和最终失败；最终失败不能仅作为普通模型文本或无回复完成。不要用任意用户/模型文本的正则作为可信错误分类来源。
2. **为持续重试设置预算和进度通知。** 区分后端不可达、容量拥堵、额度耗尽；使用结构化恢复/停止状态。保留取消和现场恢复能力，避免自动重复已经执行的写操作。
3. **补充真实推理健康和延迟指标。** 本次 provider diagnostic 的 spawn 11 ms、initialize 2645 ms、session/new 8796 ms 只说明握手成功，不能代表当前模型推理可用。建议 separately 记录轻量推理首输出、总耗时、错误类型及模型/账户关联的脱敏标识。
4. **再优化简单任务轮数。** 合并可并行的目录检查，明确技能安装入口和完成条件。高思考设置可能影响延迟，但本轮没有同模型不同思考档的对照，不能认定调低档位就解决 502/503。

本轮没有证明 502 来自 Google 服务、代理链路或网络的哪一跳，也没有生产 ACP 原始帧证明终止错误具体在哪层丢失；这些是下一轮精准修复所需证据。现有数据已足以确认慢和中断体验真实存在，以及产品层需要补齐错误展示和结束语义。
