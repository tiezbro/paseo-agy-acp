# Antigravity ACP

在 Paseo 中注册 `paseo-agy-acp` provider，通过官方 ACP 内核运行 Antigravity agent。

要求 Paseo 0.17.4 或更新版本，daemon 所在机器上须安装 `paseo-agy-acp` 并准备好官方 ACP 内核。使用 `paseo-agy-acp --login` 登录 ACP 账号。

## 后台用量数据源已移除

参照 Paseo 0.17.6（[PR #10953](https://github.com/getpaseo/paseo/pull/10953)）及 Google 官方维护者在 [antigravity-cli#1493](https://github.com/google-antigravity/antigravity-cli/issues/1493) 中的条款说明，本插件已移除 Paseo 后台自动用量数据源，不再向 Paseo 注册 `usageSource`，也不会在打开或刷新「使用情况」面板时自动创建 ACP 短会话查询 `/usage`。

消费级个人登录（`oauth-personal`）由第三方工具在后台程序化发起调用存在违反 Google Antigravity Additional Terms §6 并导致账号受限的风险。如需查看当前 ACP 账号额度，建议直接在交互会话中手动输入 `/usage`，或在终端按需手动运行 `paseo-agy-acp --usage`。

## 配置说明

插件注册 `paseo-agy-acp` provider。已有同名自定义 ACP 配置需要移除 `kind` 和 `extends`，保留 `command`、`env` 等运行配置，才能交由插件提供 provider 注册。CLI 账号仍由 Paseo 内置 Antigravity provider 单独管理。
