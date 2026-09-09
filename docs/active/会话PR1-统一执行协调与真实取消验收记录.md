# 会话执行协调与媒体体验修复验收记录

日期：2026-08-17

集成分支：`feature/daily-changes-2026-08-17`

## 范围

本记录覆盖 2026-08-17 合入 `develop` 前的工程改动：会话执行协调、真实取消、活动执行拦截、受控流事件推送与本地恢复屏障；作品库视频 Range 预览和应用内全屏；Vidu 结果下载独立超时；以及此前已单独合入的 Vidu 失败结果重新接收修复。

本次没有新增业务一级页面，没有恢复已冻结的批量创作能力，没有加入登录、会员、充值或云同步，也没有发起真实服务商收费请求。

## 实际修改

- 新增 `ConversationExecutionCoordinator`，按 `responseExecutionId` 持有活动 provider operation 的取消句柄与 completion，并保证取消和完成并发时只收口一次。
- DeepSeek、NewAPI 与 UniCompAPI 共用文本 dispatch 在 adapter 返回 operation handle 后注册协调器；注册失败时尽力取消已启动 operation。
- 新增受控 `cancelResponseExecution` IPC。主进程校验当前项目、会话和 execution 归属，调用真实 adapter `cancel()`，等待 completion 后再返回持久化终态。
- 新增同会话活动 execution 查询与服务端并发拦截，页面不再通过乐观修改 assistant message 或 execution 伪造 `cancelled`。
- 新增主进程到 preload/renderer 的受控响应事件订阅、序号确认、断线重放和有界背压；聊天页移除 200ms 全量轮询，按事件幂等更新正文、推理、Usage 与终态。
- 文本执行终态统一回写 Submission Intent、Provider Invocation 与项目级 Usage；本地启动恢复屏障会中断缺少内存 adapter 的遗留 `pending`/`streaming` execution，但不伪造远端完成或自动重提。
- 修复失败事件与消息投影竞态，并补齐会话归档、归档列表加载和恢复入口。
- `unicomp-media` 响应支持单段 HTTP Byte Range，正确返回 `206`、`Content-Range`、`Accept-Ranges` 与不可满足范围的 `416`，用于视频播放和拖动定位。
- 作品库视频预览使用应用内全屏覆盖层，支持 Escape 退出并锁定页面滚动，同时隐藏当前不可用的 Chromium 原生全屏按钮。
- Vidu 普通 API 请求超时保持原策略，结果媒体下载改用独立的 5 分钟默认超时。
- Vidu 失败下载的“重新接收结果”复用原任务、execution、remote operation 与协议绑定，不重新提交生成。

## 验证结果

- `pnpm test`：Node/UI 260 项与 Vitest 704 项，共 964 项通过，0 失败、0 跳过。
- 真实 FFmpeg 媒体套件包含在全量结果中；`.tools/` 仅通过本地目录联接使用，未进入 Git。
- `pnpm typecheck`、`pnpm lint`、`pnpm build`：通过。
- `pnpm audit:platform`：扫描 332 个文件，0 违规。
- `pnpm verify:handoff`：50 项校验通过。
- `git diff --check`：通过。
- 未访问真实服务商 HTTP/DNS，未读取真实凭证，未产生收费请求。

## 未完成边界

- PR2 的完整跨实体补偿与崩溃窗口收口尚未完成。
- PR3 仅完成本地启动恢复屏障，远端 operation 的持久化重绑与继续查询仍未完成。
- PR5 存储迁移、PR6 SSE 故障矩阵、PR7 重试与预算、PR8 数据治理仍需独立实施和验收。
- macOS 实机与媒体工具链继续保持 `required=false`、`not_run/deferred`，不声明已支持。
- 阶段 10 的安装包、签名、公证、生产更新、生产媒体组件分发、SBOM 和发布准入未启动。
