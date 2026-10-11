# Office Agent 新会话系统安全整合计划

日期：2026-10-10

状态：计划已冻结，阶段 0 完成，阶段 1 完成，阶段 2 Renderer 初步接线完成，阶段 3 Shadow Projection 接线完成，阶段 4 Item 索引初步完成，隔离 Electron/Mock Provider 验收完成

## 1. 基线与范围

当前集成基线为 `develop@b1d01c7f5f346cd2ff170ab77ad1de930267257a`。用户主导的新会话实现来自 `feature/conversation-phase0@c16394aa50ad1b16e710fbb59004c7cd9688a965`，其线性后继为 `feature/conversation-e2e-completion@c449f0299e7214887f80221752c8da531aefc654`。共同祖先为 `41e73e471f83e2c1ac7ba8c885880904c8f0fb1e`。

本计划采用“当前 `develop` 执行基线 + Thread 分支新增实现 + 高冲突文件局部适配”的混合整合方式。计划不允许整体覆盖 `ChatPage`、preload 或 IPC 合同，不重写 Agent Runtime、Provider Tool Calling、Document Tool Bridge 或 Document Runtime。

迁移期间保持 `Legacy Conversation` 为生产权威。ThreadFile 先作为隔离读取、Shadow Read 和候选存储；真实数据迁移、在线双写和 authority Cutover 均需要独立门禁和负责人批准。

## 2. 必须保持的 develop 能力

- Agent-first 新消息入口和 `ConversationResponseController`；
- Agent Session、Agent Run、`ConversationAgentRuntimeService`；
- Response Execution、Replay/ACK/Backpressure 和 RAF 流式投影；
- Provider Tool Calling、Canonical Tool Contract 和 `DocumentToolBridge`；
- Document Task Runtime、PPT/Word/Excel 生成、渲染/结构校验、Work 登记和文件 Hash；
- 预算、权限、取消、超时、幂等、未知结果冻结和恢复；
- Production Trace、项目范围、会话范围和当前 `readMode: fast`；
- 当前已验证的项目切换代次保护和聊天输入状态。

Thread 不建立第二套 Agent 或 Document Runtime。Thread 保存会话 transcript、Turn、Item 和执行事实的安全投影；Agent Runtime 保持执行状态权威；Document Runtime 保持文档任务权威。

## 3. 复用与适配清单

### 3.1 优先直接复用

以下实现从 e2e 分支带入后，先独立测试，再接入当前页面：

- `src/domain/entities/conversation-thread.ts`、`src/domain/sha256.ts`；
- `src/application/conversation-thread-adapter.ts`、`src/application/model-history-reader.ts`；
- `src/platform/repositories/thread-file-repository.ts`、`src/platform/repositories/thread-migration.ts`；
- `src/platform/ipc/conversation-thread-read-controller.ts`、`src/platform/ipc/thread-file-read-adapter.ts`；
- `src/pages/chat/threadSummaryStore.ts`、`src/pages/chat/threadItemStore.ts`、`src/pages/chat/StreamingItem.tsx`、`src/pages/chat/VirtualMessageList.tsx`；
- `src/components/markdownMetrics.ts` 和完成内容 Markdown 缓存；
- Thread Repository、迁移、Adapter、Store、VirtualMessageList、Markdown 的直接测试和隔离 Electron 验收脚本。

### 3.2 必须局部适配

- `src/pages/chat/ChatPage.tsx`：保留 develop 的 Agent 发送、取消、项目切换、Trace、RAF、`readMode: fast` 和文档状态；只移植 Thread Store、分页和虚拟列表。
- `electron/preload.ts`：保留旧 `listConversations(..., readMode?)`，新增 Thread Query API；测试指标只在 E2E 环境暴露。
- `src/shared/chat-context-ipc.ts`：保留完整 Conversation DTO 合同，新增 Thread DTO、cursor、scope 和白名单解析。
- `src/platform/ipc/chat-context-runtime.ts`、`electron/ipc/chat-context-ipc.ts`：增加显式 Thread Read 接线，不改变 Agent/Document Runtime 的注册和权威。
- `src/pages/chat/StreamingMarkdown.tsx`、`src/components/MarkdownMessage.tsx`：保留当前 RAF 流式缓冲，仅对完成内容启用有界缓存。
- `electron/main.ts`、`package.json` 和 UI/Controller 测试：只接入隔离 E2E 入口和合同，不改变生产入口。

### 3.3 进入生产前必须修复

