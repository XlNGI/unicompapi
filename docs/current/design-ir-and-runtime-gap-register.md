# Design IR 与 Agent Runtime 缺口登记

记录日期：2026-09-30
代码基线：develop@9e90f6f
记录性质：维护与架构缺口登记，不包含业务代码修改，不将缺口标记为已完成。

## 2026-10-06 D-01 / D-03 / D-05 实施补充

负责人明确授权按建议执行后，当前支持的生成/读回主链路接入无损版本化 canonical content、Host 稳定身份与来源、唯一 Production Layout IR 和只读 Render Plan；内容/版本冲突、漏项或重复来源即使重算 Hash 也会拒绝。每次有限布局修正保留对应设计与事实，重新编译真实几何，写前持久化私有 candidate，并将 QA receipt/实际文件 Hash 与正式作品关联；收据和备份不能独立授权发布。

该范围本地验收完成：3625 项完整自动测试，类型/lint/生产构建/工程审计通过；真实本地强制修正与连续修改、三方向 9 页 Office 渲染、编译 Host/preload 隔离恢复 19 项、ChatPage 生产/StrictMode 各 7 项通过。事实与失败/性能日志见 [工程验收](d01-d03-d05-content-layout-repair-validation.md) 和 PLANS.md 顶部。

下方原 D-01/D-03/D-05 行仍保留为 2026-09-30 问题快照。旧 scene 仅显式文本框局部投影，精确源 XML 修改保留成熟 physical identity，旧父作品整篇重生成仍有明确兼容原因；没有将全部旧工作流与图片/复杂构图称为完整新 IR。D-02 完整 Host 策略、D-04/D-06 后续覆盖仍独立，预览/审美评分暂停，macOS 实机延期。未提交、部署或重启用户应用。

## 2026-10-05 R-04 / R-05 实施补充

负责人明确授权后，当前会话 Agent/受控 PPT 主链路已接入稳定父 Session、固定预算与等待版本、一次性续接令牌、执行租约 owner/epoch、主 metadata 跨进程 CAS 和统一恢复分类。已知本地投影只幂等修复，未知请求/工具结果冻结；正常等待、过期新任务、明确关闭与同一 Host 租约到期后的按需核对保持原身份和预算，不重发未知调用。两处绑定断点由主身份与消息 pin 补收据，正常结束历史不会挤满恢复名额。

R-04/R-05 在该范围本地验收完成：3520 项自动测试，类型/lint/生产构建及工程审计通过；真实隔离 Electron 生产/StrictMode 各 7 项通过。详情、失败/性能记录和证据见 [工程验收](r04-r05-session-recovery-validation.md) 与 PLANS.md 顶部。下方原 R-04/R-05 行保留为 2026-09-30 快照，不描述当前实现。只续接已有受控消息/工作流引用，没有从 Hash 自动重建任意工具参数，旧无 Session 独立入口未全面迁移；D-01～D-06、预览/审美 QA 与 macOS 实机仍未在本轮实施。

## 2026-10-04 真实调用的预算与交付补充

R-01/R-03/R-06 本地主链路验收后，最新真实调用暴露父预算按提案扣额、生成后旧工具重复请求、已有文件在失败响应缺少结果卡的问题。负责人授权修补；当前新实现区分提案与真实 Host 入场、给单纯生成增加受控读回/工具关闭收尾、页结构纯预检和独立保留文件投影。具体验证状态与未完成边界以 [工程记录](ppt-execution-admission-and-delivery-validation.md) 和 PLANS.md 顶部为准，不能据旧测试数量宣称这次补丁已验收。

## 2026-10-04 R-01 / R-03 / R-06 实施补充

负责人确认下一批并授权“可以实施”后，已接通当前拥有 AgentRun 的会话/受控文档链路：持久父 Runtime 固定身份和预算/deadline，模型、工具结果与 Observation 写入统一 checkpoint/事件；Runtime、事件与公开 Outbox 同一 metadata CAS。现有唯一 Provider Loop 负责实际执行，公开 Trace/UI 为安全幂等投影；重开补投影不重发模型或工具，未决副作用冻结，已登记 Work 保留。

