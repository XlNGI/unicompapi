# 阶段 2｜校验持久化与 Relink 记录

日期：2026-07-22
分支：`feature/file-verification-persistence`
负责人：开发者 B｜本地领域与平台

## 一、本次实现

- `FileReference` 增加可选 `lastVerification`，记录最后观察到的大小、Hash、匹配结果和校验时间。
- 既有 `checksumSha256` 继续作为基准证据；Hash 不一致时只更新 `lastVerification`，不覆盖基准。
- 建立版本化文件索引仓储，校验项目 ID、条目 ID、相对路径、状态、大小、Hash 和时间戳。
- `FileVerificationPersistenceService` 将探测结果转换为合法文件状态并保存 FileReference。
- 项目内文件同步更新派生文件索引；外部文件不写入项目相对路径索引。
- 保存前预检查索引路径冲突，防止两个文件 ID 占用同一路径。
- relink 必须显式用户确认，并对候选文件重新执行本地校验。
- 存在基准 Hash 时，候选文件必须完全匹配；不匹配时保留原 locator 和原记录。
- 没有基准 Hash 时，首次成功校验建立本地基准。
- 同一服务实例串行化持久化与 relink 操作。

## 二、持久化顺序

1. 根据探测结果构造新的 FileReference；
2. 预检查文件索引路径冲突；
3. 原子保存 FileReference；
4. 更新派生文件索引。

FileReference 是事实源，文件索引是可重建的派生数据。如果索引更新失败，服务抛出 `index_update_failed`，不回滚已经确认的文件事实。

## 三、安全边界

- 未经用户确认不执行 relink。
- 候选文件缺失、不可用或 Hash 不匹配时不修改持久化记录。
- relink 不删除、覆盖或移动原文件。
- 恢复流程不上传文件，不写入后台假设或凭证。
- 本 PR 不暴露 Electron IPC，不允许渲染进程提交任意绝对路径。

## 四、验证结果

- 校验持久化与 relink 测试：4 项通过。
- 平台测试：19 项通过。
- 领域测试：18 项通过。
- UI 契约测试：11 项通过。
- 完整测试：48 项通过。
- TypeScript、ESLint、生产构建和 `git diff --check`：通过。

## 五、未完成项

1. 索引更新失败后的自动重建；
2. 备份恢复执行器；
3. 已验证能力下的重新下载执行器；
4. Electron 受控存储与恢复 IPC；
5. Windows Electron 端到端恢复验收；
6. macOS 文件系统语义验证。

## 六、下一步

下一份小 PR 实现从 FileReference 重建派生索引和最小受控 IPC 契约；备份恢复与重新下载继续保持显式用户确认和能力验证前置条件。
