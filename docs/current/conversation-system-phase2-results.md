# Office Agent 会话系统重构：阶段 2 结果

日期：2026-10-08  
状态：阶段 2 Renderer 会话渲染升级已实施；未进入阶段 3  及存储迁移
分支：`feature/conversation-phase0`

本阶段只修改 Renderer 会话读取模型、消息渲染边界、测试和性能基线。Agent Runtime、Provider Tool Calling、Canonical Tool Contract、Controlled Provider Tool Bridge、ResponseExecution/SSE/ACK/Replay/Backpressure、持久化权威来源和 IPC DTO 没有改动。

## 实际修改

- `src/pages/chat/threadSummaryStore.ts`
  - 新增按 `threadId` 规范化的摘要 Store。
  - `summaryById` 保存摘要身份，`orderedThreadIds` 只保存稳定排序；兼容 setter 保留 ChatPage 既有摘要更新调用语义。
- `src/pages/chat/threadItemStore.ts`
  - 新增当前 Thread 的 `itemById` + `orderedItemIds` Store。
  - 分页合并按 tagged Item ID 去重，只在新增 Item 或 sequence 变化时重建顺序；相同 Item 保留对象引用。
- `src/pages/chat/ChatPage.tsx`
  - Summary 与 Item 状态分离；旧 `listConversations/getConversation` fallback 保持完整 DTO 语义。
  - Item 页、顶部历史补页、完整 Conversation 刷新统一写入 normalized Store。
  - `projectProductionMessages` 结果按 ID 建索引，流式执行只生成一个 `streamingMessage` overlay；历史消息不再因每批 Delta 重新构建完整 display message 对象数组。
  - 新增 `ThreadItemRow` memo 边界和稳定 `message:<messageId>` key。行的动态状态由显式 `rowRevision` 控制，历史 Item 对象引用不变时不会重新提交子树。
  - 保留 `prependScrollAnchorRef` 的顶部分页高度补偿和 `followOutputRef` 的用户上翻保护。
  - 使用 `useChatLayoutEffect` 保持真实 Electron 的布局补偿，同时兼容无 DOM 的既有 hook runner。
- `src/pages/chat/StreamingItem.tsx`
  - 当前流式 Assistant 的独立渲染边界；历史完成 Item 继续使用 `StreamingMarkdown/MarkdownMessage`。
- `src/components/MarkdownMessage.tsx`
  - 用 `useMemo` 稳定 Markdown 子元素；content 变化仍完整解析，未引入无界 AST 缓存。
- `tests/application/thread-item-store.test.ts`
  - 验证分页顺序、对象引用、Projection Item 重放去重。
- `tests/application/thread-summary-store.test.ts`
  - 验证摘要身份隔离和旧 revision 丢弃。
- `tests/performance/conversation-phase2-render-baseline.test.ts`
  - 在系统临时目录之外只写入忽略目录 `outputs/conversation-phase2/render-baseline.json`，测量合成 Item 更新工作量、长 Markdown SSR 和 Node 内存。
- `tests/ui/chat-phase2-render-contract.test.mjs`、`tests/ui/chat-page-contract.test.mjs`
  - 固定 normalized Store、stream overlay、memo row、稳定 key、滚动补偿和不盲目引入虚拟列表的合同。

## 渲染合同

```text
Thread Summary Store
  summaryById[threadId] + orderedThreadIds

当前 Thread Item Store
  itemById[itemId] + orderedItemIds + readAtSequence/cursor

Provider/ResponseExecution Delta
  → 现有 sequence 去重、requestAnimationFrame 批处理
  → 单个 streamingMessage overlay
  → 只有当前 assistant Item 的 rowRevision 变化
  → StreamingItem/StreamingMarkdown
```

`ThreadItemRow` 的比较条件是 Item 对象引用和显式 `rowRevision`。rowRevision 包含当前流状态、执行父任务状态、trace 末序列、复制/编辑/核对/忙状态和 trace issue；因此历史 Item 不会因 stream sequence 变化而提交 DOM。终态事件仍调用原有完整 `getConversation()`，以确保最终 Message、文档状态和失败事实完整正确，未使用分页内容替代模型或终态上下文。

