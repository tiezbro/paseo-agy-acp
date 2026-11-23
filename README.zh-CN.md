# paseo-agy-acp

[English](./README.md) | [中文](./README.zh-CN.md) | [Changelog](./CHANGELOG.md)

`paseo-agy-acp` 把 Google 官方 Antigravity ACP 内核接入现有 Paseo。适配器包版本为 `2.10.0`，内核基准是官方 `agy_acp_server` 1.5.2，Linux 托管安装使用兼容层。只需安装本包，在 Paseo 中配置一个 ACP provider，即可使用，无需修改 Paseo。

<!-- readme:positioning -->
## 产品定位

在 Paseo 中选择 **Antigravity Pro**，就会启动 `paseo-agy-acp`。它和内置的 **Antigravity**（`antigravity`）可以并存。Antigravity Pro 使用官方 ACP 1.5.2，Linux x86_64 托管运行目录附加兼容补丁；内置 provider 使用主机上的 `agy`。

![Paseo 中 Antigravity Pro 与内置 Antigravity 并存](./docs/images/antigravity-and-antigravity-pro.png)

Google 内核负责账号认证、模型、工具、重试和会话历史。适配器负责把 Paseo 的工作目录、背景说明和技能交给内核，再把回答、权限请求和错误交回 Paseo。这是社区项目，Google 内核单独下载。

<!-- readme:value -->
## 为什么用 paseo-agy-acp

适配器以官方 1.5.2 为基准，保留官方模式、重试和取消。官方已经提供的规则文件、路径策略、企业配额显示和许可证区域由内核执行。Linux x86_64 托管兼容层仍恢复账号可用的受支持模型，通过工具呈现技能，并观察内核事件。用户只需安装这个包，无需修改 Paseo；连接使用真实客户端身份。

新架构带来的结果：

- 直接连接官方内核，不再刮 `agy` 的界面。
- 准备重试和 HTTP 503 立刻显示，这一轮继续。
- `max_tokens`、`max_turn_requests`、`refusal` 显示成失败，不再看起来像成功。
- 保留模型分组与独立档位选择；托管兼容层通过技能工具提供内置技能，避免自动向工作区写入技能文件。

“官方能力”表示未修改的 1.5.2 是否原生提供第一列所述能力。最后一列依据 Paseo 内置 `antigravity-provider` 的实现。“未核对”表示没有足够证据判断内置 provider 的行为。1.5.0 能力目录仍是历史对照：[官方能力目录](docs/research/2026-11-19-official-capability-catalog.md)。

