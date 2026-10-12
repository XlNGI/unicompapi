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

## 真实 Provider 证据及限制

负责人授权最近成功且仍有效文本模型，一个合成隔离 PPT 生成/读回用例：最多 5 次请求，外层每次最多 1024 输出 token，Art Direction 最多 4096，自动重试 0。实际选中 `kimi-k3`，2 次请求，Content Planning 与 Art Direction 均 HTTP 200，费用无可靠价格证据记 `unknown`。

`generate_pptx` 收据为 failed（`generation_failed`），Trace 有 `tool_call/write_document`、`document_check failed`、`tool_result failed/write_document`，Work 为 0。原报告分类 `generation_tool_failed`；补充分类器依据持久 Trace 将失败阶段细化为 `document_validation_failed`。该证据不足以定位具体校验器，也不能宣称实际渲染或登记已经执行。验收脚本在试图发送后续失败反馈时本地阻断，最终 `newapi.network_error` 是此拦截的外层诊断，不能覆盖此前已经发生的生成/校验失败。

报告 `outputs/office-convergence-provider-live/real-provider.json` SHA256：`7a4faee6cfa57f73c849058acfc86ed338461727b3c6afc9886ac356e2c8e2e5`。安全摘要登记在 `docs/evidence/office-agent-convergence-provider-20261012.json`。原调用使用旧清理逻辑，项目已经删除，只剩该报告和未完整删除的 profile；新保留逻辑修复发生在调用之后，不能倒称本次现场已保留。没有为重建现场再调用 Provider，没有消耗余下请求预算。

本次验收走兼容 `responses.start`，报告仅有 1 Turn/1 Assistant，Tool Call/Result/Artifact Item 为 0；兼容路径的 Document Runtime Tool facts 到 Thread 投影仍需定向覆盖，不能把 Agent-native Tool 投影已存在推断为所有入口已完整投影。

## 剩余实际调用方和下一批边界

| 实际调用方 | 当前用途及剩余问题 | 迁移目标 |
|---|---|---|
| `ConversationResponseArtifactFactory` | Thread 写模式 pending 已走 Outbox；仍读取 Legacy revision/user message、工具/附件授权；模型历史已改读 Thread | 保留旧 DTO 合同，授权与引用改从 Thread Reader 获取 |
| `conversation-text-submission.createConversationLinkedLifecycle` | Thread 写模式 start/delta/complete/fail/cancel 已由 persisted-event hook 提交 Thread/Outbox；Legacy 回滚路径仍直接保存 | 保留 Completion Journal；继续核对恢复与其他入口 |
| `chat-context-runtime.projectThreadStreamEvent` | 已从 Response/Thread 构建权威 snapshot；正式 PPT 收据也先提交 Thread；恢复等仍有直接兼容写入 | 继续消除恢复的 Legacy 权威读取/写入，失败只形成 projection debt |
| `ConversationAgentContinuationRuntime`、`JsonConversationAgentSessionRepository` | 语义历史改读 Thread；输入引用校验、初始预算、重放 DTO、本地澄清回复仍依赖 Legacy | 输入引用与预算判断改读完整 Thread，回复复用 Coordinator/Outbox |
| `ProjectConversationResponseSubjectResolver`、`ConversationDocumentToolSessionService` | 使用 Legacy Message revision/content/收据选定文件、brief 和授权绑定 | 同一 Thread DTO Reader 保留项目/版本/权限门禁，不从模型历史决定正式 Work |
| Workflow、Document Generation、Attachment/Page Context、Native Search | 兼容计划/目标/文件读取仍消费 Conversation DTO；Thread-first Workflow 执行已转入现有 Agent | 逐个替换事实读取，保留离线 Legacy 回滚；不新增执行循环 |
| `RegistryFeatureCandidateSource` | 已统一候选入口及参数/Route 重验；能力证据仍主要经 profile/包合同表达，未完全统一具体模型的证据版本 | 明确 Profile/Evidence 绑定与 stale/unknown 合同，保持费用 unknown，不猜名称或静默换模型 |
| `ProviderOperationRouter`、旧 image preflight/draft factory | 历史图像/视频执行仍消费 capabilityEvidenceId；新候选路径消费 Feature Contract | 先补两者等价性与未知证据测试，再收敛为同一能力快照 |

后续优先级：先在本地复现兼容响应 Tool 投影缺口与 Legacy 先写失败边界；再迁移授权/引用 Reader；再收敛 Capability Evidence/Profile/Route 的统一版本与参数来源。外部 Provider 后续验收需另一个明确预算与新隔离项目，未知结果不自动重发。本轮不把这些待处理调用方标为完成，也不扩展成完整 Provider 矩阵通过。

## 验证

最终 Node/UI 400/400；串行 Vitest 全量 335 文件、3398/3400，仅两个旧多图夹具依赖查询隐式初始化失败。改为显式初始化后定向 2/2 通过，其他 3398 项已经通过，无未决失败，未调整时限。`typecheck`、`lint`、生产 `build` 通过；夹具修复后再跑测试类型/定向 lint 通过。Thread-first Electron + Mock Transport 普通 Agent、取消、PPT Tool Calling/Artifact 与 Word/Excel 文件登记通过；生成验收 dry-run 0 外发、未解密凭证，脚本语法/`git diff --check` 通过。
