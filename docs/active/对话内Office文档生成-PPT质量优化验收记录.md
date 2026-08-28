# 对话内 Office PPT 质量优化验收记录

日期：2026-08-27
分支：`feature/ppt-quality-layouts-current`
状态：代码、自动化、真实 PPTX 文件与 PowerPoint 逐页视觉自验收通过；模板上拉选择、自动匹配、Application 业务编排和模型无关的本地大纲恢复已实现。真实 Electron 窗口可发现且文本可访问树可读取，但本机截图接口与按元素点击驱动不可用；真实多模型生成交互、WPS 与打包仍待项目负责人人工验收。未暂存、未提交、未推送、未合并。

## 1. 本轮目标与边界

本轮面向办公用户优化对话内 PPTX 生成质量，解决旧实现内容过少、正文页大面积无意义空白、长内容截断、一个 section 固定一页和浏览器窗口尺寸影响预览观感的问题。

已实现范围：

- 五套原创本地模板：工作汇报、自然简约、极简商务、科技风、融资演讲稿；工作汇报为默认模板，融资演讲稿保留为专项模板。
- 固定 16:9 PPTX；浏览器窗口只影响预览缩放，不参与生成文件的换行、页数或布局计算。
- 模型提示词要求每页有明确结论、3 至 5 个带解释的内容组和可执行行动；资料不足时标注建议、假设或待确认项，不编造业绩和业务数据。
- 平台层根据页面语义和内容容量选择封面、正文、双栏、流程、数据、图文、章节和结尾版式，并把超量内容拆成续页。
- 表格按行和列续页，图表使用专用版式；正文不再通过 `slice` 丢弃，单块内容超过可读容量时返回受控错误。
- 解析预算与实际布局结果均限制最多 40 页，防止宽表和长表组合绕过预估页数造成资源膨胀。
- PPT 模板只通过五个枚举 ID 进入命名 IPC；未声明字段、非法模板、非布尔 `aiImages` 和不匹配的表格行列数默认拒绝。
- Runner 使用同目录临时文件、OOXML 类型检查、大小与 SHA-256 校验、同步和原子发布；成功发布并重新校验后才登记 FileReference 与 Work。
- 支持同请求去重、不同模板独立生成、取消、失败回滚和已登记作品不可被迟到取消删除。
- PPT 模式保持 Word/Excel/PPT 类型切换可见，同时隐藏无效的旧颜色主题控件；上传 PPTX 仍可作为内容附件，但不再作为第六种自由样式来源。
- PPT 模板控件改为输入框内的主题感知上拉选择器，默认显示“自动匹配”；用户显式选择优先，否则按提示词风格词确定模板，无命中时回退工作汇报。
- 结构化输出不绑定模型名：候选声明对象型 `response_format` 时请求 JSON 对象；一次模型响应返回后，Application 先严格编译，PPT 仅在结构错误时调用 Platform 本地恢复。缺逗号等局部损坏可从同一响应恢复并继续生成，不再追加第二次模型调用。
- Application 拥有等待消息终态、编译/本地恢复、内容指纹、生成调用、结果挂接、revision 冲突重试、并发去重和取消窗口；Platform Controller 只负责 DTO、用例调用、安全错误映射和打开文件，Renderer 只提交意图和展示状态。
- 内部 Provider prompt 与用户可见内容分离：`message.content` 保留受控结构化指令，`displayContent` 只显示用户原始需求；文档任务中的 assistant JSON 不直接作为 Markdown 气泡展示。

明确未做：URL 读取、RAG 或附件外发扩容、真实 Provider 调用、图片或视频生成入口、依赖升级、打包发布、macOS 支持。

## 2. 根因结论

旧 PPT 内容单调和空白过多不是浏览器窗口大小造成，而是生成链路同时存在以下限制：

1. PPT 提示词把每页限制为最多 3 个要点、每点不超过 15 字，模型源头只能输出短词。
2. 生成器按一个 section 固定生成一页，没有使用页面语义和容量做拆分或组合。
3. 溢出内容通过 `slice` 截断，无法续页保留。
4. 已有布局判断没有成为生产 PPT 的唯一决策入口。
5. 旧文件直接写入最终路径，取消和写入失败存在半成品风险。
6. 真实 `kimi-k3` 失败会话中的第 5 个 section 表格第二行缺少开头 `[`；其他模型也可能产生缺逗号、长标题或长行动项。旧链路把“提示词要求严格 JSON”误当作可靠前提，严格解析失败后又让 Renderer 发起第二次模型修正，因此两次都可能失败，并泄漏内部 prompt/JSON 到聊天气泡。该根因不属于某个模型，修复按统一 Application 用例和本地恢复工作，不检查模型名称、不追加模型调用。

因此本轮同时修改了大纲合同、模板/容量注册表、单一 PPT 渲染器、Runner 文件状态机和受控 UI/IPC；只调整预览 CSS 无法解决根因。

## 3. 用户可见结果

