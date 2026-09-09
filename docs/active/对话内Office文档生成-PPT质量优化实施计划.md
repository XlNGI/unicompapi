# 对话内 Office PPT 质量优化实施计划

> **面向执行 Agent：** 必须按任务逐项执行并使用复选框记录。实现阶段先使用 `test-driven-development`，完成前使用 `verification-before-completion` 和代码审查。

**目标：** 让对话页生成的 PPTX 使用五套原创本地模板，呈现详细、可读、自动分页的固定 16:9 内容，同时保持既有受控生成、校验和作品登记边界。

**架构：** 模型只负责一次受控的详细 PPT 大纲响应。Application 用例层负责等待消息完成、编译/本地恢复、内容指纹、生成调用、结果挂接、revision 冲突重试、并发去重和取消窗口；Platform 只负责大纲解析/恢复、模板与布局、文件生成和受控 I/O；Renderer 只提交意图并展示状态。模板注册表和容量策略确定性选择布局并拆成续页，Runner 独占文件校验和 Work 登记；Renderer 可保持“自动匹配”或显式选择模板，但提交 IPC 前必须解析为五个合法模板 ID 之一。

**技术栈：** TypeScript、React 18、Electron 33、Vitest、Node test、`pptxgenjs` 4.0.1、既有本地 JSON 存储。

**设计依据：** `docs/active/对话内Office文档生成-PPT质量优化设计.md`

## 全局约束

- 在当前项目目录 `D:\unicompapi-git` 开发；计划确认后、首次修改业务代码前，在该目录创建未被其他 worktree 占用的 `feature/*` 分支。根 `AGENTS.md` 保持用户本地未提交状态，不暂存、不提交、不覆盖。
- 只处理 PPT 内容质量；不实现 URL 读取，不扩大附件/RAG 外发，不调用真实 Provider，不改图片或视频工作区。
- 不新增依赖，不复制五套生成器，不让 Renderer 或模型决定文件路径、布局坐标或成功状态。
- 稳定行为严格执行 RED -> GREEN；测试夹具只使用合成中文内容，不放入用户实际 PPT、路径、业务数据或截图。
- 生成器写入同目录临时文件后原子替换；失败、取消或校验失败均不得登记 Work。
- 每一阶段只运行该阶段相关测试；全量测试、类型、静态检查、构建和 Windows Electron 人工验收留在最终验证阶段。

### 任务 1：建立 PPT 语义和资源边界

**文件：**

- 修改：`src/platform/documents/document-outline-parser.ts`
- 修改：`src/pages/chat/documentDrafting.ts`
- 测试：`tests/platform/document-outline-parser.test.ts`
- 测试：`tests/application/document-drafting.test.ts`

**接口：** 输入是既有 `DocumentOutline` JSON 或 Markdown 回退；输出为仅 PPT 使用的 `pageKind`、`takeaway`、`action` 元数据和集中资源预算。Word/Excel 的 JSON、Markdown、`paragraph`、`bullets`、`table`、`chart` 语义不得改变。

- [x] 在 `tests/application/document-drafting.test.ts` 先将旧“每页最多 3 个要点、每点不超过 15 字”断言替换为“结论、解释、资料不足”提示词断言，并确认新断言在旧提示词下失败。
- [x] 在 `tests/platform/document-outline-parser.test.ts` 添加合成 JSON：一个含 `pageKind: 'insight'`、`takeaway`、`action` 的合法 PPT section，及分别超过总字符、内容组和页面预算的输入；断言合法元数据被保留，三类超限均返回 `DocumentOutlineError('document_invalid_outline')`。
- [x] 运行 `pnpm vitest run tests/application/document-drafting.test.ts tests/platform/document-outline-parser.test.ts`，记录 RED 结果。
- [x] 在 parser 中新增 `PresentationPageKind`、PPT section 元数据解析和唯一的 `presentationOutlineLimits`；只在 `kind === 'ppt'` 时读取新字段并累积文本、列表、表格和预估页面预算。
- [x] 更新 `documentKindInstruction('ppt')`：要求一个结论、3 至 5 个带解释的内容组、仅可靠数据可用图表、资料不足时标注建议或待确认项。
- [x] 再运行相同命令，确认 GREEN；执行 `git diff --check`，并检查差异只涉及上述四个文件。

### 任务 2：建立五模板注册表和确定性版式选择

**文件：**

- 新增：`src/platform/documents/presentation-template.ts`
- 修改：`src/platform/documents/document-theme.ts`
- 修改：`src/platform/documents/document-layout.ts`
- 测试：`tests/platform/document-theme-layout.test.ts`

