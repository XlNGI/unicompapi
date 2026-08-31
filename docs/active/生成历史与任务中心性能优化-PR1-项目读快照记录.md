# 生成历史与任务中心性能优化 PR1｜项目读快照记录

日期：2026-08-28

分支：`feature/project-read-snapshots`

## 实际修改

- `GlobalReadModelController` 按“项目 ID + 项目根目录 + 实体文件”维护最多 64 个项目的内存 Promise 快照；相同并发请求共享底层读取，失败快照立即移除。
- Task 列表一次批量读取 Tasks 与 Executions，并在内存按 `taskId` 分组；Work 列表一次批量读取 Works、Executions 与 FileReferences，并在内存建立 ID 映射。
- Task/Work 详情复用同一批量快照；可选 ProviderOperation 恢复资格仍按需读取并失败关闭。
- 项目存储监控通知会同时清理读快照与本地容量摘要，JSON 项目事实文件继续是唯一权威来源。

## 验收结果

- 2 项目、每项目 25 个实体的确定性门禁：冷读 Task 时每项目 `tasks.json`、`executions.json` 各 1 次；冷读 Work 时每项目 `works.json`、`executions.json`、`file-references.json` 各 1 次。
- 20 个相同并发 Task 查询只读取目标项目的 Tasks 与 Executions 各 1 次。
- DTO、排序、不可用项目隔离、损坏数据 `invalid_data` 与恢复资格语义保持原有测试覆盖。
- 未调用真实服务商，未读取凭证，未产生收费请求；未启动阶段 10 或 macOS 实机工作。

## 未完成项与下一步

PR2 将新增单次任务时间线查询，移除 renderer 的调用列表加逐条详情 IPC，并把调用项目筛选与分页前置。
