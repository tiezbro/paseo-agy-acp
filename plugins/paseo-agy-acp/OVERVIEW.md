# Antigravity ACP

在 Paseo 中注册 `paseo-agy-acp` provider，通过官方 ACP 内核运行 Antigravity agent。

要求 Paseo 0.17.4 或更新版本，daemon 所在机器上须安装 `paseo-agy-acp` 并准备好官方 ACP 内核。使用 `paseo-agy-acp --login` 登录 ACP 账号。

## 后台用量数据源已移除

参照 Paseo 0.17.6（[PR #10953](https://github.com/getpaseo/paseo/pull/10953)）及 Google 官方维护者在 [antigravity-cli#1493](https://github.com/google-antigravity/antigravity-cli/issues/1493) 中的条款说明，本插件已移除 Paseo 后台自动用量数据源，不再向 Paseo 注册 `usageSource`，也不会在打开或刷新「使用情况」面板时自动创建 ACP 短会话查询 `/usage`。

消费级个人登录（`oauth-personal`）由第三方工具在后台程序化发起调用存在违反 Google Antigravity Additional Terms §6 并导致账号受限的风险。消费级 `oauth-personal` 用户应优先使用官方 Antigravity 的用量入口。在交互会话内手输 `/usage` 与在终端启动适配器 `paseo-agy-acp --usage` 是两条路径；后者仍会通过第三方适配器新建 ACP 短会话并发送 `session/prompt`，仅作为兼容能力保留，不作为消费级 OAuth 用户的合规或安全替代。

## 已安装 2.11.0 插件的升级提醒

仅升级全局 `paseo-agy-acp` CLI **不会**移除旧插件中的后台用量源，必须同时更新或移除插件本身：

- 通过 `npm:...` 安装的插件：执行 `paseo plugin update paseo-agy-acp --version <版本>`，并在需要时重启 daemon。
- 通过本地目录安装的插件：先更新该目录中的插件文件，再执行 `paseo plugin reload paseo-agy-acp`（或重启 daemon）。

## 配置说明

插件注册 `paseo-agy-acp` provider。已有同名自定义 ACP 配置需要移除 `kind` 和 `extends`，保留 `command`、`env` 等运行配置，才能交由插件提供 provider 注册。CLI 账号仍由 Paseo 内置 Antigravity provider 单独管理。
