# PPT 视觉设计链路审计与增量优化

日期：2026-10-13。范围：现有 Office Agent PPT 生成路径、`Design IR v2`、布局求解器、Render Plan/Layout IR、PptxGenJS writer 和本地 Office/PDF QA。未调用 Provider，未读取凭证。

2026-10-14 合并复核补充：原提交 `5d90d0e` 的局部视觉修订会携带文本 patch 的章节字段，导致视觉输出被父文件格式覆盖；旧测试只覆盖 IR helper，未证明登记作品修改成功。此次在 `origin/develop@4e0aee4` 的隔离功能分支中修复并新增真实 Application → Runner → 父 Work → 指定页渲染 → 新 Work/生产计划读回回归。只挑选 PPT 提交，不带入原功能分支其余 19 个模型合同和聊天维护提交。

视觉修订现在保留父内容快照和非目标 Layout IR，仅写目标页面，并将目标页及其关系依赖合入原 PPTX。发布前再次核对父文件 Hash；失败时停止，不能回退旧模板掩盖失败。读回页面映射以已验证 Layout IR 的 sectionId 为准，不依赖视觉排序后第一段文字是标题的假设。`rule/edge/frame` 已有实际渲染，流程节点按 step 业务组生成，不把注释/行动项当作步骤；内容 elementId 不再包含几何坐标。明确命令以整句匹配，否定、混合正文修改、章节目标、越界或局部颜色要求不会扩大为全篇视觉修改。

编译后的生产 Node/Office QA 验证已真实登记父/子作品，均 6 页且 completed，未修改的 37 个原包文件逐项一致，新作品可读回匹配的生产计划。报告、IR、PPTX 和页面截图见 [2026-10-14 合并验收证据](../evidence/ppt-visual-integration-20261014/validation.json)。此案例的 Art Direction 是确定性语义夹具；未调用真实 LLM，不能把它当作真实模型的设计能力或主观审美验收。完整自动门禁结果以 PLANS 顶部和本轮机器记录为准。

## 真实链路

1. 用户请求由 `collectArtDirectionRequestText` 保留在应用层，`DocumentGenerationRunner` 在 PPT create 且没有 revision 时调用 `planPresentationArtDirection`（`src/platform/documents/document-generation-runner.ts`、`src/application/presentation-art-direction.ts:26`）。应用层通过 `buildPresentationArtDirectionInput` 只投影标题、页角色、内容引用、用户视觉要求和品牌约束；模型返回严格的 `PresentationDesignIRV2`，随后 `parsePresentationDesignIR` 做页序、引用、枚举和组织关系校验。
2. 生产编译入口是 `compilePresentationRenderPlan`（`src/platform/documents/presentation-render-plan-compiler.ts:84`）。它先绑定 `DocumentContentSnapshot`，再把 Design IR 交给 `buildPresentationLayoutConstraintModel`（`src/platform/documents/presentation-page-features.ts:97`）。这个边界保留页面语义，输出安全区、元素最小/首选尺寸、层级、关系和组织分组，不接受模型坐标。
3. `solvePresentationLayoutWithRepair`（`src/platform/documents/presentation-layout-engine.ts:126`）负责文本容量估算、CJK 宽度、轨道/网格/比较区、间距、边界、重叠和最多四次本地修复。它会使用 hierarchy、focalArea、balance、flow、emphasis 和 sequence/comparison 关系；不会读取 `pageIntent` 或自由文本 `visualStrategy` 作为可执行指令。
4. `buildRenderPlan` 将规范内容从快照回填到 `PresentationRenderPlan`，`buildProductionPresentationLayoutIR` 和 `derivePresentationRenderPlanFromLayoutIR`（`src/platform/documents/presentation-layout-ir-adapter.ts:48,133`）建立唯一可持久化的几何/样式事实。`renderPresentationRenderPlan`（`src/platform/documents/presentation-design-renderer.ts:5`）只写已校验的 plan。
5. 本地 `createOfficeRenderAdapter`（`src/platform/documents/office-render-adapter.ts:108`）把 PPTX 转 PDF/PNG，检查 PNG、PDF 页数、文本越界、文本框重叠和 PPTX shape 边界。当前环境的 LibreOffice 和 Poppler 均可用。

## 根因

