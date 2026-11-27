# 查询 ACP 账号额度与插件说明

`paseo-agy-acp --usage` 可在终端独立查询额度，不需要插件。数据来自官方 `agy_acp_server` 的 ACP `/usage`，不会调用 `agy` CLI。两者可以各自登录不同账号。

## 为什么移除 Paseo 后台自动用量数据源

参照 Paseo 0.17.6（[PR #10953](https://github.com/getpaseo/paseo/pull/10953)）以及 Google 官方维护者在 [google-antigravity/antigravity-cli#1493](https://github.com/google-antigravity/antigravity-cli/issues/1493) 中的说明：在消费级个人登录（`oauth-personal`）下，由第三方工具或后台调度器程序化驱动 `agy -p` 或 `agy acp` 违反 Google Antigravity Additional Terms §6，且不区分是否消耗 token、也不豁免个人单账号。

此前配套插件注册了 Paseo `usageSource`，导致用户打开或刷新 Paseo「使用情况」时，daemon 会在后台自动拉起短会话并向官方 ACP 内核发送 `session/prompt`（`"/usage"`）。为避免将消费级账号暴露在不必要的风控风险中，现已从 `plugins/paseo-agy-acp` 中移除后台自动用量数据源：

- 插件仅保留 `paseo-agy-acp` provider 注册，不再向 Paseo 注册 `usageSource`。
- 如需查看额度，优先在正常交互会话中由人手动输入 `/usage`，或在终端按需手动运行 `paseo-agy-acp --usage`（请知悉消费级 `oauth-personal` 账号的条款限制，避免将其放入定时任务或自动化轮询）。
- 若未来官方 ACP 协议提供非 `session/prompt` 的原生只读额度查询接口，再评估是否恢复面板集成。

## 手动终端查询

在运行 provider 的同一台 daemon 主机上构建并按需手动查询：

```bash
npm ci
npm run build
node "dist/ACP Connector/main.js" --prepare-kernel
node "dist/ACP Connector/main.js" --usage
```

如果 provider 设置了 `GEMINI_HOME` 或 `PASEO_AGY_ACP_OFFICIAL_BIN`，终端查询也要设置相同值。额度查询会使用 ACP 自身的凭据目录 `<GEMINI_HOME>/antigravity-acp`；未设置 `GEMINI_HOME` 时默认为 `~/.gemini/antigravity-acp`。不要为查询额度切换到 CLI 登录，也不要把 CLI 的凭据复制过来。

返回 JSON 中 `remainingPct` 是剩余比例，`usedPct` 是已用比例，`resetsAt` 是 UTC 时间或 `null`。只有内核实际报告的百分比窗口才会显示；未提供的重置时间保持未知。周窗口和 5 小时窗口分别提供完整时长。当前 ACP 返回 Markdown，解析器针对内核 1.5.2 的格式；上游格式改变时需要重新验证。

查询创建独立短会话，不会占用正在工作的 agent，也不会把 `/usage` 加进业务对话。内核可能保留自己的短会话记录，并按原有机制刷新令牌。查询只在内核先声明支持 `/usage` 后发送该命令，不支持时直接失败。

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

安装产物的真实验收使用 `node scripts/verify-paseo-quota-install.mjs --live`。先构建，使用现有 Paseo CLI 和已有 ACP 登录运行；也可用 `PASEO_QUOTA_SOURCE_HOME` 指向隔离账号的 daemon 配置目录。脚本从实际 tarball 安装插件，同时安装已发布 2.10.0，验证普通 ACP provider 正常可用、`paseo usage ls --refresh --json` 不再出现后台 Antigravity ACP 数据源且不触发后台 `--usage` 调用，并单独验证手动执行 `--usage`。

配置只写 `HOME`、`USERPROFILE`、`GEMINI_HOME`、`PASEO_AGY_ACP_OFFICIAL_BIN` 和本轮 `PASEO_HOME` 这些必要路径；代理和证书等网络设置仅通过子进程内存环境传递。脚本不继承 API key、无关令牌或 `NODE_OPTIONS`，不记录原始命令输出。正常结束、异常及退出信号都会清理本轮新建的临时工作目录，包括配置、daemon 密钥、日志、缓存和安装树；只在 `.tmp-quota-results` 保留脱敏结果。该脚本不自动运行于无账号 CI，也不修改生产 daemon。

Paseo 的接口依据：[provider 插件](https://paseo.sh/docs/plugins/providers.md)。
