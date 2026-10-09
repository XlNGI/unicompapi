# Office Agent Electron 真实性能诊断

日期：2026-10-09
状态：真实 Electron 读取诊断完成；本轮补充 Chromium Trace、100/1000 Threads、重启恢复和新旧语义对账；Provider/Office 外部 E2E 仍受凭据/授权阻塞；未执行生产 Cutover

## 真实运行链路

```tex
Electron main.ts
→ BrowserWindow
→ preload chatContexts
→ ipcMain chat-context handlers
→ ChatContextRuntime.threadReads
→ ThreadFileReadAdapter 或 ConversationThreadReadController
→ ThreadFileRepository 或 JsonProjectConversationRepository
→ Thread/Item page DTO
→ ChatPage ThreadItemStore
→ VirtualMessageLis
→ ThreadItemRow / StreamingItem / MarkdownMessage
```

源码证据：

- BrowserWindow：`electron/main.ts:317-360`
- preload API：`electron/preload.ts:832-856`
- IPC handler：`electron/ipc/chat-context-ipc.ts:49-70`
- 默认 legacy runtime：`src/platform/ipc/chat-context-runtime.ts:210-217,262-267,1254-1276`
- ThreadFile runtime 开关：`src/platform/ipc/chat-context-runtime.ts:156,1263-1280`
- ThreadFile Adapter：`src/platform/ipc/thread-file-read-adapter.ts:34-119`
- 旧 Repository：`src/platform/repositories/json-project-conversation-repository.ts:28-46,138-143`
- ThreadFile Repository：`src/platform/repositories/thread-file-repository.ts:170-245,401-412`
- Renderer 分页和虚拟列表：`src/pages/chat/ChatPage.tsx:1388-1454,4524-4778`

真实 Electron 由 `tests/electron/conversation-phase6-e2e.mjs` 启动，使用临时 userData、临时 project、真实 BrowserWindow、真实 preload 和 DevTools Protocol。测试真实点击三个历史会话，往返切换并执行顶部滚动；在 1000/5000 Items 场景实际触发“读取更早消息”分页，然后再执行同一 Renderer 中的五次 Summary/Page 读取。测试结束会杀掉 Vite/Electron 子进程并删除临时目录。

## 测试构建和开关

```tex
Node v24.20.0
Electron 33.4.11
Windows x64
Vite development server + production-built Electron main/preload
React Profiler instrumentation enabled through VITE_UNICOMP_E2E=1
```

ThreadFile 模式：

```tex
UNICOMP_THREAD_FILE_READ_PATH=1
VITE_UNICOMP_THREAD_FILE_READ_PATH=1
```

Legacy 模式：两个开关均关闭。测试数据为真实格式 `entities/conversations.json`，先通过 `LegacyFileMigrationRunner` 导入 ThreadFile 副本，再启动 Electron。

## 自动化操作

脚本真实完成：

1. 创建临时 project manifest、catalog 和 legacy Conversation 文件。
2. 执行 primary 文件到 ThreadFile 的隔离迁移。
3. 启动 Vite 和 Electron BrowserWindow。
4. 通过 CDP 连接真实 Renderer。
5. 调用真实 `window.unicomp.storage.openRecentProject()`。
6. 等待真实 ChatPage、历史会话按钮和虚拟消息行挂载。
7. 点击真实历史会话按钮，连续切换三个 Thread 并返回第一个。
8. 对真实消息滚动容器触发顶部滚动；1000/5000 Items 场景点击“读取更早消息”。
9. 通过真实 preload IPC 获取 Summary 和 Item Page，并记录 E2E-only 调用计数。
10. 采集 DOM 行数、虚拟行数、Renderer heap、React Profiler Commit。
11. 通过测试专用 main IPC 采集主进程 event-loop delay。
12. 分别执行 legacy 和 ThreadFile 模式。
13. 关闭 Electron、Vite，删除临时目录。

运行命令：

```powershell
pnpm test:electron-conversation
```

该命令依次执行 ThreadFile 和 legacy 两种模式。

## 真实 Electron 数据

每个场景运行 5 次读取，p50/p95 来自同一 Electron 窗口内的真实 preload→ipcMain→Repository IPC 调用；每次场景独立启动 Electron。每个窗口包含 3 个 Thread，每个 Thread 使用相同消息规模。`ipcMetrics` 还记录真实 UI 触发的 `listThreadSummaries`、`getThread` 和 `getThreadItemsPage` 调用次数。

