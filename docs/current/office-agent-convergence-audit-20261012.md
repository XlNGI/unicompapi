# Office Agent 会话与模型适配维护审计

日期：2026-10-12。基线：`develop = origin/develop = d863d3f4a7fdc850880d493ee146d7b7d1a27420`。实施分支：`feature/office-agent-thread-model-convergence`。初始工作区干净；不依据旧阶段状态重建已有能力。

追加维护：`78718ed` 修复切页消息恢复，`cc99df9` 修复 Agent 启动反馈、同步重复发送及 Thread Runtime 控制恢复。后续 Response snapshot/事件分组优化、今天工具超时未知结果与共享 metadata/base64 写放大详见 [会话稳定性审查](chat-startup-stability-review-20261012.md)；这些修复不代表下文剩余 Legacy/Capability 调用方已全部收敛。

## 已存在且继续复用

`ConversationTurnCoordinator`、Thread Commit/Projection Outbox、`ThreadLegacyProjectionWorker`、Thread Summary/Page、虚拟列表、Assistant 同一 Item 更新、Tool/Artifact 投影及启动迁移屏障已经存在。默认 Electron 启动通过 Legacy 备份、迁移 Ledger 和 Shadow Compare 后激活 Thread authority；`UNICOMP_THREAD_FIRST=0` 保留回滚。Agent Runtime、Response Execution、Document Runtime、Work/File/Hash 和 Completion Journal 仍分别拥有执行、文档与结算事实。本轮没有替换这些实现，也没有直接打开真实用户项目执行迁移。

## 第一批最小修复

- 读取工具只在尚未交付成功 Observation 时请求 `providerToolChoice=required`。成功后保留工具及文件/权限重验，允许模型回答。
- Agent 的工具可用性和“明确批准立即生成”的要求分离。普通讨论和需要澄清的请求不强制生成；已批准明确生成以及生成后的必要读回继续受门禁约束。
- Legacy 首次 Outbox 恢复使用完整 Message snapshot，保留 streaming/failed/cancelled、reasoning 和文档收据。相同 revision 的元数据缺失可从权威 snapshot 修复；更新不使 Conversation 时间倒退。
- `expected_one_generated_work` 改为依据脱敏 Tool Receipt、Trace、Work 数量和 Art Direction 请求进行失败分类。区分本地验收拦截、工具失败/未知、渲染、校验、登记和重复 Work；出现 Art Direction 就不能再断言没有调用生成链路。
- 验收脚本显式启用 ThreadFile 读写，支持指定独立输出目录。后续真实生成用例保留隔离项目和 profile；本地生成物位置只写入忽略的本机定位文件。

## 第二批收敛

- `ThreadModelHistorySource` 将完整已提交 Thread 消息转换为现有 Conversation DTO 供模型使用，复用 `ModelHistoryReader`、Context Builder 和 Agent Context Assembler；不依赖 UI 页大小。保留 snapshot 的附件、reasoning 和收据，以 Item 状态/正文为准，中断/未知不进入已完成模型历史。
- `ConversationResponseArtifactFactory` 的模型上下文和 Agent Continuation 语义上下文已接入上述 Reader。Thread 写入模式缺少 Thread 时阻断；仅只读模式中未迁移的 Thread 可以显式 Legacy fallback。损坏和项目越界始终传播失败，不静默回退。
- `ThreadProjectionCoordinator` 更新同 revision Assistant 时也持久化新的 snapshot 元数据；幂等键包含 snapshot 摘要，避免只更新元数据被旧键吞掉。
- 文本、图片、视频、文档 Agent 已复用 `RegistryFeatureCandidateSource`/`ProviderFeatureCandidateService`。原图片/视频候选查询每次调用 `registry.mutate()`，即使无变化也推进 revision 并改写备份；现在将包合同 profile 补齐放在图片/视频 Runtime 初始化屏障，查询只消费已提交注册表。模型启用命令同时补齐 reference image profile。
- `mutateIfChanged()` 在同一写锁内校验并比较快照，无变化不写文件、不推进 revision；有变化继续保留原有 Capability 历史校验、原子写与备份。初始化沿用既有包合同，不新增真实 Provider 能力验证声明。

## 回复主路径后续收敛（2026-10-12）