同一份“AI Agent 季度工作汇报”合成大纲使用五个模板生成后，每份均为 8 页：封面、四类详细正文/数据页、两张行动与决策页、结尾页。正文页先给核心结论，再展示解释和下一步；表格占用专用数据区域；科技风使用深色网格和高亮线条，其余模板分别使用蓝灰、自然绿、克制黑白灰和路演深色体系。

最终样例位于本地临时验收目录，不纳入 Git：

- `.tmp/ppt-quality-acceptance/generated-current/工作汇报-AI Agent季度工作汇报.pptx`
- `.tmp/ppt-quality-acceptance/generated-current/自然简约-AI Agent季度工作汇报.pptx`
- `.tmp/ppt-quality-acceptance/generated-current/极简商务-AI Agent季度工作汇报.pptx`
- `.tmp/ppt-quality-acceptance/generated-current/科技风-AI Agent季度工作汇报.pptx`
- `.tmp/ppt-quality-acceptance/generated-current/融资演讲稿-AI Agent季度工作汇报.pptx`

2026-08-27 最终代码重新生成后，本机 PowerPoint 分别成功打开五份文件并读取到 8 页。OOXML 检查确认五份 `ppt/presentation.xml` 均为宽屏尺寸，模板颜色和原生框架几何可区分。PowerPoint 原生导出的 40 张 PNG 已逐页检查，五套样例 Canvas 越界均为 0。

另有 `.tmp/ppt-quality-acceptance/generated-current/异常大纲恢复-科技风-AI Agent.pptx`：输入故意缺少 JSON 逗号，并包含长标题、长结论、四个详细内容组和超长行动项。Application 本地恢复后生成 5 页科技风 PPTX；PowerPoint 可打开并导出全部页面，Canvas 越界 0，长行动项集中为一张可读行动页，全部关键文本保留。

## 4. 实际验证证据

### 4.1 TDD 与定向测试

- 最后一轮审查修复前已取得 RED：
  - 未声明 IPC 字段和非布尔 `aiImages` 未返回 `invalid_request`；
  - 宽表非首列发生重复；
  - 表格行列数不一致未拒绝；
  - Runner 未在 Work 登记前关闭取消窗口。
- 对应 GREEN：四个最小命令共 5 项目标断言通过。
- PPT 链路定向套件：7 个文件、87 项测试通过，覆盖大纲、五模板、分页、图表/表格、Runner、Controller 和脱敏日志。
- 最终新增资源回归先 RED：20 列 × 80 行合法表格被旧实现生成成约 3.5 MiB PPTX，没有被 40 页预算拒绝。
- 最小修复后 GREEN：生成器根据实际展开页数在渲染前拒绝超过 40 页的结果；大纲/主题/生成器 3 个文件、54 项测试通过。
- 交付自验收发现 UI 回归：选择 PPT 后“文档类型”组被条件隐藏，用户无法切回 Word/Excel。新增回归测试先取得 6 通过、1 失败的 RED；仅恢复类型组由 `documentMode` 控制后取得 7/7 GREEN，PPT 的旧“文档主题”仍保持隐藏。
- Application 编排和本地恢复新增回归：先以缺逗号 JSON 取得严格编译失败，再验证同一响应经 `recoverPresentationContent()` 恢复；Controller 全链测试真实写出可读 PPTX、登记一个 Work 并只挂接一次 conversation result。
- 长行动项密度回归：旧实现把同一行动拆成两张稀疏 focused page；新增行为测试后，最小修复将 90 字以上、240 字以内的行动合并到一张自适应字号行动页，正文不截断。最终 `tests/platform/office-document-generator.test.ts` 24/24 通过。

### 4.2 完整门禁

最终生产改动后的本轮新鲜结果：

- `pnpm test`：148 个测试文件、886 项测试通过，0 失败，0 跳过；确认实际发现并运行了新增 Application、本地恢复、长行动项和真实 PPTX 全链测试。
- `pnpm typecheck`：退出码 0。
- `pnpm lint`：退出码 0。
- `pnpm build`：退出码 0，Vite 转换 2049 个模块；仅有既有 Vite CJS 弃用和大 chunk 警告。
- `git diff --check`：退出码 0；没有空白错误，仅有工作区既有 LF/CRLF 提示。
- 五模板最终样例：5/5 成功，PowerPoint 均识别为 8 页、960 × 540 像素导出画布、固定 16:9；40 张 PNG 逐页检查未发现文字裁切、元素越界或非预期重叠。
- 异常大纲恢复样例：1/1 成功，PowerPoint 识别为 5 页、960 × 540；故意缺逗号的响应经 Application 本地恢复后全部内容保留，长行动项只占一张行动页。
- PowerPoint Canvas 边界检查：五模板和异常恢复样例均为 0 个越界元素。

历史 147 文件/873、877 项门禁只保留为早期阶段记录，不作为本轮最终结论；最终结论只采用上述 148 文件/886 项的新鲜结果。

## 5. 视觉验收与限制

