# 新会话系统未完成项目人工验收手册

本文用于在隔离项目和隔离用户数据目录中执行人工验收。人工验收必须同时观察界面、执行记录和本地文件；只看到“生成成功”不能证明恢复、幂等或数据一致性成立。

## 0. 安全基线

1. 建立专用测试项目，例如 `Office-Agent-Acceptance-YYYYMMDD`，不要使用真实用户项目。
2. 关闭真实项目上的 ThreadFile 写入开关。`UNICOMP_THREAD_FILE_WRITE_PATH=1` 只允许在专门的 Shadow 测试副本中使用。
3. 记录 Git commit、Windows、Electron、Provider、模型、项目 ID、开始时间和测试编号。
4. 备份隔离项目目录和用户数据目录；备份后计算文件 Hash。测试结束后保留备份和报告。
5. 真实 Provider 测试使用最小预算、低成本模型和最小测试资料；凭证只能从安全凭证库读取，不得写入报告、截图或日志。

### Windows 手工关闭 ThreadFile 写入

`electron/ipc/chat-context-ipc.ts` 只在 `process.env.UNICOMP_THREAD_FILE_WRITE_PATH === '1'` 时开启写入。因此可以在启动应用的同一个 PowerShell 中执行：

```powershell
$env:UNICOMP_THREAD_FILE_WRITE_PATH = '0'
pnpm dev
```

或者清除当前 PowerShell 的变量后再启动：

```powershell
Remove-Item Env:UNICOMP_THREAD_FILE_WRITE_PATH -ErrorAction SilentlyContinue
pnpm dev
```

如果之前把变量写入了 Windows 用户环境变量，先清除持久值，再打开新的终端：

```powershell
[Environment]::SetEnvironmentVariable('UNICOMP_THREAD_FILE_WRITE_PATH', $null, 'User')
```

如果通过 VS Code launch/task、批处理或 CI 启动，删除其中的 `UNICOMP_THREAD_FILE_WRITE_PATH=1`；`scripts/run-dev.mjs` 会把父进程环境传给 Electron 子进程。关闭旧窗口并停止旧的 Vite/Electron 进程后再启动，因为 Runtime 只在注册 IPC 时读取一次环境变量。

验证方式：

```powershell
if ($env:UNICOMP_THREAD_FILE_WRITE_PATH -eq '1') { 'ThreadFile write: ON' } else { 'ThreadFile write: OFF' }
```

关闭写入不会删除已有的 `项目目录\entities\threads` 文件，也不会关闭只读 Thread 路径；它只阻止后续 `ThreadCommandService`/`ThreadProjectionCoordinator` Shadow 写入。若要同时关闭 Thread 读取，另行将 `UNICOMP_THREAD_FILE_READ_PATH`、`VITE_UNICOMP_THREAD_FILE_READ_PATH` 和 `VITE_UNICOMP_THREAD_READ_PATH` 设为 `0` 或清除，但这不是关闭写入的必要步骤。

每个用例都记录：`pass`、`fail` 或 `blocked`。`blocked` 表示缺少可控故障注入、真实 Provider 能力或负责人批准，不能改写成通过。

## 1. 真实 Provider 工具链边界

当前这次真实生成会话只向模型暴露 `generate_pptx`。它可以一次性生成完整 PPT，但不能在同一用户可见会话中假定存在“读取刚生成 PPT”或“追加/修改页面”的工具。因此下面两项当前应记录为 `blocked`，不能人工伪造为通过：

- 生成后调用 `read_document_structure`；
- 根据读取结果调用 `add_slide`、`update_element` 或其他修改工具。

代码仓库中确实存在这些受控合同，但它们要求已有已验证文档、文档身份/版本和相应读取或写入授权；合同存在不等于当前会话已经向 Provider 暴露。新建 PPT 的真实人工验收目前只覆盖 `generate_pptx`。

### 当前可执行的人工验收

