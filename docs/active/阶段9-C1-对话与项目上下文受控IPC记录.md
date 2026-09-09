# 阶段 9 C1｜对话与项目上下文受控 IPC 工程记录

日期：2026-07-28

分支：`feature/chat-context-ipc`

基线：`develop@9df9ce0`

状态：第三批实现与工程门禁已完成，等待项目负责人验收；未经批准不得合并 `develop`

## 一、批准边界

项目负责人批准在第一批 Conversation/Message 领域与本地仓储、第二批 ProjectContext 登记均合并后启动第三批。本分支只实现非 UI 应用服务、共享 IPC 契约、主进程控制器、preload 白名单和 Electron 组合根接线。

本分支未修改 React 页面，未实现 Vidu 或其他供应商 HTTP 适配器，未实现新的原生附件导入，未创建图片/视频 Task、Execution 或 Work，未把对话页恢复为直接生成入口，也未修改第一、第二批冻结的领域状态机、Schema 或仓储语义。

## 二、实际修改

- 新增 `ConversationApplicationService`，通过第一批 ConversationRepository 完成创建、读取、列表、重命名、归档、恢复、软删除和纯文本用户消息保存；
- Conversation 创建使用显式 `bindToCurrentProject`，绑定目标只能由主进程当前受控 Project Session 派生；未打开项目时只允许创建未绑定纯文本 Conversation；
- renderer 消息写入接口不接收附件、文件位置或原始附件内容；本分支不新增任意文件选择或附件登记流程；
- 新增供应商无关 `ConversationStreamApplicationPort` 与 `ConversationStreamingService`，提供 start、append、complete、fail、cancel 受控状态转换；流式片段只能由主进程应用服务按 Conversation/Message revision 写入；
- 当前没有真实对话适配器，`requestAssistantResponse` 在校验 Conversation 与 revision 后稳定返回 `adapter_unavailable`，不创建 assistant Message，不制造流式片段、进度、费用、成功或 completed 状态；
- 新增共享 `chat-context` IPC 契约，覆盖 Conversation/Message DTO，以及 ProjectContext 草稿、预览、片段、标签、登记、更新、删除、候选、详情、历史 revision 和来源状态 DTO；
- 所有请求执行严格对象形状、受控 ID、整数 revision、文本长度、标签数量和布尔值运行时校验；多余字段、路径式 ID 和缺失字段均返回稳定 `invalid_request`；
- IPC 结果使用稳定错误码，revision 冲突可返回安全的当前 revision；错误响应不返回内部堆栈、仓储位置或原始异常；
- Conversation DTO 只返回业务字段和已登记附件的 AssetId/FileReferenceId；不返回绝对路径、Hash、凭证、endpoint、远端 operation ID 或内部文件系统身份；
- 新增 `ConversationController`，renderer 只能调用命名操作，不能直接写 Conversation 仓储，也不能直接追加、完成或失败流式消息；
- 新增 `ProjectContextController`，所有 ProjectContext 操作从主进程当前 Session 派生项目范围，renderer 不传 projectId 或项目位置；未打开项目返回 `project_not_open`，其他项目的 draft/context ID 在当前项目仓储中失败关闭；
- 保存 Conversation 与登记 ProjectContext 保持两个独立调用；创建草稿不等于登记，登记必须显式 `confirmed: true`；查询上下文不构成模型外发授权；
- ProjectContext 控制器在进入第二批服务前显式核对当前 revision，将过期请求稳定映射为 `revision_conflict`，不改变第二批领域和仓储语义；
- 新增纯平台 `createChatContextRuntime` 组合根：应用级 Conversation JSON 位于 Electron userData，ProjectContext 仓储只根据当前受控项目根目录创建并按 Session 缓存；不建立 renderer 仓储或第二套 Conversation 仓储；
- 新增 Electron `chat-context-ipc` 注册器，全部 channel 固定在共享白名单，`ipcMain.handle` 只向对应控制器传递 unknown 请求并由运行时校验；
- preload 新增 `chatContexts` 命名 API，不暴露通用 ipcRenderer、自定义 channel、Node 文件系统、进程或 Electron 原生能力；
- 项目切换、关闭和应用退出会等待对话/上下文受控操作完成，避免原子写入尚未结束时切换项目或终止主进程；
- React 页面和最终 UI 交接包原件均未修改。

## 三、自动化测试与验证

新增 12 项 Node/Vitest 测试，覆盖：

- IPC channel、handler 和 preload 方法白名单；
- preload 不暴露通用 Electron/Node 能力；
- renderer DTO 与共享契约敏感字段扫描；
- 严格请求校验、多余字段和路径式输入拒绝；
- 未打开项目和显式 Conversation 项目绑定；
- Conversation revision 冲突；
- `adapter_unavailable` 不创建或完成 assistant Message；
- 流式 pending、streaming、completed 事实只能通过应用服务写入；
- 未保存 Conversation 拒绝；
- non-completed Message 和跨 Conversation 片段拒绝；
- ProjectContext draft/context revision 冲突；
- 其他项目 Session 访问拒绝；
- 同一 Conversation 多消息片段登记；
- 来源 Conversation 软删除后登记快照继续可读，并可刷新为 `source_deleted`；
- 应用级 Conversation 文件与项目级 ProjectContext 文件的组合根分离；
- 控制器返回值不包含 userData 或项目根路径。

完整工程验证结果：

- Node UI/IPC/工具链测试：150 项通过；
- Vitest 领域与平台测试：319 项通过；
- 合计：469 项通过，0 失败，0 跳过；
- `npm.cmd run typecheck` 通过；
- `npm.cmd run lint` 通过；
- `npm.cmd run build` 通过；
- `git diff --check` 通过；
- 真实 FFmpeg 集成测试在完整测试中执行并通过；
- Windows Electron 生产构建启动烟测新增 4 个 Electron 进程，4/4 保持响应；测试结束后本次新增进程残留 0。

## 四、未完成项和阻断项

- 没有真实 LLM、Vidu、供应商或 HTTP 适配器；`adapter_unavailable` 是当前唯一诚实的生成请求结果；
- 没有 React 对话页、上下文预览/确认页或创作工作区 UI 接线；
- 没有新的原生附件选择、任意文件导入、附件登记或内容解析；当前 renderer 写消息接口不接受附件；
- 已登记 AssetId/FileReferenceId 的安全展示与原生选择接线需另建批准的小 PR；
- `readProjectContext` 与 `readSavedProjectChats` 在创作页面的候选隐藏/人工选择 UI 语义尚未接线；本分支没有自动读取或自动外发；
- 没有供应商提交前确认、内容外发、价格、模型、费用或进度事实；
- 没有物理清理、Conversation 级联删除 ProjectContext 或高风险影响计划；
- 阶段 9 既有 Windows 人工项、macOS 实机和跨平台完整验收缺口保持不变。

## 五、下一步

1. 项目负责人审核 `feature/chat-context-ipc` 的实现提交和本记录；
2. 未经负责人明确批准，不合并 `develop`；
3. 验收通过后按非快进方式合并并在合并后的 `develop` 重跑完整门禁与 Electron 烟测；
4. React UI 接线必须另建独立小分支，并遵守最终 UI 冻结边界；
5. 真实供应商适配器、原生附件选择和内容解析分别另行审批，不在本分支追加。
