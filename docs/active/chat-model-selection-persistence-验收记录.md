# 聊天页模型选择持久化与不可用清空验收记录

日期：2026-08-18
分支：`feature/chat-model-selection-persistence`
阶段：9（阶段 10 未启动）

## 需求

模型选择后保持不变，除非模型不可用。切换页面、重新进入聊天页后仍保留上次选择；候选消失或变为不可用时清空选择，不保留导致发送按钮卡住的不可用模型。

## 改动

- `App` 新增 `selectedChatCandidateId` 状态，跨页面切换保持聊天模型选择。
- `ChatPage` 新增 `initialCandidateId` 与 `onCandidateChange` 受控入口，页面内选择变化同步到 `App`。
- 候选刷新时仅保留仍存在且 `available` 的模型；不可用或已移除时清空选择。
- `tests/ui/chat-page-contract.test.mjs` 增加状态提升与不可用清空的合同断言。

## 验证

- `pnpm test`：Node/UI 264 项 + Vitest 725 项，共 989 项通过，0 失败、0 跳过。
- `pnpm typecheck`、`pnpm lint`、`pnpm build`、`pnpm audit:platform`、`pnpm verify:handoff`、`git diff --check` 通过。
- 未调用真实服务商、未读取真实凭据、未产生收费请求。

## 边界

- 当前为应用内会话保持，不跨应用重启持久化；如需重启后恢复，应走主进程受控设置存储，不在 renderer 使用本地存储。
- 阶段 10、macOS 实机与媒体工具链、服务商优化边界不变。
