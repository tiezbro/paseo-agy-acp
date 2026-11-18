# 官方内核全能力接入 Paseo：覆盖、缺口与共同决策

日期：2026-11-17 America/Los_Angeles。实施分支 `refactor/official-core-paseo-lightweight`，
本轮开始 HEAD `e19d09f`，工作树干净。用户补充要求：官方内核当前全部能力适配到 Paseo，
语义冲突共同决策；精简不以损失能力为代价。本文是可复查的覆盖盘点，不是全能力验收通过证书。

## 版本和证据边界

- 实时读取官方 Registry `https://raw.githubusercontent.com/agentclientprotocol/registry/main/antigravity-acp/agent.json`，版本仍为 1.5.0。
- 官方源码取自已按 Registry SHA-256 校验的 Linux 归档；本机 `/tmp/agy-acp-150-audit/server-0.py` 与 `runtime/agy_acp_server.par`。PAR SHA-256 `8a35f63dd2284e3790a1d97dd0cb2236057c55a0c598b26f3bde022b843d5c04`。长期上游定位及下载证据见 [版本核验](2026-11-17-kernel-150-adapter-repair-plan.md)。
- 仓库托管 pins 仍为 1.4.5。1.5.0 的历史显式实验不等于已升级托管产品。
- 仓库此前只锁定 Paseo 0.13.2／0.14.0。现场本机安装 CLI 所依赖的 `@getpaseo/server` 是 0.16.0；本轮增加独立锁定 fixture，不声称它是最新 Paseo，也不据此推断当前 daemon 的进程版本。
- 下表 Paseo 源码以 `tests/fixtures/paseo-client-0.16.0/node_modules/@getpaseo/server/dist/server/server/agent/providers/acp-agent.js` 为准。安装目录不是产品源码，不在其中打补丁。Paseo UI 与生产尚未验收。
- 官方npm锁定0.16.0客户端 `acp-agent.js` SHA-256为`f600f3dc3fdb0db729aa3883a1ebac293a1f492a32a0eecce36cee9422e22c95`；现场同版本文件为`337960861c95a9a9d2c9e2b65337b2c940d373f8c5f038d680e4d8cfd1734e18`，二者内容不同，不能用版本号代替源码一致性证明。以下明确采用锁定npm版；现场版另行运行相同隔离客户端契约。
- 适配器的通用双向转发允许未特判的 RPC 和字段通过，但这不保证客户端会生成请求、处理结果或展示控件。底层闭源 harness 的全部行为不能仅从 Python 服务层证明。

## 能力矩阵

“协议覆盖”指本仓库代理可交付；“客户端支持”指锁定客户端实际存在调用／转换；“待验”不等于缺失。通用ACP的plan、session_info、terminal、close等支持单独注明，不算官方1.5.0已有能力。
官方精细接口清单另见 [官方能力盘点](2026-11-17-official-capability-inventory.md)。

