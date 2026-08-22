# 对话内 Office 文档生成｜企业级实施方案（定稿 v1）

日期：2026-08-22

状态：方案定稿，待项目负责人批准后按 PR1—PR5 分阶段实施；本计划为唯一工程侧实施依据，不覆盖任何权威 UI 原件。

## 一、目标与核心体验

用户在对话输入区输入需求（可拖入图片/文档作为依据），发送后会话内直接产出对应的 Office 文档（Word/Excel/PPT）：assistant 消息依次展示真实阶段（解析需求 → 撰写大纲 → 生成本地文档），完成后呈现文档卡片（打开、在作品库查看、重试），模型生成的大纲正文保留为可折叠内容。产物必须经本地 SHA-256 校验并登记为项目正式作品（`mediaKind: document`），进入任务中心与作品库。

## 二、现状基线（复用点）

- 会话链路已具备：Conversation/Message 状态机、ConversationResponseExecution 与统一协调器、候选/路由/一次性令牌/授权门禁、项目上下文选择、停止/重发、启动恢复屏障。
- 本地产物登记链路已存在：视频导出即“Task → Execution（`queued→writing_file→verifying_file→registering_work→completed`）→ NodeFileStatusProbe + SHA-256 → `registerWork`”；`MediaKind` 已含 `document`。
- 非流式文本调用已存在：`submitPromptOnce`（`text_reasoning` 路由）；图片识别已有 `image_understanding` 路由与豆包视觉等多模态适配器。
- 消息附件契约已预留：`asset`/`file_reference` 两类，严格项目作用域校验；当前附件按钮禁用，本方案批准启用。

## 三、范围与边界

- 纳入：对话内直出文档、拖拽发送附件、识图、读文件、版式引擎与内置主题、本地图片配图、任务/作品登记。
- 明确不做（v1）：文档创作独立页、草稿复用、模板库与上传风格迁移、对话式多轮改稿、AI 生图配图、联网搜图、关键词检索/RAG、登录/会员/云同步、安装包/签名/公证/生产更新（阶段 10 事项）、macOS 实机验证（维持 `not_run/deferred`）、Vidu（预算已用尽）。
- 已登记决策：本方案覆盖 AGENTS.md“不得把对话页做成直接生成入口”旧规则，由项目负责人 2026-08-22 确认，写入 PLANS.md 与验收记录。

## 四、总体架构与关键设计

1. 文档类型确定：输入区类型下拉（自动 / Word / Excel / PPT），默认“自动”；自动时模型在结构化输出中返回 `kind`，主进程校验枚举合法性。
2. 模型输出契约：系统提示要求返回严格 JSON——`{ "kind", "title", "sections": [{ "heading", "level", "blocks": [paragraph|bullets|numbered|quote|table] }] }`；解析失败返回安全错误码 `document_invalid_outline`，不猜测、不补写。
3. 附件与读文件：拖拽/对话框选择 → `webUtils.getPathForFile` 取路径 → 复制进项目目录登记为素材（项目内副本，文件随项目备份/校验/迁移）→ 主进程解析服务按 fileId 提取内容；白名单 txt/md/csv/docx/pdf/xlsx/pptx，魔数校验、大小/页数/行数上限、压缩炸弹与宏/加密文档拒绝、扫描 PDF 明确提示不支持 OCR；renderer 只拿到截断预览与统计，全量文本只在主进程组装进提示词。
4. 识图：消息带图片附件时走 `image_understanding` 候选路由选用户配置的视觉模型，分析结果作为回复正文与生成依据；调用走确认门禁，不写死模型。
5. 版式引擎（v1.1）：6 种参数化版式（封面/目录/要点/双栏/图文/结尾）× 2–3 套内置主题；模型契约扩展 `pageType`/`image`/`chart`；图片先支持项目本地图片与手动选择，AI 生图后置；图表用 shape 直接渲染。
6. 本地生成与登记：docx/exceljs/pptxgenjs 仅主进程使用，文件名 = 清洗后标题 + 时间戳 + 扩展名，写入项目 `files/documents/`；执行复用本地导出状态机，校验通过才 `registerWork(mediaKind: 'document')`。
7. 会话投影与 IPC：assistant Message 新增可选 `documentResult { workId, fileName, kind, sizeBytes }`（可选字段，旧数据免迁移）；新增 document-generation 通道组（候选/准备/提交/取消/查询/打开文档），renderer 只传 id 与文本，不接触绝对路径、Hash、凭证、endpoint。

