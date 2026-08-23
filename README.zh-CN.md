<div align="center">

# 🔌 paseo-agy-acp

**Paseo × Antigravity — 官方 ACP 内核产品适配器**

[![License](https://img.shields.io/badge/license-Apache%202.0-blue?style=flat-square)](./LICENSE)
[![Version](https://img.shields.io/badge/version-2.1.0.0-blue?style=flat-square)](./package.json)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen?style=flat-square)](#)
[![ACP](https://img.shields.io/badge/ACP-NDJSON%20v1-8A2BE2?style=flat-square)](https://agentclientprotocol.com)

</div>

<div align="center">

[🇺🇸 English](./README.md) | [🇨🇳 中文](./README.zh-CN.md)

</div>

---

`paseo-agy-acp` 是面向 Paseo 的 ACP 产品。**ACP 协议执行已经换成 Google 官方
Antigravity ACP 内核**（`agy_acp_server` / Registry id `antigravity-acp`）。
本仓库是一层 NDJSON 代理，加上 Paseo 产品行为（Admission、daemon 上下文、身份、
模式/MCP 改写）。它**不是**对 `agy` CLI 的 PTY/SQLite 刮取，也**不再**是
`shindgew/agy-acp` 的内核 fork。

> **非 Paseo 官方支持。非 Google 官方支持。** 社区维护产品，使用风险自负。

## 关于

| | |
|---|---|
| **维护者** | [tiezbro](https://github.com/tiezbro) |
| **仓库** | [github.com/tiezbro/paseo-agy-acp](https://github.com/tiezbro/paseo-agy-acp) |
| **ACP 内核** | Google 官方 Antigravity ACP 服务器（本机 spawn，不随包分发） |
| **产品许可证** | [Apache 2.0](./LICENSE) |

## 许可证（请先读）

| 层 | 许可证 | 我们怎么做 |
|---|---|---|
| **本仓库**（产品源码、Admission、代理） | **Apache-2.0** | **保持 Apache-2.0，不改开源协议。** |
| **官方 ACP 内核**（`agy_acp_server.par` / `antigravity-acp`） | **专有软件**（非开源，受 Antigravity ToS 约束） | 我们只 **spawn** 你本机已安装的内核。npm 包 **不** 附带约 1.5GiB 的 `.par`。 |
| **ACP 协议 / `@agentclientprotocol/sdk`** | 独立的 Apache-2.0 生态 | 官方 NDJSON 代理运行时不依赖它。 |

**不要**为了“对齐官方内核”而改本项目的 SPDX 许可证。官方内核不是开源的；
Admission / Paseo 上下文 / 代理等 Apache-2.0 代码也不能在未删除或未获授权的
情况下改成别的协议。

第三方用 PTY 包装 `agy -p` 是另一类 ToS 风险。本产品的内核是 Google **原生
ACP 服务器**，不是 CLI 刮取。

## 2.1.0.0 是什么

```
Paseo Generic ACP (NDJSON)
  → paseo-agy-acp 产品代理
      → 官方 agy_acp_server (NDJSON)
```

产品代理会：叠加产品身份、注入 daemon `appendSystemPrompt`、映射 session 模式
（`accept-edits` → `auto_edit`，`dangerously-skip-permissions` → `yolo`，
`plan` → `default`）、把 MCP `http` 改写成 `sse`、在启用时把 Admission 围栏
加在官方 `session/prompt` 写入上、拒绝无可见输出的空白 `end_turn`。

PTY/SQLite 刮取内核已经 **删除**。没有 `--legacy-kernel` /
`PASEO_AGY_ACP_KERNEL=legacy` 逃生门。

## 环境要求

- Node.js >= 22
- 本机已安装官方 Antigravity ACP 内核。本机默认 pin：

  `~/.local/opt/agy-acp-server-agy_acp_server_20260818_01_RC01/agy-acp-server-canary`

  用 `PASEO_AGY_ACP_OFFICIAL_BIN` 覆盖。`.par` 在本机需要 `--uid=`。
- 已完成官方 `authenticate`（`methodId=oauth-personal`）。

## 快速开始

```bash
git clone https://github.com/tiezbro/paseo-agy-acp.git
cd paseo-agy-acp
npm ci
npm run build
npm test
node 'dist/ACP Connector/main.js' --login
```

## Admission Controller v2

账户级持久队列默认 **开着**。队列的一个实际好处是：**Paseo 委派 Antigravity
更稳健**——多出来的 turn 会排队等待，而不是一齐打到官方 ACP 内核上。

**默认值来自实测，不是官方宣称的上限：** **8 个共享 active 席位**、
**8 路同时启动**、启动间隔 **2 秒**。生产环境对默认 8 做过 10 个
Antigravity agent 的派发，没有复现旧刮取内核的挂死。

这 8 **不是** 已经拍板的产品上限。把下面两个环境变量设成任意 **≥ 1**
的整数，就可以自己测更高（或更低）并发；测到真实上限或稳定更高值，欢迎反馈。
官方 ACP **并未** 被证明无限并发。

**背景：** 旧的 3+1 是为了缓解已删除的 PTY/SQLite 刮取内核在相邻 `agy -p`
负载下挂死。隔离环境 `127.0.0.1:6768` 上 6 路 yolo 压测没有复现该挂死。
3+1 仍可作为更紧的覆盖，但不是推荐默认：

```bash
AGY_ACP_ADMISSION_MAX_ACTIVE_TURNS=3
AGY_ACP_ADMISSION_MAX_CONCURRENT_STARTS=1
```

相关环境变量：`AGY_ACP_ADMISSION_MAX_ACTIVE_TURNS`、
`AGY_ACP_ADMISSION_MAX_CONCURRENT_STARTS`（整数 ≥ 1，默认 8）。
官方内核 Admission 状态隔离在 `$AGY_ACP_STATE_DIR/official-kernel`，
不与历史刮取账本共用。

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

**按现状提供，无担保。使用风险自负。**
