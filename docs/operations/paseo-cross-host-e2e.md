# Paseo 跨主机部署与端到端验收

本文面向 Linux VM，说明普通用户部署、代理、无桌面登录和远端委派的手工验收方法。
第 6 节属于**作者本地验收，未纳入 CI**；原始环境证据未公开，维护者尚未独立复现，
表中结果为作者报告的现场观察，不是产品保证。
命令以 Paseo `0.13.2`、适配器 `2.7.1`、官方内核 `1.4.3` 为基线。
`2.7.1` 为本次待发布补丁；发布前请按下一节使用源码构建。第 6 节保留实际验收时的版本与源码标识。
文中的 `VM_HOST`、`SSH_USER`、`PROXY_HOST`、`PROXY_PORT` 及大写 ID 均需替换为自己的值。

## 1. 准备两端运行环境

- A 是发起委派的主机，B 是接收任务的 VM；两端均需 Node.js 22 或更新版本及 Paseo CLI。
- Linux 主机需提供 `python3` 用于内核解压；依赖需要编译时还需 C++ 工具链。B 应启用 SSH 服务。
- Linux x86_64 托管兼容层拒绝 root 运行。可由 root 安装系统依赖，再切换到普通用户部署和运行服务。
- 在实际运行 provider 的用户下登录 Google，每台机器独立授权。root 登录成功不代表普通用户已登录。
- 两端使用同一适配器版本或同一源码提交。复测未发布补丁时，分别运行 `npm ci`、`npm run validate`，将 provider 的 `command` 指向该构建的 `node` 和 `dist/ACP Connector/main.js` 绝对路径；固定的 npm 发布包不会自动包含分支补丁。

先在两端确认版本，再按 [README](../../README.zh-CN.md) 配置 provider 和账户共享的 Admission 状态目录。

```bash
node --version
paseo --version
```

`--prepare-kernel` 会安装并校验托管内核。`--doctor` 只读检查可执行文件与收据，
`ready: true` 时认证和 daemon 仍是 `not_checked`，不能据此判断模型已经可调用。
安装与登录放在下一节设置代理之后执行。

## 2. 配置代理并完成登录

### 登录终端的代理

网络需要 HTTP 代理时，先在两端实际运行 provider 的用户终端中设置：

```bash
export HTTPS_PROXY="http://PROXY_HOST:PROXY_PORT"
export HTTP_PROXY="$HTTPS_PROXY"
export https_proxy="$HTTPS_PROXY"
export http_proxy="$HTTP_PROXY"
export NO_PROXY="localhost,127.0.0.1,::1"
export no_proxy="$NO_PROXY"

curl --proxy "$HTTPS_PROXY" --head --fail --max-time 20 https://registry.npmjs.org/
npx -y paseo-agy-acp@2.7.1 --prepare-kernel
npx -y paseo-agy-acp@2.7.1 --login
```