R-01/R-03/R-06 按该主链路范围本地验收完成：3268 项自动测试、类型/lint/构建/工程审计通过，真实 Electron 生产/StrictMode 各 25 项通过。具体实现、故障注入及性能修补见 [工程记录](r01-r03-r06-persistent-runtime-validation.md) 与 PLANS.md 顶部。后面的原 R-01/R-03/R-06 行保留为 2026-09-30 问题快照。任意 step 自动续跑、跨进程租约/epoch、统一系统 Recovery 和同 Run 等待/授权恢复仍属于 R-05/R-04；无 AgentRun 的旧独立工作流未强制迁移。D-01～D-06、预览和新的审美 QA 未在本轮实施。

## 2026-10-03 R-02 / R-08 / R-09 实施补充

负责人随后授权实施 R-02、R-08、R-09；本轮按当前会话 Agent/受控文档主链路完成状态归属、真实完成门、未知结果贯穿及安全确认关闭。采用明确的本地 WAL/CAS/幂等投影，允许仅重做可证明安全的本地状态写入，不重跑模型或工具。最终 3171 项自动测试、类型/lint/构建/审计及真实 Electron 组件验收通过；详见 [三项工程验收](r02-r08-r09-execution-settlement-validation.md) 与 PLANS.md 顶部。

下表对应三行仍保留为 2026-09-30 问题快照。R-01/R-03/R-04/R-05/R-06、D-01～D-06 的完整关闭条件未因本轮而满足；独立旧工作流未强制迁移为统一父 Run。无法确认的远端提交继续冻结且禁止自动重放，不宣称完成所有服务商查询/补偿或完整 Recovery。

## 2026-10-03 R-07 实施补充

负责人随后明确要求“先完成 R-07”。本轮已实施现有生产执行链的统一 Host deadline/调用次数/调度预算、父子取消传播、启动中停止、迟到准入防护、精确停止诊断和持久截止时间；实现与最终验收见 [R-07 工程验收](r07-execution-budget-validation.md) 和 `PLANS.md` 顶部。R-07 按修补方案 A/B 的当前执行链范围收口；下表原 R-07 行保留为 2026-09-30 的问题快照，不再描述本轮完成后的代码状态。

本轮补齐了已完成响应的实际结算等待屏障，但没有建立新的统一持久 Agent Run、跨实体原子终态/事件流或 Recovery。D-01～D-06、R-01～R-06、R-08/R-09 的完整关闭条件保持未达到；未来父 Run 接入复用本次预算合同。逐页预览、新视觉 QA 与 Design IR 策略仍未在本轮实施；macOS 实机与 Unix 特殊后代进程清理维持延期边界。

## 2026-10-02 工程复核补充

下文保留为 2026-09-30 基线快照。已对照当前源码和 `PLANS.md` 顶部维护记录完成复核，并新增 [分批修补方案](design-ir-and-runtime-remediation-roadmap.md)。持续执行状态以 `PLANS.md` 为准；本次仅更新工程记录，没有启动 Runtime/Design IR 架构实现。

- D-01～D-06、R-01～R-09 仍未达到原登记的完整关闭条件。会话展示和普通页数规划目标调整没有关闭这些架构缺口。
- D-03 的旧 Layout IR 仍实际用于临时文档流程；D-04 的表格/图表已有当前 design-aware 支持，不能将其描述为全部未实现。
- D-05 仍存在后续 attempt 不传 Design IR 的问题，但当前文件 QA 修正仅允许布局修改且保留内容，已有修正/回退记录；缺少的是每个候选一致的 IR/Render Plan 身份与版本，而非完全无审计。
- D-06 已有部分非文本形状越界检查；仍缺非文本重叠/组合变换、真实字体替换、可读性及视觉回归。现有 `font_missing` 诊断不能证明实际字体替换已被检测。
- 当前 R-07 有直接的计时层级不协调证据：120 秒 Provider 循环短于 180 秒单生成工具及 360 秒文档任务预算；停止子类型被归一化丢失。先补原因记录和父子预算，再推进状态归属、持久 Run 与 Recovery，不以放宽 QA 或增大单个常量作为整体修复。

## 结论

