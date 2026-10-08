# Office Agent 会话系统重构：阶段 1 结果

日期：2026-10-08
状态：阶段 1 实施完成；未进入阶段 2
分支：`feature/conversation-phase0`

阶段 1 只实现 Thread Summary 与按需读取链路。没有修改 Agent Runtime、Provider Tool Calling、Canonical Tool Contract、Controlled Provider Tool Bridge、工具授权、Observation、取消/超时/幂等或持久化权威来源；没有执行数据迁移。

## 实际修改

- `src/shared/chat-context-ipc.ts`
  - 新增 `listThreadSummaries`、`getThread`、`getThreadItemsPage`、`getTurn` channel、DTO、request parser 和错误码。
  - 旧 `getConversation`、`listConversations` 接口和 `ConversationDto.messages` 完整语义保留。
- `src/platform/ipc/conversation-thread-read-controller.ts`
  - 新增旧 Conversation DTO 的显式只读适配层。
  - 摘要 cursor 使用受限内存 snapshot、scope、includeArchived/includeDeleted 查询条件和 120 秒过期时间。
  - Item cursor 固定 Thread、项目 scope、方向、`readAtSequence` 和 sequence 锚点。
  - 旧 MessageId 作为 `namespace: message` ItemId；Turn 通过 `turn-legacy-v1-<sha256(threadId,messageId)>` 稳定推导，标记 `legacy_inferred`。
  - Summary 带 `hasActiveDocumentGeneration`，启动恢复只对标记 Thread 调用旧完整 `getConversation()`；普通历史列表不再全量传输正文。
  - 当前适配器读取旧完整 JSON 后再裁剪 DTO；因此优化 IPC payload 和 Renderer 加载范围，不解决物理 JSON parse/read/write 成本。
  - Legacy `getTurn` 目前需要从旧完整会话集合定位 `legacy_inferred` Turn；它是兼容读取合同，不是阶段 1 的物理索引优化，后续 Thread Repository 应提供直接 Turn 索引读取。
- `src/platform/ipc/chat-context-runtime.ts`、`src/platform/ipc/index.ts`
  - 暴露 Thread read controller；不改变旧 Conversation Controller。
- `electron/ipc/chat-context-ipc.ts`、`electron/preload.ts`
  - 接通四个新 IPC 读取 API。
- `src/pages/chat/ChatPage.tsx`
  - 新增默认开启的 `VITE_UNICOMP_THREAD_READ_PATH` 功能开关；设置为 `legacy` 时回到旧完整 list/get 读取路径。
  - 历史列表先加载 Thread Summary；选择 Thread 后加载最新 Item 页；向上滚动或按钮加载更早页，并通过 scrollHeight 差值保持阅读位置。
  - 旧完整 `getConversation()` 仍用于工作流、文档生成/恢复、编辑、重试、终态和需要完整 revision/message 的操作。
  - 新读取状态与摘要状态分离；完整 Conversation 不再写入历史列表状态。
- 测试：`tests/platform/conversation-thread-read-controller.test.ts`、既有 Controller/IPC UI contract 测试更新。

## Repository / I/O 边界

阶段 1 没有切换 Repository。`ConversationThreadReadController` 通过现有 `ConversationControllerPort.list/get` 适配，因此：

```text
Renderer IPC payload: 已减少到 summary 或 page
Renderer React message state: 已按 Thread/Item 页缩小
底层旧 conversations.json read/JSON.parse: 仍按旧 Repository 全量执行
物理 JSON write/backup/fsync: 未改变
```

这个边界是刻意保留的，阶段 1 的性能结果不能描述为物理文件 I/O 优化。真正减少底层读写需要阶段 4 Thread Repository、Segment、Manifest 和 Snapshot。

## Cursor 与分页合同

- Summary `limit`：`1..200`。
- Item `limit`：`1..200`。
- Summary cursor：版本、snapshotId、scope/query filter、offset；快照保存 120 秒，最多保留 8 个。
- Item cursor：版本、scope、threadId、direction、readAtSequence、anchorSequence。
- 默认 `older` page 返回当前高水位下最新一页，Item sequence 按升序返回；继续 older 使用 exclusive anchor。
- 新增消息不会改变已生成 Item cursor 的 `readAtSequence`。
- scope、方向、Thread 不匹配返回 cursor scope error；过期 summary cursor 返回 cursor expired；非法 limit 返回 page limit error。
- Legacy DTO 与新 Thread Summary 使用同一个 `conversationId`，不会在 UI 产生第二条会话。

## 调用方处理

以下调用方仍显式需要完整 Conversation，保留旧 `getConversation()`：

- `ConversationResponseController`：revision、user Message、Draft、ResponseExecution 启动。
- `ConversationResponseArtifactFactory`：完整上下文、附件、文档页和引用校验。
- `ConversationWorkflowController`/ChatPage workflow execution：source message、target artifact、文档交付和 revision。
- `conversation-agent-continuations.ts`：resume reference、MessageId 和 Agent Session scope。
- 文档生成恢复、重试、终态 artifact verification 和 cancelled message 编辑。

只读历史列表、Thread 打开、首屏消息和更早消息使用新读取链路。生产 Trace 事件只投影到当前已加载页内存在的 source Message，避免未加载旧消息产生错误的虚拟 Assistant 项。

## 测试证据

通过：

- `pnpm typecheck`
- `pnpm build`
- `pnpm exec eslint`（本阶段改动文件）
- `node --test tests/ui/chat-context-ipc-contract.test.mjs tests/ui/chat-page-contract.test.mjs`：9/9
- `pnpm exec vitest run tests/platform/conversation-thread-read-controller.test.ts tests/platform/conversation-controller.test.ts tests/platform/conversation-response-controller.test.ts tests/platform/conversation-response-artifact-factory.test.ts tests/application/conversation-context-builder.test.ts --maxWorkers=1 --minWorkers=1`：80/80
- 分页 Controller 测试：6/6，覆盖 summary body-free、summary snapshot、Item `readAtSequence`、旧 Turn 稳定身份、summary/item cursor scope、limit。

没有运行真实 Electron Renderer、真实 Provider、真实 Office 文件或数据迁移。生产 build 保留既有 Vite 大 chunk warning；没有新增依赖。

## 指标对比与限制

阶段 0 Node/Vitest synthetic baseline 的 1000×100 场景：旧完整 list 约 454.91ms，单 Thread get 约 433.29ms，完整 DTO payload 约 38.89 MB；摘要 payload 约 190,781 B。这说明新 API 的 IPC 候选 payload 约从 38.89 MB 降到 0.19 MB，但因为阶段 1 仍适配旧 JSON，主进程仍读取/解析完整约 56.23 MB 文件。没有“物理 I/O 已改善”的结论。

Renderer Commit、真实 Electron IPC structured clone、浏览器 Markdown parse、主进程 long task 和内存增量未测；这些指标留给阶段 2/阶段 4 的专门基线。

## 回滚验证和未完成项

回滚方式：设置 `VITE_UNICOMP_THREAD_READ_PATH=legacy`，重新构建 Renderer，即恢复旧 `listConversations/getConversation` 加载路径；新 IPC/Controller 保持可编译但不被 UI 使用。旧 Conversation 文件、Runtime 和执行记录均未改写。

未完成：按 Thread 物理文件拆分、JSONL Segment、Commit Journal、Manifest、Snapshot、Recovery、真正底层 read/parse 优化、虚拟列表和 Chromium 性能测量。阶段 2 未启动。

阶段 1 已停止，等待阶段 2 授权。
