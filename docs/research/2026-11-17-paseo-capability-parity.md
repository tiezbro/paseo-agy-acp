# 官方内核全能力接入 Paseo：覆盖、缺口与共同决策

日期：2026-11-17 America/Los_Angeles。实施分支 `refactor/official-core-paseo-lightweight`，
本轮开始 HEAD `e19d09f`，工作树干净。用户补充要求：官方内核当前全部能力适配到 Paseo，
语义冲突共同决策；精简不以损失能力为代价。本文是可复查的覆盖盘点，不是全能力验收通过证书。

## 2026-11-18 分支现状

下方首轮矩阵以锁定的 Paseo 0.16.0 作对照。配套分支 `b9726d2d` 与适配器 `bea1662` 的实现及实测已覆盖部分原有缺口。

| 事项 | 当前证据 |
| --- | --- |
| 账号 | 已确认新建和冷恢复采用宿主机官方认证配置。账号选择与状态页面待实现，详见文末决策。 |
| 并发 | 全局 Admission、席位和启动间隔已删除。四个独立适配器进程在约 0.26 ms 内提交四轮，全部完成。直连四轮也全部完成。三路运行中取消均返回 `cancelled`。实际服务端模型并行度和账号吞吐上限仍未知。见[四路实验](2026-11-17-lightweight-runtime-results.json)。 |
| 连接与会话 | 同一代理连接内同时收到的 `session/new` 按序转发，以关联无请求 ID 的早期通知与 cwd。单代理内按 `sessionId` 拒绝重叠 prompt，Paseo 的会话对象也限制一个活动前台轮次。两种保护均属于局部约束。 |
| 配套界面 | 已有模式策略、系统信息、附件、模型与思考等级切换、附加目录和原生参数。隔离浏览器单规格 8/8 通过。 |
| 真实执行 | 通过附加目录随机值读取、PDF 内容识别、Gemini 4 Hydrogen 切换后推理和冷恢复后的 stdio MCP 调用。详情见[脱敏实测](2026-11-18-kernel-comparison.json)。 |
| 终态 | 配套 `acp-agent.ts` 的 `handlePromptResponse` 单独处理 `cancelled`，把 `end_turn`、`max_tokens`、`max_turn_requests`、`refusal` 都映射为 `turn_completed`。已有可信停止原因的分支也会损失区别。官方只送普通正文加 `end_turn` 是另一个独立缺口。 |

## 版本和证据边界

