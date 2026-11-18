# paseo-agy-acp

Google 官方 Antigravity ACP 内核的轻量 Paseo 适配器。

[English](./README.md) | [中文](./README.zh-CN.md) | [Changelog](./CHANGELOG.md)

本分支为尚未发布的轻量化迭代。托管内核仍固定为 1.4.5；独立的 1.5.0 实验不代表安装版本已升级。

本轮目标是让官方内核全部能力在 Paseo 中可用；当前尚未全部完成。协议透传、客户端入口和 UI 验收分别记录在[能力覆盖与待决策清单](docs/research/2026-11-17-paseo-capability-parity.md)。

<!-- readme:positioning -->
## 产品定位

`paseo-agy-acp` 通过 ACP NDJSON 将 Paseo 连接到官方 `agy_acp_server`。认证、模型执行、工具、推理、重试和会话持久化由官方内核负责；适配器负责 Paseo 上下文、技能与协议兼容。

独立 provider id 为 `paseo-agy-acp`，显示名称为 `Antigravity Pro`，可与 Paseo 内置 `antigravity` 共存。官方 ACP 登录状态位于 `~/.gemini/antigravity-acp`。Google 内核单独下载，不随本 Apache-2.0 包分发。本项目由社区维护。

<!-- readme:value -->
## 适配能力

| 能力 | 适配行为 |
| --- | --- |
| 模型与思考 | 转发目录、选择、配置及原生思考摘要；另保留第三方模型兼容补丁 |
| 工具与权限 | 保留工具事件、权限请求及客户端答复 |
| 会话生命周期 | 支持新建、加载、恢复、取消与进程关闭；session/close按内核能力协商 |
| Paseo 上下文 | 注入 daemon context；显式启用时协商原生 context 能力 |
| 技能 | 合并 slash command 元数据，通过会话级 MCP 暴露技能资源 |
| MCP | 保留 HTTP/SSE 端点并提供必要协议兼容 |
| 错误 | 保留 JSON-RPC 错误，拒绝完全没有可见输出的成功空轮次 |

独立会话直接派发，不再增加适配器排队、席位限制、启动间隔或冷却。同一活动会话的第二个 prompt 会被拒绝。这不代表上游账号拥有无限并发额度。只有内核实际发送思考摘要时才能显示，适配器不会生成替代推理内容。现有展示兼容仍将特定系统消息折叠到思考区，因此思考区内容不全是模型摘要；该行为列入待决策清单。

<!-- readme:architecture -->
## 架构

```text
Paseo / ACP client
  -> paseo-agy-acp
       identity | daemon context | modes | MCP | skills
       session cancellation | output compatibility | diagnostics
  -> official agy_acp_server
       OAuth | models | tools | inference | conversation history
```

每个 connector 进程运行一个官方内核子进程。适配器没有调度数据库，也没有运行时 npm 依赖。官方内核自己的会话数据库完整保留。同一连接的 `session/new` 仍按序绑定，因为早到的命令更新没有 request id；这不会串行化不同会话的 prompt。

<!-- readme:requirements -->
## 运行要求

- Node.js 22+
- 支持自定义 ACP provider 的 Paseo
- 获授权使用官方 Antigravity 服务的账号
- 使用托管 Linux x86_64 兼容包装器时，以非 root 用户运行

<!-- readme:quickstart -->
## 试用本分支

先本地构建；已发布的 npm 版本尚不包含本次迭代。

```bash
npm ci
npm run build
node "dist/ACP Connector/main.js" --doctor
node "dist/ACP Connector/main.js" --prepare-kernel
node "dist/ACP Connector/main.js" --login
```

`--doctor` 只检查本地安装。准备命令按需下载固定版本的官方内核；登录使用官方 OAuth。无桌面主机可在浏览器完成授权，再将 localhost 回调粘贴到该主机终端。

隔离 Paseo 测试配置示例，替换其中的绝对路径：

```json
{
  "agents": {
    "providers": {
      "paseo-agy-acp": {
        "enabled": true,
        "extends": "acp",
        "label": "Antigravity Pro",
        "command": ["node", "/absolute/path/paseo-agy-acp/dist/ACP Connector/main.js"]
      }
    }
  }
}
```

provider 配置对新启动的 agent 生效。本分支通过验收后，再安排生产切换与固定版本的 npm 启动命令；迁移说明见下文。

<!-- readme:configuration -->
## 配置

| 变量 | 用途 |
| --- | --- |
| `PASEO_AGY_ACP_OFFICIAL_BIN` | 指定已有内核或包装器的绝对路径；不设置则使用托管安装 |
| `PASEO_HOME` | Paseo 目录，默认 `~/.paseo` |
| `PASEO_AGY_ACP_NATIVE_SYSTEM_CONTEXT` | `1`：仅在内核声明支持时使用原生 context |
| `AGY_ACP_DIAGNOSTICS` | `1`：向 stderr 输出固定字段耗时，不记录 prompt 或凭据 |
| `AGY_ACP_CANCEL_TIMEOUT_MS` | 取消确认等待超时，正整数毫秒，默认 30000 |

| Paseo mode | Official mode |
| --- | --- |
| `default` | `default` |
| `accept-edits` | `auto_edit` |
| `dangerously-skip-permissions` | `yolo` |
| `plan` | `default` |

`plan` 当前仅是 `default` 的历史别名，不提供只读 Plan 权限；是否删除该别名待共同决策。未知模式原样交官方校验。

权限请求在答复或取消前保持活动。原生 `yolo` 与 Paseo Auto Accept 是独立配置。网络代理需配置在 provider 环境中，并将本地 MCP 端点加入 `NO_PROXY`。

技能发现支持配置目录、工作区与全局 Gemini/Agents/Codex 目录，以及 Paseo 兼容目录。命令冲突时原生命令优先，工作区技能优先于全局技能；`user-invocable: false` 不显示 slash 提示。技能读取限制在已发现的目录内，每文件最多 1 MiB。

<!-- readme:operations -->
## 运维与验收

部署时移除旧 `AGY_ACP_ADMISSION_*` 和 `AGY_ACP_STATE_DIR` 配置。旧账本不再读取，也不会被自动删除；`agy-acp-prepare-state` 入口已移除。明确的内核错误透传；上游把失败编码为普通正文加 `end_turn` 的情况仍需专项处理。删除调度不能解决服务端 429/502/503 或模型生成耗时。

- [Admission retirement / 迁移](docs/operations/admission.md)
- [Lightweight architecture / 轻量化验收](docs/operations/lightweight-adapter.md)
- [Kernel compatibility / 内核兼容](docs/operations/official-kernel-compat-runbook.md)
- [Paseo verification / Paseo 验收](docs/operations/paseo-adapter-verification.md)
- [Cross-host / 跨主机](docs/operations/paseo-cross-host-e2e.md)
- [npm publishing / npm 发布](docs/operations/npm-publishing.md)

<!-- readme:development -->
## 开发验证

```bash
npm run validate
npm run test:paseo-provider
npm run test:paseo-client
```

客户端测试需要按验收指南安装锁定的 fixtures，使用真实 Paseo 客户端及模拟内核。需要真实账号对照时，显式运行：

```bash
node scripts/compare-kernel.mjs --run --kernel /absolute/path/agy_acp_server.par --concurrency 4 --groups native,adapter
```

探测共用现有账号额度，拒绝工具权限，两组固定同一模型，异常即停并清理自建进程。报告只保存耗时和状态，不保存模型正文或原始错误文本。历史证据保留在 `docs/research/` 与 `docs/design/`。

<!-- readme:license -->
## License

[Apache-2.0](./LICENSE)
