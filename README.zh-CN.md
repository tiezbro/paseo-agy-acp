# paseo-agy-acp

与 Paseo 内置 Antigravity 共存，同时登录两个 Antigravity Pro 账号

[![License](https://img.shields.io/badge/license-Apache%202.0-blue?style=flat-square)](./LICENSE)
[![Version](https://img.shields.io/badge/version-2.7.1-blue?style=flat-square)](./package.json)
[![npm](https://img.shields.io/npm/v/paseo-agy-acp?style=flat-square)](https://www.npmjs.com/package/paseo-agy-acp)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen?style=flat-square)](./package.json)
[![ACP](https://img.shields.io/badge/ACP-NDJSON%20v1-8A2BE2?style=flat-square)](https://agentclientprotocol.com)

[English](./README.md) | [中文](./README.zh-CN.md) | [Changelog](./CHANGELOG.md)

Paseo 从 v0.11.0 起内置了 Antigravity provider。`paseo-agy-acp` 作为独立
provider 和它共存，Paseo 就可以同时登录两个 Antigravity Pro 账号，把日常工作
分给不同的账号来调度。

**上游运行时：Registry `antigravity-acp` 1.4.3。** v2.7.1 修复 Admission 事务争锁，
补充真实 Paseo 0.13.2 客户端契约与作者本地跨主机验收记录，保留协议生命周期加固、只读技能资源、
模型跟踪、诊断能力和工作区完整性修复。

![Paseo 中 Antigravity 与 Antigravity Pro 同时可用](./docs/images/antigravity-and-antigravity-pro.png)

设置列表里看到的是显示名称。写 `config.json`、创建 agent 时填写 provider id。

| | **Antigravity Pro**（本适配器） | **Antigravity**（Paseo 内置） |
| --- | --- | --- |
| 显示名称 | Antigravity Pro | Antigravity |
| provider id | `paseo-agy-acp` | `antigravity` |
| 进程 | 官方 ACP 内核 `agy_acp_server` | 宿主机 `agy`（从 `PATH` 查找） |
| 登录 | `~/.gemini/antigravity-acp` | `~/.gemini/antigravity-cli` |

<!-- readme:positioning -->
## 这个产品是什么

`paseo-agy-acp` 是 Paseo 与 Google 官方 Antigravity ACP 内核之间的产品适配层。
认证、模型、工具、MCP 和推理仍由官方内核负责；本适配器补齐 Paseo 多 agent
可靠运行所需要的上下文、协议兼容、并发治理、skill discovery 和失败语义。

它不是第二个 Antigravity 实现，也不重新分发 Google 的专有内核。npm 包只包含
这个 Apache-2.0 代理；官方内核需要单独在本机安装和认证。

> 社区维护项目。非 Paseo 官方支持，非 Google 官方支持。

<!-- readme:value -->
## 为什么需要 paseo-agy-acp

ACP 提供协议，但一条可用于生产的 Paseo provider 仍需要协议之外的产品行为：

| 需求 | 直接连接 Generic ACP | 使用 `paseo-agy-acp` |
| --- | --- | --- |
| 官方执行链 | 可以启动 ACP server | OAuth、模型、工具、MCP 和推理继续留在 Google 官方内核 |
| Paseo 上下文 | 没有产品级保证 | 将 Paseo daemon 与 workspace/agent context 注入官方 prompt |
| Modes 与 MCP | 客户端和内核数据形态可能不同 | 映射 Paseo modes，保留原生 MCP `http` / `sse`，仅做必要的协议兼容 |
| 多 agent 突发 | 多个 prompt 可能同时打入内核 | 使用跨 connector 共享的账户级持久 Admission 队列 |
| Slash command discovery | 官方命令更新不包含本地 skills | 加入可由用户调用的 Gemini、Agents、Codex、配置和 workspace skills |
| 空白回合 | 无输出的 `end_turn` 可能看起来成功 | 返回明确 JSON-RPC 错误，避免记录静默成功 |
| 额外授权模型 | 官方 ACP 默认走 Gemini 系路径 | 为有资格的 Claude 4.6 与 GPT-OSS 120B 提供显式本机兼容 runbook |
| 产品身份 | 跟随底层 server | 向 Paseo 暴露稳定的 `agy-acp` / `paseo-agy-acp` 身份 |

### 多 agent 稳定性

Paseo 主控可以一次委派多个 Antigravity agent。Admission 允许主控保留这种批量
派发能力，同时让超额 turn 排队，而不是一起写入 `agy_acp_server`。使用同一状态
目录的所有 connector 共享账户席位，回合完成、失败或取消后释放。

实测默认策略是 **8 个 active turns / 8 路同时启动 / 最少 2 秒启动间隔**。
这些是可调整的运行默认值，不是对 Google 产品上限的声明。启用后的非法配置会
fail closed。

### Skill discovery

适配器将原生 ACP 命令与配置目录及默认 Gemini、Agents、Codex、workspace roots
中的 `SKILL.md` 元数据合并。同名时原生命令优先，workspace skills 优先于全局
skills，`user-invocable: false` 不会出现在 slash command 提示中。Discovery 按
session cwd 隔离，并发 workspace 不会互相泄漏命令元数据。

### 模型边界

未修改的官方 ACP 路径默认以 Gemini 系模型为工作集合。已获得 Claude 4.6 或
GPT-OSS 120B 资格的账号，可以按
[官方内核兼容 runbook](docs/operations/official-kernel-compat-runbook.md)
显式启用本机兼容生命周期。推理仍由同一套官方内核和 Google backend 负责；本仓库
不打包也不替换它们。

<!-- readme:architecture -->
## 架构与职责

```text
Paseo / Generic ACP client
  -> paseo-agy-acp 产品适配器
       身份 | daemon context | mode map | MCP rewrite
       skill hints | blank-turn guard | 可选 Admission fence
  -> 官方 agy_acp_server（ACP v1 over NDJSON）
       OAuth | 模型 | 工具 | MCP | 推理
```

| 层 | 职责 | 许可证边界 |
| --- | --- | --- |
| Paseo | Agent 生命周期、workspace、委派和 provider 配置 | Paseo 项目 |
| `paseo-agy-acp` | Paseo 专用 ACP 适配与 Admission | Apache-2.0；发布到 npm |
| 官方 `agy_acp_server` | 认证、模型目录、工具、MCP 和推理 | Google 专有软件；只在本机安装 |

每个 connector 进程运行一个官方内核子进程。Admission 是可选项，但当一个
Antigravity 账号服务多个并发 Paseo agent 时建议启用。

CI 使用真实 Paseo 0.13.2 ACP 客户端、隔离内核和本地 HTTP MCP 服务验证适配器，
不运行 Google 账号、真实 Paseo daemon 或跨主机部署。

作者报告曾用事务修补源码完成 Gemini / Claude 跨 VM 委派与后续消息，以及 Gemini
取消和主机重连。这些属于**作者本地验收，未纳入 CI**；原始环境证据未公开，维护者尚未
独立复现，不能视为产品保证。UI、账号隔离、Paseo 0.12.0 和其他操作系统未重新验收。
详见[验收范围](docs/operations/paseo-adapter-verification.md)与
[跨主机指南](docs/operations/paseo-cross-host-e2e.md)。

<!-- readme:requirements -->
## 环境要求

- **Paseo** v0.12.0 或更新版本，支持自定义 ACP provider
- **Node.js 22 或更新版本**
- Linux x86_64 托管兼容层需使用普通用户运行
- 可以完成官方 `oauth-personal` 的 Antigravity 账号
- 启用 Admission 时，系统需支持 Linux 文件 owner 与 mode

首次启动时，适配器按当前操作系统从 Google 下载对应的官方 Antigravity ACP 1.4.3
包。npm 包本身不包含这些内核。Linux x86_64 还会装上本机兼容包装器。
`PASEO_AGY_ACP_OFFICIAL_BIN` 留空，或继续指向托管包装器即可。指向其他已存在路径时，
按该路径启动。

<!-- readme:quickstart -->
## 快速开始

### 1. 完成认证

```bash
npx -y paseo-agy-acp@2.7.1 --login
```

第一次运行会下载并配置官方内核 1.4.3。下载约 320 MiB，放在 `~/.local/opt/`。

OAuth 由官方内核完成。Token 保留在内核自己的状态中，本适配器不会打印。

无桌面的 VM 可在电脑浏览器打开授权链接，再把完整的 localhost 回调地址粘贴回
同一个 VM 终端。登录与运行 provider 应使用同一 Linux 用户。网络需要代理时，
登录命令和 provider 都要配置代理，见下文。

### 2. 准备 Admission 状态

单 agent 可以不启用 Admission；多 agent 委派建议启用。

```bash
export AGY_ACP_STATE_DIR="$HOME/.local/state/paseo-agy-acp/account-name"
install -d -m 700 "$AGY_ACP_STATE_DIR"
npx -y --package=paseo-agy-acp@2.7.1 \
  agy-acp-prepare-state "$AGY_ACP_STATE_DIR"
```

每个 Antigravity 账号使用一个 owner-only 状态目录。预检会创建或验证目录，并拒绝
已经存在的宽权限路径。

### 3. 配置 Paseo provider

在 `$PASEO_HOME/config.json` 或 `~/.paseo/config.json` 中增加或更新 provider。
provider id 是 `agents.providers` 下的键：

```json
{
  "agents": {
    "providers": {
      "paseo-agy-acp": {
        "extends": "acp",
        "label": "Antigravity Pro",
        "command": ["npx", "-y", "paseo-agy-acp@2.7.1"],
        "env": {
          "AGY_ACP_ADMISSION_ENABLED": "true",
          "AGY_ACP_STATE_DIR": "/home/YOU/.local/state/paseo-agy-acp/account-name"
        }
      }
    }
  }
}
```

自定义 ACP provider 需要声明 `extends: "acp"` 和 `label`。
provider id 必须匹配 `^[a-z][a-z0-9-]*$`，`paseo-agy-acp` 符合。

Paseo 会向 provider 进程提供 `PASEO_AGENT_ID` 和 `PASEO_AGENT_CWD`。只有在明确
需要不受 Admission 约束的单 agent 运行时，才省略两个 Admission 变量。

#### 与 Paseo 内置 Antigravity 共存

显示名、provider id、登录目录和截图见文首。上面的 JSON 里，键是
`paseo-agy-acp`，`label` 是 `Antigravity Pro`。

如果本适配器原先配置在 `antigravity` 键下，必须把该键改名为
`paseo-agy-acp`。旧键仍然存在时，Paseo 会隐藏内置 Antigravity provider，并把
`antigravity` 这个 id 路由给本适配器。

### 4. 重新加载并验证

运行 `paseo reload`，再创建 provider 为 `paseo-agy-acp` 的 agent，选择受支持模式
并发送一个简单 prompt。`npx` 启动的是 Paseo 使用的 stdio ACP server，不是独立
聊天程序。

<!-- readme:configuration -->
## 配置

### 必要环境变量

| 变量 | 作用 |
| --- | --- |
| `PASEO_AGY_ACP_OFFICIAL_BIN` | 官方 kernel wrapper 或 `.par` 的绝对路径 |
| `PASEO_HOME` | 可选 Paseo home；默认 `~/.paseo` |
| `AGY_ACP_ADMISSION_ENABLED` | `true` / `1` 启用 prompt fence |
| `AGY_ACP_STATE_DIR` | 一个账号共享的 owner-only 绝对状态目录 |

高级席位、启动限速、排队超时、cooldown、权限、恢复和 policy 变更流程见
[Admission 运维](docs/operations/admission.md)。

### 网络代理

需要代理时，在 provider 的 `env` 中配置 `HTTP_PROXY`、`HTTPS_PROXY`、
`http_proxy` 和 `https_proxy`，并将 `NO_PROXY`、`no_proxy` 设置为
`localhost,127.0.0.1,::1`，按需补充直连主机地址。
代理地址必须在每台机器上可达；`127.0.0.1` 始终指当前机器。
登录终端中的环境变量不会自动应用到已经运行的 Paseo daemon。完整示例见跨主机指南。

### Mode 映射

| Paseo 或旧 id | 官方在线 mode |
| --- | --- |
| `default` | `default` |
| `accept-edits` | `auto_edit` |
| `dangerously-skip-permissions` | `yolo` |
| `plan` | `default`（官方内核没有 plan mode） |

官方 `yolo` 与 Paseo 的 Auto Accept（`features.auto_accept`）是两套独立开关。
未应答的 `session/request_permission` 会让 `session/prompt` 一直保持打开，
因此即使 assistant 文本已经可见，agent 仍可能保持 `running`。无人值守运行时，
请打开 Auto Accept，或用 `paseo permit ls` / `paseo permit allow` 批准，
并在需要内核跳过工具确认时使用 `yolo`。本适配器不会把已显示的文本当成
`end_turn`。见 [#11](https://github.com/tiezbro/paseo-agy-acp/issues/11)。

`PASEO_AGY_ACP_KERNEL=legacy` 和 `--legacy-kernel` 会 fail closed。官方内核是唯一
执行路径。

### Skill roots

Discovery 合并配置目录和 workspace、全局 Gemini、Agents、Codex 及 Paseo
兼容目录，并尊重 `GEMINI_HOME` 和 `PASEO_HOME`。Paseo 文档列出的安装位置包括
`.agents/skills`、`.claude/skills` 和 `.codex/skills`；`.paseo/skills` 是额外兼容
目录。每个 skill 需要带有可用 name 与 description 的 `SKILL.md` frontmatter。
按会话隔离的 `paseo_skills` MCP server 提供 `list_skills` 与 `read_skill`，让内核
实际读取已发现技能正文及相对资源文件，无需复制到工作区；读取范围限制在已发现
技能目录内，每个文件最多 1 MiB。

排队 notice、可选 stderr 诊断、原生 context 开关与真实 Paseo 待验收流程见
[适配器验收](docs/operations/paseo-adapter-verification.md)。

<!-- readme:operations -->
## 运维与故障排查

运行 `paseo-agy-acp --doctor` 可只读检查本地内核执行文件与托管收据，输出 JSON；
`ready` 为 false 时退出码为 1，认证和 daemon 状态保持 `not_checked`。启动 agent
前，可显式运行 `paseo-agy-acp --prepare-kernel` 安装或校验托管内核。

- `npx` 安装代理包；`--prepare-kernel`、`--login` 或首次协议启动会另外下载托管
  官方内核。
- npm 首次运行可能编译 `better-sqlite3`，需要本机 C++ 工具链。
- 修改 provider command、环境变量或内核路径后运行 `paseo reload`，配置对后续启动
  生效；已经运行的 agent 进程保留原配置。见
  [Paseo 自定义 provider 文档](https://paseo.sh/docs/custom-providers)。
- 已启用 Admission 但 identity 缺失、状态权限不安全或 policy 非法时，系统拒绝启动，
  不会静默变成 unfenced 运行。
- assistant 文本已经可见但 turn 仍 `running`，通常是未处理的权限卡片，而不是内核
  丢失完成态。检查 Auto Accept 和 `paseo permit ls`。Paseo 的 `Worked for …`
  是墙钟时间，权限等待也会计入。
- 工具质量、生图、backend 配额与 provider 错误文案仍由官方内核和 Google backend
  负责。
- 可复现升级或回滚应在 provider command 中固定三段 npm 版本，然后运行
  `paseo reload` 并启动新 agent。

当前运维入口：

- [Admission 运维](docs/operations/admission.md)
- [Claude / GPT-OSS 本机兼容](docs/operations/official-kernel-compat-runbook.md)
- [跨主机部署、代理与端到端验收](docs/operations/paseo-cross-host-e2e.md)
- [npm Trusted Publishing](docs/operations/npm-publishing.md)
- [Changelog](CHANGELOG.md)
- [GitHub Releases](https://github.com/tiezbro/paseo-agy-acp/releases)
- [Issue tracker](https://github.com/tiezbro/paseo-agy-acp/issues)

详细实现与研究记录保留在 `docs/design/`、`docs/evidence/` 和 `docs/research/`；它们
不是发布历史或安装说明。

<!-- readme:development -->
## 开发

```bash
git clone https://github.com/tiezbro/paseo-agy-acp.git
cd paseo-agy-acp
npm ci
npm run validate
```

官方内核 smoke 还需要 `PASEO_AGY_ACP_OFFICIAL_BIN`：

```bash
node scripts/official-kernel-smoke.mjs
```

<!-- readme:license -->
## 许可证与免责声明

适配器源码使用 [Apache-2.0](LICENSE)。官方 Antigravity 内核不包含在本项目中，
并继续受 [Google Antigravity 条款](https://antigravity.google/terms) 约束。本社区
项目只 spawn 你在本机安装的内核，不重新实现、不重新授权、不重新分发该软件。

第三方使用可能带来账号或服务风险。应使用经过授权的账号与官方凭据。本软件按现状
提供，不作任何担保。
