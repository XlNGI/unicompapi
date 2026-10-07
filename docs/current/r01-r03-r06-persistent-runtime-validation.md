# R-01 / R-03 / R-06 持久运行与事件提交验收

日期：2026-10-04。当前工作树 `feature/chat-send-input-runtime-fix`；依据负责人“可以实施”及后续继续指令，实施修补方案 D。属于阶段 9 收口后的维护，保留此前授权的会话、页数目标、R-07 与 R-02/R-08/R-09 改动。

## 2026-10-04 真实调用后的工程补充

本节以下为当时 R-01/R-03/R-06 验收快照。随后真实 PPT 调用暴露“执行前拒绝仍按完整单位扣父预算”的组合缺口，负责人另行授权修补，见 [入场预算与生成交付记录](ppt-execution-admission-and-delivery-validation.md)。新的工具提案仅一次 prepared CAS，实际 Host admission 原子记录 started/扣额；提案次数与实际执行数分开。所有实际执行前、结果和 Observation 边界继续保留，旧日志/预算不自动改写，不能用本页原 3268 项结果代替后续补丁的实际门禁。

## 执行事实

新增 `ConversationAgentRuntimeV1`，以原 AgentRun 为父身份，固定关联项目、会话、来源消息和 ResponseExecution。保存不可变总 deadline/可信预算、单调调用计数、checkpoint、模型轮次与请求/结果 Hash、工具参数/结果/Observation Hash、已登记 Work 和停止/待核对原因。模型无法决定身份、路径、预算或登记事实。

Runtime、事件和安全 Outbox 在 `conversation-agent-runtimes-v1` 元数据条目内通过同一 ProjectMetadataUnitOfWork CAS 写入，保留其他完成 WAL 条目。事件有固定 `runId`、连续 sequence、唯一 eventId 和幂等 eventKey；同 key 不同事实拒绝，CAS 冲突有界重读，不重新执行业务调用。仅旧备份可读或主记录损坏时，不能授权新动作。缓存比较实际主记录的完整安全条目签名，不跳过磁盘/来源检查。

只保存受控枚举、计数、Hash 和不透明 Host 引用。原始 Prompt、工具参数正文、模型原文、思维链、附件、凭证和绝对路径不进入新的执行事件。Observation Hash 与原始工具结果 Hash 分开，表明结果接收和可供续轮使用的受控 Observation 是两个提交边界；正文仍由原会话/受控文档存储管理。

## 唯一循环与边界

继续复用 `runControlledProviderToolRounds()`，Application 服务只负责准入和持久收据，不实现第二个执行循环。NewAPI、DeepSeek 初次及续轮都接入同一 Host 生命周期；受控 Native Search 保持原有界循环并记模型轮次摘要。

| 边界 | 持久事实与后续动作 |
| --- | --- |
| 首次/续轮模型准备 | 写 prepared 与请求 Hash，校验固定 deadline、归属、前轮结果和 Observation |
| 即将发送 HTTP | 写 submitting；写入失败、取消或预算耗尽均不继续发送 |
| 模型结果 | 提交结果 Hash、终止原因和安全计数后，才进入工具或续轮 |
| 工具准入 | prepared/started 写入成功后才调用工具；使用可信合同额度，重复 started 拒绝且不重复扣费 |
| 工具结果 | 保存结果 Hash 与 Host Work 收据；已登记作品不会因迟到取消丢失 |
| Observation | 单独提交受控 Observation Hash，缺失时禁止下一轮模型 |
| 结束/异常 | 收尾真实 session，保存预算、停止/未知事实，完成门按实际交付结算；已知终态再 settle |
| 中断重开 | 未决提交冻结为 needs_reconciliation；只补本地事件/状态，不重新调用模型或工具 |

副作用/HTTP 已开始而结果或写入事实未知，保持冻结。迟到已知结果和 Work 可以增加证据，不能自动恢复执行权。可信预算的两个本地视图按最大已用计数对齐，不能相加重复收费；超过父策略的 Host 计数拒绝并留待核对。

最终审查补齐了四个结束分支：父 Runtime 建立后的准备取消、授权 claim 失败、session 关闭确认丢失、无 session 但实际 HTTP 已打开后的 acceptance 写入失败。前两种在未发送请求时安全结算；后两种保守冻结。无 session 的实际 handle 也会有界撤销；正常 handle 收尾将真实预算停止原因传给 Runtime，不用未知结果类别替换取消/超时原因。重开后，已知完成门终态且 WAL 未冻结时补 canonical settle，真正未知仍保持待核对。

## 事件投影与重开

绑定父 Runtime 的生产进度先写 canonical event/Outbox，再投影到既有 Production Trace。公开 DTO 保留业务事实和关联编号，内部请求/结果 Hash、工具参数和思维链不进入 UI。新 DTO 的 runId/runEventId/runSequence 必须完整成组；旧历史记录继续可读。

Trace 持久去重索引与有界展示历史分离，不因历史截断重复插入同一个 Run 事件。投影失败保留 Outbox；Trace 已写入而确认 CAS 失败，也只重复投影/确认。确认按同一 Run 排队并以 1000ms/64 条批次写入，避免与 checkpoint CAS 抢写；结束、重放和关闭屏障会刷确认收据。只延后确认标记，不延后 Trace 持久化或显示。确认失败不把已知业务成功误判为未知副作用，未确认记录下次仍可补齐。

最终审查修复了重开时丢失 clientCommandId 的身份冲突：每条公开事件保存原 Host traceId、clientCommandId 和 assistantMessageId，包括原本未绑定消息/命令的情况。启动 scope 只提供存储和业务归属，不能用后来的命令或 assistant 改写原事件。真实磁盘回归覆盖两条已投影未确认记录及一条尚未投影记录，重开全部确认，行数不重复、原归属不变、不新增调用事实。

