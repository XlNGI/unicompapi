# Office Agent 会话系统重构：阶段 4 结果

日期：2026-10-08  
状态：Thread 文件 Repository、Commit Journal 与恢复协议已实现；未迁移真实数据、未切换默认权威  
分支：`feature/conversation-phase0`

## 实际修改

- `src/platform/repositories/thread-file-repository.ts`
  - 新增 `ThreadFileRepository`，目录结构为：

    ```text
    entities/threads/index.v1.json
    entities/threads/<threadId>/thread.v1.json
    entities/threads/<threadId>/manifest.v1.json
    entities/threads/<threadId>/segments/*.jsonl
    entities/threads/<threadId>/commits/commits-<generation>.jsonl
    entities/threads/<threadId>/snapshots/*.json
    entities/threads/<threadId>/projection-debt.v1.jsonl
    ```

  - Segment Record、Commit Record、Manifest、Snapshot、Projection Debt 均有版本字段和 SHA-256 canonical JSON 校验。
  - Commit Journal 的完整换行记录、hash chain、fsync 成功是唯一 durable commit boundary。
  - Manifest 只在 Commit 已 durable 且 participant offset/checksum 验证后前推。
  - 单 Thread 使用进程内串行队列和 `sharedFileWriteCoordinator`；`expectedGeneration` 提供 CAS 冲突保护。
  - Segment 按字节阈值轮换，Commit 记录保留幂等提交边界。
  - Summary index、Thread metadata 是可重建投影；Projection Debt 会记录投影失败。
  - Recovery 支持 durable Commit roll-forward、尾部 quarantine、安全截断、非尾部损坏 degraded read-only、Snapshot 校验和 index 重建。
- `src/platform/repositories/index.ts`
  - 暴露新 Repository，但没有接入现有 Conversation Repository 或默认运行时。
- `tests/platform/thread-file-repository.test.ts`
  - 9 个故障注入和一致性测试。
- `tests/performance/conversation-phase4-repository-baseline.test.ts`
  - 新 Repository 合成存储基线，数据写入 `outputs/conversation-phase4/` 隔离目录。

## 提交和可见性规则

```text
校验 generation/idempotency
→ append Turn/Item/link JSONL（先写，未提交）
→ segment flush/fsync
→ append Commit Record + previousCommitHash + participants
→ Commit Journal flush/fsync（唯一 durable commit boundary）
→ Manifest atomic CAS 前推
→ Thread metadata / summary index 投影
→ 返回 committed 或 projection debt
```

Segment 已写但 Commit 未 durable 的记录不会被读取；恢复时会隔离为 orphan/torn tail。Commit 已 durable 但 Manifest 未更新时，恢复会验证 participant offset/checksum 后 roll-forward Manifest，并重建 metadata。任何投影失败都不会重新执行 AgentRun、Provider 或 Office 工具。

幂等键由 Segment Record 持久保存，重复提交返回原 Commit；同一 key 但 payload hash 不同返回 `idempotency_conflict`。同 Thread 的并发 append 在队列中串行执行，sequence 和 generation 不会交叉。

## 故障注入结果

通过：

| 场景 | 结果 |
|---|---|
| Segment 写入后退出 | orphan segment 被 quarantine，Manifest 不可见，历史为空 |
| Commit 写入前退出 | segment tail 被隔离，不产生可见提交 |
| Commit fsync 后退出 | durable Commit 被 roll-forward，Item 恢复 |
| Manifest 更新失败 | 重启后验证 participant 并前推 Manifest |
| Snapshot 损坏 | 报告 `snapshot_checksum_mismatch`，继续使用 Segment/Commit 权威 |
| 重复提交 | 返回原 Commit，不追加第二份 Item |
| 同 Thread 并发 | 串行队列保证 sequence `[1, 2]` |
| JSONL 半条记录 | 尾部 quarantine 和安全截断 |
| 非尾部 checksum mismatch | `degraded_read_only`，不跳过损坏记录 |
| Summary index 删除 | 扫描 Thread metadata 后重建 |
| 写入失败模拟 | 在 Commit 前故障点停止，恢复不产生假提交 |
| Segment Rotation | 低阈值测试生成多个 Item segment，读取结果完整 |

测试命令：

```powershell
pnpm exec vitest run tests/platform/thread-file-repository.test.ts tests/performance/conversation-phase4-repository-baseline.test.ts --maxWorkers=1 --minWorkers=1
```

结果：11/11 通过。测试只使用系统临时目录；性能报告写入 Git 忽略的 `outputs/conversation-phase4/repository-baseline.json`。

## 存储基线

Windows x64 / Node/Vitest 合成 1,000 Items 单次 durable commit：

- append：约 1,267.80 ms
- committed segment read：约 20.92 ms
- durable Commit 数：1
- Manifest：615 bytes
- Commit Journal：73,581 bytes

这不是旧 `conversations.json` 的同条件对比；阶段 0 旧模型基线保留在 `outputs/conversation-phase0/baseline.json`。本阶段没有声称整体性能已经改善。当前单次 append 的成本包含每条记录打开/写入和最终 fsync；后续可在不改变提交语义的前提下优化批量句柄和 segment checksum 计算。

## 已知风险和未完成项

- 当前写入互斥使用进程内 Thread queue 与共享 FileWriteCoordinator；没有把它描述为跨进程 OS lease。部署仍需保持 Electron project single-writer 约束，或后续增加带启动 nonce 的文件租约。
- Snapshot 已校验并在损坏时安全回退到 Segment/Commit；当前恢复重建仍以 committed segments 为完整来源，Snapshot 尚未作为增量重放加速路径。
- Manifest/metadata/index 使用原子 rename，但 Windows 目录耐久和跨文件 fsync 仍需目标机器故障注入验证。
- Repository 仍是显式新实现，没有接入默认 IPC、Agent Runtime 或旧 Conversation Repository。
- 未执行真实用户数据迁移，未删除或覆盖 `conversations.json`。

## 回滚

阶段 4 没有改变旧权威存储。回滚只需停止使用 `ThreadFileRepository`、删除新 Repository wiring（本阶段没有默认 wiring），旧 Conversation/Runtime 文件继续可读。测试临时目录和 `outputs/conversation-phase4` 可独立删除，不涉及用户数据。

阶段 4 已停止，等待后续明确授权。
