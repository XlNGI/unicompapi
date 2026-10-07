# R-02 / R-08 / R-09 执行结算验收

日期：2026-10-03。工作树 `feature/chat-send-input-runtime-fix`，保留此前授权的 R-07、会话展示和页数目标改动。本轮依据负责人明确的“实施 R-02 / R-08 / R-09”；属于阶段 9 收口后的维护。

## 所有权与完成门

AgentRun 在 Provider 调用前绑定唯一 ResponseExecution 和不可减的子任务清单。子任务必须属于同一项目、会话、来源消息和父响应；Work 通过实际 Host 发布收据绑定子任务，不要求本地文件 Execution ID 与父响应 ID 混同。字段和状态更新通过 Schema 与 CAS 校验，旧记录保持兼容。

| 持久事实 | 父任务判定 |
| --- | --- |
| 纯回答结束；未使用的文档能力无工具调用或副作用 | 可完成 |
| Host 已确认要求文档，但模型只给文字且无文件 | 未完整完成，不能以回复结束冒充交付 |
| 回复结束但实际子任务仍在本地收尾 | 等待结算，不提前完成；新请求等实际 handle/close 屏障 |
| 实际工具失败、读回缺失或交付事实缺失 | 失败并保留已登记作品事实 |
| 未决调用、缺 Observation、未知写入或未知远端提交 | `needs_reconciliation`，禁止自动重放 |
| 工具、Observation、Work、文件 Hash/读回和持久交付收据闭合，回复也结束 | 可完成 |

PPT 主执行链使用真实 RegisteredReader 核对本地文件和 Hash。成功工具 Observation 中的公开 Work 收据是等价持久交付事实；完成 WAL 在此基础上补会话文件链接。只有已完成的回复可附现有 documentResult，失败/取消的回复保持原状态，已有 Work 仍保留在作品库与父任务事实中。没有把未知文件强行标成可用。

独立 Office DocumentGenerationRuntimeBridge 也保留取消/失败/未知之后迟到的登记 Work；没有把本地文档 Execution ID 偷换为父响应 ID。未拥有 AgentRun 的旧独立工作流继续使用原工作流交付协议，本轮不将其强制迁移成新的 Agent Loop。

## 持久结算机制

薄 ConversationCompletionCoordinator 不实现新的 Provider 循环。它在单 JSON 的 ProjectMetadataUnitOfWork 中以 CAS 写入完成 WAL，随后执行本地幂等投影、父 Run CAS 和最终确认。这是 WAL 加幂等修复，不宣称多文件同时原子写入。

运行中的 Response/工具事实会自然变化，只有终态边界进入完成 WAL 的稳定证据检查。结束前后固定验证 Parent/Response/Task 的身份、版本和清单，避免文件已生成但状态投影尚未写完时提前完成。Provider 已 terminal 的 acceptance 仍补本地投影；错误记录并保守冻结，不静默吞掉。

已知的本地投影失败以 `freezeOrigin=local_projection` 留存；用户明确触发核对时，可以仅重做幂等本地投影并用专用 CAS 确认已知终态。真正未知结果、证据变更或没有新 origin 的旧冻结记录不走这个通道。自动重开不重放未知外部副作用。

启动恢复覆盖“回复已完成、Work/Observation 已持久、session.close 尚未落盘即退出”的边界：当前项目内核对已登记文件，仅结算已知子任务；未决调用转待对账。纯读取任务可完成且不制造新作品。完整的租约、父 Run checkpoint、全系统 Recovery 与统一事件流仍属于其他缺口。

## 查询、确认与禁止重放

会话层展示有效父任务状态。WAL 冻结优先于历史 completed 投影，未完成结算不允许新请求。旧未知来源消息即使确认关闭，也不能通过编辑旧消息或旧 draft submit 重发。

受控 IPC 只有三个动作：

1. `inspectReconciliation`：只读核对当前归属与版本。
2. `reconcileReconciliation`：核对并重做可证明安全的本地投影，不调用 Provider 或文档执行工具。
3. `acknowledgeReconciliation`：核对后由用户明确确认“关闭本次任务，不自动重试”。Host token 绑定项目、响应、Run、WAL 和 Task 版本，短时有效且一次消费；版本变化必须重新核对。

确认关闭不证明远端未收费或不存在副作用。`reconciliationReason` 与未知子调用永久保留；不解除旧工具的执行权，不改变文件，不执行删除、回滚或重新生成。已关闭旧任务允许用户发新的命令，禁止自动用原调用重试。

外部模型请求没有可靠可查询结果时，保留 unknown_outcome / retryAllowed=false；本轮不猜测服务商查询接口、不默认联网查账，不做无证据补偿。损坏/仅能读取旧备份的执行元数据不能授权新动作，需要修复主记录后再核对。

## 验收记录

| 门禁 | 最终结果 | 证据 |
| --- | --- | --- |
| Node/UI | 387/387，零失败、零跳过 | `outputs/r0289-node-tests.log` |
| Vitest | 283 文件、2784/2784，零失败、零跳过 | `outputs/r0289-vitest-complete.log` |
| 最终 UI 定向 | 71/71 | `outputs/r0289-ui-final-tests.log` |
| 类型 / lint / 生产构建 | 全部通过，保留既有大 chunk 提示 | `outputs/r0289-typecheck-complete.log`、`r0289-lint-complete.log`、`r0289-build-complete.log` |
| 平台 / 恢复 / 阶段 9 基线 / 计划审计 | 全部通过、零违规 | `outputs/r0289-*-audit.log` |
| 真实 Electron 组件 | 生产/StrictMode 各 24 项；异常、生命周期告警与外发零 | `outputs/chat-production-progress/report-r0289.json`、`report-r0289-strict-mode.json` |

共 3171 项自动测试通过。首轮双 worker 全量仅既有真实 Office 渲染在 10 秒等待内超时；独立 7/7 复验及单 worker 全量通过，保留原失败日志 `r0289-vitest-gate.log` 与 `r0289-office-recheck.log`，未改变超时或 QA。UI 最终状态摘要纠正后又通过定向与真实 DOM 复验，避免待核对时仍显示“正在生成”。

最终数量与日志在 PLANS.md 顶部登记。定向覆盖旧记录、Scope/manifest 拒绝、Observer 与 session.close 次序、无文件不能完成、真实生成/读回、崩溃重开、CAS/各 WAL 边界、局部投影重结算、未知不清除、核对后版本变化、一次性确认、拒绝跨项目/额外字段和原请求重放。Provider 全部为合成 Transport，文档和存储为隔离临时目录。

真实 Electron 组件覆盖待核对提示、已有作品记录留存、未勾选时禁止确认、明确确认仅关闭一次且不启动模型/工具；生产与 StrictMode 报告单独保存为 `outputs/chat-production-progress/report-r0289.json` 与 `report-r0289-strict-mode.json`，不覆盖此前 R-07 报告。

没有实施新逐页预览、审美 QA、模板/Design IR 改造、持久父 Agent Loop、完整统一 Recovery 或发布。macOS 实机继续延期。改动目前为本地工作树，未提交、推送、合并或部署。
