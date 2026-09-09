# 对话内 Office 文档生成：EPUB 电子书上传与解析验收记录

日期：2026-08-24

分支：`feature/chat-epub-upload`

基线：`develop@4f2afc5`（对话内 Office 文档生成 PR1—PR6 与候选功能已合入）

状态：功能在独立分支完成并通过全量门禁，待项目负责人验收后非快进合入 `develop`（分支保留）。

## 一、批准边界

用户提出“下载的小说文件为 EPUB 格式，希望支持上传 EPUB 文件”。本功能属于已批准的“对话内 Office 文档生成”独立功能系列内的附件能力扩展：把附件白名单从 txt/md/csv/docx/pdf/xlsx/pptx 扩展为包含 epub，使对话页文档模式可拖入 EPUB 电子书并解析其正文文本，作为文档生成依据与本地检索（RAG）素材。不新增一级页面，不调用真实服务商，不读取凭证，不产生收费请求，不改变阶段 9/10 边界。

## 二、实际修改

- `src/shared/document-attachment-ipc.ts`：`DocumentAttachmentFormat` 新增 `epub` 格式，附件导入/提取 IPC 契约随之扩展。
- `src/platform/documents/file-extraction-service.ts`：
  - `detectDocumentFormat` 将 `.epub` 纳入 ZIP 魔数校验分支（PK 头 + 扩展名双重校验，扩展名与内容不符返回 `unsupported`）；
  - `extractByFormat` 新增 `epub` 分支；
  - 新增 `extractEpub`：JSZip 解包 → 校验 `mimetype`（application/epub+zip）→ 解析 `META-INF/container.xml` 定位包文档（OPF）→ 解析 manifest（id→href）与 spine（idref 阅读顺序）→ 按顺序读取 XHTML 章节 → 剥离 script/style/标签、解码 HTML 实体（含数字实体与 `&nbsp;`）、按段落/换行重组文本，以章节标题为分隔；沿用既有上限（文件 20MB、ZIP 条目 500、单章 XML 10MB、全文 2,000,000 字符、预览 4,000 字符）；
  - 非法 EPUB（缺 mimetype / container.xml / OPF / spine）返回 `failed` 并给出中文警告；条目超限返回 `too_large`。
- `src/pages/chat/ChatPage.tsx`：文档模式输入占位与拖拽提示文案补充“EPUB 电子书”，引导用户拖入 EPUB。
- `tests/platform/file-extraction-service.test.ts`：新增 4 项 EPUB 用例（spine 顺序正文提取、HTML 实体与换行解码、非 EPUB 的 ZIP 拒绝、OPF 子目录与嵌套章节路径解析）。

## 三、验证结果

- 新增测试 4 项全部通过；`pnpm test` 全量门禁 146 个文件 / 822 项通过，0 失败、0 跳过；
- `pnpm typecheck`、`pnpm lint`、`pnpm build`、`git diff --check` 全部通过；
- RAG（检索资料）复用 `extractFullText`，EPUB 上传后自动纳入附件全文检索；长篇小说建议开启“检索资料”以全文切块检索，短篇可直接作为附件预览上下文。

## 四、未完成项与阻断项

- 未新增 EPUB 封面/目录（toc.ncx/nav）专门解析，章节标题以正文 h1–h6/title 提取，无标题时以“章节 N”命名；
- EPUB 全文统一受 `maxAssembledCharacters`（200 万字符）上限约束，超长小说会被截断（有中文警告），如需完整长文处理需负责人另行决策；
- 不涉及 OCR、加密 EPUB（DRM）解密；
- macOS 延期目标与阶段 10 边界不变。

## 五、下一步建议

1. 项目负责人验收后以非快进方式合入 `develop`，保留本地与远程 `feature/chat-epub-upload` 分支；
2. 若小说场景需要更完整上下文，可在后续候选评估“章节级分段送入”或“增大全文上限”的取舍；
3. 如需支持 DOC/RTF/ODT 等更多格式，另行登记候选。