最终代码重新生成的五模板共 40 张 PNG 位于 `.tmp/ppt-quality-acceptance/visual-qa-powerpoint-20260827/`；异常恢复样例 5 张 PNG 位于其 `long-recovery/` 子目录。它们均由本机 PowerPoint 原生打开后导出，不使用旧截图替代最终字节证据。

逐页按原始分辨率复核结果：

- 五模板每份 8 页，封面、四类正文/数据页、行动/决策页和结尾页均可读；正文页包含核心结论、解释、内容组、表格或行动条，没有大面积无意义空白。
- 异常恢复样例 5 页；长标题和正文正常换行，四个详细内容组完整，超长行动项集中在一页，未拆成两张稀疏页面。
- PowerPoint 页面画布为 960 × 540；所有样例 Canvas 边界越界 0。PowerPoint `TextRange.Bound*` 对少量中文字体外延返回 4—9pt 候选值，但相应 PNG 无实际裁切，因此未把字体度量假阳性记为真实 overflow。
- `presentations` 技能自带 `artifact-tool` 渲染器对本项目 `pptxgenjs` 输出无结果退出，因此本轮采用 PowerPoint 原生导出作为视觉证据；该兼容性问题不影响本机 PowerPoint 打开和 OOXML 校验，但 WPS 仍未验证。
- Windows 应用控制能发现并读取真实 UniComp Electron 窗口的文本可访问树，包含本地项目和既有文档作品；图形捕获仍返回 `SetIsBorderRequired 0x80004002`，按可访问元素点击也被控制驱动拒绝。因此没有取得模板上拉菜单的 Electron 实点证据，也未执行真实 Provider 请求。

## 6. 七项交付审查

### 6.1 是否满足需求

代码和自动化范围满足已确认设计：五模板、详细内容合同、语义排版、无截断续页、固定 16:9、表格/图表专用页、模板选择、取消、原子发布和安全错误映射均有实现和行为测试。URL 读取按负责人决定保持本轮外。

真实 Electron 开发实例成功启动并出现一个 UniComp 窗口；文本可访问树读取到标题栏、主导航、项目页、本地项目和既有文档作品。开发启动使用默认 `user-data-dir`，所以未在窗口内执行项目切换、Provider 或文件生成操作；本机图形捕获和按元素点击驱动不可用。因此五模板入口实点、键盘完整路径、加载/失败、重复点击、取消和作品登记仍需项目负责人人工验收，不宣称整项产品验收或发布完成。

### 6.2 是否超出范围

没有修改 Provider、附件外发、图片/视频工作区、依赖、打包或发布配置。除计划直接列出的文件外，以下支持改动是取消和原子回滚的必要最小变更：

- `src/domain/transitions/execution-transitions.ts`：允许本地文档在 `verifying_file` 承认取消；
- `src/platform/repositories/json-file-index-repository.ts` 与 `json-repositories.ts`：取消窗口内回滚已登记 FileReference/索引；
- `electron/ipc/document-generation-logging.ts`：避免错误日志写入文档内容和绝对路径；
- `src/platform/documents/index.ts`：导出模板 owner。

这些变更均有对应测试，不形成新的产品能力或第二状态真源。`AGENTS.md` 是用户本地修改，未由本轮修改、暂存或覆盖。

最终纠偏新增的直接相关支持面：

- `src/application/document-generation-service.ts` 与 `src/application/index.ts`：恢复 Application 对文档生成业务编排的唯一 owner；
- `src/platform/documents/document-generation-application-adapters.ts`：把既有 Parser/Runner 适配到 Application 端口，不承载业务流程；
- `src/application/conversation-service.ts`、`src/domain/entities/conversation.ts`、`src/shared/chat-context-ipc.ts`、conversation controllers：增加 `displayContent` 投影，隔离内部 Provider prompt 与用户气泡；
- `src/pages/chat/documentDrafting.ts`：只按候选 ParameterSchema 能力请求 JSON 对象，不绑定模型名称；
- `src/pages/chat/ChatPage.tsx` 与 `src/styles/pages.css`：删除二次模型修正，保留输入框内模板上拉、自动匹配、失败恢复和同步重复点击保护。

上述文件均直接对应“所有文本模型只调用一次、Application 编排、聊天不泄漏内部 JSON、模板可选择”的确认需求。Provider 适配器、依赖、图片/视频工作区、发布配置和 URL 读取未修改。`README.md` 与 `AGENTS.md` 的既有用户改动保持原样，不纳入本轮交付判断。

### 6.3 回归风险

- Word/Excel 保留旧 `theme` 行为；PPT 缺少模板时兼容回退工作汇报，旧融资主题映射融资演讲稿。
- 单一 `buildPptBuffer()` 仍是唯一 PPT 渲染入口，没有复制五套生成器。
- 全量 886 项覆盖现有应用、领域、平台和 UI 合同回归。
- 仍有真实 Electron 自动/显式模板选择、真实多模型响应、取消/重复点击、作品登记和 WPS 未验证风险，不能由自动化测试或本地合成大纲替代。

