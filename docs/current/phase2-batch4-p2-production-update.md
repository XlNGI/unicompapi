# 第二阶段第四批 P2：生产文本更新闭环

2026-09-28：限定 `update_element({ elementId, text })` 的生产闭环已通过指定 kimi-k3 验收。回滚基线为 `e4d3384`，包含 P1 的 `4367d79`、`1aceb94`。未进入 P3，也未增加任何 add/delete 工具。

## 最终生产链路

```text
自然语言修改请求
→ Host 绑定同会话已登记 PPT / 用户授权页范围
→ 首次精确文件 admission 或加载不可变 Work manifest
→ 持久 authoritative head → RegisteredPresentationReader 真实文件/Hash
→ Runtime Context + Canonical Registry → deriveAvailableToolSet
→ Provider 的 read_document_structure / update_element
→ Canonical 参数校验 → 执行前 live 授权与版本复核
→ Application DocumentMutationCoordinator / update_text Patch
→ 原 PPTX + manifest 的单文本对象 copy-on-write
→ 结构/几何 QA、真实 Office 渲染 QA、SHA-256、完整 identity 校验
→ 候选 File / manifest / child Work 登记
→ 持久 head CAS（最终切换点）
→ Session live state 刷新
→ RegisteredPresentationReader + element locator 真实读回
→ 安全 ToolResult / 原 tool_call_id → 模型最终回答
```

Canonical 合同只定义模型参数 `elementId`、`text`；Provider Schema 和参数 Validator 仍派生同一个 input。mutation Session 的 read Observation 返回公开 pageId/elementId/type/text。旧只读 Session 和生成 Session 的逻辑保持原边界，已建立 mutation lineage 的后续读取解析当前 authoritative head。

工具可见性在每轮 `prepareTools` 中重建。存在有效 manifest、匹配文件 Hash、可读 IR、有效 project/task、写授权、可执行 Binding，且没有取消/未决 mutation，才允许写工具。执行前、提交锁内及 head 原子替换前再次复核取消与权限。只读任务只暴露读工具。

Runtime 注入 `currentDocumentId`、`currentDocumentIR`、`currentVersionPin`、revision、project/task、authorization、AbortSignal、deadline、budget 和 checkpoint。Provider DTO 去除内部 irPatch、Work/File ref、manifest、checksum、物理定位和 Runtime 对象；模型只接收修改成功的元素、字段和安全诊断。

## P1 接生产时补齐的真实缺口

- P1 的 CAS/登记/QA ports 没有生产实现；新增实际 Host 适配器和串行 head CAS。
- 原幂等缓存仅在内存；现以 project/task/call 的稳定 SHA256 键持久化 Coordinator record，重开 Host 后不会重复物化。变更参数复用同调用被拒绝。
- manifest 增加 File/source execution/index version 精确绑定，严格字段/唯一性校验、不可变 Work 快照、并发 seed only-once；页/元素指纹均与真实 XML 比较。
- 原字符串空白归一化不足以验证修改结果；现保留精确文本。复杂富文本、字段和多 run 不作降级修改。
- journal 索引镜像同一 Coordinator 状态；崩溃遗留的未决写入阻止新 task/call 绕行。结果未知不自动重生候选。已登记但未切换的候选保留供核对，不删除其真实文件。
- 取消后 Provider Loop 立即停止；Host ledger 和 `mutation_committed_fact` Trace 保留已提交事实，刷新失败/提交后取消记录 `committed_pending_refresh`。
- 撤权负例发现 NewAPI continuation 失败码拼接了大写异常类名，导致失败终态持久化被拒绝。现将安全 cause 类别转为小写，不改变请求协议。
- 修改请求允许重复提及同一页，并区分“最后简短回答”与“最后一页”；不同页/相对页歧义仍拒绝。

## 真实 Provider 验收

报告：`docs/evidence/phase2-batch4-p2-real-provider.json`。

- requested model 与实际 wire model 都为 `kimi-k3`，无回退。
- 合成 PPT 由现有 Runner 生成，真实 Office/PDF renderer 与 QA 启用；共 4 页，第二页目标与另一页对象包含相同文字。
- 成功运行共 4 次 HTTP：read(page 2) → update_element → read(page 2) → final answer。
- 原文“年度销售目标”改为“2027 年全球销售目标”。同一 elementId 在新文件恢复且文字匹配，另一处相同文本未改，所有未修改 page/element ID 保持。
- authoritative revision 从 1 到 2；identity-index schema version 为 1；只有 1 个 child Work，原 Work/文件保留；新旧 SHA-256 不同，File/source execution/manifest/head pin 一致。
- 最终 Observation 来自 RegisteredPresentationReader 的真实 bytes 和具体对象定位，模型最终答案包含读回新值。
- 所有 tool_call_id 与消息顺序正确；无路径、Work/File 内部身份、manifest 或 Runtime Context 外发；用户配置 Hash 未变化。
- 前两次尝试均在本地页码检查被拒绝，HTTP 数为 0；本批真实模型请求合计仍为 4 次。费用金额未取得，usage 为 Provider 返回的末轮事实，不冒充整轮总费用。

## 自动化与审计

最终 `pnpm test`：Node/UI 384 项，Vitest 261 文件/2320 项，合计 2704 项，0 失败/跳过。typecheck、lint、build、平台/恢复/阶段关闭/计划合规审计、diff 检查通过。

