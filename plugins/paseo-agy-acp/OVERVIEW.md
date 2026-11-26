# Antigravity ACP

在 Paseo 中运行 `paseo-agy-acp`，并在原生「使用情况」面板展示 ACP 账号的 Gemini、Claude/GPT 周额度与 5 小时额度、剩余比例和重置时间。

要求 Paseo 0.17.4 或更新版本，daemon 所在机器上须安装带 `--usage` 入口的 `paseo-agy-acp` 并准备好官方 ACP 内核。使用 `paseo-agy-acp --login` 登录 ACP 账号。

插件通过适配器启动独立的 ACP 查询会话，发送内核声明支持的 `/usage` 命令。它不调用 `agy` CLI，沿用 provider 的内核路径及环境，包括 `GEMINI_HOME`。ACP 与 CLI 的账号可以不同；额度身份来自 ACP 的 `antigravity-acp` 目录。

查询和 provider 可用性探测会先确认实际适配器支持额度能力。旧版本、能力未知或超时都会明确报错，并指出 daemon PATH 命令或 provider 指定的适配器路径。只更新插件不会更新该适配器。

查询不会触发模型生成，但会访问 ACP 登录态和上游额度服务，也会创建短期 ACP 会话。插件不读取或返回原始凭据。内核负责令牌刷新和自己的会话存储。额度服务未返回的数值或重置时间保持未知；认证错误和超时显示为查询失败。

插件注册 `paseo-agy-acp` provider。已有同名自定义 ACP 配置需要移除 `kind` 和 `extends`，保留 `command`、`env` 等运行配置，才能交由插件提供账号额度来源。CLI 账号仍由 Paseo 内置 Antigravity provider 单独展示。
