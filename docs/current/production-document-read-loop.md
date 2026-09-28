# Canonical 只读工具生产接线记录

本批以已验证并提交的 `1032ddf4338ca7ed0780ae17eed7e920dd3fff16` 为回滚点，在 `feature/ppt-goal-pipeline` 完成增量接线。当前执行状态以 `PLANS.md` 顶部记录和本批机器证据为准。

实现提交为 `3a373b8`。证据归档保留最终真实报告，不含凭证、请求正文、用户文档或文件路径；尚未推送、合并或发布。

## 本批边界

只开放 `read_document_structure`。其余七个工具仍保持既有 `internal` 状态，未删除、重写或新增 Provider 暴露。复用上一批 Canonical Contract、Available Tool Set、参数 Validator、只读 Binding 和 Runtime。

未修改 Outline Contract/Parser、Document IR 核心、PptxGenJS、Runner、QA、发布、CRUD、`generate_pptx` 或 Provider Loop 轮数策略。

## 最终生产链路

```text
createChatContextRuntime.responses.start
→ ConversationResponseController 识别当前会话的已登记 PPT 读取请求
→ Session 固定 project/conversation/source/user revision、Work/File、Hash 和授权范围
→ SubjectResolver / ArtifactFactory 绑定提交范围与 response execution
→ ConversationTextDispatchBridge 获取该 execution 的只读 Session
→ 每次请求：prepareTools → 最新文档/权限/Hash/状态/有界读取
→ Canonical Registry → deriveAvailableToolSet → Provider Schema
→ 凭证回调及 beforeRequestStarted 完成后再次 prepareTools
→ 验证工具集合与已序列化 Schema 相同，才发送 HTTP
→ LLM 返回 read_document_structure({ scope?, ordinal? })
→ Canonical 参数校验 + 再次可用性/绑定/授权检查
→ Runtime checkpoint → Binding authorize → Adapter execute
→ DocumentToolResult 校验与脱敏
→ role=tool，tool_call_id=原调用 ID，content=安全结果 JSON
→ 下一次 LLM 请求重新准备工具和重验权限
→ LLM 基于 Observation 回答
→ Trace / checkpoint；只读 Session 收尾
```

普通聊天不附带文档工具。当前选择来自同一会话中此前的已登记 PPT；附件、Word/Excel、歧义多文档选择不扩展到本批。首轮不把历史大纲、文档正文或旧 context 注入请求。单页读取使用真实 PPTX 的物理页顺序，含封面和隐藏页。

## Schema 唯一来源和可用集合

唯一权威来源继续是 `src/domain/entities/canonical-tool-contract.ts` 的 `canonicalToolCatalog`。本批没有新增参数定义副本。Provider 流式工具调用允许首个空 `function.arguments` 增量，最终累计字符串仍必须通过严格 JSON 和 Canonical 参数校验。

```text
contract.input
├─ canonicalToolInputSchema → providerToolsFromContracts → Provider parameters
└─ validateCanonicalToolArguments → parseAtomicToolArguments → Runtime validation
```

允许的模型参数只有：

```ts
{ scope?: 'document' | 'page' | 'section'; ordinal?: number }
```

`scope` 默认 `document`；`page/section` 必须提供 1—500 的整数 `ordinal`；`document` 禁止 `ordinal`；未知参数拒绝。生产 PPT Session 本批只授权 `document/page`，`section` 安全拒绝，不把 Outline 章节当作真实页。

`document-tool-bridge.ts` 的 `available(context)` 调用 `deriveAvailableToolSet`，根据 exposure、实际 Binding、capability、operation、当前文档、IR、revision、读写授权筛选。Session 每轮先刷新真实状态，Provider 出站前再次复核。两个 Adapter 的当前名称集合从本次派生的 Schema 计算，没有恢复手写 `allowedToolNames`。

文档授权、文件登记或 Hash 在已成功读取后失效时，停止续轮 HTTP，避免再次外发历史 Observation。工具执行前状态不满足时不会进入 Adapter。准备过程受 contract timeout 和 task deadline 共同约束；迟到的文件读取无法恢复失效授权。

## Runtime 注入上下文

模型只给业务参数。Host 注入：

- `currentDocumentId`、`currentDocumentIR`、`revision`；
- `operation: 'analyze'`、从 Contract 取得的 capability；
- `projectContext: { projectId, workId }`；
- `authorization: { canRead, canWrite: false, allowedToolIds }`；
- `abortSignal`；
- `taskContext: { taskId, deadlineAt, checkpoint: { revision, step } }`；
- Bridge 在实际执行上下文补充 `callId` 和 `idempotencyKey`。

