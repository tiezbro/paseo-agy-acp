<div align="center">

# 🔌 paseo-agy-acp

**Paseo × Antigravity — ACP 适配器**

[![License](https://img.shields.io/badge/license-Apache%202.0-blue?style=flat-square)](./LICENSE)
[![Version](https://img.shields.io/badge/version-1.0.0.4-blue?style=flat-square)](./package.json)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen?style=flat-square)](#)
[![ACP](https://img.shields.io/badge/ACP-v1%20%2B%20draft%20v2-8A2BE2?style=flat-square)](https://agentclientprotocol.com)

</div>

<div align="center">

[🇺🇸 English](./README.md) | [🇨🇳 中文](./README.zh-CN.md)

</div>

---

[Google Antigravity CLI](https://antigravity.google/product/antigravity-cli) 的 ACP 适配器。
基于 [`shindgew/agy-acp`](https://github.com/shindgew/agy-acp) 的社区衍生版本，针对
[Paseo](https://github.com/getpaseo/paseo) 日常使用进行了可靠性强化。

> **非 Paseo 官方支持。非 Google 官方支持。** 社区维护分支，使用风险自负。

## 📖 关于

| | |
|---|---|
| **维护者** | [tiezbro](https://github.com/tiezbro) |
| **仓库** | [github.com/tiezbro/paseo-agy-acp](https://github.com/tiezbro/paseo-agy-acp) |
| **上游** | [shindgew/agy-acp](https://github.com/shindgew/agy-acp)（Apache 2.0） |
| **许可证** | [Apache 2.0](./LICENSE) |

本项目构建于 [Shindge Wong](https://github.com/shindgew) 及上游贡献者的杰出工作之上。
原始 ACP 适配器架构的全部功劳归他们所有。

## ✨ 功能

### 🧬 继承自上游

| 功能 | 描述 |
|---|---|
| ACP v1 + draft v2 | 完整 ACP 协议支持，含降级协商 |
| PTY 会话管理 | 每会话一个 PTY，通过 `agy --print --conversation <id> --sandbox` |
| Protobuf 流式 | 从 SQLite protobuf 结构化解码步骤（不解析 stdout） |
| 会话模式 | `default`、`accept-edits`、`plan` 通过 `agy --mode` 透传 |
| 斜杠命令 | ACP 斜杠命令分发（`/mode` 等） |
| 工具调用 | `run_command`、`write_to_file` 等 Antigravity 工具 |

### 🔧 Paseo 新增

| # | 功能 | 描述 |
|---|------|------|
| 1 | Daemon 上下文桥接 | 将 `daemon.appendSystemPrompt` 前置到后端 prompt，让 Paseo 上下文传入 Antigravity |
| 2 | 权限权威决断 | ACP "拒绝"抑制后续 provider 成功行；已拒绝工具被追踪拦截 |
| 3 | 完成门控 | Turn 仅在最终 assistant 输出可见后才完成（忽略 progress/system 行） |
| 4 | 前台任务修复 | 带显式 `exitCode` + `task_details` 的命令不再卡在"活跃"状态 |
| 5 | 回滚容错 | 整文件回滚容忍 provider 添加的 `\n` / `\r\n` |
| 6 | 权限绕过 | 将 `--dangerously-skip-permissions` 暴露为 ACP mode id `dangerously-skip-permissions` |
| 7 | 测试覆盖 | 为所有 Paseo 专属路径扩展测试套件 |

→ [完整技术细节](./docs/PASEO_LOCAL_CHANGES.md)

## v2 Admission Controller 开发状态

v2.0.0.0 Admission Controller 已进入源码开发。它将为本机多个 connector
提供统一准入、保守崩溃恢复和容量错误分类，不修改官方 Paseo 或 Antigravity
endpoint。当前发布版本尚未把该 Controller 接入真实 prompt。

设计契约和发布门禁见
[`docs/design/v2.0.0.0-admission-controller.md`](docs/design/v2.0.0.0-admission-controller.md)。

## 🔧 解决的问题

上游 `agy-acp` 是通用适配器。本分支解决了 5 个 Paseo 专属的可靠性问题：

| # | 问题 | 解决方案 |
|---|------|----------|
| 1 | Paseo daemon 上下文对 Antigravity 不可见 | 桥接将 `daemon.appendSystemPrompt` 前置追加到后端 prompt；`PASEO_HOME` 可选，默认回退到 `~/.paseo` |
| 2 | 权限"拒绝"被延迟的 provider 成功消息覆盖 | 权威拒绝追踪，拒绝后抑制成功行 |
| 3 | Turn 在最终 assistant 消息出现前就关闭 | `turnCompleteCandidate` 要求可见的终端输出 |
| 4 | 带退出码的前台命令仍显示为"活跃"后台任务 | `task_details` + `exitCode` 行不再视为后台任务 |
| 5 | 整文件回滚因 provider 添加的换行符而失败 | 对整文件写入操作容忍 `\n` / `\r\n` |
| 6 | Paseo 无法选择 Antigravity 的无人值守权限绕过 | 将官方 `--dangerously-skip-permissions` 参数暴露为 ACP mode id `dangerously-skip-permissions` |

→ [完整技术细节](./docs/PASEO_LOCAL_CHANGES.md)

## ⚡ 快速开始

```bash
git clone https://github.com/tiezbro/paseo-agy-acp.git
cd paseo-agy-acp
npm ci
npm run build
npm test
```

**要求：** Node.js >= 22，`agy` CLI（首次运行时自动安装）。

## 🌍 环境变量

| 变量 | 用途 |
|---|---|
| `PATH` | 需包含 `agy` 和 `node` |
| `AGY_BIN` | 覆盖 `agy` 二进制路径 |
| `PASEO_AGENT_ID` | Agent ID；启用 daemon 上下文桥接 |
| `PASEO_HOME` | 可选 Paseo 主目录覆盖；未设置或为空时回退到 `~/.paseo` |

## 🏗️ 架构

```
Paseo / ACP 客户端
  └─ paseo-agy-acp（ACP v1 或草案 v2）
       └─ agy --print --conversation <id> --sandbox
            └─ ~/.gemini/antigravity-cli/conversations/<id>.db  ← 结构化 protobuf
       └─ StreamPoller + Translator → ACP 通知
```

每会话一个 PTY。步骤从 SQLite protobuf 解码，不解析 stdout。
`--sandbox` 默认开启。配置项：`mode`、`model`、`reasoningEffort`。
`dangerously-skip-permissions` mode 直接映射到 Antigravity CLI 官方
`--dangerously-skip-permissions` 参数，不经过自定义的 "full access" 名称转义。
当该绕过模式生效时，`paseo-agy-acp` 也会禁用自身的 completed-edit
事后审查桥接，避免 Antigravity 已经完成写入后，Paseo 侧又弹出额外 ACP
批准面板。

Paseo daemon 上下文会前置到发送给 `agy` 的后端 prompt。Antigravity CLI
当前没有逐调用 system/developer prompt 参数，因此这是模型可见的 prompt
桥接，不是真正的原生 system-role 消息。

当 `agy models` 输出 `modelId<TAB>显示名称` 两列时，本适配器会优先使用
provider 原生 model id。这样 Paseo 中的 `gemini-3.1-pro` + `high` 会映射到
Antigravity 的精确 variant id，不会把显示名称混进模型名，也不会额外追加不被
支持的 `--effort` 参数。

## 🔌 Paseo Provider 配置

```json
{
  "providers": {
    "antigravity": {
      "type": "acp",
      "command": "node",
      "args": ["/path/to/paseo-agy-acp/dist/main.js"]
    }
  }
}
```

`bin` 名称保持 `agy-acp` 以保证向后兼容。

## 💬 初始化 Prompt

粘贴到任意 Paseo agent 中以安装或修复 Antigravity provider：

~~~
配置 Paseo daemon，添加 Google Antigravity 的 ACP provider。

1. 读取 Paseo 配置（$PASEO_HOME/config.json 或 ~/.paseo/config.json）。
2. 添加或更新 providers.antigravity：
   - type: "acp"
   - command: agy-acp 二进制路径（如 "agy-acp" 或 dist/main.js 完整路径）
   - args: []
3. 如 agy-acp 未安装：cd paseo-agy-acp && npm ci && npm run build
4. 确保 agy CLI 已安装：curl -fsSL https://antigravity.google/cli/install.sh | bash
   然后：agy auth login
5. 重启 Paseo daemon。
6. 验证：用 provider "antigravity" 创建测试 agent，发送简单 prompt。
~~~

## ✅ 验证

```bash
# 冒烟测试
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1}}' \
  | node dist/main.js

# 完整测试套件
npm test
```

金丝雀检查清单：权限拒绝、多轮对话、长 prompt + daemon 上下文、前台命令、整文件编辑。

## ⚠️ 已知问题

当 `PASEO_AGENT_ID` 指向一个真实 Paseo agent state 时，原始 prompt 测试可能看到前置的 daemon 上下文。

```bash
env -u PASEO_AGENT_ID -u PASEO_HOME npm test
```

这只会在测试进程中禁用 bridge。

## 🔄 升级 / 回滚

```bash
# 升级
git pull && npm ci && npm run build && npm test

# 回滚
git checkout <版本> && npm ci && npm run build && npm test
```

将 daemon 指向目标版本的 `dist/main.js` 并重启。

## ⚖️ 免责声明

使用第三方工具访问 Antigravity 可能违反 [Google 服务条款](https://antigravity.google/terms)，
有账户暂停风险。优先使用官方 API 密钥。仅限测试/备用账户使用。

**按原样提供，无任何担保。使用风险自负。**
