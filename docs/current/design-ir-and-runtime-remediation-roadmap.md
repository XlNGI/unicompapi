# Design IR 与 Agent Runtime 修补方案

复核日期：2026-10-02。基线：当前 `feature/chat-send-input-runtime-fix` 工作树，HEAD `bef4797`，包含尚未提交的会话修复、展示优化和页数规划目标调整。

本文件是工程修补建议与复核快照，不代表架构实现已启动或缺口已关闭。持续执行状态和负责人决策只维护在 `PLANS.md` 顶部；原始编号与 2026-09-30 基线保留在 [缺口登记](design-ir-and-runtime-gap-register.md)。本轮没有修改业务代码，不重开已验收阶段，不扩大阶段 10。

## 2026-10-06 D-01 / D-03 / D-05 实施补充

负责人明确授权 G/H → I 后，当前支持的内容/设计生成和读回主链路已经接通 canonical content、稳定 Host 身份、Production Layout IR 与只读 Render Plan；有界 QA 修正保持同一设计并实际改变目标几何。私有计划写前持久、逐候选版本/Hash/父链、QA 收据及正式 Work 读回闭合；原文件与成熟 physical mutation 身份保留。最终 3625 项自动测试、类型/lint/构建/审计和真实本地文件/Office/隔离恢复验证通过，详见 [工程验收](d01-d03-d05-content-layout-repair-validation.md) 与 PLANS.md 顶部。

G/H/I 在该范围本地收口，原方案正文保留历史建议。旧 scene 是显式文本框局部兼容投影，旧父作品整篇重生成与精确源 XML 修改未伪装为完整新 Layout IR；不是全部旧入口与能力迁移完成。下一步仍为 J（D-02 完整设计执行策略），K（D-04/D-06 按类能力和质量覆盖）独立；预览、审美评分和 macOS 实机维持现有暂停/延期边界。当前改动未提交、推送、合并、部署或重启用户应用。

## 2026-10-05 R-04 / R-05 实施补充

负责人明确授权后，R-05 的执行租约与统一恢复分类、R-04 的稳定父 Session 与等待续接协议，已在当前拥有 Session 的会话 Agent/受控 PPT 主链路完成本地验收。固定 deadline/预算、等待版本和单次令牌持久化；已知本地投影幂等收尾，未知调用冻结且不自动重发。最终 3520 项自动测试及类型/lint/生产构建/工程审计通过，真实隔离 Electron 生产与 StrictMode 各 7 项通过；详见 [工程验收](r04-r05-session-recovery-validation.md) 和 PLANS.md 顶部。

后续旧日期补充及方案正文保留为当时快照，不描述当前实施状态。只续接已有受控消息/工作流引用，未从 Hash 重建任意工具参数，旧无 Session 独立入口未全面迁移。Design IR、逐页预览和审美 QA 不在本轮范围；改动未提交、部署或重启用户应用，macOS 实机继续延期。

## 2026-10-04 R-01 / R-03 / R-06 实施补充

负责人确认下一批并授权实施 R-01/R-03/R-06。当前会话 Agent/受控文档链路已完成 D 的持久父 Runtime、唯一循环钩子、checkpoint/事件/Outbox 单 CAS 与公开幂等投影的本轮验收（3268 项自动测试及类型/lint/构建/审计，真实 Electron 生产/StrictMode 各 25 项）；详见 [工程记录](r01-r03-r06-persistent-runtime-validation.md) 和 PLANS.md 顶部。补投影不重新执行，未知调用保持冻结；文档 Task/完成 WAL 沿用既有所有权与文件门禁。

以下 D/E/F 继续保留为建议快照。跨进程租约/epoch、统一系统 Recovery、任意 step 续跑和同 Run 等待/授权恢复未实施，属于后续 R-05/R-04；新的事件保存受控 Hash/引用，不包含可自行重发的原始参数。Design 线与审美 QA 未在这批实施。

## 2026-10-03 实施补充

负责人又授权 R-02/R-08/R-09；当前会话/文档主链路已完成 C 的所有权、完成门、本地 WAL/CAS 与未知结果闭环，补入显式本地核对和确认关闭。验收见 [三项工程验收](r02-r08-r09-execution-settlement-validation.md) 与 PLANS.md；后面的 C/E 方案正文继续保留为历史建议，完整持久 Loop、统一 Recovery/租约、统一事件和 Design 线不因此整体关闭。

