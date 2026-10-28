# 历史资料脱敏与证据关系

本 PR 从功能修复 PR #20 拆出，只替换历史文档、验收记录和代理说明中的个人主目录与内网镜像地址，并同步一处文档契约常量。它不修改产品行为、官方内核补丁或运行时兼容收据，不创建版本或发布包。

[逐文件映射表](repository-redaction-map.json) 列出全部 89 个文件的修改原因、原始与脱敏后 Git blob、两份文本各自的 SHA-256。表中不重复现场路径或地址。原始内容绑定到表中的 sourceCommit，可由 Git 历史独立读取；脱敏文本不能冒充原始字节证据。

历史 receipt 内记录的代码提交、工件哈希和验收结论保持原样，仍指向当时的原始材料；它们不是脱敏后 receipt 文本的新校验和。映射表保留两者的关系，资料清理本身不代表重新执行或复核原验收。

这次没有重写 Git 历史，旧提交中的原始内容仍然存在。检查未发现真实密码、私钥、OAuth 凭据或访问令牌。本 PR 保留通用系统路径、loopback 地址和测试占位值；现场测试日志、部署文件与本地凭据不纳入仓库。

在项目根目录运行以下只读命令，可复核全部映射和当前脱敏文本。命令只输出计数，不打印原始内容：

```bash
node --input-type=module <<'JS'
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
const map = JSON.parse(readFileSync("docs/operations/repository-redaction-map.json", "utf8"));
const digest = text => createHash("sha256").update(text, "utf8").digest("hex");
for (const row of map.files) {
  const sourceBlob = execFileSync("git", ["rev-parse", map.sourceCommit + ":" + row.path], { encoding: "utf8" }).trim();
  assert.equal(sourceBlob, row.originalBlob);
  const original = execFileSync("git", ["cat-file", "blob", row.originalBlob], { encoding: "utf8" });
  const redacted = execFileSync("git", ["cat-file", "blob", row.redactedBlob], { encoding: "utf8" });
  assert.equal(digest(original), row.originalSha256);
  assert.equal(digest(redacted), row.redactedSha256);
  assert.equal(digest(readFileSync(row.path, "utf8")), row.redactedSha256);
}
console.log("redaction mappings verified:", map.files.length);
JS
```

其他源文件和锁文件应与 sourceCommit 一致。现有文档格式问题保留原样，只对脱敏文本做校验；不通过批量重排改变更多历史字节。
