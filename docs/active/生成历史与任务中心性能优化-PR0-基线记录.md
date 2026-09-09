# 生成历史与任务中心性能优化｜PR0 基线记录

日期：2026-08-28

分支：`feature/read-model-performance-baseline`

阶段：阶段 9 已收口后的工程性能优化；阶段 10 未启动。

## 范围

- 新增独立 `test:read-model-performance` 门禁和合成项目夹具。
- 通过 `NodeProjectStorage.readJsonWithBackup` 计数器记录读模型的事实文件读取次数，不记录文件内容、项目名、路径、Prompt、媒体、凭证或远端响应。
- 冻结优化前的结构性基线：2 个项目、每项目 25 个 Task/Execution/Work/FileReference。
- 本 PR 不修改生产读模型结果、不增加缓存、不改变 IPC 或页面。

## 基线结论

合成夹具确认：

- `listTasks()` 每项目读取 1 次 `tasks.json`，但会按 Task 数量读取 `executions.json`，共 50 次；
- `listWorks()` 每项目读取 1 次 `works.json`，但会按 Work 数量分别读取 `executions.json` 和 `file-references.json`，各 50 次；
- 读取放大与实体数线性增长，而不是只与项目数增长。

2026-08-28 真实目录匿名聚合基线继续沿用总方案记录：8 个可用项目、286 个 Task、153 个 Work、289 个调用；一次 `listTasks()` 估算重复读取约 12.58 MiB，生成历史基础扫描约 28.73 MiB。该聚合没有输出项目名称、目录、用户内容或凭证。

## 验收

- `pnpm test:read-model-performance`：1/1 通过，并明确证明当前读取放大；
- `pnpm typecheck`、定向 ESLint 与 `git diff --check`：通过；
- PR0 只建立基线，不宣称性能已提升；
- PR1 必须把同一门禁更新为“每项目每相关文件最多读取 1 次”，并保持 DTO 结果一致。

## 边界

未调用真实服务商，未读取真实凭证，未产生收费请求；没有进入阶段 10，没有执行 macOS 实机或媒体工具链扩展。
