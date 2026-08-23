# 对话内 Office 文档生成｜融资演讲稿模板验收记录

日期：2026-08-23

阶段：阶段 9 收口后的对话内 Office 文档生成独立功能系列补充

## 依据与范围

- 参考资料：负责人提供的 `Slide1.jpg` 至 `Slide19.jpg`（16:9 融资演讲稿视觉参考）；
- 权威工程记录：`docs/active/对话内Office文档生成-PR6-版式引擎主题图片图表验收记录.md`、`docs/active/对话内Office文档生成-候选功能验收记录.md`；
- 实现范围：对话内 PPT 生成入口新增可编辑的“融资演讲稿”内置主题；不新增一级页面，不改变文档生成 IPC 和本地作品登记门禁。

## 实际修改

- `src/platform/documents/document-theme.ts` 新增 `financing` 主题，采用黑白与青色强调色（`078AA3`），并标记融资演示版式族；
- `src/platform/documents/office-document-generator.ts` 为该主题增加深色标题带、青色强调条、内容卡片和深色结尾页，标题、正文、表格与图表仍由 PPTX 原生对象生成；
- `src/shared/document-generation-ipc.ts` 与 `src/pages/chat/ChatPage.tsx` 接入“融资演讲稿”选择项；
- PPT 文档提示词明确要求优先输出结构化 JSON；有可靠数值时使用 `table` 与 `chart` 块，Markdown 仍作为回退格式；
- 同一对话的后续改稿明确按局部修改处理：仅改用户指定的表格、图表或分节，其余内容保持不变，再生成完整新版文件；
- 新增主题解析、PPTX 产物和 UI 合同测试。

参考图片未作为不可编辑的整页背景写入成品，避免把示例文字固化到用户文档；其构图与配色被转换为可编辑的版式结构。

## 验收结果

- `pnpm typecheck`：通过；
- `pnpm lint`：通过；
- `pnpm build`：通过（仅有项目原有 bundle 体积提示）；
- `node --test tests/ui/chat-document-ui-contract.test.mjs`：2/2 通过；
- `vitest run tests/platform/document-theme-layout.test.ts tests/platform/office-document-generator.test.ts`：11/11 通过；
- 未调用真实服务商、未读取凭证、未产生收费请求。

补充：如果生成内容没有可靠的数值资料，系统不会编造表格或图表；测试时应在需求中提供明确的分类和数值。

## 未完成项

- 未实现把 19 张截图逐页作为不可编辑背景的复刻模式；当前交付为可编辑的融资演讲稿主题模板；
- 未执行全量门禁；本次已完成生产构建，完整阶段门禁仍按项目既有流程执行。
