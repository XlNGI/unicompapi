# 阶段 9 E6｜Windows 文档产物烟囱验收记录

日期：2026-09-01
分支：`feature/phase9-document-intent-plan`
状态：自动化 preflight 完成；Windows Electron/Office GUI 人工验收尚未签署

## 一、已执行的自动化 preflight

- 在当前 Windows 环境使用现有生成器分别生成真实 `.docx`、`.xlsx`、`.pptx` 临时产物。
- 对每个产物检查文件存在、大小一致、SHA-256 一致和 ZIP/OOXML 必需部件：
  - Word：`word/document.xml`；
  - Excel：`xl/workbook.xml`；
  - PPT：`ppt/presentation.xml`。
- 通过 `publishDocumentCandidate` 注入端口执行 revision、幂等、临时包校验和原子发布，确认三种格式均返回 `published`。
- 测试使用系统临时目录，测试结束自动清理，不写入项目正式作品库。

## 二、验证结果

- `pnpm.cmd vitest run tests/platform/phase9-e6-document-e2e.test.ts`：1/1 通过，覆盖 Word/Excel/PPT 三种真实产物。
- 完整 `pnpm.cmd test`：168 个 Vitest 文件、1013 个测试全部通过。
- `pnpm.cmd typecheck`：通过。
- `pnpm.cmd lint`：通过。
- `pnpm.cmd build`：通过。
- `pnpm.cmd audit:platform`：通过，未发现平台假设违规。
- `pnpm.cmd verify:handoff`：通过，权威交接资源校验无失败。
- `git diff --check`：通过。
- 相关测试：[phase9-e6-document-e2e.test.ts](../../tests/platform/phase9-e6-document-e2e.test.ts)。

环境探测：当前工作区未发现 `WINWORD.EXE`、`EXCEL.EXE` 或 `POWERPNT.EXE`，本轮无法执行 Office GUI 打开、修改和保存验收；该项保持未完成并等待具备 Office 的 Windows x64 验收机。

## 五、2026-09-01 Excel 实际验收失败与修复

负责人实际生成工资表时，DeepSeek 返回的 Excel JSON 使用了合法的 JSON 数值单元格（金额、年龄），并使用 `footers.label/values` 表达汇总行。旧解析器只接受字符串行且未处理 footer，因此在写入 Excel 文件前返回 `invalid_outline`，界面显示“AI 内容格式异常，文档未生成”。

修复内容：

- Excel 表格单元格有限接受数值并归一化到内部字符串契约；Word/PPT 的严格字符串校验保持不变。
- 受控 `footers` 归一化为表格末尾的“合计”行。
- 工资模板金额字段不再写入“示例基本工资1”等文本；实发工资和合计行由 Excel 公式计算。
- 补齐表头样式、列宽、冻结首行和筛选，避免内容横向挤压。

回归结果：解析器与生成器定向测试 59/59 通过；完整测试 168 个文件、1014/1014 通过；typecheck、lint、build、平台审计、交接校验和 diff 检查通过。该修复只对后续重新生成的文件生效，负责人仍需在最新构建中重新执行 Excel 创建和 Office GUI 验收。

## 六、2026-09-01 13:59 模板样式反馈与解析修复

负责人反馈文件 `部门员工工资表（模板）-20260901055906-ec9236d7-315f-4a02-a0b9-f9a56126d435.xlsx` 样式异常。只读检查确认该文件实际使用区域退化为 `A1:A43`：标题、列名和示例值被纵向写入单列，且没有表头样式、公式、冻结首行或筛选。回溯对应 assistant 原文后确认，响应在 `rows` 结束处括号错位，导致严格 JSON 解析失败；通用恢复器随后只保留字符串，丢失了表格结构。

本轮修复：

- Excel 解析器在严格 JSON 失败时，仅针对可识别的 `rows`/表格尾部括号错位尝试一次受控修复，修复后仍完整经过 Schema、长度和类型校验；无法安全修复的响应继续走原有失败路径。
- 工资表检测到基本工资、绩效、补贴、扣款和实发工资列时，实发工资行统一写入公式；模型返回数值示例时不再出现实发工资整列空白。
- 新增 malformed Excel rows 回归和 numeric payroll formula 回归；重新构建 `dist-electron`，未修改负责人原始文件。

验证：解析器与 Excel 生成器定向测试 61/61 通过，`pnpm.cmd build` 通过。待负责人完整退出并重启最新 Electron，重新发送同一句工资表请求，并用 Excel 打开确认 10 列表格、蓝色表头、公式计算、冻结首行、筛选和说明文本；该人工项完成前 E6 仍不收口。

## 七、2026-09-01 14:25 PPT 解析反馈

截图对应的失败请求为《AI 在企业运营中的应用》PPT，而非工资表。模型返回的 8 页 JSON 结构完整，但使用了 `summary/detail/roadmap/risk` 等语义 `pageKind` 标签；渲染器原先只接受内部枚举，因而在生成前返回 `invalid_outline`。

已增加受控别名归一化：`summary/detail/risk` 映射为 `insight`，`roadmap/action` 映射为 `process`；未知标签仍会被拒绝。14:34 重试时模型使用了新增的 `action` 语义标签，现已纳入同一受控映射。对应原始 8 页响应离线重放解析通过，`dist-electron` 已重新构建。负责人需完整退出并重启 Electron 后重新发送 PPT 请求，人工确认页面布局、字体、溢出、图表/表格和最终文件卡片；E6 仍待 Windows GUI 签署。