当前 D3 已完成的是“现有支持范围内的 Design IR 生产闭环”，不是完整目标架构的全部实现。真实 kimi-k3 验收已经证明当前支持范围可以走通：

    Content Planning
      -> DocumentOutline / DocumentIR
      -> Art Direction
      -> Design IR v2
      -> Layout Constraints + Layout Solver
      -> Render Plan
      -> design-aware Renderer
      -> PPTX
      -> Office/PDF/PNG QA
      -> Hash / 原子发布 / Work 登记
      -> RegisteredReader / Observation 读回

验收事实已记录在 PLANS.md 顶部：8/8 页面走 design-aware，0 次 legacy fallback，Design IR v2、Render Plan、最终 PPTX 几何签名、Hash、RegisteredReader 和 Observation 读回一致。该结果不等于以下目标全部完成：统一的内容事实源、完整 Design IR 覆盖、修正循环中的 Design IR 保持、完整 Visual QA，以及可恢复的统一 Agent Runtime。

目标边界保持如下：

    ChatPage
      -> startAgentResponse
      -> AgentRunCoordinator
      -> runControlledProviderToolRounds()
      -> Tool Runtime / Bridge
      -> Observation
      -> LLM 下一轮

    Conversation Agent
      -> create_presentation(goal, instructions, sources)
      -> Presentation Generation Workflow
      -> Content Planning -> DocumentIR -> Art Direction
      -> Design IR -> Layout / Render Plan -> Renderer -> QA / readback

主 Agent 只决定是否创建演示文稿及其业务目标；PPT 内部生产 Workflow 负责如何生成。不得再新增第二个 while (tool_calls)，不得让主 Agent 绕过 Design IR、Render Plan 或 QA 直接编排渲染步骤。

## Design IR 缺口

| 编号 | 缺口与当前证据 | 影响 | 建议验收 |
| --- | --- | --- | --- |
| D-01 | **内容事实源分裂。** src/application/generate-pptx-tool.ts:65 创建 DocumentIR；Art Direction 接收其投影摘要，但 src/platform/documents/presentation-render-plan-compiler.ts:272 仍从 DocumentOutline 解析最终内容。 | 内容、设计和渲染不能围绕同一个稳定 IR 重放；DocumentIR 的修改可能无法完整传递到 Render Plan。 | 明确 DocumentIR 的内容原子、来源和稳定 ID；Layout/Render Plan 只消费经过校验的 IR 投影，并能从同一输入重放同一内容与身份。 |
| D-02 | **Design IR 不是强制生产门。** src/application/presentation-art-direction.ts:22 将缺失/超时/非法结果转为诊断；src/platform/documents/office-document-generator.ts:841、:850、:891 允许 legacy-fallback。 | 当前真实样例可全量走 design-aware，但其他请求仍可能退回旧模板，无法证明设计计划已被执行。 | 明确兼容模式与目标模式的策略；目标模式下 Design IR 缺失、非法或不支持必须产生可见受控失败，兼容模式的 fallback 必须显式登记、可审计且有覆盖率门禁。 |
| D-03 | **没有统一的生产 Layout IR。** 生产编译结果是 Layout Constraints、PresentationLayoutPageResult 和 PresentationRenderPlan（src/platform/documents/presentation-render-plan-compiler.ts:61）；另有旧 PresentationLayoutIR（src/domain/entities/presentation-design.ts），尚未成为生产统一中间产物。 | 同一概念存在多套表示，后续 Patch、预览、恢复和读回难以共享身份与几何事实。 | 选择唯一生产 Layout IR，定义 Design IR -> Layout IR -> Render Plan 的版本化合同，并让旧类型只保留明确兼容边界。 |
| D-04 | **Design IR 支持范围仍有限。** src/platform/documents/presentation-render-plan-compiler.ts:89 拒绝图片内容，:90-91 拒绝 radial 和 full-bleed。 | 图片、复杂流式构图和全出血页面不能进入同一 design-aware 链路，最终仍需旧路径或失败。 | 为图片资源、图表/表格、radial、full-bleed 定义受控语义和几何约束；每类能力有 schema、失败码、fixture、真实渲染和回读验收。 |
| D-05 | **修正循环会丢失 Design IR。** src/platform/documents/document-generation-runner.ts:287-288 仅在 attempt === 0 传入 designIR，后续内容修正明确回到 legacy path。 | 修正前后的生产语义不一致；修正候选可能绕过 Design IR 和 design-aware Renderer。 | 修正只更新内容/设计 Patch 并重新编译同一 Design IR/Render Plan；每次 attempt 都记录 IR 版本、Render Plan 版本、诊断和来源，不得无记录切换 renderer。 |
| D-06 | **当前 QA 不是完整 Visual QA。** src/platform/documents/office-render-adapter.ts:161-223 主要验证 PNG、页数、空页、PDF 可提取文本、文本越界和文本框重叠。 | 非文本元素重叠、真实字体回退、表格/图表可读性、像素级布局退化和视觉层级问题可能漏检。 | 在确定性结构 QA 之外增加脱敏的逐页视觉检查；至少覆盖元素边界/重叠、字体实际回退、表格/图表可读性和视觉回归基线，失败时保留页级诊断并阻止发布。 |

