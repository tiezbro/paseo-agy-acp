# 分组模型修订与验收

## 修订基线

以维护者在 PR #24 的决定及 v2.9.1 为基线。恢复账号实际提供的受支持 Claude/GPT‑OSS 目录，撤回初版修复中恢复扁平 `models` 的做法。会话及配置更新继续通过 `configOptions` 提供分组选择。

触发条件：官方账号目录包含第三方模型，但内核按客户端身份过滤了这些条目；初版修复同时恢复了 Paseo 优先读取的扁平列表，违背既定分组界面。因此保留目录兼容补丁，统一删除旧 `models` 字段，仅清理模型选项的显示名，不更改选项值、模型 ID 或内核档位解析。

菜单显示 Gemini 3.8 Flash、Claude Sonnet 4.6、Claude Opus 4.6、GPT-OSS 120B。Gemini 的 Low/Medium/High 在独立控件选择。当前账号的 Claude/GPT‑OSS 只有一档，保留其真实 ID，不合成额外档位控件。

Skill 防落盘、轮次与取消、stderr 精确过滤、托管缓存失效四项修复继续保留。`2aac48c` 仍是分支祖先，89 条脱敏映射不变。

## 可重复的真实验收

使用已有登录账号，运行独立 loopback Paseo 0.16.2 daemon 和托管官方 1.5.0 内核。脚本使用真实 AgentManager 保存选项、关闭运行时并从存储重新加载，不停止生产 daemon。

```bash
PASEO_LIVE_CLI_ROOT=/path/to/@getpaseo/cli \
  node scripts/verify-paseo-grouped-models-live.mjs
```

脚本对目录中的每个 Claude/GPT‑OSS 模型执行选择、短文本生成、冷恢复、历史校验码生成；随后切换 Gemini 三档并分别冷恢复。隔离内核包装器通过额外的同会话 `session/load` 探针读取官方实际模型 ID，探针响应不交给 Paseo；此探针不修改模型选择，但会重新加载该隔离会话。原始正文、认证环境及异常文本不写入报告，输出仅包含模型选择与断言结果。

初版验收脚本直接使用 ACP 客户端历史 handle，没有模拟 daemon 持久化的模型配置；官方跨进程加载会先使用默认模型，不能据此判断 daemon 恢复失败。最终脚本使用 daemon 的 `setAgentModel`、`setAgentThinkingOption`、运行时回收及 `ensureAgentLoaded` 路径，验证持久化配置重新应用后的实际选择。

## 自动化范围

产品回归覆盖新建、加载、恢复、配置回包中的分组名称与真实 ID，以及嵌套选项、未知元数据和输入对象不可变性。Paseo 0.16.2 已加入精确锁定的客户端 CI 矩阵，保留 0.13.2、0.14.0、0.16.0 基线。真实账号生成验收需在有凭据的本机显式执行，不将账号凭据交给公共 CI。

## 本机结果

2026-11-22 隔离 daemon 验收返回 `passed: true`，Paseo 0.16.2 配合托管 1.5.0 内核：

| 菜单名称 | 实际模型 ID | 验证结果 |
| --- | --- | --- |
| Claude Sonnet 4.6 | `claude-sonnet-4-6` | 首次生成、冷恢复、恢复后历史校验码生成通过；无档位选择器。 |
| Claude Opus 4.6 | `claude-opus-4-6-thinking` | 首次生成、冷恢复、恢复后历史校验码生成通过；无档位选择器。 |
| GPT-OSS 120B | `gpt-oss-120b-medium` | 首次生成、冷恢复、恢复后历史校验码生成通过；无档位选择器。 |
| Gemini 3.8 Flash | `gemini-3.8-flash-low/medium/high` | 三次切档及逐档冷恢复通过，额外恢复 High 后仍正确。 |

本地产品测试 46 个文件、393/393 通过；四版本客户端契约分别 5/5、8/8、5/5、5/5；Linux provider 2/2、配置清理 4/4，架构与敏感信息扫描通过。快照祖先关系及全部 89 条映射校验通过。文档通过 markdownlint 和 lint-md。本机验收不代表完整浏览器 UI 或其他平台官方内核验收。