局部改稿边界修复：生成服务现在根据用户请求中的“第 N 章/节/页/部分”解析目标范围，将非目标章节从上一版大纲恢复，目标章节仅采用模型返回的语义内容，并保留原章节标题、层级和页面类型。该保护避免了“改第二章”被模型扩写成整篇内容重写；交付仍为新版本文件，原文件保持不变。

二次修复：局部改稿提示新增面向非技术管理者的语义验收规则，要求目标章节围绕业务目标、经营影响、决策依据、风险和行动重写，并明确删除不影响决策的实现细节；异常重试生成继续携带父版本。PPT 生成器新增安全的父版本文字补丁：当目标章节页面数量和文字节点数量均匹配时，以原 PPTX 为基底只替换目标页面文字，其他页面的 OOXML 和资源关系不重新生成；无法安全匹配时回退到完整生成，避免阻断导出。

如果模型返回的目标章节与上一版正文完全相同，应用层会对“面向非技术管理者”请求启用受控白话化兜底（技术术语转换、管理影响和试点行动补充），防止静默交付未修改内容；非目标章节仍从上一版恢复。

本轮回归：`tests/application/document-drafting.test.ts`、`tests/application/document-generation-service.test.ts`、`tests/platform/document-generation-runner.test.ts`、`tests/platform/document-generation-controller.test.ts`、`tests/platform/office-document-generator.test.ts` 定向测试共 79 项通过；`pnpm.cmd typecheck`、`pnpm.cmd lint`、`pnpm.cmd build` 通过。该代码尚未替代 Windows PowerPoint 人工验收。

新增 PPT 内容修复：针对负责人提供的 `AI 在企业运营中的应用-20260901074245-777034d9-8ef7-4e73-a61a-c1049cf17c3e.pptx`，只读检查发现共 19 页，其中第 12—18 页均为“谢谢”标题下的数据碎片。渲染器现会过滤首个“封面”和末尾“谢谢/感谢观看”装饰 section，避免将装饰节点和尾部错误表格当作正文分页；有实际内容的 `pageKind=section/closing` 页面仍保留。新增回归后定向测试更新为 81 项通过，完整测试、类型检查、lint 和 build 需在本轮代码合并后复跑。该文件保持不变。

本轮复跑：PPT/提示词定向测试 40/40 通过，`pnpm.cmd typecheck`、`pnpm.cmd lint`、`pnpm.cmd build`、`git diff --check` 通过；完整 `pnpm.cmd test` 已通过。修复后的 `dist-electron` 已生成，负责人需重启 Electron 后重新生成同一主题 PPT 进行人工页数、表格完整性和 PowerPoint 打开验收。

## 三、人工验收待办

- Windows x64 Electron 会话内真实自然语言链路。
- 使用 Microsoft Word/Excel/PowerPoint 打开生成和修改后的文件。
- 指定页面/段落/列/单元格修改时，其余内容保持不变。
- 预览渲染、字体、溢出、重叠和布局一致性人工确认。
- 取消、超时、revision 冲突、渲染失败和应用重启恢复。
- 任务中心、作品库和会话文档卡片展示真实结果。
- 负责人签署 Windows 必需矩阵；macOS 继续 `required=false/not_run/deferred`。

## 四、结论

自动化 preflight 证明真实三格式产物可以经过本地包校验、Hash 校验和受控发布合同；这不能替代 Office GUI 和 Electron 端到端人工验收，也不代表 E6 已完成收口。
## E6 回归补充：PPT 表格自动分页

2026-09-01 对负责人提供的新版 PPT（18 页）进行 OOXML 与渲染检查，发现第 12 页和第 16 页仅包含“续 2”标题及页码，实际表格内容为空。根因是应用层已经通过 `splitTableRows` / `splitTableColumns` 拆分表格，底层 pptxgenjs 又触发了自动分页，生成重复的空白 continuation slide。

修复：在 `renderDataPage` 的 `slide.addTable` 选项中显式设置 `autoPage: false` 与 `autoPageRepeatHeader: false`，确保表格只按应用层分页结果写入当前页面。新增回归覆盖普通表格、宽表分栏和稠密多行表格，验证不存在空白“续 2”页面且单元格内容不丢失。

本轮自动化验证：`office-document-generator.test.ts` 定向测试通过；完整 `test`、`typecheck`、`lint`、`build` 与 `git diff --check` 需在本次代码合并后复跑。原始 PPT 文件未覆盖，需完整重启 Electron 后重新生成并由 Windows PowerPoint 人工确认页面、表格、字体、溢出和文件打开行为；人工验收签署前 E6 不标记为完成。
## E6 UI 回归补充：文档大纲不直接展示

截图复核发现，文档请求在模型流式返回 JSON 大纲期间，聊天页曾将内部 JSON 当作普通 Markdown 展示，并显示“正在回答”。现已增加 `documentResponseActive` 状态：文档编排期间只显示受控的 Office 生成进度文案，模型 JSON 仍仅供本地解析和文件生成使用；生成完成后显示文档卡片。新增 UI 合约测试覆盖该行为。该改动不改变原始消息存储和文档生成输入。
