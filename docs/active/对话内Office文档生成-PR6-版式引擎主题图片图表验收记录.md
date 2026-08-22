# 对话内 Office 文档生成｜PR6 版式引擎、主题、图片与图表验收记录

日期：2026-08-22

分支：`feature/chat-office-doc-pr1-domain-generator`（PR1—PR5 顺序提交后继续）

基线：`develop@1271be6`

状态：本 PR 满足批准范围与工程门禁，等待项目负责人验收后合并 `develop`。

## 一、批准边界

PR6 实现视觉层能力：内置主题、版式选择、PPT 图表、本地图片插入。全部为本地确定性渲染，不写死服务商/模型；不调用真实服务商、不读取凭证、不产生收费请求。

## 二、实际修改

- 主题（`document-theme.ts`）：商务蓝/墨色/松绿三套内置主题（强调色/背景/文字/弱化色），`resolveDocumentTheme` 带默认回退；
- 版式（`document-layout.ts`）：`title/section/bullets/table/image_text/closing` 版式枚举，`chooseSectionLayout` 按内容块类型确定性选择，为图文/图表预留扩展点；
- 图表：大纲契约新增 `chart` 块（bar/pie、≤50 项、标签/数值校验），PPT 渲染为原生图表（pptxgenjs 内嵌），Word 回退为可读文本，消息大纲展示同步支持；
- 图片：生成请求新增 `images[{fileId,caption}]`，主进程按受控 fileId 解析本地文件后嵌入 PPT 图片槽（右侧图片 + 说明文字，正文自动收窄）；对话页把拖入的图片附件（png/jpg/gif/webp）自动带入生成；
- 主题选择：对话页文档模式新增主题按钮组（商务蓝/墨色/松绿），贯穿 IPC → 执行管线 → 生成器。

## 三、验证结果

- 新增/更新测试：主题解析与回退、版式选择、chart 块校验、PPT 原生图表产物（`ppt/charts/chart1.xml`）、本地图片嵌入产物（`ppt/media/`），全部通过；
- `pnpm typecheck`、`pnpm lint`、`pnpm build`（含 electron）、`git diff --check` 通过；
- 定向测试 8+ 项全绿（office-document-generator 6、runner 2），全量回归门禁此前 795/796（唯一失败为工作区既有 Vidu 未提交改动）。

## 四、未完成项与阻断项

- 对话式多轮改稿、模板上传风格迁移、AI 生图配图、关键词检索/RAG 为候选功能，需项目负责人批准后实施；
- Excel 图表与图文版式在 Excel/Word 中的增强未实现（当前图表/图片针对 PPT）；
- `revision_conflict` 修复（3654a2e）待 Windows 实机回测；
- Windows 人工验收、PLANS.md 登记（等待负责人既有 Vidu 改动提交）、合入 `develop` 待负责人确认。

## 五、下一步建议

1. 项目负责人验收并合入 `develop`（保留本地与远程分支）；
2. 候选功能按优先级单独批准：对话式改稿 → 模板风格迁移 → AI 生图配图 → 关键词检索/RAG。