**接口：** `presentationTemplateIds` 仅包含 `work_report`、`natural_minimal`、`business_minimal`、`technology`、`financing`。`resolvePresentationTemplate(value)` 返回模板，`choosePresentationLayout(template, section)` 返回带容量和字号下限的布局。

- [x] 在 `tests/platform/document-theme-layout.test.ts` 先断言注册表恰好含五个 ID；每个模板至少支持封面、正文、数据和结尾；带 chart 的 section 选择 data 布局，长 bullets 选择可分页正文布局。
- [x] 运行 `pnpm vitest run tests/platform/document-theme-layout.test.ts`，确认当前实现缺少模板或容量语义而失败。
- [x] 创建 `presentation-template.ts`，集中声明每个模板的颜色、字号、可用布局、内容组容量、正文容量、图表/表格槽位；科技风使用深色背景和高亮线条，其他模板遵循设计文档对应方向。
- [x] 扩展 `document-layout.ts` 以复用区域判断，不新建第二个按 section 渲染的生成器；`document-theme.ts` 保持 Word/Excel 旧主题能力，旧融资主题映射到 `financing`，旧 PPT 请求缺模板时回退 `work_report`。
- [x] 再运行 `pnpm vitest run tests/platform/document-theme-layout.test.ts tests/platform/document-outline-parser.test.ts`，确认 GREEN；以 `rg -n "buildPptBuffer|presentationTemplateIds|choosePresentationLayout" src/platform/documents` 检查只有一个 PPT 渲染入口和一个模板 owner。

### 任务 3：实现无截断的语义分页和五模板 PPT 渲染

**文件：**

- 修改：`src/platform/documents/office-document-generator.ts`
- 测试：`tests/platform/office-document-generator.test.ts`

**接口：** 输入为 `DocumentOutline`、`PresentationTemplate` 和既有本地图片；输出为固定 `LAYOUT_WIDE` 的原生可编辑 PPTX。所有内容块可追溯到页面或续页，DOCX、XLSX、图表、项目图片嵌入和文件名清洗保持现有行为。

- [x] 在生成器测试中构造含 12 个带解释 bullet 和一个 action 的 PPT section。生成后读取全部 `ppt/slides/slide*.xml`，断言每个唯一标记文本都至少出现一次，且 slide 数量大于“封面 + 原 section + 结尾”。
- [x] 为同一合成大纲分别生成五模板，断言 `ppt/presentation.xml` 的 `sldSz` 为宽屏比例、五份输出具有可区分的背景或标题标记，且标题和全部正文 XML 均存在。
- [x] 运行 `pnpm vitest run tests/platform/office-document-generator.test.ts`，确认旧 `slice(0, maxLines)` 截断和缺少四套模板导致 RED。
- [x] 增加 `expandPresentationSections()`：按 `PresentationLayout` 容量分配内容块、生成续页标题和页码；表格、图表、图片优先占用专用槽位。删除任何截断 `slice` 逻辑；单个块超过安全容量时抛出受控生成错误。
- [x] 保持单一 `buildPptBuffer()`，由其按语义页面调用封面、正文、双栏、流程、数据、图文和结尾的 `pptxgenjs` 绘制函数。模板只提供 tokens 和布局集合，不能复制完整渲染函数；标题不自动缩字或换行。
- [x] 运行 `pnpm vitest run tests/platform/office-document-generator.test.ts tests/platform/document-theme-layout.test.ts`，确认 GREEN 及既有 chart/image/Word/Excel 回归通过；执行 `git diff --check`。

### 任务 4：将模板选择、取消和原子写入纳入受控 IPC 与状态机

**文件：**

- 修改：`src/shared/document-generation-ipc.ts`
- 修改：`electron/preload.ts`
- 修改：`electron/ipc/document-generation-ipc.ts`
- 修改：`src/platform/ipc/document-generation-controller.ts`
- 修改：`src/platform/documents/document-generation-runner.ts`
- 测试：`tests/platform/document-generation-controller.test.ts`
- 测试：`tests/platform/document-generation-runner.test.ts`

**接口：** 输入为已验证的 `presentationTemplate`、会话 ID、revision、message ID 和取消意图；输出是安全的执行状态及独立 Work。Renderer 不可获得路径、Hash、模板文件或内部异常。