- 实时读取官方 Registry `https://raw.githubusercontent.com/agentclientprotocol/registry/main/antigravity-acp/agent.json`，版本仍为 1.5.0。
- 官方源码取自已按 Registry SHA-256 校验的 Linux 归档；本机 `/tmp/agy-acp-150-audit/server-0.py` 与 `runtime/agy_acp_server.par`。PAR SHA-256 `8a35f63dd2284e3790a1d97dd0cb2236057c55a0c598b26f3bde022b843d5c04`。长期上游定位及下载证据见 [版本核验](2026-11-17-kernel-150-adapter-repair-plan.md)。
- 初始盘点时仓库托管 pins 为 1.4.5；后续分支已升级至 1.5.0 并完成临时目录 prepare／verify。生产未切换，详见下方后续实施记录。
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
| additionalDirectories | new／load／resume可透传 | 配套Provider设置页已提供会话参数入口，三条调用均发送；持久化完整参数块，恢复不混入新的默认目录 | 真实1.5.0新建／冷恢复已接受；目录实际读取和信任流程待验 |
| 模型目录、切换、自动替换通知 | 转发 model/config；另有本地目录与请求补丁 | 配套客户端优先configOptions模型系列，运行中使用会话实时目录；官方确认后同步模型与档位 | 真实初始化已验，推理／工具与更多模型仍待验 |
| thinking_level | 原样转发 configOptions 与配置请求 | 配套客户端保留官方名称、顺序、当前值及Thinking Level标题；换模型后更新档位，官方移除时清空 | 初始目录真实核验通过；交互见配套浏览器规格，真实多模型推理待验 |
| default／auto_edit／yolo | 已知模式／别名映射 | ACP mode/config 选择已有 | 原生工具权限验收 |
| 未知／未来官方模式 | 本轮改为原值传递，由官方接受或报错 | 可保留官方动态目录 | 不得静默降级 default；plan 历史别名已按确认移除 |
| 工具审批与拒绝 | request_permission 和返回原样转发 | 已有 permission 请求与操作选择 | 真实工具、持久许可、管理员策略验收 |
| 官方问答选择 | 官方通过 interaction_* 工具调用和 permission options 表达 | 0.16 有 chooser 识别：重复allow种类才阻止自动批准，并非所有交互都能识别；不能等同任意自由文本问答 | 用官方选项形状验证 UI；保留原生单选边界 |
| 文字与图片输入 | 内容块保留 | 真实客户端组装 text／image | 代理与客户端契约覆盖；真实多模态待验 |
| 音频、embedded context、resource link | 内容块保留 | 配套客户端复用上传入口，协商embeddedContext后发送resource_link／嵌入文本resource；无该能力时保留旧文本附件 | 上传、拒绝后继续输入已通过页面验收；真实模型媒体理解待验 |
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
| 原生工具过滤、MCP加载及输出参数 | 保留会话`_meta.antigravity`中的enabledTools／disabledTools、eagerMcpServers、mcpMaxOutputBytes | 配套会话参数入口支持原生metadata，新建／加载／恢复及保存值已验证 | 真实初始化已接受；工具限制与MCP执行效果待验 |
| 官方hooks与workspace trust | 留在官方加载／执行，转发其审批请求 | 通用permission卡可呈现；Auto Accept可能自动选trust，需验原生交互形状 | 尊重官方信任和企业策略；决定自动批准与交互问答的边界 |
| cancel、断连、清理 | 原生取消+本地终态修补；同会话互斥；退出清理 | 客户端取消、工具收尾、进程生命周期已有 | 取消超时会关闭共享连接，不能承诺异常超时完全隔离 |
| session/close的能力边界 | 兼容支持close的内核；不伪造能力声明 | 0.16关闭时按close能力位决定是否调用，再回收进程 | 官方1.5.0未声明／未实现close；不能把模拟内核close成功算作官方能力 |
| 结构化错误与未知扩展 | 原样保留；另有空轮次检查 | 标准RPC错误转失败；未知通知通常仅记录 | 普通正文＋end_turn的上游失败仍待处理；不猜测任意正文 |

### 源码复查入口

- 官方 `server-0.py`：initialize 2576、模式校验2718、配置2881、认证2966、logout3193、new3631、cancel3759、list3828、resume4112、load4209、MCP/技能配置4253、问答5381、prompt5499、原生thought6035、usage6394。
- Paseo 0.16 `acp-agent.js`：能力默认151、new1211、load/resume1240附近、权限1943、事件转换2327、输入转换2822。`GenericACPAgentClient`是否暴露某配置必须另查其构造参数，不能只看到基类支持就认定UI可用。
- 本仓库：`ACP Connector/official-kernel/proxy.ts`（请求、回包、生命周期）、`mode-map.ts`、`context.ts`、`system-message-fold.ts`、`mcp-protocol-bridge.ts`、`skill-mcp.ts`、`login.ts`、`kernel-compat-rc01-recipe.ts`。

## 已确认的实施决策

用户已确认以下六项；第5项以最新“无人值守全自动、最大权限”要求为准，取代此前问答／信任必须人工的建议。

1. **Paseo自身的能力入口**：在配套 MAACS 源码独立分支补认证、附加目录、原生音频／资源块及状态／UI；本仓库保留轻量协议桥。配套工作树 `/home/tiezbro/projects/MAACS-agy-capabilities`，分支 `feat/antigravity-official-capabilities`，基线 `240a073357a0e027a9aac64506b82a367447defa`。不改生产安装或重启 daemon。
2. **移除 `plan → default`**：保留官方 `/plan` 命令；不存在的模式交由官方明确报错，不伪装成只读模式。
3. **系统信息独立展示**：在 Paseo 保留系统／状态身份后，移除适配器 SYSTEM_MESSAGE→thought 转换；思考区只展示官方思考摘要，不制造上游未发送的思考。
4. **模型兼容扩展**：先保留仍必要的第三方模型兼容补丁并明确标记；对照1.5.0实测后删除官方已覆盖的部分。不能绕过管理员策略。
5. **模式决定自动化**：明确选择官方 `yolo`（无人值守）时，全自动处理工具授权、workspace trust与问答单选，使用可用的最大许可。普通 `default`／`auto_edit` 保留官方审批语义，旧 `auto_accept` 开关不能覆盖它们。ACP没有自由回答或推荐选项的标准字段；问答按官方选项顺序选择第一个允许项，工具许可优先 `allow_always`，再 `allow_once`；无允许选项时返回 `cancelled`，不伪造选项或无限等待。模式切换以官方成功确认的当前值为准。
6. **官方名称与交互语义**：开关／模式、模型与思考等级使用官方显示名，不更改大小写、重命名或造档位；优先configOptions的模型系列与当前值，切换后读取完整回包。ACP内核没有独立GUI，控件由Paseo呈现；官方当前会话未提供其他模型的档位时不推测，进入该模型会话后再展示。

