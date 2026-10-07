# PPT 内容驱动样式编译第一批工程验收

日期：2026-10-06。负责人确认“按内容设计，每页有变化”，按讨论优先级明确要求“直接实施”。当前为维护优化，沿用 `feature/chat-send-input-runtime-fix` 的全部已授权改动。本批只落实已有设计与内容角色的样式编译，完整分组、chrome 和设计策略仍按后续批次。

## 实际接线与行为

新增纯函数 `presentation-style-compiler.ts`：从现有 globalDesign 的 visualTone/colorDirection、每页 pageRole、hierarchy、emphasis、contentRoles 与 Host 主题色生成实际 paint。不同语义角色使用对应背景，指标、主要证据和强强调可使用已有文本框 fill；标题、正文、辅助文字按层级解析字重和颜色。规则不读取 pageNumber，不改变正文、位置、尺寸、字号或对齐。

字体方向、密度、留白与几何继续由现有 solver 处理；本批不宣称全部设计字段已完整执行，visualRhythm 的完整编排等仍属后续。解析后的样式及语义引用与输入隔离并冻结。neutral/monochrome 覆盖背景、文字、表格与图表的灰度；前景色根据实际背景选择可读的深/浅颜色。这是样式生成规则，不新增颜色审美 QA、模型评分或额外模型调用。

生产 `presentation-render-plan-compiler.ts` 把该结果写入唯一 Layout IR 的 backgroundColor/style，再派生只读 Render Plan。Renderer 不重新设计配色或坐标。原 Layout/Render digest、私有写前计划、候选父链和正式 Hash/发布/Work 门禁覆盖新增颜色；正文来源库存、稳定页/元素身份和几何验证保持。

表格新增可选 `tableHeaderColor`，封闭样式 Schema 校验六位 Hex 且只允许在 table 元素出现；表头 renderer 使用该字段，旧记录无此字段继续回退原 style.color。表体前景与其背景单独解析。图表数值标签显式使用 style.color，避免依赖库默认深色；若 IR 有 fill，chartArea/plotArea 明确消费同一 fill，轴标签、图例和系列颜色沿用计划。

复用已有 text/table/chart，不添加独立图形、图片、page.chrome、模型代码、最终任意坐标或字体下载。首次新生成与原有 QA 有限修正均走同一编译，原文件与精确 physical mutation 身份保留。

## 真实文件与编译 Host 验收

新七角色 fixture 在相同正文和主题下包含封面、内容、指标、证据表格、对比、流程、结束。真实 PPTX 验证每个稳定 render ID 的背景、填充、文字色、字重、字体、字号与 EMU 几何；色向改变不改变正文/来源/字体尺寸/几何。同一页改变语义角色时样式变化，其他六页 XML 保持；受控修正记录第二候选版本和父 Hash，保持 paint 与其他页，只改变目标几何。另核对深色 bar/pie 图表实际 chart XML 的数据标签、标题、轴、图例与系列色。

本地 Office 原有 10 秒等待下，两套独立七角色浅/深主题实际渲染 **14 页**，约 **5.5 秒**；原三方向 **9 页**约 **4.2 秒**。fixture 仍保留既有 PDF 检查器不可用时 `font_missing` 的测试环境限制，未删减其他错误；不能据这种测试例外宣称字体检查完成。

`scripts/verify-ppt-style-compiled.cjs` 进一步使用实际编译的 Runner/Reader、真实配置的 Office/PDF renderer 和独立输出项目。使用严格 `requireRenderForPpt:true`，实际渲染 **7 页、diagnostics 空、warnings 空**，不滤掉 font_missing；登记并读回 **1 个 Work**，文件 Hash、私有计划及 style 字段匹配，design-aware、fallback 空。运行环境为 Windows/Node v24.20.0，HTTP(S)/Provider 请求为 **0**，只读取两个显式 renderer 配置，不读取真实凭证/用户项目或重跑真实任务。

样例为合成数据、验证用途：

- PPT：`outputs/ppt-style-proof/20261006135810512-c52405aa/synthetic-seven-role-style-sample.pptx`
- 实际 PDF：同目录 `preview/synthetic-seven-role-style-sample.pdf`
- 页面 PNG：同目录 `preview/page-1.png` 至 `page-7.png`
- 报告：同目录 `report.json`，记录编译文件/fixture/文件 Hash、真实 QA、登记、读回与离线边界。

人工观察了实际封面、指标与对比页：背景与指标填充已落地，文本未越出画布；保留的指标来源窄栏仍出现单字换行，卡片仍使用原 margin=0。此为当前几何/分组/内边距边界，不能把第一批 paint 补丁表述为完整精美排版或 Codex 所有效果已实现。

## 自动门禁与失败记录

冻结源码后最终门禁：Node/UI **387/387**、Vitest **313 文件/3260 项**，合计 **3647** 项，零失败、零跳过。源/测试 typecheck、全仓 lint、生产 build、平台/恢复/阶段 9 基线/计划审计与 diff 检查通过；构建保留既有大 chunk/Vite CJS API 提示。4 个相关业务源与实际编译文件在完整验收前后 Hash 未变。另完成定向 **104 项**与上述严格编译 Host 真实样例。没有为本批增加既有测试等待、预算、循环次数或跳过必需套件。

最初类型检查暴露 solver hierarchy 的 `unassigned`，已使 helper 类型准确接受该既有状态，运行处理仍为普通文字，不改为强强调。完整冻结测试未出现新失败。

证据：`outputs/ppt-style-vitest-complete.log`、`ppt-style-contracts-and-repair.log`、`ppt-style-office-and-production.log`、`ppt-style-typecheck-complete.log`、`ppt-style-lint-complete.log`、`ppt-style-build-final.log`、`ppt-style-node-final.log`、`ppt-style-audit-{platform,recovery,phase9,plan}.log`、`ppt-style-diff-final.log`、`ppt-style-source-manifest.json` 及上述严格编译 Host 报告。最初类型失败为 `ppt-style-typecheck-first.log`，保留未覆盖。

## 范围、回滚与下一步

QA 继续现有文案、文件、结构、可读、重叠/越界、Hash 和登记检查，没有增加视觉审美模型、预算、等待或重试次数。业务代码不读或写用户已有作品；本批不重启用户应用，macOS 实机维持延期。

本批按内容角色落实 paint；主题范围仍来自当前受控主题，未开放任意新调色协议。独立卡片容器/内边距、分组与关系、流程连接线、完整设计策略及整篇重生成风格继承属于后续批次。逐页预览和审美评分仍暂停。

回滚仅逆向本批 Style Compiler、生产接线、可选表头色/图表 renderer 修补及直接测试，不回退已验收 Runtime/D-01/D-03/D-05 或删除历史文件/版本证据。当前改动未提交、推送、合并或部署。