负责人随后授权优先完成 R-07；本轮已实现 A 的停止原因与计时诊断、B 的现有 Host 父子预算/取消，并补齐已完成响应等待真实结算的屏障。当前执行链验收记录见 [R-07 工程验收](r07-execution-budget-validation.md) 与 `PLANS.md` 顶部。以下正文继续保留为 2026-10-02 的方案快照；C～K 没有因此整体完成，尤其不将统一父 Run、事件流、恢复、同 Run 等待和 Design/QA 能力标记为已实施。

## 复核结果

D-01～D-06、R-01～R-09 均仍未满足原登记的完整关闭条件。页数目标化解决了普通页数偏好被误当硬约束的问题；会话展示优化改善了阅读和进度展示。这两项不等于统一 Runtime、统一 IR 或完整 Visual QA 已完成。

需要保留并准确描述已有能力：

| 项目 | 已有能力 | 仍需修补 |
| --- | --- | --- |
| 工具执行与恢复 | `beginToolCall`、`recordObservation`、未知结果冻结、文档 Runtime 恢复已有实现 | 父 Run 的持久执行事实、跨实体所有权、统一恢复与等待协议 |
| 文件与作品 | 本地结构/渲染/Hash/原子发布/Work 登记；已登记作品遇到迟到取消或状态同步失败会保留 | 父 Run 能区分文件已交付、回复未完成、未知提交与等待对账 |
| 设计渲染 | 当前支持范围已完成 D3 生产验收；表格和图表已有 design-aware 路径，fallback 有原因与路径记录 | 图片、radial、full-bleed、scene 等边界；明确的主持层设计策略和完整覆盖率门禁 |
| Layout | Constraints、Solver layouts 与 Render Plan 已在生产链路使用；旧 Layout IR 也在临时文档流程使用 | 唯一版本化生产 Layout 合同及旧流程适配，不能直接删除旧类型 |
| QA | PNG/PDF、文本重叠、文本与部分非文本形状越界已有检查 | 非文本重叠/组合变换、实际字体替换、表格图表可读性及视觉回归 |

当前文件 QA 修正仅允许 `replace_page_layout`，实际保持内容并修改布局类别；但 Runner 仍只在首次 attempt 传入 Design IR。修正尝试已有记录，缺少的是与每个候选一致的 IR/Render Plan 版本及身份关联。Layout Solver 的内部修正和文件渲染后的修正循环必须分开记录。

## 优先修运行时的三个小 PR

### A：保留停止原因，先让日志可诊断

对应 R-07 的可观测性部分。Owner 为唯一 Provider Loop、NewAPI/DeepSeek adapter 与安全诊断合同。

- 保留 `timeout`、`failure_limit`、`budget_exceeded`、`no_progress`、`unknown_result`、`cancelled` 的原始子类型；旧 `tool_loop_limit` 仍可读取，但不能当作新的精确原因。
- 记录父/子 deadline、计时范围、已用/剩余时间、步数与预算、最后安全提交阶段；关联 run、response、task、tool call 的内部身份。
- 普通 UI 显示可理解的原因和下一步；路径、凭证、内部 Prompt、完整附件和原始模型数据不进入诊断。

验收：离线合成触发每种停止原因；响应、Trace 和审计原因一致，终态只提交一次，诊断脱敏。此 PR 只修可观测性，不关闭整个 R-07。

### B：让父子时间预算与取消一致

对应 R-07，以及 R-09 的最小迟到结果保护。Owner 为 Application 预算合同、DocumentToolSession、现有 Provider Loop 和 Tool Bridge。

当前文档会话已经有任务 horizon，可先把它作为该子任务的权威 deadline 传入唯一循环；未来持久父 Run 接入时使用同一合同。普通聊天保留自己的有界策略。预算由 Host 固定，模型不能增加时间、步数、费用或权限。

- 子步骤有效时限取 `min(父任务剩余时间, 子工具上限, 本地资源上限)`；模型续轮、工具准备、Art Direction、修正、QA 和发布均消费同一父预算。
- token 与进度不重置总期限；剩余时间或预算不足时不启动新步骤。网络空闲检测仍是独立保护。
- 父超时必须向当前请求/工具传播 AbortSignal，不能只标记超时后继续等待副作用。
- 明确提交前与提交后取消：未提交候选停止并清理；已登记作品保留并如实报告；提交事实未知时冻结并对账，不再次生成。

验收：假时钟覆盖“92 秒工具 → 25 秒模型 → 91 秒工具”及边界时刻。在被批准的父预算内，不得被隐藏的 120 秒子循环误截断；预算到期、网络长期空闲、用户 Stop 均有独立回归。截止后不得启动新的 Provider/工具调用；迟到提交不得丢失或重复登记作品。不能仅把常量改大来宣布 R-07 完成。