| 官方能力 | 代理处理 | Paseo 0.16 入口／状态 | 尚需工作 |
| --- | --- | --- | --- |
| initialize、能力协商、版本 | 保留 capabilities、authMethods、扩展；覆盖产品身份 | 建连接时协商，但 capabilities 不自动变成全部 UI 控件 | 逐能力真实验证 |
| 个人 OAuth、企业 OAuth、API key、Agent Platform | authenticate 双向透传 | 通用 ACP 客户端未发现认证方法选择与 authenticate 调用；外部预登录可复用 | 认证入口；便捷 `login` 当前只选个人 OAuth |
| 条件式 Gateway 认证 | 保留协商字段和认证参数 | 需客户端 auth capability、官方 rollout 开关及管理员策略允许 | 明确的条件式入口，不能强行宣告已支持或绕过策略 |
| logout／官方退出命令 | 原生 RPC 与命令可透传 | 通用 ACP 客户端未发现 logout 调用；slash 命令可作为原生入口 | 退出后的会话／凭据状态和重新登录交互验收 |
| new／load／resume | 补 cwd、daemon context、技能 MCP；返回字段保留 | 已有新建、冷恢复及历史加载路径 | 1.5.0 原生恢复、技能／MCP恢复验收 |
| 会话列表、导入 | session/list 及字段透传 | 已有 listImportableSessions／importSession | 官方1.5.0忽略cursor、无分页；验列表与历史完整性，不虚构分页能力 |
| additionalDirectories | new／load／resume 可透传该字段 | 客户端三条调用目前仅组装 cwd、mcpServers（恢复另有 sessionId） | Paseo 配置、持久化与选择入口缺口 |
| 模型目录、切换、自动替换通知 | 转发 model/config；另有本地目录与请求补丁 | 已有目录、setModel 与配置更新 | 原生目录与兼容扩展分开记录；升级后模型／工具实测 |
| thinking_level | 原样转发 configOptions 与配置请求 | 按 thought_level category 映射思考选项 | 本轮补真实客户端配置契约；各模型实测待做 |
| default／auto_edit／yolo | 已知模式／别名映射 | ACP mode/config 选择已有 | 原生工具权限验收 |
| 未知／未来官方模式 | 本轮改为原值传递，由官方接受或报错 | 可保留官方动态目录 | 不得静默降级 default；plan 历史别名仍待共同决定 |
| 工具审批与拒绝 | request_permission 和返回原样转发 | 已有 permission 请求与操作选择 | 真实工具、持久许可、管理员策略验收 |
| 官方问答选择 | 官方通过 interaction_* 工具调用和 permission options 表达 | 0.16 有 chooser 识别：重复allow种类才阻止自动批准，并非所有交互都能识别；不能等同任意自由文本问答 | 用官方选项形状验证 UI；保留原生单选边界 |
| 文字与图片输入 | 内容块保留 | 真实客户端组装 text／image | 代理与客户端契约覆盖；真实多模态待验 |
| 音频、embedded context、resource link | 内容块保留 | toACPContentBlocks 对非文字／图片走文本附件转换 | Paseo 原生内容块入口与类型缺口；官方_parse_prompt1249起实际解析音频和资源，但模型支持仍有条件 |
| 正文、思考摘要、工具开始／结束 | 原生 thought/tool 事件保留；正文有展示转换 | 映射 assistant_message、reasoning、tool_call 等 timeline | 原生帧→Paseo UI同轮对照；上游没发摘要不能制造 |
| 官方 `/plan` 命令 | 命令及正文／工具产物转发 | slash列表可达；ACP plan事件也可映射timeline | 官方1.5.0本身不发plan事件；不能把通用客户端支持当官方现有能力，更不能等同只读模式 |
| 使用量、上下文占用 | usage_update 与扩展保留 | 有 usage 状态处理 | 1.5.0 tracker语义、恢复基线与UI核验；官方不发session_info_update，不支持原生改标题 |
| 账号 tier 元数据 | `_meta.antigravity` 保留 | 已核对的通用 ACP 状态路径没有专门 tier 展示 | 产品入口是否需要独立控件待与 Paseo能力落点一起确定 |
| 官方 `/usage`、`/logout` 等命令 | 与技能命令合并，官方同名优先 | available_commands_update → 命令列表 | 原生命令结果与登录状态联动验收 |
| stdio／HTTP／SSE MCP | 头格式整理；HTTP兼容桥；stdio保留 | MCP配置归一化并传入会话 | 当前协议桥固定兼容版本，需核对每个目标的真实协商，不能把所有MCP都当Paseo |
| 原生技能与工具 | 官方执行；技能呈现方式有本地补丁 | 工具事件已有展示路径 | 重验官方1.5.0是否可取代补丁 |
| Paseo／跨工具技能目录 | 本地发现、命令、只读技能 MCP | 用户可选命令，模型可按需读取 | 是扩展适配，不应冒充官方原生能力；去重不得丢目录／资源 |
| 原生 systemPrompt.append | 能力协商且显式启用时使用 | 默认动态 daemon context 每轮注入 | 官方session快照与Paseo动态变化不能直接互换 |
| fs客户端请求；原生命令执行 | 通用双向转发，亦兼容terminal RPC | 有终端生命周期；fs方法存在但默认能力声明关闭 | 官方1.5.0不调用客户端terminal，命令在harness执行；fs声明会替换部分原生工具，不能未经分析强开 |
| 浏览器、文件编辑、命令执行等官方工具 | 执行留在官方；转发工具事件／权限 | 通用工具展示、审批、终端支持 | 官方账号／策略／宿主条件依赖；真实工作流待验 |
| 原生工具过滤、MCP加载及输出参数 | 保留会话`_meta.antigravity`中的enabledTools／disabledTools、eagerMcpServers、mcpMaxOutputBytes | new／load／resume未提供这些metadata的通用入口 | 纳入Paseo会话配置与持久化，按官方条件暴露 |
| 官方hooks与workspace trust | 留在官方加载／执行，转发其审批请求 | 通用permission卡可呈现；Auto Accept可能自动选trust，需验原生交互形状 | 尊重官方信任和企业策略；决定自动批准与交互问答的边界 |
| cancel、断连、清理 | 原生取消+本地终态修补；同会话互斥；退出清理 | 客户端取消、工具收尾、进程生命周期已有 | 取消超时会关闭共享连接，不能承诺异常超时完全隔离 |
| session/close的能力边界 | 兼容支持close的内核；不伪造能力声明 | 0.16关闭时按close能力位决定是否调用，再回收进程 | 官方1.5.0未声明／未实现close；不能把模拟内核close成功算作官方能力 |
| 结构化错误与未知扩展 | 原样保留；另有空轮次检查 | 标准RPC错误转失败；未知通知通常仅记录 | 普通正文＋end_turn的上游失败仍待处理；不猜测任意正文 |

