# 会话与 Agent 业务架构性能治理计划

状态：已立项，未实施。日期：2026-10-08。

本计划针对“打开项目中的会话仍然卡顿”以及后续 Agent 工作流扩展的共同基础问题。目标是把会话读取、Agent 执行、恢复和 UI 展示拆成主流的命令/查询分离与事件驱动架构，同时保留现有安全门、项目隔离、取消、预算、未知结果冻结、文件校验和正式作品登记规则。

## 1. 当前事实与问题边界

当前实现已经有 `readMode: 'fast'`，它减少了首屏 DTO 和 recovery 工作，但底层仍存在以下结构性成本：

- 项目会话列表和详情都可能读取、解析、校验完整的 `entities/conversations.json`，一个会话的读取成本随整个项目历史增长。
- 选中会话的详情路径会等待全局 recovery，并附带父任务、AgentSession 和保留作品校验；部分路径会重复触发 recovery。
- 流式消息可能反复读取和原子重写完整会话文件，与读取请求争用文件协调器。
- Renderer 一次性渲染全部消息和 Markdown，长会话没有消息分页或窗口化。
- focus、项目切换和快速选择可能重复发起尚未完成的 IPC/磁盘读取。

本计划只治理本地会话、Agent 执行和显示架构，不恢复首页入口，不新增业务一级页面，不绑定新的服务商、向量数据库或联网搜索服务，不把未实施能力写成已完成。

## 2. 目标架构

### 2.1 业务对象分层

保留现有领域事实，但明确读写职责：

| 对象 | 责任 | UI 是否直接依赖 |
| --- | --- | --- |
| `Conversation` | 用户消息、助手消息、会话标题和版本事实 | 通过查询 DTO |
| `AgentSession` / `RootRun` | 一次任务的生命周期、租约、预算、取消和恢复归属 | 只读状态摘要 |
| `ChildRun` | 一次模型、工具、检索或文档步骤 | 任务时间线/诊断 |
| `ExecutionEvent` | 不可变的流式增量、状态变化和工具观察 | 订阅投影 |
| `ConversationSummary` | 列表所需的摘要读模型 | 是 |
| `ConversationMessagePage` | 当前会话的消息窗口 | 是 |
| `AgentRunSummary` | 当前任务和待处理状态的摘要 | 是 |
| `ArtifactSummary` | 本地文件、Hash、校验和登记状态 | 是 |

LLM 只产生受控语义计划和工具参数。Application 层校验 Schema、实体、项目、权限、预算和状态；Platform 层执行白名单工具。读取页面不能赋予模型新的执行权限。

### 2.2 四条链路

1. **命令链路**：用户输入 → 意图/参数计划 → 完整性检查/追问 → 授权 → 预算与状态校验 → 创建或继续 RootRun → 受控执行。
2. **查询链路**：UI → 摘要/消息页/任务状态查询 → 只读 DTO。查询不隐式启动全局 recovery，不执行模型或工具。
3. **事件链路**：模型、工具和本地步骤 → 不可变事件 → 会话/任务/作品投影 → IPC 订阅。流式显示不依赖每个增量重新读取完整会话。
4. **恢复链路**：应用启动后台扫描未决 RootRun；普通打开会话只做有界、按会话的状态补充。发送、继续、确认或交付前必须重新执行完整准入和所有权校验。

## 3. 分阶段实施

### P0：基准、合同和可观测性

输入：当前生产构建、隔离项目 fixture、脱敏的会话规模矩阵。

新增只读性能记录，至少区分：Renderer 点击到 IPC、IPC 排队、`responses.ready`、`refreshRecovery`、文件读取、JSON 解析/领域校验、DTO 序列化、IPC 字节数、Renderer commit、Markdown/layout long task。

基准矩阵：1/10/100/1000 个会话，每会话 100/1000/10000 条消息；另测 0/1/10 个未决 AgentRun 和带/不带保留作品的会话。记录 p50/p95、最大值、字节数和失败码，不记录正文、凭证、绝对路径或原始网页。

输出：基准报告、脱敏 trace 字段合同、失败/取消语义、后续阶段的门禁。P0 不改变业务行为。

### P1：会话摘要读模型

新增版本化、可重建的 `ConversationSummaryIndex`，至少包含：

```text
conversationId, projectId, title, status, updatedAt,
revision, messageCount, lastMessagePreview, activeRunSummary,
hasPendingGeneration, indexRevision
```

列表、项目侧边栏和搜索只读摘要索引；索引缺失、损坏或版本落后时由事实源重建，重建结果经原子替换。现有 `conversations.json` 暂作为事实源，不在此阶段迁移数据库。

输入：会话事实、会话写入事件、项目 ID。

输出：稳定排序的摘要页、索引版本、重建状态。

失败码：`summary_index_unavailable`、`summary_index_rebuild_failed`、`project_scope_mismatch`、`storage_error`。

约束：索引不能授权执行，也不能覆盖事实源；摘要 revision 必须与会话 revision 对齐，落后摘要只能显示为旧状态并触发后台刷新。

### P2：详情消息分页与渐进加载

新增受控的详情查询，首屏只返回会话元数据、最近一页消息和任务摘要：

```text
getConversationSnapshot(conversationId, expectedRevision?)
listConversationMessages(conversationId, cursor?, limit?)
getConversationRunSummary(conversationId)
```

消息页使用稳定游标和明确顺序，默认取最近 30-50 条；向上滚动加载更旧消息。分页结果携带 `conversationRevision`、`nextCursor`、`hasMore` 和脱敏诊断字段。

