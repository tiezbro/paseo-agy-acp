# 插件随主项目 Release 发布

适配器和可选的 Paseo 额度插件使用同一个仓库、主版本号及 npm 发布包。GitHub Release 介绍变更和迁移步骤；用户从 npm 安装该版本。插件保留在 `plugins/paseo-agy-acp`，无需独立 npm 包或额外版本号。

源码中的额度功能尚未包含在公开的 2.10.0 中。本文的 `X.Y.Z` 必须替换成后续实际发布、包含该功能的版本，不能直接复制占位符执行。

## 交付范围和版本要求

| 内容 | 交付方式 | 用户是否必需 |
| --- | --- | --- |
| 适配器、`--usage` 和内核兼容资源 | 主 npm 包 | 查询 ACP 账号额度时需要 |
| Paseo provider 与额度来源插件 | 同包的 `plugins/paseo-agy-acp` | 展示 Paseo 原生额度卡片时需要 |
| 官方 Google ACP 内核 | 用户通过 `--prepare-kernel` 单独准备 | 需要，不打入 npm 包 |
| 账号凭据、额度缓存、会话数据 | 留在 daemon 主机 | 不进入发布产物 |

面板插件要求 Paseo 0.17.4 或更新版本。`--usage` 可独立运行，不依赖插件开关。所有安装及查询都在运行 provider 的 daemon 主机上执行，使用 ACP 账号的 `GEMINI_HOME` 和内核路径，不使用 `agy` CLI 的另一套账号。

当前插件默认从 daemon 的 `PATH` 启动 `paseo-agy-acp`，也接受 provider 的 `command` 覆盖。它尚未自动定位插件安装包内的适配器，因此插件和全局适配器必须同步安装或升级；仅更新插件不会更新全局命令。若配置了源码路径，必须构建并验收该路径对应的源码版本。包内适配器自动定位属于后续改进。

## 用户从发布版本安装

先从 [GitHub Releases](https://github.com/tiezbro/paseo-agy-acp/releases) 选定包含插件的版本，并确认该版本的 npm 发布已经成功。在 daemon 主机上执行，保持与现有 provider 一致的账号环境：

```bash
npm install --global paseo-agy-acp@X.Y.Z
paseo-agy-acp --version
paseo-agy-acp --prepare-kernel
paseo-agy-acp --usage
```

新账号需先运行 `paseo-agy-acp --login`。已有 ACP 登录无需重新登录或复制 CLI 凭据。若只需终端额度查询，到这里即可。

需要面板时，在目标 daemon 开启插件功能，再安装同版本 npm 包中的子目录：

```bash
paseo plugin install npm:paseo-agy-acp@X.Y.Z:plugins/paseo-agy-acp
paseo plugin ls paseo-agy-acp --json
```

插件是受信任、无沙箱隔离的代码。用户需同意启用插件功能及安装该代码。已有同名自定义 provider 的配置迁移、环境保留和验收方式见 [ACP 额度接入](paseo-quota.md)。不要把内置 `antigravity` provider 改成 ACP 账号，它仍对应 CLI 登录。

已有本地目录插件时，不能对相同 ID 重复安装。先记录原目录、provider 配置和插件设置，移除目录来源的插件注册，再从 npm 安装。移除目录插件不会删除源码目录，但会删除插件保存的设置，应先备份。切换来源前应让使用该 provider 的 agent 完成任务。

## 升级与回滚

升级前记录当前适配器版本、插件来源和版本、provider 的 `command`、`env` 及 daemon 配置备份。升级到选定版本时：

```bash
npm install --global paseo-agy-acp@X.Y.Z
paseo-agy-acp --prepare-kernel
paseo-agy-acp --usage
paseo plugin update paseo-agy-acp --version X.Y.Z
paseo provider diagnostic paseo-agy-acp --json
```

`paseo plugin update paseo-agy-acp` 不带版本号时会检查 npm 的 `latest`；安装时指定版本并不会永久锁定后续升级。目录来源插件使用 `paseo plugin reload paseo-agy-acp`，不由 npm update 管理。更新源码或全局适配器不会替已运行的内核进程切换版本，应让当前任务结束后重新打开相关会话。

回滚到仍包含插件的已知可用版本时，对全局适配器和插件分别执行上述显式版本安装及更新，并重新验收。回滚到没有插件的旧版时，先备份配置和插件设置，移除插件，再安装旧适配器，并把同名 provider 恢复为原来的普通 ACP 配置，例如恢复 `extends: "acp"`，保留原 `command` 和 `env` 后执行 `paseo reload --json`。不要直接覆盖整份 daemon 配置，不要删除 ACP 账号目录。

## 维护者发布检查

1. 确定主包的新版本，并同步根目录 `package.json`、`package-lock.json` 及 README 版本说明。插件清单中的 `requirements.paseo` 表示最低 Paseo 版本，不是本项目版本。插件开发包继续保持 `private: true`。
2. 在隔离环境执行下列验证，并确认三平台插件 CI 和项目原有 CI 都通过。
3. 检查实际 tarball：包含适配器 `dist`、插件的清单、`package.json`、入口、额度来源、介绍页和兼容资源，不含 `node_modules`、凭据、数据库或 Google 内核。显式交付插件 `package.json`，保持不同 npm 版本下的文件清单一致。
4. 按 [npm 发布流程](npm-publishing.md) 推送位于 `main` 的对应标签。标签推送会自动发布 npm，不要在等待 GitHub Release 时重复手工发布。
5. 等待 npm 发布成功，核对版本、provenance 和文件清单。在测试 daemon 安装确切的已发布版本，验证插件 `running`、provider `Ready`、额度卡片属于 ACP 账号，且与同环境下的 `--usage` 一致。
6. 使用 [Release 正文模板](../releases/acp-quota-template.md) 创建对应 GitHub Release，写入实际版本、测试结果和迁移说明。公开截图须去掉账号信息。

```bash
npm ci
npm run validate
npm ci --prefix plugins/paseo-agy-acp --ignore-scripts
npm --prefix plugins/paseo-agy-acp run typecheck
npm --prefix plugins/paseo-agy-acp test
npm pack --dry-run --json
```

标签发布工作流会重复执行主项目验证和插件检查，并验证 tarball 中包含插件清单、`package.json`、入口、额度来源和介绍页。真实登录和额度面板验收需在测试 daemon 上单独完成，CI 的假内核用例不能代替它。

GitHub Release 的自动源码压缩包没有构建后的 `dist`，不能作为已构建 npm 包直接安装。若要在 Release 提供下载，附加发布工作流已经验证的同一份 `.tgz`、文件清单和 SHA-256 校验值。Actions artifact 默认只保留 30 天，也不会自动出现在 Release 附件中。

后续可按 [Paseo 插件发布指南](https://paseo.sh/docs/plugins/publishing.md) 提交市场审核；当前直接 npm 安装不依赖市场收录。子目录安装及更新语义依据 [Paseo 插件来源规范](https://paseo.sh/docs/plugins/reference.md#plugin-sources)。