- ThreadFile Page 当前会读取并解析完整 Segment，必须增加 sequence/offset index、增量 replay 和索引恢复；
- ThreadFile Read Adapter 必须校验 project scope、cursor 签名/有效期、`readOnly`、活跃文档状态和完整 DTO 字段；
- `interrupted` 不得直接映射为 `failed`；`messageCount` 不得混用 `itemCount`；
- `legacyMessageSnapshot` 只能通过字段白名单投影给 Renderer；
- Summary snapshot、`getTurn()` 全库扫描、幂等扫描和索引重建必须有规模基线；
- Migration Shadow Compare 必须覆盖附件、reasoning、文档状态、Work/Execution/Agent 引用和失败状态。

## 4. 最小新增生产接线

只有确认现有投影合同没有生产调用方时才新增两个 Application 组件：

### `ThreadCommandService`

负责接受用户 Turn、创建 User Item、保留 `clientCommandId` 幂等键，并在迁移期间同时返回 Legacy 兼容引用。它不调用 Provider，也不决定权限或预算。

### `ThreadProjectionCoordinator`

消费已经持久化的 Agent Run、Response Execution、Tool Observation 和 Work 事实，追加 TurnExecutionLink、Assistant Item、Tool projection 和 Artifact projection。投影失败只产生 projection debt，不重放模型或工具调用。

建议接线点：

```text
ConversationResponseController.startValidated
→ ThreadCommandService.acceptUserTurn
→ 现有 Agent/Response 执行链
→ ThreadProjectionCoordinator
```

现有 Provider Tool Calling、Document Tool Bridge、Document Task Runtime 和 Work 登记代码不重写。

## 5. 分阶段实施

### 阶段 0：基线和合同冻结

目标：固定三方 SHA、冲突矩阵、测试基线和 Thread/DTO 状态合同。

允许修改：计划文档、合同测试和审计记录。

门禁：`typecheck`、`lint`、`build`、`git diff --check`；完整测试失败项必须有可复现报告。未通过不得进入生产接线。

回滚：删除阶段 0 文档/测试增量即可，不接触用户数据。

### 阶段 1：Thread Query 隔离接入

目标：新增 Summary/Thread/Page/Turn Query API，保留旧 `getConversation` 和 `listConversations`。

复用：ThreadFile Read Adapter、Legacy Thread Read Controller、preload/IPC DTO。

门禁：Legacy/ThreadFile 字段对账、项目隔离、cursor 错误、primary/backup 读取和隔离 Electron 读取。

回滚：清除 Thread Read flag，恢复 Legacy 读取；Thread 文件保留为诊断副本。

### 阶段 2：Renderer Store 和虚拟列表

目标：在当前 ChatPage 中接入 Thread Summary/Item Store、VirtualMessageList、分页和完成内容 Markdown 缓存。

不允许破坏：Agent-first、停止/取消、项目切换保护、Trace、RAF、Response Replay/ACK、文档进度。

门禁：真实 React DOM/StrictMode、A→B→A 项目切换、长会话滚动、流式期间历史行稳定、窄窗口和附件状态。

回滚：Renderer flag 回到旧列表；不影响 Thread 数据和 Agent 执行。

### 阶段 3：Thread 与 Agent/Document 投影

目标：接入 `ThreadCommandService` 和 `ThreadProjectionCoordinator`，写入 Turn、Execution Link、Assistant/Tool/Artifact projection。

门禁：幂等、连续 Tool Calling、Tool 失败/超时、取消、恢复、unknown/reconciliation、WorkId 对账；投影失败不得重发副作用调用。

回滚：关闭 Thread projection，Agent/Document 继续使用现有权威。

### 阶段 4：ThreadFile 性能和恢复增强

目标：解决完整 Segment 扫描，增加 sequence/offset index、增量 replay、索引恢复和损坏隔离。

门禁：10/100/1000 Threads、100/1000/5000 Items 的 Summary/Page p50/p95、主进程 event-loop、IPC payload、React Commit、恢复耗时和 Hash 不变。

回滚：禁用 indexed read，恢复安全的完整读取路径。

### 阶段 5：历史迁移和 Shadow Compare

目标：在隔离目录执行真实格式迁移、Ledger 续迁、完整字段/附件/文档/Work/Execution 对账。

门禁：幂等重跑、primary/backup、断点续迁、失败不覆盖源、projection debt 可恢复；Legacy 仍为权威。

回滚：停用 Thread 副本，源 `conversations.json` 不变。

### 阶段 6：Durable Journal/Outbox 和一致性追平

目标：建立 Legacy 写入与 Thread 投影之间的可靠变更记录，不做无日志双写。

门禁：并发 CAS、崩溃窗口、outbox lag、重复投影、进程重启、未知结果冻结、活跃执行保护。

