# Office Agent 会话系统重构：阶段 5 结果

日期：2026-10-08  
状态：隔离副本迁移工具、Migration Ledger、Shadow Comparator 和 Cutover Readiness 已实现；未执行生产 Cutover  及真实用户数据迁移
分支：`feature/conversation-phase0`

## 实际修改

- `src/platform/repositories/thread-migration.ts`
  - `LegacyThreadMigration.scan()`：扫描 Conversation、检查 Conversation/Message ID 重复、消息归属和源总 checksum。
  - `migrate()`：在目标隔离目录中按稳定 ConversationId/MessageId 导入 Thread/Turn/Item，source checksum 和 idempotency key 保证断点续迁。
  - 旧 MessageId 原样保留；legacy Turn 由阶段 3 adapter 标记 `legacy_inferred`。
  - Document Result/Retained Document Result 生成 Artifact Item，并保留原 WorkId；执行引用中的 AgentRunId/ResponseExecutionId 只建立旁路 link/ledger 记录，不复制或重启执行。
  - `shadowCompare()`：比较 Thread 摘要、Item 数量、内容 hash、重复 Thread 身份和模型上下文输入边界。
  - `prepareCutover()`：生成 authority fence/readiness，只在备份、generation、active execution、ledger 和 shadow 条件全部满足时报告 `ready_for_separate_approval`。
  - `rollbackReadiness()`：在旧仓未追平新写入时明确拒绝回滚。
- `src/platform/repositories/index.ts`
  - 暴露迁移工具；没有接入默认 IPC/Runtime，也没有切换存储权威。
- `tests/platform/thread-migration.test.ts`
  - 只使用临时目录，覆盖隔离迁移、稳定 ID、Ledger 断点续迁、Shadow 对账、Cutover 阻断和回滚阻断。

## 迁移策略边界

当前没有经过验证的持久变更追平机制，因此工具明确声明：

```text
LEGACY_AUTHORITATIVE
  → isolated migration copy
  → shadow comparison
  → readiness report
  → separate human approval required
```

迁移期间旧 Conversation 仍是权威。工具不会双写旧仓，不会在线接收新增消息，也不会声称支持无损在线双写。真实项目要进行迁移前，必须先建立持久 legacy change journal/outbox，并单独通过负责人批准。

Migration Ledger 位于目标副本的 `migration/migration-ledger.v1.json`，每条记录包含 ConversationId、source checksum、迁移状态、Item/Turn 数量、执行 ID/WorkId 引用和错误信息。中断后重复运行相同 source checksum 会跳过已完成项；同一 Conversation 内容变化会进入新的 checksum 迁移路径，不能静默覆盖旧记录。

## Cutover Readiness

Readiness 默认要求：

- source Ledger 全部 `migrated`
- Shadow differences 为零
- legacy/target generation 相等
- active AgentRun/ResponseExecution 数为零，或已有显式冻结协议
- 备份已验证
- 旧仓仍保留并可读

`onlineDualWriteSupported` 固定为 `false`。本阶段没有 authority switch 方法调用；Fence 只记录 `legacy_authoritative` 或 `prepared`。生产切换必须另行批准。

回滚只有在旧仓已追平新写入时才可安全进行。若新仓已经产生旧仓未拥有的新写入，直接切回会丢失数据，工具会返回 `blocked`，不能声称完整回滚。

## 验证结果

通过：

- `tests/platform/thread-migration.test.ts`：3/3
- 阶段 0～4 相关定向回归仍通过（包含旧 Conversation API、Context、ResponseExecution、Runtime、Thread Repository）
- `pnpm typecheck`
- 迁移工具 ESLint

未执行或未宣称通过：

- 真实 Electron Renderer/IPC 迁移流程
- 真实 AgentRun/Provider Tool Calling 迁移联调
- 真实 Office 文档生成、修改、恢复 E2E
- 生产用户目录迁移
- 生产 authority Cutover

当前环境没有针对隔离 Provider/Office 项目和凭证的安全真实 E2E harness；因此本报告把这些列为未执行项，而没有用合成测试冒充真实外部工具完成。

## 数据安全和回滚

- 所有迁移测试使用 `mkdtemp()` 临时目录。
- 源 Conversation 对象在测试中迁移前后 checksum/JSON 保持一致。
- 旧 `conversations.json` 不被打开写入、不删除、不覆盖。
- 新 Repository 写入只发生在显式目标目录。
- 回滚方式是停止使用新 Repository 并保留旧权威；若未来已切换且新写入未追平旧仓，必须恢复经过验证的备份或继续使用新仓，不能假称零丢失回滚。

阶段 5 已停止，等待负责人单独批准 Cutover；当前结果不构成生产切换授权。