| 能力名称 | 能力内容简述 | 官方能力 | Paseo 适配说明 | Paseo 内置 antigravity |
| --- | --- | --- | --- | --- |
| 连接身份 | 多个 provider 并存时，可以辨认当前连接。 | 否 | 保留内核声明的能力，握手名称为 `agy-acp`，标题为 `paseo-agy-acp (official Antigravity ACP kernel)`，版本号取自适配器。 | 注册为 `antigravity`，显示为 Antigravity，启动 `agy`。 |
| 终端 Google 登录 | 使用个人 Google 账号登录，需要时可重新授权。 | 是 | 在 daemon 主机运行 `paseo-agy-acp --login`，只办理 `oauth-personal`。聊天中无登录或切换账号按钮。 | 在终端启动 `agy` 登录，使用 CLI 的登录状态。 |
| 崩溃后恢复与历史重放 | 重新打开会话时，找回原对话和工具记录。 | 是 | 优先用 `loadSession` 重放用户消息、回答、已记录的思考和工具。只有内核不支持 load 且声明支持 resume 时，才仅恢复上下文。 | 能做，但只按 `--conversation` 和原会话 ID 继续，CLI 不重放历史时间线。 |
| 本地会话列表 | 按工作目录列出内核已保存的会话。 | 是 | 透传 `session/list` 和会话 ID。默认数据目录为 `~/.gemini/antigravity-acp`。 | 做不到，内置 provider 可重新打开已知会话，但没有枚举 CLI 历史会话的接口。 |
| 工作目录与额外目录 | 为会话指定工作目录和允许访问的其他目录。 | 是 | 请求缺少工作目录时取 `PASEO_AGENT_CWD`，客户端给出的 `additionalDirectories` 原样交给内核。 | 能做，但 provider 只将当前工作目录作为 `--add-dir` 传给 CLI。 |
| 中断当前轮次 | 停止当前请求，保留会话供下次使用。 | 是 | 转发取消。若内核用 `end_turn` 确认本地取消，则向客户端返回 `cancelled`。默认 30 秒无确认后关闭该连接。 | 能做，但会停止 CLI 进程，下次发消息时按原会话 ID 重启。 |
| 同一会话防重入 | 一轮还在运行时，防止同一会话收到第二个并行请求。 | 否 | 拒绝重叠请求，其他会话直接派发。适配器不设置全局席位或冷却时间。 | 也会拒绝同一会话的重叠请求，返回 `TURN_ACTIVE`。 |
| 图片与附件 | 消息可包含图片、文件位置或内嵌资源。 | 是 | 粘贴的图片作为 ACP 图片块发送。上传文件（含音频）交给内核的是本机文件位置；直接提供的 ACP 资源块原样转发。 | 能做，但图片先写入临时文件，再把路径发给 CLI。其消息接口只接受文本和图片。 |
| 每条消息的背景说明 | 会话中途更新 daemon 的背景说明，下一条消息即可使用。 | 否 | 默认逐条读取并前置说明。启用原生会话背景后，在新建、加载或恢复时追加一次。 | 能做，但只在新会话的第一条消息前加说明，恢复后也不会再加。 |
| `/usage` 与 `/logout` | 单独发送命令可查看用量或退出账号。企业登录且官方打开配额可见开关时，`/usage` 还显示配额告警、活动桶说明和 Overage。 | 是 | daemon 没有保存背景说明，或设置 `PASEO_AGY_ACP_NATIVE_SYSTEM_CONTEXT=1` 并启用官方会话背景时，内核直接处理命令。否则前置说明会让命令作为普通消息进入模型。结果按普通回复显示。配额可见性由官方实验开关决定，个人登录保持原有用量。 | 做不到，内置 provider 启动 CLI 时禁用了斜杠命令。 |
| 斜杠技能与 `/plan` | 在官方命令菜单里找到工作区和个人技能。 | 否 | 保留官方 `/plan`、`/logout`、`/usage`，在后面追加可调用的本地技能。同名时官方命令优先。`/plan` 用来请求计划，保留当前权限模式。 | 做不到，内置 provider 禁用斜杠命令，发送给 Paseo 的命令列表为空。 |
| 模型与思考级别 | 查看账号可用的模型，按内核提供的选项调整思考级别。API Key 与 Agent Platform 目录包含 Gemini 4 Neon、Gemini 4 Hydrogen，以及 High、Extra High、Medium、Low。 | 是 | 保留具体模型 ID 和分组思考档，Extra High 原样交给内核。Linux 托管兼容层同时列出上游账号目录实际提供的受支持 Claude/GPT 模型，保留上游禁用模型检查。 | 能做，但从 `agy models` 读取模型，思考级别只能通过模型 ID 选择。 |
| 三种模式与 YOLO 无人值守 | Default 按策略审批，Auto Edit 自动批准编辑，YOLO 自动批准常规工具。 | 是 | 按官方模式运行。需要无人值守执行常规工具时选 `yolo`。管理员复核规则仍生效；Paseo 对权限请求的 Auto Accept 是独立设置。 | 能做，但只有 Full access，始终用 `--dangerously-skip-permissions` 启动，不能选择 Default 或 Auto Edit。 |
| 工具审批与单选问答 | 审批工具、保存适用的许可，或从内核给出的选项中作答。本轮取消时，未作答的询问随轮次结束，不再作为回答送回内核。 | 是 | 将官方选项交给 Paseo 的权限面板。多个允许选项需要人选择，切换 YOLO 本身不会让现有 Paseo 代答。取消仍按官方终态转发。 | 做不到，内置 provider 不能把 CLI 的交互式权限请求或单选题交给 Paseo 作答。 |
| 工作区信任与钩子 | 工作区钩子需要信任时，内核询问是否信任并保存明确选择。 | 是 | 通过普通权限请求显示“信任／不信任”。默认由人选择；启用 Paseo Auto Accept 后，只有一个允许项的信任请求可以被自动批准。 | 做不到，内置 provider 没有向 Paseo 转交工作区信任选项的接口。 |
| 流式回答与思考摘要 | 阅读逐步到达的正文，以及模型实际提供的思考摘要。 | 是 | 将正文和官方思考分开传给 Paseo；加载历史时可重放已保存的摘要。 | 能做，但只把回复文字写入时间线，没有独立的思考摘要条目。 |
| 系统消息封套 | 在回复中识别明确标为 `SYSTEM_MESSAGE` 的片段。 | 否 | 识别代码块外的完整封套，将原文作为独立 ACP 文本消息交付。普通 Paseo 能读到正文；引用和命令回执仍是普通回复。 | 做不到，内置 provider 按回复步骤拼接文本，没有识别该封套的处理。 |
| 工具进度与结果 | 查看工具正在做什么、输出了什么、最终是否成功。 | 是 | 用官方调用 ID 关联更新，保留内核给出的文件位置、命令结果和退出码。 | 能做，但 shell 条目只映射命令和输出，没有单独的退出码字段。 |
| MCP 工具连接 | 让内核调用会话配置的 MCP 服务。 | 是 | stdio 直接传递，HTTP 和 SSE 经本地协议桥连接，工具调用与结果显示在时间线中。 | 能做，但只能使用 `agy` 自己配置的 MCP 服务；内置 provider 不接入 Paseo 提供的 MCP 工具。 |
| 上下文与 token 用量 | 查看上下文已用空间、总容量和本轮的用量。 | 是 | 转发官方 `usage_update` 和回包用量；普通 Paseo 可读取输入、输出和缓存读取计数。 | 能做，但只累计输入、输出和缓存读取数，没有官方上下文容量更新。 |
| 空成功检查 | 区分正常完成与没有产生任何可见内容的 `end_turn`。 | 否 | 有可见回答或工具活动时保留成功；完全没有可见内容时返回 `-32000`，Paseo 显示失败。 | 做不到，CLI 返回 `SUCCESS` 就标记完成，没有检查本轮是否有可见输出。 |
| 三种未完成原因 | 分别识别 token 达上限、单轮请求达上限和配额耗尽。 | 是 | 把 `max_tokens`、`max_turn_requests`、`refusal` 转成 `-32000` 错误。Paseo 显示对应的英文原因，`error.data.stopReason` 保留官方原值。 | 做不到，内置 provider 处理 CLI 的 `SUCCESS` 或 `ERROR`，没有这三个 ACP 原因的映射。 |
| 即时重试与 HTTP 503 提示 | 等待时看到内核是否已安排重试，或后端是否报错。 | 否 | 托管 Linux x86_64 包装器捕获到明确重试记录时立即发文字提示。识别到 HTTP 503 时也立即提示，同一轮相同状态码只提示一次；本轮继续，502 或 503 本身不代表已安排重试。 | 做不到，内置 provider 不解析这两种信号，也不向时间线推送相应提示。 |
| 内核确认的终止失败 | 内核有时在执行失败后仍回 `end_turn`。 | 否 | 托管包装器确认本轮终止失败后，适配器返回 `-32000`。失败诊断长文不会被当成本轮回答。 | 能做，但依据 CLI 的 `ERROR` 或进程异常报告失败，没有这项 ACP 终态校正。 |
| 企业账号与策略 | 企业登录可启用管理员策略和企业浏览器等受许可功能。 | 是 | 本包的登录命令只办理个人 Google 登录，未提供企业、API key、Agent Platform 或网关登录入口。 | 未核对 |
| 工作区规则文件 | 内核读取工作区与 Gemini 主目录中的 `GEMINI.md`、`AGENTS.md`，并作为用户规则交给模型。 | 是 | 1.5.2 在规则列表为空时自行注入这两个文件名。适配器不另写规则，也不改写文件内容。 | 未核对 |
| 路径访问策略 | `.aiexclude` 与管理员允许、拒绝的读写路径约束文件工具和命令参数中的路径。 | 是 | 拒绝由内核执行，适配器原样转发工具错误。拒绝原因包括 `aiexclude_deny`、`aiexclude_deny_wildcard`、`admin_denied_path`、`admin_denied_path_wildcard`。 | 未核对 |
| 企业许可证区域 | 企业登录按项目查询可领取许可证的区域；查询失败时使用 global、us、eu。 | 是 | 区域列表和回退由官方登录流程决定。本包登录命令仍只办理个人 Google 登录。 | 未核对 |

