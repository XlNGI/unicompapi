# LLM 自主设计与系统忠实执行实施记录

日期：2026-10-14。基线：`develop@4692337`；分支：`feature/llm-autonomous-design`。状态：本轮实现完成，Windows 自动、本地 Office 与隔离 Electron 验收通过。实现提交：`82c2d98`、`01e5f4d`；记录/证据另一个本地提交。

## 授权与范围

负责人要求由 LLM 自主设计，系统根据设计实现，并要求实施记录。范围限于现有 PPT 生产设计链路与对应验收，不优化模板，不重开历史阶段，不覆盖权威交接资料。原工作区有对话进度汇总未提交改动，使用 Codex 管理的隔离工作树；不移动或改写原改动。

## 架构与增量

1. 在唯一生产 Design IR v2 中增加可选 `designTree`，保留旧 v2 的显式兼容。树是受控语义规格，没有文件路径、凭证、工具代码或最终坐标。支持 row/column/grid/overlay、权重、嵌套、跨栏、锚点、相对尺寸、间距和内边距；限制深度 8、节点 96、单容器子节点 24。
2. 全部内容叶必须来自当前页内容引用，并完整覆盖一次。元素/容器样式继承；文字局部强调使用原文 UTF-16 范围，不复制或重写事实。Office 原生字重的执行范围明确为普通/粗体。
3. 设计树由约束链路进入独立的确定性求解器；显式比例与结构不被旧兼容修复替换。字号缩小须遵守设计容差。生产几何仍只持久化在 Production Layout IR，Render Plan 为只读投影。
4. 图片使用 Host 投影的 `image-N` 语义别名，读取已授权本地文件、检查尺寸/格式/预算，以精确嵌入字节的 SHA-256 绑定；模型看不到绝对路径，writer 不下载素材。持久计划只保留别名、digest、比例和 fit。
5. 规划输入增加结构化设计反馈；修正保持内容事实、全篇设计和非目标页，复用现有取消、超时和总预算。主观审美与多模态审核没有实际运行时不能声明通过。

## 已实现的行为

- 模型在 `designTree` 中自主组合内容、图形、图片和容器。Host 不按 pageRole 重新选择构图；节点权重决定区域比例，grid 支持列跨栏，overlay 支持九种锚点和相对尺寸。可有意叠放背景形状；正文和图片前景重叠被拒绝。模型只使用页面内容引用与语义节点键，实际页面/元素身份由 Host 赋予。
- 自主页使用显式 palette，并取消旧页角色对正文填充/边线的隐式覆盖。字体、字号、普通/粗体、行距、字距、对齐和表面绘制贯通；显式字号默认不缩小，只有 `minimumFontScale` 声明的容差允许调整。节点样式按作用域继承，容器表面不作为子节点填充继承。局部文本样式使用已验证的原文范围，文本内容保持唯一。
- 图表可在同一事实数据上选择 bar/line/pie/doughnut 表现及颜色、图例、数值标签。表现保存在 Layout IR 样式中，canonical content 的事实和原图表内容不被改写。图表不接受无法执行的字距/行距、字重、对齐等请求。
- 本地 PNG/JPEG 通过既有 File/Work 安全路径解析进入 Host，限制单图 20 MiB、总量 80 MiB、24 个素材。模型只收到 `image-N` 和 aspect ratio；计划持久化别名、SHA-256、比例、fit/mask，不包含路径或图片 base64。writer 对绑定 digest/比例核对后嵌入本地字节，执行 contain/cover 和椭圆遮罩。
- `auditPresentationDesignExecution` 在写文件前对求解后的设计与 Layout IR 读回投影逐元素比较几何、样式、内容、图层顺序和背景；摘要写入持久候选计划。该检查证明执行投影没有丢设计，不证明主观审美优秀。
- 新自主规划要求所有页有可执行树。错误 JSON、缺失树、不支持的结构/样式和失败设计均拒绝正式发布；原无模型入口、已提供的旧 v2 与 Host 显式兼容配置保留其既有路径。旧 `visualTreatment` 不允许覆盖自主树，装饰应直接作为节点表达；旧 v2 明确选择的 edge/rule/frame 原语也已贯通，未改变未声明这些原语的旧默认输出。
- 初次规划加最多两次模型修正；编译预检与实际渲染修正共用这个计数。反馈只含安全失败码、目标页和语义节点键，逐次验证全篇视觉系统及非目标页保持不变。失败、取消、未变更修正和不可修复诊断均停止，不重新套模板。候选仍走写前持久计划、QA 收据、Hash、原子发布和唯一 Work 登记；封面/结尾修正记录为 Host 的 system page 稳定身份。

核心文件：[设计树合同](../../src/domain/entities/presentation-design-tree.ts)、[约束求解](../../src/platform/documents/presentation-design-tree-layout.ts)、[编译器](../../src/platform/documents/presentation-render-plan-compiler.ts)、[有限规划修正](../../src/platform/documents/presentation-design-planning.ts)、[生产 Runner](../../src/platform/documents/document-generation-runner.ts)、[执行检查](../../src/platform/documents/presentation-design-execution-audit.ts)。

