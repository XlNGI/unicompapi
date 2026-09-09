# Word 文档内容与排版修复设计

## 用户确认范围

用户确认采用范围 B：Word 生成结果必须呈现正常的可编辑正文，而不是模型 JSON；同时采用接近截图 3 的专业排版方向，包括居中彩色标题、清晰标题层级、分隔线、正文间距、原生列表和可编辑表格。不要求逐像素复刻截图，也不改变 Excel/PPT 的现有产品范围。

## 已确认根因

截图中的模型输出使用了另一套 JSON 形态：根对象包含 `title` 和 `sections`，分节使用 `content`，表格使用 `headers`，列表使用 `ordered_list`，并包含 `id`、`subsection` 等当前合同没有定义的字段。当前严格大纲解析失败后，主进程把所有解析错误都降级为 Markdown；Markdown 解析器于是把首行 `{` 当成标题，并把整段 JSON 写入 DOCX。

## 推荐设计

主进程文档解析 owner 新增一个模型内容归一化入口。它先清理开场白并识别 JSON 外观；规范大纲直接使用既有 `DocumentOutline` 校验，截图所示的已知模型形态显式映射到该合同，普通非 JSON 文本才进入 Markdown 回退。JSON 外观但不符合任一已知合同时失败关闭，返回现有 `invalid_outline`，禁止生成错误的“成功”文件。规范大纲的 `kind` 必须与用户选择的格式一致。

Word adapter 只接收归一化后的 `DocumentOutline`。它使用 `docx` 原生样式生成可编辑文档：标题居中并使用主题强调色，标题层级使用主题色和稳定间距，标题下方保留分隔线；列表每项生成独立的原生段落；表格标题、表头、边框、内边距和正文行使用可编辑的 DOCX 表格对象；截图形态的表格 caption 在归一化时转为表格前的普通段落，避免扩展共享表格合同。

## 数据边界与非目标

- 不新增 Provider、模型、IPC 通道、凭证、文件访问能力或依赖。
- 不在 Renderer 中解析原始模型 JSON，不让 Renderer 接触路径、Hash 或凭证。
- 不建立第二套持久化文档 schema；截图形态只作为输入 adapter。
- 不改变 Excel/PPT 生成器，不把 Word 页面做成图片，不引入 pandoc。
- 不修改根 `AGENTS.md` 或权威交接原件，不运行真实 Provider 和打包命令。

## 验收标准

1. 截图形态的 assistant JSON 能生成标题、分节、正文、列表、表格 caption、表头和单元格均可编辑的 DOCX。
2. 生成的 `word/document.xml` 不包含原始 JSON 的结构键或序列化对象文本。
3. 普通 Markdown 仍能生成；未知或畸形 JSON 外观返回 `invalid_outline`，不登记 Work。
4. Word XML 具备居中标题、主题强调色、分隔线、标题层级、原生列表和带样式表头的表格证据。
5. 现有文档领域、应用、平台和 UI 合同测试不回归；Windows Electron 人工验收确认 WPS/Word 可打开并可编辑。