- [x] 在 controller 测试中传入非法 `presentationTemplate` 并断言 `invalid_request`；针对同一 message 和 kind，以两个合法模板并发生成并断言各有独立 Work，只有同模板重复请求才去重。
- [x] 在 runner 测试中使用受控 abort signal，分别在临时写入前和写入后校验前取消；断言 execution 为 `cancelled`、Work 为空、最终文件不存在且临时文件被清理。再模拟原子替换失败，断言 `failed`、无 Work、无半成品。
- [x] 运行 `pnpm vitest run tests/platform/document-generation-controller.test.ts tests/platform/document-generation-runner.test.ts`，记录 RED。
- [x] 在共享 DTO parser 中仅接受五个模板枚举，且 Word/Excel 传该字段返回 `invalid_request`；preload 只透传 DTO；controller 将模板加入 `documentMessageOperationKey()` 并传给 Runner。
- [x] 为 Runner 增加受控取消信号，在每次不可逆状态转换前检查；生成器返回临时文件信息，Runner 复读校验类型、大小和 Hash 后同目录原子替换，成功后才创建 FileReference 与 Work；失败或取消清理临时文件。
- [x] 注册仅以 conversation/message/revision 定位的取消 IPC。主进程校验项目归属和活动 operation；重复取消幂等，已完成作品不可删除。
- [x] 再运行相同测试并确认 GREEN；执行 `rg -n "presentationTemplate|cancelDocument|document-generation" src/shared electron/preload.ts electron/ipc src/platform/ipc`，确认没有路径或任意颜色对象进入 Renderer API。

### 任务 5：更新对话页模板选择和安全错误展示

**文件：**

- 修改：`src/pages/chat/ChatPage.tsx`
- 修改：`src/styles/pages.css`，仅在既有样式无法表达模板选择时修改
- 测试：`tests/ui/chat-document-ui-contract.test.mjs`

**接口：** 文档模式的用户可选择“自动匹配”或五个 PPT 模板；仅 PPT 请求携带解析后的合法 `presentationTemplate`；Word/Excel 不展示或不提交该字段；错误码有安全中文文案。

- [x] 在 UI 合同测试中断言五个模板 ID 和中文标签存在；仅 PPT 发送 `presentationTemplate`；旧“作为样式模板”按钮不再作为 PPT 版式入口；新增错误码都有中文展示文案。
- [x] 运行 `node --test tests/ui/chat-document-ui-contract.test.mjs`，确认当前四个 `documentTheme` 和上传 PPTX 自定义主题流程导致 RED。
- [x] 最小化修改 ChatPage：PPT 时显示主题感知的上拉选择器，默认“自动匹配”；显式选择优先，自动状态按原始提示词确定模板，无风格信号时回退工作汇报，发送时只传五个枚举模板之一。Word/Excel 保留旧颜色主题；上传 PPTX 可作附件资料，但移除其改变 PPT 版式的交互和文案。
- [x] 添加非法模板、内容超限、取消和写入失败的安全中文提示，不显示内部错误。
- [x] 运行 `node --test tests/ui/chat-document-ui-contract.test.mjs tests/ui/chat-page-contract.test.mjs`，确认 GREEN；执行 `git diff --check` 并人工审查未重构无关聊天、附件、RAG 或 Provider 流程。

### 任务 5B：通过 Application 编排和本地恢复处理模型偶发损坏 JSON

**文件：**

- 新增：`src/application/document-generation-service.ts`
- 新增：`src/platform/documents/document-generation-application-adapters.ts`
- 修改：`src/platform/documents/document-outline-parser.ts`
- 修改：`src/platform/ipc/document-generation-controller.ts`
- 修改：`src/pages/chat/ChatPage.tsx`
- 测试：`tests/application/document-generation-service.test.ts`
- 测试：`tests/platform/document-outline-parser.test.ts`
- 测试：`tests/platform/document-generation-controller.test.ts`
- 测试：`tests/ui/chat-document-ui-contract.test.mjs`

**接口：** 不按服务商或模型名称判断。文本候选声明对象型 `response_format` 时仍请求 JSON 对象输出；一次模型响应返回后，由 Application 先严格编译，PPT 仅在结构错误时调用 Platform 的本地恢复端口。恢复成功直接进入既有 Runner；恢复失败返回安全错误且不得登记 Work。Renderer 不得再发起“大纲修正”模型调用。

