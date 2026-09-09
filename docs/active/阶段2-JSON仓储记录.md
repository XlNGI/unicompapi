# 阶段 2｜JSON 仓储记录

日期：2026-07-22
分支：`feature/json-repositories`
负责人：开发者 B｜本地领域与平台

## 一、本次实现

- 建立 `JsonProjectRepository`，读写项目根目录的 `project.json`。
- 建立草稿、素材、文件引用、任务、执行记录和作品 JSON 仓储。
- 集合文件统一使用 `{ schemaVersion: 1, entities: [] }` 格式。
- 保存按实体 ID 执行 upsert，不覆盖其他实体。
- 项目仓储绑定项目 ID；项目范围仓储拒绝跨项目保存、查询和磁盘数据。
- 执行记录仓储在项目内共享 `executions.json`，按任务 ID 查询并保留其他任务的执行历史。
- 同一仓储实例串行化写入，避免并发保存产生读改写丢失。
- 读取时校验集合版本、实体版本、ID 唯一性、作用域、状态枚举、必要引用和规范时间戳。
- 未知版本、重复 ID、未知状态、无效时间戳和跨作用域数据统一抛出 `RepositoryDataError`。

## 二、持久化文件

```text
project.json
entities/drafts.json
entities/assets.json
entities/file-references.json
entities/tasks.json
entities/executions.json
entities/works.json
```

所有写入继续通过 `ProjectStorageAdapter.writeJsonAtomically`，仓储不直接调用 Node 文件系统。

## 三、安全与边界

- 领域层只保留仓储端口，不依赖 JSON 或 Node 实现。
- 仓储按项目根目录隔离，不允许将另一个项目的实体写入当前目录。
- 执行记录按任务过滤，但同一项目内使用单一写队列和集合文件。
- 未写入 API Key、Token、模型、价格或其他后台假设。
- 本 PR 不实现删除、Schema 迁移、加密、IPC 或 UI 调用。

## 四、验证结果

- 平台测试：2 个测试文件、10 项测试通过。
- 领域测试：18 项通过；UI 契约测试：11 项通过；完整 `test` 命令共执行 39 项测试。
- 仓储测试覆盖项目清单、七类实体、upsert、项目过滤、跨项目拒绝、并发保存、未知版本、重复 ID、未知状态和错误项目清单。
- TypeScript 与 ESLint：通过。
- TypeScript、ESLint 和生产构建通过；Vite 转换 73 个模块。
- `git diff --check`：通过。

## 五、未完成项

1. Schema 版本迁移和备份策略；
2. SHA-256 文件校验执行器；
3. 文件丢失、只读、损坏和外置存储断开的恢复服务；
4. Electron 受控 IPC；
5. Windows Electron 仓储集成验收；
6. macOS 文件系统语义验证。

## 六、下一步

本 PR 合并后，下一份小 PR 实现 SHA-256 文件校验与恢复状态探测服务；IPC 保持后置，避免在平台能力稳定前扩大渲染进程接口。
