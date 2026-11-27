# vX.Y.Z：移除 Paseo 后台自动用量数据源

维护者使用说明：这是发布正文模板，不代表功能已经发布。发布前替换全部 `X.Y.Z`、填写本标签的实际验证结果，并删除本段和下方验证占位说明。

## 变更说明

- 参照 Paseo 0.17.6（[PR #10953](https://github.com/getpaseo/paseo/pull/10953)）及 Google 官方维护者在 [antigravity-cli#1493](https://github.com/google-antigravity/antigravity-cli/issues/1493) 中的条款说明，从配套插件移除后台自动用量数据源（不再注册 `usageSource`），避免打开 Paseo「使用情况」时自动拉起 ACP 短会话触发消费级 OAuth 封号风险。
- 保留 `paseo-agy-acp` provider 插件注册、交互会话内手动输入 `/usage`，以及终端按需手动命令 `paseo-agy-acp --usage`。
- 适配器与插件随同一个 npm 包发布，统一使用 X.Y.Z 版本。配套插件要求 Paseo 0.17.4 或更新版本。

## 安装与升级

在运行 Paseo daemon 的主机上，使用与现有 ACP provider 相同的账号环境：

```bash
npm install --global paseo-agy-acp@X.Y.Z
paseo-agy-acp --prepare-kernel
```

已安装配套插件的用户同步更新插件以停止后台用量刷新：

```bash
paseo plugin update paseo-agy-acp --version X.Y.Z
```

首次安装插件时，开启 daemon 的插件功能并执行：

```bash
paseo plugin install npm:paseo-agy-acp@X.Y.Z:plugins/paseo-agy-acp
```

当前插件调用全局或 provider 配置的适配器，请同时更新适配器，不能只更新插件。新账号使用 `paseo-agy-acp --login`；已有 ACP 登录继续沿用，不需要切换 CLI 账号。

## 迁移与限制

- 已有同名普通 ACP provider 需移除 `extends` 和 `kind`，保留 `command`、`env` 等配置，交由插件注册，再热加载配置。
- 目录来源的开发插件需先备份设置再切换来源，不能对相同 ID 重复安装。
- 手动运行 `paseo-agy-acp --usage` 会创建独立短会话，内核可能保留会话记录并刷新令牌；消费级 `oauth-personal` 账号请勿用于后台自动轮询，建议优先在正常交互会话中手动输入 `/usage`。
- 插件为受信任的服务端代码，可访问 daemon 主机的文件、进程、凭据和网络。

详细步骤和回滚：[插件发布与升级](https://github.com/tiezbro/paseo-agy-acp/blob/vX.Y.Z/docs/operations/plugin-releases.md)、[ACP 额度与插件说明](https://github.com/tiezbro/paseo-agy-acp/blob/vX.Y.Z/docs/operations/paseo-quota.md)。

## 验证

发布前填写本标签的 CI 链接、主项目与插件测试结果、已发布 npm 包安装验收结果，以及实际验证的平台和 Paseo 版本。真实账号验证与假内核测试分开列出；未执行的检查明确标注，不沿用其他版本的通过结果。
