# 文档生成切页与正文布局维护（2026-10-12）

本轮按 `PLANS.md` 顶部维护事实处理用户反馈，修改范围为既有 Response/文档 Tool Session、会话页面、虚拟列表、对应回归与工程记录。验收采用本地 Mock Provider、真实 Office 文件和隔离 Electron，不新增付费请求，不重发原未知或未交付任务。

用户截图与只读持久记录相互印证：原请求的 Response 收到 1101 字符 PPT 大纲后 completed；对应 Document Runtime paused、toolCalls 为空，未发现正式 Work 收据。后续工作流取消记录不能单独证明由切页触发，不据此归因为后台任务被导航取消。

确认的实现问题与修复：

- 应用已校验 ready 的 PPT 工作流仍使用旧 Outline JSON 提示，其中明确禁止工具调用。Agent-native PPT 现在接收同一应用计划及受控工具执行要求，保留普通 Outline 路径。
- 生成工具是否必须执行只检查原 User 措辞，未消费应用确认。Host-only prepare 现在接受 ready Workflow，校验项目、会话及已完成来源消息不晚于当前回复，再将已批准的 create/PPT 固定为必须生成；同一 Root 的连续澄清可沿用原需求。新建不提供修改旧作品的替代工具。普通讨论和未确认意图的既有用例保留。结算从绑定同一 execution 的持久 Workflow 保留此要求，重建 Service 后也不会退回重新猜措辞。
- 页面显示依赖组件内 documentResponseActive。现在依据已持久化的来源说明和文档结构识别正文草稿，复用既有安全正文投影。只收到大纲时显示“文档内容已接收，尚未生成可交付文件”，不得把模型回复完成记成文件交付。普通 JSON 消息保持原显示。
- 本地 Office 的 validating_outline/generating_file 状态在切页返回后恢复原消息的生成控制，并通过既有有限轮询读取终态。停止请求绑定原会话/消息，不重发 generateFromMessage，也不因为页面挂载调用中断恢复；Word、Excel、PPT 均有回归。
- 虚拟列表绝对定位曾忽略 CSS 消息间距；现在偏移与总高度包含 24px 间距，测量使用 border box。浮动输入框的留白按实际高度更新，并在跟随输出时同步滚动。真实 Electron 曾复现留白更新后滚动落后，修正后最后一条消息与加高输入框之间保持约 24px。

新增离线验收覆盖应用确认不含“立即”的请求、既有 PPT 的新建约束、错误来源拒绝、模型忽略工具后的未交付结算、Service 重建后必须执行事实、渲染期连续读取不改任务/不重复执行、组件切页恢复和普通 JSON 对照。

中间全量曾发现连续澄清的来源校验过严，已修复并复核；随后全量 3485 项中 3482 项通过、3 个新增夹具仍期待“停止生成”，实际本地生成的正确按钮为“停止文档生成”。修正夹具后 ChatPage 整文件 61/61，通过原消息调用 cancelGeneration，未触发生成或中断。原失败日志保留；最终完整相关回归重新执行，不把中间全量报告改写为全部通过。

`pnpm exec electron scripts/verify-agent-provider-mock-electron.cjs --ui-navigation` 加载真实 ChatPage、preload、IPC 和 Tool Runtime，使用临时项目/profile 与进程内 Provider 替身；通过有界暂停本地执行制造切页窗口。三次卸载/返回期间均为 Response streaming / Parent executing_tool，停止按钮恢复；释放后完成物理 PPT、唯一 Work 与页面正式收据。另用 15 节长草稿、180px 输入区验证正文、状态、消息间距与遮挡。该合成用例不等同于新增真实 Provider 验收。

原用户任务仍按已持久证据保留，不自动补生成、不伪造收据。后台改动需要新启动的主进程加载；本轮未主动关闭或重启用户运行中的应用。macOS 实机及真实 Provider 切页矩阵未运行。最终检查结果见 [机器证据](../evidence/document-navigation-maintenance-20261012.json)。
