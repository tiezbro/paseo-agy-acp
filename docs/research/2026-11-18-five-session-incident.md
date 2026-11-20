# 2026-11-18 五会话生产故障定位

用户从生产 Paseo 启动五个独立的 Argon Low 会话，发送 `AGY-11` 至 `AGY-15`。以下结果关联了 Paseo 消息与状态、对应会话的原生 SQLite 步骤，以及每个 `agy_acp_server` 进程的 INFO 日志。表中耗时从 Paseo 的 `lastUserMessageAt` 计到 `lastActivityAt`。当地日志使用太平洋标准时间（UTC−8）。

| 消息 | Paseo ID 前缀 | 原生 ID 前缀 | 内核 PID | 从发送到最后活动 | 502 步骤 | 最终输出 |
|---|---|---|---:|---:|---:|---|
| AGY-11 | b9a80eca | fd05ed91 | 551467 | 18:59 | 6 | 模型回复 |
| AGY-12 | 8da95e74 | 608c1467 | 551517 | 29:55 | 8 | 503 `MODEL_CAPACITY_EXHAUSTED` 显示为助手正文 |
| AGY-13 | bbadf19a | 2d879119 | 551580 | 5:19 | 1 | 模型回复 |
| AGY-14 | 750ecf06 | 8e17f3d6 | 551687 | 24:01 | 6 | 调用 Git 工具后回复 |
| AGY-15 | ed1d4811 | 3c57fb34 | 551752 | 8:02 | 2 | 模型回复 |

## 连接断开的位置

五个独立模型代理于 03:19:22.226、24.006、33.882、33.945、34.010 收到各自的首次生成请求。第一条断开发生在 03:21:06.702。五条在本地代理向上游请求生成的阶段重叠约 92.69 秒。无法从客户端观测 Google 实际同时调度了几个推理任务。

这五条轨迹共记录 23 次 502，对应的代理异常均为 `http.client.RemoteDisconnected`。`ccpa_connection/ccpa_client.py:219` 运行 `urllib.request.urlopen`，栈停在 `getresponse → _read_status`，对方在发回 HTTP 状态行前关闭了连接。`ccpa_client.py:246` 将异常包装成 `CCPAConnectionError`，`ccpa_connection/proxy_server.py:225` 将其映射成本地 HTTP 502。该调用配置的 socket 超时为 300 秒。HTTP 502 本身不能确定发起断连的远端设备，也不能当作 Google 返回的 HTTP 状态码。

AGY-11 和 AGY-12 的首次断开相隔 4.8 毫秒；另三条在约 9 毫秒内一起断开。前两条多轮在 03:21:06、24:06、27:07、30:07、33:07、36:07 同时或接近同时断开，而重新发出请求的时刻逐渐分离。这个规律支持排查共用出口和上游服务，无法单凭约 180 秒的间距认定是哪一层的定时器。

## 等待与错误展示

`local_connection.py:515` 在 SDK 接收步骤时处理 SYSTEM 错误。对 502 会记录日志并继续。执行器在第一次 502 后提示 4 秒重试，后续代理重新接到同一会话的模型请求。AGY-12 的第八次 502 到第九次请求之间还有约 237 秒。从第一条错误就将整轮置失败，会提前结束本批四条后来成功的会话。

AGY-12 第九次请求约 11.5 秒后收到 HTTP 503。错误包含 `UNAVAILABLE`、`MODEL_CAPACITY_EXHAUSTED` 和模型 ID；这次有明确的模型容量证据。SDK 最终抛出执行异常，原生进程日志有 `server.py:5737` 异常栈。`server.py:5760` 附近将格式化错误作为 `AgentMessageChunk` 发送；无正常 response 时 `server.py:5829` 默认 `end_turn`。生产 Paseo 的助手消息确实只有容量错误。该轮原始 ACP frame 没有留存，`end_turn` 是按运行源码推导，不能冒充逐帧实测。重试期间的 SYSTEM 错误也不会通过 `server.py:6030` 的 MODEL→USER 文本过滤。单改 Paseo 对 `refusal` 等结构化停止原因的映射覆盖不到这条路径。

## 隔离对照

本次使用 `scripts/compare-kernel.mjs` 的 native 模式，每次一个请求，前一个测试释放进程后才启动下一个，均采用固定短 prompt、临时目录和零工具。安装的兼容内核分别选择 `gemini-4-argon-low` 和 `gemini-3.8-flash-high`，两次都在诊断器自定的 75 秒内没有收到正文。这个时间是观测窗口。

随后直接运行官方 1.5.0 的原始 `agy_acp_server.par`，跳过 Paseo、connector 和本地模型兼容代码。单会话 Argon Low 于 03:58:12.743 进入生成请求，04:00:09.813 遇到同样的断连并在本地生成 502，相差 117.07 秒。探针绑定进程的套接字与路由器连接表匹配，目标为 `daily-cloudcode-pa.googleapis.com:443`，OpenClash 命中 `DomainSuffix` 并走代理链。该路由是对此次独立复现的现场观察。原始归档 SHA-256 为 `8a35f63dd2284e3790a1d97dd0cb2236057c55a0c598b26f3bde022b843d5c04`。探针在自定的 210 秒窗口到期后结束该独立会话，期间未收到正文。生产批次没有留存能将关闭方定位到具体代理节点或 Google 边缘的两端连接记录。

本机兼容包与原始归档逐文件对比，CCPA 网络客户端、ACP `server.py` 和 SDK `local_connection.py` 内容一致。CCPA 代理增加的请求转换函数对 Argon 直接返回原请求。原始归档的单路复现提供了独立的运行证据。

生产批次与复现仅涉及本机观察和临时探针。没有更改生产路由、启动器、daemon 或用户会话。复查原始数据可按表中的 PID 和原生 ID 在 `/tmp/agy_acp_server.*.log.INFO.20261118-0319*` 和本机 `~/.gemini/antigravity-acp/conversations/` 中定位。原始归档复现日志为 `/tmp/agy_acp_server.par.H007-tiezbro-dev.tiezbro.log.INFO.20261118-035758.770758`。报告不包含提示词上下文、凭据或代理节点标识。