真实文件位置只在 Platform 的受控读取服务中使用。上述上下文整体不进入 Tool Schema；结果投影也不返回 Host 文档 ID、路径、凭证或权限对象。Observation 中已有的业务 revision 摘要继续保留，模型不能用它覆盖 Host revision。

## ToolResult 到 Provider Tool Message

| 内部数据 | Provider 消息 |
| --- | --- |
| 原始调用 `call.id` | `tool_call_id`，保持原值 |
| Contract 的 `toolId` | `name` |
| `schemaVersion/status/observation/diagnostics/artifactRefs/metadata` | 合同校验、大小/深度检查和脱敏后，作为 `content` JSON |
| Runtime context、路径、凭证、内部引用 | 不发送 |
| `irPatch` | 本批只读 Contract 不接受 |

保留对应的 assistant `tool_calls` 消息，再附加关联的 `role: tool`。同一 assistant 消息出现重复调用 ID 时拒绝；跨轮既有幂等逻辑未改。失败返回受控 diagnostic，不回传异常堆栈。

整篇 Observation 包含可表示范围内的全部抽取文本和页容器；单页只返回获授权的物理页内容。超过 IR/结果容量时失败，不静默截断。此工具不解释图片、图形或图表的视觉含义。

## Trace 与恢复

有效调用记录 `tool_authorization`、`tool_call`、`tool_result`。工具分类来自 Contract 的 `diagnostics.traceType`（该工具为 `read_sources`），使用调用 ID 关联；checkpoint 保存输入指纹、步骤、结果摘要，不持久化正文或路径。

本批将 Runtime 写前的已知授权/范围/预算冲突映射为明确失败。真正的未知结果继续保留 reconciliation 边界。结束读取后 Session 清除内存绑定并使只读 Runtime 进入 `paused`，不会伪造新 Work 完成或发布。

完整生产测试发现的响应轮询竞态同时做了局部修复：execution 和 events 改为来自同一次存储快照，不更改状态转换。

## 实际修改文件清单

相对回滚点，共 25 个文件；无关未跟踪 `mermaid-diagram.png` 不纳入。

| 文件 | 操作 | 具体变化 |
| --- | --- | --- |
| `PLANS.md` | 修改 | 本批范围、回滚点、实际验收及剩余限制 |
| `config/phase9-platform-audit.json` | 修改 | 将受控真实 Provider 验收脚本登记到平台审计白名单 |
| `src/platform/documents/conversation-document-tool-session.ts` | 新增 | 绑定当前会话的已登记 PPT；刷新授权/文件 Hash/IR；构造只读 Session、上下文和有界准备过程 |
| `src/platform/ipc/chat-context-runtime.ts` | 修改 | 在生产 Chat Runtime 中创建、注入和释放文档工具 Session |
| `src/platform/ipc/conversation-response-controller.ts` | 修改 | 识别只读请求、固定用户授权页范围和 draft；避免预注入正文 |
| `src/platform/providers/project-conversation-response.ts` | 修改 | 把受控文档绑定 Hash 纳入提交范围；排除旧文档上下文 |
| `src/platform/providers/conversation-response-artifact-factory.ts` | 修改 | 构造只读工具指令并绑定 response execution；首轮不预先发送正文 |
| `src/platform/providers/conversation-text-submission.ts` | 修改 | 按 execution 获取动态 Session；传递 prepareTools/Bridge 并收尾 |
| `src/platform/providers/deepseek/deepseek-chat-adapter.ts` | 修改 | 逐请求派生工具；最终 HTTP 前重验；仅执行本次广告集合；保持调用 ID |
| `src/platform/providers/newapi/newapi-chat-adapter.ts` | 修改 | 与 DeepSeek 一致的动态 Schema、出站重验与只读工具续轮 |
| `src/platform/providers/document-tool-bridge.ts` | 修改 | 把写前拒绝映射为明确失败，避免将已知授权/范围/预算冲突误报为未知执行结果 |
| `src/platform/providers/provider-tool-calling.ts` | 修改 | 拒绝同一 assistant 消息的重复 tool_call_id，兼容合法空参数流式增量 |
| `src/domain/repositories/repository-ports.ts` | 修改 | 增加可选 execution/events 同版本快照接口 |
| `src/platform/repositories/json-conversation-response-execution-repository.ts` | 修改 | 一次读取返回 execution 与有序 events |
| `src/platform/providers/conversation-response-streaming.ts` | 修改 | 使用快照投影响应，消除生产轮询读取竞态；兼容旧测试替身 |
| `tests/platform/conversation-document-tool-session.test.ts` | 新增 | 真实 PPT 读取、权限/版本/Hash、越权参数、页范围、取消/超时与迟到完成回归 |
| `tests/platform/production-document-read-loop.test.ts` | 新增 | responses.start 到 Provider/真实本地读取/Observation/回答/Trace 的完整生产接线测试 |
| `tests/platform/deepseek-chat-adapter.test.ts` | 修改 | 动态 dispatch、每轮及最终出站前重验、撤销、取消、Schema 漂移回归 |
| `tests/platform/newapi-provider-package.test.ts` | 修改 | NewAPI 动态工具集合、关联 ID 与出站前撤销回归 |
| `tests/platform/provider-tool-calling.test.ts` | 修改 | 重复调用 ID、真实 Provider 空参数增量、最终 JSON 拒绝回归 |
| `tests/platform/conversation-response-streaming-contracts.test.ts` | 修改 | 同一存储快照的 execution/events 投影回归 |
| `scripts/verify-production-document-read.cjs` | 新增 | 隔离 profile/合成 PPT，通过生产入口执行两个真实 Provider 读取场景 |
| `docs/current/production-document-read-loop.md` | 新增 | 本批生产链路、实际文件清单、合同/上下文/结果/Trace 说明 |
| `docs/evidence/production-document-read.json` | 新增 | 自动化验收、保护文件、范围和限制的机器可读证据 |
| `docs/evidence/production-document-read-real-provider.json` | 新增 | 真实 Provider 最小验收的脱敏报告 |

