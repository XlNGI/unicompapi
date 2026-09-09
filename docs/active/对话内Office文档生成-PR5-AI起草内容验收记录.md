# 对话内 Office 文档生成｜PR5 AI 起草内容验收记录

日期：2026-08-22

分支：`feature/chat-office-doc-pr1-domain-generator`（PR1—PR4 顺序提交后继续）

基线：`develop@1271be6`

状态：本 PR 满足批准范围与工程门禁，等待项目负责人验收后合并 `develop`。

## 一、背景与批准边界

PR4 验收反馈：文档内容由本地草拟器回显需求原文，未经过 AI 生成。本 PR 将内容起草改为真实模型生成：文档模式下先由已选文本模型按需求撰写 Markdown 正文（复用既有候选/路由/流式回复链路，不写死服务商与模型），正文完成后由主进程把 Markdown 转为大纲并生成本地 Office 文件，再挂到该 assistant 消息上形成文档卡片。

## 二、实际修改

- 领域/应用：新增 `attachDocumentResultToMessage` 与 `ConversationStreamingService.attachDocumentResult`（已完成 assistant 消息可附加文档结果，同步更新 `completedAt`/`updatedAt` 保持消息不变量）；
- 大纲解析：`parseMarkdownToOutline(markdown, kind)`——标题、小节、列表、引用、表格（含分隔行跳过、表头/行拆分）、纯文本兜底；
- 控制器：新增 `generateFromMessage`——加载会话、校验消息为 completed assistant、解析 Markdown 大纲、SHA-256 指纹、运行本地生成/校验/登记管线、附加 `documentResult` 并返回 DTO；
- IPC/preload：新增 `generate-from-message` 通道与 API；
- 对话页：`sendDocumentMessage` 改为“用户消息 → startResponse 由模型撰写正文 → 轮询执行完成 → generateFromMessage 转 Office 文档”，阶段文案区分“AI 正在撰写文档内容…”“正在生成本地 Office 文档…”。

## 三、验证结果

- 新增/更新测试：Markdown→大纲 2 项（标题/列表/表格、纯文本兜底）、控制器 generateFromMessage 1 项（AI 正文消息 → 文档结果落库 + 作品登记）、UI 契约 1 项（generateFromMessage/轮询/阶段文案），全部通过；
- `pnpm typecheck`、`pnpm lint`、`pnpm build`（含 electron）、`pnpm audit:platform`、`git diff --check` 全部通过；
- 全量 Vitest：795/796 通过，唯一失败仍为工作区既有 Vidu 未提交改动（`vidu-text-video-adapter.test.ts`），与本 PR 无关。

## 四、未完成项与阻断项

- Excel/PPT 的版式引擎与主题（PR6）未启动；AI 生图配图、识图上下文、检索/RAG 仍为后续候选；
- Windows 人工验收：需真实模型调用验证“写一份项目周报…”能得到 AI 撰写正文并正确转档；
- PLANS.md 登记继续等待负责人既有 Vidu 改动提交后一并补充。

## 五、下一步建议

1. 项目负责人验收并合入 `develop`（保留本地与远程分支）；
2. 创建 `feature/chat-office-doc-pr6-layout-engine`：版式库 × 内置主题、`pageType`/`image`/`chart` 扩展、本地图片插入与图表渲染。
