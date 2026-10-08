# Office Agent 会话系统重构：阶段 3 结果

日期：2026-10-08  
状态：Thread / Turn / Item 领域模型与兼容适配已完成；未切换生产权威、未迁移历史  
分支：`feature/conversation-phase0`

本阶段仅落地领域合同、只读 shadow projection、执行关联 metadata、展示投影去重和模型历史读取适配。现有 Conversation Repository、Agent Runtime、ResponseExecution、Provider Tool Calling、Canonical Tool Contract、Tool Gateway、Observation、取消/恢复/超时/幂等协议均保持权威；没有写入用户历史或改变运行时执行行为。

## 实际修改

- `src/domain/ids.ts`
  - 新增品牌 `ThreadId`、`TurnId`、`ItemId`、`ToolCallId`。
  - `ThreadId` 与旧 `ConversationId` 通过同值转换兼容；`TurnId` 必须使用 `turn-` 前缀；Projection ItemId 必须是 `item-projection-v1:<sha256>`；ToolCallId 独立于 ItemId。
- `src/domain/entities/conversation-thread.ts`
  - 新增 `ThreadV1`、`TurnV1`、`ItemV1`、`TurnExecutionLinkV1`。
  - 提供严格解析、生命周期更新、不可变身份、单调 sequence/counter、消息 Item 与投影 Item 约束。
  - `appendTurnExecutionLink()` 只追加 metadata，不改变 AgentRun 或 ResponseExecution 生命周期。
- `src/domain/sha256.ts`
  - 提供 Renderer-safe 的同步 SHA-256，用于 projection identity；不引入 `node:crypto` 到 Vite bundle。
- `src/application/conversation-thread-adapter.ts`
  - `conversationToThreadProjection()` 将旧 Conversation 映射为 Thread、legacy_inferred Turns 和保留原 MessageId 的 message Items。
  - `ConversationThreadShadowProjector(false)` 默认关闭；启用时只生成内存只读投影。
  - Tool Call/Tool Result/Artifact 展示项按 `(threadId, projection kind, eventSystem, sourceIdentity)` 的 SHA-256 身份去重；ToolCallId 作为关联字段保留；Artifact 只引用真实 WorkId。
- `src/application/model-history-reader.ts`
  - `ModelHistoryReader` 通过完整 Conversation read 独立获取上下文，提供 `readModelHistory`、`buildContext`、`assembleAgentContext`。
  - UI Item 分页不会改变模型历史；Builder 和 AgentContextAssembler 的 system/reference、最近消息、token budget、裁剪和 tool message 语义保持原实现。
- `src/domain/index.ts`、`src/application/index.ts`
  - 导出新增合同和适配器。
- 测试：
  - `tests/domain/conversation-thread.test.ts`
  - `tests/application/conversation-thread-adapter.test.ts`
  - `tests/application/model-history-reader.test.ts`

## 关键不变量

```text
ConversationId == ThreadId（仅兼容值映射）
MessageId → ItemId { namespace: message, value: 原 MessageId }
(ThreadId, projectionKind, eventSystem, sourceIdentity)
  → ItemId { namespace: projection, value: item-projection-v1:<sha256> }
TurnId → TurnExecutionLinkV1[] → 现有 AgentRunId / ResponseExecutionId
ToolCallId 保持 Provider/Runtime 原值
WorkId 保持作品仓库原值
```

投影重放只更新相同 source identity 的 Item；不会重新调用 Provider 或 Office 工具。Unknown Runtime 结果、幂等键、Observation 和恢复冻结仍由现有 Runtime/Execution Repository 管理。Item 只表示内容和展示投影，不具备执行控制权限；Turn 只汇总会话轮次，不替代 AgentRun。

## ModelHistoryReader 兼容证据

Reader 的输入是完整 `Conversation`，因此不从 Renderer 的首屏/分页 Store 推断上下文。测试对同一 Conversation 分别调用原 `ConversationContextBuilder.build()`、新 `ModelHistoryReader.buildContext()`，结果逐字段相等；Agent-native 路径同样比较 `AgentContextAssembler.assemble()` 与 Reader 适配结果。当前 Reader 尚未注入 `ConversationResponseArtifactFactory`，这是后续在不改变 startValidated 合同前的窄适配工作；本阶段不切换生产上下文来源。

## 验证结果

通过：

- `pnpm typecheck`
- 新增领域/适配/ModelHistoryReader Vitest：9/9（含 SHA-256 身份向量）
- `pnpm build`（保留既有 Vite 大 chunk warning）
- 新增领域/应用文件 ESLint
- 既有阶段 0/1/2 执行链和读模型定向测试仍保持原合同（应与阶段验收命令一起运行）

本阶段没有运行真实 Electron、Provider、Office 或用户数据迁移；没有声称端到端工具执行已由新模型验证。新 projection 只在显式启用 `ConversationThreadShadowProjector(true)` 时生成，生产默认不启用。

## 已知风险和后续边界

- `ModelHistoryReader` 当前通过旧完整 Conversation read 适配，保证语义兼容但不减少底层旧 JSON read/parse；物理优化属于阶段 4 Repository 工作。
- 执行 link 当前是旁路 metadata API，尚未由 Response Controller 在真实 startValidated 提交；切入时必须先建立 Turn、再写 link，并保留原执行 ID 和幂等边界。
- Projection Item 的持久化、Commit Journal、Snapshot、Recovery 和 projection debt 尚未实现；本阶段未修改存储 Schema。
- 旧 Conversation 的 Turn 只能按 user message 边界稳定推断，均标记 `legacy_inferred`；没有事实的历史 AgentRun/ToolCall 不会被伪造。

阶段 3 已停止，等待后续明确授权。下一步若批准，应先为 Response Controller/Artifact Factory 设计最小 Turn link 接入和 shadow comparison，再进入文件 Repository/迁移阶段；不得直接切换生产数据权威。
