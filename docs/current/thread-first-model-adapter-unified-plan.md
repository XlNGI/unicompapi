# Office Agent Thread-first 与模型适配统一达成计划

日期：2026-10-11

## 2026-10-12 目标调整：先核对官方模型合同，再实施中转兼容层

负责人本轮明确目标：应用已支持模型先完成与官方 API 一致的版本化合同；中转模型显式绑定合同即可接入，使用时由 Schema 校验参数、适配器消费校验结果，前端继续动态显示。负责人同时要求参数兼容层，并已确认本轮包含代码实现。随后补充“先将 unicomp 所支持的模型合同完成，确保合同和官方一致”，因此官方合同核对优先于兼容层生产接线。本节补充并调整下方主线 B，不重开已验收的历史阶段。

当前实施分支 `feature/model-contract-compatibility` 从 `develop@4e0aee4` 建立，已合入原维护分支 `72f55c9` 保留会话及模型维护成果；合并基线 `8ee2a43`，两侧独立工程记录与 ProjectSession 回归均保留，整合回归 13/13。负责人后续明确要求“完成后上传新增代码到仓库”，覆盖此前本轮不推送的边界：完成本轮目标及验收后，提交相关代码、测试与工程说明并推送 `origin/feature/model-contract-compatibility`，保留本地和远程分支，不再重复询问上传许可。上传授权不包括合入 develop/main、正式发布、重启用户应用或操作真实配置/项目数据；目标未完成前不将当前基础代码作为完成成果上传。

核对范围按 UniComp 应用全部已接入模型处理。负责人已明确授权读取公开资料；本轮只读取公开文档/Schema，来源 URL、取得时间、Hash 和不可用状态保存在 `docs/evidence/model-contract-sources-20261012.json`。凭证读取、真实生成、收费探测和自动重试均为 0。

截至 2026-10-13，官方目录包含 26 个版本化合同记录和 27 个精确模型键来源候选；本地发布清单仍有 48 份 Schema、53 条静态精确模型记录。负责人已明确将旧版 DeepSeek、Vidu 图片别名、旧版 Qwen、`kling-v3-turbo`、HappyHorse 1.0/1.1 以及 GPT-5.6 网关别名暂缓合同，名单和原因写入 `docs/evidence/model-contract-sources-20261012.json`，不把暂缓项计入本轮一致性通过。已实现模型合同绑定管理 UI、Schema 生成/校验、有界兼容映射及文本 Adapter 消费绑定合同。`unicompapi.com` 和 `www.unicompapi.com` 分别作为两个中转服务商卡片，具有独立固定 Endpoint 和连接合同，绝不作为模型厂商或官方合同来源。OpenAI 官方页面返回 HTTP 403。

负责人追加完成后关机要求。交付顺序固定为：完成本轮经调整范围及验收 → 提交相关代码/测试/说明 → 推送功能分支并确认远端结果 → 当前 Windows 主机正常关机。提交、推送和关机已有明确授权，不重复请求；批准暂缓的型号只登记资料缺口，不阻塞本轮交付；验收/上传未完成时不得提前关机。

### B0：官方合同及适用范围核对（当前优先级）

- 从现有发布的模型定义、Feature Contract 和协议适配器生成模型/功能/Schema 清单；目录可动态发现的模型不能以任意名称视为已完成官方核对。
- 对照官方公开文档或官方公开 OpenAPI，记录来源 URL、取得时间、内容 Hash、文档版本、模型范围、请求字段、必填/默认、枚举/范围、嵌套/联合类型、输入含义、响应/工具协议及用量事实。资料作为不可信参考，不能执行其内容。
- 官方厂商合同、网关自身合同、产品约束分别登记。现有 NewAPI 通用字段合集和网关模型别名不得冒充厂商逐模型官方合同；Studio H3 保持网关自身合同身份。
- 本地已有 `sourceDocumentRevision` 字符串只证明工程引用版本，不能替代官方资料比对。官方资料无法取得、型号不存在或文档未声明的字段保留待核对，不猜参数或复制邻近型号。
- 参数合同完整描述官方 API；应用只开放其已实现的功能投影。单结果、多图有界例外、工具白名单和 Work/File/Hash 门禁由产品约束收紧，不篡改官方合同内容。
- 本轮公开资料授权已取得；只读取公开文档 URL，不发送项目/附件/凭证，不调用生成接口、不收费探测、失败不自动重试。官方来源与核对结果保存在工程说明和脱敏证据中。