- [x] 以模板自动匹配优先级、显式覆盖、能力驱动 `response_format`、Application 编排、本地恢复和“仅一次模型响应”UI 合同取得 RED。
- [x] 实现确定性模板匹配；融资专项词优先于科技等泛用词，无命中回退工作汇报。
- [x] 仅依据候选 ParameterSchema 的 `response_format: object` 能力设置 `{ type: 'json_object' }`，没有任何模型名或服务商名分支。
- [x] 新增 `DocumentGenerationApplicationService`，集中负责等待 assistant 终态、编译/恢复、生成、结果挂接、revision 冲突、去重和取消；Platform Controller 只保留 DTO 解析、用例调用、安全错误映射和打开文件。
- [x] `recoverPresentationContent()` 只从同一响应中恢复缺逗号等局部 JSON 损坏，并继续执行标题、字段、内容组、总字符和页数资源校验；不新增第二次 Provider 调用、备用 Agent 链路或模型名分支。
- [x] Renderer 删除 `buildDocumentOutlineRepairInput()`、删除“大纲格式异常，正在自动修正一次”和第二次模型调用；文档任务用户气泡显示 `displayContent`，assistant 结构化 JSON 不直接渲染为 Markdown。
- [x] 定向 Application/Platform/UI 测试与类型检查 GREEN；缺逗号、长标题、长结论、四个详细内容组和长行动项通过 Application → compiler/recovery → Runner → PPTX → Work → conversation result 的真实文件全链测试。

### 任务 6：完成自动化验证、Windows 验收和交付审查

**文件：**

- 修改：`PLANS.md`，仅在代码和验证完成后登记事实
- 新增：`docs/active/对话内Office文档生成-PPT质量优化验收记录.md`

- [x] 运行定向测试集：`pnpm vitest run tests/application/document-drafting.test.ts tests/platform/document-outline-parser.test.ts tests/platform/document-theme-layout.test.ts tests/platform/office-document-generator.test.ts tests/platform/document-generation-runner.test.ts tests/platform/document-generation-controller.test.ts`。
- [x] 依次运行 `pnpm test:ui-contract`、`pnpm typecheck`、`pnpm lint`、`pnpm test`、`pnpm build`、`git diff --check`。任一失败先基于本轮失败证据修复，不使用旧门禁记录替代结果。
- [ ] Windows Electron 人工验收：同一固定提示词分别选择五模板生成；窄窗和宽窗重复工作汇报。检查 PowerPoint/WPS 可打开、封面/正文/续页/图表/图片/页码无裁剪或重叠、相同输入 XML 页面结构一致、重复点击不生成第二个 Work、取消后无 Work 或半成品、FileReference 类型/Hash/归属正确、关闭后无残留 Electron 进程。
  - 已完成可自动执行部分：本轮全量 148 个测试文件、886 项测试通过；五模板各 8 页和异常恢复样例 5 页均由 PowerPoint 打开并导出 PNG，固定 16:9、Canvas 越界 0，已逐页复核无文字裁切、元素越界或非预期重叠。真实 Electron 成功启动，文本可访问树可读取项目页和本地作品；但本机图形捕获返回 `0x80004002`，按元素点击也被控制驱动拒绝，故上拉菜单实点、真实多模型生成、键盘完整路径、重复点击、取消、作品登记和 WPS 仍保留为项目负责人人工验收，本项不勾选。
- [x] 对照设计文档审查：五模板、内容合同、无截断分页、固定 16:9、原子写入、取消、IPC 拒绝和未扩大附件/Provider 范围全部覆盖；检查不存在重复渲染器、第二状态真源、任意路径输入、吞错或仅断言 mock 调用的测试。
- [x] 仅在证据完整后写验收记录和 `PLANS.md`，如实登记修改文件、实际命令、通过或失败结果、未验证项和下一步；不得记录发布、合并或真实 Provider 调用等未发生事实。
- [x] 交付前运行 `git status --short -b`、`git diff --stat`、`git diff --check`。变更只能包含本计划列出的 PPT 相关源文件、测试和工程记录；不暂存、提交、推送或合并，除非另获明确授权。

## 计划自检

- 设计中的五模板、丰富内容、语义布局、分页、固定比例、文件原子性、取消、错误、IPC、UI、自动化和 Windows 验收均有对应任务。
- URL、RAG 扩展、真实 Provider、图片/视频和发布均明确排除。
- Word/Excel、图表、图片、文件登记、revision 和并发在相邻测试中保留回归保护。
- 每个任务均列出文件、接口、RED、最小实现、GREEN 和范围检查，没有待定项或泛化占位步骤。

## 2026-08-27 补充子阶段：多页结构差异与自然语言修订