| Items/Threads | 模式 | Summary p50/p95 (ms) | Page p50/p95 (ms) | 主进程读取期间 event-loop max (ms) | DOM rows | virtual rows | Renderer heap |
|---:|---|---:|---:|---:|---:|---:|---:|
| 100 × 3 | ThreadFile | 0.90 / 1.00 | 5.50 / 6.20 | 16.2 | 8 | 7 | 77.5 MB |
| 100 × 3 | Legacy | 7.90 / 8.50 | 6.80 / 7.00 | 22.0 | 8 | 7 | 75.8 MB |
| 1000 × 3 | ThreadFile | 0.90 / 1.00 | 38.10 / 40.40 | 36.9 | 18 | 17 | 81.8 MB |
| 1000 × 3 | Legacy | 20.20 / 20.70 | 18.80 / 19.20 | 20.5 | 13 | 12 | 79.8 MB |
| 5000 × 3 | ThreadFile | 0.70 / 1.10 | 177.00 / 184.80 | 176.3 | 19 | 18 | 81.3 MB |
| 5000 × 3 | Legacy | 79.00 / 85.10 | 83.10 / 88.50 | 67.6 | 18 | 17 | 94.2 MB |

`outputs/conversation-phase6/electron-e2e-*.json` 是本轮实际输出。每个场景的 E2E preload 调用计数为：100 Items：`listThreadSummaries=6, getThread=4, getThreadItemsPage=9`；1000/5000 Items：`listThreadSummaries=6, getThread=4, getThreadItemsPage=12`。其中 1 次 Summary、4 次 getThread（初始加三次切换）、其余调用来自顶部滚动/分页和五次读取样本；所有记录 `ok=true`。

数据文件：`outputs/conversation-phase6/electron-e2e-*.json`。

## React Commit 和虚拟列表

真实 React Profiler 采集到了 `ChatMessageList` Commit。5000 Items 场景中，首屏及分页后只挂载 18～19 个消息行、17～18 个虚拟 row，证明虚拟列表没有一次性创建 5000 个 DOM 节点。

ThreadFile 5000 Items 样本的首个 Commit actual duration：

```tex
mount: 19.8 ms
updates: 4.6, 13.1, 1.3, 1.8, 2.5 ms
```

Legacy 5000 Items 样本：

```tex
mount: 21.8 ms
updates: 5.7, 12.5, 1.4, 2.0, 2.6 ms
```

这些 Commit 数据来自真实 Chromium React Profiler，不是 SSR 或 Node 代理。

## 真实测量的主要瓶颈

### 主要瓶颈：ThreadFile Item Page 在主进程解析完整 Segmen

证据：

- ThreadFile 5000 Items Page p95：约 184.8 ms
- 同场景主进程 event-loop max：约 176.3 ms
- Legacy Page p95：约 88.5 ms
- ThreadFile Summary p95：约 1.0 ms
- Renderer 只挂载 17～18 个虚拟 row，首个 React Commit 约 19.8 ms

结论：5000 Items 卡顿主要发生在主进程 ThreadFile Segment 读取/JSON 解析/校验，而不是当前可见 DOM 数量或 React Commit。

涉及源码：

- `src/platform/ipc/thread-file-read-adapter.ts:74-94`
- `src/platform/repositories/thread-file-repository.ts:191-214`
- `src/platform/repositories/thread-file-repository.ts:401-412`（底层 committed record 读取）

当前 Adapter 每次 `getThreadItemsPage()` 都调用 `readItems()`；Repository 会读取并解析该 Thread 的全部 committed JSONL records，然后再按 sequence 过滤。分页减少了返回 payload，但没有减少主进程 Segment 解析范围。

### 次要瓶颈：Legacy 完整 JSON 读取随数据规模增长

证据：

- Legacy Summary p95：100 Items 8.5ms → 1000 Items 20.7ms → 5000 Items 85.1ms
- Legacy Page p95：7.0ms → 19.2ms → 88.5ms
- 旧路径读取完整 `conversations.json`：`json-project-conversation-repository.ts:28-46,138-143`

Legacy 路径随整个 JSON 文档增长而变慢，但在 5000 Items 场景反而低于当前 ThreadFile Page，因为 ThreadFile 当前实现重复扫描和校验完整 JSONL Segment。

### Renderer 当前不是主瓶颈

证据：

- 真实虚拟行数量保持 7～18
- 5000 Items React mount 约 19.8～21.8ms
- 页面 `interactive=true`
- Renderer heap 约 75.8～94.2MB（包含三 Thread 切换后的当前运行态）

这不代表 Renderer 永远没有问题；长 Markdown、图片、滚动 Layout/paint 和复杂工具结果仍未单独采集 Chromium trace。

## 重复调用分析

本次 E2E 每个场景直接测量：

- Summary IPC：每个基准样本 1 次，另有真实 UI 列表加载与切换调用
- Item Page IPC：每个基准样本 1 次，顶部滚动/分页也会产生真实调用
- `getThread`：初始打开和三次会话切换各 1 次
- DOM 虚拟行：7～18（与动态高度、分页后的可视区域有关）

当前代码仍存在这些额外路径：

