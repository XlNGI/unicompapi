# 生成历史与任务中心性能优化 PR2｜任务时间线记录

日期：2026-08-28

分支：`feature/task-timeline-batch-read-model`

## 实际修改

- 新增受控 `getTaskTimeline(projectId, taskId)` IPC；renderer 选择任务后只发起 1 次业务请求，不再执行调用列表、最多 200 条详情请求和末端 `taskId` 过滤。
- 主进程只定位指定项目，并按真实媒体 subject 的 `taskId` 过滤；Invocation Attempt 与 Event 由同一次文档读取获得，Route、Usage、LocalResult 与 Work 各批量读取一次。
- `getCallDetails` 改为强制携带 `projectId`，调用列表的项目过滤在读取项目事实前执行；伪造项目范围或跨项目标识不返回其他项目数据。
- 时间线 DTO、调用安全投影、用量、正式作品登记状态与原有排序语义保持不变。

## 验收结果

- 平台定向测试 6/6 通过，其中任务时间线门禁确认 5 类目标项目事实文件各读取 1 次。
- UI 合同确认任务页不存在 `listCallRecords` 或逐条 `getCallDetails` 链路，调用中心详情继续通过受控项目范围读取。
- TypeScript、定向 ESLint 与差异检查通过；完整工程门禁在本分支提交前执行。
- 未调用真实服务商、未读取凭证、未产生收费请求；未启动阶段 10 或 macOS 实机工作。

## 未完成项与下一步

PR3 将合并全局状态监控、任务活动条与任务页面的重复任务读取源，并为消费汇总增加共享请求与延迟刷新。
