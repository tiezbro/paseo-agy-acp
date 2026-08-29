<div align="center">

# 🔌 paseo-agy-acp

**面向 Paseo 的适配器，跑在 Google 官方 Antigravity ACP 内核前面**

[![License](https://img.shields.io/badge/license-Apache%202.0-blue?style=flat-square)](./LICENSE)
[![Version](https://img.shields.io/badge/version-2.2.1-blue?style=flat-square)](./package.json)
[![npm](https://img.shields.io/npm/v/paseo-agy-acp?style=flat-square)](https://www.npmjs.com/package/paseo-agy-acp)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen?style=flat-square)](#)
[![ACP](https://img.shields.io/badge/ACP-NDJSON%20v1-8A2BE2?style=flat-square)](https://agentclientprotocol.com)

</div>

<div align="center">

[🇺🇸 English](./README.md) | [🇨🇳 中文](./README.zh-CN.md)

</div>

---

`paseo-agy-acp` 是面向 Paseo 的 Google Antigravity ACP 产品。从 **2.1.0.0** 起，
它以薄层 NDJSON 代理运行 Google 官方 Antigravity ACP 内核（`agy_acp_server` /
Registry id `antigravity-acp`），再补上 Generic ACP 本身给不了的 Paseo 行为：
daemon 上下文、session 模式映射、MCP 改写、产品身份，以及账户级 Admission
队列——让 Paseo 主控可以一次委派多个 Antigravity agent，而不把启动打成风暴。

**2.2** 仍使用同一套官方 ACP 内核。它只增加一层明确的 **本机 opt-in**
兼容：有资格的 Claude 4.6 与 GPT-OSS 120B 可以在这条路径上跑完回合。
如果未 opt-in，官方路径默认只支持 Gemini 系模型。

**2.2.1** 与 2.2.0 是同一产品：GitHub tag 从此与 npm 对齐（`v2.2.1` =
`paseo-agy-acp@2.2.1`）。本文说明 `npx` 只拉起本代理。旧 GitHub tag
`v2.2.0.0` 仍是 2.2.0 那条线。

> **非 Paseo 官方支持。非 Google 官方支持。** 社区维护产品，使用风险自负。

## 30 秒摘要

如果你在 Paseo 里使用 Google Antigravity，`paseo-agy-acp` 给 Paseo 提供一条
接入 Google 官方 Antigravity ACP 内核的产品化路径。模型工作仍然由官方内核完成，
本仓库补上 Generic ACP 桥本身不提供的 Paseo 侧行为：

- daemon 上下文注入
- session 模式映射
- MCP `http` 到官方 `sse` 的改写
- 稳定产品身份
- 面向多 agent 委派的账户级 Admission 队列
- 本机 opt-in 后可跑 Claude 4.6 与 GPT-OSS 120B；未 opt-in 则只支持 Gemini 系

## 适合谁

适合你，如果：

- 你运行 Paseo
- 你本机已经安装并登录 Google Antigravity
- 你想通过 Generic ACP 使用 Antigravity
- 你会一次委派多个 agent，希望启动突发被限速而不是同时砸到内核上
- 你想在官方 ACP 内核上通过 Paseo 使用 Claude 4.6 或 GPT-OSS 120B（本机 opt-in）

可能不适合你，如果：

- 你不使用 Paseo
- 你想要一个独立的 Antigravity 替代品
- 你期待这个包重新分发 Google 的专有内核

## 快速开始

前提：**Paseo**、**Node.js >= 22**，以及本机已安装的官方 Antigravity ACP 内核
（本包装 **不会** 安装 Google 的 `.par`）。`--login` 完成官方 OAuth
（`authenticate` / `oauth-personal`）。把 `PASEO_AGY_ACP_OFFICIAL_BIN` 指到你的
内核 wrapper 或 `.par`（除非已在维护者主机默认 pin 路径，否则必填）。

npm 包 `paseo-agy-acp@2.2.1` 是 **代理**。`npx` 只拉起这个代理，**不能**代替
Antigravity 或 Paseo。

```bash
export PASEO_AGY_ACP_OFFICIAL_BIN="/absolute/path/to/agy_acp_server.par-or-wrapper"
npx -y paseo-agy-acp@2.2.1 --login

export AGY_ACP_STATE_DIR="$HOME/.local/state/paseo-agy-acp/default"
install -d -m 700 "$AGY_ACP_STATE_DIR"
npx -y --package=paseo-agy-acp@2.2.1 agy-acp-prepare-state "$AGY_ACP_STATE_DIR"
export AGY_ACP_ADMISSION_ENABLED=true
```

再把 Paseo Generic ACP 的 `command` 指到 npx（见
[Paseo Provider 配置](#paseo-provider-配置)）。下面这一行 **不是** 独立聊天程序，
而是 Paseo spawn 的 stdio ACP 服务：

```bash
npx -y paseo-agy-acp@2.2.1
```

Claude / GPT-OSS 见 [§1](#1-官方-agy-acp-内核能力) 和
[runbook](docs/operations/official-kernel-compat-runbook.md)。源码 checkout
（`git clone` + `npm ci` + `npm run build`）见 [安装](#安装)。

## 关于

本仓库是 **产品适配器**，不是第二个 Antigravity。模型工作由内核完成；本仓库
补上 Generic ACP 桥本身不提供的 Paseo 侧行为。

| 亮点 | 为什么重要 |
|---|---|
| **官方 ACP 内核** | 原生 ACP / NDJSON。未 opt-in 时官方路径只支持 Gemini；本机 opt-in 后，有资格的 Claude 4.6 与 GPT-OSS 120B 可以跑完回合。 |
| **Paseo 侧胶水** | daemon `appendSystemPrompt`、Paseo 已在用的 mode id、以及 MCP `http` server，都会改写成官方内核认识的形态，Generic ACP agent 不用再写一层适配。仍须安装 Paseo、官方内核，并把 `command` 指到本代理。 |
| **突发委派更稳健** | 账户级持久 Admission 队列给 `session/prompt` 限速，Paseo 主控可以一次派出很多 Antigravity agent，不会让每个 turn 同时砸到内核上。 |
| **生产实测默认值** | 默认 **8 个共享席位 / 8 路同时启动 / 2 秒间隔**，来自真实 Paseo 派发（含 10 agent 突发）和隔离压测。整数 **≥ 1** 可以继续试更高并发；本仓库 **不编** 一个产品上限。 |
| **失败即关闭** | 非法环境变量、policy 分叉、无法证明的写入一律 fail closed。排队超时、取消、内核错误仍然能区分。 |
| **空白回合守卫** | 官方 `end_turn` 且没有任何可见助手/工具输出时，改成 JSON-RPC 错误，避免 Paseo 记成静默成功。 |
| **许可证分层清楚** | 本仓库保持 **Apache-2.0**。官方内核是专有软件：只 **spawn** 你本机已安装的二进制；npm **不** 附带约 1.5GiB 的 `.par`。 |

```text
Paseo Generic ACP (NDJSON)
  → paseo-agy-acp 产品代理
      身份 · daemon 上下文 · 模式映射 · MCP 改写 · Admission 围栏
  → 官方 agy_acp_server (NDJSON)
```

| 层 | 许可证 | 我们怎么做 |
|---|---|---|
| **本仓库**（代理、Admission、Paseo 上下文） | **Apache-2.0** | **保持 Apache-2.0，不改开源协议。** |
| **官方 ACP 内核**（`agy_acp_server.par` / `antigravity-acp`） | **专有软件** | 只 spawn 本机内核，不分发。 |
| **ACP 协议 / `@agentclientprotocol/sdk`** | 独立的 Apache-2.0 生态 | 官方 NDJSON 代理运行时不依赖它。 |

---

## 1. 官方 `agy-acp` 内核能力

本产品 **不重新实现** Antigravity。它拉起 Google 原生 ACP 服务器，转发 Agent
Client Protocol NDJSON。下表是**官方内核**通过该协议提供的能力。

| 范围 | 官方内核提供什么 |
|---|---|
| 协议 | 原生 **ACP v1 / NDJSON** |
| 鉴权 | `authenticate`，`methodId=oauth-personal`（内核内 OAuth） |
| 会话生命周期 | `initialize`、`session/new`、`session/prompt`、`session/cancel`、`session/set_mode`、`session/set_config_option` |
| 流式输出 | `session/update`：助手文本、思考、工具调用 / 工具更新 |
| 在线 session 模式 | `default`、`auto_edit`、`yolo`（官方 **没有** plan 模式） |
| 工具 | 文件编辑、shell/终端等，以 Google 实现为准 |
| MCP | 官方 MCP 客户端；在 `session/new` 上声明 server |
| 模型 | 未 opt-in：只支持 Gemini 系。本机 opt-in：有资格的 Claude 4.6 与 GPT-OSS 120B（[§2](#2-我们为-paseo-做了哪些适配)）。 |
| 回合结束 | 官方 `end_turn` / stop reason |

### 模型

未 opt-in 时，官方 ACP 路径**默认只支持 Gemini 系模型**。Antigravity IDE 里
有资格的账号已经能看到 Claude 4.6 与 GPT-OSS 120B；在这条 ACP 路径上，请求
仍按 Gemini 对齐（JSON Schema、工具 ID、GPT generation config），所以它们
不是默认可工作集合。

本机 opt-in（同一套官方内核）见 [§2](#2-我们为-paseo-做了哪些适配)。
操作步骤：[runbook](docs/operations/official-kernel-compat-runbook.md)。

工具质量、生图、供应商 503/配额文案，由官方内核和 Google 后端负责。
本产品只 **代理** 这层能力。

---

## 2. 我们为 Paseo 做了哪些适配

下面这些才是本仓库存在的理由：**Paseo 侧**加在官方内核之上的适配。

| # | 适配 | 做什么 |
|---|---|---|
| 1 | 产品身份 | `initialize` 的 `agentInfo` 叠加为 `agy-acp` / `paseo-agy-acp`，Paseo 看到的是稳定产品名。 |
| 2 | Daemon 上下文桥 | 设置了 `PASEO_AGENT_ID` 时，把 Paseo daemon 的 `appendSystemPrompt` 注入官方 `session/prompt`，工作区/agent 上下文才能到达 Antigravity。 |
| 3 | Session 模式映射 | 把 Paseo / 旧 id 映射到官方在线模式：`accept-edits` → `auto_edit`，`dangerously-skip-permissions` → `yolo`，`plan` → `default`。 |
| 4 | MCP `http` → `sse` | Paseo 常给出 `type: "http"` 加 header 对象；官方内核要 `sse` 和 `{name,value}` 数组。代理在 `session/new` 上改写。 |
| 5 | Admission 围栏 | 启用 Admission 时，官方 `session/prompt` **写入前**先占账户级持久席位，回合结束/失败/取消再释放。 |
| 6 | 空白回合守卫 | 官方 `end_turn` 且 **没有任何** 可见助手/工具输出时，改成 JSON-RPC 错误（`-32000`），避免 Paseo 当成空成功回合。 |
| 7 | 隔离 Admission 账本 | 官方内核队列状态在 `$AGY_ACP_STATE_DIR/official-kernel`，不与历史账本混用。 |
| 8 | 单一内核 | `PASEO_AGY_ACP_KERNEL=legacy` 和 `--legacy-kernel` 直接失败。官方内核是唯一 ACP 执行路径。 |
| 9 | 本机模型兼容（opt-in） | 同一套官方内核：本机解开 + 请求转换，让有资格的 Claude 4.6 与 GPT-OSS 120B 跑完回合。未 opt-in 则关闭。 |

`PASEO_HOME` 可选；未设置或为空时回退到 `~/.paseo`。Paseo 通常会给 ACP
provider 进程提供 `PASEO_AGENT_ID`（以及 `PASEO_AGENT_CWD`）。

### 本机 opt-in：Claude 4.6 与 GPT-OSS 120B

**2.2 仍使用同一套官方 ACP 内核。** 它只增加这一层。如果未 opt-in，
官方路径默认只支持 Gemini 系模型。

opt-in 是 **本机、显式** 的：

1. 对本机已安装的官方 RC01 构件做 pin（hash 校验；不匹配则 fail closed）。
2. **只在本机**解开。npm 和 git **不**分发 Google 的 `.par` 或 runfiles。
3. 加载 `paseo_model_compat.py`：只保留同时出现在 live CCPA 目录 **和** 本地
   profile 里的模型；转换工具 JSON Schema（`$schema`、`parameters`）、配对
   工具 ID、处理 GPT-OSS generation config。Gemini 与未知 id 走 identity，
   不加变换。
4. `prepare` → `verify` → lifecycle `activate`，再把
   `PASEO_AGY_ACP_OFFICIAL_BIN` 指到 **stable** wrapper
   （`agy-acp-kernel-compat-active` / `status.stableWrapperPath`）。不要把
   生产指到 per-release 冒烟 wrapper。

命令：`agy-acp-prepare-official-kernel-compat`（或
`node ./scripts/prepare-official-kernel-compat.mjs`）。完整参数、JSON 字段和
回滚见 [runbook](docs/operations/official-kernel-compat-runbook.md)。

维护者主机在具备 raw CCPA 资格时核验过：`claude-sonnet-4-6`、
`claude-opus-4-6-thinking`、`gpt-oss-120b-medium` —— 文本、顺序工具、warm
resume。你的账号仍须在 raw CCPA 目录里拥有这些 id。

请在自己的环境测试 Claude 与 GPT-OSS（单个 agent 和一次开多个）。模型缺失、
回合失败或工具异常，请 [开 Issue](https://github.com/tiezbro/paseo-agy-acp/issues)。
我们会按反馈做优化和修复。

---

## 3. 为什么需要 Admission 队列

### 背景

Paseo 是 **主控**。它会 **一次委派很多个 Antigravity agent**。这种突发下，
高并发曾经把回合挂死：助手气泡一直空着、进程卡住，或 ACP **Internal Error
`-32603`**。当时的 **3+1**（3 个共享席位、1 路同时启动、启动间隔 2 秒）是给
那种故障 **止血**用的，不是测出来的官方 ACP 上限。

换成官方内核后，生产环境实测默认 **8 个共享席位 / 8 路同时启动 / 2 秒间隔**，
包括一次 10 个 Antigravity agent 的派发，没有复现旧的挂死。隔离环境
`127.0.0.1:6768` 上 6 路 yolo 压测同样没有复现。官方 ACP **仍未**被证明无限
并发。**8 是实测默认值，不是已经公布的产品上限。**

### 原理

```text
Paseo 主控
  一次委派多个 Antigravity agent
            |
            v
  账户级持久 Admission 队列
            |
     共享 active 席位（默认 8）
     限速同时启动（默认 8，间隔 ≥ 2s）
            |
     官方 session/prompt 写入
            |
     回合结束 / 失败 / 取消后释放席位
```

多出来的 turn **在队列里等**，而不是一起打到 `agy_acp_server` 上。队列按最早
可调度者排队，并带 agent fairness，跨 connector 进程持久，非法环境变量失败
关闭（非整数、`< 1`、启动间隔 `< 2000ms`）。共用同一状态目录的多个 Paseo
agent 共用一份账户席位池，不会各自再乘一倍并发。

### 优势

队列不是为了把 Paseo 永久锁在 8 个 agent。它是为了让 **Paseo 主控委派
Antigravity 更稳健**：

- 主控仍然可以一次派出一批；
- 超出席位的工作排队，而不是把官方内核打满；
- 席位是账户级的，跨进程、跨重启仍然一致；
- 排队超时 / 取消 / 内核错误仍然能和崩溃区分开；
- 可以把席位/启动整数调到 **≥ 1** 去试更高并发，测到结果欢迎反馈。

所以换成官方内核之后，Admission 仍然留在产品里。

---

## Admission Controller v2

Admission 是上面这套队列的落地实现：持久席位、启动限速、故障恢复、typed
terminal。通过环境变量 **显式启用**（`AGY_ACP_ADMISSION_ENABLED=true`，加上
绝对路径 `AGY_ACP_STATE_DIR` 和合法 `PASEO_AGENT_ID`）。只要 Paseo 会委派
不止一个 Antigravity agent，就建议打开。

### 启用 Admission

每个 Antigravity 账号准备一个 owner-only 状态目录，并跑随包发布的预检：

```bash
export AGY_ACP_STATE_DIR="$HOME/.local/state/paseo-agy-acp/account-name"
install -d -m 700 "$AGY_ACP_STATE_DIR"
agy-acp-prepare-state "$AGY_ACP_STATE_DIR"
export AGY_ACP_ADMISSION_ENABLED=true
```

预检会以 `0700` 创建缺失目录，并核验类型、owner 和精确权限。已经存在的宽权限
目录会被 **拒绝**，不会静默改权。确认路径和归属后执行
`chmod 700 -- "$AGY_ACP_STATE_DIR"`，再重新跑预检。Admission key 与 SQLite
文件以 `0600` 创建。

官方内核队列写在 `$AGY_ACP_STATE_DIR/official-kernel` 下，不会和历史账本混用。

### 默认与保守 policy

| 规则 | 默认 | 覆盖 |
|---|---:|---|
| 共享 active 席位 | **8**（实测） | `AGY_ACP_ADMISSION_MAX_ACTIVE_TURNS`，整数 **≥ 1** |
| 同时启动路数 | **8**（实测） | `AGY_ACP_ADMISSION_MAX_CONCURRENT_STARTS`，整数 **≥ 1** |
| 最小启动间隔 | **2000 ms** | `AGY_ACP_ADMISSION_MIN_START_INTERVAL_MS`，整数 **≥ 2000** |
| 最长排队时间 | 30 分钟 | `AGY_ACP_ADMISSION_QUEUE_TIMEOUT_MS`，整数 `1`–`1800000` |
| 容量 cooldown | 30 秒 | `AGY_ACP_ADMISSION_CAPACITY_COOLDOWN_MS`，整数 **≥ 30000** |

使用同一状态目录的所有本地 connector、session 和模型共享这些账号席位。队列按
oldest-eligible 调度并带 agent fairness。可信的 provider 容量故障只暂停受影响
的 provider/model。排队超时会在同一事务中取消请求并删除加密 prompt。

覆盖值失败即关闭：非整数、`< 1`、启动间隔低于 2000 ms 都不会启动。本仓库
**不公布**产品上限；把整数调大去试，测到结果欢迎反馈。

更紧的历史 3+1（可选，**不是**推荐默认）：

```bash
AGY_ACP_ADMISSION_MAX_ACTIVE_TURNS=3
AGY_ACP_ADMISSION_MAX_CONCURRENT_STARTS=1
```

soft drain 可以降低席位，而不杀死进行中的工作、不丢弃排队请求。

### 持久化、dispatch 与恢复

本地实现使用 `shared-admission-queue` **schema v3**。持久 policy
（`policy_state` / `policy_fingerprint`）、queued owner、带 suspect metadata 的
lease（给 runtime reaper 用）以及 `schema_migrations` 都在同一份 SQLite 账本里。
额外的 delivery-authority 表仍然 fail closed。

每个启用 Admission 的 runtime opener 都会在 startup recovery 前 claim 或核验
这份持久 policy。第二个 connector 对同一目录使用 **不同** policy 时直接失败
关闭，不会形成只存在于进程内的 policy 分叉。

空闲 session 不占席位，也不保留常驻 turn 进程。获得席位的 turn 走一次 fenced
的 `session/prompt` 写入；无法证明的写入进入 `dispatch_ambiguous` 或
`recovery_required`，绝不静默重放。Heartbeat、owner 身份和 runtime reaper 只
在 owner 被证实退出时回收容量。关闭 session 会取消尚未开始的排队请求；已经
运行的 turn 走 connector 取消路径（`session/cancel`）。

Admission **不会**再做第二套 live 输出、outbox、ACK、terminal replay 或手工
requeue API。官方 session 历史仍由 ACP Connector / 内核负责。

### 设计 authority 与实现边界

当前 authority 是 confirmed Scheme 与已接受的 Stage 2 artifacts（见下方
[权威文档](#权威文档v2000-closeout)）。旧 Admission design 文件只作为
historical input。

仓库严格只有两个源码功能区：

```text
paseo-agy-acp/
|-- ACP Connector/          ACP NDJSON 代理、官方内核 spawn、Paseo 上下文
`-- Admission Controller/   持久席位、队列、策略、启动间隔、恢复
```

`ACP Connector/` 负责协议、身份、模式/MCP 改写、内核 spawn，以及围在
`session/prompt` 上的 Admission。`Admission Controller/` 只负责共享席位池、
持久队列、策略账本、lease、reaper 和 capacity cooldown。package 入口仍在
`ACP Connector/` 内。

---

## 环境要求

- **Node.js >= 22**
- 本机已安装 **官方 Antigravity ACP 内核**。维护者主机默认 pin：

  `~/.local/opt/agy-acp-server-agy_acp_server_20260818_01_RC01/agy-acp-server-canary`

  用 `PASEO_AGY_ACP_OFFICIAL_BIN` 覆盖。如果路径就是 `.par` 本身，进程会
  `cd` 到该目录并以 `--uid=` 启动（没有可用 group 的主机，例如 `nogroup`，
  必须带 `--uid=`）。

- 已完成官方 `authenticate`（`methodId=oauth-personal`）。令牌留在内核自己的
  状态里，本仓库不会打印。

## 安装

`npx` 安装并运行 **本代理**。它不会安装 Paseo，也不会安装 Google 内核。适配器
请用 npm，不要默认 `git clone`。

```bash
# 经代理做官方 OAuth（本机必须已有官方内核）
npx -y paseo-agy-acp@2.2.1 --login
```

命令：`paseo-agy-acp` / `agy-acp`（ACP 代理）、`agy-acp-prepare-state`、
`agy-acp-prepare-official-kernel-compat`。第一次 `npx` 可能要编译
`better-sqlite3`（本机需要 C++ 工具链）。

源码 checkout（开发用）：

```bash
git clone https://github.com/tiezbro/paseo-agy-acp.git
cd paseo-agy-acp
npm ci
npm run build
npm test
```

```bash
# ACP initialize 冒烟（需要官方二进制）
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1}}' \
  | npx -y paseo-agy-acp@2.2.1
```

登录（官方内核 OAuth）：

```bash
npx -y paseo-agy-acp@2.2.1 --login
```

## 环境变量

| 变量 | 作用 |
|---|---|
| `PASEO_AGY_ACP_OFFICIAL_BIN` | 官方内核 wrapper 或 `.par` 路径 |
| `PASEO_AGENT_ID` | 启用 daemon 上下文 + Admission agent 绑定 |
| `PASEO_HOME` | 可选 Paseo home；缺省 `~/.paseo` |
| `AGY_ACP_ADMISSION_ENABLED` | `true` / `1` 时把 prompt 围进 Admission |
| `AGY_ACP_STATE_DIR` | Admission 状态目录（官方运行时用下面的 `official-kernel/`） |
| `AGY_ACP_ADMISSION_MAX_ACTIVE_TURNS` | 共享 active 席位。整数 **≥ 1**。默认 **8**（实测）。 |
| `AGY_ACP_ADMISSION_MAX_CONCURRENT_STARTS` | 同时启动路数。整数 **≥ 1**。默认 **8**（实测）。 |
| `AGY_ACP_ADMISSION_MIN_START_INTERVAL_MS` | 最小启动间隔。默认 **2000**；低于 2000 失败关闭。 |
| `AGY_ACP_ADMISSION_QUEUE_TIMEOUT_MS` | 最长排队。默认 30 分钟；上限 1800000。 |
| `AGY_ACP_ADMISSION_CAPACITY_COOLDOWN_MS` | 可信容量故障后的 provider/model cooldown。默认 30000；最小 30000。 |

`PASEO_AGY_ACP_KERNEL=legacy` 和 `--legacy-kernel` 失败关闭。

## 架构

```text
Paseo / Generic ACP 客户端
  └─ paseo-agy-acp (agy-acp)
       ├─ 产品代理：身份、daemon 上下文、模式映射、MCP 改写
       ├─ session/prompt 上的 Admission 围栏（可选，建议打开）
       └─ 官方 agy_acp_server (NDJSON)
            └─ Antigravity 账号、工具、MCP、模型
```

每个 connector 进程一个官方内核子进程。Admission 通过持久账本协调这些进程之间的
**账户级**席位。

## Paseo Provider 配置

```json
{
  "providers": {
    "antigravity": {
      "type": "acp",
      "command": ["npx", "-y", "paseo-agy-acp@2.2.1"],
      "env": {
        "PASEO_AGY_ACP_OFFICIAL_BIN": "/home/YOU/.local/opt/agy-acp-server-agy_acp_server_20260818_01_RC01/agy-acp-server-canary",
        "AGY_ACP_ADMISSION_ENABLED": "true",
        "AGY_ACP_STATE_DIR": "/home/YOU/.local/state/paseo-agy-acp/account-name"
      }
    }
  }
}
```

`command` 是 Paseo **拉起本代理** 的方式。`PASEO_AGY_ACP_OFFICIAL_BIN` 必须指向
本机已安装的内核。`command` 为 `node` 时，`args` 传
`["/path/to/paseo-agy-acp/dist/ACP Connector/main.js"]`。
Paseo 会给 provider 进程提供 `PASEO_AGENT_ID`。

改完 provider 后重启 Paseo daemon，空闲的 Antigravity agent 才会换到新二进制。

## 初始化 Prompt

贴到任意 Paseo agent，用来安装或修复 Antigravity provider：

~~~
Configure the Paseo daemon to add an ACP provider for Google Antigravity.

1. Confirm a local official Antigravity ACP kernel is installed (this package does not vendor it).
2. Read Paseo config ($PASEO_HOME/config.json or ~/.paseo/config.json).
3. Add or update providers.antigravity:
   - type: "acp"
   - command: ["npx", "-y", "paseo-agy-acp@2.2.1"]  (spawns the proxy, not the Google kernel)
   - env.PASEO_AGY_ACP_OFFICIAL_BIN: local official kernel wrapper (agy-acp-server-canary or agy_acp_server.par)
   - env.AGY_ACP_ADMISSION_ENABLED: "true"
   - env.AGY_ACP_STATE_DIR: absolute owner-only directory (mode 0700)
4. Prepare Admission state: npx -y --package=paseo-agy-acp@2.2.1 agy-acp-prepare-state "$AGY_ACP_STATE_DIR"
5. Login once: npx -y paseo-agy-acp@2.2.1 --login
6. Restart the Paseo daemon.
7. Verify: create a test agent with provider "antigravity", send a simple prompt.
~~~

## 验证

```bash
# 冒烟（需要官方二进制）
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1}}' \
  | node 'dist/ACP Connector/main.js'

# 完整测试
npm test
```

金丝雀清单：真实 Paseo agent 上的 daemon 上下文、多回合、以 `http` 声明的 MCP
server、模式 `dangerously-skip-permissions` → 官方 `yolo`、小席位下的 Admission
排队、空白回合拒绝。

`2.1.0.0` 在隔离环境 `127.0.0.1:6768` 上证明了产品代理 + 官方内核 + daemon
上下文。

## 已知问题

- opt-in 之后请自行测试 Claude 4.6 与 GPT-OSS 120B，不稳定就
  [开 Issue](https://github.com/tiezbro/paseo-agy-acp/issues)，我们据此优化和修复。
- 官方 RC01 的 active cancel 在我们的 harness 里未确认；真实 503/配额未对
  线上后端做诱导验证。
- 官方内核二进制必须本机已安装；本包装不会随包分发它。`npx` 只拉起代理。
- 在 `AGY_ACP_ADMISSION_ENABLED`、`AGY_ACP_STATE_DIR`、`PASEO_AGENT_ID` 都合法
  之前，Admission 保持关闭。没有 agent id 的 discovery / `--login` 不会打开账本。
- 官方 ACP 没有 plan 模式；Paseo 的 `plan` 映射到 `default`。
- 生图和线上 503 文案由官方内核负责。本适配器 **不声称** 已在此重新验证这些能力。
- 当 `PASEO_AGENT_ID` 指向正在运行的 Paseo agent 时，裸 prompt 测试可能看到
  被前置的 daemon 上下文：

```bash
env -u PASEO_AGENT_ID -u PASEO_HOME npm test
```

## 升级 / 回滚

若 Paseo `command` 走 npx，改 npm 版本钉（例如 `paseo-agy-acp@2.2.1`）并重启
daemon。这是打包安装的升级/回滚路径。

源码 checkout：

```bash
# 升级
git pull && npm ci && npm run build && npm test

# 回滚
git checkout <rev> && npm ci && npm run build && npm test
```

改 `command` 或内核路径后重启 daemon。Admission policy 变更（例如 3+1 → 8/8）
时，如果持久 fingerprint 会把新 policy 失败关闭，请换一个 **全新** 的
`AGY_ACP_STATE_DIR`。

## 权威文档（v2.0.0.0 closeout）

- [confirmed Scheme](/home/tiezbro/projects/MAACS/docs/maacs-paseo-agy-acp-confirmed-scheme.md)
- [Stage 2 handoff](docs/design/v2.0.0.0-stage2-handoff.md)
- [503 feasibility](docs/design/v2.0.0.0-stage2-503-feasibility.md)
- [ACP source map](docs/design/v2.0.0.0-stage2-acp-source-map.md)
- [Admission source map](docs/design/v2.0.0.0-stage2-admission-source-map.md)
- [Architecture](docs/design/v2.0.0.0-stage2-architecture.md)
- [Domain model](docs/design/v2.0.0.0-stage2-domain-model.md)
- [Test contracts](docs/design/v2.0.0.0-stage2-test-contracts.md)
- [Specification](docs/design/v2.0.0.0-stage2-spec.md)

→ [本地技术说明](./docs/PASEO_LOCAL_CHANGES.md)

## 免责声明

官方内核受 [Google Antigravity 条款](https://antigravity.google/terms) 约束。
本产品只 spawn 该内核，不重新实现、不分发该二进制。

面向 Antigravity 的第三方工具可能违反上述条款并导致账号风险。优先使用官方 API
密钥。建议只用测试/备用账号。

**按现状提供，无担保。使用风险自负。**
