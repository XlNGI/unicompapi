# 生成历史与任务中心性能优化 PR5｜条件判断记录

日期：2026-08-28

分支：`feature/rebuildable-read-index`

结论：跳过可重建磁盘索引与缩略图缓存实现。

## 判断依据

在当前 Windows x64、健康 NVMe SSD（ZHITAI Ti600 1TB）上，新增固定 10 项目、每项目 100 个 Task/Execution/Work/FileReference 的 1,000 实体合成门禁。夹具构建时间不计入查询时间，结果为：

| 指标 | 实测 | 方案目标 |
| --- | ---: | ---: |
| 冷 `listTasks()` | 19.49 ms | 800 ms 内 |
| 热 `listTasks()` median（20 次） | 0.62 ms | 300 ms 内 |
| 热 `listTasks()` P95（20 次） | 0.91 ms | 300 ms 内 |
| 单项目/单草稿历史首屏冷读 | 2.92 ms | 600 ms 内 |

结构性门禁同时保持：Task 列表每项目 Tasks/Executions 各最多 1 次；历史首屏只读取目标项目 Tasks/Executions/Works/FileReferences 各 1 次；相同并发请求共享 in-flight。

## 决策

PR1—PR4 已消除当前主要 N+1、逐条 IPC、重复轮询和整页媒体预加载，合成规模结果已达到条件目标。继续增加磁盘索引或缩略图缓存会引入 revision 协调、损坏重建、容量清理和隐私扫描面，当前收益不足以覆盖维护成本，因此按批准方案停止于设计，不写入任何生产索引或缩略图。

本决策不把合成数据表述为所有外接盘、机械盘或断盘环境的绝对性能保证；这些环境继续以正确性和明确不可用状态优先。若未来真实项目规模或慢盘证据再次超过门槛，再从项目 JSON 事实文件可重建地启动索引设计。

## 验收与下一步

- `pnpm.cmd test:read-model-performance`：4/4 通过。
- 未引入数据库、磁盘索引、缩略图、`.tools` 或 FFmpeg。
- 未调用真实服务商、未读取凭证、未产生收费请求；未启动阶段 10 或 macOS 实机工作。
- 下一步直接进入 PR6 Windows Electron 性能收口。