Markdown 没有改变 GFM、安全链接、图片策略或终态协议。完成 Item 的 Markdown 子树受到 `MarkdownMessage` 和 memo row 的双重引用隔离；流式 Markdown 仍使用既有 `StreamingTextBuffer` 和约 30ms RAF 节流，`streaming=false` 时直接以完整最终 content 渲染，确保终态不会显示缓冲截断。长代码块、表格和文档正文继续走完整 `react-markdown` 解析。

## 性能证据与边界

基准文件：`outputs/conversation-phase2/render-baseline.json`。运行环境为 Windows x64、Node/Vitest 进程；不是 Electron 主进程或 Chromium。

| 场景 | 旧全量数组工作量（300 批） | 阶段 2 目标 Item 工作量 | 旧数组映射耗时 | 单 Item overlay 耗时 |
|---|---:|---:|---:|---:|
| 100 Items | 30,000 | 300 | 0.39 ms | 0.02 ms |
| 1,000 Items | 300,000 | 300 | 2.45 ms | 0.02 ms |

这是合成 JavaScript 更新代理，证明顺序数组和历史 Item 引用没有随 Delta 重建；它不等于 React Commit 数或浏览器 DOM 时间。长 Markdown fixture 为 65,958 字符，SSR 解析 201.99 ms，HTML 136,398 bytes。该值仅用于解析规模基线，未宣称浏览器优化比例。该次进程 `heapUsed` 从 23,076,336 bytes 到 66,878,416 bytes，受 Vite/Vitest 和 SSR 生命周期影响，不能作为应用稳定内存占用。

尚未测量：真实 Electron/Chromium React Commit 次数和耗时、真实 IPC structured clone、浏览器布局和可变高度滚动、真实内存快照、虚拟列表对比、真实 Provider/Office 流程。因此本阶段不引入虚拟列表；是否引入留待真实 Renderer 基线达到门槛后决定。

阶段 1 的 IPC 边界仍然有效：新摘要/Item API 通过旧 Repository 适配，降低 Renderer payload 和初始渲染量，但仍会读取/解析旧 `conversations.json`；阶段 2 没有声称物理文件 I/O 改善。

## 验证

通过：

- `pnpm typecheck`
- `pnpm build`（保留原有 Vite 大 chunk warning）
- 阶段 1 读链路、Response、Artifact、Context、Production Timeline 和阶段 2 Store/基准 Vitest：119/119
- UI IPC、ChatPage、Markdown 和阶段 2 Renderer 合同：14/14
- 阶段 2 修改文件 ESLint
- `git diff --check`

已知测试缺口/失败：

- `tests/application/chat-composer-behavior.test.ts`：47 项中 46 项通过，1 项失败。失败是既有项目切换 race fixture 在首个 `getProjectSession()` deferred 时期望两次 `listConversations()`，当前阶段 1 的 `Promise.all` 读取会在旧请求完成前取消后续旧列表读取；本阶段没有改变该读取策略。该失败不涉及 Agent Runtime、Provider 或 Item Store，但在宣称全量回归通过前必须单独修复/确认。
- 未运行真实 Electron Renderer、真实 Provider、真实 Office、迁移或物理文件恢复测试。

## 回滚

1. 构建时设置 `VITE_UNICOMP_THREAD_READ_PATH=legacy` 可关闭阶段 1 的新读取路径；阶段 2 Store 仍只影响 Renderer 读状态。
2. 恢复 `ChatPage.tsx`、`threadSummaryStore.ts`、`threadItemStore.ts`、`StreamingItem.tsx` 和对应测试文件即可回到阶段 1 的数组渲染。
3. 本阶段没有修改用户数据、存储 Schema、Runtime、Provider 或执行记录，不需要数据回滚。

阶段 2 已停止，等待阶段 3 的明确授权。虚拟列表、Markdown AST/增量解析、真实 Chromium Commit/内存基线和阶段 4 物理 I/O 优化不属于本阶段已完成事项。