上述决策尚不等于能力矩阵全部实现或通过验收。仍有语义冲突时共同讨论，不重复询问已授权事项。

## 可直接推进的工作及本轮改动

- 已修复未知模式静默降级；只映射自有的已知别名，其他值原样交官方校验。同时避免`constructor`／`__proto__`命中原型属性而损坏字段。
- 新增代理契约覆盖：能力与认证元数据、附加目录、原生context、多模态块、config与未来扩展、原生事件、权限与客户端fs/terminal往返。模拟事件仅证明协议保真，不证明官方执行或UI消费。
- 新增Paseo0.16.0私有锁定fixture及CI矩阵，继续保留旧版本回归；所有客户端版本增加thinking配置和图片输入契约。运行时npm依赖没有增加。
- 1.5.0托管产物已升级并做单轮冒烟；补丁去重、原生工具与多模型、长任务、全部能力的UI端到端验证仍需继续；本轮未合并、发布或切换生产。

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

## 后续实施记录：模式、系统信息、托管1.5.0

- 删除plan→default；公开官方模式元数据，默认／自动编辑=false，无人值守=true；配套Paseo以成功确认的模式决策，处理已有待答问题并保存最后模式，普通模式不继承旧Auto Accept权限。
- 系统封套保留文字并标记为系统，由配套客户端映射notification；原生thought不变，旧客户端保留正文。没有伪造上游不存在的思考。
- 六个平台的1.5.0归档URL／SHA256取自实时Registry。Linux x64 PAR、harness及四个前像哈希重新核对，五个补丁锚点在临时目录全部匹配，prepare／指定artifact verify通过。其他平台本机未执行。
- 真实托管兼容产物冒烟：Gemini 3.8 Flash High，1/1通过，首个内核输出约61.806秒，无工具／thought帧。该结果说明本地队列删除后上游首响应仍可能很慢，不证明低延迟或完整能力通过。脱敏收据见 `2026-11-17-managed-150-smoke.json`。
- 本仓库与配套MAACS都保持独立分支，未发布、推送、合并或切生产。剩余能力入口、真实工具／多模型／长任务以及错误终态仍须继续。

- 本阶段最终验证：`npm run validate` 36文件324测试通过；三版本Paseo客户端18项、provider2项通过；配套客户端128项、浏览器2条规格通过。浏览器记录为配套工作树 `tmp/e2e-release/spec-2026-11-18T05-41-39-831Z/partial.txt`。这些记录覆盖模式与系统信息，本表剩余能力并未因此完成。

## 配套客户端：官方选项名称与模型联动

配套分支已修正旧models优先导致的模型系列展开、思考选项被复制到所有模型、官方移除档位后旧值残留，以及显示名被强制转小写。会话实时目录通过可选协议字段送达UI，模式与思考选择器保留官方标题。模型选择被内核拒绝时保持已确认状态；恢复保存最后确认的模型和思考值。

真实1.5.0初始化经本地适配器和配套Paseo客户端完成，约12.33秒：6个模型系列，当前gemini-3.8-flash/high，模式Default、Auto Edit、YOLO，没有额外运行时Auto Accept。见[脱敏收据](2026-11-17-official-selection-smoke.json)。这次没有发推理或工具请求，不证明延迟问题已解决，也不证明其他能力完成。客户端、浏览器与lint基线记录以配套仓库docs/antigravity-acp-capability-canary.md为准。

