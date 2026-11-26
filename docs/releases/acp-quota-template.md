# vX.Y.Z：ACP 账号额度查询与可选 Paseo 面板

维护者使用说明：这是发布正文模板，不代表功能已经发布。发布前替换全部 `X.Y.Z`、填写本标签的实际验证结果，并删除本段和下方验证占位说明。

## 新增功能

- `paseo-agy-acp --usage` 通过官方 ACP 内核查询独立 ACP 账号的额度，不调用 `agy` CLI，不发送模型生成请求。
- 可选插件在 Paseo 原生「使用情况」面板展示 Gemini、Claude/GPT 的周额度、5 小时额度及上游提供的重置时间。
- 适配器与插件随同一个 npm 包发布，统一使用 X.Y.Z 版本。终端查询不需要插件；面板插件要求 Paseo 0.17.4 或更新版本。

## 安装

在运行 Paseo daemon 的主机上，使用与现有 ACP provider 相同的账号环境：

```bash
npm install --global paseo-agy-acp@X.Y.Z
paseo-agy-acp --prepare-kernel
paseo-agy-acp --usage
```

需要面板时，开启 daemon 的插件功能并安装：

```bash
paseo plugin install npm:paseo-agy-acp@X.Y.Z:plugins/paseo-agy-acp
```

已有插件使用 `paseo plugin update paseo-agy-acp --version X.Y.Z`。当前插件调用全局或 provider 配置的适配器，请同时更新适配器，不能只更新插件。新账号使用 `paseo-agy-acp --login`；已有 ACP 登录继续沿用，不需要切换 CLI 账号。

## 迁移与限制

- 已有同名普通 ACP provider 需移除 `extends` 和 `kind`，保留 `command`、`env` 等配置，交由插件注册，再热加载配置。
- 目录来源的开发插件需先备份设置再切换来源，不能对相同 ID 重复安装。
- 查询会创建独立短会话，内核可能保留会话记录并刷新令牌。未报告的额度或重置时间保持未知，错误不伪装为 100% 剩余。
- 插件为受信任的服务端代码，可访问 daemon 主机的文件、进程、凭据和网络。

详细步骤和回滚：[插件发布与升级](https://github.com/tiezbro/paseo-agy-acp/blob/vX.Y.Z/docs/operations/plugin-releases.md)、[ACP 额度接入](https://github.com/tiezbro/paseo-agy-acp/blob/vX.Y.Z/docs/operations/paseo-quota.md)。

## 验证

发布前填写本标签的 CI 链接、主项目与插件测试结果、已发布 npm 包安装验收结果，以及实际验证的平台和 Paseo 版本。真实账号验证与假内核测试分开列出；未执行的检查明确标注，不沿用其他版本的通过结果。