Thread 写模式已将 pending Assistant 与流式正文/推理/终态改为先提交 Thread snapshot，再由 Durable Outbox 投影 Legacy。`projectThreadStreamEvent` 从已提交 Response Execution 取正文和状态，Host 元数据从完整 Thread Reader 保留，停止读取滞后的 Legacy 正文；正式 PPT 交付收据在 Work/File/Hash 重验后也先提交 Thread。终态投影读取 Thread，Legacy 故障保持待投影事件，恢复重放不调用 Provider。Legacy 显式回滚模式保持原实现。授权、引用与 revision 的 Legacy 兼容读取、恢复/澄清/其他 Office 写入尚未在本批全部迁移。

兼容 Tool 缺口已补接：没有 Agent Runtime 时读取 Document Runtime 持久 Call/Observation，仅投影受控状态；在 Session close 结算后补 Call/Result、已验证 Artifact/Assistant 收据，避免 acceptance 早返回留下旧 streaming。隔离 Electron `responses.start` + Mock Transport 通过生成/读回及两种工具 Items，外部 Provider 不因此自动记 PASS。另修复同 Thread 不同 Response 步骤编号复用造成的 Tool Item 串写；投影身份包含执行/来源/工具，旧同执行记录继续幂等更新。

模型证据接线追加：新候选使用 Feature Contract 对应的最新模型能力证据，unsupported/unknown 等不再被 verified Profile 掩盖；相关证据完整指纹进入现有选型令牌绑定，证据变更后重验拒绝旧令牌。Profile 引用和会话图片能力证据同时参与绑定，参数/费用来源不变，公开 DTO 不含证据字段。历史 Task 旧 capabilityEvidenceId 继续按 immutable 合同路由；不把这条兼容合同未迁移误报成统一 Route 已全部完成。

## 授权、引用与本地回复后续收敛（2026-10-12，基线 `53fcba0`）

Thread 写模式新增组合层 `conversationFacts`，复用现有完整 Thread DTO Reader。Response Controller/Draft、Subject Resolver、Artifact Factory、Document Tool Session 的选定/准备/执行重验、Continuation 引用/初始预算/重放，以及 Workflow 和联网确认读取同一已提交会话。工具仍从 Work/File/Hash 与现有授权绑定确认正式文件；模型历史不取得文件或权限决定权。Artifact Factory 同时明确核对项目、会话、Draft/User 身份与版本。

`ThreadFileRepository.readTranscript()` 在跨实例共享 Thread 写锁内读取元数据和 manifest 已提交 Item 前缀，避免授权 revision 和消息来自不同提交。完整 snapshot 继续严格解析；原生 User Item 合法的附件/displayContent 简写按受控字段恢复，并保留显式附件选择语义；损坏、越界或缺少权威 Thread 不回退 Legacy。

Application Service 增加可注入的 transcript 端口：本地澄清、Workflow、来源/搜索说明及联网确认 User 回复通过既有 Coordinator/Commit/Outbox 发布；消息 snapshot 保留 workflowReply 幂等标记。Workflow 已有会话的追问也先提交 Thread；Legacy 保存失败只记 Outbox 欠账，恢复投影不增加消息或重发工具。联网授权仍要求当前问题、显式回复、版本、模型/范围与有效期，过期快照不能授权；本批测试仅生成和消费本地授权合同，没有联网调用。

Continuation 重新读取会话后校验 pinned User、项目与状态；恢复器的 `recordVerifiedResponseBinding` 在原 metadata CAS 内读取提交后的 Thread 引用，不再要求 Legacy 投影存在，主 Run/Response WAL、租约、Hash 和预算门禁保留。仅显式 Legacy 回滚模式继续原主文件校验。

隔离 composed Host 复现先得到 `message_not_completed`；修复后所有 Legacy message save 持续拒绝时，Agent 仍只生成一次、读回物理 PPT、登记一个 Work，父任务 completed，Thread 有两组 Call/Result 和正式 Assistant 收据，Legacy 仍为空。其余新增回归覆盖 Thread-only 澄清与续接、引用变更拒绝、已有 PPT 收据的预算、Workflow 回复/重放和联网确认过期快照。本批实际门禁和最终数量以 PLANS 顶部及 `docs/evidence/thread-authorization-convergence-20261012.json` 为准。

尚未完成：启动/中断恢复和 DocumentGeneration 独立 Office 路径仍有直接 Legacy 写入；通用 Conversation CRUD、Context Registry 和部分兼容读取也未在本批统一。Thread 元数据投影债务仍由原恢复协议处理，新增快照读取不替代恢复器。不将本批记为唯一会话事实源已全量达成，也不将离线 Transport 记为真实外部 Provider 通过。