1. 在隔离项目提供完整主题、内容和页数要求。
2. 明确同意生成，执行 `generate_pptx`。
3. 核对最终 PPT、实际页数、Work、Execution、文件 Hash 和重新打开后的会话记录。

通过标准是一次生成闭环完整且没有重复 Work。你刚刚完成的真实 PPT 生成属于这一项。

### 后续工具链验收条件

只有在一个“已有已验证 PPT + 明确读取/编辑授权”的会话中实际看到 `read_document_structure`，并在读取后看到受控编辑工具时，才执行连续 Tool Calling 验收：

```text
读取结构 → Observation → add_slide/update_element → Observation → 最终回复
```

届时还要核对同一 Agent Run/Response Execution、连续序号、版本递增、单次 Work 登记、实际 PPT 内容和重新打开后的结果。如果工具列表仍只有 `generate_pptx`，该用例继续保持 `blocked`。

## 2. 取消、失败和恢复

分别执行三次：模型流式输出期间取消、文档工具执行期间取消、工具失败或超时。

### 操作

1. 启动一个需要较长输出或文档生成的任务。
2. 在目标阶段点击“停止”，等待界面出现终态。
3. 记录 Response Execution、Agent Run、消息状态、Document Task、Work 和 Provider 请求次数。
4. 重启应用并重新打开该会话。
5. 对可证明“尚未产生副作用”的任务，使用“继续原任务”；对未知结果，先核对并关闭，确认系统不会自动重发。
6. 重新检查 Provider 请求次数、文件数量、Work 数量和会话消息数量。

### 通过标准

- 取消后不会继续产生新的工具副作用；
- 已生成且已登记的文件保留，未完成文件不能被标记为正式 Work；
- 可恢复任务创建新的受控 child Run/Response，不复用旧执行身份；
- 未知结果进入 `needs_reconciliation` 或等价冻结状态，不自动重试；
- 重启前后没有重复消息、重复 Work 或重复计费请求；
- 失败、取消、interrupted 的 UI 状态与持久化状态一致。

手动点击停止不能单独证明网络超时；没有可控超时故障注入时，超时项应标记为 `blocked`。

## 3. 崩溃恢复

只对隔离测试应用执行。记录 Electron 主进程 PID，确认不会误杀其他 Electron 应用。

### 操作

在三个边界各执行一次：Provider 请求尚未发出、Provider 已开始流式输出、文档文件已经出现但正式登记尚未确认。第二个边界最容易人工观察；第一和第三个边界需要开发测试开关或可控断点，不能靠猜测。

1. 启动测试任务并记录当前 Run、Response、消息和文件状态。
2. 在目标边界结束测试 Electron 进程，不点击 UI 的停止按钮。
3. 重新启动应用并打开相同项目和会话。
4. 查看会话状态、Agent Session、Response Execution、Document Task、Work、Trace 和 Provider 请求记录。
5. 重复重启一次，检查恢复是否幂等。

### 通过标准

- 未提交请求可以安全本地收尾，允许继续时只产生一次新请求；
- 已提交但结果未知的请求被冻结，不能自动重发；
- 已知本地文件经过校验后保留，不能凭文件存在直接宣称生成成功；
- 重启两次不会新增重复消息、工具调用、Work 或计费请求；
- 租约、owner、epoch、预算和恢复令牌没有被无条件重置；
- 恢复失败时进入可见的核对/只读降级状态，不静默丢数据。

## 4. 长会话、分页和项目隔离性能

### 操作

1. 用隔离数据生成至少 1,000 条消息；正式性能基线建议使用 5,000 条消息、3 个会话。
2. 开启 Thread 只读路径：`VITE_UNICOMP_THREAD_READ_PATH=1` 或 `VITE_UNICOMP_THREAD_FILE_READ_PATH=1`。不要开启生产写权威。
3. 使用 DevTools Performance 或 CDP 记录：打开会话到首条消息显示的时间、Summary 请求、首屏 Item Page 请求、读取更早消息请求、IPC payload 大小、长任务和 DOM 行数。
4. 连续上翻触发分页，确认每页 Item 数量受限，且 Item ID 没有重复或乱序。
5. 切换项目 A → B → A，确认消息、草稿、Trace 和活动任务不串项目。
6. 用同一数据关闭 Thread 路径再测 Legacy，保留两套结果作为对照。