### 6.4 安全问题

- Renderer 只能提交 ID、revision、枚举模板和受控图片引用；不能提交路径、endpoint、凭证、颜色对象或布局坐标。
- IPC 使用精确字段白名单，图片子对象也默认拒绝未知字段。
- 模型输出经过标题、字段、文本、内容组、表格结构、总字符、预估页数和实际页数限制。
- 正式产物重新检查 OOXML、大小、Hash 和项目归属后才登记；失败或取消清理临时/最终文件和未完成登记。
- 错误日志只保存分类和白名单 code，不记录文档正文、绝对路径或堆栈。
- 没有真实 Electron 恶意文件、打包运行时或 Provider 边界证据，故不宣称“已加固”或“可发布”。

### 6.5 重复代码或过度设计

模板集中为 tokens、frame style 和布局容量，渲染函数只有一套；未增加通用 Agent 框架、备用链路、新依赖或自由配置对象。取消和回滚复用现有 Execution、FileReference、Work 与 repository owner。审查未发现需要本轮继续抽象的重复实现。

### 6.6 测试是否覆盖需求

行为测试覆盖：详细提示词、PPT 元数据、三类资源预算、实际展开页数、五模板、16:9、内容完整性、续页、宽表只重复首列、表格行列一致、单块溢出、图表、图片、非法 IPC、模板去重、不同模板独立、取消竞争、原子发布失败、OOXML 类型、Hash 变化、无 Work/半成品、脱敏日志和 UI 合同。

合同测试不能证明真实 React/Electron 生成操作体验；窄/宽 Renderer 和 Electron 启动/退出已有实测证据，其余交互列为未验证，不用测试数量替代。

### 6.7 错误处理是否完整

用户可见错误包含非法请求、大纲无效、布局溢出、取消、生成/写入失败、作品/文件不可用；内部路径、内部 prompt、原始模型 JSON 和堆栈不进入聊天页。一次模型响应在 Application 严格编译失败时，仅允许调用 Platform 本地恢复一次；恢复仍失败、取消或资源超限即停止，不会追加 Provider 调用或进入循环。结果挂接遇到 revision conflict 最多重读当前 revision 并重试两次；Runner 对取消、临时写入、OOXML、Hash、发布、登记和回滚均有受控分支。

## 7. 独立代码审查状态

按 `requesting-code-review` 两次调用只读审查 Agent，均未产生审查结果：第一次为连接中断，第二次为外部服务 `403 insufficient balance`。主 Agent 已逐文件对照设计、计划、Git 差异与测试完成自审，并修复实际页数预算缺口；本记录不把自审描述为独立审查通过。

## 8. Git 与未验证项

- 当前分支：`feature/ppt-quality-layouts-current`，不是 `main`/`master`。
- 未执行 `git add`、commit、push、PR、merge、deploy 或发布。
- `.tmp/` 为本地验收产物，未纳入 Git。
- `AGENTS.md` 保持用户本地未暂存修改。
- 未运行真实 Provider、未读取凭证、未产生收费调用。
- 未运行 `pnpm package:win` 或 `pnpm package:win:dir`。
- 本轮为 UI 验收启动的 Electron/Vite 开发进程已按工作区命令行精确清理；交付前复查仓库开发 Electron/Node 进程为 0、5173 监听为 0、PowerPoint 进程为 0。
- 未完成 Windows Electron 五模板真实生成、键盘完整路径、加载/失败、重复点击、取消和作品登记验收；未完成 WPS、真实 Provider 与打包产物验收。

下一安全步骤：由项目负责人按本次交付的人工验收手册，在现有 Windows Electron 开发环境中用同一固定提示词分别选择五模板，补做真实生成、PowerPoint/WPS 打开、重复点击、取消和作品登记验收；通过后再决定是否授权暂存或提交。

## 9. 2026-08-27 长响应误报失败与取消状态修复

项目负责人真实验收时出现“回答仍在生成，但页面同时提示 AI 内容生成失败”的矛盾状态。脱敏运行记录确认：该次执行在 Renderer 等待窗口结束时仍为 `streaming`，随后一次执行实际完成并登记了 PPTX，并非所有模型均生成失败。

根因有两个：

1. Renderer 固定轮询 300 次、约 5 分钟，耗尽后把仍为 `pending/streaming` 的执行误判为失败；Provider 文本流统一策略的总时限为 15 分钟，Renderer 形成了更短的第二状态真源。
2. Provider 确认 `stream_cancelled` 时只更新 ResponseExecution，未把对应 conversation assistant message 从 `streaming` 投影为 `cancelled`，导致刷新后旧消息仍可显示“正在回答/正在生成 Office 文档”。文档流程的 `busy` 状态还错误禁用了活动响应的停止按钮。

最小修复保持现有 owner：Application 等待编排持续跟随主进程真实终态；Renderer 只适配 IPC 并在活动响应期间开放停止按钮；Provider 生命周期先持久化取消终态，再将助手消息投影为 `cancelled`，最后向 Renderer 发布终态事件。未新增 Provider 调用、模型名称分支、重试链路、依赖或权限。