输入：项目范围、会话 ID、游标、页大小上限。

输出：可取消的只读消息页，不执行 recovery、模型或工具。

失败码：`conversation_not_found`、`conversation_revision_changed`、`cursor_invalid`、`page_size_exceeded`、`storage_error`。

兼容：保留现有 `getConversation` 作为完整读取/迁移入口，调用方逐步切换到 snapshot + page；不在一个 PR 中删除旧接口。

### P3：详情读取与 Recovery 解耦

详情首屏先返回可显示的摘要和最近消息。全局 recovery、父任务、AgentSession、保留作品校验和文档中断核对改为：

- 应用启动后的后台恢复任务；
- 当前会话的有界 scoped recovery；
- 用户点击继续、确认、发送或交付前的强制准入检查。

同一请求内共享 recovery Promise，禁止 `get`、`readParentRuns`、`readAgentSessions` 各自重复扫描。父任务和 AgentSession 提供批量摘要读取，不逐条触发 `completion.inspect`。

输入：会话 ID、项目 session、当前 owner/epoch。

输出：`ready | recovering | needs_reconciliation | unknown_effect | failed` 的受控状态摘要。

失败码：`recovery_in_progress`、`recovery_scope_mismatch`、`recovery_outcome_unknown`、`continuation_not_available`、`cancelled`。

预算：单次 scoped recovery 设最大耗时、最大扫描条数和最大修正次数；超限保留状态为未决，不自动重试、不自动扣费。

### P4：事件追加与批量快照

流式回复、工具进度和文档进度先进入有界事件缓冲或 append-only 日志，再按时间/字节阈值批量生成会话快照。终态、取消、失败和未知结果必须立即写入 durable 状态。

建议初始参数由 P0 基准决定，候选范围为 50-200ms 或 16-64KB，且设置最大 dirty window。任何进程崩溃后都能从最后快照和事件恢复；事件去重使用稳定的 execution/sequence/idempotency key。

输入：受控事件、当前 conversation revision、RootRun 所有权。

输出：事件序号、快照 revision、投影状态。

失败码：`event_sequence_conflict`、`snapshot_write_failed`、`unknown_submission_outcome`、`owner_epoch_changed`。

此阶段不得降低现有文件校验、原子发布、作品登记和未知结果冻结门禁。

### P5：Renderer 渐进显示

- 将会话摘要和当前详情分离，避免把完整消息 DTO 放进列表数组。
- 消息列表按窗口渲染，长会话使用稳定高度估算或受控虚拟化。
- 已完成 Markdown 按消息 revision 缓存/懒解析，流式消息使用轻量文本缓冲。
- 生产 trace 使用 `afterSequence` 和最近窗口回放，旧事件按需加载。
- focus 刷新采用 200-500ms debounce、single-flight、revision/mtime 条件读取；旧请求可取消或只读丢弃。

输入：摘要页、消息页、事件订阅。

输出：首屏可交互状态、渐进消息、可恢复的滚动锚点。

失败码：`subscription_gap`、`stale_page`、`render_budget_exceeded`。

## 4. 存储迁移路线

第一阶段保留 JSON 事实源，增加索引和分层读取；索引必须能从事实源重建。第二阶段再评估按会话/消息分片文件或 SQLite/WAL，只有 P0/P1/P2 基准证明 JSON 仍达到瓶颈时才立项。迁移必须支持：

- 双读校验和 revision 对账；
- 原子切换与旧格式回退；
- 中断后继续重建；
- 不覆盖已有用户文件；
- 迁移失败时继续使用旧事实源；
- 明确的 schema version 和数据保留期限。

不把内存缓存作为唯一事实；缓存按 project/revision/mtime 失效，进程重启后可安全丢弃。

## 5. PR 与验收门禁

建议拆为六个小 PR：

1. P0 性能 trace、fixture 和基准报告；
2. P1 摘要索引与重建；
3. P2 消息 snapshot/page 查询；
4. P3 recovery 解耦与批量状态摘要；
5. P4 事件缓冲、快照和崩溃恢复；
6. P5 UI 分层、窗口化和刷新去重。

每个 PR 必须通过：类型检查、相关 Vitest/UI 合同、生产构建、`git diff --check`、项目范围/路径安全/取消/恢复回归；涉及真实文件时增加本地文件 Hash、原子写和重启恢复验证。所有 Provider 继续使用合成 transport，不读凭证、不联网、不收费。

P0 先确定正式性能门禁。计划阶段的临时目标仅用于设计讨论：摘要列表 p95 小于 200ms、最近消息页 p95 小于 300ms、点击后先显示会话框架小于 500ms；不得在真实基准完成前宣称达到这些目标或宣称稳定 60fps。

## 6. 非目标与风险

非目标：新增业务一级页面、登录/会员/云同步、服务商绑定、向量数据库、无限 Agent 循环、自动重试未知模型结果、删除旧会话数据、把索引当正式作品事实。

主要风险：索引与事实源不一致、分页与流式事件排序竞态、恢复后台化后状态短暂滞后、旧 JSON 迁移中断、虚拟列表破坏滚动/辅助功能。每项风险必须由 revision、事件序号、CAS、幂等键、可取消状态、重启恢复和人工验收覆盖。

## 7. 当前结论

本计划只完成架构和实施边界登记，尚未修改业务代码，尚未建立真实性能基准，也未声明任何新能力已完成。下一步应从 P0 开始；在 P0 报告完成前，不进入存储迁移或大范围 UI 重构。