补充 probe/诊断使用 `emitProductionDiagnostic`，消费日志记录失败并显示记录不可用，避免旧 fire-and-forget 调用形成未处理 Promise 拒绝。真实必需 `emitProductionEvent` 及模型/工具生命周期写前仍必须 awaited；失败继续阻止执行。故障注入分别验证这两种合同，未把必需检查改成 best effort。

工具集只公开每次完整校验完成的摘要，去除逐工具 Schema 进入/返回产生的重复诊断写盘。逐工具、逐字段同步校验与通用诊断 callback 合同保持；模型/工具的必需执行意图、结果和 Observation 仍全部持久化。新增回归验证两个工具只产生一个摘要，传输 Schema 漂移、重复合同及篡改合同继续拒绝。

## 验证记录

| 门禁 | 最终结果 | 证据 |
| --- | --- | --- |
| Node/UI | 387/387，零失败、零跳过 | `outputs/r0136-node-complete.log` |
| Vitest | 289 文件、2881/2881，零失败、零跳过 | `outputs/r0136-vitest-complete.log` |
| 类型 / lint / 生产构建 | 全部通过；保留既有大 chunk 提示 | `outputs/r0136-typecheck-complete.log`、`r0136-lint-complete.log`、`r0136-build-complete.log` |
| 平台 / 恢复 / 阶段 9 基线 / 计划审计 | 全部通过、零违规 | `outputs/r0136-*-audit.log` |
| 真实 Electron 组件 | 生产/StrictMode 各 25 项；异常、生命周期告警与外发零 | `outputs/chat-production-progress/r0136/report-r0136.json`、`report-r0136-strict-mode.json` |

最终共 3268 项自动测试通过。真实 UI 新增同 canonical Run 事件采用不同 project sequence 重放，行数及顺序不变，内部编号不展示；同时保留核对/确认关闭真实 DOM 回归。UI 报告单独存放，未覆盖此前批次证据。

已有直接验证覆盖：CAS 并发、重复/冲突事件、before/after replace 故障、备份不能准入、缓存内容损坏、首次与续轮写前失败、取消/预算、结果未知、Observation 缺失、Native Search 有界摘要、迟到 Work、公开投影失败及确认失败后重开、历史截断后去重、脱敏合同及真实本地文件闭环。

真实合成生产链验证生成→读回→说明的三轮模型和两个工具均落在同一父 Run，模型结果与两个工具 Observation 完整、Work 收据保留、事件序列连续、Outbox 已投影。Provider 均为合成 Transport，本地文件/存储均在隔离临时目录，无真实收费调用或企业资料外发。

持久化开销曾使旧生产用例超过既有 5 秒等待，保留初始日志。通过主记录签名校验后的解析缓存和批量确认优化，不修改生产时限、测试等待或 QA；优化后的真实生成、页数目标、重开和多工具闭环已重新通过。证据为 `outputs/r0136-runtime-performance-baseline.log`、`r0136-runtime-performance-optimized.log`、`r0136-production-integration.log`、`r0136-production-recheck.log`。

最终全量首轮与独立复验仍揭示细粒度工具 Schema 诊断放大的 I/O 开销：三条生成用例超过 5 秒，连续修改超过 20 秒。加入按 Run 串行确认及工具集摘要后，生产生成/修改 21/21 通过；生成约 4 秒、重开约 4.5 秒、连续修改约 7.8 秒。80 条真实持久事件及 Trace 收据为 1507ms；直接队列/故障回归 33/33，摘要/Schema 回归 96/96。原始失败与复验日志分别为 `r0136-vitest-final.log`、`r0136-production-office-recheck.log`、`r0136-loop-performance-recheck.log`、`r0136-serialized-receipt-validation.log`、`r0136-tool-set-diagnostic-validation.log`，不改变调用前写入、primary 校验、fsync、backup 或授权门禁。

既有真实 Office 用例也曾超过原有 10 秒测试等待，独立复验仍复现，保留 `r0136-office-isolated.log`。该测试不经本轮 Runtime/Provider/事件链路，证据不足以将它认定为 QA 判断失败或确定的环境抖动。最终全量在同一 10 秒等待内通过（约 8981ms）；未改变测试等待、真实渲染或检查逻辑。

## 范围与下一步

R-01/R-03/R-06 本轮范围为当前拥有 AgentRun 的会话 Agent/受控文档主链路：父 Run 成为持久执行事实、唯一循环有持久边界、公开进度来自可重放事件。已存在的文档子 Runtime、Response 内容流和 Provider invocation/acceptance 保留各自受控协议；未将无 AgentRun 的旧独立工作流强制迁移。

任意 Agent step 自动续跑、跨进程执行租约/epoch、统一全系统 Recovery 扫描和同 Run 等待/授权恢复属于 R-05/R-04，尚未实施。当前重开仅安全冻结未决调用和修复已知本地记录，不能称为自动完成未完任务。新的事件只保存参数/Observation Hash，恢复正文需经原受控源重建，不能从 Hash 推测并重发。

模板/Design IR、逐页预览和新的审美/视觉 QA 不在本轮；既有本地文件、Hash、结构和授权门禁继续执行。macOS 实机维持延期；真实 Electron 验证覆盖 ChatPage/DocumentProgress 与合成 IPC，不覆盖完整 AppLayout、真实 preload 和 OS 输入。改动为本地未提交工作树，未推送、合并、部署或重启用户开发应用。
