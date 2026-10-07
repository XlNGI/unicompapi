# D-01 / D-03 / D-05 内容、布局与修正工程验收

记录日期：2026-10-06。负责人明确授权“根据你的建议直接执行”，按内容/布局合同先行、设计保持修正随后实施。基线为当前 `feature/chat-send-input-runtime-fix`，保留此前全部授权的未提交维护改动；不修改历史交接包与验收原件。

## 当前范围与实际行为

D-01：`DocumentContentSnapshotV1` 保存无损的段落、引文、编号、表格、图表、页面元信息和来源；版本、稳定内容 ID、已发放身份历史与明确 Host identity map 支持插入、重排、局部编辑和删除身份不复用。`DocumentIR.content`、Outline 是兼容投影，不能携带与 canonical content 冲突的另一份事实。首次生产编译由 Host 的消息/工具上下文 seed 分配独立 scope，同一输入重试保持相同身份和幂等 fingerprint；后续生产与修正复用已确认快照，保留嵌套来源、preserve、版本与已发放但非活跃的身份历史。无显式 canonical 的旧格式转换仍将兼容 Outline 投影为 Host 指定格式，显式 canonical 类型冲突继续拒绝。

D-03：当前支持的 design-aware 生产链路为 canonical content → Design IR → Production Layout IR → 只读 Render Plan → PPTX。布局只记录稳定页/元素来源、几何、样式、诊断、修正与版本/Hash，正文由匹配的快照解析。内容、设计或布局身份不匹配即拒绝。Solver 布局必须逐页完整覆盖 canonical feature 来源，每项一次，且恰好一个 Host 页码；漏掉内容后重算 Hash 不能绕过。真实 PPTX 的 object name 绑定稳定 render element ID。

旧临时流程明确适配其显式 scene 文本框：标记 `legacy_scene_projection` / `explicit_scene_boxes`，不代表全部文件几何；模板装饰、系统页码和外部图片明确排除。字体、粗体、颜色与垂直对齐沿用真实旧渲染器。复杂形状、组合、图片等不支持时保留受控旧输出并报告兼容边界，不伪造完整新布局。

D-05：布局修正只接受现有白名单 `replace_page_layout`，只改变指定页面的设计 composition/pageRole；保留全局主题、内容角色、层次、事实和来源。每个候选重新编译匹配的 Design/Layout/Render Plan，沿用最多两次修正、重复诊断停止、父预算与取消。原本没有合法设计时，各次都显式记录 legacy fallback 原因。

当前 canonical 生成候选的 writer 生成文件字节前必须 awaited 持久化私有计划；callback 取得深拷贝，修改回调对象不能改变实际 writer 输入。Runner 拒绝该范围内忽略 callback 的候选，并清理当前及前一临时文件。QA 通过的候选 Hash 必须与发布前再次读取的文件 Hash 相同。精确源 XML 修改保留既有兼容门禁，不以新生成计划替代原文件事实。文件、结构、渲染、授权、Hash、原子发布与正式 Work 门禁继续生效，失败和取消保留原作品。

## 私有证据与正式读回

每个执行仅允许 attempt 0–2；私有计划写入固定 Host 路径 `entities/document-design-attempts/<execution-hash>/attempt-N.json`。记录 canonical snapshot、Design/Layout/Render Plan、各版本与摘要、父候选 Hash、目标 section/page ID、受控诊断及回退原因。写入为不可覆盖 CAS；QA 收据分开记录实际 artifact Hash 和 `qaOutcome`，固定 `publication: not_authorized`。收据自身不能登记或恢复作品。

`RegisteredPresentationReader.readWithProductionPlan()` 先通过现有安全路径、当前真实文件 Hash/大小和正式 Work/File 读回，再只读取主记录验证 Task/Execution/作品归属、0–2 有界父链与唯一匹配的 passed 候选。备份不能授权；缺失、损坏、篡改、候选歧义或 Hash 不符会拒绝。旧作品完全无私有记录时返回兼容的物理观察。既有普通 `read()` 不增加私有解析成本。章节/页面工作流在可验证私有计划存在时使用其 canonical Outline，消息中的保存文案只作为 legacy fallback。