### 源码复查入口

- 官方 `server-0.py`：initialize 2576、模式校验2718、配置2881、认证2966、logout3193、new3631、cancel3759、list3828、resume4112、load4209、MCP/技能配置4253、问答5381、prompt5499、原生thought6035、usage6394。
- Paseo 0.16 `acp-agent.js`：能力默认151、new1211、load/resume1240附近、权限1943、事件转换2327、输入转换2822。`GenericACPAgentClient`是否暴露某配置必须另查其构造参数，不能只看到基类支持就认定UI可用。
- 本仓库：`ACP Connector/official-kernel/proxy.ts`（请求、回包、生命周期）、`mode-map.ts`、`context.ts`、`system-message-fold.ts`、`mcp-protocol-bridge.ts`、`skill-mcp.ts`、`login.ts`、`kernel-compat-rc01-recipe.ts`。

## 当前需要共同决策的事项

以下先记录方案，本轮不静默改变这些既有语义，也不改另一仓库或生产配置。

1. **Paseo自身的能力入口**。推荐在用户指定的 Paseo／MAACS 源码分支补认证、附加目录、原生音频／资源块及相应状态／UI；本仓库保留轻量协议桥。仅在这里增加slash命令或拼接文字会损失原生语义，不能视为达到完整适配。需确定跨仓库实施范围及目标产品源码分支。
2. **`plan → default`**。官方当前没有对应的只读Plan模式，官方对未知模式会报错。推荐移除该别名并使用官方模式名称，让不支持的plan明确不可用；计划事件仍正常展示。如果产品确实要只读Plan，需要在Paseo设计真实权限边界，不能保留同名但有不同权限的映射。
3. **系统提示伪装成思考摘要**。推荐在Paseo为系统／状态信息保留清晰身份，原生thinking才进思考区，再删除适配器的SYSTEM_MESSAGE→thought转换。仅此仓库可先恢复正文，但那会改变阅读体验，需要确认过渡方式。
4. **原生目录与本地模型扩展**。当前补丁扩大特定第三方模型对Paseo的可见范围，并修整请求；严格原版目录与保留历史兼容扩展是不同产品策略。推荐先保留并明确标为兼容扩展，按1.5.0逐项实测，官方已覆盖的部分再删除；不得把固定本地白名单当作官方完整目录或擅自扩大管理员授权。
5. **自动批准与交互问答**。官方把工具授权、workspace trust和用户单选共用permission请求；Paseo的Auto Accept只用选项kind识别部分chooser。建议普通工具审批可按用户配置自动批准，原生问答／信任决策保留人工选择；需要对实际官方请求形状建立可靠识别，再共同决定边界，不能自动替用户回答问题。

## 可直接推进的工作及本轮改动

- 已修复未知模式静默降级；只映射自有的已知别名，其他值原样交官方校验。同时避免`constructor`／`__proto__`命中原型属性而损坏字段。
- 新增代理契约覆盖：能力与认证元数据、附加目录、原生context、多模态块、config与未来扩展、原生事件、权限与客户端fs/terminal往返。模拟事件仅证明协议保真，不证明官方执行或UI消费。
- 新增Paseo0.16.0私有锁定fixture及CI矩阵，继续保留旧版本回归；所有客户端版本增加thinking配置和图片输入契约。运行时npm依赖没有增加。
- 1.5.0正式托管升级、补丁去重、原生工具与多模型、长任务、UI端到端验证仍需继续；本轮未合并、发布或切换生产。

## 验收门槛

每个官方能力都需有明确状态和证据；官方条件不满足的能力记录条件，不标成适配完成或擅自开启。
能力表无未解释缺口、关键路径经过真实内核与真实Paseo验证、冲突得到决策之后，才评估合并。
本轮验证：

- 未知模式代理回归先红：3项失败；修正后通过，包括普通未知值、`constructor`和`__proto__`。
- `npm run validate`：TypeScript、构建、36文件319测试、架构边界、秘密扫描和live-config4项通过。
- `npm run test:paseo-client`：0.13.2为5/5，0.14.0客户端＋daemon为8/8，0.16.0客户端为5/5，总计18项通过。
- 现场安装的0.16.0（内容不同于npm fixture）另外运行相同客户端契约5/5通过，日志`/tmp/paseo-capability-host-client.log`；这仍是隔离内核契约，不是生产daemon验收。
- 三个fixture的锁文件校验通过；0.16.0安装使用`npm ci --ignore-scripts`，未增加产品运行时依赖。
- 日志：`/tmp/paseo-capability-validation.log`、`/tmp/paseo-capability-clients.log`。

这些测试使用模拟内核；本轮未新发Google推理请求，也未做生产／浏览器UI验收。
现有功能通过不代表全能力目标已经达成。
