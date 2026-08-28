# 生成历史与任务中心性能优化 PR4｜生成历史分页记录

日期：2026-08-28

分支：`feature/generation-history-pagination`

## 实际修改

- 新增 `listGenerationHistory(projectId, draftId, mediaKind, cursor, limit)` 受控 IPC；主进程只读取目标项目的 Tasks、Executions、Works 与 FileReferences 快照，在主进程完成草稿关系、执行完成、文件可用和校验时间过滤。
- 首屏默认返回最近 20 个作品/状态节点，使用时间、节点类型与实体 ID 组成的稳定不透明游标加载更早记录；renderer 首屏仅发 1 次元数据 IPC。
- 删除生成历史的全局 Task/Work 扫描、逐 Task/Work 详情读取和整页媒体句柄预创建。
- 历史图片使用 `loading="lazy"` 与 `decoding="async"`；视频缩略项默认 `preload="none"`，进入视口或选中后才获得受控 `src`。
- 媒体句柄请求可携带 `projectId` 并校验 Work 归属；同一项目 Work 的有效句柄由主进程复用，应用清理时一并撤销。

## 验收结果

- 合成 2 项目、目标项目 25 个同草稿作品：第一页 20 条、第二页 5 条、无重复；只读取目标项目 4 类事实文件且各 1 次，其他项目读取为 0。
- 伪造项目范围不返回其他项目媒体；同一 Work 句柄复用，文件缺失和句柄过期继续失败关闭。
- 独立性能门禁 3/3、平台定向 7/7、相关 UI 合同 28/28、TypeScript、完整 ESLint 与差异检查通过；完整测试与构建在提交前执行。
- 未调用真实服务商、未读取凭证、未产生收费请求；未启动阶段 10 或 macOS 实机工作。

## 未完成项与下一步

按方案进入 PR5 条件判断：只有 PR1—PR4 后的合成/当前 Windows 测量仍未达目标，才允许新增可重建磁盘索引或缩略图缓存；否则明确跳过并直接进入 PR6 收口。