## 自动化与真实验收

最终自动化结果：Node/UI 384/384，Vitest 252 文件、2228/2228，合计 2612 项通过，无失败/跳过。typecheck、lint、build、平台审计、恢复审计、既有关闭门禁和计划合规通过。完整本地日志位于 `outputs/production-document-read/`。

生产接线测试经过真实 `responses.start`、动态 dispatch、模拟 HTTP、真实合成 PPT 读取、Observation、最终回答和 Trace；另有 Session、Provider、参数校验和仓储竞态回归。

真实验收命令：

```powershell
pnpm exec electron scripts/verify-production-document-read.cjs --authorized-two-synthetic-cases
```

该脚本固定两个合成请求（整篇、物理第 2 页），每案例最多两次 HTTP，每次最多 1024 输出 token，无自动重试；不发送用户文件或历史对话，使用隔离 profile，并检查用户配置 Hash 未变。真实结果保存为 `docs/evidence/production-document-read-real-provider.json`，自动化及范围证据保存为 `docs/evidence/production-document-read.json`。

构建仍提示已有 Vite CJS API 弃用和较大 chunk 警告；不影响本轮构建结果。

最终通过批次为 2026-09-28 00:49:45—00:51:12 UTC，当前配置模型 kimi-k3。两案例均只调用一次 read_document_structure，随后根据 Observation 完成回答；每例 2 次 HTTP，最终批次共 4 次。该数字不包含故障定位的早期调用。最小验收请求明确要求读取一次后立即回答。此前一次复验中模型在成功读取后仍要求更多工具调用，脚本的请求预算阻止了第三次 HTTP；这属于仍保留的模型/轮数策略限制，未通过放宽预算掩盖。最终响应 usage 不能解释为完整诊断任务费用。

早期本地预检发现设置文件缺失、会话连续 revision 保存和隔离 Electron profile 加密上下文问题，均在脚本内修复。脚本在 app ready 前从 Local State 仅复制 os_crypt 加密配置，不复制 Cookies，不记录解密值。真实网络发现的空 arguments 增量缺陷已修复并纳入默认回归。最终报告保留临时清理延迟事实；进程退出后的任务清理命令被自动审批策略拒绝，临时目录保留，不纳入 Git。

## 尚未处理

1. Provider Loop 仍保留原有轮数策略；未开展 generate_pptx、CRUD 或其他七项工具的生产暴露。
2. 读取限于当前会话中的已登记 PPT、可表示的文本结构和 document/page 范围；不含附件编辑、多文档显式选择、语义章节或视觉解释。
3. 尚未增加“必须至少成功读取一次才允许完成文档问答”的强制完成门禁。Prompt 要求先读，真实验收会核对实际工具往返；Provider 若直接 stop，既有响应状态机仍可完成。
4. 部分参数/调用 ID/未广告工具的提前拒绝已有安全 ToolResult，但尚未补齐独立 tool_result Trace；有效调用链和 Runtime 写前拒绝已有记录。
5. 既有 Provider usage 当前保存最终响应的 usage，不足以作为整个多请求工具循环的总用量或总费用；费用保持 unknown，不估算为零。
6. 本轮为 Windows 生产入口及真实 Provider 最小验收，不替代可见 UI 人工验收、跨 Provider 全组合或 macOS 实机验证；未推送、合并或发布。
