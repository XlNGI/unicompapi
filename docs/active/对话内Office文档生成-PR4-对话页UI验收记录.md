# 对话内 Office 文档生成｜PR4 对话页 UI 验收记录

日期：2026-08-22

分支：`feature/chat-office-doc-pr1-domain-generator`（PR1—PR3 顺序提交后继续）

基线：`develop@1271be6`

状态：本 PR 满足批准范围与工程门禁，等待项目负责人验收后合并 `develop`。

## 一、批准边界

PR4 在对话页接入“生成 Office 文档”模式：类型下拉（自动/Word/Excel/PPT）、拖拽文件发送、附件摘要、文档卡片（打开/作品库）、失败提示。v1 大纲由本地确定性草拟器从需求文本生成（不调用模型）；模型起草作为后续 PR。本 PR 不调用真实服务商、不读取凭证、不产生收费请求。

## 二、实际修改

- 对话页（`src/pages/chat/ChatPage.tsx`）：
  - 输入区新增“文档”模式开关与类型下拉（自动判断由关键词启发式推断 Word/Excel/PPT）；
  - 文档模式下支持拖拽文件：`webUtils.getPathForFile` 取路径 → `importAttachment` 登记项目内副本并提取 → 附件摘要 chips 展示、可移除；
  - 发送走独立 `sendDocumentMessage`：创建/复用会话 → 用户消息 → `generateFromConversation`（本地草拟大纲 + SHA-256 指纹）→ 完成后消息呈现文档卡片（文件名/类型/大小/打开/作品库）与可折叠大纲正文；
  - 未打开项目、归档/只读会话、忙状态均禁用文档入口；
- 本地草拟器（`src/pages/chat/documentDrafting.ts`）：`inferDocumentKind`、`buildOutlineFromRequirements`、`sha256Hex`，纯函数可测；
- preload 暴露 `getPathForFile`，`vite-env.d.ts` 同步；App 传入作品库跳转；
- 样式：文档卡片、附件 chips、拖拽态、模式开关。

## 三、验证结果

- 新增测试 4 项：草拟器 3（类型推断、大纲构建、指纹）+ UI 契约 1（入口、类型选项、卡片、受控路径/附件 API 存在性、样式）全部通过；
- `pnpm typecheck`、`pnpm lint`、`pnpm build`（含 electron）、`pnpm audit:platform`、`pnpm verify:handoff`、`git diff --check` 全部通过；
- 全量 Vitest：792/793 通过，唯一失败仍为工作区既有 Vidu 未提交改动（`vidu-text-video-adapter.test.ts`），与本 PR 无关；
- 既有 rsuite 契约（模型选择器搜索归属）保持通过，未破坏对话页既有能力。

## 四、未完成项与阻断项

- 模型起草大纲（需求 → 结构化 JSON 的非流式文本调用）未接入，当前为本地确定性草拟；
- 识图作为生成依据（视觉模型分析图片并影响文档内容）未接入；
- PR5 版式引擎与主题未启动；
- Windows Electron 手工验收（真实生成三种文档并打开、拖拽、作品库联动）待负责人或人工执行；
- PLANS.md 登记继续等待负责人既有 Vidu 改动提交后一并补充。

## 五、下一步建议

1. 项目负责人验收并合入 `develop`（保留本地与远程分支），随后执行 Windows 人工验收；
2. 创建 `feature/chat-office-doc-pr5-outline-model`：复用 `prompt_once` 文本路由，把“需求+附件提取内容”起草为大纲 JSON 后接入 PR3 管线；
3. 后续 PR：版式引擎与内置主题、识图上下文、关键词检索/RAG 候选。