## 真实 Provider 证据及限制

负责人授权最近成功且仍有效文本模型，一个合成隔离 PPT 生成/读回用例：最多 5 次请求，外层每次最多 1024 输出 token，Art Direction 最多 4096，自动重试 0。实际选中 `kimi-k3`，2 次请求，Content Planning 与 Art Direction 均 HTTP 200，费用无可靠价格证据记 `unknown`。

`generate_pptx` 收据为 failed（`generation_failed`），Trace 有 `tool_call/write_document`、`document_check failed`、`tool_result failed/write_document`，Work 为 0。原报告分类 `generation_tool_failed`；补充分类器依据持久 Trace 将失败阶段细化为 `document_validation_failed`。该证据不足以定位具体校验器，也不能宣称实际渲染或登记已经执行。验收脚本在试图发送后续失败反馈时本地阻断，最终 `newapi.network_error` 是此拦截的外层诊断，不能覆盖此前已经发生的生成/校验失败。

报告 `outputs/office-convergence-provider-live/real-provider.json` SHA256：`7a4faee6cfa57f73c849058acfc86ed338461727b3c6afc9886ac356e2c8e2e5`。安全摘要登记在 `docs/evidence/office-agent-convergence-provider-20261012.json`。原调用使用旧清理逻辑，项目已经删除，只剩该报告和未完整删除的 profile；新保留逻辑修复发生在调用之后，不能倒称本次现场已保留。没有为重建现场再调用 Provider，没有消耗余下请求预算。

本次真实验收走兼容 `responses.start`，当时报告仅有 1 Turn/1 Assistant，Tool Call/Result/Artifact Item 为 0。后续兼容路径的 Document Runtime Tool facts/正式 Artifact 已补接并通过隔离 Mock 验收；原真实失败报告不追改为成功，也没有重试真实请求。

## 剩余实际调用方和下一批边界

### `d589426` 后持续收敛：仓储、恢复、Office、CRUD 与证据快照

默认 Thread 写模式新增 `ThreadConversationRepository`，继续实现原有 `ProjectConversationRepository` 合同，写入经过唯一 `ConversationTurnCoordinator`。通用创建、消息、重命名、归档/恢复/删除、取消后编辑、Context Registry 和本地恢复共享该适配层；不再把 Legacy 的 revision 或消息内容作为这些路径的业务权威。单次保存把变更 Message/Turn、标题/状态和 Outbox 放入同一个 Thread Commit，保留原项目校验和 CAS。

元数据投影也新增可恢复的 `thread_upsert` Outbox；manifest 已提交而 `thread.v1.json` 更新失败时，读取可从提交的元数据/Items 重建当前 revision、状态与计数，重启恢复持久化该结果。已记录 `new_authoritative` fence 的项目启动先恢复 Thread，再重放 Legacy 欠账；不重新把滞后的 Legacy 全量快照当成启动准入基线。首次迁移仍保留备份、Ledger 和 Shadow Compare 门禁。Legacy Outbox 遇到首次失败停止该次顺序投影，避免后来的 Assistant 越过缺失的 User；后续可按原顺序重放，Provider/工具均不重发。

Electron 独立 DocumentGeneration 通过 Chat Runtime 提供的同一受控仓储读写，不再自行实例化生产 Legacy 权威；PPT 修改范围/重试判断也注入相同 Reader。Word/Excel/PPT 正式收据在重新核对 Work、File、大小、Hash 和项目后提交 Thread，并附到 Artifact。项目外的最近会话摘要在 fence 有效时读取 Thread；显式回滚由同一个配置选择 Legacy。取消后编辑和 Workflow 再次接管已提交 User Item 会复用原 Turn；Turn 投影/读回使用结构化 Item identity，避免多个 Assistant 被 `[object Object]` 合并。

模型接线继续保持 Feature Contract 的参数与费用来源；旧图片预检改用统一的 revision 选择函数，最新 unsupported/unknown/restricted/verification_failed 不再使旧 supported 复活。新 Route Snapshot 可保存具体 Capability Evidence 的 ID/revision/Hash，图片/视频 Task 和 Vidu 路由按该快照读取；内容、模型、用途、版本或 Hash 不一致时在外发前拒绝。已接受的历史 Task/Route 继续保留 immutable evidence 合同，未迁移的旧 route 沿原显式兼容读取，不把它记为新候选能力依据。