- `ChatPage.tsx:1764-1777`：流终态完整 `getConversation()`
- `ChatPage.tsx:1473-1500`：文档生成状态刷新
- `ChatPage.tsx:1102-1105`：Reconciliation 完整刷新
- `ChatPage.tsx` 多处编辑、重试、工作流完整读取

第二批已把文档轮询改为状态变化感知退避，但旧模式下的底层完整 JSON 读取仍然存在。当前 E2E 没有启动文档生成或 Provider，因此这些路径的真实重复调用次数尚未测量。读取链路中的真实调用计数已经通过 E2E-only preload 计数器采集；计数器只在 `UNICOMP_E2E=1` 存在，生产环境不暴露。

## 本轮补充的真实 Electron 验证

### Chromium Performance Trace

`UNICOMP_E2E_TRACE=1` 在同一真实 BrowserWindow 中启用 CDP `Tracing.start/Tracing.end`，输出位于 `outputs/conversation-phase6/traces/`。3 Threads × 100 Items 的 Trace 包含 27,550 个事件、82 个 Layout、153 个 Paint 和 7 个持续时间至少 50ms 的长任务，采样约 5.55 秒；3 Threads × 1000 Items 的 Trace 包含 33,880 个事件、117 个 Layout、236 个 Paint 和 11 个长任务，采样约 6.51 秒。Trace 只做诊断，不改变 Renderer 业务逻辑。

### 100/1000 Threads

| Threads × Items | 模式 | Summary p50/p95 (ms) | Page p50/p95 (ms) | 读取期间 event-loop max (ms) | 摘要数 | DOM/virtual rows |
|---:|---|---:|---:|---:|---:|---:|
| 100 × 100 | ThreadFile | 1.2 / 1.5 | 5.7 / 6.4 | 18.1 | 100 | 8 / 7 |
| 100 × 100 | Legacy | 197.6 / 208.7 | 56.7 / 58.5 | 49.7 | 100 | 8 / 7 |
| 1000 × 100 | ThreadFile | 1.6 / 2.0 | 5.9 / 6.5 | 16.1 | 100 | 8 / 7 |
| 1000 × 100 | Legacy | 1899.8 / 2405.8 | 425.9 / 487.8 | 419.7 | 100 | 8 / 7 |

1000 Threads 的迁移和真实 Electron 启动均完成；Legacy 1000 Threads 的列表读取已经达到秒级，读取期间主进程 event-loop 峰值约 420ms。ThreadFile 摘要读取仍保持毫秒级，但 UI 默认摘要页只返回前 100 条，未宣称一次展示全部 1000 条。

### 重启恢复、语义对账和重复执行保护

在隔离项目中，真实 Electron 第一次启动读取后被自动结束，再次启动同一项目并经过真实 preload/IPC 读取。ThreadFile 和 Legacy 两种模式均满足：`reopened=true`、分页语义签名相等、Thread/Item/MessageId/sequence/role/content/revision 样本一致。ThreadFile 与 Legacy 3 Threads × 100 Items 的语义签名也完全相等；测试只回放展示读取，不调用 Provider 或 Office 工具。

本轮输出：

- `electron-e2e-thread-file-3threads-100-restart.json`
- `electron-e2e-legacy-3threads-100-restart.json`
- `electron-e2e-thread-file-100threads-100.json`
- `electron-e2e-legacy-100threads-100.json`
- `electron-e2e-thread-file-1000threads-100.json`
- `electron-e2e-legacy-1000threads-100.json`

### 可在当前环境完成的 Electron 文档/工作流验证

- `verify-chat-production-progress-electron.cjs --strict-mode`：通过；真实 BrowserWindow/Chromium UI，使用合成 IPC 和隔离 userData，未调用 Provider。
- `verify-generation-history-cards-electron.cjs`：通过；真实组件/CSS/滚动/键盘交互，存储边界为合成 harness。
- `verify-production-document-read.cjs --dry-run`：通过；隔离 PPT 注册和本地文件 QA，`providerRequests=0`。
- `verify-production-document-add-delete.cjs --dry-run`、`--p4-add-slide --dry-run`：均通过；`providerRequests=0`。
- `verify-production-document-update.cjs --dry-run`：通过；隔离配置 hash 未变化，`productionRoundtripExecuted=false`。
- `verify-ppt-style-compiled.cjs`、`verify-ppt-organization-compiled.cjs`：通过；生成并实际渲染合成 PPTX/PDF/PNG，不能等同真实 Provider 生成。

## 未测量和未验证

