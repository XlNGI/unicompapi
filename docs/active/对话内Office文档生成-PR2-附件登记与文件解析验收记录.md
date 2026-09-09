# 对话内 Office 文档生成｜PR2 附件登记与文件解析验收记录

日期：2026-08-22

分支：`feature/chat-office-doc-pr2-attachment-parser`

基线：`develop@1271be6`（PR1 已提交，本分支在 PR1 之上继续开发）

状态：本 PR 满足批准范围与工程门禁，等待项目负责人验收后合并 `develop`。

## 一、批准边界

PR2 实现受控附件导入与文件内容提取：拖拽/对话框文件复制进项目 `files/attachments/` 并登记 FileReference，白名单格式（txt/md/csv/docx/pdf/xlsx/pptx）解析出结构化文本，返回截断预览与统计。不接入对话页 UI、消息附件、IPC 或识图（分别属于 PR3/PR4）。本 PR 不调用真实服务商、不读取凭证、不产生收费请求。

## 二、实际修改

- 新增 `src/platform/documents/attachment-import-service.ts`：源文件存在性/大小校验 → 项目内副本（`files/attachments/<uuid>-<安全名>`）→ FileReference 登记 → SHA-256 校验（复用 NodeFileStatusProbe + FileVerificationPersistenceService）→ 返回 fileId/文件名/大小/提取摘要；
- 新增 `src/platform/documents/file-extraction-service.ts`：
  - 格式检测含魔数校验（ZIP 头/%PDF/无 NUL 文本），扩展名与内容不符返回 `unsupported`；
  - 默认上限：文件 20MB、PDF 300 页、xlsx 5 万行、pptx 100 页、ZIP 条目 500、预览 4000 字符，均可调；
  - txt/md 直读、csv 表格化、docx（mammoth）、pdf（pdfjs-dist，动态加载，扫描件返回 `scanned_pdf` 提示 OCR 不支持）、xlsx（exceljs，按工作表输出）、pptx（jszip 解包提取每页 `<a:t>` 文本）；
  - 加密文档、ZIP 炸弹（条目超限）、超大文件分别返回 `encrypted`/`too_large`；
- 新增 `src/shared/document-attachment-ipc.ts`：附件导入/提取 IPC 通道名与 DTO/错误码契约（PR3 接线使用）；
- 依赖：`mammoth@1.12.1`、`pdfjs-dist@6.2.108`、`jszip@3.10.1`（运行期，仅主进程使用）。

## 三、验证结果

- 新增测试 10 项：导入 3（项目内副本+校验、源缺失拒绝、超限拒绝）、提取 7（txt、csv、docx/xlsx/pptx 真实产物、真实 PDF 文本、伪造扩展名拒绝、超限、ZIP 炸弹）全部通过；
- `pnpm typecheck`、`pnpm lint`、`pnpm build`、`pnpm audit:platform`、`pnpm verify:handoff`、`git diff --check` 全部通过；
- 全量 Vitest：785/786 通过，唯一失败仍为工作区既有 Vidu 未提交改动（`vidu-text-video-adapter.test.ts`），与本 PR 无关。

## 四、未完成项与阻断项

- 消息附件接线、IPC/preload、识图上下文、对话页 UI 未启动（PR3/PR4）；
- 扫描 PDF 的 OCR、加密 PDF 解密、更多格式（doc/rtf/odt）不在 v1；
- PLANS.md 登记继续等待负责人既有 Vidu 改动提交后一并补充。

## 五、下一步建议

1. 项目负责人验收并合入 `develop`（保留本地与远程分支）；
2. 从最新 `develop` 创建 `feature/chat-office-doc-pr3-session-ipc`，实现会话文档执行（候选/路由/令牌/提交/取消/重试/恢复）、附件 IPC 与识图上下文接入。