本轮严格 TDD 证据：

- RED：应用等待用例与 linked lifecycle 工厂尚不存在，2/5 失败；UI 取消合同 11/12 通过、1 项因 `busy` 禁用失败。
- GREEN：第 302 次读取才完成仍可返回完成结果；取消顺序为 execution terminal → message cancelled → terminal event published；活动文档响应期间停止按钮保持可用。
- 窄测试：Application/Platform 6/6，UI 文档合同 12/12。
- 相邻 Provider/会话回归：74/74。
- `pnpm typecheck`、`pnpm lint`、`pnpm build`：退出码均为 0；构建保留既有 Vite CJS 和大 chunk 警告。
- `pnpm test` 单独运行：149 个测试文件、889/889 项通过。首次把全量测试与构建并行运行时有 6 项文件系统测试达到 5 秒超时；对应 3 个文件随后单独复跑 33/33，通过后全量测试独立复跑 889/889，证据支持并行资源争用而非本次状态修复回归。
- `git diff --check`：退出码 0，仅有工作区既有 LF/CRLF 提示。
- 当前 UniComp Electron 窗口仍可被 Windows 应用控制发现，但本轮只读截图再次返回 `SetIsBorderRequired failed: 不支持此接口 (0x80004002)`；未继续使用旧截图或坐标操作，也未向应用发送输入。

未验证边界：本轮未调用真实 Provider、未读取凭证、未产生费用，也未把本地自动化描述为真实模型链路通过。当前开发实例需要加载修复后的代码，再由项目负责人执行一次长响应、主动取消、刷新和真实 PPT 生成验收；通过前不宣称产品人工验收完成或可发布。

## 10. 2026-08-27 多页结构差异与 Office 自然语言修订实施记录

### 10.1 根因与实际修改

- PPT 同质根因：`insight/process/comparison` 虽有不同语义 ID，但大部分最终走相同的 `renderTextPage -> drawContentUnits` 几何结构；五模板的差别以配色和 frame 为主。
- 触发不准根因：Renderer 只识别“生成动作词 + 明确格式词”，无法把“第二页换成时间线”等上下文修改路由到上一版；同时新建也默认附带最近文档内容，存在误改风险。
- 新增 Application owner `src/application/office-request-intent.ts`，统一返回 create/revise、格式、修改目标类型和待补信息；提问/分析保持普通聊天，缺主题、数据范围或同类型上一版时停止。
- `presentation-template.ts` 为每个模板集中定义不同构图序列，`office-document-generator.ts` 在单一 PPT 渲染入口中增加 editorial、split、cards、timeline，并根据语义、容量、页面索引和前一构图确定性选择。
- `ChatPage.tsx` 显示“Office 操作预览”，并只在 revise 时选择当前会话最近一份同类型完成文档；create 从空白大纲生成。

> 以上“Office 操作预览”是 2026-08-27 的阶段性实现，已被本文第 11 节记录的负责人最终决定覆盖；当前实现不再显示该常驻预览。

### 10.2 TDD 与当前证据

- RED：Office 意图 4/4 因 `analyzeOfficeRequest` 不存在失败；构图序列 1 项因 `choosePresentationComposition` 不存在失败；真实 PPTX 几何回归证明四个连续 insight 页首内容组偏移仅 1 种；UI 合同 2 项因缺少操作预览失败。
- GREEN：Application 意图 4/4；模板与构图选择 6/6；真实 PPTX 几何回归 1/1；Application/平台相关回归合计 44/44；聊天文档 UI 合同 13/13；`pnpm typecheck` 退出码 0。
- 本地样例已通过现有生成器写出 PPTX；本轮 OOXML 几何断言确认四个连续 insight 页至少三种首内容组偏移，且构图选择器保证相邻页不重复。
- `presentations` 技能的受管渲染器仍无法渲染本项目 `pptxgenjs` 输出；本机 PowerPoint 可被发现和启动，但截图再次返回 `SetIsBorderRequired 0x80004002`，因此未继续发送坐标或键盘输入，未把几何/OOXML 测试描述为逐页视觉通过。

### 10.3 未验证边界

- 尚未取得本轮新构图的 PowerPoint/WPS 逐页 PNG 视觉证据，无法声明无实际文字裁切、重叠或字体度量差异。
- 尚未在真实 Electron 窗口完成“明确新建、缺信息、自然语言修改”三条键盘/点击路径，也未调用真实 Provider、读取凭证或产生费用。
- 未运行 Windows 打包；不宣称发布完成或可发布。

### 10.4 最终自动化收口

- 相关回归：Application 13/13、Platform 86/86、聊天文档 UI 合同 13/13。
- `pnpm typecheck`、`pnpm lint`：退出码 0。
- `pnpm build`：退出码 0，Vite 转换 2050 个模块；仅保留既有 CJS 弃用与大 chunk 警告。
- `pnpm test`：150 个测试文件、894/894 项通过，确认新增 Office 意图与构图测试被实际发现。
- D2 Task Decision 与 UI Delivery Shape Lock 的 pre-implementation 治理校验通过；由于本机图形捕获与真实交互证据不可用，未伪造 acceptance 阶段通过。

