# Office Agent Thread-first 与模型适配统一达成计划

日期：2026-10-11

## 目标和边界

目标是让新 Thread 架构成为可正常使用的生产会话架构，同时保留 develop 已验证的 Agent Runtime、Provider Tool Calling、Document Runtime 和 Work 安全门禁，并完成既有模型能力、计费、参数和路由计划的统一接线。

最终主链路：

```text
用户输入
→ Thread Turn/User Item
→ 唯一 Turn Coordinator
→ Agent Runtime / Agent Run
→ Response Execution / Canonical Tool Contract
→ Provider Adapter
→ Document Runtime / Work
→ Thread Tool、Assistant、Artifact Item Projection
→ Summary/Page/VirtualMessageList
```

明确不做：不建立第二套 Agent Runtime；不重写 Provider Tool Loop；不让 Workflow、Legacy Conversation 或 ChatPage 直接拥有文档副作用写入权；不按模型名称猜能力；不在完成迁移和回滚门禁前切换真实用户数据的 Thread authority。

## 当前事实

- `src` 约 196,605 行，`electron` 约 5,621 行，测试约 99,794 行，文档和脚本约 32,500 行。总量包含大量测试、历史证据和兼容实现，不能直接按总行数删除。
- Thread/Turn/Item、ThreadFile Repository、迁移、Summary/Page、Store、VirtualMessageList、Shadow Projection 已存在，但 Thread 写入和读取仍由环境变量控制，Legacy 仍是默认生产会话权威。
- `ConversationResponseController`、`ConversationAgentRuntimeService`、Response Execution、Provider Tool Calling、Document Tool Bridge、Document Task Runtime 和 Work/File/Hash 门禁是成熟能力，应保留。
- `ConversationWorkflowService` 目前同时承担计划、确认、多交付状态和执行编排；`ChatPage` 仍可通过 `executeReadyWorkflow` 触发独立文档生成，Agent Native 也可通过 `generate_pptx` 触发同一副作用。这是重复 Work 的主要来源。
- 模型适配计划已经建立 Provider Registry、Capability Evidence、Feature Contract、Parameter Schema、Route Snapshot 和部分独立 Provider/协议适配，但历史实施、回退和新能力接线并存，必须统一为一套能力真源。

## 架构权威和取舍

| 领域 | 最终权威 | 保留 | 退出 |
|---|---|---|---|
| 会话数据 | Thread/Turn/Item | Legacy 只读迁移适配 | Legacy 新消息写入 |
| 执行状态 | Agent Runtime/Response Execution | Agent Run、预算、租约、取消、恢复 | Workflow 自己启动 Provider |
| 文档状态 | Document Task Runtime/Work/File | 渲染、校验、Hash、原子发布、登记 | UI 直接判断文件存在即成功 |
| 计划和确认 | Workflow 计划状态 | 澄清、确认、多交付顺序、失败原因 | Workflow 独立副作用执行循环 |
| 模型能力 | Capability Evidence + Feature Contract | Provider Registry、Parameter Schema、Route Snapshot | 名称猜测、页面各自过滤 |
| UI 读取 | Thread Summary/Item Page | Legacy fallback、虚拟列表、RAF 流式 | 默认 Legacy 全量读取 |

关键规则：一个 User Item 只能绑定一个 Turn、一个主 Agent Run、一个 Response Execution；一个文档 delivery 只能登记一个正式 Work。已有正式 Work 只能读回、校验或结算，不能再次调用 `generate_pptx`。

## 两条主线

### 主线 A：Thread-first 会话收敛

#### A0：建立依赖和权威矩阵

目标：列出所有会话写入、读取、执行启动、文档启动和状态投影调用方。

复用：现有 Thread contracts、ThreadCommandService、ThreadProjectionCoordinator、ConversationResponseController、Workflow Service。

需要检查的文件：