旧精确 mutation 的 physical `PresentationIdentityManifest`、opaque page/element IDs、version pin、head/journal 与 tombstone 不被 canonical ID 替换。已受控版本丢失主 identity 时拒绝重建 UUID/lineage/head；仅无受控版本证据的 legacy 首次 admission 可以 seed。扫描限定当前项目、有数量上限；备份只作只读证据。

## 验证矩阵

- 内容合同：rich table/chart/numbered/quote 无损、来源、插入/重排/重复文案、显式局部编辑、删除身份不复用、冲突拒绝。
- 布局合同：同输入重放、稳定页/元素 ID、内容与设计身份冲突、篡改 Hash、错误页来源、缺失正文/表格/编号项、重复来源及错误系统页码拒绝。
- 真实文件修正：目标页 OOXML 几何改变、全部事实保留、其他页 XML 不变；两次候选均 design-aware；版本和父候选关联；重复诊断、取消、计划持久失败、callback 缺失、QA 后同大小有效 ZIP 改变均不得登记。
- 边界：回调修改并重算摘要仍不能改变真实 PPTX；旧 scene 框几何与样式匹配真实 XML、排除页码；已有文件/Work 保留。
- 私有读回及收据：真实本地 PPT、当前文件匹配、合法父链；缺主记录、损坏主 JSON、备份独存、篡改字段/版本/Hash、锁等待期间父记录变化、已有收据覆写与重复匹配拒绝。
- mutation：连续真实修改后丢失最新 identity，下一次 prepare 拒绝；原文件、head、version、Works 和身份目录保持。

## 最终门禁与证据

2026-10-06 冻结源码后：Node/UI **387/387**，Vitest **311 文件、3238/3238**，合计 **3625** 项，零失败、零跳过。源与测试 typecheck、全仓 lint、生产 build、平台/恢复/阶段 9 基线/计划审计及 diff 检查通过。构建已有大 chunk 与 Vite CJS API 提示保留，没有通过调整阈值隐藏。

Office 原三方向用例实际转换 **9 页** PDF/PNG 并通过原有检查，约 **7.3 秒**，原 10 秒时限不变。该已有用例允许 PDF 文本检查器不可用产生的 `font_missing`，不能据此声明实际字体替换已完成检测；本轮没有增设或放宽该例外。强制设计修正使用合成诊断，但实际 PPTX、目标几何、其余 XML、来源/事实、Hash、单次 Work 登记和失败清理真实核对。

新构建另复验生产 Host/IPC/preload：三个不同隔离 Electron 进程 **19 项**通过，前两阶段没有模型请求，第三阶段仅 **3 次合成明确续接请求**；HTTP(S) 外发 **0**。真实 ChatPage 生产/StrictMode 各 **7/7**，渲染错误与外发均 **0**。这些是隔离组件和受控 Host 验证，未宣称覆盖完整 AppLayout、真实用户 OS 输入、付费 Provider 或用户实际应用重启。

| 证据 | 结果与范围 |
| --- | --- |
| `outputs/d0135-vitest-final.log` | 311 文件/3238 项完整冻结门禁 |
| `outputs/d0135-node-final-complete.log` | 387 项 Node/UI 契约 |
| `outputs/d0135-typecheck-verified.log` | 源与测试 TypeScript |
| `outputs/d0135-lint-final-complete.log` | 全仓 lint；最后 readonly fixture 另选定 lint 通过 |
| `outputs/d0135-build-final.log` | 生产 renderer/Electron 构建与模板复制 |
| `outputs/d0135-audit-{platform,recovery,phase9,plan}.log` | 既定工程审计 |
| `outputs/d0135-diff-final.log` | 默认 Git 换行配置下的 whitespace 检查 |
| `outputs/d0135-built-recovery/report.json` | 编译 Host/preload、3 进程/19 项/0 外发 |
| `outputs/d0135-ui-recovery/report-r45.json` 与 `report-r45-strict-mode.json` | 真实 ChatPage 各 7 项 |
| `outputs/d0135-source-manifest.json` | 20 个相关源文件与实际编译文件 Hash |