真实 Electron 还复现切页返回时末条消息不可见：数据已提交，但消息列表延迟出现后原挂载期 ResizeObserver 没有重新绑定。现按已解析会话和显示消息数量绑定实际列表。新增 hook 回归在旧实现下 `observe=0` 失败，修复后通过；修复后 Thread 导航连续两次通过，Legacy 导航保持通过。不能把该失败解释为 Provider 无响应。

本地完成边界及最终数量以 PLANS 顶部和新机器证据为准。负责人批准后，`glm-5.2` 实际 4 次请求完成生成/读回交付，本地只读复核得到 `verified_delivery`；原严格验收器漏记的逐页 wire 比较仍保留 not_recorded。负责人最终明确“按当前交付结果收口，不再付费”，不追加调用。具体预算与结果见 [真实验收方案](thread-model-provider-acceptance-proposal-20261012.md)。共享 acceptance/base64 写放大属于单独性能治理，本批不裁剪真实历史或修改存储内容。

| 实际调用方 | 当前用途及剩余问题 | 迁移目标 |
|---|---|---|
| `ConversationResponseArtifactFactory` | Thread 写模式 revision/user、工具/附件授权和模型历史均接入完整 Thread Reader；pending 走 Outbox | 继续审查独立 Office/恢复调用方，保留项目/版本/权限重验 |
| `conversation-text-submission.createConversationLinkedLifecycle` | Thread 写模式 start/delta/complete/fail/cancel 已由 persisted-event hook 提交 Thread/Outbox；Legacy 回滚路径仍直接保存 | 保留 Completion Journal；继续核对恢复与其他入口 |
| `chat-context-runtime.projectThreadStreamEvent` | Response/Thread snapshot、正式 PPT 收据和本地恢复均走 Thread；Legacy 只保留投影与回滚 | 保留失败/取消/unknown、租约和本地恢复门禁 |
| `ConversationAgentContinuationRuntime`、`JsonConversationAgentSessionRepository` | Thread 写模式引用校验、初始预算、重放 DTO、本地澄清和恢复绑定 CAS 已接入完整 Thread；Run/Response/租约合同保留 | 继续审查恢复终态及其他直接写入 |
| `ProjectConversationResponseSubjectResolver`、`ConversationDocumentToolSessionService` | Thread 写模式从同一完整 Reader 获取 revision/content/收据、brief 和授权绑定；Work/File/Hash 原门禁保留 | 继续核对变更/撤销/恢复边界，模型不决定正式 Work |
| Workflow、Document Generation、Attachment/Page Context、Native Search | 默认 Thread 模式会话读取、确认回复、独立 Office、CRUD 与 Context Registry 已接入共享仓储；原 Legacy 构造仅保留显式兼容/回滚 | 后续以外部验收和兼容删除评估为边界，不新增执行循环 |
| `RegistryFeatureCandidateSource` | 已统一候选入口、参数/Route 重验及相关模型证据指纹；无对应模型证据仍沿已批准包合同，不宣称真实能力验证 | 继续审查完整 Profile/Evidence/Route 持久快照，保持费用 unknown，不猜名称或静默换模型 |
| `ProviderOperationRouter`、旧 image preflight/draft factory | 新预检按最新 revision 拒绝负向/未知；新 Route pin 固定证据 ID/版本/Hash 并供媒体 Task/Vidu 使用；历史 Task 仍精确消费原 immutable ID | 保留旧协议兼容矩阵，不以旧 Task 合同覆盖当前候选；真实外部 Provider 独立验收 |

本轮本地门禁、脱敏证据及真实交付复核已完成，并按负责人最终选择收口，不再收费。历史协议、显式回滚、只读迁移入口保留；共享 metadata 写放大另按测量治理，不扩大副作用执行入口。未覆盖的外部 Provider/严格 wire 记录不扩展成矩阵通过。

## 验证

最终 Node/UI 400/400；串行 Vitest 全量 335 文件、3398/3400，仅两个旧多图夹具依赖查询隐式初始化失败。改为显式初始化后定向 2/2 通过，其他 3398 项已经通过，无未决失败，未调整时限。`typecheck`、`lint`、生产 `build` 通过；夹具修复后再跑测试类型/定向 lint 通过。Thread-first Electron + Mock Transport 普通 Agent、取消、PPT Tool Calling/Artifact 与 Word/Excel 文件登记通过；生成验收 dry-run 0 外发、未解密凭证，脚本语法/`git diff --check` 通过。