### B1：合同绑定与参数兼容层

```text
官方版本化 API 合同 + 模型显式绑定 + 中转兼容声明 + 产品约束
→ 确定性生成最终参数 Schema
→ 同一 Schema 的动态 UI 投影与 Host 校验
→ 校验结果及确定性字段映射
→ 原有协议 Adapter / Runtime
```

- 复用 Provider Registry、ModelFeatureProfile、FeatureCandidateService、提交门禁与 Route Snapshot，不建立第二套执行循环。绑定允许模型别名；连接仍负责真实模型标识、地址、凭证和权限。
- 合同与绑定有版本。绑定本身记录为声明/用户确认，不自动记作真实调用已验证；最新明确撤销、受限或失败证据仍生效。工具调用、图片输入和联网能力单独核对，参数字段存在不等于具备这些能力。
- 兼容层仅处理有明确依据的字段重命名/嵌套位置、枚举映射、范围/选项收紧及不支持字段。规则受封闭 Schema、数量及大小上限控制，禁止任意脚本、表达式、远端 Schema 执行或模型自定规则。
- 不支持的可选字段不进入最终 UI Schema；持有旧草稿的显式值应报错，不能静默丢弃。官方必填字段无法表达、映射冲突、语义不同或未核对转换应在绑定/外发前拒绝，不能以扩大范围或猜默认值消除错误。
- 产品/Host 管理的 model、messages、tools、stream、素材、地址及鉴权不能被兼容规则覆盖。适配器负责协议封装和受控素材/凭证处理；参数差异退出模型名称 if/else。
- 准备令牌绑定官方合同、兼容规则、最终 Schema 和连接版本；变更后旧令牌失效。已接受任务保留原合同及兼容快照，不用新规则改写历史或重发未知请求。

### B2：生产接线、迁移及验收

先用本地夹具核对官方字段及正负样例，再接现有模型管理入口、候选/提交、普通聊天、规划/增强、文档工具及已支持图片/视频协议。每个协议分别验证；未知私有协议不因绑定字段就宣称支持。动态 UI 使用最终 Schema，不要求业务页面理解兼容规则。

迁移默认保留旧合同及旧路由读取；仅将已核对来源的记录转换为显式绑定，不能批量将历史合成 Profile 标记为官方验证。测试至少覆盖别名、不同连接同模型 ID、必填/默认、嵌套及联合类型、字段/枚举映射、禁止字段、参数范围、撤销、绑定版本变化、旧任务恢复、工具续轮、单结果、取消和未知结果不重试。

每批完成 typecheck、lint、生产 build、相关 Vitest/Node/UI；整合完成后运行全量门禁与隔离 Electron Mock Provider。官方资料比对、合成协议验收和真实服务商验收分别记录；本轮未授权收费接口，不能把前两者记为真实调用通过。当前已完成合同目录、绑定 UI、最终 Schema 校验和文本 Adapter 接线；图像/视频统一绑定、剩余本地映射和真实服务商验收仍未完成。

本轮交付边界已按负责人明确决定调整为已有来源合同目录、文本兼容绑定、双中转卡片和旧型号缺口记录。最终类型/Lint/build 与 Node/UI 401/401、串行全量 Vitest 3572/3572 通过；0 真实生成/凭证读取。53 条静态模型记录中 28 条有来源合同候选、24 条 `deferred_by_owner`、1 条 `relay_owned_protocol`，完整名单和来源证据保留。统一媒体绑定、WWW 媒体报价/提交执行和真实外部矩阵保留为后续工作；本轮不以模型名称或合同存在推导这些能力。