## Agent Runtime 缺口

| 编号 | 缺口与当前证据 | 影响 | 建议验收 |
| --- | --- | --- | --- |
| R-01 | **ConversationAgentRun 目前是响应生命周期投影。** src/domain/entities/conversation-agent-run.ts:27-39 只有会话、来源消息、父 Run、响应执行 ID、状态和时间；src/platform/ipc/conversation-response-controller.ts:706-716 创建它，:746-762 将它绑定并按响应终态结算。 | Run 本身不能恢复任意 Agent step，也不能从自身回答“当前执行到了哪个 tool call、Observation 是否已提交、还剩多少预算”。 | 将 Agent Run 变成持久执行事实，或建立明确的父级 AgentRunRuntime：保存 checkpoint、step、tool call、Observation、预算、deadline、取消原因、完成条件和未知结果，并通过 CAS 更新。 |
| R-02 | **Conversation Agent 与 Document Task Runtime 是两套状态机。** Agent Run 有 running/waiting_user/waiting_authorization/executing_tool/completed/failed/cancelled；src/domain/entities/document-task-runtime.ts:24-33 另有 planning/running/waiting_input/paused/cancelled/failed/completed/needs_reconciliation，当前没有统一机器校验的 AgentRun <-> TaskRuntime <-> ResponseExecution <-> Work 映射。 | 状态可能不同步；聊天 Run 已结束但文档任务仍在等待、对账或发布，或者重启后无法判断哪个实体拥有继续执行权。 | 定义跨实体状态映射、所有权和终态规则；每个状态转换都有原子写入、版本校验、取消语义和可重放测试。 |
| R-03 | **Agent-native 主链路尚非完整持久化 Agent Loop。** src/platform/providers/provider-tool-calling.ts:154-198 已有受控 Provider 工具循环，但聊天侧目前主要创建/绑定 Response Execution；DocumentTaskRuntime 的 step、tool call 和 Observation 持久化主要由文档 Agent 适配层承载。 | 复用 Provider Loop 不等于聊天 Agent 的每轮模型决策和工具 Observation 都进入同一个可恢复 Runtime；进程重启时不能保证从任意 Agent step 继续。 | 保留 runControlledProviderToolRounds() 作为唯一循环；由薄的 Coordinator 在每轮前后写统一 checkpoint、tool call 和 Observation，并验证重启后不会重复未知副作用。 |
| R-04 | **等待状态只有领域枚举，没有完整恢复协议。** Agent Run 定义了 waiting_user 和 waiting_authorization，但当前 Agent-native 请求在 src/platform/ipc/conversation-response-controller.ts:706-739 创建并直接启动响应执行，尚未形成“等待 -> 后续用户消息/授权 -> 恢复同一 Run/Task”的持久协议。 | 追问、授权和继续执行容易重新创建请求，无法稳定保持同一执行身份、预算和审计链。 | 持久化等待原因、恢复 token/版本和下一步允许动作；后续消息或授权只能通过校验后的恢复命令唤醒原 Run，禁止重复付费调用。 |
| R-05 | **Recovery 仍按子系统分散。** src/platform/documents/persistent-document-agent.ts:20-54 可恢复文档 Runtime；响应执行、Conversation Agent Run、工作流和文件对账仍分别处理。 | 启动恢复没有统一扫描、排序、租约和所有权交接，跨实体故障可能留下半完成状态。 | 增加统一 Recovery Coordinator：启动扫描 Agent Run、Task Runtime、Response Execution、Mutation Journal 和 Work；先处理未知副作用和租约，再决定继续、冻结对账或失败。 |
| R-06 | **事件没有统一持久事件流。** Production Trace、Response Stream、DocumentTaskRuntime、Provider invocation/acceptance 和 AgentRun 分别持有事件或摘要，缺少统一序列、幂等 event key、跨实体原子提交和重放协议。 | UI 看到的进度、Runtime 恢复事实和审计记录可能出现顺序或缺失差异，难以证明一次 tool call 的完整生命周期。 | 建立以 runId + sequence + eventId 为核心的脱敏事件合同；调用前写入、结果/Observation 写入和状态变更可幂等重放，UI 仅消费投影。 |
| R-07 | **预算、超时和取消边界未统一。** Provider Loop 自有 maxToolCalls/timeout/failure（src/platform/providers/provider-tool-calling.ts:311-369），DocumentTaskRuntime 另有 maxSteps/budgetUnits/timeoutMs（src/domain/entities/document-task-runtime.ts:71-75），Art Direction 和修正循环也分别计时。 | 子循环可能各自未超限但父任务已耗尽；取消可能只停止某一层，产生迟到结果或不一致的终态。 | 父 Agent Run 持有总 deadline/预算/取消信号，子循环继承剩余预算；统一耗尽码、取消传播、迟到结果处理和最终审计。 |
| R-08 | **完成条件仍按子系统定义。** 文档 Runtime 只有在其文档流程完成后才可进入完成；persistent-document-agent.ts:50-54 将 Agent 结果投影为 paused/failed/cancelled，而聊天 Run 在 conversation-response-controller.ts:756-762 只按 Response Execution 终态结算。 | “模型回答完成”“工具执行完成”“Work 已发布”“Observation 已读回”和“交付说明已生成”可能被错误当成同一个完成。 | 定义父 Run 的完成条件：最终回答、工具/子任务终态、Observation 持久化、文件/Work 注册、读回和交付说明按任务类型组合校验；任何未知结果不能进入完成。 |
| R-09 | **未知结果/对账状态没有贯穿 Agent Run。** DocumentTaskRuntime 已有 needs_reconciliation 和 tool call unknown；Agent Run 状态没有对应状态，Provider 已提交但响应未知时只能落为失败/中断投影。 | 重启或网络边界上的副作用无法在会话层表达，恢复逻辑可能重复调用或误报失败。 | 在父 Run 中增加 unknown/needs_reconciliation 语义或等价冻结状态；对每个外部副作用定义查询、确认、补偿和禁止重放规则。 |

