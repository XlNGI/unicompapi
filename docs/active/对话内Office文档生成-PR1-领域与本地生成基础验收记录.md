# 对话内 Office 文档生成｜PR1 领域与本地生成基础验收记录

日期：2026-08-22

分支：`feature/chat-office-doc-pr1-domain-generator`

基线：`develop@1271be6`

状态：本 PR 满足批准范围与工程门禁，等待项目负责人验收后合并 `develop`。

## 一、批准边界

PR1 只实现领域契约与本地生成/登记基础：消息文档结果字段、`document_generation` 任务快照、大纲解析器、Office 生成器、本地执行→校验→登记管线。不接入对话页 UI、模型调用、附件解析、识图或 IPC（分别属于 PR2—PR4）。本 PR 不调用真实服务商、不读取凭证、不产生收费请求；不修改 Vidu 相关代码与既有未提交改动。

## 二、实际修改

- 领域层：
  - 新增 `document-generation.ts`：`word|excel|ppt` 枚举、扩展名映射、`DocumentMessageResult` 解析与严格校验；
  - `conversation.ts`：assistant 已完成消息支持可选 `documentResult`（旧数据无字段仍兼容，白名单校验同步扩展；用户消息与非完成态禁止携带）；
  - `task.ts`：新增 `document_generation` 提交快照与 `createDocumentTask`（kind/title/contentFingerprint/draftRevision 冻结）；
  - `register-work.ts`：`registering_work` 门禁由“必须有 exportPlanId”泛化为“outputFileId 必须关联已校验文件”，视频导出不受影响，文档本地产物可登记。
- 平台层（新增 `src/platform/documents/`）：
  - `document-outline-parser.ts`：模型 JSON 大纲解析与边界校验（非法 JSON/类型/篇幅/表格形状均返回 `document_invalid_outline`）；
  - `office-document-generator.ts`：docx/exceljs/pptxgenjs 本地生成，文件名清洗 + 时间戳，写入项目 `files/documents/`；
  - `document-generation-runner.ts`：Task→Execution（`queued→validating_sources→preparing_media→encoding→writing_file→verifying_file→registering_work→completed`）→ SHA-256 校验 → `registerWork(mediaKind: 'document')`，失败只落 failed 终态、不登记作品。
- 读模型与校验：`entity-validators.ts` 支持 `document_generation` 任务；`global-read-model-controller.ts` 任务摘要区分文档生成来源。
- 依赖：`docx@9.7.1`、`exceljs@4.4.0`、`pptxgenjs@4.0.1`（运行期，仅主进程使用）、`adm-zip@0.6.0`（测试）。

## 三、验证结果

- 新增测试 21 项：领域 8（消息结果兼容/拒绝、任务快照）、大纲解析 6、生成器 4（三种真实产物 + ZIP 结构 + xlsx 读回）、执行管线 2（成功登记、写盘失败不登记）、作品登记扩展 1，全部通过；
- `pnpm typecheck`、`pnpm lint`、`pnpm build`、`pnpm audit:platform`、`pnpm verify:handoff`、`git diff --check` 全部通过；
- 全量 Vitest：775/776 通过，唯一失败为 `tests/platform/vidu-text-video-adapter.test.ts`（期望 `accepted_async`、实得 `submission_outcome_unknown`），属于工作区既有未提交 Vidu 参数改动，本 PR 未触碰相关文件，非本 PR 引入。

## 四、未完成项与阻断项

- PR2 附件登记与文件解析、PR3 会话文档执行与 IPC、PR4 对话页 UI、PR5 版式引擎均未启动；
- PLANS.md 登记待负责人既有 Vidu 改动提交后一并补充，避免混合未提交变更；
- Vidu 未提交改动导致的单项测试失败需负责人确认处理方式。

## 五、下一步建议

1. 项目负责人验收并合入 `develop`（保留本地与远程分支）；
2. 从最新 `develop` 创建 `feature/chat-office-doc-pr2-attachment-parser`，实现附件登记与文件解析。