- Art Direction 原来只有 tone/rhythm/density/whitespace/typographyDirection/colorDirection 等有限意图。模板 token 在 `resolvePresentationPageStyle` 中重新决定背景、表面、强调色；模型无法可靠指定一组受控的 palette 或精细字体参数。
- 原 `PresentationRenderPlanStyle` 只有 `fontFamily/fontSize/bold/color/fill/alignment/verticalAlignment` 等字段，行距、字距、字重和页面 surface treatment 没有权威表达，导致这些设计信息在 style compiler 边界丢失。
- Design-aware 流程页的 sequence 关系确实被 layout solver 使用，但 Render Plan 只有 text/table/chart。因而同一语义页在新路径中没有可审计的节点/轨道组件；旧兼容模板反而会画出流程线。
- `pageIntent` 和 `visualStrategy` 是审查用 rationale，提示词明确禁止将它们当坐标或事实；它们保留在 IR/snapshot，但不会被正则或自由文本解释成执行指令。这是安全边界，不是静默丢失。
- 视觉 QA 当前没有可用多模态模型。已有本地确定性 QA 可识别几何和 PDF 文本框问题，但不能证明“高级/未来科技感”等主观判断。

## 已实施

- 在唯一权威 `PresentationDesignIRV2` 中增加可选 `globalDesign.visualSystem`（palette、display/body scale、weight、line spacing、character spacing）和页面 `visualTreatment`（flat/card/outlined、none/rule/edge）。解析器、JSON schema、提示词和引用边界均保持严格；旧 v2 IR 无需迁移。
- `visualTreatment.component` 现在允许页面声明通用原语 `none/nodes/track/frame`；未声明时才根据 sequence 语义推断，显式 `none` 可以关闭装饰。它不绑定页码或模板 ID；测试覆盖 nodes-only 与 track 两种不同 Render Plan。
- 已接入已登记 PPT 的局部视觉修订：`第三页更简洁一点`、`整份 PPT 的颜色更克制一些`、`第四页改成科技感流程图` 会在读取并校验原生产计划后只修改目标 Design IR 字段，再沿同一内容快照和 QA/登记链路生成新版本；无法明确识别的审美请求不会被本地规则强行解释。
- Style compiler 现在消费模型 palette/typography，并把 bounded style 字段传入 Render Plan；Pptx writer 执行行距、字距、字重映射和文本/表格边线。
- 将流程节点/轨道作为 generated decoration shape 写入 Render Plan 和 Layout IR（`decoration-node`/`decoration-line`），不在 writer 内偷偷追加未持久化形状。布局来源覆盖和 digest 校验继续生效。
- 新增 `PresentationVisualAudit`。它只输出占用率、对比度、字体一致性和层级平坦度等确定性 warning，并明确 `multimodalReview: not_available`。它不会把主观视觉评价标成通过，也不会改变交付门禁；真实 Office/PDF QA 仍在 runner 中执行。
- 新增 `scripts/generate-ppt-visual-audit-evidence.cjs`，使用本机配置的 Office/PDF 渲染器生成基线/优化 PPTX、Design IR、Render Plan、几何结果和 PNG。

## 验证

- 定向回归：IR contract、render plan、Layout IR、layout engine、repair、style writer、生产 PPT、视觉系统和视觉修订测试共 88 项通过。
- `npm run typecheck` 通过；`npm run build` 通过。Vite 只有既有 chunk size warning。
- 六页同等内容案例（封面、测试目标、测试范围、测试流程、预期结果、结尾）真实生成：`baseline.pptx` 与 `optimized.pptx` 均 6 页；`inspectPptxGeometry` 基线/优化均 0 个错误；优化页 4 的 Render Plan 含 7 个 shape（4 个节点、3 段连线）。`optimized-audit.json` 为 `status: passed`、`multimodalReview: not_available`、确定性 diagnostics 为空。
- PNG 人工复核重点：`baseline-page-4.png` 是旧模板的浅色流程轨道；`optimized-page-4.png` 是深色技术风格，四步内容由 Design IR 的 sequence 组织驱动，并持久化为节点/连线。两者都保留全部四步事实。

证据目录：[ppt-visual-audit-20261013](../evidence/ppt-visual-audit-20261013/)。

## 尚未实现与风险

- 目前没有可用多模态视觉模型，视觉审计仍是确定性检查加人工 PNG 复核；不能把 `visualAudit.status=passed` 解释成审美通过。
- 当前受控自然语言视觉 revision 已支持明确的全篇颜色收敛、指定页简洁化和指定流程页组件选择，并复用登记作品的生产计划、内容快照、QA、Hash、原子发布和 Work 登记。更开放的审美描述仍保持不解释、不猜测；多模态视觉模型和图片裁切/遮罩仍未实施。
- 图片、裁切、遮罩和复杂阴影仍不进入 Design-aware path；现有输入含图片时会按既有安全策略降级或拒绝。没有改变外部图片/多图批量边界。