## 处理顺序

以下顺序只作为后续实施边界，本登记不代表已开始实施：

1. 先统一 AgentRun、ResponseExecution、DocumentTaskRuntime 和 Work 的身份、状态映射、总预算及终态规则。
2. 保留并复用 runControlledProviderToolRounds()；新增的 Coordinator 只负责上下文装配、生命周期、持久化、流式和取消，不实现第二套工具循环。
3. 建立统一 checkpoint/event/outbox 与 Recovery Coordinator，先解决未知结果、跨重启和等待用户/授权恢复。
4. 再收敛 DocumentIR -> Design IR -> Layout IR -> Render Plan 的单一生产合同，保留显式 legacy 兼容边界。
5. 最后扩展 Design IR 支持范围和 Visual QA；每项能力都必须经过结构、渲染、读回、失败和取消验收。

## 当前验收边界

- 已完成并保留：D3 当前支持范围的 Design IR v2、Layout/Render Plan、design-aware Renderer、PPTX 生成、结构/文件 QA、Hash、原子发布、Work 登记和真实 kimi-k3 读回证据。
- 未完成：D-01 至 D-06、R-01 至 R-09 所描述的架构缺口；本文件将其作为后续优化与稳定性治理记录。
- 本轮未修改业务代码，未运行全量测试；仅应执行文档变更的 git diff --check，并在提交前检查新增链接与 Markdown 结构。
