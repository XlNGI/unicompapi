# PPT 入场预算、生成交付与保留文件验收

日期：2026-10-04。工作树 `feature/chat-send-input-runtime-fix`。负责人在核对最新真实调用后授权“修吧”并要求继续；当前为阶段 9 基线收口后的维护，保留此前全部授权改动。

## 真实问题与本轮范围

最新主调用目标 12 页，约 133 秒：一次生成失败，一次成功登记 6 页，成功后再请求旧生成工具被拒绝，第四次提案被父预算拦截。父记录 3 次/24 单位，而文档真正入场 2 次/16 单位。已保存文件没有随失败响应展示。单独 Art Direction 成功；新布局因 font_below_minimum 回退兼容路径，但正式文件门已通过。后两种事实与预算/回复失败分开处理，不将其归为 QA 拦截或生产总时限已到。

本轮修改现有预算、唯一 Provider Loop/Bridge、PPT 编译预检、单纯生成的读回/收尾、失败响应保留文件及直接测试。没有新增业务入口、预览或审美评分，没有增加总时限、调用上限和调度预算，没有绑定新服务商/模型或调用真实付费接口。

## 入场记账

父 Runtime 增加独立 `toolAttemptsUsed`，保留 `toolCallsUsed`、`costUnitsUsed` 表示实际入场。新工具提案仅原子写 `tool_call_prepared`，计入有界提案次数；真实 Host 授权、纯预检、子任务写前记录通过后，必须 awaited 的 `onExecutionAdmitted`/`toolAdmitted` 回执将调用置 started/admitted 并按可信合同扣额。效果执行在持久入场回执完成之后。

| 情况 | 记账/执行 |
| --- | --- |
| 参数或内容预检拒绝、权限拒绝、已撤销工具 | 保留提案/失败/Observation，不消费完整执行额度 |
| 相同幂等调用的已知回放 | 返回已知收据，不再次入场或扣额 |
| 真实执行失败 | 保留已消费单位，不能按 failed 一律退款 |
| 入场/持久收据或写入效果未知 | 保守保留消耗、冻结，禁止自动重放 |
| 损坏主记录/只读备份 | 不授权新执行 |

旧执行记录保持保守兼容，不自动改写旧预算或重放。已有 `tool_call_started` 事件仍可读取，新数据不再为纯提案额外写一次 started CAS；实际开始事实由 `tool_call_admitted` 原子记录。准备、入场、结果和 Observation 边界均保留。未知结果或缺 Observation 仍不得续轮。

新增真实父 JSON Runtime、子 JSON DocumentRuntime、Host budget 与唯一 Provider Loop 的合成回归：一次真实失败、一次成功、一次撤销提案后，三处均为 16 单位，提案 3 次、实际执行 2 次；纯预检拒绝为 0 单位；真实未知执行保持 8 单位并冻结。

## 生成前的内容与页结构

`generate_pptx` 增加受控纯 preflight：编译已验证内容与 IR，检查授权/取消，格式错误以具体安全码返回，不进入文件执行或消耗执行额度的子任务写前步骤，不公开原始编译错误。当前作用域内缓存已编译内容，执行前仍重新核对授权；版本、参数或作用域变化不能使用旧缓存授权。

工具说明明确接受结构化大纲或分节 Markdown，封面和结束页由 Host 增加，正文分节应向目标总页数减两页规划。估计分节数量只用于规划，不当作真实物理页数。普通 target 偏差最多给一次 `page_plan_incomplete` 结构化反馈，随后允许明确说明偏差并交付；不填空白页、复制内容或无限重试。明确 exact/max/range 仍由实际文件门校验，本轮不降低这些条件。

成功执行器的真实页数与普通规划目标以安全标量 `pageCount`/`planningTargetTotalPages` 留在出版收据中。没有有效目标收据的旧记录只显示实际页数，不从原始聊天或旧失败尝试猜目标。

## 单纯生成的受控收尾

普通生成 Work 成功后，Host 只允许一次整篇读回，再进行一次 `tool_choice: none` 的最终说明。模型调用已撤销生成工具，或过早停止时，Host 可显式转换为必要读回；原始模型结果 Hash 保留，转换另有 Host 审计，实际调用与扣额记录 read_document_structure。模型再提出工具调用时禁止执行，结果说明只能使用已核验的 Host 文件事实。

取消、预算停止、未知效果和已关闭 session 撤销 finalization。权限/版本改变时不读取失效文件，也不虚构完成；已有正式 Work 仍保留。生成加修改的组合任务继续执行其完整条件，不被普通生成收尾策略提前终结。

缺 Bridge、工具请求无效、循环轮数达到上限使用独立停止码/提示，不再一律表示实际调度预算耗尽。

## 已保存文件与原终态

新增 Host `retainedDocumentResult` 展示收据，与 completed 的 `documentResult` 分开。failed/cancelled/interrupted 响应可以展示独立已校验 PPT、实际页数和有效规划目标；原响应、父 Run、WAL 和未知冻结保持，保留文件不成为旧消息的自动修改目标。

