# 会话 PR2｜停止后编辑重发验收记录

日期：2026-08-18

开发分支：`feature/chat-stop-edit-resend`

## 阶段与范围

本次是在阶段 9 已正式收口、阶段 10 未启动边界内，经项目负责人明确批准实施的会话功能增量。改动只覆盖现有纯文本对话的“停止生成后编辑上一条输入并重新发送”，不新增暂停/继续状态，不新增业务一级页面，也不涉及安装包、签名、公证、生产更新、媒体组件分发或真实服务商预算调用。

权威依据保持为最终 UI 与开发交接包 V1.2.1、项目级 `AGENTS.md`、`PLANS.md` 和 `docs/active/会话功能企业级修复计划.md`；本记录仅新增工程侧说明，不修改或覆盖权威原件。

## 最终交互语义

- 页面只提供“停止生成”，用户点击后由主进程向真实 provider operation 发出取消请求，并等待后台确认终态；确认前显示“正在停止”，不得由 renderer 乐观伪造 `cancelled`。
- 后台确认取消后，在输入框没有未发送草稿时自动恢复对应的原用户输入；已有未发送草稿时不覆盖。
- 允许稍后通过该用户消息旁的编辑按钮重新进入编辑状态，也可通过取消编辑按钮退出。
- 只有最后一个用户回合且其后的全部 assistant 尝试均为 `cancelled` 时才允许编辑；其他消息、完成回复、失败回复或仍在执行的回复不可编辑。
- 重新发送会创建新的 Response Draft、`responseExecutionId`、Provider Invocation Attempt 和 SSE 流式请求，不存在“继续原 SSE”的暂停/恢复语义。

## 数据一致性

- 用户消息采用原位修订：保持 `messageId` 不变，更新内容并递增 message revision 与 conversation revision。
- 旧 execution、invocation、usage/cache 观测和原始 outbound snapshot 保持不变，继续记录当时真实发送的旧文本，不回写历史审计事实。
- 已取消的 assistant 片段继续保存在会话内用于本地历史和审计，但新的 outbound context 会排除所有 `cancelled` assistant 尝试。
- 新请求只使用修订后的用户文本；不会同时发送旧用户文本，也不会把已取消片段当作有效上下文。
- 本功能不自行判断或承诺 LLM 缓存命中。上游是否命中缓存由服务商按模型、规范化提示词前缀及其缓存策略决定，本地仅保存服务商实际返回的 usage/cache 观测。

## 实际修改

- 领域层新增停止后编辑转换，集中校验会话状态、消息角色、消息终态和后续取消链，并递增消息与会话修订号。
- 应用层新增 `editCancelledUserMessage` 用例和 `message_not_editable` 安全错误映射。
- 共享 IPC、主进程 controller/runtime、Electron IPC 注册和 preload 新增受控编辑命令，继续执行严格字段解析、项目归属、只读状态和 revision conflict 校验。
- 聊天页新增取消确认后的输入恢复、编辑/取消编辑状态和图标按钮；切换会话、新建会话、删除会话时同步清理编辑状态。
- 重发流程复用修订后的 user message，新建回复草稿与 execution，并继续使用既有受控 SSE 订阅、真实取消和终态协调链路。
- 增加领域、controller、artifact factory、IPC 合同与 UI 合同测试，覆盖不可提前编辑、取消后可编辑、修订递增、非法额外字段拒绝，以及新请求只包含修订后文本。

## 验证结果

- 聚焦 Vitest：18 项通过。
- 聚焦 Node/UI 合同：8 项通过。
- `npm.cmd test`：全量通过；Vitest 130 个文件、717 项通过，0 失败。
- `npm.cmd run typecheck`：通过。
- `npm.cmd run lint`：通过。
- `npm.cmd run build`：通过；仅保留既有 Vite chunk size 警告。
- `npm.cmd run audit:platform`：扫描 337 个文件，0 违规。
- `npm.cmd run verify:handoff`：50 个 checksum 条目、27 个 manifest 资产，0 失败。
- `git diff --check`：通过。
- 页面实测：深色与浅色主题均在 `1280×720` 检查，输入区、工具栏和按钮无横向溢出、遮挡或布局跳动。
- 未访问真实服务商 HTTP/DNS，未读取真实凭证，未产生收费请求。

## 未完成边界

- 本次不实现暂停/继续生成；所谓“继续”应理解为用户确认修订后发起全新的请求和 SSE 流。
- 服务商缓存键、缓存窗口和命中策略不由 UniComp 强制控制；只有服务商返回观测时才展示或持久化相关用量事实。
- macOS 实机与媒体工具链继续保持 `required=false`、`not_run/deferred`，不声明已支持。
- 阶段 10 仍未启动；本增量不改变阶段 9 已正式收口的发布边界。
