# 历史资料脱敏与证据关系

本 PR 从功能修复 PR #20 拆出，只替换历史文档、验收记录和代理说明中的个人主目录与内网镜像地址，并同步一处文档契约常量。它不修改产品行为、官方内核补丁或运行时兼容收据，不创建版本或发布包。

[逐文件映射表](repository-redaction-map.json) 列出全部 89 个文件的修改原因、原始与脱敏后 Git blob、两份文本各自的 SHA-256。表中不重复现场路径或地址。原始内容绑定到表中的 sourceCommit，可由 Git 历史独立读取；脱敏文本不能冒充原始字节证据。

PR 合入最新 main 后，sourceCommit 同步为 PR #20 的合并提交，以包含 CHANGELOG 新增的 v2.7.1 条目。redactionCommit 固定为合入 main 后的脱敏快照。当前映射对应包含该条目的完整文本；此前映射及其基准仍保留在 Git 历史中。没有重写旧提交或历史验收的结论。

历史 receipt 内记录的代码提交、工件哈希和验收结论保持原样，仍指向当时的原始材料；它们不是脱敏后 receipt 文本的新校验和。映射表保留两者的关系，资料清理本身不代表重新执行或复核原验收。

这次没有重写 Git 历史，旧提交中的原始内容仍然存在。检查未发现真实密码、私钥、OAuth 凭据或访问令牌。本 PR 保留通用系统路径、loopback 地址和测试占位值；现场测试日志、部署文件与本地凭据不纳入仓库。自动 secrets scan 只覆盖现有规则，不能证明不存在任何形式的敏感内容，也不扫描或删除旧提交中的原始内容。

## 只读校验与 CI

在包含完整 Git 历史的项目根目录执行：

```bash
node scripts/verify-repository-redaction.mjs
node scripts/verify-no-secrets.mjs
node scripts/verify-no-secrets.mjs --root docs/design/receipts
```

CI 的独立 job **Read-only redaction mappings and secrets** 使用完整历史 checkout（fetch-depth: 0），只申请 contents: read，不持久化 Git 凭据；无需安装依赖或获取业务凭据。校验失败时 job 立即失败，不自动 fetch、改写映射、写入 blob 或修改文件。

验证器强制 89 个唯一相对路径，并逐条核对 sourceCommit 与 redactionCommit 均可读取且为 commit、前者是后者的祖先、两份快照的路径与各自 blob 的关系、两个 blob 的可读取性和各自 SHA-256、当前普通文件与脱敏 blob 的逐字节一致性及 Git blob ID。

路径覆盖由 sourceCommit 到 redactionCommit 的 Git 差异独立推导，不能只靠映射表自报。除工作流、映射、本文、验证器及其回归测试这 5 个明确的校验辅助文件外，所有变更路径必须与 89 条映射完全对应。覆盖边界固定为本次脱敏快照，之后的无关功能提交不会被误报为遗漏；当前 89 个文件仍须与映射完全一致，后续修改这些材料必须更新映射和快照。

验证器还对每个映射文件单独执行 secrets scan，覆盖默认仓库扫描排除的历史 receipt 和 NDJSON。job 另外运行全仓扫描与 receipt 目录扫描。输出仅含计数、路径和校验结果，不打印原始文件或匹配到的凭据。

隔离 Git 仓库回归测试覆盖成功路径、校验前后工作树不变、缺失对象、摘要篡改、重复／遗漏／越界路径、额外改动、当前文件漂移，以及摘要仍正确但 NDJSON 新增凭据时失败。

现有历史文档格式问题保留原样；不通过批量重排改变更多历史字节。