配套浏览器单规格 `acp-mode-policy.spec.ts` 最终6/6通过、退出码0，收据为 `tmp/e2e-release/spec-2026-11-18T06-41-20-273Z/partial.txt`。覆盖官方名称、模型切换后的动态档位、移除档位与拒绝后保留原选择，并复验既有模式、系统通知和附件流程。此为隔离daemon与模拟ACP内核的界面验收，不是生产或真实推理验收。

## 配套客户端：原生会话参数

Provider设置页增加会话参数入口，使用 `options.session` 配置官方 `additionalDirectories` 与 `_meta`。保留字段名、顺序、空数组与未知metadata，原有cwd、sessionId与mcpServers仍由其现有入口管理。未协商附加目录的内核会收到明确的客户端错误。只保存session参数块，冷恢复不混入后来修改的provider默认目录或metadata；显式恢复覆盖仍优先。

完整服务端构建、服务端和界面typecheck通过；针对性服务端87项、界面表单与翻译43项、浏览器单规格8/8通过。浏览器收据：配套工作树 `tmp/e2e-release/spec-2026-11-18T07-42-06-554Z/partial.txt`。界面设置页6项lint错误与原HEAD基线一致，新增表单代码lint通过。

真实官方1.5.0接受带附加目录和原生metadata的新建及冷恢复：新建11.264秒、恢复15.053秒，恢复后本地参数快照一致。见[脱敏收据](2026-11-17-official-session-options-smoke.json)。未发推理或工具请求；不证明工具过滤、目录访问、MCP加载效果、长任务或性能问题已完成验收。认证入口与其余真实执行证据仍需补齐。

## 11月18日补验

没有保存参数的旧会话也已加入回归，配置的新目录、MCP 和工具参数仅用于新会话。服务端针对性用例 87/87 和类型检查通过。

同一个未经修改的官方 1.5.0 可执行文件、同一模型、同一句无工具请求，交换直连与适配器顺序。直连完成用时 9.61、9.89 秒，适配器为 42.43、11.90 秒。首个内核输出和客户端正文使用不同的计时起点，两者之差不能当作精确转发耗时。四轮均返回指定正文与 `end_turn`，均无思考摘要。这两对样本不能区分远端波动与适配器对请求上下文的影响。

在全新的临时主目录中，官方内核公布四种认证方式和 logout 能力。未提供密钥时 `authenticate(gemini-api-key)` 返回成功，`session/new` 随即返回 -32000 并提示缺少 GEMINI_API_KEY。页面不能仅凭 authenticate 的成功回包宣称账号可用。临时环境 logout RPC 返回成功。官方源码还区分 OAuth 凭据、已选方式和仍可用的外部凭据；跨会话账号状态不能单从 logout 回包推断。详见[脱敏实测记录](2026-11-18-kernel-comparison.json)。

单独记录上下文准备阶段的真实请求耗时 13.19 秒，其中 daemon context 为 0.489 秒，收到首个内核输出为 13.11 秒（包含上下文准备）。这组顺序对照不控制远端负载，无法据此解释历史 502。

配套 Paseo 客户端经托管 1.5.0 完成了三项真实任务：读取附加目录文件内预先生成的随机值、从上传 PDF 识别随机码，以及切到 Gemini 4 Hydrogen 的 high 档位并准确回复指定文本。冷恢复后的 stdio MCP 两次各收到一次调用；第二次最终回复含工具产生的随机码，两次都带额外文字，严格文本匹配失败。测试经过客户端接口，浏览器证据沿用隔离规格。

**账号切换范围已于 2026-11-18 确认，设置页待实现。** 设置页切换宿主机的官方认证配置，后续新建和冷恢复按官方可用凭据初始化。Paseo 允许其他运行中的任务继续，不为切换身份主动取消、重启或广播切换。界面分别表达选定的认证方式和实际验证结果。OAuth 退出按官方行为处理，外部 API key 和 Gateway 的状态按各自语义呈现。操作者确认本次没有运行中的 paseo-agy-acp 会话。

官方 1.5.0 的工作区 hooks 信任另有时序区别。`new_session` 创建配置时调用 `load_hooks_config_async(resolved_cwd)`，没有传 `ask_user_fn`；该函数只在提供回调且信任状态未知时询问。后续 hook 的 `run` 路径才传入用户选择回调。因此源码不支持通常在 `session/new` 阻塞等待这个信任弹窗的判断。真实工作区 hooks 交互仍待验收。
