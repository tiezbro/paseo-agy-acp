# paseo-agy-acp

[English](./README.md) | [中文](./README.zh-CN.md) | [Türkçe](./README.tr.md) | [Changelog](./CHANGELOG.md)

`paseo-agy-acp` 将 Google 官方独立 Antigravity ACP 内核接入 Paseo。[最新稳定版（`2.11.1`）](https://github.com/tiezbro/paseo-agy-acp/releases/tag/v2.11.1)锁定 [Google 官方 `agy_acp_server` `1.5.2`](https://github.com/tiezbro/paseo-agy-acp/blob/v2.11.1/ACP%20Connector/official-kernel/ensure-managed-kernel.ts#L18)。Linux x86_64 托管安装会附加兼容层，无需修改 Paseo。

<!-- readme:positioning -->
## 产品定位

在 Paseo 中选择 **Antigravity Pro** 即可启动 `paseo-agy-acp`，它可与内置的 **Antigravity**（`antigravity`）并存。Antigravity Pro 基于官方 ACP 1.5.2 内核（Linux x86_64 托管运行目录包含兼容补丁），内置 provider 则调用主机上的 `agy`。

![Paseo 中 Antigravity Pro 与内置 Antigravity 并存](./docs/images/antigravity-and-antigravity-pro.png)

Google 内核负责账号认证、模型、工具、重试与会话历史；适配器向内核传入 Paseo 的工作目录、背景说明与技能，并将回复、权限请求与错误传回 Paseo。本项目为社区项目，Google 内核需单独下载。

<!-- readme:value -->
## 为什么用 paseo-agy-acp

适配器以官方 1.5.2 为基准，保留官方模式、重试和取消。官方已经提供的规则文件、路径策略、企业配额显示和许可证区域由内核执行。Linux x86_64 托管兼容层仍恢复账号可用的受支持模型，通过工具呈现技能，并观察内核事件。用户只需安装这个包，无需修改 Paseo；连接使用真实客户端身份。

新架构带来的结果：

- 直接连接官方独立 ACP 内核，与本机另装的 `agy` CLI 分开运行。
- Linux x86_64 托管运行时可显示内核安排的重试或观测到的 HTTP 503，本轮继续。
- `max_tokens`、`max_turn_requests`、`refusal` 显示成失败，不再看起来像成功。
- 保留具体模型选项；托管兼容层通过技能工具提供内置技能，避免自动向工作区写入技能文件。

### 能力对比

#### 能力表基线

- **Paseo 内置 Antigravity：** [Paseo `0.18.1`](https://github.com/getpaseo/paseo/releases/tag/v0.18.1) + [Google Antigravity CLI（`agy`）`1.5.18`](https://github.com/google-antigravity/antigravity-cli/releases/tag/1.5.18)，通过 `agy acp` 启动。
- **Antigravity Pro：** 同一个 Paseo `0.18.1` + [`paseo-agy-acp` `2.11.1`](https://github.com/tiezbro/paseo-agy-acp/releases/tag/v2.11.1) 及同版本 `2.11.1` 配套插件 + Google 官方独立 ACP 内核 `1.5.2`（`agy_acp_server`）。

`agy` 和 `agy_acp_server` 是 Google 分开发布的两套程序，版本号各自独立。Linux x86_64 托管兼容层的行为在表中单独标明。对照基于发布源码、官方文档和所附验收记录，不代表同一账号的全项实测。

| 能力点 | Paseo 内置 Antigravity | Antigravity Pro（paseo-agy-acp） |
| --- | --- | --- |
| 启动与安装 | Provider 随 Paseo 提供，调用另装的官方 `agy acp`；Paseo 0.18.1 要求 CLI 至少为 1.5.1。 | Paseo 启动适配器，再启动独立的 `agy_acp_server`。支持 `--doctor`、托管准备和指定内核路径。适配器、插件、内核分别维护。 |
| Google 登录与数据 | 复用 CLI 登录，SSH 和非 SSH 环境可能读取不同的凭据。 | `--login` 为独立内核办理个人 OAuth。凭据和会话与 CLI 分开，默认在 `~/.gemini/antigravity-acp`。 |
| 无人值守认证 | Paseo 文档建议定时或无人值守运行使用 API Key 或 Agent Platform。 | 自带 `--login` 只办理个人 OAuth；等价的 API Key 或 Agent Platform 配置未在此验证。权限模式不会改变 Google 的账号规则。 |
| 模型目录 | 使用已登录账号经 `agy` 在 ACP 中公布的模型。 | 使用独立内核的目录。Linux x86_64 托管兼容层补回账号实际提供的受支持 Claude/GPT 条目，保留上游禁用检查。没有同账号实测两边的目录差异。 |
| 模型缓存与刷新 | 在 0.18.1 中，Paseo 重启后可复用目录缓存，按需刷新，不做后台轮询。 | 0.18.1 上的配套插件使用同一 ACP SDK 的按需目录策略。 |
| 思考档位 | 分别探测各模型公布的档位，不把默认模型的档位套给其他模型。 | 透传原生档位，包括模型实际提供的 Extra High。配套插件未启用内置版的逐模型目录探测。 |
| 分组显示与固定档模型 | 使用 SDK 的模型与思考档控件；模型没有公布档位时，可能不显示档位选项。 | 协议回包保留分组 `configOptions`，但 0.18.1 的插件 SDK 会展开选项。固定档显示逻辑只识别 `Paseo`，0.18.1 插件宿主发送的是 `paseo`，所以该接法不触发；该逻辑本身也不改变真实思考档。 |
| 权限模式 | 提供 CLI 原生模式，包括 Default、Accept edits、Plan，以及 Paseo 默认的 Full access；后者可对符合条件的请求代选 Allow once，CLI 策略仍生效。 | 内核提供 Default、Auto Edit 和 YOLO。YOLO 是内核模式，`/plan` 是命令，两者都不等于内置版的 Full access。 |
| 工具审批与取消问答 | 把工具审批交给 Paseo；停止一轮时清理尚未作答的审批。 | 转交内核的权限选项。1.5.2 负责取消未作答的请求；如果选择题仍发给客户端，YOLO 本身不会代答。未验证原生问答表单是否等价。 |
| 工作区信任与钩子 | 有通用 ACP 权限接口；未单独验证工作区信任和钩子流程。 | 内核信任请求可走普通权限通道；未单独验证 Paseo 0.18.1 中的呈现是否等价。 |
| 会话列表和导入 | 能列出和导入 CLI 保存的对话；上游迁移验收使用了真实 CLI。 | 转发 `session/list`，内核声明支持时，插件 SDK 可以列出和导入。两边的历史分开，未验证跨 Provider 导入。 |
| 冷恢复与历史重放 | 用 `session/load` 加载已保存的会话，兼容旧 Provider 保存的会话 ID，并等待 200 毫秒接收晚到的历史事件。 | 配套插件也用 `session/load`，但没加内置版的等待窗口。适配器可以转发客户端发来的 resume 请求，当前 SDK 不把它作为独立的恢复路径。 |
| 停止与恢复 | 发送 ACP 取消请求；对 CLI 已回包但工具仍在运行的情况有专门处理。 | 也转发取消；本地取消后若内核回 `end_turn`，校正为 `cancelled`。已派发请求默认 30 秒未确认取消时关闭连接。 |
| 追问与并发 | 对仍有工具运行的延迟结束轮次提供专门的追问处理，也对周期调度作区分。 | 同会话拒绝重叠请求，不在不同会话之间做全局排队。插件没有启用内置版的延迟轮次处理。 |
| 工作目录和额外目录 | SDK 发送 `cwd`；标准会话请求不发送 `additionalDirectories`。 | 没收到工作目录时由 `PASEO_AGENT_CWD` 兜底；可透传 ACP 客户端已发来的 `additionalDirectories`，配套插件仍使用同一 SDK。 |
| 会话背景指令 | CLI 声明支持时，在建立或加载会话时使用原生追加指令。 | 默认每轮在消息前附加 daemon 说明；设置 `PASEO_AGY_ACP_NATIVE_SYSTEM_CONTEXT=1` 且内核支持时，改为在打开会话时追加。 |
| 斜杠命令与技能 | 显示 CLI 公布的命令和技能，在菜单区分两者，并等待首批菜单。 | 保留内核命令，追加 Paseo、Agents、Codex、Claude、Gemini 等位置发现的本地技能，同名时内核优先。给会话提供列出和读取技能的工具；Linux x86_64 托管兼容层也通过工具提供内置技能，不自动把技能文件写入工作区。 |
| 图片与其他附件 | SDK 直接发送 ACP 图片块，其他输入块类型会转成文本。 | 同受 Paseo SDK 限制；直连 ACP 的客户端可传原生资源块。能上传文件不意味着 Paseo 原生支持 PDF 或音频输入。 |
| MCP | 把给 Agent 配置的 MCP 服务交给 `agy`；上游真实验证过 stdio 工具及其审批。 | 接收会话配置，保留 stdio，规范化请求头，并通过本地协议桥转接 HTTP/SSE URL。未逐项验证远端服务兼容性。 |
| 流式输出与工具卡 | 正文和模型报告的思考分开展示；针对 CLI 映射命令、输出、退出码、文件、搜索及 MCP。 | 转发正文、内核报告的思考和工具事件。配套插件使用通用 ACP 工具卡，未复用内置版的专用映射。 |
| 上下文与 token | 共用 SDK 读取上游报告的 token 数及上下文窗口用量。 | 由同一 SDK 读取内核字段。这是会话用量，和账号剩余额度是两回事。 |
| Paseo Usage 额度卡 | 上游在 0.17.6 移除；0.18.1 没有这张卡。 | 配套插件在 2.11.1 移除。只升级 CLI 不会移除已安装的 2.11.0 插件里的后台来源。 |
| 手动账号命令 | 官方 `agy` 终端提供 `/usage` 和登录管理；Paseo 的 ACP 菜单以 `agy` 实际公布的命令为准。 | 独立内核的 `/usage` 和 `/logout` 与已移除的额度卡无关；消息前置 daemon 说明可能使它们不能作为独立命令识别。适配器仍保留兼容入口 `--usage`；个人 OAuth 用户应使用 Google 官方额度界面。 |
| 未完成的停止原因 | 在 SDK 的普通消息路径中，成功回包即使带 `max_tokens`、`max_turn_requests` 或 `refusal` 也会标为完成；ACP 错误回包则标为失败。 | 将上述原因转成 ACP 错误，并保留原值 `error.data.stopReason`。 |
| 空白结束 | 未在内置 Provider 或普通消息路径中发现同样的空白成功检查。 | 内核回成功结束，但没有可见回答或工具活动时，返回明确错误。 |
| 重试、HTTP 503 与终止失败 | 依赖 `agy` 通过 ACP 上报的状态和错误，没有配置同类内核事件观察器。 | Linux x86_64 托管版可提示内核明确安排的重试或观测到的 HTTP 错误（如 503），本轮继续。HTTP 错误本身不等于重试；观察器也可纠正部分被回报为 `end_turn` 的失败。 |
| 系统消息封套和轮播文本 | 未在内置适配中找到等价的封套与轮播转换。 | 将 `SYSTEM_MESSAGE` 封套和轮播格式转换为可读 ACP 文本；配套插件接法下未验证独立系统卡。 |
| 工作区规则与路径策略 | Provider 本身不实现 Google 规则或路径策略；未核对 `GEMINI.md`、`AGENTS.md`、`.aiexclude` 和管理员规则是否等价。 | 工作区规则发现和路径访问由独立 1.5.2 内核执行，适配器转发相应工具错误。 |
| 企业策略和许可证区域 | 文档说明 Agent Platform 认证；未核对许可证区域回退和完整企业策略。 | 支持的企业策略和许可证区域由独立内核处理；套件自带登录命令仍只办理个人 OAuth。 |

证据：[Paseo 内置 Provider 文档](https://github.com/getpaseo/paseo/blob/v0.18.1/public-docs/supported-providers/antigravity.md)、[内置版 ACP 迁移与实测](https://github.com/getpaseo/paseo/pull/10193)、[Paseo ACP SDK](https://github.com/getpaseo/paseo/blob/v0.18.1/packages/plugin/src/server/acp-internal/connection.ts)、[Paseo 插件客户端身份](https://github.com/getpaseo/paseo/blob/v0.18.1/packages/server/src/server/agent/plugin-provider.ts#L94-L104)、[Pro 插件注册](https://github.com/tiezbro/paseo-agy-acp/blob/v2.11.1/plugins/paseo-agy-acp/index.server.ts)、[Pro 固定档实现](https://github.com/tiezbro/paseo-agy-acp/blob/v2.11.1/ACP%20Connector/official-kernel/fixed-model-effort.ts)、[Pro ACP 转发与轮次结果](https://github.com/tiezbro/paseo-agy-acp/blob/v2.11.1/ACP%20Connector/official-kernel/proxy.ts)和[额度移除及升级说明](docs/operations/paseo-quota.md)。[官方 1.5.0 能力目录](docs/research/2026-11-19-official-capability-catalog.md)记录的是旧版独立内核，作为历史参考。

<!-- readme:architecture -->
## 架构

```text
Paseo → ACP / NDJSON → paseo-agy-acp → agy_acp_server 1.5.2 → Google
```

每个适配器进程启动一个内核子进程。托管安装会校验 Google 原始下载包，并在 Linux x86_64 的独立兼容运行目录中接入内核事件观察器。也可直接指向未修改的官方可执行文件，此时重试、HTTP 与终止失败提示取决于该程序是否输出对应信号。

会话历史由内核存储；适配器不含调度数据库，也没有运行时 npm 依赖。同一连接上的新会话按顺序建立，确保早到的命令菜单绑定到正确工作区；不同会话的请求可并发处理。

<!-- readme:requirements -->
## 运行要求

- Node.js 22 或更高版本，以及支持自定义 ACP provider 的 Paseo。
- 具备官方 Antigravity 服务使用权限的 Google 账号。
- 运行托管 Linux x86_64 包装器需使用非 root 用户。

<!-- readme:quickstart -->
## 试用

在运行 Paseo daemon 的主机上安装发布包。如果要从源码构建同一个安装包，先切到对应的发布 tag，再按「开发验证」打包。

```bash
npm install --global ./paseo-agy-acp-2.11.1.tgz
paseo-agy-acp --doctor
paseo-agy-acp --prepare-kernel
paseo-agy-acp --login
```

`--doctor` 检查本机安装，`--prepare-kernel` 按需下载固定版本的内核，`--login` 使用个人 Google OAuth 登录。若为无桌面主机，可在其他设备的浏览器中完成授权，再将 localhost 回调地址粘贴回 daemon 主机的登录终端。

把下面的示例合并到 `~/.paseo/config.json` 的 `agents.providers` 中。如果 daemon 的 `PATH` 找不到可执行文件，请将 `command` 中的值换成该文件的绝对路径。

```json
{
  "agents": {
    "providers": {
      "paseo-agy-acp": {
        "enabled": true,
        "extends": "acp",
        "label": "Antigravity Pro",
        "command": ["paseo-agy-acp"]
      }
    }
  }
}
```

配置仅对新启动的 agent 生效。在 Paseo 中新建会话时选择 **Antigravity Pro** 即可。

### 使用可选 Paseo 插件注册 provider

在 Paseo 0.17.4 或更新版本中，可以通过配套插件注册 `paseo-agy-acp` provider。

1. 在运行 Paseo daemon 的主机上安装适配器，并按需准备内核。已有 ACP 登录可以直接复用，新账号运行 `paseo-agy-acp --login` 登录。

   ```bash
   npm install --global paseo-agy-acp@2.11.1
   paseo-agy-acp --prepare-kernel
   ```

2. 若需要通过配套插件注册 provider，在目标 daemon 的「设置 → 插件」中开启「启用插件」，再在该主机上安装同一 npm 版本中的配套插件。

   ```bash
   paseo plugin install npm:paseo-agy-acp@2.11.1:plugins/paseo-agy-acp
   ```

3. 若 `~/.paseo/config.json` 已有 `agents.providers["paseo-agy-acp"]`，删除该条目中的 `extends` 和 `kind`，由插件注册 provider。保留现有的 `command`、`env` 和其他覆盖配置。下面是覆盖插件默认配置的最小示例。如果 daemon 的 `PATH` 找不到 `paseo-agy-acp`，在 `command` 中填写已安装的可执行文件的绝对路径。

   ```json
   {
     "agents": {
       "providers": {
         "paseo-agy-acp": {
           "enabled": true,
           "label": "Antigravity Pro",
           "command": ["paseo-agy-acp"]
         }
       }
     }
   }
   ```

   如果 daemon 的 `PATH` 能找到适配器，且无需自定义设置，直接使用插件默认配置即可。

4. 重载配置并确认插件为 `running`。

   ```bash
   paseo reload --json
   paseo plugin ls paseo-agy-acp --json
   ```

升级时请为适配器和插件选择同一版本。

<!-- readme:configuration -->
## 配置

| 环境变量 | 用途 |
| --- | --- |
| `PASEO_AGY_ACP_OFFICIAL_BIN` | 已有内核或包装器的绝对路径；留空则使用托管安装。 |
| `PASEO_HOME` | Paseo daemon 数据目录（默认 `~/.paseo`）。 |
| `PASEO_AGY_ACP_NATIVE_SYSTEM_CONTEXT` | 设为 `1` 时，在内核声明支持的前提下使用会话级背景说明。 |
| `AGY_ACP_DIAGNOSTICS` | 设为 `1` 时向 stderr 输出各阶段耗时（不记录提示正文与凭据）。 |
| `AGY_ACP_CANCEL_TIMEOUT_MS` | 等待内核确认取消的超时时间（毫秒，正整数，默认 `30000`）。 |

支持的模式 ID 为 `default`、`auto_edit` 和 `yolo`，旧配置中的 `accept-edits`（对应 `auto_edit`）与 `dangerously-skip-permissions`（对应 `yolo`）继续兼容；未知模式交由内核校验。需先制定计划时，在聊天中发送 `/plan`。

权限请求会保持等待直至答复或取消。若需使用网络代理，请在 provider 环境变量中配置代理地址，并将本地 MCP 端点加入 `NO_PROXY`。

技能发现涵盖配置目录、工作区根目录、全局 Gemini/Agents/Codex 目录及 Paseo 兼容目录，同名时工作区技能优先于全局技能。设置 `user-invocable: false` 可在斜杠菜单中隐藏该技能。会话级只读 MCP 服务 `paseo_skills` 仅读取已发现的技能目录，单文件上限 1 MiB。

<!-- readme:operations -->
## 运维与验收

从含全局排队的版本迁移时，请移除 `AGY_ACP_ADMISSION_*` 与 `AGY_ACP_STATE_DIR`。旧账本文件留在磁盘上不再读取，原 `agy-acp-prepare-state` 命令也已移除。账号额度、上游 429/502/503 响应及生成耗时仍由上游服务决定。

从 2.9.2 升级至 2.10.0 会将托管内核由 1.5.0 替换为 1.5.2，旧的 1.5.0 兼容收据不可复用。升级或重新构建后，请先在终端运行 `paseo-agy-acp --prepare-kernel` 并等待完成，再执行 Provider 诊断（源码检出请使用 `node "dist/ACP Connector/main.js" --prepare-kernel`）。首次准备可能耗时数分钟，超出 Paseo 诊断初始化的 20 秒超时限制。运行中的会话将继续使用原已加载的内核。

适配器在 ACP 回包中发送分组 `configOptions`，省略旧扁平 `models` 列表；Paseo 0.18.1 插件 SDK 会展开这些选项。有原生档位的模型（如 Gemini、账号实际提供的 Claude 5.5）使用内核报告的真实档位。Gemini 4 Neon 和 Hydrogen 的 Extra High 原样转发。固定档显示逻辑曾在旧版客户端接法验证；在 0.18.1 配套插件下的行为见上表。Linux x86_64 托管兼容层也恢复上游账号目录实际提供的受支持第三方模型，不更改客户端身份。仅在兼容模块和补丁配方均匹配时复用内核缓存。模型可用性仍以上游账号目录为准。

- [旧排队配置迁移](docs/operations/admission.md)
- [轻量适配器验收](docs/operations/lightweight-adapter.md)
- [内核包装器运维](docs/operations/official-kernel-compat-runbook.md)
- [Paseo 客户端验收](docs/operations/paseo-adapter-verification.md)
- [分组模型的真实账号验收](docs/operations/2026-11-22-grouped-model-acceptance.md)
- [跨主机验收](docs/operations/paseo-cross-host-e2e.md)
- [npm 发布](docs/operations/npm-publishing.md)
- [插件随 Release 发布、安装与升级](docs/operations/plugin-releases.md)

自 2.11.1 起，Paseo「使用情况」已移除 Antigravity ACP 用量卡片。已安装 2.11.0 插件的用户需同步升级适配器和插件，才能移除旧用量来源。[升级指南](docs/operations/paseo-quota.md#已安装-2110-用户的升级步骤)

<!-- readme:development -->
## 开发验证

在源码根目录安装开发依赖、构建并打包试用所需的 npm 安装包：

```bash
npm ci
npm run build
npm pack
```

```bash
npm run validate
npm run test:paseo-provider
npm run test:paseo-client
```

客户端测试基于验收指南中锁定的 Paseo 客户端夹具与模拟内核。如需使用真实账号对比官方内核与适配器，可另行运行探针脚本：

```bash
node scripts/compare-kernel.mjs --run --kernel /absolute/path/agy_acp_server.par --concurrency 4 --groups native,adapter
```

两组使用同一模型并消耗当前账号额度。脚本会拒绝工具权限、遇异常即停并清理自建进程；报告仅记录耗时与状态，不包含模型输出或原始错误。历史证据存放在 `docs/research/` 与 `docs/design/`。

<!-- readme:license -->
## License

[Apache-2.0](./LICENSE)