### 通过标准

- Thread 首屏只请求 Summary 和首屏 Item Page，不读取全量历史；
- DOM 行数受 VirtualMessageList 控制，不随总消息数线性增长；
- 上翻只追加缺失页，不重复写入已有 Item；
- 项目切换不显示另一项目的消息或任务；
- 首屏、分页 p50/p95、主线程长任务和 IPC 字节量达到负责人批准的目标。

如果尚未批准具体毫秒阈值，只能报告相对 Legacy 的基线改善，不能宣称“性能验收通过”。当前 Electron 脚本已能生成可重复的 Summary/Page/虚拟列表数据，但它属于合成数据验收，不替代真实长会话人工测量。

## 5. 历史 Conversation 迁移与对账

迁移只能在 Legacy 文件的隔离副本上执行。

### 操作

1. 复制 `entities/conversations.json`、附件、文档 Work、Response、Agent Run 和相关项目元数据到测试目录，并保存源文件 Hash。
2. 使用现有 `LegacyFileMigrationRunner` 和 `LegacyThreadMigration` 执行迁移；不要直接复制 JSONL 或手工修改 ThreadFile。
3. 检查 Migration Ledger、Commit Journal、Manifest、Snapshot 和 Thread Item/Turn 文件是否生成。
4. 对每个会话逐项对账：标题、项目 ID、消息顺序、消息 ID、正文、reasoning、附件、状态、失败原因、文档状态、Work ID、Execution ID、Agent Run ID、createdAt/updatedAt。
5. 对源文件重复运行迁移，确认幂等；修改测试副本后再运行，确认差异被报告而不是静默覆盖。
6. 用 Thread 只读路径打开迁移结果，比较 Legacy 与 Thread 的 Summary、Item Page 和完整读取结果。

### 通过标准

- 源文件、Ledger、Commit Journal、Manifest 和 Snapshot Hash 能互相验证；
- 没有缺失、额外、重复或跨项目 Item；
- `interrupted`、`failed`、`cancelled`、未知结果和活跃任务状态没有被错误转换；
- Attachment、Document、Work、Response、Agent Run 引用全部可追溯；
- 第二次迁移不增加 Item、Turn、Work 或消息；
- Shadow Compare 零差异，或每一条已批准的兼容差异都有记录。

任何对账失败都应删除隔离目标并从备份重建，不能在真实用户数据上“边迁移边修”。

## 6. Thread 生产 Cutover

Cutover 不是普通人工点选项，不能因为 Thread 页面能读取或一次 PPT 成功就通过。

必须先完成并留档：迁移全量对账、Shadow Read 连续观察、真实 Provider 矩阵、连续 Tool Calling、取消/恢复、崩溃恢复、备份恢复演练、无活跃执行、回滚演练和负责人单独批准。批准后才可以在独立发布窗口切换存储权威；切换前保存 Legacy 只读备份和当前 Thread Manifest/Journal Hash。

Cutover 后第一批只允许小范围、可回滚的灰度项目。发现 Summary/Item/Work/Execution 任一差异，立即关闭新写入、保留现场证据并按回滚方案恢复 Legacy；不得直接删除 Thread 数据或强制覆盖两边。

## 7. 证据记录模板

```text
testId:
date/time:
gitCommit:
projectId:
profile/dataBackup:
provider/model:
flags:
operation:
expected:
observed:
executionId/agentRunId/workId:
requestCount:
artifactHash:
ledger/manifest/journal:
result: pass | fail | blocked
failureEvidence:
operator:
```

当前负责人已确认的“真实调用成功生成 PPT”应填写为单次真实 PPT 生成证据；其余项目必须按上述独立用例完成，不能合并成一个笼统的“真实调用成功”。