- [x] RED：新增 Application 意图测试，证明 Office 新建/修改/歧义/普通问答没有统一 owner；新增版式序列测试，证明构图选择器不存在；新增真实 PPTX 几何测试，证明四个连续 insight 页首内容组坐标只有一种；新增 UI 合同，证明没有发送前操作预览。
- [x] GREEN：新增 `src/application/office-request-intent.ts`；Renderer 仅展示和提交结构化计划；create 不再自动携带上一版，revise 只选择同类型最近完成文档。
- [x] GREEN：模板注册表新增确定性构图序列；生成器在原有单一渲染入口内增加 editorial、split、cards、timeline，data/image_text/section/closing 保持原 owner。
- [x] GREEN：聊天输入区新增 Office 操作预览，显示新建/修改、格式、上一版目标和待补信息；没有新增 IPC、依赖、权限、Provider 调用或第二状态真源。
- [x] 定向验证：Application/平台 44 项与 UI 合同 13 项通过；`pnpm typecheck` 通过。
- [ ] 最终门禁和页面/逐页视觉验收：完成相关回归、lint、build、diff 检查与 Electron 可见交互；PowerPoint 或受管渲染可用时补逐页视觉检查。

自动化收口已完成：相关 Application 13/13、Platform 86/86、UI 13/13，`pnpm typecheck`、`pnpm lint`、`pnpm build` 均为退出码 0，`pnpm test` 为 150 文件、894/894。该未勾选项只剩真实 Electron 点击/键盘与 PowerPoint/WPS 逐页视觉验证，不用自动化数字代替。

补充子阶段的下一条安全命令：`pnpm vitest run tests/application/document-drafting.test.ts tests/application/office-request-intent.test.ts tests/platform/document-theme-layout.test.ts tests/platform/office-document-generator.test.ts && node --test tests/ui/chat-document-ui-contract.test.mjs`。

## 2026-08-28 最终覆盖决定：后台自动定位，UI 只显示结果

本节覆盖上一子阶段“输入区显示 Office 操作预览”的 UI 决定，不回写或伪造历史测试事实。

- [x] Application 接收当前对话完成文档列表，并返回精确 `targetMessageId`；明确文件名、明确格式、最近 Office 结果、同类型最新版本和“改前一个”均有规则测试。
- [x] Word、Excel、PPT 的自然语言后续修改共用同一意图 owner；“重新做一份”保持 create，Office 咨询保持 chat，无当前文档时不猜测。
- [x] Renderer 删除“新建/修改上一版/操作预览/目标”常驻条，不增加确认面板；保留模板、附件、RAG、进度、取消和最终文档卡。
- [x] 项目上下文按不可信 user 资料发送，不提升为 system；新增提示注入边界测试，未增加模型调用。
- [x] PPT 删除模板展示名称，普通文本续页取消机械“续 N”，4+1 孤页重平衡为 3+2；表格/图表续页语义保留。
- [x] 定向测试 37/37、UI 13/13、类型检查、lint、build 通过。
- [ ] 默认 `pnpm test`：两次分别为 896/900 与 898/900，通过项之外均为全量并行下 5 秒 I/O/文档测试超时；失败文件隔离复跑 40/40。默认全量命令未绿，不标记完成。
- [ ] 真实 Electron Word/Excel/PPT 修改、无目标、重复点击、取消、结果卡及 PowerPoint/WPS 逐页视觉验收；当前被本机窗口捕获 `0x80004002` 阻断。

## 2026-08-28 人工验收补充：Excel 口语修改与超时未知结果

- [x] RED：增加“给表格加几列”“当前工资表在加年龄跟性别”两条 Excel revise 用例，并以“工资表怎么加年龄列更合理？”“今天给大家加油”保护普通聊天负向路径。
- [x] GREEN：Application 在当前对话文档上下文中识别口语单字“加”，Excel 类型词补齐“表格、工资表、薪资表”；不增加模型分类调用或 UI 确认面板。
- [x] RED → GREEN：Provider 默认响应头等待从 60 秒改为 5 分钟，idle 60 秒和 total 15 分钟保持不变，显式 override 仍有回归保护。
- [x] timeout 投影为远端结果未知；实时失败事件和刷新后的持久化 unknown 状态都提示费用可能已产生并避免立即重复发送，不自动重试。
- [x] 定向与相邻回归：Vitest 75/75、Node UI 18/18，`pnpm typecheck`、`pnpm lint`、`pnpm build` 通过。
- [ ] 默认 `pnpm test` 本轮未运行；第 11 节登记的全量并行 I/O 超时仍未闭合，不标记全量门禁通过。
- [ ] Windows Electron 人工复验：输入两条真实 Excel 修改口语应直接生成新版；模拟或等待超过旧 60 秒但小于 5 分钟的首包；timeout 时核对费用风险提示、不得自动重试，并与服务商后台记录交叉确认。
