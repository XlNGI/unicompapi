# 对话内 Office 文档生成：大学课堂汇报模板验收记录

日期：2026-08-24
分支：`feature/ppt-university-classroom-template`
基线：`develop@4f2afc5`

## 目标与范围

将用户提供的《人工智能入门_大学生汇报.pptx》提炼为对话内 PPT 的可复用内置主题“大学课堂汇报”。参考文件仅用于识别可编辑视觉语言，不复制、嵌入或修改参考文件中的课程内容。

范围限定为主题选择、IPC 契约、PPT 原生布局和回归测试；不新增 Provider、凭证、外部请求、收费调用、一级页面或发布能力。

## 实际修改

- `document-theme.ts`：新增 `university` 主题，采用青绿主色、蓝/橙/红辅助色、浅色内容卡和 16:9 课堂汇报版式族。
- `ChatPage.tsx` 与 `document-generation-ipc.ts`：对话文档模式新增“大学课堂汇报”主题选项，并将其完整传递到主进程生成管线。
- `office-document-generator.ts`：PPT 生成器新增原生可编辑的课堂封面、章节标题、分页线、四色知识卡、表格页、图片槽与图表页；图表独立成页，带图时采用左右分栏安全尺寸。
- 长内容不会静默截断：每四项要点、每段说明和每六行表格都会按需要拆分为独立页面；所有输入文本持续保留在生成产物中。

## 验证结果

| 命令 | 结果 |
| --- | --- |
| `pnpm exec vitest run tests/platform/document-theme-layout.test.ts tests/platform/office-document-generator.test.ts` | 16 passed，0 failed |
| `node --test tests/ui/chat-document-ui-contract.test.mjs` | 5 passed，0 failed |
| `pnpm exec tsc --noEmit` | exit 0 |
| 定向 `eslint` | exit 0 |
| `pnpm build` | exit 0；仅有既有 Vite 大包提示 |
| `git diff --check` | exit 0 |

产物回归覆盖：封面标识与主题色、四色可编辑卡片、长段落/六项要点/七行表格的分页保留，以及图表框坐标不越过 13.333 x 7.5 英寸页面边界。

## 未验证与限制

- 尚未在 Windows PowerPoint 或 WPS 中人工打开生成文件进行最终视觉验收；需要重点确认中文字体替换、长文本缩放和图表标签可读性。
- 未调用真实 Provider、未读取凭证、未产生收费请求。
- 未运行安装包、签名、公证、macOS 实机或正式发布验收。
- 本轮未提交、推送、创建 PR 或合并。