## 验证与执行日志

| 验收 | 最终结果 |
| --- | --- |
| `tsc --noEmit -p tsconfig.test.json` | 通过，覆盖源码与测试 |
| 全仓 ESLint | 通过 |
| `tsc -b`、Vite build、Electron tsc、模板资产复制 | 通过；保留既有 Vite chunk size warning |
| 平台约束审计 | violations 为空 |
| Node/UI 合同 | 401/401，0 失败/跳过 |
| 串行全量 Vitest | 348 文件、3612/3612，0 失败/跳过 |
| 新增自主合同/构图/规划/生产修正 | 31 项，已纳入完整全量 |
| 编译后生产 Runner 三种方案 | 同等事实，分别 3 页，唯一 Work 1 个，Office/PDF QA passed，PPTX 几何错误 0 |
| 真实 Electron/preload/IPC Mock | 7 次进程内请求，Art Direction 1 次；已登记 PPT 的 3 页自主设计执行摘要 passed，Word/Excel 与 Thread 收据通过 |

完整结果：[validation.json](../evidence/llm-autonomous-design-20261014/validation.json)。详细日志以 `.log.gz` 保存在同目录，逐个验证解压字节与原日志完全一致，并登记原始 SHA-256；保留终端原始空格与行尾，不重写失败输出。

首次完整 Vitest 为 3597 通过、8 失败、7 跳过，原始 [vitest-first-run.log.gz](../evidence/llm-autonomous-design-20261014/vitest-first-run.log.gz) 保留。失败原因包括旧 Art Direction 预算断言、旧“image 不支持”断言、PptxGenJS 全局图表编号导致新测试错误假定 chart1、旧默认装饰被多画以及隔离工作树没有开发 FFmpeg。按实际合同修复：仅显式旧视觉原语才执行新增装饰，未知类型负向测试改为仍不支持的 video，图表按真实 ZIP part 读取；链接已有 `.tools/media-engine` 后环境项全部执行。旧 v2 修正/组织/计划读回夹具明确提供已批准设计；新规划夹具提供自主树。定向 124/124 后重新执行完整全量通过，没有删测试或放宽旧时限。

最初 `pnpm typecheck` 被本机工具包装器转为依赖安装，Electron postinstall 因缺失 checksums.json 失败。改为直接执行现有本地 Node/tsc/Vite/Vitest/ESLint；Electron 使用本机已有缓存 ZIP 解到忽略的 `.tools/electron-native`，未将二进制加入 Git 或生产构建。真实 Electron 用隐藏 Start-Process、等待退出并保存 stdout/stderr；最终退出成功，核对残留 0。Vitest VM 中 PDF.js 原生 ESM 检查有既有 `font_missing` 限制；新增 QA 测试通过原生 Node 子进程执行同一真实适配器，没有把该错误豁免为审美通过。编译后案例与 Electron 的原生 Office/PDF 检查均通过。

案例脚本：[generate-autonomous-design-evidence.cjs](../../scripts/generate-autonomous-design-evidence.cjs)。初跑修复脚本对现有存储导出、File verifying→available 状态转换、Repository save 方法的适配，最终没有绕过文件状态与 Hash 门禁。三组模型输出均为离线合成 fixture，通过真实生产 Runner 和作品仓库；不能用其审美证明真实模型发挥。

案例索引：[cases.json](../evidence/llm-autonomous-design-20261014/cases.json)。65/35 案例保留一条 `visual_crowded_page` warning；占用率以元素边界计算，包含有意背景绘制，该 warning 不构成主观审美结论。三份 PPTX/PDF、九张页面 PNG、Design IR 与 Layout IR 均保存；[同内容设计对照](../evidence/llm-autonomous-design-20261014/same-content-designs.png) 已人工检查，文字完整，图文遮罩与各自构图一致。

原工作区 `feature/chat-progress-summary` 的未提交内容未修改。本轮未合入 develop/main、推送远程、发布或重启用户应用；功能分支和隔离工作树保留。

## 未完成边界

- 真实收费 LLM 的 Schema 成功率、设计多样性与成品审美尚未测试；本轮只使用明确的离线合成输出，真实 Provider 外发 0。
- 多模态成品审美审核未实施，当前是渲染结构诊断、投影一致性检查和有限文本规划修正；`multimodalReview` 保持 `not_available`。
- 当前页数与内容归属沿用受校验 Outline/canonical content；跨页重新分配、拆并和重排尚未扩展。图片限已提供的本地 PNG/JPEG，没有自动搜索/下载或生成素材。
- 任意 SVG、复杂遮罩/阴影、动画、网格行跨栏和语义连接图尚未加入当前能力。放射和满版旧枚举没有假装被实现；新 Prompt 不广告它们。字体名可表达，但仍受本机 Office 字体可用性制约，未实现字体嵌入。
- macOS 实机保持延期，不把 Windows 结果推广为 macOS 已验收。

下一步建议：先在明确授权和预算下，用同一组需求对真实选定 LLM 做设计合同成功率与多样性评测，再接授权的多模态成品反馈；根据实际输出缺口扩展通用原语。模板优化不属于该方向。
