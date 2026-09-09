# 聊天页首条消息流式订阅竞态修复与 renderer 诊断打点验收记录

日期：2026-08-18
分支：`feature/chat-renderer-diagnostics`
阶段：9（阶段 10 未启动）

## 现象与结论

新建会话发送首条消息后，回复正文长时间不出现；后端执行事件正常写盘，`content_delta` 在首包后约 2 秒即已持久化。结论为 renderer 侧新建会话清理 effect 误杀了正在进行的流式订阅，不是上游首字延迟。

## 根因

`sendMessage` 在首条消息成功后同时设置新会话 `selectedId` 与 `responseExecution`；`selected?.conversationId` 变化触发的会话切换 effect 无条件调用 `clearResponseDraftState()`，把刚建立的执行清空。流式订阅 effect 因 `responseExecution` 消失立即 cleanup 并调用 preload unsubscribe，后续 `content_delta` 不再投递到 ChatPage。

## 本地复现证据

使用独立 Electron + Vite 探针页挂载 `ChatPage`，注入 mock `chatContexts` 与 `storage`，不调用真实服务商、不读取真实凭据。

修复前日志顺序：

```text
sendMessage:startResponse-ok
effect:conversation-change
clearResponseDraftState
effect:response-subscription-setup
subscribeResponseEvents
effect:response-subscription-cleanup
unsubscribeResponseEvents
renderedContent=正在接收…
```

修复后日志顺序：

```text
sendMessage:startResponse-ok
effect:conversation-change (keepActiveResponse=true)
effect:response-subscription-setup
subscribeResponseEvents
onEvent / flushEvents / terminalEvent
renderedContent=探针回复内容
```

## 改动

- `ChatPage` 会话切换 effect 改为仅当活动执行不属于当前选中会话时才清空 `responseExecution`；新建会话首条消息不再触发误清理。
- `ChatPage` 增加仅开发环境启用的 `rendererTrace` 打点，覆盖发送、会话切换、订阅、事件、flush 与 cleanup。
- `preload` 增加订阅建立、事件到达、重放与 disconnect 打点。
- `main` 在开发环境或 `UNICOMP_RENDERER_TRACE=1` 时把 renderer console 转发到 stdout 与 `userData/logs/renderer-trace.log`。
- `tests/ui/chat-page-contract.test.mjs` 增加防止该竞态回归的源码合同断言。

## 验证

- `pnpm test`：Node/UI 264 项 + Vitest 725 项，共 989 项通过，0 失败、0 跳过。
- `pnpm typecheck`、`pnpm lint`、`pnpm build`、`pnpm audit:platform`、`pnpm verify:handoff`、`git diff --check` 通过。
- 探针复现验证通过：修复前订阅被清理且正文不出现，修复后订阅保持到终态且正文渲染成功。
- 未调用真实服务商、未读取真实凭据、未产生收费请求。

## 边界

- `rendererTrace` 仅开发环境输出；生产运行仍不输出 renderer 日志。若后续需要生产可开关，应增加显式受控 trace IPC，不在 renderer 直接读取本地存储。
- 阶段 10、macOS 实机与媒体工具链、服务商优化边界不变。