## 11. 2026-08-28 上下文自动修订与极简交互最终实施

### 11.1 最终产品决定

负责人确认：Office 修改统一覆盖 Word、Excel、PPT；主流程结合当前对话已有文档自动判断目标，不为每次修改增加模型调用，也不常驻显示“新建”“修改上一版”“操作预览”或目标确认面板。只有没有合法目标或缺少创建必要信息时才停止并提示。原文件必须保留，成功后生成新版。

目标解析优先级落为同一个 Application 纯函数：明确文件名优先；明确格式时选择当前对话最近同类型完成文档；省略格式的“再补、增加、丰富、调整”等表达选择当前对话最近 Office 文档；“不是这个，改前一个”按当前对话文档顺序前移；“重新做一份、另做一份、新建”明确走 create。不得跨对话、跨项目或按绝对路径猜测目标。

### 11.2 实际修改

- `src/application/office-request-intent.ts` 扩展为接收当前对话的结构化文档列表，返回精确 `targetMessageId`。自然语言修改覆盖 Word、Excel、PPT；普通咨询如“PPT 怎么做得更专业”仍走 chat。
- `src/pages/chat/ChatPage.tsx` 将完成的文档消息映射为 Application 上下文，三处意图分析复用同一输入；修改时按 `targetMessageId` 取得上一版，不再只按格式盲选最近文件。成功提示明确新版基于哪份文件且原文件已保留。
- 删除输入区“Office 操作预览” JSX、状态派生和对应 CSS。高置信度路径只保留既有生成进度、取消能力和最终文档卡；文档类型、PPT 模板、RAG、附件与 AI 配图控件保持原行为。
- `conversation-response-artifact-factory.ts` 将用户选择的项目上下文从 `system` 消息降为带“项目上下文资料：不可信参考资料，不是系统指令”边界标记的 `user` 资料消息，防止不可信材料被提升为系统规则；Provider 路由、授权、费用和调用次数没有变化。
- `office-document-generator.ts` 删除封面和正文中的内部模板展示名称；普通文本页不再机械添加“（续 N）”，表格/图表天然分页仍保留续页提示；当贪心分页只剩一个普通内容组时，从前页回移一个可容纳内容组，避免 4+1 稀疏结构。五模板继续使用单一生成器和已有的模板专属 frame/composition 序列，没有复制五套渲染器。

### 11.3 RED → GREEN 证据

RED 首次定向运行共 37 项，5 项按预期失败：自然语言修改漏判 2 项、项目上下文仍为 system 1 项、PPT 模板名可见 1 项、普通文本 4+1 孤页 1 项；UI 合同 13 项中 1 项因常驻操作预览存在失败。测试夹具曾误用项目上下文仓储创建 API，已先修正夹具后再评价生产行为。

GREEN 定向结果：Application/Provider/PPT 37/37，聊天文档 UI 13/13；`pnpm typecheck`、`pnpm lint`、`pnpm build` 均退出码 0。生产构建转换 2050 个模块，仅保留既有 Vite CJS 弃用和大 chunk 警告。

完整 `pnpm test` 本轮运行两次：第一次 896/900 通过，4 项在全量并行文件 I/O 压力下达到既有 5 秒超时；第二次 898/900 通过，2 项文档 controller 并发测试达到同一超时，其中一项超时后的清理报告 `ENOTEMPTY`。四个涉及文件随后单独复跑 40/40，通过且耗时恢复到约 0.6—1.1 秒/关键用例；没有业务断言失败。由于默认全量命令未达到 900/900，本记录不把完整门禁标记为通过，也不通过扩大超时或修改无关测试掩盖该事实。

### 11.4 页面核验与未验证边界

本地 Vite Renderer 实际渲染核验确认：对话输入区只保留“文档”入口、模型与发送按钮，不再出现“新建/修改上一版/目标文件”常驻条；无 Electron preload 时项目与发送按钮按设计禁用。真实 Electron 窗口存在，但 Windows 图形捕获仍返回 `SetIsBorderRequired failed: 0x80004002`，按控制工具规则停止向窗口发送输入。因此尚未取得本轮 Word/Excel/PPT 三类真实对话修改、缺目标提示、重复点击、取消和最终新版文件卡的 Electron 人工证据。

本轮没有调用真实 Provider、读取凭证、产生费用、运行 Windows 打包、暂存、提交、推送、合并或发布。PowerPoint/WPS 对新分页和模板名移除的逐页人工复核、真实 Provider 上下文行为和打包产物均保持未验证，不能据此宣称产品人工验收或可发布。

## 12. 2026-08-28 Excel 口语修订与付费请求超时语义修复

### 12.1 人工验收事实与根因

