# 查询 ACP 账号额度与插件说明

`paseo-agy-acp --usage` 作为终端兼容能力保留，不需要插件。数据来自官方 `agy_acp_server` 的 ACP `/usage`，不会调用 `agy` CLI。两者可以各自登录不同账号。

## 为什么移除 Paseo 后台自动用量数据源

参照 Paseo 0.17.6（[PR #10953](https://github.com/getpaseo/paseo/pull/10953)）以及 Google 官方维护者在 [google-antigravity/antigravity-cli#1493](https://github.com/google-antigravity/antigravity-cli/issues/1493) 中的说明：在消费级个人登录（`oauth-personal`）下，由第三方工具或后台调度器程序化驱动 `agy -p` 或 `agy acp` 违反 Google Antigravity Additional Terms §6，且不区分是否消耗 token、也不豁免个人单账号。

此前配套插件注册了 Paseo `usageSource`，导致用户打开或刷新 Paseo「使用情况」时，daemon 会在后台自动拉起短会话并向官方 ACP 内核发送 `session/prompt`（`"/usage"`）。为避免将消费级账号暴露在不必要的风控风险中，现已从 `plugins/paseo-agy-acp` 中移除后台自动用量数据源：

- 插件仅保留 `paseo-agy-acp` provider 注册，不再向 Paseo 注册 `usageSource`。
- **区分三条路径**：消费级 `oauth-personal` 用户应**优先使用官方 Antigravity 的用量入口**。在正常交互会话内由人手动输入 `/usage`，与在终端手动启动适配器 `paseo-agy-acp --usage` 是两条不同路径；后者仍会由第三方适配器创建独立 ACP 短会话并发送 `session/prompt`（`"/usage"`），Google 的说明并未确认这条路径在消费级 OAuth 下获准。因此 `--usage` 仅作为兼容能力保留，不作为消费级 OAuth 用户的安全或合规替代，也严禁将其放入定时任务或自动化轮询。
- 若未来官方 ACP 协议提供非 `session/prompt` 的原生只读额度查询接口，再评估是否恢复面板集成。

## 已安装 2.11.0 用户的升级步骤

**仅升级全局 CLI（`npm install --global paseo-agy-acp@...`）不会移除已安装旧插件里的后台用量源**，必须按插件原来的安装方式同步更新或移除插件：

- **npm 来源安装的插件**（通过 `paseo plugin install npm:paseo-agy-acp@2.11.0:plugins/paseo-agy-acp` 安装）：

  ```bash
  npm install --global paseo-agy-acp@X.Y.Z
  paseo plugin update paseo-agy-acp --version X.Y.Z
  paseo daemon restart
  ```

- **本地目录来源安装的插件**（通过绝对路径从源码目录或全局包目录安装）：不受 `paseo plugin update` 管理。需先更新对应目录中的适配器与插件文件，再重载或重启 daemon：

  ```bash
  paseo plugin reload paseo-agy-acp
  paseo daemon restart
  ```

- **不再使用插件时**：可直接 `paseo plugin remove paseo-agy-acp`，把 `~/.paseo/config.json` 中同名 provider 恢复为 `extends: "acp"` 后执行 `paseo reload --json`，即可立即停用旧版后台用量源。

升级后建议执行 `paseo usage ls --refresh --json` 确认 `Antigravity ACP` 来源已消失，再执行 `paseo provider diagnostic paseo-agy-acp --json` 确认普通 provider 正常。

## `--usage` 兼容入口说明

在运行 provider 的同一台 daemon 主机上构建并调用兼容入口（注意：不作为消费级 `oauth-personal` 账号的合规替代）：

```bash
npm ci
npm run build
node "dist/ACP Connector/main.js" --prepare-kernel
node "dist/ACP Connector/main.js" --usage
```

如果 provider 设置了 `GEMINI_HOME` 或 `PASEO_AGY_ACP_OFFICIAL_BIN`，终端查询也要设置相同值。额度查询会使用 ACP 自身的凭据目录 `<GEMINI_HOME>/antigravity-acp`；未设置 `GEMINI_HOME` 时默认为 `~/.gemini/antigravity-acp`。不要为查询额度切换到 CLI 登录，也不要把 CLI 的凭据复制过来。

返回 JSON 中 `remainingPct` 是剩余比例，`usedPct` 是已用比例，`resetsAt` 是 UTC 时间或 `null`。只有内核实际报告的百分比窗口才会显示；未提供的重置时间保持未知。周窗口和 5 小时窗口分别提供完整时长。当前 ACP 返回 Markdown，解析器针对内核 1.5.2 的格式；上游格式改变时需要重新验证。

该入口会由第三方适配器创建独立短会话并发送 `/usage`，不会占用正在工作的 agent，也不会把 `/usage` 加进业务对话；内核可能保留自己的短会话记录，并按原有机制刷新令牌。查询只在内核先声明支持 `/usage` 后发送该命令，不支持时直接失败。

## 可选 Paseo 插件（仅注册 Provider）

使用 npm 发布版时，可按 [中文 README 的插件配置步骤](../../README.zh-CN.md#手动查询-acp-用量与可选-paseo-插件) 安装插件、迁移 provider 并重载配置。安装及升级细节见 [发布版安装](plugin-releases.md#用户从发布版本安装)。本地源码开发时，在目标 daemon 上启用插件后，从源码目录安装配套插件。

```bash
paseo plugin install /absolute/path/to/paseo-agy-acp/plugins/paseo-agy-acp
```

插件为受信任代码，可以访问 daemon 主机的文件、进程、凭据和网络。只有目标 daemon 已开启插件功能时才能加载；安装位置和 provider 配置都属于 daemon 主机。

插件默认启动 daemon `PATH` 上的 `paseo-agy-acp`。源码开发时，在 `agents.providers["paseo-agy-acp"]` 配置明确的启动路径：

```json
{
  "agents": {
    "providers": {
      "paseo-agy-acp": {
        "enabled": true,
        "command": ["node", "/absolute/path/to/paseo-agy-acp/dist/ACP Connector/main.js"],
        "env": {
          "GEMINI_HOME": "/absolute/path/to/acp-gemini-home"
        }
      }
    }
  }
}
```

仅当已有 ACP 登录使用了独立 `GEMINI_HOME` 时填写该变量；默认账号可省略 `env`。保留实际使用的内核路径和其他环境设置。已有同名自定义 provider 配置应移除 `kind`、`extends` 字段，让插件注册 provider；保留 `command`、`env`、模型等所需配置。无需修改 Paseo 内置 `antigravity` provider。

用 `paseo reload --json` 加载 provider 配置，用 `paseo plugin ls` 确认插件运行。源文件更新后使用 `paseo plugin reload paseo-agy-acp`。

## 开发验证

```bash
npm test
npm ci --prefix plugins/paseo-agy-acp
npm --prefix plugins/paseo-agy-acp run typecheck
npm --prefix plugins/paseo-agy-acp test
```

配套插件测试使用 Node 22.6 及更新版本的类型擦除功能。协议测试验证 `--usage` 只发送 `initialize`、`session/new`、`session/prompt`，且 prompt 精确为 `/usage`；未声明命令、认证错误和超时都会失败。插件测试验证保留 Paseo 原生 provider 注册且不再注册后台 `usageSource`。

### 2.11.0 原位升级回归（无需真实 OAuth）

在安装了原版 Paseo CLI 的主机上构建后，运行：

```bash
npm run build
node scripts/verify-paseo-plugin-upgrade.mjs
```

该脚本使用隔离的 `PASEO_HOME` 与假 ACP 内核（不接触真实账号与消费级 OAuth），先安装公开发布的 `paseo-agy-acp@2.11.0` 插件证明旧版刷新会触发后台 `--usage` 查询并出现 `Antigravity ACP` 来源，再在同一个隔离 daemon 上原位升级到当前打包插件并重启 daemon，验证 `Antigravity ACP` 来源消失、刷新不再启动任何查询，且普通 ACP provider 仍可完成真实握手。

如需在隔离环境对照真实已登录 ACP 环境验收，仍可使用 `node scripts/verify-paseo-quota-install.mjs --live`（仅在明确授权和自有合规环境下运行，不建议用消费级 OAuth 账号重复触发额度查询）。

Paseo 的接口依据：[provider 插件](https://paseo.sh/docs/plugins/providers.md)。