### C：按真实交付事实结算终态

对应 R-02/R-08，以及 R-01/R-09 的部分合同。Owner 为 Application 的薄 Completion Coordinator 与现有实体 Repository；UI 读取投影。

先定义 `AgentRun ↔ ResponseExecution ↔ TaskRuntime ↔ Work` 的身份、执行归属和状态映射，再实施结算。模型响应结束只表示回答流结束，父任务是否完成取决于任务类型。

| 事实 | 父任务允许状态 |
| --- | --- |
| 纯回答完成，无未决工具或子任务 | 可完成 |
| 文档工具仍执行，或 Observation 未持久化 | 不可完成 |
| Work 已登记但最终说明/读回尚未完成 | 保留作品，进入待交付/待核对语义，不谎报未生成 |
| 写入或外部提交未知 | 冻结为待对账，不完成、不重放副作用 |
| 所需工具/Observation/文件/登记/读回及交付条件均满足 | 可完成 |

具体状态名称、版本迁移和兼容投影应先形成合同；不能只新增枚举而没有转换实现。使用 CAS/版本和单一执行归属防止两个 finalizer 相互覆盖；结算失败要记录并可重试结算，不能吞掉异常后当成功。

验收：延迟/失败 finalizer、快速响应后绑定、并发结算、工具失败但模型自然结束、提交前后取消及已登记作品保留。使用显式持久化结算屏障校验状态，不靠固定 sleep；既有 2 秒测试等待失败的具体原因仍需复现，不能只延长测试时限宣布修复。

## 后续 Runtime 修补

| PR | 缺口与 Owner | 实施边界 | 关闭所需证据 |
| --- | --- | --- | --- |
| D：持久父 Run 与事件提交 | R-01/R-03/R-06；Domain/Application Coordinator、CAS Repository | 父 Run 保存 checkpoint、执行 owner/epoch、工具调用、Observation、预算、deadline、取消原因和完成合同；给 `runControlledProviderToolRounds()` 加持久化钩子，不增加第二套工具循环 | 重复/反序事件与 CAS 冲突可处理；调用前、结果和 Observation 提交边界可重放；UI 投影可重建；未知副作用不可重发 |
| E：统一 Recovery | R-05/R-09；Platform Recovery Coordinator | 当前项目内扫描 Run/Task/Response/Mutation Journal/Work，先拿执行租约、检查未知副作用和已提交作品，再选择恢复或冻结 | 每个提交边界 crash/restart；仅一个恢复者；登记后不生成第二份作品；未知收费请求不会自动重试 |
| F：等待与同 Run 恢复 | R-04及更完整的R-08；Application Resume Command/授权适配 | 持久化等待原因、版本化恢复 token 与允许动作；后续消息/授权关联原 Run；沿用原预算/deadline并重新验证权限 | 追问、授权、撤权、取消、重启、过期/重复/跨项目恢复均覆盖；不会重复调用 |

A → B → C → D → E/F 是建议顺序。B/C 必须先处理最小未知结果冻结和迟到作品核对，不能等完整 Recovery 才保护副作用。D 之前的有限修补不得将 R-01～R-09 整体标记为关闭。

JSON 跨实体“原子提交”需要说明具体机制：复用当前事务/Journal 能力，或明确 WAL/outbox + 幂等修复规则；不能把连续写多个文件称为原子。外部查询与恢复调用仍须遵守原授权、费用和外发范围。

## Design IR 按合同依赖修补

