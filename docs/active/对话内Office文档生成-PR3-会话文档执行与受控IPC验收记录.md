# 对话内 Office 文档生成｜PR3 会话文档执行与受控 IPC 验收记录

日期：2026-08-22

分支：`feature/chat-office-doc-pr1-domain-generator`（PR1/PR2 顺序提交后继续）

基线：`develop@1271be6`

状态：本 PR 满足批准范围与工程门禁，等待项目负责人验收后合并 `develop`。

## 一、批准边界

PR3 实现会话内文档执行与受控 IPC：给定会话与大纲，主进程完成“开始 assistant 消息 → 本地生成/校验/登记 → 完成消息并携带文档结果”的闭环，并提供打开文档、附件导入/提取 IPC 与 preload 白名单。不接入对话页 UI（PR4）；不调用真实模型（大纲由调用方提供，模型起草属后续）。本 PR 不调用真实服务商、不读取凭证、不产生收费请求。

## 二、实际修改

- 领域/应用：`completeAssistantMessage` 与 `ConversationStreamingService.complete` 支持可选 `documentResult`（仅 completed assistant 消息可携带，旧数据兼容）；
- 新增 `src/platform/ipc/document-generation-controller.ts`：
  - `generateFromConversation`：复用 ConversationStreamingService 的 start/append/complete 消息生命周期，DocumentGenerationRunner 生成→SHA-256 校验→登记后，以大纲正文为消息内容、以 `{ workId, fileName, kind, sizeBytes }` 完成消息；失败时消息落 failed 终态；乐观并发通过 revision 校验防冲突；
  - `openDocument`：按 workId 解析受控作品文件后由注入的 `openPath` 打开，renderer 不接触绝对路径；
- IPC/preload：新增 `document-generation-ipc.ts`（生成/打开）与附件通道（导入/提取），electron main 注册 handlers，preload 暴露 `documentGeneration`/`documentAttachments`，`vite-env.d.ts` 同步类型；会话切换守卫纳入文档操作等待；
- 共享契约：`document-generation-ipc.ts` 与 `document-attachment-ipc.ts` 的请求解析器、错误码、DTO。

## 三、验证结果

- 新增控制器测试 4 项：生成并完成消息（documentResult 落库、作品登记）、非法大纲返回 `invalid_outline`、过期 revision 返回 `revision_conflict`、打开文档解析受控路径，全部通过；
- `pnpm typecheck`、`pnpm lint`、`pnpm build`（含 electron）、`pnpm audit:platform`、`pnpm verify:handoff`、`git diff --check` 全部通过；
- 全量 Vitest：789/790 通过，唯一失败仍为工作区既有 Vidu 未提交改动（`vidu-text-video-adapter.test.ts`），与本 PR 无关。

## 四、未完成项与阻断项

- 对话页 UI（类型下拉、拖拽、文档卡片、阶段文案）未实现（PR4）；
- 模型起草大纲（需求 → 结构化 JSON 的非流式调用）未接入，当前由调用方传入大纲；
- 识图上下文接入对话生成链路未实现（PR4/后续）；
- PLANS.md 登记继续等待负责人既有 Vidu 改动提交后一并补充。

## 五、下一步建议

1. 项目负责人验收并合入 `develop`（保留本地与远程分支）；
2. 创建 `feature/chat-office-doc-pr4-chat-ui`：对话页接入生成入口（类型下拉、拖拽附件、阶段状态、文档卡片、打开/重试），并用 `prompt_once` 文本路由把需求起草为大纲 JSON 后再走 PR3 管线。