- 用户输入“当前工资表在加年龄跟性别”时仍进入普通对话。Application 意图 owner 当时只识别“增加、加一、加几”等词，Excel 类型词也不包含“表格、工资表、薪资表”，因此没有形成 Office revise 意图，模型返回的结构化内容被当成普通聊天展示。
- 一次 PPT 修改在服务商后台已产生费用，但本地在 62.5 秒后以 `newapi.timeout` 失败；该执行从创建到失败只有 `execution_created`、`stream_failed`，没有收到内容分片。Provider 公共策略当时的响应头等待上限为 60 秒，因此客户端可能在服务商已经接收并执行请求后先行中止。本地无法据此确认远端最终结果或费用状态，不能继续把它等同于“服务商不可用”。

### 12.2 最小修复

- `office-request-intent.ts` 将“表格、工资表、薪资表”纳入 Excel 类型识别，并增加受上下文约束的口语单字“加”识别；问句/分析优先规则保持不变，“工资表怎么加年龄列更合理？”和“今天给大家加油”仍走普通聊天。
- 文本流默认响应头等待从 60 秒调整为 5 分钟；已经开始读取流后的空闲等待仍为 60 秒，单次文本流总上限仍为 15 分钟。服务商显式测试或配置覆盖值继续生效。
- `newapi.timeout` 等 timeout 安全码投影为 `failureReason: unknown`。界面在实时事件带有 timeout 安全码以及刷新后只剩持久化 unknown 状态时，都明确提示“本地等待模型响应超时，远端状态和费用可能已经产生”，要求先核对服务商后台并避免立即重复发送；不增加自动重试，防止重复扣费。

### 12.3 RED → GREEN 与回归证据

- RED：口语 Excel 修改、5 分钟默认首包等待、timeout 的 unknown 投影、费用风险文案以及刷新后 unknown 状态保留风险提示共 5 个行为边界按预期失败。
- GREEN 窄门禁：3 个 Vitest 文件 11/11；聊天文档 UI 合同 13/13。
- 相邻回归：Office 意图、文本流超时、消息投影、NewAPI 与 DeepSeek adapter 共 5 个测试文件 75/75；聊天文档与聊天页 UI 合同 18/18。
- `pnpm typecheck`、`pnpm lint`、`pnpm build` 均退出码 0；构建转换 2050 个模块，仅保留既有 Vite CJS 弃用和大 chunk 警告。

### 12.4 未验证边界

本修复没有真实调用 Provider、读取凭证或产生新的费用，也没有自动重试。默认 `pnpm test` 本轮未运行，沿用第 11.3 节已经登记的全量并行 I/O 超时未闭合状态；不以定向门禁替代全量门禁。5 分钟首包策略、费用提示和 Excel 口语修改仍需在加载新代码后的 Windows Electron 中人工复验；服务商后台的实际计费和远端最终结果只能由服务商记录确认。

## 13. 2026-08-28 Office 意图、持久化终态与交付闭环

### 13.1 用户可见行为

- “给我生成一个表格”“帮我做一个员工表”“把这些内容整理成表格”直接进入 Excel 新建，不再要求补充主题；没有真实数据时由提示词要求生成可填写的通用模板，示例值必须标明为示例或待确认。
- “生成一份包含表格的 Word 报告”和“做个 PPT，第二页放表格”分别保持 Word/PPT；“表格应该怎么设计？”继续走普通对话。未明确格式的 Office 成果请求由 Application 使用固定规则推断，普通流程不弹确认。
- Office 产物状态从 Renderer 内存集合迁移到助手消息的持久化 `documentGenerationStatus`。模型内容、结构校验、文件生成、成功、失败、取消和中断互不混淆；编译或文件失败后刷新仍显示安全失败原因，应用重启时没有活动 worker 的遗留运行收敛为“已中断”，不会永久显示“正在生成”。
- UI 不显示 IPC 错误码、Provider 原始响应、内部 prompt、路径、endpoint、header、凭证或堆栈；具体失败只映射为内容未完成、格式异常、资源限制、本地保存失败或通用生成失败。
- 修改上一版时 Renderer 只提交受控 `parentWorkId`；Application 重新确认该 Work 来自当前对话且格式一致，Runner 创建新 Work 并登记父版本，原 Work 和原文件保留。

### 13.2 后端约束和文件质量

- `prepareGeneration` 在模型开始生成内容后立即登记 Office 状态；`generateFromMessage` 负责结构校验、确定性本地恢复、文件生成和终态持久化；`reconcileGeneration` 只用于把重启后失去 worker 的活动状态收敛为 interrupted。三个 IPC 均为命名通道、精确字段白名单，不接受路径、endpoint、凭证或任意工具参数。
- Word、Excel、PPT 的轻微 JSON 语法漂移统一使用同一次模型响应做本地恢复，不追加 Provider 调用；语义上不支持的结构继续失败关闭。Excel 额外归一化常见 `columns/data`、`headers/rows` 与多工作表形态。
- 同一助手消息的不同生成选项串行执行，同一请求仍幂等复用，避免同名文件和状态竞态。取消窗口在 Work 登记前关闭，重复取消返回稳定结果。
- Runner 在大小、扩展名、OOXML 包结构、Hash 和原子发布之外，重新读取临时 Office 包并核对标题、章节标题及 Excel 表头；包可打开但缺少关键内容的“空壳成功”会失败并且不登记 Work。