- `src/pages/chat/ChatPage.tsx`
- `src/platform/ipc/chat-context-runtime.ts`
- `src/platform/ipc/conversation-response-controller.ts`
- `src/platform/ipc/conversation-workflow-controller.ts`
- `src/application/conversation-workflow-service.ts`
- `src/platform/documents/conversation-document-tool-session.ts`
- `src/application/document-generation-service.ts`

完成标准：每个副作用入口只有一个 owner；所有 Legacy 调用方都有迁移目标；没有继续新增 Legacy 功能。

#### A1：唯一 Turn Coordinator

新增最小 Application 协调器，职责只有：

- 接受 User Turn 和 `clientCommandId`；
- 将 Workflow 计划绑定到 Turn；
- 调用现有 Agent Runtime/Response Execution；
- 处理幂等、项目范围和取消；
- 不执行 Provider、不执行文档、不写 Work。

迁移：`startAgentResponse`、`startWorkflow`、`answerWorkflow` 统一转入 Coordinator；`executeReadyWorkflow` 改为 Coordinator 命令适配，不再直接启动文档生成。

验收：同一 Turn 重复提交返回同一执行身份；不同 Turn 才能启动新执行；失败上限只进入 failed/needs_reconciliation，不自动创建第二个副作用执行。

#### A2：新会话 Thread-first 写入和读取

目标：新建会话和新消息默认写 Thread；ChatPage 默认读取 Summary/Page；Legacy 只作为尚未迁移会话的只读 fallback。

复用：`ThreadFileRepository`、`ThreadCommandService`、`ThreadProjectionCoordinator`、`ThreadSummaryStore`、`ThreadItemStore`、`VirtualMessageList`。

需要修改：

- `src/pages/chat/ChatPage.tsx`
- `src/platform/ipc/chat-context-runtime.ts`
- `electron/ipc/chat-context-ipc.ts`
- `electron/preload.ts`
- `src/shared/chat-context-ipc.ts`

兼容：旧会话仍可通过 Legacy Read Adapter 显示；不做无日志双写。每个会话保存 `storageAuthority: thread | legacy_readonly` 或等价明确状态，禁止请求级混用两个写权威。

验收：新会话首屏只读 Summary/Page；消息、Tool、Artifact 都能在 Thread 中恢复；A→B→A 项目切换无串数据；关闭 Thread flag 只能用于旧会话回滚，不改变新会话已记录的 Thread 数据。

#### A3：Execution/Tool/Work Projection 完整接线

目标：将 Agent Run、Response Execution、Tool Call、Observation、Document Work 投影为 Thread Item，投影失败只产生 projection debt，不重发副作用。

复用：现有 `ThreadProjectionCoordinator` 和 Document/Agent 事实；不重复实现 Provider Loop。

验收：普通 Agent、生成 PPT、Tool 失败、取消、未知结果、重启后，Thread 时间线与 Runtime/Work 事实一致；一个 delivery 最多一个 Work。

#### A4：Legacy 退出

条件：新会话 Thread-first 连续通过；历史迁移 Shadow Compare 通过；Agent/Document/Work 全部有 Thread projection；回滚可用。

动作：停止 Legacy 新写入，保留只读迁移适配；迁移完成后删除旧执行入口、重复 DTO 和仅服务 Legacy 的 UI 刷新代码。删除前必须保留源分支、备份和只读回滚版本。

### 主线 B：模型适配和能力真源

#### B0：能力模型冻结

统一结构：

```text
Provider Connection
→ Protocol Adapter
→ Model Identity
→ Capability Evidence
→ Feature Contract
→ Parameter Schema
→ Route Snapshot
```

规则：

- 连接适配器能力不等于具体模型能力；
- 输入模态不等于输出能力；
- 不按名称猜图片、视频、联网或 Tool Calling 能力；
- 目录/详情/用户确认/精确内置映射是证据来源；
- 网络失败不改写成“不支持”；
- 能力版本和凭证/连接版本绑定；
- 候选查询只读，不隐式修改注册表。