另外九项尚未确认的事实见[能力目录第十四节](docs/research/2026-11-19-official-capability-catalog.md#十四仍未确认)。该目录记录的是 1.5.0，不覆盖上表新增的 1.5.2 行。

<!-- readme:architecture -->
## 架构

```text
Paseo → ACP / NDJSON → paseo-agy-acp → agy_acp_server 1.5.2 → Google
```

每个适配器进程启动一个内核子进程。托管安装校验 Google 的原始下载包；Linux x86_64 在独立的兼容运行目录中接入内核事件观察器。直接指定未修改的官方可执行文件也可连接，此时重试、HTTP 和终止失败提示取决于该程序是否提供相应信号。

会话历史由内核保存。适配器没有调度数据库或运行时 npm 依赖。同一连接按顺序建立新会话，使早到的命令菜单能绑定到正确工作区；不同会话的消息可以同时处理。

<!-- readme:requirements -->
## 运行要求

- Node.js 22 或更高版本，以及支持自定义 ACP provider 的 Paseo。
- 可使用官方 Antigravity 服务的 Google 账号。
- 托管 Linux x86_64 包装器需要以非 root 用户运行。

<!-- readme:quickstart -->
## 试用

在运行 Paseo daemon 的主机上，从本版本的 npm 包安装。若手头是源码，可按“开发验证”中的命令生成同名安装包。

```bash
npm install --global ./paseo-agy-acp-2.10.0.tgz
paseo-agy-acp --doctor
paseo-agy-acp --prepare-kernel
paseo-agy-acp --login
```

`--doctor` 检查本机安装，`--prepare-kernel` 按需下载固定版本内核。登录使用个人 Google OAuth。无桌面主机可以在另一台设备的浏览器里授权，再把 localhost 回调地址粘贴回 daemon 主机的登录终端。

把下面的 provider 合并到 `~/.paseo/config.json` 的 `agents.providers` 中。如果 daemon 的 `PATH` 找不到可执行文件，请将 `command` 中的值换成该文件的绝对路径。

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

配置对新启动的 agent 生效。在 Paseo 创建会话时选择 **Antigravity Pro**。

<!-- readme:configuration -->
## 配置

| 环境变量 | 用途 |
| --- | --- |
| `PASEO_AGY_ACP_OFFICIAL_BIN` | 指向已有内核或包装器的绝对路径。留空使用托管安装。 |
| `PASEO_HOME` | Paseo daemon 数据目录，默认 `~/.paseo`。 |
| `PASEO_AGY_ACP_NATIVE_SYSTEM_CONTEXT` | 设为 `1`，在内核声明支持时使用会话级背景说明。 |
| `AGY_ACP_DIAGNOSTICS` | 设为 `1`，向 stderr 写入各阶段耗时，不记录提示正文或凭据。 |
| `AGY_ACP_CANCEL_TIMEOUT_MS` | 取消后等待内核确认的时间，单位为毫秒，须为正整数，默认 `30000`。 |

模式 ID 为 `default`、`auto_edit` 和 `yolo`。已有配置中的 `accept-edits` 对应 `auto_edit`，`dangerously-skip-permissions` 对应 `yolo`。未知模式交给内核校验。需要先做计划时，在聊天中使用 `/plan`。

权限请求会等到答复或取消。使用网络代理时，在 provider 的环境变量中设置代理地址，并在 `NO_PROXY` 中加入本地 MCP 端点。

技能发现范围包括配置目录、工作区、全局 Gemini、Agents、Codex 和 Paseo 兼容目录。工作区技能优先于全局同名技能。`user-invocable: false` 隐藏该技能的斜杠菜单项。会话级 `paseo_skills` MCP 只读已发现的技能目录，每个文件最多 1 MiB。

<!-- readme:operations -->
## 运维与验收

从带全局排队的版本迁移时，移除 `AGY_ACP_ADMISSION_*` 和 `AGY_ACP_STATE_DIR`。旧账本保留在磁盘上，适配器不再读取，原 `agy-acp-prepare-state` 入口已移除。账号额度、服务端 429/502/503 和模型生成时间仍由上游决定。

从 2.9.2 升级到 2.10.0 会把托管内核从 1.5.0 换成 1.5.2。旧的 1.5.0 兼容收据不能复用。升级或重新构建后，先在终端运行 `paseo-agy-acp --prepare-kernel` 并等待完成，再运行 Provider 诊断。源码检出使用 `node "dist/ACP Connector/main.js" --prepare-kernel`。首次准备可能需要数分钟，超过 Paseo 诊断初始化的 20 秒限时。已运行的会话继续使用原先加载的内核。

会话建立及配置回包使用分组 `configOptions`，省略旧扁平 `models` 列表。模型菜单只显示名称，支持原生档位的模型（如 Gemini，以及符合条件账号上的 Claude 5.5）通过独立控件切换真实推理档位。Gemini 4 Neon 与 Hydrogen 的 Extra High 是官方档位，适配器不把它改成 Low、Medium 或 High。原版 Paseo 中，受支持的固定档 Claude/GPT‑OSS 也显示低、中、高，但点选只改变界面，不改变实际模型 ID 或推理档位。Linux x64 托管兼容层也恢复上游账号目录实际提供的受支持第三方模型，不更改客户端身份。仅在兼容模块和补丁配方均匹配时复用内核缓存。模型可用性仍以上游账号目录为准。

- [旧排队配置迁移](docs/operations/admission.md)
- [轻量适配器验收](docs/operations/lightweight-adapter.md)
- [内核包装器运维](docs/operations/official-kernel-compat-runbook.md)
- [Paseo 客户端验收](docs/operations/paseo-adapter-verification.md)
- [分组模型的真实账号验收](docs/operations/2026-11-22-grouped-model-acceptance.md)
- [跨主机验收](docs/operations/paseo-cross-host-e2e.md)
- [npm 发布](docs/operations/npm-publishing.md)

<!-- readme:development -->
## 开发验证

在源码根目录安装开发依赖、构建并生成试用所用的 npm 包：

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

客户端测试使用验收指南锁定的 Paseo 客户端和模拟内核。需要用真实账号对照官方内核和适配器时，可另行运行：

```bash
node scripts/compare-kernel.mjs --run --kernel /absolute/path/agy_acp_server.par --concurrency 4 --groups native,adapter
```

两组使用同一模型并消耗现有账号额度。脚本拒绝工具权限，遇到异常即停并清理自建进程。报告只保存耗时和状态，不保存模型正文或原始错误。历史证据位于 `docs/research/` 和 `docs/design/`。

<!-- readme:license -->
## License

[Apache-2.0](./LICENSE)