- React Profiler 和 Chromium Performance trace 的 Layout/Paint/Long Task 已测；Trace 仍不是持续生产压力 profile。
- 主进程 event-loop delay 已测，但采样是测试专用 250ms 窗口，不是持续压力 profile。
- Renderer heap 已测，但不是稳定运行 10 分钟后的内存曲线。
- 未执行真实 Provider 网络请求。
- 未执行真实 Agent Tool Calling。
- 未在真实 Electron 流程中产生或对账 ToolCallId、AgentRunId、ResponseExecutionId、WorkId；本轮 fixture 是只读历史消息。
- 未执行 Word/PPT/Excel Office E2E。
- 未执行取消、Resume、异常退出后的真实 Provider/Office 恢复。
- 未覆盖 10 Threads 和 100/1000 Threads × 1000/5000 Items 的完整笛卡尔积；已完成 100/1000 Threads × 100 Items 真实 Electron 场景，以及 3 Threads × 100/1000/5000 Items 场景。

## 建议修复方向

1. 为 ThreadFile Segment 增加 committed offset 对应的 sequence index，Item Page 只读取目标范围。
2. 使用 Snapshot + Segment offset 做增量重放，避免每次分页从 JSONL 起点解析。
3. 将 Segment Record 解析/校验拆为批量流式读取，避免在主进程一次性构造完整数组。
4. 保留当前虚拟列表和稳定 Item Row；当前真实 Commit 数据没有证明需要重新设计 Renderer。
5. Provider/Office E2E 应单独使用受控测试凭证和隔离文件目录，不与本次读取基线混合。

## 自动化验证结果

通过项：

- `pnpm typecheck`：通过。
- `pnpm build`：通过。
- `pnpm lint`：通过。
- `pnpm test:ui-contract`：43/43 通过。
- ThreadFile/迁移/Adapter/虚拟列表/Markdown/读取基线定向 Vitest：5 个文件、10/10 通过。
- `pnpm test:electron-conversation`：通过；两种 Feature Flag 模式均真实启动 Electron、BrowserWindow、preload、IPC 和 Chromium Renderer，并自动清理隔离目录。
- `git diff --check`：通过。

真实 Electron Agent/Provider 检查：`pnpm exec electron scripts/verify-conversation-runtime.cjs` 确实启动了 Electron 和 production preload/IPC，但在第一条请求因隔离 Provider Registry 没有可用模型而返回 `model_selection_required`，随后脚本未能在其自身清理时限内退出，已停止该测试进程并记录为环境阻塞；没有发送任何 Provider 请求。当前环境只发现已保存的 Provider registry 元数据，没有为本轮授权的隔离 Provider 凭据或外部请求批准。

失败项的隔离复核：`tests/platform/conversation-response-controller.test.ts` 单独运行 51/51 通过；`tests/platform/production-document-generation-loop.test.ts --testTimeout=30000` 单独运行 17/17 通过，说明默认 5 秒时限不足且全套并行时出现资源竞争；`tests/application/chat-composer-behavior.test.ts` 单独运行仍为 43/47，通过确认其中 4 项是稳定的当前行为/竞态断言失败，需要另行修复。

完整 `pnpm test` 未通过：本轮日志为 `outputs/conversation-phase6/full-test-phase7-review.log`，326 个测试文件通过、2 个测试文件失败，3337/3347 个测试通过，10 个失败。失败集中在：

- `tests/application/chat-composer-behavior.test.ts`：3 个“重开后显示回复失败原因”断言和 1 个旧项目加载竞态计数断言。
- `tests/platform/production-document-generation-loop.test.ts`：6 个 5 秒长时限超时。

`tests/platform/conversation-response-controller.test.ts` 本轮未失败。单独提高 `production-document-generation-loop.test.ts` 到 30 秒后仍为 17/17 通过；Chat Composer 单独运行仍为 43/47，4 项稳定失败。这些失败没有被修改断言或跳过；它们阻止把完整测试套件标记为全绿。它们也不影响已经通过的读取链路定向测试和真实 Electron 读取诊断，但在进入性能修复或生产切换前必须分别处理。

## 验收结论

【真实测量结果】已完成 legacy/ThreadFile 两种模式的真实 Electron 对比。
【主要瓶颈】5000 Items 时 ThreadFile Page 的主进程 Segment 全量解析和校验。
【Renderer 结论】虚拟列表生效，当前 DOM/React Commit 不是主要卡顿来源。
【Chromium Trace】已完成；100/1000 Threads、重启恢复和新旧语义对账已完成。
【Provider/Agent】真实 Provider Tool Calling、Cancel/Resume/Timeout 仍因隔离凭据和外部请求授权阻塞；Electron IPC smoke 在无模型配置下明确失败。
【Office】合成 PPT 本地渲染/回读通过；真实 Provider 驱动的 Word/PPT/Excel 生成、修改和恢复未验证。
【生产 Cutover】未执行、未授权。
【下一步】先处理完整测试套件的 10 项失败，再在获得隔离 Provider 凭据和外部请求授权后运行真实 Agent/Office E2E；性能修复仍应先优化 ThreadFile Page 的 Segment 索引/增量读取。