不需要代理时，直接运行末尾两条安装和登录命令。首次内核下载约 320 MiB；下载超时的
锁与暂存目录处理见[托管内核安装恢复](paseo-adapter-verification.md#托管内核安装恢复)。

连接测试只说明代理可访问该站点。Google 认证、模型目录和实际推理仍要分别验证。
代理地址必须能从每台 VM 到达；宿主机上的代理不能在 VM 中直接写成 `127.0.0.1`。
如果直接连接其他局域网地址，将它们加入 `NO_PROXY` 和 `no_proxy`。

无桌面登录流程：

1. 在电脑浏览器打开 VM 终端输出的授权链接，并完成 Google 授权。
2. 浏览器跳转到 localhost 后，即使页面无法访问，也复制完整回调地址。
3. 将地址粘贴到发起登录的同一个 VM 终端，等待 `official kernel login succeeded`。

回调由适配器递交给 VM 内核的本地监听地址，不需要为了此流程暴露 OAuth 端口。
回调地址含临时授权信息，应只粘贴到该终端，不能放进聊天、问题报告或日志附件。

### Provider 进程的代理

把以下字段合并到每端 `agents.providers["paseo-agy-acp"].env`，保留已有 Admission 等字段：

```json
{
  "HTTP_PROXY": "http://PROXY_HOST:PROXY_PORT",
  "HTTPS_PROXY": "http://PROXY_HOST:PROXY_PORT",
  "http_proxy": "http://PROXY_HOST:PROXY_PORT",
  "https_proxy": "http://PROXY_HOST:PROXY_PORT",
  "NO_PROXY": "localhost,127.0.0.1,::1",
  "no_proxy": "localhost,127.0.0.1,::1"
}
```

登录终端的 `export` 不会改变已经运行的 daemon。保存配置后执行 `paseo reload`，
并创建新 agent；已有进程继续使用原环境。若 daemon 在登录前缓存了认证失败，
先用 `provider diagnostic` 重新探测；确认仍是旧快照时再重启对应测试 daemon。

```bash
paseo reload
paseo provider diagnostic paseo-agy-acp --json
paseo provider models paseo-agy-acp --json
```

模型目录成功返回后，还需向选定模型发送一个短提示词并检查实际回复。
CLI 的 `status: completed` 可能伴随错误文本；应核对活动内容，不能只看退出码。

## 3. 使用独立测试 daemon 连接 VM

B 使用普通用户的 `~/.paseo/config.json`，在已有 provider 配置旁合并以下 `daemon` 字段：

```json
{
  "daemon": {
    "listen": "127.0.0.1:6767",
    "relay": { "enabled": false },
    "mcp": { "enabled": true, "injectIntoAgents": true },
    "browserTools": { "enabled": false }
  }
}
```

在 B 上运行 `paseo start`。SSH 连接使用配置好密钥的 `SSH_USER`；即使 SSH 管理账号
是 root，daemon 与内核仍应由普通用户运行。

A 使用单独的 Paseo 配置目录，先在 A 上创建：

```bash
export PASEO_E2E_HOME="$HOME/dev/tools/paseo-e2e/daemon-a"
mkdir -p "$PASEO_E2E_HOME"
```

在该目录的 `config.json` 中配置同一 provider、代理和上述 daemon 字段，将 `listen`
改为 `127.0.0.1:6771`，再在同一终端启动：

```bash
env -u PASEO_HOME -u PASEO_AGENT_ID -u PASEO_AGENT_CWD -u PASEO_WORKSPACE_ID \
  paseo start --home "$PASEO_E2E_HOME" --json
```

`--home` 选择 Paseo 配置目录，不会改变运行用户的 `HOME`，也不会隔离 Google 登录
或官方内核状态。需要账户隔离时，应使用独立运行用户或明确配置的登录目录并分别授权。

在 A 的另一个终端保持 SSH 隧道运行：

```bash
ssh -o ExitOnForwardFailure=yes -N \
  -L 127.0.0.1:6772:127.0.0.1:6767 SSH_USER@VM_HOST
```

随后在 A 的测试 daemon 注册 B：

```bash
paseo --host 127.0.0.1:6771 host add 127.0.0.1:6772 --label e2e-b --json
paseo --host 127.0.0.1:6771 host ls --json
```

等待状态为 `online`。保存两类 ID：工具路由使用 B 的 `serverId`，CLI 的启用、禁用
与删除使用 `registrationId`。远端工作区 ID 和路径都属于 B，不能使用 A 的路径代替。
此拓扑通过 SSH 传输真实跨 VM TCP 流量，B 的 daemon 仅监听 loopback。

## 4. 验证真实委派与结果回传

在 B 的专用测试目录生成一个随机标记，创建后不要把值提供给 A 的模型：

```bash
mkdir -p "$HOME/dev/js/paseo-e2e"
cd "$HOME/dev/js/paseo-e2e"
node --input-type=module <<'JS'
import fs from "node:fs";
import { randomUUID } from "node:crypto";
fs.writeFileSync("host-proof.json", JSON.stringify({ nonce: randomUUID() }), {
  encoding: "utf8",
  mode: 0o600,
  flag: "wx"
});
JS
```

在 A 的测试 daemon 创建使用官方内核的 agent，让它通过注入的 Paseo MCP 工具依次执行：

1. `list_hosts` 找到在线的 B，确认与自身 `serverId` 不同；读取 profiles 和实际模型目录后选择模型。
2. 用带 B `serverId` 的 `create_workspace` 创建远端 local 工作区，路径为 B 上测试目录的绝对路径。
3. `create_agent` 带相同 B `serverId`、远端 `workspaceId` 和 `notifyOnFinish: true`。
   要求子代理执行 `hostname`、`pwd`、`id -un`，读取标记，写 `phase1.json` 并回报完整 JSON。
4. 父代理结束当前轮次等待完成通知，再用带同一 B `serverId` 和原 `agentId` 的
   `send_agent_prompt` 派发第二轮，写 `phase2.json` 并输出“跨主机回传成功”。
5. 收到第二轮通知后，用带 B `serverId` 的 `get_agent_activity`、`get_agent_status`
   核对实际工具活动、同一代理身份和最终状态。

由测试控制器通过 SSH 独立读取 B 上的标记与两份结果，比较主机名、用户、工作目录和 nonce。
父代理的“完成”描述、工具目录可见或本地伪造的 JSON 都不能单独作为通过依据。
`yolo` 可用于明确授权的测试目录；实际模型 ID 和支持模式以运行时目录为准。

## 5. 取消、连接恢复与关闭

| 场景 | 操作 | 通过依据 |
| --- | --- | --- |
| 运行中取消 | 子代理启动会写“已开始”标记的长任务，控制器执行下方 `stop` | 收到取消文本，实际子进程退出，且没有完成标记 |
| 连接不可用 | 禁用注册后，通过 A 的 MCP 调用一次远端 `get_agent_status` | 返回 `host_disabled`；错误发生在远端路由边界 |
| 重连继续 | 重新启用注册，等待 `online`，向原代理发送后续任务 | 原代理在 B 写新结果，标记一致，完成通知回到 A |
| 关闭清理 | 归档测试代理，关闭独立 A daemon 和隧道 | 测试内核、harness、取消任务等子进程均退出 |

以下命令均在 A 执行，先替换对应 ID。等 B 的长任务已启动后，通过隧道端点取消：

```bash
paseo --host 127.0.0.1:6772 stop REMOTE_AGENT_ID --json
```

取消检查完成后，禁用 A 保存的 B 主机注册：

```bash
paseo --host 127.0.0.1:6771 host disable REGISTRATION_ID --json
```

此时让 A 代理仅调用一次带 B `serverId` 的 `get_agent_status`，保存 `host_disabled`
结果，再启用注册。等待 `online` 后，才向原代理派发重连后的任务：

```bash
paseo --host 127.0.0.1:6771 host enable REGISTRATION_ID --json
paseo --host 127.0.0.1:6771 host ls --json
```

全部结果核对完成后，分别归档 A、B 代理，再停止独立 A daemon：

```bash
paseo --host 127.0.0.1:6771 archive LOCAL_AGENT_ID --json
paseo --host 127.0.0.1:6772 archive REMOTE_AGENT_ID --json
paseo daemon stop --home "$PASEO_E2E_HOME" --json
```

最后在运行隧道的终端按 Ctrl+C。按需保留 B 的已部署服务和测试文件。
取消通知可能以 `finished` 事件携带 `The request was cancelled by the client.` 文本，
要结合原始通知、远端状态与实际进程检查判定，不能只按事件名称推断。

## 6. 作者本地验收记录与限制（未纳入 CI）

2026-10-27，适配器源码提交 `37a278d`（版本号 `2.7.0`）在两台 Linux x86_64 VM 上
使用 Node.js `22.23.1`、Paseo `0.13.2` 和官方内核 `1.4.3`，作者报告完成了上述流程。

| 检查 | 结果 |
| --- | --- |
| 真实 Gemini / Claude Sonnet 4.6 两轮跨主机任务 | 完成，结果由 VM 文件与随机标记独立核对；Sonnet 期间发生数据库锁错误并重试 |
| Gemini 运行中取消 | 子进程退出、无完成标记、通知返回 A |
| 注册禁用与恢复 | 返回 `host_disabled`，恢复后原代理继续执行并回传结果 |
| 资源生命周期 | 测试代理归档后无残留内核及 harness；独立 A daemon 和隧道关闭，B 服务保留 |
| VM 上的完整验证 | 58 个测试文件通过，358 项通过、1 项跳过，架构与秘密扫描通过 |

原始结果保存在测试控制器本地的 `.tmp-real-e2e/verification-summary.json` 等文件中，
属于未纳入 Git 的现场记录；本文保留可公开复现的步骤与结论，不包含现场地址或凭据。
这次未覆盖完整 UI、双账号隔离、真实许可拒绝、冷启动恢复、其他系统或长时间并发压测。
自动契约测试与真实验收的区别见[适配器验收](paseo-adapter-verification.md)。

### 作者报告的事务修补版本地复测

2026-10-28（UTC+8）以 `37a278d` 加 Admission `BEGIN IMMEDIATE` 修补，在相同两台
VM 和相同版本环境复测。两端源码 SHA-256 均为
`6e8c0b6a7cf2e303c66924c2527682ed85336ee6f60cda4e25f6bfc384b343c5`。

| 检查 | 修补版结果 |
| --- | --- |
| Gemini Flash High、Claude Sonnet 4.6 两轮委派 | 原生 MCP 派发、完成通知与同一代理后续消息均通过；VM 文件独立核对通过 |
| 新随机标记挑战 | Sonnet 追加读取、Gemini 重连后读取均匹配控制器新写入的标记 |
| 运行中取消 | 真实测试子进程退出，未产生完成标记，取消通知返回 A |
| 注册禁用 | 原生 MCP 返回 `host_disabled` |
| 专用 SSH 隧道断开 | 原生 MCP 返回 `host_offline`；恢复隧道后主机自动在线 |
| 取消并重连后继续 | 原 Gemini 远端代理完成第三轮并正常回传，未创建替代代理 |
| 日志与 Admission | 两端零锁错误、零轮次失败；正常轮次全部完成、取消轮次正常结算，无失败或待恢复记录 |
| 关闭清理 | 四个测试代理已归档，未残留其进程；A 测试 daemon 和辅助隧道已停止，B daemon 保持运行 |

验收任务未重试；主机断线后的自动连接重试属于连接恢复机制。Sonnet 第二轮复用了
上下文中的旧标记，因此另外更换了隐藏随机标记并追加第三轮，独立确认了新的远端读取。
这些结果仅为作者对本轮本地组合验收的报告；未纳入 CI，也不代表长时间持锁或其他场景的保证。

本地证据位于被 Git 忽略的 `.tmp-real-e2e/<retest-run>/`，
包括 `verification-summary.json`、VM 文件核对、取消进程证明、原生通知、日志及关闭清理记录。
报告以源码哈希绑定修补版，不将相同 `2.7.0` 版本号视为 npm 发布包已包含该修补。

### `database is locked`：Admission 事务争锁

最初在 Sonnet 远端第二轮投递，以及 Gemini A 端取消后的下一轮请求中观察到
`database is locked`（JSON-RPC `-32000`）。该错误码也会包装适配器异常，
不能据此认定错误来自官方内核。

后续排查发现 Admission 的 SQLite 事务使用默认 `DEFERRED` 模式。入队、激活和结算
均先读状态再写入；并发连接持有写锁或提交新快照时，读事务升级写事务可能立即失败，
已有的 `busy_timeout = 5000` 无法消除这种竞争。原理见
[SQLite 事务隔离说明](https://www.sqlite.org/isolation.html)。

历史 Admission 记录显示：A 端失败轮次没有入队记录；B 端失败轮次停在
`dispatch_intent`，未写入 `active`。这与上述入队、激活竞争的阶段吻合。
独立数据库压力测试和持锁进程回归测试均能复现同一错误。

源码已统一改用 `BEGIN IMMEDIATE`，在读取事务快照前取得写锁，竞争时使用现有的
5 秒等待上限。未增加 prompt 重放，未修改官方内核、数据库结构或兼容层收据。

| 验证 | 结果 |
| --- | --- |
| 旧实现，4 个独立连接、600 次入队／取消操作 | 568 次操作报锁错 |
| 修补版，同样 600 次操作 | 本地与测试 VM 均全部成功、零锁错 |
| 独立进程持锁时的入队、激活、结算回归 | 旧实现 3 项失败，修补版 3 项通过 |
| 官方内核 Gemini Flash High，2 个并发会话、各 2 轮 | 4 轮均正常结束、随机标记全部匹配、零锁错 |
| 修补版完整跨主机委派、取消、禁用注册、隧道断开与重连续跑 | 通过；零锁错误、零轮次失败、零任务重试 |

长时间持锁仍可能超过 5 秒等待上限。若再次遇到错误，保留实际版本、发生阶段、
会话与代理关联、错误码、活动记录和进程状态；可按
[诊断说明](paseo-adapter-verification.md#排队反馈与诊断)启用结构化 stderr。
重试前先核对远端活动与结果文件，确认前一次是否已执行；写入性任务不能盲目重复派发。
不要通过删除数据库、凭据或兼容层收据处理锁错误。

### 模型可发现但无法推理

本次 Gemini 在实际推理时返回过 `User location is not supported for the API use`，
而模型目录和 Claude 推理可用；配置运行用户可达的 HTTP 代理后，两端 Gemini 短回复与
跨主机任务均成功。遇到此类情况，应核对服务可用条件、实际进程代理环境和模型回复，
不能仅依据模型列表判定网络与账号已经可用。
