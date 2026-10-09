# 会话系统第二批实施结果：数据完整性、隔离读取与 Renderer 性能

日期：2026-10-09
状态：第二批代码、隔离测试和真实 Electron 读取诊断完成；Provider/Office E2E 未执行，未生产 Cutover

## 实际修改

- `src/domain/entities/conversation-thread.ts`
  - ItemV1 增加 `legacyMessageSnapshot`，保存旧 Message 的完整 JSON 字段，避免附件、reasoning、文档状态、revision、timestamps 和未知扩展字段丢失。
- `src/application/conversation-thread-adapter.ts`
  - Legacy Message Item 写入完整 snapshot。
- `src/platform/ipc/thread-file-read-adapter.ts`
  - 从 snapshot 重建完整页面 Message DTO；实现摘要、Thread、Item Page、Turn 只读读取。
- `src/platform/repositories/thread-migration.ts`
  - 真实 primary/backup 文件 Runner、artifact WorkId 投影和上下文字段对账。
- `src/platform/ipc/chat-context-runtime.ts`、`electron/ipc/chat-context-ipc.ts`
  - 增加显式隔离 ThreadFile read flag，默认关闭。
- `src/pages/chat/ChatPage.tsx`
  - ThreadFile Renderer 路径必须同时满足 `UNICOMP_THREAD_FILE_READ_PATH=1` 和 `VITE_UNICOMP_THREAD_FILE_READ_PATH=1`；默认旧路径。
  - 文档生成轮询增加状态感知退避：有变化时 750ms，无变化逐步退避至 5s；只在 revision/Item 状态变化时更新 Renderer Store。
- `src/pages/chat/VirtualMessageList.tsx`
  - 新增可变高度、overscan、ResizeObserver 和顶部分页兼容的虚拟消息列表。
  - ChatPage 消息区只挂载可视范围及 overscan Item DOM。
- `src/components/MarkdownMessage.tsx`、`src/components/markdownMetrics.ts`、`src/pages/chat/StreamingMarkdown.tsx`
  - 完成 Markdown 内容缓存上限 128、长内容 200k 字符上限、流式内容禁用缓存和解析计数指标。
- 新增测试：
  - `tests/platform/thread-file-read-adapter.test.ts`
  - `tests/application/virtual-message-list.test.tsx`
  - `tests/application/markdown-message-performance.test.tsx`
  - `tests/performance/conversation-phase5-read-baseline.test.ts`
  - `tests/electron/conversation-phase6-e2e.mjs`
    - 真实 Electron + BrowserWindow + preload + CDP 自动化，比较 legacy/ThreadFile，采集真实 DOM、React Profiler、Renderer heap 和主进程 event-loop。

## 数据完整性

已验证：

- MessageId 保持稳定
- ItemId 与 MessageId namespace 关联保持稳定
- `legacyMessageSnapshot` 保留 reasoning、附件、documentGenerationStatus、documentResult、WorkId 等字段
- Legacy primary 损坏时按旧语义读取 backup
- 源文件迁移前后内容不变
- Migration Ledger 幂等续迁
- ThreadFile 分页 Item 顺序和 cursor 稳定
- Thread/Turn/Item 不触发 Provider 或 Office 执行

未知 ToolCall/Observation 字段若存在于旧 Message snapshot 会原样保留；Runtime 权威数据仍由现有 Runtime/Execution Repository 管理。

## Renderer 接入

虚拟列表使用 `VirtualMessageList`：

- 只渲染 viewport + overscan
- 通过 ResizeObserver 更新动态高度
- 使用稳定 MessageId key
- 继续使用现有 prepend scroll anchor
- 用户上翻时保留 `followOutputRef=false`
- 流式 assistant 仍由 `StreamingItem` 单独更新

当前虚拟列表已通过 5,000 Item SSR 结构测试，并在真实 Electron 中验证首屏仅挂载 14～15 条消息行。真实浏览器连续滚动和动态高度压力场景仍需扩展。

## Markdown 优化

完成 Item 内容缓存：

- 最多缓存 128 个完成内容
- 单条超过 200k 字符不缓存
- 流式内容禁用缓存
- Markdown 内容、allowImages 或 cache 条件变化才重新创建 Markdown 子树

测试验证相同完成内容重复渲染只记录一次解析，流式内容仍重新解析，保持终态正确性。真实 Electron 诊断已采集 React Commit，但尚未单独采集 Chromium Markdown parse trace。

## 完整 Conversation 刷新

文档生成轮询保留原有兜底读取，但增加：

- revision/Item 状态无变化时不调用 `replaceConversation`
- 轮询退避从 750ms 逐步增加到 5s
- 有状态变化时恢复 750ms
- 不删除取消、恢复和终态刷新逻辑

这减少了无变化的 Renderer 状态提交，但旧路径的底层 `getConversation()` 在轮询时仍会读取旧 JSON；真正消除物理 read/parse 需要 ThreadFile 写入权威和增量执行事件接入，属于后续批次。

## 测试结果

通过：

- 第二批新增/相关隔离测试：
  - ThreadFile/迁移/Adapter/性能：17/17
  - 虚拟列表、Markdown：2/2
- 阶段 0～4 相关回归：132/132
- UI 合同：14/14
- `pnpm typecheck`
- `pnpm build`
- ESLin
- `git diff --check`

## 性能测量边界

当前可复现 Node/Vitest 隔离基线：

- 10 Threads × 100 Items
- 旧路径 list p50/p95：约 4.76 / 6.50 ms
- ThreadFile summary p50/p95：约 1.00 / 1.87 ms
- 旧路径单 Thread get p50/p95：约 4.84 / 5.07 ms
- ThreadFile 首页 p50/p95：约 4.99 / 6.50 ms

这些结果不是同语义的完全等价操作。真实 Electron 报告和原始数据位于 [electron-real-performance-diagnosis.md](electron-real-performance-diagnosis.md) 与 `outputs/conversation-phase6/electron-e2e-*.json`。尚未测量：

- 真实 Electron IPC structured clone 的精确拆分
- 真实 100/1000 Threads 和 1000/5000 Items 浏览器滚动
- Provider/Agent/Office E2E

## 回滚和风险

- 清除两个 ThreadFile Feature Flag，回到旧读取路径。
- 虚拟列表可通过恢复消息区 map 渲染回退。
- Markdown 缓存可通过 `cache={false}` 回退。
- 旧 Repository、Runtime、Provider 和 Office 写链路未切换。
- ThreadFile Adapter 当前只读；生产权威仍旧为 JsonProjectConversationRepository。
- Provider/Agent/Office 外部工具验收未完成，不能宣称本批已达到完整生产性能门禁。

下一批应先建立 Electron 可控性能 harness 和真实隔离项目 E2E，再决定是否扩大 ThreadFile read flag 范围。
