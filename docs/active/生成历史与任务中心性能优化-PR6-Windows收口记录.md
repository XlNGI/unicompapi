# 生成历史与任务中心性能优化 PR6｜Windows 收口记录

日期：2026-08-28

分支：`feature/read-model-performance-closeout`

结论：PR0—PR6 已按批准顺序完成 Windows x64 工程收口；阶段 10 未启动，macOS 实机仍为 `not_run/deferred`。

## 实际修改

- 调用列表把项目、产品功能、服务商、连接、模型、状态和时间过滤前置到轻量 Entry/Attempt/Route 候选阶段，按稳定排序执行 `offset/limit` 后，才为当前页构建完整安全 DTO。
- 有 Usage Observation 的候选在分页前检查精确 Usage Schema 是否存在；缺失 Schema 的项目继续登记 `invalid_data`，不会把不可解释的用量伪装成有效记录。
- 新增 7 条调用、`limit=1` 的确定性门禁：结果 `total=7`、当前页 1 条；Schema 解析计数固定为 1 次共享可用性检查加 1 次当前页完整构建，页外 6 条不构建完整 DTO。
- PR5 已确认当前指标充足，PR6 未引入磁盘索引、缩略图缓存、数据库、`.tools/` 或 FFmpeg 二进制。

## Windows 性能结果

参考环境：Windows x64，健康 NVMe SSD（ZHITAI Ti600 1TB）。合成规模为 10 个项目、1,000 个 Task/Execution/Work/FileReference；夹具构建时间不计入查询时间。

| 指标 | PR5 判断值 | PR6 最终复测 | 目标 |
| --- | ---: | ---: | ---: |
| 冷 `listTasks()` | 19.49 ms | 18.62 ms | 800 ms 内 |
| 热 `listTasks()` median（20 次） | 0.62 ms | 0.69 ms | 300 ms 内 |
| 热 `listTasks()` P95（20 次） | 0.91 ms | 1.21 ms | 300 ms 内 |
| 单项目/单草稿历史冷读 | 2.92 ms | 3.49 ms | 600 ms 内 |

这些数值只代表上述 Windows、磁盘与合成规模，不把外接盘、机械盘、断盘或 macOS 描述为同等绝对性能保证。

## I/O、IPC 与媒体门禁

- Task 冷读：每项目 `tasks.json`、`executions.json` 各最多 1 次；20 个相同并发请求共享唯一 in-flight。
- Work 冷读：每项目 `works.json`、`executions.json`、`file-references.json` 各最多 1 次。
- 单任务时间线：renderer 由最多 `1 + 200` 次调用 IPC 收敛为 1 次；目标项目 Invocation、Route、Usage、LocalResult、Work 各事实文档最多读 1 次。
- 常驻任务状态：三个消费者共享唯一 snapshot/in-flight；删除两份 5 秒轮询，保留 100 ms 变更合并和唯一 60 秒健康检查。
- 生成历史：默认首屏 20 条；25 条夹具稳定分页为 20+5、无重复；目标项目四类事实文件各读 1 次，其他项目 0 次。
- 媒体句柄：不为整页历史预创建；图片使用 lazy/async decode；视频默认无 `src` 且 `preload=none`，进入视口或选中后才加载；同一 Work 的有效句柄复用。
- PR5 条件不成立，因此没有索引删除/损坏重建项可执行；权威项目 JSON 与现有损坏/不可用项目隔离语义保持不变。

## 完整验证

- `pnpm.cmd test`：Node/UI 327 项与 Vitest 887 项，共 1,214 项通过，0 失败、0 跳过。
- `pnpm.cmd test:read-model-performance`：4/4 通过。
- TypeScript、ESLint、生产构建、交接校验、平台审计、恢复审计、阶段 9 收口校验、运行时集成、安全存储与 `git diff --check` 全部通过。
- Windows 生产 Electron：4 个进程、4/4 响应、1 个可见窗口、stderr 0 字节；请求正常关闭后残留进程 0。隔离临时目录已移入回收站。

## 边界与未完成项

- 真实服务商 HTTP/DNS 0 次、真实凭证读取/验证 0 次、收费请求 0 次、费用 0。
- 未执行 macOS 实机，`macos-primary` 继续为 `required=false`、`not_run/deferred`；Windows 结果不代表 macOS 已支持。
- 未启动安装包、签名、公证、生产更新、生产媒体组件分发、SBOM 或其他阶段 10 工作。
- 当前 Windows/NVMe/合成规模无未达目标项；慢盘、断盘和真实超大项目只保留正确性与明确不可用状态承诺，不作同等绝对耗时承诺。

本分支验收为 `passed`，允许提交、推送并非快进合并 `develop`；本地与远程功能分支必须保留。
