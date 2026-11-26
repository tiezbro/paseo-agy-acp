# ACP 额度插件的安装产物与升级错配验收

2026-11-26 在 Linux x64 上使用未修改的 Paseo CLI / daemon 0.17.4 完成。验收基于 PR #25 的能力预检修补工作区；不是 npm 新版本发布，也不是其他操作系统的真实账号验收。

## 安装来源

先构建，再执行 `node scripts/verify-paseo-quota-install.mjs --live`。脚本从工作区执行 `npm pack --ignore-scripts`，通过 npm 将产物安装到独立目录，再让隔离 daemon 从安装包里的插件目录加载代码，没有直接加载仓库中的插件源目录。

- 隔离目录：`.tmp-quota-install-dEitmj`。
- 实际 tarball：`.tmp-quota-install-dEitmj/tarballs/paseo-agy-acp-2.10.0.tgz`。
- tarball SHA-256：`46057f2b0a019e0fb08dd9197419ea5423fc9ae60d4467386c097c48013e6ac1`。
- 插件安装路径：`.tmp-quota-install-dEitmj/installed/node_modules/paseo-agy-acp/plugins/paseo-agy-acp`。
- 匹配版本适配器：同一安装目录下的 `dist/ACP Connector/main.js`。
- 错配对照：从 npm 安装公开的 `paseo-agy-acp@2.10.0` 到 `.tmp-quota-install-dEitmj/old`。
- 本地完整结果：`.tmp-quota-install-dEitmj/result.json`，不提交临时目录、账号环境和 daemon 运行数据。

本次源码产物暂时沿用 2.10.0 包版本，尚未正式发布；与公开的 2.10.0 使用不同内容和能力响应。新代码以 `--version --capabilities` 返回的 `accountQuota: 1` 判断能力，不把相同版本号当作支持保证。正式发布仍需新版本号，不能覆盖 npm 的既有版本。

安装产物中的 `server/usage.ts` 与验收时工作区源码逐字一致，其 SHA-256 为 `2af2b4ec0b6c42e96764e735fc6695e445a199ef17b1cac7ea6bc22bd22e7836`。插件入口 SHA-256 为 `96c8576a8252f79e76f64020144804047f71c6774cde6b8dbee5a855f1358f01`。

## 结果

| 场景 | 检查结果 |
| --- | --- |
| daemon PATH 指向公开的 2.10.0 | 额度报告明确失败，提示 daemon PATH 实际解析的旧适配器路径及升级要求；未生成普通内核启动标记 |
| provider command 指向公开的 2.10.0 脚本 | 明确失败，提示 provider 指定的旧脚本路径和启动器；未生成普通内核启动标记 |
| provider command 指向从 tarball 安装的匹配适配器 | 插件运行，原版 Paseo 返回四个额度窗口，与相同 ACP 环境下直接执行 `--usage` 的结果一致 |

错配阶段把 `PASEO_AGY_ACP_OFFICIAL_BIN` 指向只记录启动标记的哨兵程序。如果旧入口落入普通启动，会生成该标记；两个错配阶段均检查标记不存在。插件的额度刷新和 provider 可用性探测都先执行安全的能力预检，不向旧版发送单独的 `--usage`。

真实账号阶段沿用原 ACP provider 的账号和内核环境，不复制 CLI 凭据、不调用 `agy` CLI、不发送模型生成请求。验收时 Gemini 周额度剩余 70%、5 小时剩余 80%，Claude/GPT 两个窗口均为 100%；这些是当时读数，不是固定测试数据。

隔离 daemon 使用 loopback 临时端口，关闭 relay、语音和其他 provider。脚本结束后停止该 daemon，并将临时配置的环境值脱敏；生产 daemon 未切换配置。

## 自动化覆盖与限制

- 主项目 `npm run validate`：409 项 Vitest、7 项 Node 测试以及类型、构建、架构和秘密检查通过。
- 插件测试：账号隔离、正确能力查询、旧入口、畸形能力、未知能力版本、非零退出及预检超时。失败用例断言适配器只收到 `--version --capabilities`，且错误区分 daemon PATH 与 provider 指定路径。
- CLI 测试使用不存在的内核路径执行能力探测，确认返回结构化能力且不会启动内核；原有纯文本 `--version` 行为保留。

真实安装验收脚本必须显式传入 `--live`，需要已有 ACP 登录和网络，不在无账号 CI 中执行。三平台 CI 验证假适配器场景；本次真实安装及真实额度验收仅覆盖 Linux x64 与 Paseo 0.17.4。