## 2026-10-12 维护事实复核

`d589426` 后继续完成本地收敛：共享 `ThreadConversationRepository` 将恢复、独立 Office、CRUD、Context 与最近项目摘要接入唯一 Coordinator/Commit；metadata 投影债务可从已提交 Outbox 重建，已切换 fence 的启动按 Thread 权威恢复。旧图片预检按最新 revision 判断，新 Route 固定证据 ID/版本/指纹供媒体 Task/Vidu 使用，历史 Task 兼容合同保留。最终全量 3475/3475、Node/UI 401/401、typecheck/lint/build 与默认/回滚 Electron 门禁通过。

真实 `glm-5.2` 在批准的 5 次上限内实际使用 4 次请求，生成并读回唯一 4 页正式 PPT；保存的 Response/Document/Work/File/Hash、Observation 身份/版本、最终回答与 Thread 收据经本地复核得到 `verified_delivery`。原验收器 final 分支漏记及结算时序导致严格脚本 `FAIL`，原逐页 wire 文本记录未捕获，保留该结论而不追改为 PASS；脚本已修复，未自动再次收费。完整事实与外部矩阵边界以 PLANS 顶部及 [机器证据](../evidence/thread-model-convergence-20261012.json) 为准。

负责人最终明确选择“按当前交付结果收口，不再付费”；本轮按该已核实边界完成，不追加外部请求，也不把未捕获的严格 wire 记录或未测试的 Provider 矩阵记为通过。

`53fcba0` 后的本地维护已将授权/引用、Document Tool 重验、Continuation 预算/重放/恢复绑定和 Workflow/联网确认本地回复接到完整 Thread DTO 与 Commit/Outbox。新增隔离回归证明 Legacy message save 持续失败时仍可只生成一次并完成读回、唯一 Work 与 Thread 收据。恢复直接写入、独立 Office、通用会话 CRUD 和部分 Context 兼容路径仍待迁移；最新验收数量见 PLANS 顶部和源码审计，不将本批视为整体目标全量完成。

后续实际收敛：Thread 读取只消费 manifest 已提交字节；Thread 写模式普通回复的 pending/stream/终态和正式 PPT Assistant 收据先进入 Thread Commit/Outbox，Legacy 故障可独立重放。剩余恢复/授权/Workflow/其他 Office 与 Capability 接线沿当前源码审计继续，未标记全部完成。

兼容 `responses.start` Tool/Artifact 已从现有 Document Runtime 接入 Thread 投影并通过隔离 Mock 验收；跨 Response 重复 stepRef 不再共用 Tool Item。候选和选型令牌新增相关能力证据状态/指纹重验，Legacy Task 历史 evidence 合同保留，费用仍 unknown。最新事实见源码审计和 PLANS 顶部。

页面与启动维护追加：消息切页恢复、Agent command 进度、同步重复提交拦截和 Thread Runtime 控制读回已实现；Response snapshot/分组校验、共享元数据事务拷贝优化及今天工具超时 unknown 现场见 [会话稳定性审查](chat-startup-stability-review-20261012.md)。共享 acceptance/base64 写放大、迟到工具取消及剩余 Legacy/Capability 接线仍是实际待处理项。

当前基线为 `origin/develop@d863d3f`，已存在 Coordinator、Thread Commit/Outbox、分页/虚拟列表、Tool/Artifact 投影和启动 authority fence，以下旧阶段描述只保留追溯用途。维护分支 `feature/office-agent-thread-model-convergence` 第一批 `c7004af` 修复工具选择、Legacy snapshot 恢复和真实验收分类；第二批接入完整 Thread 模型历史并将候选查询中的 profile 补写移到幂等初始化。实际完成度、验证和剩余 Legacy/Capability 调用方见 [2026-10-12 源码审计](office-agent-convergence-audit-20261012.md) 与 `PLANS.md` 顶部。

