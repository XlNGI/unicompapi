# R-07 执行预算、超时与取消验收

日期：2026-10-03。工作树：`feature/chat-send-input-runtime-fix`，基线 HEAD `bef4797`，保留此前授权的会话展示与页数规划目标改动。负责人已明确授权先完成 R-07；本记录属于阶段 9 收口后的稳定性维护。

## 最终行为与边界

- HostExecutionBudget 是当前执行链的父预算所有者。固定绝对 deadline、最大调用次数、可信调度单位由 Host 给定，模型与工具参数不能修改。首次模型和准备时间计入总时限，续轮、进度和生成/修改分支不重置预算。
- 对话文档生成为 360 秒 / 8 次 / 24 调度单位；修改以及包含修改的组合 Agent 为 540 秒 / 12 次 / 32 单位；读取为 180 秒 / 8 次 / 8 单位。单工具仍保留更短的原有上限，子步骤使用父剩余时间与自身上限中的较小值。调度单位不代表金额。独立本地文档流程继续采用其既有上限并拥有同样的固定父预算。
- DocumentTaskRuntime 保存可选且不可变的父 deadline。旧记录按 createdAt + timeoutMs 兼容；恢复/重开不会重新给满时长。预算支持当前执行链；持久父 Agent Run、统一恢复/同 Run 等待协议仍归 R-01～R-06/R-08/R-09，不能据此宣称它们完成。
- 初次模型、续轮模型、准备、语义修订、设计、有限修正和渲染的等待受父信号约束。忽略 AbortSignal 的 Promise 会被父截止/取消竞争结束，迟到回调不得启动新步骤，迟到拒绝始终被观察。
- UI 在未取得响应编号的启动阶段，可以按受控 projectId + clientCommandId 停止；取得编号后沿用执行取消。取消不等待恢复屏障，保留草稿。启动注册失败会结算已知未 dispatch 的 response/assistant，防止下一次发送被 pending 阻塞。
- 应用关闭先取消尚未取得 handle 的启动命令；文档会话服务关闭时也取消正在创建会话的父预算。即使恢复屏障或 session factory 不响应信号，也不等待整个任务时限；迟到会话会被关闭，不能重新登记。
- 真实合成 Runtime 覆盖首 HTTP 响应头挂起后的停止：AbortSignal 到达实际请求，迟到 tool_call 流不被读取，不执行工具，不增加后续 HTTP；同会话下一次发送可用。远端请求已开始但结果未知时，保留 submission_outcome_unknown / retryAllowed=false 审计，不声称请求未发送或无费用事实。
- 本地写文件、原子发布与登记必须等待真实提交结果，不用 Promise.race 假装完成或取消。已登记 Work 保留，允许必要的 Observation/终态结算；未知写入/保存结果冻结，不退款、不重放、不重复生成。可中断的 Office 渲染使用受控进程树与独立 LibreOffice profile。
- 新诊断区分 timeout、cancelled、tool_call_limit、budget_exceeded、failure_limit、no_progress、unknown_result，并保留执行/准备/模型/工具/设计/修正/渲染等计时范围、已用/剩余时长和调用/调度额度事实。严格 allowlist 排除路径、提示词、凭证和原文。历史通用 tool_loop_limit 只描述为原因未保存，不反推超时。
- 普通对话展示可读原因；已保存文件及明确的 QA/写入/登记错误优先。泛化失败可用同轮精确停止事实解释；实际新生成产生周期起点，幂等重复请求不清除事实，重试不沿用旧超时。
- 响应完成与本地投影完成之间可能有间隔。结算屏障先等已完成响应的真实 handle completion，再排空终态 finalizer；不等待无关的活动聊天，不增加测试的 2 秒等待常量。更完整的跨实体 CAS/失败重结算协议仍属于后续 C 批次。

## 验证记录

定向覆盖包括 fake-clock 固定 deadline、非协作挂起、同步取消后抛错、迟到拒绝、可信幂等记账、组合分支共享预算、首次/续轮 Provider 准备与请求、无工具长聊天、语义修订挂起、受控 Office 进程、持久 deadline、发布结算、未知写入冻结、启动取消及历史摘要。

全量、生产构建和隔离 Electron 最终结果在 `PLANS.md` 顶部登记；原始与复跑日志保留在 `outputs/r07-*.log`，不以定向测试替代全量门禁。

| 门禁 | 最终结果 | 证据 |
| --- | --- | --- |
| Node/UI | 387/387，零失败、零跳过 | `outputs/r07-node-complete.log` |
| Vitest | 279 文件，2700/2700，零失败、零跳过 | `outputs/r07-vitest-complete.log` |
| 类型 / lint / 生产构建 | 全部通过；保留既有大 chunk 提示 | `outputs/r07-typecheck-complete.log`、`r07-lint-complete.log`、`r07-build-complete.log` |
| 平台 / 恢复 / 阶段 9 基线 / 计划合规 | 全部通过，零违规 | `outputs/r07-platform-audit.log`、`r07-recovery-audit.log`、`r07-closeout-audit.log`、`r07-plan-audit.log` |
| 真实 Electron 组件 | 生产与 StrictMode 各 23 项；异常、生命周期警告、HTTP(S) 外发均零 | `outputs/chat-production-progress/report.json`、`report-strict-mode.json` |
| 差异与预览撤回范围 | `git diff --check` 通过；预览 IPC 不存在、临时文档工作流无 diff | `outputs/r07-diff-check.log` 与工作树核查 |

合计 3087 项自动测试通过。Electron 使用合成 IPC 与隔离 userData，覆盖真实 ChatPage/DocumentProgress，不能替代完整 AppLayout/preload 或 OS 原生交互验收；真正 Runtime 集成另由上述合成 Transport 回归覆盖。

首轮全量的真实失败包括旧取消合同断言、Office QA 在 10 秒测试等待内超时及 Agent-native 2 秒终态等待超时。旧断言已改为校验精确 cancelled 原因；并发等待失败保留原日志并复跑，不扩大生产时限或删 QA。新增周期事件的完整轨迹预期也同步更新。

## 未扩大实施与验收范围

逐页预览、新视觉 QA、Design IR/模板策略、持久父 Run 和统一 Recovery 未在本轮实施。此前误做的预览接口与临时文档改动已撤回；Office adapter 本轮只修改受控渲染取消，不保存或公开 QA 页面图。

全部 Provider 调用使用合成 Transport 与隔离存储，不读取真实凭证、不产生真实费用。Windows 进程树及本地 Office 渲染有测试；macOS 实机仍延期。Unix 在父进程先退出、后代忽略 SIGTERM 时的强制清理边界未经过本轮实机验证，不宣称跨平台树清理完整关闭。

改动目前为本地工作树，未提交、推送、合并或部署。建议验收当前构建的停止、超时说明和文件保留体验；其余缺口按原编号另行授权。
