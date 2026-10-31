# Paseo 真实客户端测试依赖与信任边界

真实客户端契约测试使用两个独立私有 npm 项目：`tests/fixtures/paseo-client/` 固定 0.13.2 基线，`tests/fixtures/paseo-client-0.14.0/` 固定 0.14.0。它们只用于 CI 和显式运行的本地测试，不属于适配器运行依赖，也不进入 npm 发布包。

## 固定与完整性

- 直接依赖分别固定为 `@getpaseo/server@0.13.2` 和 `@getpaseo/server@0.14.0`，不使用 semver 范围或浮动 tag。
- 分别提交专用 `package-lock.json`，每个版本固定全部 336 个依赖工件的版本、下载 URL 和 SHA-512 integrity，包括当前平台不会安装的可选依赖。版本目录映射集中在 `scripts/paseo-client-versions.mjs`。
- 所有工件来自 `https://registry.npmjs.org/`，不接受 Git、file、link、带凭据或查询参数的来源。
- 安装前运行 `scripts/verify-paseo-client-lock.mjs`，只解析 JSON 和配置，不导入外部包。检查失败时停止安装。
- 通过 `npm ci` 安装；manifest 与 lock 不一致会失败，工件内容不匹配已锁定 integrity 也会失败。fixture 的 `.npmrc` 与 CI 命令均禁用安装生命周期脚本，不执行该依赖的 postinstall、原生构建或自动下载。

此策略固定复现输入并检测工件变化，不证明第三方代码本身安全。语义依据见 npm 官方的 [npm ci](https://docs.npmjs.com/cli/v11/commands/npm-ci/) 与 [package-lock.json](https://docs.npmjs.com/cli/v11/configuring-npm/package-lock-json/) 文档。

## CI 与发布隔离

产品验证 job 保留根项目自身的 `npm ci`、完整测试与架构检查；`better-sqlite3` 的原有构建策略不变。外部 Paseo 客户端安装和导入放在独立的 `paseo-client-compat` 矩阵 job、独立 runner 中执行，每个版本单独安装和验证。

工作流仅申请 `contents: read`，checkout 不持久化 Git 凭据，不接收 Google 登录目录、生产配置、发布 secret 或 OIDC 写权限。发布工作流和根项目运行依赖不引用测试 fixture；已有打包白名单测试继续拒绝额外目录。

`--ignore-scripts` 只约束 npm 安装生命周期。契约测试仍会显式导入外部客户端并执行其 JavaScript，因此这个只读、无业务凭据的 CI job 就是第三方代码执行边界；不能把禁用安装脚本解释为“不会执行外部代码”。测试只连接隔离内核与 loopback HTTP 服务。0.14.0 另使用真实 AgentManager、存储和空闲回收器验证生命周期，不连接生产 daemon 或 Google 账号。CI 显式将 `PASEO_COMPAT_VERSION` 与 `PASEO_COMPAT_CLIENT_ROOT` 固定为同一矩阵项；本地如手工覆盖后者选择其他安装目录，就不属于这里描述的锁定依赖复现。实际包版本仍须与预期版本完全相同。

## 本地复现与更新

在项目根目录执行：

```bash
node scripts/verify-paseo-client-lock.mjs
npm ci --prefix tests/fixtures/paseo-client --ignore-scripts --no-audit --no-fund --registry=https://registry.npmjs.org/
npm ci --prefix tests/fixtures/paseo-client-0.14.0 --ignore-scripts --no-audit --no-fund --registry=https://registry.npmjs.org/
npm run test:paseo-client
```

默认命令验证两个锁文件并依次运行两个版本。只运行单个版本时使用 `PASEO_COMPAT_VERSION=0.14.0 npm run test:paseo-client`；未知版本会直接报错。

更新客户端时必须显式修改固定版本、重建并审查专用 lockfile、同步测试版本断言和预检策略，再运行完整测试及真实客户端契约。不要在日常 CI 中用 `npm install` 重新解析依赖或自动改写 lockfile。
