# 通用会话与文档能力审计（2026-10-17）

状态：审计完成，缺陷未修复；方案与设计尚未展开。

## 1. 本轮边界与依据

负责人要求按“先审计，再做方案，再设计”推进。会话定位是能讨论、分析、生成和修改多类文档的通用助手，Word、Excel、PPT 均在审计范围；PPT 的视觉设计和多轮修改是重点。图片功能不纳入缺口、实施范围或验收要求，不引入固定自动生成流程，不把代表页预览设为必经步骤。

当前属于既有能力维护。依据为最新负责人要求、AGENTS.md、PLANS.md 顶部维护记录、当前源码及本地测试。审计基线为 `feature/www-video-contract-binding@c2f8ac696da3fb39dd368233a0142e458e80b9cf`；没有切换运行应用或推断用户窗口已加载该版本。

仅新增本报告、离线复现证据和 PLANS 顶部登记，不修改业务源码和现有测试，不提交、合并或推送。未读取凭证或真实用户项目，未调用外部 Provider，未生成新 PPT，未重启应用，未扫描工作区外归档。AGENTS.md 指定的 V1.2.1 交接包路径在当前工作区不存在，因此本轮不提供与该权威 UI 原件逐项一致的验收结论。

## 2. 已有能力与实际入口

| 能力 | 当前事实 | 审计边界 |
| --- | --- | --- |
| 通用会话 | AgentContextAssembler 让模型结合会话回答、追问或调用工具；已有等待、预算、取消、租约、恢复和 unknown 门禁 | 不能据此认定所有文档能力都已成为 Agent 工具 |
| Word / Excel 文件生成 | 存在聊天草稿、通用 DocumentGeneration IPC、文件生成与正式收据路径 | 当前 Agent 原生工具目录没有对应生成工具；已有 Electron 验收通过独立 IPC 完成这两类文件 |
| PPT 新建 | `generate_pptx` 连接内容编译、Design IR / designTree、布局求解、渲染、QA、Hash 与 Work 登记 | 自主规划失败时可按已批准策略使用基础模板兜底 |
| 已有 PPT 读取与文字编辑 | 绑定真实文件和物理对象身份，提供读取、改文字、加文字、删元素及加空白页工具 | 这些工具不能表达对已有页重新构图或修改配色、字体系统 |
| PPT 视觉修改 | 独立 Office 应用路径有受控视觉 revision；新版自主设计有显式构图与样式 | 视觉 revision 与新版设计树存在兼容缺陷；主 Agent 缺少对应重设计工具 |
| 成品检查 | 本地 Office/PDF 渲染、几何与文字检查及确定性视觉信号已存在 | 技术校验通过不构成专业视觉质量验收 |

入口证据：

