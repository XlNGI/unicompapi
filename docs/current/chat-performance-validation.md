# 会话流式显示性能第一批维护验收

日期：2026-10-08。分支：`feature/chat-performance`。本轮针对负责人反馈的会话卡顿，范围限定在本地 Renderer、preload 和 Electron 日志路径；不调用真实模型、凭证、联网或收费服务，也不新增业务一级页面。

## 项目会话打开优化

项目切换和打开会话新增受控 `fast` 列表模式：首屏列表不等待 response recovery，不为每个会话读取 AgentSession 或校验保留文档，也不通过 IPC 传输非当前会话的消息正文。首次选中会话的详情读取同样支持受控 `readMode: 'fast'`：快速路径返回完整已持久化消息，但不等待 recovery、执行句柄终态、ParentRun/AgentSession 或保留作品校验；界面先显示消息，完整读取和文档恢复在后台补齐。启用 Thread 读取时首屏直接使用 `Thread Item Page`，避免重复读取 Legacy 全量详情。快速路径暂时隐藏未校验的 `retainedDocumentResult`，防止把未核验收据展示为正式作品。发送、取消、恢复、文档登记等默认完整读取行为保持不变。

## 实际修改

- 流式响应事件在 Renderer 端按 `requestAnimationFrame` 合并，同一帧的正文与推理增量只触发一次状态更新；切换会话和卸载时清空旧事件队列。
- 生产事件按帧批量合并，文档轮询在 revision 未变化时不替换会话状态，避免无变化的整页重渲染。
- 会话生产轨迹只通过订阅回放一次历史，移除选中会话后的重复整文件 `list` 读取；测试夹具同步覆盖订阅历史回放语义。
- 生产消息投影使用 `useMemo`，并预建“消息到最近用户消息”的索引，移除每帧的前缀扫描、切片和反转分配。
- 流式 Markdown 阶段先显示轻量纯文本，完成后再走完整 Markdown/GFM 解析；显示刷新间隔从 30ms 调整为 60ms。
- Renderer、preload 和 Electron 主进程日志只在显式设置 `UNICOMP_RENDERER_TRACE=1` 或对应 Vite 变量时输出，避免开发模式逐事件日志放大主线程压力。
- 会话 IPC 新增 `readMode: 'fast'` 受控参数；默认完整读取行为保留，只有项目首屏列表显式使用快速模式。
- 会话详情 IPC 的 `conversationId` 请求增加可选 `readMode`；`ConversationController` 和 Runtime 仅在显式 `fast` 时跳过恢复/投影等待，默认完整读取合同不变。

## 验证结果

- `pnpm typecheck` 通过。
- 全仓 `pnpm lint` 通过。
- 会话相关 Vitest 82/82 通过：`chat-composer-behavior`、`chat-production-timeline`、`streaming-text`；项目会话控制器快速列表回归 8/8 通过。
- 会话控制器与 Runtime 定向测试 27/27 通过，覆盖快速详情不触发 recovery/ParentRun/AgentSession，以及默认完整详情仍触发这些一致性读取。
- 保留作品投影回归 17/17 通过，覆盖快速读取隐藏未校验 `retainedDocumentResult`、完整读取继续执行本地文件/任务/执行记录校验。
- 聊天 UI 合同 26/26 通过：`chat-page-contract`、`chat-document-ui-contract`、`chat-context-ipc-contract`。
- `pnpm build` 通过；保留既有 Vite CJS API 与大 chunk 提示。
- Electron ChatPage 合成验收生产模式 23/23、StrictMode 23/23 通过；渲染错误 0、HTTP(S) 外发 0。

## 边界与后续

本轮验证证明项目打开链路的读取范围和首屏行为收敛正确，不等价于真实用户机器上的稳定 60fps。Electron 验收使用合成 IPC，未覆盖真实服务商响应、完整 AppLayout 和真实项目磁盘规模。后续如需继续优化，应先补 DevTools/真实长会话帧耗时基准，再评估 focus 刷新去重、production trace 的一次性历史订阅和持久化会话摘要索引；不得用未测量结果宣称性能目标已达成。

当前改动尚未提交、推送、合并、部署或重启用户应用。