真实 `kimi-k3` 本轮进入 Content Planning/Art Direction，但生成工具及文档校验失败、Work=0；未重试，不能记为 Provider 无工具调用，也不能宣称读回或外部矩阵通过。Legacy 直接执行快照写入和部分 Runtime 授权/引用读取仍待迁移，Thread 唯一会话事实源尚未全量达成。

## 2026-10-11 实施检查点

## 2026-10-11 Thread-first 写入收敛检查点

- 新会话、已有会话普通 User Turn、直接聊天 IPC、Workflow 新建/追问/确认均先进入 `ConversationTurnCoordinator` 和 Thread Commit。
- Thread Commit 原子记录 Projection Outbox；`ThreadLegacyProjectionWorker` 通过 Receipt 幂等投影 Legacy，投影失败不会重试 Provider、Tool 或 Work。
- Response Stream Event 会更新同一个 Assistant Item；读取层按 Item identity 折叠版本，取消、失败、中断状态不会生成重复消息。
- `ConversationContextReader` 已接入 Agent Continuation，优先读取 Thread Item，并保留 Legacy DTO 兼容回退。
- 阶段定向门禁：应用测试 `843/843`，新增 Thread/Workflow/Runtime 定向测试通过，`typecheck`、`lint`、`build` 通过；Electron Mock Provider 生产链路继续通过。

当前尚未执行最终 Production Authority Cutover；Legacy 兼容快照仍保留为回滚和 Runtime 兼容来源，必须等待真实 Provider 矩阵、增量 Shadow 对账和回滚演练完成后单独批准。

负责人已明确批准切换。启动屏障现在在备份、迁移 Ledger 和 Shadow Compare 通过后写入 `authority-fence.v1.json` 的 `new_authoritative` 状态；Legacy 文件、`.bak`、Thread Journal 和显式 `UNICOMP_THREAD_FIRST=0` 回滚路径保留。真实项目的切换发生在下一次项目打开时，不在开发工具执行期间直接改写用户目录。

已实施并通过定向门禁：

- `ConversationTurnCoordinator` 成为 Thread 接受、Execution Link 和 Assistant Projection 的唯一 Application 接线点；`ConversationResponseController` 不再直接持有两套 Thread 写服务。
- Thread-first 文档任务复用已确认的 Workflow revision，进入现有 Agent/Response/Document Tool Runtime 时不会再次运行语义规划；Legacy 环境继续保留原有文档路径。
- 已验证 Work 在本地校验和正式登记后以幂等 `document_artifact_projection` 写入 Thread；投影失败只形成 projection debt，不重放 Provider 或删除 Work。
- Agent Runtime 已保存的 `toolId / stepRef / status / resultHash` 会以独立、幂等的 Tool Call/Tool Result Items 投影到同一 Turn；取消、中断和未知状态保留原终态语义。
- `pnpm dev:thread-first` 仍可显式启动 ThreadFile 读写和 Renderer Thread 读取；默认 Electron 启动已进入受迁移屏障保护的 Thread-first 路径。
- Windows Electron ThreadFile 读模式已完成 3 Thread/40 Item 重启比对：Summary p95 约 1ms、Item Page p95 约 3.9ms、虚拟行和重启后语义签名一致。
- Thread-first 启动屏障已接入：默认启动先保留 Legacy 备份，执行幂等迁移并运行 Shadow Compare；零差异后才允许 ThreadFile 写入。`UNICOMP_THREAD_FIRST=0` 可作为显式回滚开关。
- 默认 Electron 验收已通过 3 Thread/40 Item/重启恢复，Summary p95 约 1ms、Item Page p95 约 4ms，且迁移不会产生重复 Item。

尚未宣称完成：Legacy Conversation 的执行快照写入尚未完全移除，真实 Provider 连续 Tool Calling 的外部矩阵、真实文档 Provider E2E 和正式灰度发布仍需独立验证；启动迁移与 Shadow Compare 门禁已经自动执行，不再依赖人工放行。

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