#### B1：协议适配器收敛

优先顺序：

1. OpenAI-compatible/NewAPI 文本和 Tool Calling；
2. DeepSeek/Kimi 等已有独立协议；
3. 图片、视频、异步 predictions；
4. 原生联网搜索。

每种协议只有一个 Adapter，模型差异进入 Capability Evidence/Parameter Schema，不复制整套 Provider Loop。

验收：同一 Feature Contract 在不同 Provider Adapter 上输出一致的 Host DTO；参数、费用、隐私、地区未知时保持 unknown；不可用候选在 Host 阻断。

#### B2：模型选择与提交统一

ChatPage、图片页、视频页和文档 Agent 都从同一 Candidate Source 获取候选；保存 `candidateId + productFeature + project/connection revision`；提交前重新解析 Route Snapshot 和 Capability Evidence；不静默换模型。

验收：候选显示、提交、重启恢复、参数 Schema、费用读模型使用同一能力结果；旧候选不会覆盖新草稿；读取失败、成功空列表和未知能力分别展示。

#### B3：模型能力计划的实施边界

保留此前模型能力/计费/参数计划中已验证的注册表、证据、参数缓冲和候选状态修复；暂不把未取得真实协议证据的图片编辑、多图、视频和异步模型标为已支持。真实 Provider 适配必须单独记录凭证范围、费用和实际请求证据。

## 数据迁移和回滚

1. 新会话先 Thread-first；旧会话仍 Legacy 只读。
2. 使用 Migration Ledger、Commit Journal、Manifest、Snapshot 和 Shadow Comparator 迁移历史。
3. 对账消息、附件、reasoning、状态、Tool/Observation、Execution、Agent Run、Document、Work、Hash。
4. Cutover 前要求 active unknown 为零或明确冻结、projection debt 可恢复、备份可读、回滚演练通过。
5. 回滚以会话 authority 为单位，不删除 Thread 数据，不回写覆盖 Legacy 源文件。

## 代码瘦身策略

不以删除测试和文档制造虚假瘦身。按以下顺序减少运行时代码：

1. 删除 Workflow/Agent 两个副作用入口之一；
2. 删除 ChatPage 对 Legacy 全量读取和重复轮询；
3. 删除 Legacy 新写入和重复 Conversation DTO 投影；
4. 合并 Provider Candidate/Capability 的重复判断；
5. 迁移完成后删除只服务 Legacy 的 Controller、Store 和兼容分支；
6. 测试按唯一权威重组：Thread 合同、Runtime 合同、Provider Adapter 合同、Electron E2E，不再为重复入口复制整套测试。

## 阶段门禁和关键路径

阶段顺序：`A0 → A1 → A2 → A3 → B0/B1 → B2 → Migration → A4`。

可并行：B0/B1 能力模型与 A2 Thread Query/Store；B2 必须依赖 B0；A3 必须依赖 A1/A2；A4 必须等 Migration 和真实 E2E 完成。

每阶段门禁：

- `pnpm typecheck`
- `pnpm lint`
- `pnpm build`
- Thread/Runtime/Provider 定向测试
- Electron production/StrictMode
- 失败、取消、未知结果、重启和项目隔离
- `git diff --check`

不把 Mock Provider 当作真实 Provider 验收；不把一次 PPT 成功当作完整模型适配验收；不在未批准前切换生产存储权威。

## 当前明确结论

- 主开发方向从 Legacy 性能修补转为 A1/A2：唯一 Turn Coordinator + Thread-first 新会话。
- Agent Runtime、Document Runtime 和模型能力计划是集成基础，不重新实现。
- Workflow 保留计划语义，退出独立执行权。
- Legacy 保留只读迁移能力，停止新增业务逻辑。
- 代码瘦身通过删除重复权威实现，不通过删除安全门禁、测试证据或历史数据。
