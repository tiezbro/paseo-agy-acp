> Historical instructions, retired by the lightweight adapter iteration. Commands and source paths below describe the pre-removal experiment. See `../operations/lightweight-adapter.md` for the current design.

# Admission 隔离对照

此脚本用于评估全局排队是否有收益。它从当前构建直接启动适配器，绕过可能写死
Admission=true的生产启动脚本，不连接／重启Paseo daemon，也不修改生产队列。
启用组使用现行8/8/2000ms策略。它不提供“开启队列但间隔为0”的第四种配置。

## 本地验证

```bash
npm run build
npx vitest run tests/admission-comparison-script.test.ts tests/admission-sqlite-contention.test.ts
```

模拟内核测试验证：同模型、三组实际进程、关闭组不创建账本、开启组真正排队、运行中
和队列中取消、异常后停止后续组。它不能证明云端吞吐或上游可靠性。

## 真实内核比较

先准备并认证一个明确版本的官方独立ACP内核。`--kernel`指向二进制或独立包装器；
直接使用Linux `.par`时脚本添加Registry要求的`--uid=`，同目录需有匹配的
`localharness_external`。现有兼容包装器也可传入，但必须明确自己比较的是哪一版本。
脚本不会升级托管内核，也不会自动安装兼容补丁。

```bash
node scripts/compare-admission.mjs
# 上一条只打印用法，不发模型请求。
node scripts/compare-admission.mjs --run \
  --kernel /absolute/path/agy_acp_server.par \
  --concurrency 1 --output /absolute/path/compare-1.json
```

每组先创建全部会话，固定第一个会话返回的模型ID（或显式`--model ID`），然后同时
提交固定短回复请求。测试客户端拒绝工具权限和文件／终端请求。出现错误、超时、
非预期结束、非预期回复或工具调用时，停止后续组，不自动重试。

单并发通过后，用相同模型交错组顺序，逐步比较3和4并发，再依据结果决定是否扩大到6/8：

```bash
node scripts/compare-admission.mjs --run \
  --kernel /absolute/path/agy_acp_server.par --model MODEL_ID \
  --concurrency 3 --groups off,on,native --output /absolute/path/compare-3.json
node scripts/compare-admission.mjs --run \
  --kernel /absolute/path/agy_acp_server.par --model MODEL_ID \
  --concurrency 4 --groups on,native,off --output /absolute/path/compare-4.json
```

取消对照使用`--groups off,on --cancel-after-ms 1000`。如果请求在计时器之前已经正常
完成，该行记录passed且cancelAckMs=null，不能算作取消验收。`admissionWaitMs`在排队取消时也可能有值，不能单凭它判断是否已经获得席位；
需结合账本事件中的状态转换区分运行中取消和排队取消。

## 证据与限制

- 每次调用使用新的0700临时目录；报告为0600，保留实验路径便于查看账本。
  开关隔离会删除继承环境里的`PASEO_*`和`AGY_ACP_*`配置，再设置实验值。
  当前工具只在Linux上验证开启组的进程身份和权限语义。
- 官方登录仍来自当前用户，临时账本不隔离云端账号／额度。运行时避免同账号生产流量
  干扰，短任务成功之后仍需重复、工具任务与长任务验证。
- 报告包含版本、二进制SHA-256、模型、会话ID、建立会话和prompt耗时、首个正文时间、
  Admission等待时间、工具与思考事件数、取消确认、终态及账本是否创建。
  若传入包装器，SHA-256仅标识该包装器，不能代替内部PAR／harness摘要。
- `submittedMs`和`finishedMs`只定义客户端prompt区间。请求数不是模型实际并发数；
  上游内部排队、重试及实际模型请求重叠需要另查原生轨迹。排队反馈可能使用thought
  事件，因此thoughtChunks也不能直接视为模型思考数量。
- 模型正文和provider stderr不写入报告。普通`end_turn`必须同时得到预期标记才算passed，
  防止把无回复结束计为成功；这仍不能代替原生轨迹中的错误／重试核对。
  RPC失败只记录方法、错误码及固定词表命中；这些关键词是诊断提示，不是可信HTTP状态分类。
- 超时默认120秒，可用`--timeout-ms`在1秒到5分钟内调整。清理时终止实验进程组。
  临时文件不会自动删掉，以便保存验收证据；确认无需保留后仅删除报告给出的实验目录。
- Admission-off仍使用适配器的上下文／MCP等逻辑，所以native/off差异不能归因于排队。
  on/off才是固定内核下的排队对照。顺序、热身和云端负载会影响结果，不以单轮耗时下结论。

选择策略时，同时看可靠性收益和成本。若目标负载下关闭组无回归，且开启没有保护
收益，才考虑调整部署默认值；取消、同session互斥和故障恢复需分别验收。此脚本
不自动修改部署策略。