- [Agent 原生工具准备与生成要求](../../src/platform/documents/conversation-document-tool-session.ts#L274)。
- [工具唯一目录](../../src/domain/entities/canonical-tool-contract.ts#L119)。
- [聊天按执行模式选择 Agent 或文档生成入口](../../src/pages/chat/ChatPage.tsx#L2616)。
- [Word / Excel Electron 验收调用独立文档 IPC](../../scripts/verify-agent-provider-mock-electron.cjs#L316)。
- [独立 Office 入口确实注入原作品生产计划读取](../../electron/ipc/document-generation-ipc.ts#L198)。该接线已核实，不登记为“完全没有接入”。

## 3. 发现清单

### A01 / P1 / 已复现：禁止立即生成的否定句被标记为必须生成

Agent-native 准备逻辑通过 PPT 动词匹配和“直接 / 立即 / 马上”等正向子串判断 generationRequired，没有识别同句否定与先后顺序。以下三条隔离输入均得到 `generationRequired=true`、`generationAuthorization=approved`：

1. `先讨论PPT方案，不要直接生成`
2. `不要马上制作PPT，先讨论`
3. `我不想立即生成PPT，先分析内容`

`先帮我设计PPT结构` 得到 false，`立即生成PPT` 得到 true，说明问题集中在否定语义。无既有编辑会话时，generationRequired 会继续影响 Provider 的 required 工具选择。

证据：[准备逻辑](../../src/platform/documents/conversation-document-tool-session.ts#L282)、[正向子串判定](../../src/platform/documents/conversation-document-tool-session.ts#L1489)、[required 工具选择](../../src/platform/documents/conversation-document-tool-session.ts#L1244)。离线证据字段为 `intentCases`。

影响：与“先讨论、再方案、最后执行”的交互要求直接冲突。本轮只复现了错误判定，没有发起真实模型请求，也没有把它扩写为“每次必然生成文件”。

### A02 / P1 / 代码确认：多类文档具备生成能力，但 Agent 工具接线不统一

当前对 Provider 暴露的规范工具仅为 `read_document_structure`、`update_element`、`add_element`、`delete_element`、`add_slide`、`generate_pptx`。生成工具、Agent 指令和文档读写会话主要针对演示文稿。Word / Excel 的文件生成经通用文档服务和兼容路径完成；相应 Electron 样例先获取正文，再显式调用 prepareGeneration / generateFromMessage。

证据：[工具目录](../../src/domain/entities/canonical-tool-contract.ts#L135)、[Agent 指令](../../src/platform/documents/conversation-document-tool-session.ts#L1458)、[Word / Excel 验收路径](../../scripts/verify-agent-provider-mock-electron.cjs#L316)。离线证据字段为 `providerTools`。

影响：不能用“Word / Excel 物理文件验收通过”证明它们已具备与 PPT 相同的原生会话工具闭环。具体用户路径还受 Thread-first 执行开关影响；本轮不把现有 Word / Excel 能力记为不存在。

### A03 / P1 / 代码确认：已有 PPT 的语义重设计缺少原生工具入口

update_element 只能改一个真实元素的文字，add_element 只能加文字，add_slide 加空白页。它们没有页面构图、设计树、配色或字体系统参数。当前生成工具则创建新演示文稿，并不接受基于已有 Work 的受限重设计参数。

证据：[改文字合同](../../src/domain/entities/canonical-tool-contract.ts#L157)、[加文字合同](../../src/domain/entities/canonical-tool-contract.ts#L183)、[加页合同](../../src/domain/entities/canonical-tool-contract.ts#L234)、[生成合同](../../src/domain/entities/canonical-tool-contract.ts#L265)。

影响：模型即使理解“保持事实，把第二页重新排版”，当前原生工具也缺少准确表达该操作的能力。独立 Office 视觉 revision 的存在不能替代原生 Agent 工具可达性。

### A04 / P1 / 已复现：新版自主设计的视觉修改会失败，也可能没有可见变化

以仓库现有三页纯文字自主设计夹具为基线，编译结果为 valid：

- `第二页更简洁一点`、`把第二页改成科技感流程图` 均抛出 `presentation_design_ir_invalid`。原因是旧 revision 写入 visualTreatment，而新版解析器明确禁止 designTree 与 visualTreatment 共存。
- 在带显式 palette / 树样式的同一夹具上，把 colorDirection 从 accent-led 修改为 restrained，前后均编译 valid，但全部 Render Plan 页面内容、几何和样式完全相同。该案例证明设计元数据改变不必然落实为可见修改；不扩大为所有配色修改均无效。

证据：[视觉 revision](../../src/application/presentation-design-revision.ts#L58)、[禁止字段共存](../../src/domain/entities/presentation-design-contract.ts#L796)、[自主树样式覆盖](../../src/platform/documents/presentation-render-plan-compiler.ts#L287)。离线证据字段为 `revisionCases`、`colorCase`。

影响：持续优化可能直接失败，或只改了内部意图字段。原有视觉 revision 测试使用旧 fallback 设计并检查 IR 字段，未覆盖本轮自主树的可见结果。

### A05 / P2 / 已复现有限窗口：多轮约束未稳定传递到设计阶段

默认模型上下文保留最近 40 条已完成消息，超出后截断历史。42 条合成用户消息的案例中，首条“先讨论、不生成”约束已不在模型输入中。上下文长度必须有界，但当前上下文装配没有额外注入持久的需求约束摘要。

Art Direction 另取最多 8 条用户消息，并在遇到已交付文档时停止。帮助函数的 9 条用户消息案例丢失最初风格约束；Agent 原生路径也有独立的 `brief.length < 8` 上限，已通过源码核对。

证据：[40 条窗口](../../src/application/conversation-context-builder.ts#L52)、[原生设计 brief](../../src/platform/documents/conversation-document-tool-session.ts#L1104)、[独立 Office brief](../../src/application/document-generation-service.ts#L1550)。离线证据字段为 `contextCase`、`briefCase`。

影响：长会话中早期确定的风格和流程要求可能未到达后续模型阶段。本轮只确认输入保留缺口，没有声称任何真实模型已经违反丢失约束，也不建议取消预算上限。

### A06 / P2 / 代码与编译确认：视觉检查尚未成为质量闭环

PresentationVisualAudit 仅产生 warning，multimodalReview 固定为 not_available。占用率使用元素包围框面积相加，未区分文字实际墨迹面积、背景与前景；因此该数字不能直接表示观感拥挤程度。基线夹具出现 visual_crowded_page 时仍返回 valid Render Plan，编译 diagnostics 为空。

证据：[确定性视觉信号](../../src/platform/documents/presentation-visual-audit.ts#L18)、[编译成功返回](../../src/platform/documents/presentation-render-plan-compiler.ts#L167)。离线证据字段为 `deterministicVisualAudit`。

影响：当前无法据此证明标题与主体关系、视觉焦点、页面节奏及修改效果达到专业标准。本地真实渲染和越界检查仍有效；“没有多模态模型”不应等价为“没有任何 QA”。

### A07 / P2 / 已复现策略边界：初次规划格式错误会直接退出设计修正

planExecutablePresentationDesign 的有限修正循环要求已有可解析 designIR。隔离规划器第一次返回无效 JSON、第二次预备返回有效设计时，实际只请求一次，得到 invalid_json，没有有效设计。随后生产 Runner 可依据已批准策略进入基础模板兜底。

证据：[修正循环入口](../../src/platform/documents/presentation-design-planning.ts#L14)、[生产兜底](../../src/platform/documents/document-generation-runner.ts#L309)。离线证据字段为 `planningCase`。

影响：“最多两次设计修正”并不覆盖所有初次规划失败。该行为是当前兜底策略的边界，不能记成未经授权的回退或自行取消已批准的兜底政策；本轮也没有测量真实兜底率。

### A08 / P2 / 设计阶段边界：内容与视觉规划缺少返回上游的协同

Art Direction 固定页数，要求引用留在原页、所有内容原子完整覆盖；修正反馈还要求保留全局设计和非目标页。这保护了事实与范围，但该阶段无法因内容过密或过空重新组织分页或改写正文。

证据：[固定页面与引用](../../src/domain/entities/presentation-design-contract.ts#L436)、[内容完整覆盖](../../src/domain/entities/presentation-design-contract.ts#L450)、[目标页修正](../../src/application/presentation-art-direction.ts#L98)。

影响：当问题来自上游信息组织时，后续布局修正能力有限。此项登记为能力边界，不把内容身份、事实保护和局部修改范围本身登记为缺陷。

### A09 / P2 / 验收缺口：执行正确与视觉满意尚未分别建立证据

最近自主设计记录中的三种构图由 synthetic offline planner fixtures 提供；真实 Electron 接受受控 Mock Transport，真实收费模型的设计质量及多模态审美未验收。相关测试能够验证模型设计被执行、内容与身份保留、文件可渲染，不证明真实生成的设计令人满意。

证据：[自主设计验收记录](../evidence/llm-autonomous-design-20261014/validation.json)、[实际启动目录验收限制](../evidence/autonomous-design-activation-20261014/validation.json)。

本轮没有取得用户当前不满意的那一份 PPT，因此未给出该文件逐页问题、对应生产分支、实际回退原因或当前运行窗口版本的结论。

## 4. 验证结果与限制

- 本轮现有定向回归：14 文件、322 项通过、0 失败、0 跳过。涵盖会话意图与 Workflow、上下文、Session / Continuation、文档生成、PPT 真实文件修订保存、生产设计与有界修正、模板兜底。
- 离线复现直接运行当前 TypeScript 源码：7 条执行意图输入、2 条新版视觉修订拒绝、1 条配色元数据变化但渲染不变、2 个有界上下文保留案例、1 个无效初次规划案例。工具目录另做规范合同检查。
- 复现脚本返回成功表示“当前缺口稳定复现”，不表示业务缺陷通过验收。脚本不执行文档工具，不读真实用户仓库，不发网络请求，仅在本次证据目录写入 reproduction.json。
- 仅增加审计记录，未重新做生产构建、完整回归、真实 Provider 交互、macOS 实机或用户实际 PPT 逐页评审；不沿用历史全量结果冒充本轮新验收。
- 本轮检查与完整命令记录在 [validation.json](../evidence/conversation-document-audit-20261017/validation.json)，源码 Hash 和合成复现结果在 [reproduction.json](../evidence/conversation-document-audit-20261017/reproduction.json)。

复现命令：`node docs/evidence/conversation-document-audit-20261017/reproduce.cjs`。

## 5. 本轮交付与下一阶段输入

实际修改仅为审计报告、离线复现脚本与证据、PLANS 顶部登记。A01 / A04 缺陷仍未修复，其余能力边界和验收缺口尚未实施处理。

下一阶段“方案”的输入是上述可复现问题、入口能力差异和验收限制。方案需要分别说明通用会话的讨论 / 执行语义、多类文档的工具可达性，以及 PPT 的已有作品重设计与视觉修改效果如何验收。当前没有提前决定交互流程、页面原型或技术实现；“设计”阶段尚未开始。
