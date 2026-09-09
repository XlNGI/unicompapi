# 对话内 Office 文档生成：Word 内容与排版修复验收记录

日期：2026-08-24
分支：`feature/word-document-content-rendering`
基线：`develop@4f2afc5`

## 目标与范围

本轮修复对话页生成 Word 时把模型返回的 `{ title, sections[].content }` 结构误当作 Markdown，导致文件名以 `{` 开头、正文显示 JSON 的问题。实现范围限定在文档内容归一化、文档生成控制器、Word 提示契约和 Word 原生排版；不新增 Provider、凭证、IPC 通道、格式或发布能力。

## 实际修改

- `src/platform/documents/document-outline-parser.ts`：新增严格 `parseDocumentContent` 边界；兼容已观测的 section/content JSON，未知 JSON 结构失败关闭，普通非 JSON 内容继续 Markdown 回退。
- `src/platform/ipc/document-generation-controller.ts`：统一通过归一化边界解析 assistant 消息，非法 JSON 返回 `invalid_outline`，不登记 Work。
- `src/pages/chat/documentDrafting.ts`：提示模型使用 canonical `kind/title/sections/heading/level/blocks` 契约，并禁止 `content`、`id`、`ordered_list`、`headers`、`subsection`。
- `src/platform/documents/office-document-generator.ts`：Word 使用原生可编辑段落、标题层级、编号/项目符号、表格标题和主题色表头；Excel/PPT 分支未改动。
- 对应 parser、controller、application 和 Word generator 测试补充了正向、失败关闭和 XML 排版回归覆盖。

## 本轮验证证据

| 命令 | 结果 |
| --- | --- |
| `pnpm test:application` | 22 passed, 0 failed |
| `pnpm test:platform` | 681 passed, 5 skipped, 0 failed |
| `pnpm typecheck` | exit 0 |
| `pnpm lint` | exit 0 |
| `pnpm build` | exit 0；Vite 仅报告既有 chunk size warning |
| `pnpm exec vitest run tests/platform/file-extraction-service.test.ts --reporter=verbose` | 7 passed, 0 failed；PDF 用例 527ms |
| `pnpm test`（首次全量） | 819 passed, 5 skipped，PDF 提取用例因 5 秒测试上限超时 1 项；聚焦重跑 7/7 通过，判断为既有冷启动/并发波动，未修改 PDF 代码 |
| `pnpm test`（本轮最终） | 826 passed, 5 skipped, 0 failed |
| `git diff --check` | 本次文件无空白错误；全量命令仅报告本地 `AGENTS.md` 原有末尾空行，该文件按宪法保持本地未提交 |

## 合成 Word 结构验收

使用项目已构建的 `generateDocumentFile` 和观测 JSON 合成样本生成：

`tmp/word-qa/智能客服 Agent 系统设计文档-20260824120000.docx`（9,724 bytes，临时文件，不纳入 Git）。

对 `word/document.xml` 的检查结果：

- 标题、章节标题、表格标题、表格单元格均存在；
- 标题段居中，表头包含主题色填充，编号列表使用原生 numbering；
- 22 个段落、1 个表格，列表项分别落在独立段落；
- 未发现 `&quot;title&quot;`、`&quot;sections&quot;`、`&quot;content&quot;` 或 `ordered_list` 原始 JSON 标记。

## 未验证与限制

- 未调用真实 Provider、未读取凭证、未产生收费请求。
- `documents` 技能的 LibreOffice 渲染器因当前环境缺少可执行转换命令而未生成 PNG；WPS 窗口虽存在，但 Windows 自动化获取窗口状态返回 `SetIsBorderRequired failed: 不支持此接口 (0x80004002)`，因此 WPS/Word 人工视觉验收仍需用户在本机打开样本文档确认。
- 未运行 Windows 安装包、签名、公证、macOS、正式发布或真实 Provider 验收。
- 本轮没有提交、推送、创建 PR 或合并；`AGENTS.md` 保持未暂存、未提交。

## 后续人工验收问题修复

针对人工验收发现的三个问题，本轮追加了 TDD 回归保护和最小修复：

- 窄窗口：文档工具栏允许换行，并在 `900px` 以下约束文档类型控件宽度，避免 800×720 窗口裁切发送按钮。
- 失败原因：保留 `stream_failed` 事件的脱敏 `safeCode`，文档完成轮询结束时继续使用具体失败原因，不再覆盖为笼统提示。
- 重复点击：Renderer 增加同步 in-flight 防重入；主进程按项目、消息、revision、格式、主题和素材选项复用并发及已完成文档生成结果，失败请求仍可重试。

追加 RED → GREEN 证据：

- RED：新增 UI 合同测试 3 项失败；Controller 并发测试失败并观察到两组不同 Task/Execution/Work。
- GREEN：`tests/ui/chat-document-ui-contract.test.mjs` 5/5 通过；`tests/platform/document-generation-controller.test.ts` 8/8 通过；`pnpm typecheck` 和 `pnpm lint` 退出码 0。

追加根因回归：JSON 数组（含 fenced 数组）失败关闭；非法请求不会复用合法请求；不同格式不会合并；独立编号列表使用独立 numbering 实例；控制器不向 Renderer 返回内部异常消息。聚焦平台测试、应用测试、UI 合同测试、类型检查和 lint 均已通过。未调用真实 Provider、未读取凭证、未提交或推送。