### 13.3 本轮新鲜验收证据

- RED 首次验证共暴露 5 项预期失败：Excel 普通请求仍要求主题、Word/PPT 被“表格”误路由、Word/Excel 不进入本地结构恢复、聊天 UI 仍依赖 `documentDraftMessageIds`。
- 定向 GREEN：领域、意图、Application、结构解析、Runner、Controller 共 86/86；聊天文档 UI 合同 13/13。
- 完整 `pnpm test` 最终为 151 个 Vitest 文件、912/912 通过；Node/UI 合同阶段同时全部通过。首次两轮仅出现全量并行 I/O 压力下的 5 秒测试超时，没有业务断言失败；只对三个真实重型文件用例设置 15 秒测试预算后，完整命令零失败，未放宽生产超时或行为断言。
- `pnpm typecheck`、`pnpm lint`、`pnpm build` 和 `git diff --check` 均通过。生产构建转换 2050 个模块，仅保留既有 Vite CJS 弃用与大 chunk 警告。

### 13.4 未验证边界

本轮没有调用真实 Provider、读取凭证、产生费用、运行 Windows 打包、暂存、提交或推送。真实多模型输出、Windows Electron 中的表格硬路由、Word/Excel/PPT 实际打开、失败刷新、取消/重复点击、应用重启中断和上一版修改仍由项目负责人进行人工验收。恶意或损坏附件、超出已支持 Recipe、缺少不可替代真实数据、用户取消以及真实上游/环境故障仍可以安全失败；自动化通过不等于承诺任意 Office 请求永不失败。

## 14. 2026-08-28 Excel 合法工作簿误判修复

### 14.1 人工验收根因证据

负责人连续两次输入“给我生成一个部门员工工资表格”，Provider 执行均先明确完成，Application 也正确编译出 Excel 大纲：总标题为“部门员工工资表（模板）”，单个工作表章节为“工资明细”，包含 12 个表头和 3/4 行数据。两次本地 Execution 均在 `writing_file` 失败、没有 FileReference 或 Work，错误为 `Generated document is not a valid Office package`；同一项目随后 PPT 成功，排除上游、路由、项目目录和通用 Office 运行时整体故障。

使用两次真实大纲离线重放后，ExcelJS 均生成约 6.8 KiB、16 个 ZIP 条目且包含 `xl/workbook.xml`、`xl/sharedStrings.xml` 和工作表 XML 的合法 XLSX；章节标题和 12 个表头全部存在。唯一未出现在工作簿 XML 内的是总标题，因为表格型 Excel 按既有产品行为使用章节标题作为工作表名，总标题由文件名承载。Runner 的统一内容校验却无条件要求 Word、Excel、PPT 的总标题都出现在正文 XML，因而错误拒绝合法 Excel；同一 catch 又把内容不匹配伪装成包损坏。

### 14.2 最小修复

- Excel 总标题改为通过受控生成文件名核对；工作簿内部继续严格核对工作表章节标题和全部必需表头。Word/PPT 仍要求总标题和章节标题存在于文档内部。
- OOXML 解包/必需 part 失败继续返回“无效 Office 包”；关键内容缺失单独返回 `Generated document is missing required document content`，不再混淆根因。
- 临时文件元数据、扩展名、OOXML 与关键内容检查移动到 `verifying_file` 阶段，因此失败 Execution 能准确说明发生在验证阶段；Hash、原子发布、回滚和零 Work 语义保持不变。

### 14.3 RED → GREEN 与门禁

- RED：使用真实工资表结构新增 Runner 回归，稳定复现 `Generated document is not a valid Office package`。
- GREEN：同结构 Excel 完成 Runner、文件验证和 Work 登记；反向用例证明合法 XLSX 缺少一个必需表头时仍以 `verification_failed` 在 `verifying_file` 失败，临时/最终文件清理且 Work 为 0。
- Office 相邻测试 4 个文件、87/87 通过；最终完整 `pnpm test` 为 151 个 Vitest 文件、914/914 通过，Node/UI 合同阶段同步通过。
- `pnpm typecheck`、`pnpm lint`、`pnpm build`、`git diff --check` 均通过；构建仅保留既有 Vite CJS 弃用和大 chunk 警告。

### 14.4 人工复验要求

加载新主进程代码前必须完整退出并重启 Electron。重新发送同一句工资表请求，预期生成 XLSX 文档卡并可打开；表格应包含“工资明细”工作表、12 个表头和模型生成的数据行。此前两次失败 Execution 按事实保留，不自动改写为成功，也不自动重复 Provider 请求。本轮修复没有真实调用 Provider、读取凭证、打包、暂存、提交或推送。