自动化覆盖：Canonical 参数/内部字段拒绝、动态可用工具、真实 Runtime pin、连续两次同 ID 修改、重复文本精确更新、真实元素读回、File/manifest/head 一致性、源文件外部变化/并发 CAS 冲突、授权撤销、Adapter 前取消、渲染中取消、原子 head 替换前取消、已提交取消/刷新失败、迟到 Tool Call 不重启 Loop、持久幂等和重开 Host 重放、物化/QA 失败回滚、unknown registration/CAS、崩溃 journal 阻断、DTO 脱敏与失败终态落盘。

Windows 验收脚本需要读取 Windows safeStorage 加密上下文，已按现有同类脚本登记到平台审计精确文件清单，未放宽审计规则。现有 Vite CJS 与 chunk size 提示仍为非阻断警告。

## 实际文件清单

| 文件 | 本批变化 |
| --- | --- |
| `src/application/document-mutation-coordinator.ts` | 复用同一状态机，补持久 record、锁、版本/授权、未知结果与真实提交状态 |
| `src/application/update-element-tool.ts` | 注入 expected pin 与授权，稳定 task/call 幂等键，安全结果 |
| `src/domain/entities/canonical-tool-contract.ts` | Runtime pin 类型、update 失败码；参数机制保持 |
| `src/domain/entities/document-ir-patch.ts` | 闭合不可变 Patch、XML 安全文字、SHA256 |
| `src/domain/entities/document-version-pin.ts` | 标准化复制并冻结 pin |
| `src/platform/documents/conversation-document-tool-session.ts` | mutation selection/session、真实 checkpoint、动态 read/update、live refresh、范围和取消事实 |
| `src/platform/documents/document-identity-index-store.ts` | 不可变 Work manifest、并发首次 admission |
| `src/platform/documents/presentation-identity-manifest.ts` | 精确对象身份验证、批量对象读取、受控单 run 修改、继承 IDs |
| `src/platform/documents/document-mutation-head-store.ts` | 新增持久 head 与 CAS |
| `src/platform/documents/production-document-mutation-adapter.ts` | 新增实际物化/QA/Hash/Work/manifest/commit/恢复适配 |
| `src/platform/documents/index.ts`、`src/platform/index.ts` | 导出接线 |
| `src/platform/ipc/chat-context-runtime.ts` | 生产注入 renderer 与项目写授权 |
| `src/platform/providers/conversation-response-artifact-factory.ts` | mutation 指令路由 |
| `src/platform/providers/provider-tool-calling.ts` | 内部 Patch/身份/定位不进入 Provider DTO |
| `src/platform/providers/newapi/newapi-chat-adapter.ts` | continuation 安全失败码小写化 |
| `scripts/verify-production-document-update.cjs` | 新增隔离项目、指定模型、实际文件元素级验收 |
| `config/phase9-platform-audit.json` | 登记新 Windows safeStorage 验收脚本 |
| `tests/application/document-mutation-coordinator.test.ts`、`tests/application/update-element-tool.test.ts` | 持久化/版本/取消/幂等/错误边界回归 |
| `tests/platform/presentation-identity-manifest.test.ts`、`tests/platform/document-identity-stores.test.ts` | 精确身份、并发首次 admission、不可变快照与 CAS |
| `tests/platform/production-document-mutation-adapter.test.ts` | 新增真实候选事务、恢复与取消时机 |
| `tests/platform/production-document-update-loop.test.ts` | 新增生产多轮更新、撤权、迟到响应取消 |
| `PLANS.md`、本记录、`docs/evidence/phase2-batch4-p2*.json` | 本批状态、验证和脱敏证据 |

## 限制与后续边界

本批稳定诊断包括 `invalid_arguments`、`identity_unresolved`、`identity_ambiguous`、`identity_stale`、`revision_conflict`、`authorization_denied`、`cancelled`、`materialization_failed`、`qa_failed`、`commit_failed`、`unknown_result`、`reconciliation_required`、`committed_pending_refresh`、`idempotency_conflict`。Bridge 原有 `invalid_tool_arguments`、`authorization_or_revision_invalid`、`call_id_conflict` 等兼容诊断保留。Provider 只收到合同允许的安全码，不返回原异常消息或 stack。

本批只支持可唯一定位的简单文本 shape（单 paragraph/run）；多 run 富文本、字段、图片、shape/table/chart 编辑不开放。物化保持原设计、原对象及未修改 part，不支持重新布局后猜测恢复 ID。

CAS 使用现有项目存储锁与原子 JSON 替换，适用于当前 Host 的串行项目写入；未宣称具备多进程协同编辑或数据库跨表事务。候选未知或 crash 遗留状态安全阻断，保留证据待 reconciliation，不包含新的人工恢复 UI、自动清理策略或暂停恢复功能。

同一原始 call 在 Session 刷新后从 Bridge 重放可能得到 `call_id_conflict`；实际 Coordinator 的稳定 task/call ledger 仍保证不会二次 mutation。平台 temp 目录可能因 Electron 占用延迟清理，未进入 Git。

具备进入 P3 设计的基础；新增/删除实体仍需独立定义新 ID 分配、删除引用和 QA 合同。本轮到此停止。