旧恢复报告分别保存在 `outputs/d0135-baseline-recovery-snapshot` 与 `outputs/d0135-baseline-ui-snapshot`，本轮报告另复制到上述独立目录。

## 修复过程与性能记录

初轮完整门禁 `d0135-vitest-complete.log` 保留：7 项失败涉及旧格式转换、private callback 前布局预检失败缺 failed 事件、重试编译随机身份改变幂等 fingerprint、Trace 事实事件数量与 5 秒 known retry。格式转换现在只在没有显式 canonical 时规范输出 kind；Host seed 使同一入参重试稳定；布局规划与实际 writer 同一失败上报范围。私有写前记录、Hash 与 QA 拦截没有删减。

定向兼容回归修好功能失败后，known retry 仍约 5.2 秒；探针显示 private attempt/receipt 约 **16ms**，主耗时为多轮状态和进度持久读写。已完成布局摘要/诊断/页面事实、已计算物理页数决策、已得出的 render 诊断不再为同步空动作各写 started+completed，改为单条结果，保留 facts、取消/预算检查与拒绝谓词。真正模型/工具准入、编译、渲染、QA 前/发布前/发布后 Hash、原子发布和登记维持原边界，不缓存跨效果租约或权限。

最终完整门禁：native 生成 **3013ms**、普通目标 **3475ms**、known retry **4040ms**，原 **5000ms** 不变。定向期间一条 native 用例曾出现 5131ms，独立复验 3194ms；没有作确定环境归因，最终完整冻结全绿。诊断探针仅筛选一个用例，其 skipped 计数不计入最终全量结果；没有增加原等待、预算、循环次数、删除校验或跳过必需套件。

其他保留日志：`d0135-candidate-publication-guards.log`、`d0135-compat-and-performance-recheck.log`、`d0135-completed-check-performance.log`、`d0135-native-spike-recheck.log`、`d0135-perf-probe-ticks.log`、`d0135-typecheck-final-complete.log`。最后一个记录 readonly 攻击样本类型错误，已改为不可变重建并经测试类型、20 项攻击测试与 lint 验证；未削弱对应断言。

## 保留边界与下一步

强制修正诊断与模型 Transport 为合成 fixture；PPTX 保存、OOXML 几何/文案和本地文件读回真实执行。Office/PDF/PNG 渲染单独列实际结果，不把合成诊断称为真实视觉审美验收。所有外部模型/Provider 调用均合成，不读取真实凭证、不收费、不外发企业资料、不重启用户应用；macOS 实机继续延期。

本轮完成范围是当前支持的内容/设计/布局生产与同一生成任务的有界修正。旧父作品整篇重生成仍是明确 `existing_parent_work_regeneration` 兼容路径；精确源 XML 修改不声称拥有与整个原文件匹配的新生产 Layout IR。未把全部旧流程迁移为新 writer，也未将新 canonical 身份替换成熟的 physical identity。

D-02 的“必须遵守已确认设计/允许兼容回退”完整 Host 策略、D-04 的图片与复杂构图、D-06 的进一步质量覆盖仍独立；逐页预览和审美评分维持负责人暂停决定。保留旧模板字体/配色基础并不等于所有页强制同一版式，但本轮也不承诺彻底消除所有旧模板兜底。

改动尚未提交、推送、合并或部署。回滚须仅逆向本批合同/adapter/Runner/读回接线和直接测试，不回退先前 Runtime、恢复、预算、UI 与交付修复；已登记 Work 与私有版本证据不批量删除。