回滚：只有 Legacy 已追平新写入时才允许回退旧权威；否则继续使用 Thread 或验证备份。

### 阶段 7：真实 Electron/Provider/Office E2E

目标：验证新 Thread 投影与现有 Agent/Document 执行的完整闭环。

门禁：普通 Agent、连续 Tool Calling、Tool 失败/超时、Cancel/Resume/Crash、PPT/Word/Excel、Work 登记、文件 Hash、项目隔离。

Mock Provider 只能证明接线，不替代真实 Provider 验收。

### 阶段 8：Cutover Readiness

目标：只生成 authority fence、generation、backup、lag、对账和回滚报告。

门禁：所有前置阶段通过，active unknown 为零或已明确冻结，真实数据对账完整。

正式 Cutover 需要单独批准。

### 阶段 9：生产切换和 Legacy 退出

目标：Thread 成为新会话 transcript 写入权威，Legacy 转为只读兼容适配器，所有调用方迁移后再清理旧代码。

门禁：按项目逐步切换、可恢复、可回滚、旧数据不丢失、Agent/Document/Work 状态一致。

## 6. 测试门禁

每个阶段至少执行：

```text
pnpm typecheck
pnpm lint
pnpm build
pnpm test
git diff --check
```

Thread 相关增加：

- Thread domain/repository/adapter/migration tests；
- cursor/project scope/DTO whitelist tests；
- `ConversationResponseController` Agent-first route tests；
- ThreadCommand/Projection Coordinator tests；
- Tool Call/Observation/Work projection tests；
- Electron production preload/IPC/StrictMode tests；
- 真实长会话性能和恢复矩阵。

当前 `develop` 的完整默认测试基线为 Node/UI 396/396，Vitest 3300/3315，15 项失败；核心 Chat/Response/Composer 定向复核 116/116，文档生成循环在 30 秒独立门禁下 17/17。该基线必须在阶段 0 中保留原始日志，并在进入阶段 1 前决定哪些失败需要修复、哪些属于并发/时限环境问题。

## 7. 实施规则

- 不整体采用 e2e 的 `ChatPage`、preload 或 shared IPC 版本；
- 不使用 `ours/theirs` 批量覆盖；
- 不修改真实用户目录；
- 不切换 ThreadFile 写权威；
- 不删除 Legacy Conversation、Workflow 或 `local_compat`；
- 不重复实现 Agent Runtime、Provider Tool Calling 或 Document Runtime；
- 所有新增 Thread 写入必须带项目范围、revision、幂等键和 projection debt 处理；
- 每个阶段保留明确 Feature Flag 和可回滚路径；
- 保留三个源分支和所有原始提交。

## 8. 当前实施起点

当前分支 `codex/conversation-thread-integration-plan` 从 `develop@b1d01c7f5f346cd2ff170ab77ad1de930267257a` 建立。阶段 0 已完成：三方 SHA、祖先关系、只读合并冲突、复用范围和测试基线已记录；`typecheck`、`lint`、`build`、`git diff --check` 通过。当前 `pnpm test` 的 Node/UI 为 396/396，Vitest 为 3300/3315，15 项失败；聊天核心定向复核为 116/116，文档生成循环以 30 秒独立门禁复核为 17/17。阶段 1 已接入 Thread/Turn/Item 合同、ThreadFile Repository/迁移工具、Thread Query DTO/parser、只读 IPC/preload 和 Runtime 选择器，并在显式 `VITE_UNICOMP_THREAD_READ_PATH=1` 下让 ChatPage 读取 Thread Summary、首屏 Item Page 和更早消息分页；默认 Legacy 路径不变。阶段 2 已把现有消息行包进可切换的 `VirtualMessageList`，并保留默认 Legacy 列表；真实 Electron 已完成 ThreadFile/Legacy 读取、分页、虚拟行和项目切换验收。阶段 3 已新增 `ThreadCommandService` 和 `ThreadProjectionCoordinator`，在显式 `UNICOMP_THREAD_FILE_WRITE_PATH=1` 下为 Agent 消息写入 Shadow Thread Turn/User Item、Agent Run Execution Link 和终态 Assistant Item；默认生产路径关闭该 flag，未切换权威。阶段 4 已增加持久化 Item sequence/offset index 和按序列范围读取，隔离 Node 性能基线已通过；Mock Provider + 真实 Electron 已通过普通 Agent、取消起始、单次 Tool Calling、PPT Work、Word/Excel 物理文件生成。真实外部 Provider、连续 Tool Calling 恢复、历史迁移和 Cutover 尚未完成。本计划不授权生产 Cutover。
