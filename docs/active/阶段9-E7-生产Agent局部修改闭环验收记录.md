# 阶段 9 E7｜生产 Agent 局部修改闭环验收记录

日期：2026-09-02  
分支：`feature/ppt-page-kind-normalization`  
状态：`approved/in_progress`；自动化生产文件闭环与 Windows Office 人工视觉验收已完成，E7 尚未通过完整验收

## 一、范围与边界

本增量复用现有对话页、文档工作区、E1-E6 合同和正式文档 Runner，不新增一级页面，不启动阶段 10，不联网，不读取凭证，不产生收费请求。当前工作区已有 PPT 页面类型兼容和局部修改修复，本增量在保留这些未提交改动的基础上继续接线。

## 二、实际修改

- Application 层将明确的清空请求和指定章节改写归一化为 `clear_section` / `replace_section`。Provider 只能提供候选章节内容，工具 ID、章节索引、父 Work、文件路径和执行顺序均由应用层决定。
- 继续使用 `runDocumentAgentLoop` 的白名单、最大步数、预算、总超时、重复诊断和 AbortSignal 取消合同；工具观察保持递归脱敏。
- `office-document-tool-executor` 支持从真实 DOCX/XLSX/PPTX 读取结构并在独立临时包中清空或替换目标章节。输入只接受项目内相对路径或 Runner 已解析的受控父文件，不接受模型路径。
- 结构摘要为每个章节增加 SHA-256 `contentHash`。Runner 在发布前重新读取父文件和临时文件，校验目标实际变化、标题/层级/页面类型保留、非目标章节 Hash 不变。
- 通过 `parentWorkId` 解析父 Work 与 FileReference；临时文件仍经过 OOXML 必需部件、关键内容、大小、SHA-256 和本地可用性校验，原子 rename 后才登记 FileReference 与新 Work。失败、取消或越界变化不会登记新 Work，旧文件保持不变。
- Office 映射能力不足时失败关闭，不再用完整文件重建伪装局部修改成功。
- 局部修订的父 Work、FileReference 或父文件失效时返回 `storage_error` 并失败关闭，不再静默重建整篇文档。
- 多目标局部修订限制为 1-8 个去重目标并按顺序原子应用；NewAPI/DeepSeek 支持受控文档工具定义序列化和工具调用增量校验，当前响应生命周期缺少工具结果回传时安全拒绝执行；新增本地 LibreOffice/Poppler 渲染适配器，渲染器不可用时失败关闭。

## 三、自动化验证

- E7 定向回归：Application 清空/改写工具序列、结构化 `replace_section`、真实 DOCX 清空与改写、真实 XLSX/PPTX 清空、项目内路径拒绝、Runner 父子 Work 原子发布均通过。
- `pnpm.cmd test`：Node/UI 合同全部通过（338/338）；Vitest 172 个文件、1062 项通过，0 失败、0 跳过。
- `pnpm.cmd typecheck`、`pnpm.cmd lint`、`pnpm.cmd build`：通过。
- `pnpm.cmd audit:platform`：通过，0 违规。
- `pnpm.cmd verify:handoff`：通过，0 失败。
- `git diff --check`：通过。

## 四、Windows Office 与视觉人工验收

- 2026-09-02，负责人明确确认真实生成的 DOCX/XLSX/PPTX 可在 Windows Word/Excel/PowerPoint 中打开、保存并重新打开，未发现打开或保存异常。
- 同次确认已完成 PDF/图片导出或渲染检查：字体、截断、溢出、重叠和目标范围均无异常；目标章节/页面/单元格修改未影响非目标内容。
- 本记录依据负责人明确结论登记；当前未附 Office 版本、样例文件名、截图或导出物哈希等独立证据元数据，后续如需发布审计应补充。

## 五、失败矩阵

| 场景 | 当前结果 | Work 登记 |
| --- | --- | --- |
| 非白名单工具或补丁字段 | Schema/工具注册表拒绝 | 否 |
| 绝对路径、目录穿越、格式不匹配 | Platform 路径门禁拒绝 | 否 |
| 目标章节不存在或改写容量越界 | 文件补丁失败关闭 | 否 |
| 父 Work、FileReference 或父文件失效 | `storage_error` 失败关闭，不重建整篇文档 | 否 |
| 多目标超过 8 个或存在重复目标 | 工具/Platform 校验失败关闭 | 否 |
| Provider 返回原生工具调用但无结果回传合同 | `invalid_response` 失败关闭，不执行模型参数 | 否 |
| 本地 Office/PDF/PNG 渲染器不可用或超时 | 渲染校验失败关闭，不登记新 Work | 否 |
| 非目标章节 Hash 变化 | Runner `verification_failed` | 否 |
| 目标 Hash 未变化 | Runner `verification_failed` | 否 |
| 取消、超时、预算、重复诊断 | Agent/Runner 结构化终止 | 否 |
| 临时包、OOXML、内容或 Hash 校验失败 | Runner 清理临时/最终文件 | 否 |
| 发布后登记前取消或失败 | 清理 FileReference 与最终文件 | 否 |

## 六、未完成项

- Provider 原生 tool calling 尚未接入。当前生产流程仍由既有对话响应提供候选大纲，再由 Application 层生成受控工具请求；未执行真实 Provider 验证。
- 当前生产补丁完成章节、PPT 页面、Excel 工作表、受控 Word 单段落和 Excel 单元格范围；复杂多目标补丁及图表/关系部件的局部改写仍需独立实现和验证。
- 自动化 `render_preview` / `inspect_layout` 仍未绑定跨平台渲染器；本次视觉结论来自负责人在 Windows Office 中的人工检查。

## 七、结论

E7 已从内存大纲增量推进为真实父 Office 文件到临时补丁、范围 Hash 校验、原子发布和父子 Work 登记的自动化生产闭环，但完整 E7 验收条件尚未满足，状态保持 `approved/in_progress`，不得标记 `passed`。macOS 继续保持 `required=false/not_run/deferred`，阶段 10 未启动。
