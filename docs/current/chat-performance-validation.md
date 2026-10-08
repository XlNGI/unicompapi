# 会话流式显示性能第一批维护验收

日期：2026-10-08。分支：`feature/chat-performance`。本轮针对负责人反馈的会话卡顿，范围限定在本地 Renderer、preload 和 Electron 日志路径；不调用真实模型、凭证、联网或收费服务，也不新增业务一级页面。

## 项目会话打开优化

项目切换和打开会话新增受控 `fast` 列表模式：首屏列表不等待 response recovery，不为每个会话读取 AgentSession 或校验保留文档，也不通过 IPC 传输非当前会话的消息正文。选中的会话随后单独调用 `getConversation`，完成恢复、文档校验和完整消息加载；加载期间显示明确的读取状态。文档中断任务核对在选中会话详情加载完成后有界并行执行，上下文候选改为后台读取，不再延迟首屏完成。

## 实际修改

- 流式响应事件在 Renderer 端按 `requestAnimationFrame` 合并，同一帧的正文与推理增量只触发一次状态更新；切换会话和卸载时清空旧事件队列。
- 生产事件按帧批量合并，文档轮询在 revision 未变化时不替换会话状态，避免无变化的整页重渲染。
- 会话生产轨迹只通过订阅回放一次历史，移除选中会话后的重复整文件 `list` 读取；测试夹具同步覆盖订阅历史回放语义。
- 生产消息投影使用 `useMemo`，并预建“消息到最近用户消息”的索引，移除每帧的前缀扫描、切片和反转分配。
- 流式 Markdown 阶段先显示轻量纯文本，完成后再走完整 Markdown/GFM 解析；显示刷新间隔从 30ms 调整为 60ms。
- Renderer、preload 和 Electron 主进程日志只在显式设置 `UNICOMP_RENDERER_TRACE=1` 或对应 Vite 变量时输出，避免开发模式逐事件日志放大主线程压力。
- 会话 IPC 新增 `readMode: 'fast'` 受控参数；默认完整读取行为保留，只有项目首屏列表显式使用快速模式。

## 验证结果

- `pnpm typecheck` 通过。
- 全仓 `pnpm lint` 通过。
- 会话相关 Vitest 82/82 通过：`chat-composer-behavior`、`chat-production-timeline`、`streaming-text`；项目会话控制器快速列表回归 8/8 通过。
- 聊天 UI 合同 26/26 通过：`chat-page-contract`、`chat-document-ui-contract`、`chat-context-ipc-contract`。
- `pnpm build` 通过；保留既有 Vite CJS API 与大 chunk 提示。
- Electron ChatPage 合成验收生产模式 23/23、StrictMode 23/23 通过；渲染错误 0、HTTP(S) 外发 0。

## 边界与后续

本轮验证证明项目打开链路的读取范围和首屏行为收敛正确，不等价于真实用户机器上的稳定 60fps。Electron 验收使用合成 IPC，未覆盖真实服务商响应、完整 AppLayout 和真实项目磁盘规模。后续如需继续优化，应先补 DevTools/真实长会话帧耗时基准，再评估 focus 刷新去重、production trace 的一次性历史订阅和持久化会话摘要索引；不得用未测量结果宣称性能目标已达成。

当前改动尚未提交、推送、合并、部署或重启用户应用。