| PR | 缺口 | 实施边界 | 核心验收 |
| --- | --- | --- | --- |
| G：唯一内容事实源 | D-01 | 明确版本化内容原子、来源和稳定身份；Outline 作为兼容输入/投影；设计、布局和渲染只消费同一已校验内容投影 | 插入/重排/重复文本/局部修改后身份稳定；表格/图表无损；相同 IR 重放的内容与来源一致，Render Plan 不再从旁路 Outline 取得另一套内容 |
| H：唯一生产 Layout 合同 | D-03 | 先封装现有 Constraints/Features/Solver layouts，形成版本化 Layout IR，再编译 Render Plan；旧临时预览通过明确适配层继续运行 | 内容/页/元素身份、几何、诊断和版本可关联重放；旧预览不回归；不重复维护两套可独立修改的几何事实 |
| I：保持设计的有限修正 | D-05 | Patch 合法内容/设计/布局范围，逐候选重新编译、渲染与 QA；记录输入版本、IR/Plan digest、来源和诊断 | 强制走一次修正后仍使用匹配的设计链路，几何确实改变；重复诊断停止、耗尽与取消正确；失败候选不发布 |
| J：明确设计执行策略 | D-02 | Host 持久化“必须按确认设计”与“允许兼容版式”的策略；保留当前兼容能力，fallback 有原因及覆盖事实 | 要求设计时缺失/非法/不支持可见失败；兼容回退可审计；修正不能自行改变策略，目标能力未支持时不全面阻断现有请求 |
| K：逐类能力与对应 QA | D-04/D-06 | 图片资源先行，scene/radial/full-bleed 等分别实施；增强现有表格/图表的覆盖与质量证明，每类同步加 QA | schema、资源授权、错误码、真实文件/渲染/回读、失败及取消均有证据；非文本重叠/组合变换、实际字体替换、可读性和本地视觉基线逐项补齐 |

G/H 为 I 的主要依赖；J 的策略合同可提前设计，完整关闭要等修正链也遵守该策略。不能仅删除 Runner 的 `attempt === 0` 条件：重复使用旧 Design IR 可能重建相同几何，修正仍无效。图片、scene 等能力不得先开放到正式交付，再等待“最后一批 Visual QA”补保护。

已有 `PresentationIdentityManifest`、checksum/version pin、opaque page/element ID、继承检查、tombstone 和 Mutation Coordinator 应继续复用。新内容/Layout 身份应建立明确映射，不能用数组位置或整篇重生成替换已验收的精确 mutation 身份。

QA 区分质量门禁与偏好：文件无效、缺必要内容、不可读、严重越界、Hash/登记异常和明确硬约束仍阻断；普通页数目标及留白/风格偏好作提示或受控修正建议。装饰性允许重叠、字体与渲染环境差异须有评测依据，不新增任意视觉评分阈值。任何多模态外部视觉检查需另有明确外发授权，优先补本地确定性检查。

## 每个缺口的关闭记录

每批在 `PLANS.md` 顶部记录：缺口编号、负责层、允许文件范围、依赖合同/版本、复現方式、实际修改、测试与构建证据、未验证边界、回滚点和下一步。

关闭必须满足对应原登记的完整验收，不以“新增字段”“新枚举”“总测试通过”代替生产接线与恢复证明。离线 fixture、真实本地文件、真实 Office 渲染、真实 Provider 和人工验收分开记录；收费或外发验收必须具备对应授权，不继承旧轮次的有限授权。

每个 PR 固定源码基线并运行受影响测试与既定门禁。Runtime 使用假时钟、故障注入和持久化屏障；Design 使用支持/不支持 fixture、强制修正候选、稳定身份与真实文件读回。 macOS 仍为延期实机目标，不将 Windows 结果表述为 macOS 验收。

## 复核源码索引

索引使用文件与函数名，避免把易过期行号当作当前证据。

- Runtime：[唯一循环与计时](../../src/platform/providers/provider-tool-calling.ts) `runControlledProviderToolRounds` / `createControlledProviderToolLoopController`；[Tool Bridge](../../src/platform/providers/document-tool-bridge.ts) `createDocumentToolCallingBridge`；[文档会话](../../src/platform/documents/conversation-document-tool-session.ts) `createGenerationSession`；[终态结算](../../src/platform/ipc/chat-context-runtime.ts) `settleConversationAgentRun` / `createConversationTerminalObserver`。
- IR：[内容 IR](../../src/domain/entities/document-agent.ts) `buildDocumentIRFromOutline`；[Render Plan](../../src/platform/documents/presentation-render-plan-compiler.ts) `compilePresentationRenderPlan` / `resolveContent`；[渲染路径](../../src/platform/documents/office-document-generator.ts) `buildPptBuffer` / `fallbackReasonFor`。
- 修正/QA：[Runner](../../src/platform/documents/document-generation-runner.ts) `compileAndDiagnose` / `validateLlmRepairPlan`；[Office QA](../../src/platform/documents/office-render-adapter.ts) `inspectPptxGeometry`；[旧 Layout 流程](../../src/platform/documents/temporary-document-workflow.ts) `prepareTemporaryDocumentVersion`；[稳定身份](../../src/platform/documents/presentation-identity-manifest.ts) `carryForwardPresentationIdentityManifestForPatch`。

本轮仅更新工程记录与修补建议；未实施 A～K，未新增业务构建或测试结果。文档验收为链接/源码定位核对和 `git diff --check`。