## 五、分阶段实施（小 PR，逐项验收）

- PR1｜领域与本地生成基础：Message 可选字段与校验白名单、`document_generation` Task/Execution、大纲解析器、Office 生成器、本地登记管线；测试覆盖解析、三格式真实产物、文件名清洗、校验失败不登记。
- PR2｜附件登记与文件解析：受控附件导入（项目内副本）、文件内容提取服务与 DTO、格式/大小/安全校验；测试覆盖各格式夹具、拒绝用例、性能上限。
- PR3｜主进程会话文档执行与 IPC：候选/路由/授权/令牌、文档响应执行（大纲 JSON → 生成 → 校验 → 登记 → 消息终态）、取消/重试/恢复、识图上下文接入、IPC 与 preload、错误码；用假文本适配器做集成闭环与故障注入测试。
- PR4｜对话页 UI：生成文档模式与类型下拉、拖拽发送与附件摘要、真实阶段状态文案、文档卡片（打开/作品库/重试/失败原因）、未打开项目与归档会话禁用态；UI 契约测试 + Windows Electron 真实生成三种文档人工验收。
- PR5（v1.1）｜版式引擎与主题：版式库 × 内置主题、`pageType`/`image`/`chart` 扩展、本地图片插入与图表渲染；验收为“同一大纲不同主题”产物断言与页面截图对比。
- 后续候选（需批准）：AI 生图配图、关键词检索（BM25）→ 向量 RAG、对话式改稿、模板上传风格迁移。

## 六、测试与验收门禁

- 每个 PR 全量门禁：Node/UI + Vitest 全量测试、`typecheck`、`lint`、`build`、`audit:platform`、`verify:handoff`、`git diff --check`；从最新 `develop` 创建 `feature/*` 分支，合并后保留本地与远程分支。
- 专项测试：Message 旧数据兼容；大纲合法/非法 JSON 边界；docx/pptx ZIP 结构与 xlsx 读回；磁盘写失败与校验失败不登记；附件伪造扩展名/超限/加密/宏/ZIP 炸弹/路径逃逸拒绝；取消贯穿 AbortController；重启后活动执行重新发现且不重复提交；UI 契约断言类型下拉、拖拽、文档卡片与禁用态。
- 手工验收（Windows x64）：真实文本模型生成三种文档并打开；拖入图片/文档后识图与读文件生效并影响生成内容；作品库/任务中心出现 document 作品；未打开项目时入口禁用。
- 记录：每 PR 写 `docs/active/` 验收记录并在 PLANS.md 登记实际修改、验证结果、未完成项与下一步。

## 七、安全与失败模式

- renderer 无路径/Hash/凭证/endpoint；附件只存 fileId/assetId；解析对象必须是已登记项目素材；日志只记格式/大小/耗时，不记内容。
- 失败映射：模型失败/超时、大纲非法、磁盘只读/空间不足、校验失败分别落到明确失败码与消息终态；进程退出后执行标记 `interrupted/recovery_required`，恢复只提示不自动重发；一次性令牌防重复提交；打开文档时文件缺失返回真实错误。
- 模型外发（文本/识图）始终走既有候选与确认门禁；AI 生图不默认开启。

## 八、已确认决策与假设

1. 文档类型：自动判断 + 手动指定，默认自动。
2. 附件存储：项目内副本。
3. 批准启用“原生受控附件端口”。
4. 新增依赖：生成 `docx`/`exceljs`/`pptxgenjs`，解析 `mammoth`/`pdfjs-dist`/`jszip`，均为主进程运行期依赖；默认上限（文件 20MB、PDF 300 页、xlsx 5 万行、pptx 100 页）作为可调常量登记。
5. 本特性为独立功能系列，不属于阶段 10 定义范围；现有 Vidu 未提交改动保留不动，PR1 从最新 `develop` 起分支。
