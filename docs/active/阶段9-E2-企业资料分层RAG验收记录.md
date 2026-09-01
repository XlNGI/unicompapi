# 阶段 9 E2｜企业资料分层 RAG 验收记录

日期：2026-09-01

分支：`feature/phase9-document-intent-plan`

基线：E1 实现工作区（`feature/phase9-document-intent-plan`）

状态：E2 已完成本地 BM25 分层资料合同与可重建索引实现；向量索引、embedding 服务和联网搜索仍为 `planned/not_started`。

## 一、实际修改

- 扩展 `RagContextChunkDto`，统一返回 `chunkId`、`sourceId`、`sourceKind`、来源名称、内容 Hash、索引版本、得分、排名和可选页/工作表/章节位置。
- `RagRetrievalService` 增加统一 `DocumentRetrievalSource`/`DocumentRetrievalSourceProvider` 接口，当前附件使用 `project_attachment`，产品、品牌、模板和历史确认资料可通过受控 Provider 接入。
- 增加 `buildIndexSnapshot`，快照记录项目、`document-bm25-v2`、构建时间、片段和来源失败；索引从当前项目源文件即时重建，不绑定数据库或 embedding 服务。
- 片段 ID 由来源、片段序号和内容 Hash 派生；片段 Hash 使用 SHA-256；长段落按固定大小切分，避免单段超过分块上限。
- 附件按稳定 ID 排序；单个附件解析失败或某个企业资料 Provider 失败时记录失败 DTO 并隔离，其他来源仍可检索；删除或变更源文件后下次快照自动反映，不保留孤立索引。
- 增加 `evaluateRetrieval`，输出 Recall@k、MRR、空结果率、引用准确率和资料支持率，供脱敏黄金样本评测使用。
- 未新增向量数据库、embedding 模型、联网搜索或外发能力；BM25 继续作为当前唯一可用检索和回退路径。

## 二、验收结果

- RAG 定向测试 4 项通过：附件检索、空结果、企业资料 Provider 统一接入、Provider 失败隔离和快照重建元数据。
- 检索评测测试 2 项通过：Recall@k、MRR、空结果率、引用准确率、资料支持率和空评测集。
- `pnpm.cmd exec vitest run tests/platform/rag-service.test.ts tests/platform/retrieval-evaluation.test.ts` 通过，6 项测试全部通过。
- `pnpm.cmd typecheck` 通过。
- `pnpm.cmd lint` 通过。

## 三、未完成项与边界

- 当前索引是按请求从本地源文件重建的内存 BM25 索引，尚未实现持久化索引、增量索引任务或向量检索。
- 向量检索必须先完成脱敏 Recall/MRR/延迟/引用准确率评测，再单独批准 embedding 模型和本地可重建索引方案；不预先绑定具体向量数据库。
- E3 受控联网搜索、E4 内容/页面计划、E5 Agent 工具循环和 E6 Windows 端到端验收尚未启动。
- 不读取真实凭证、不联网、不产生收费请求，不声明向量 RAG 或联网搜索已支持。

## 四、下一步

从最新 `develop` 创建 E3 分支前，先由负责人确认是否启动联网搜索范围；若启动，必须先完成授权、外发脱敏、域名策略、缓存、来源引用和离线回退设计。
