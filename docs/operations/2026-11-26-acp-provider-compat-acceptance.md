# 普通 ACP 可用性与额度能力分离验收

2026-11-26 在 Linux x64、未修改的 Paseo 0.17.4 上完成。此记录覆盖撤销普通 provider 状态中的额度门禁，以及验收脚本的环境白名单和退出清理修补。此前 [升级错配验收记录](2026-11-26-acp-quota-install-acceptance.md) 仅作为历史记录。

## 实际安装与结果

运行 `npm run build` 后执行 `node scripts/verify-paseo-quota-install.mjs --live`。脚本把实际 tarball 经 npm 安装到隔离目录，加载包内插件；错配对照从 npm 安装公开的 `paseo-agy-acp@2.10.0`。本地源码产物仍暂用 2.10.0 版本号，不是发布新版本或覆盖 npm 包；额度能力由独立标记判断。

- 产物 SHA-256：`282384a6ceb0ad12a642211b90a124bccd0d74809aef3b7ebf4cb7a96116828b`。
- 当时的插件路径：`.tmp-quota-install-T6urR0/installed/node_modules/paseo-agy-acp/plugins/paseo-agy-acp`。
- 仅保留的脱敏结果：`.tmp-quota-results/.tmp-quota-install-T6urR0.json`，其中 `passed` 和 `workspaceRemoved` 均为 `true`。
- 工作目录已经删除，配置、daemon 密钥、日志、安装树、缓存和调用记录均未保留。前两轮遗留工作目录也已清理，仅保留脱敏摘要及历史校验信息。

| 对照场景 | 普通 ACP | 额度刷新 |
| --- | --- | --- |
| daemon PATH 指向已安装的公开 2.10.0 | 原生 provider 诊断为 `Ready`，握手与模型目录成功 | 明确提示升级 PATH 适配器，不发送 `--usage`，不误启普通链路 |
| provider command 指向公开 2.10.0 的记录包装器 | 同样 `Ready`，不因缺少额度能力被标成不可用 | 明确提示升级指定路径，调用仍只允许安全预检 |
| 指向从本次 tarball 安装的匹配适配器 | 原生可用性判断保留 | 四个额度窗口与同环境下直接 ACP 查询一致 |

记录包装器只记录启动边界，所有参数、stdio 和退出行为仍委托给实际安装的公开 2.10.0，没有伪造旧版本的能力响应。普通诊断结束后才记录额度刷新的调用：原版 Paseo 自身会读 `--version`，插件会读 `--version --capabilities`，两者均由旧入口安全退出。断言精确允许这两种参数组合，禁止无参数普通启动、`--usage` 或其他参数组合。插件单元测试则单独断言插件自身只发送组合预检参数。

真实 ACP 读数为 Gemini 周额度 68%、5 小时额度 74%，Claude/GPT 两项均为 100%，与直接查询一致。没有发送真实模型生成请求；普通 ACP 的对照验证的是可用性、握手与模型目录，不代表模型生成或所有工具能力的验收。

## 环境与清理

临时 provider 配置的环境只允许 `HOME`、`USERPROFILE`、`GEMINI_HOME`、`PASEO_AGY_ACP_OFFICIAL_BIN` 和本轮 `PASEO_HOME`。源账号可通过 `PASEO_QUOTA_SOURCE_HOME` 选择。代理和证书等必要网络设置只传给子进程内存环境；API key、无关令牌和 `NODE_OPTIONS` 不继承，也不写入配置。

脚本不保留原始 stdout、stderr、诊断参数或环境。固定失败码和验证结论可保留，账号路径和凭据不进入结果。临时根目录为 `0700`，配置和结果文件为 `0600`。正常退出、异常退出及 SIGINT / SIGTERM 的退出处理会停止本轮 daemon 并删除本轮工作目录，只留下 `.tmp-quota-results` 中的脱敏结果，不删除外部 ACP 账号目录，也不修改生产 daemon。

自动化验证覆盖：

- 普通 provider 注册状态与锁定的 Paseo SDK 原生注册一致，不添加 `accountQuota` 状态门禁。
- 额度查询仍拒绝旧版、畸形和未知能力、非零退出及超时。
- 环境白名单排除无关密钥、令牌和 `NODE_OPTIONS`；配置不包含代理凭据。
- 停止 daemon 成功或抛错时，清理操作均删除模拟敏感内容，且清理操作幂等。

本轮主项目验证为 409 项 Vitest 和 10 项 Node 测试通过。真实安装验收仅覆盖 Linux x64；其他平台通过假适配器和普通 provider CI 验证，不宣称已做真实账号验证。