生成结果投影与启动修复核对 Task/Response/assistant/source message 的绑定、实际登记 Work 与当前本地文件 Hash/权限。会话 DTO 获取再次核验显示能力；当前文件或项目失效时隐藏可用卡，不删除作品或历史收据。旧 failed Parent/applied WAL 可在重开时幂等补卡，重开两次不重复保存，不调用模型或工具。

失败/取消/中断与 completed 一样等待实际 handle 的本地收尾后再刷新目标会话和检查新请求门。等待按既有 5 秒取消确认范围有界，超时不删除执行 owner、不解除完成/对账门；running 会话不因此等待结束。

## 性能与直接证据

新增多轮真实生产合成用例曾超过旧默认 5 秒测试等待，原日志保留。准备提案减少一次冗余 CAS；NewAPI continuation 和 session 工具准备只公开一次业务摘要，去除细粒度 history/body/credentials/enter/exit 的重复诊断写盘。两次权限/工具/Schema/Hash 检查、模型准备/提交/结果及工具入场/结果/Observation 的 mandatory 写入完全保留；诊断失败仍安全报告，不形成未处理拒绝。

优化后两个关键用例在原等待内通过：普通页数规划约 3528ms，真实生成失败后成功、旧生成提案重定向读回、最终交付约 3770ms。直接 budget 138 项、最终准备/入场单 CAS 64 项、adapter/session/finalizer 262 项、Root 内容/终态等待 78 项通过。真实 retained Domain/UI/本地 Hash 与启动回归共 27 新例通过，含旧失败 WAL 重开、文件撤销/篡改不补卡。

真实隐藏 Electron 的生产/StrictMode 各 28 项检查通过：失败、取消、未知原状态保留，文件卡与目标偏差可见，重开无重复或新生成，缺目标旧收据只实际页数；Renderer 错误与 HTTP(S) 外发为 0。使用合成 IPC，不覆盖完整 AppLayout/真实 preload/OS 输入。

| 门禁 | 最终结果 | 证据 |
| --- | --- | --- |
| Node/UI | 387/387，零失败、零跳过 | `outputs/ppt-budget-delivery-node-complete.log` |
| Vitest | 294 文件、2949/2949，零失败、零跳过 | `outputs/ppt-budget-delivery-vitest-final.log` |
| 类型 / lint / 生产构建 | 全部通过，保留既有大 chunk 提示 | `outputs/ppt-budget-delivery-typecheck-complete.log`、`ppt-budget-delivery-lint-complete.log`、`ppt-budget-delivery-build-complete.log` |
| 平台 / 恢复 / 阶段 9 基线 / 计划审计 | 全部通过 | `outputs/ppt-budget-delivery-*-audit.log` |
| 真实 Electron 组件 | 生产与 StrictMode 各 28 项，异常/外发零 | `outputs/chat-production-progress/retained-results/report-retained.json`、`report-retained-strict-mode.json` |

最终共 3336 项自动测试通过。首次全量发现无工具终答提前返回跳过读回后撤权核验，以及授权拒绝未补公开 tool_result；已恢复当前文件/权限/Hash核验和明确失败记录。生成、已生成文件读回与旧只读闭环 31 项边界复验通过，106 项 Bridge/finalizer/错误提示回归也通过。首次完整日志 `ppt-budget-delivery-vitest-complete.log` 与修复后边界复验 `ppt-budget-delivery-final-boundary-recheck.log` 保留。

既有三方向真实 Office 用例初次超过原 10 秒等待，并在提前清理时出现临时文件 EBUSY；不能据此判为 QA 条件未达或确定的环境抖动。最终相同等待全量通过（约 8772ms），未改变该用例、Office/PDF渲染流程、QA、字体阈值或测试等待。

证据：`outputs/ppt-budget-delivery-production-recheck.log`、`ppt-budget-delivery-production-after-admission.log`、`ppt-budget-delivery-production-summary-recheck.log`、`ppt-budget-delivery-page-preflight.log`、`ppt-budget-delivery-host-barrier.log`、`delivery-preparation-summary-focused.log`、`retained-results-targeted.log`、`retained-results-projection-restart.log`；真实 UI 位于 `outputs/chat-production-progress/retained-results/report-retained.json`、`report-retained-strict-mode.json`，旧批次报告未覆盖。

## 边界

本轮不纠正真实历史预算记录，不复跑最新用户任务，不触碰其原文件/状态，不使用真实凭证或付费请求。现有版式/Design IR 回退策略、字号、审美 QA 和逐页预览保持原范围；普通页数仍是规划目标。跨进程租约、任意 step 续跑和等待/授权同 Run 恢复仍属 R-05/R-04。macOS 实机维持延期。改动在当前功能分支本地，未提交、推送、合并、部署或重启用户应用。
