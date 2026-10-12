# 图片与视频提交历史存储性能验收

## 2026-10-12 恢复分支整合验证

后续交付授权：负责人明确要求“合并到develop”。执行前重新获取远程，develop 仍为 `d863d3f`，无新增提交。获准提交恢复内容、合入并推送 develop，保留原功能分支及恢复分支；本节末尾未提交/待批准描述是自动验收时的历史状态，不扩大测试覆盖范围。实际交付结果以 Git 提交及远程引用为准。

当前恢复分支：`feature/restore-generation-history-scroll`，基线 `develop@d863d3f4a7fdc850880d493ee146d7b7d1a27420`。负责人批准恢复及验证，是否合并另行审核。本次以 `git revert --no-commit b1d01c7` 恢复原改动，保留 PLANS 双方独立维护记录并解除冲突；实现和测试文件逐一核对与 `a8348ee` 内容一致。未修改最新 Thread-first 业务实现。下文 2026-10-10 是原功能分支历史验收，不替代本节结果。

### 自动检查

| 检查 | 结果 | 新证据（仓库相对路径） |
| --- | --- | --- |
| 11 个定向测试文件 | 122/122 | `outputs/restore-generation-targeted.log` |
| 14 个扩展回归文件 | 串行复核 189/189 | `outputs/restore-generation-regression-serial.log` |
| 历史列表和服务商 UI 合同 | 25/25 | `outputs/restore-generation-ui.log` |
| 类型检查 | 通过 | `outputs/restore-generation-typecheck.log` |
| 全仓 lint | 0 错误，历史 outputs 夹具内 2 个警告 | `outputs/restore-generation-lint.log` |
| 生产构建 | 通过，保留 Vite CJS 与大 chunk 提示 | `outputs/restore-generation-build.log` |
| 平台审计 | 无违规项 | `outputs/restore-generation-platform.log` |

扩展回归初跑 188/189，`conversation-response-controller.test.ts` 的一个用例在临时目录清理时出现 ENOTEMPTY。未更改实现、清理逻辑或断言；该文件单独复核 51/51，整组使用 `--maxWorkers=1 --minWorkers=1` 后 189/189。保留首次失败日志 `outputs/restore-generation-regression.log` 和单文件复核日志 `outputs/restore-generation-response-recheck.log`，不能声称首次运行全绿或已根治清理时序问题。122 与 189 来自不重叠文件，合计 311 项；复跑不重复计数，未执行全量测试。

### Electron 和兼容性

- `pnpm exec electron scripts/verify-provider-result-history-electron.cjs d863d3f`：真实本地仓储、提交编排和 Worker，合成服务商结果、零外部调用。报告 `outputs/provider-result-history/1791771923892/report.json`，passed=true。
- `pnpm exec electron scripts/verify-generation-history-app-electron.cjs`：真实生产主进程、preload、IPC、Renderer 和隔离项目，预置结果而非真实收费生成。快速/专业图片、快速/文生/图生视频五模式的历史隔离、状态刷新与布局通过；导航返回保留选中任务和作品，另一项目不继承历史。图片生成状态变化期间 60 次程序化滚轮无回弹、重复卡片或时间线位移，事件至观察绘制 p95 17.9ms、最大 18.2ms；派发到脚本观察 p95 95.3ms、最大 96.7ms。报告 `outputs/generation-history-app/report.json`。此脚本的 60 次滚轮段只覆盖图片；图片和视频提交链路的主线程阻塞由上一项分别覆盖。
- 新会话/旧会话双模式分别运行原 `tests/electron/conversation-phase6-e2e.mjs`，开启重启检查，3 个会话、每会话 120 条消息；分页、切换、重启后的内容签名一致均通过。由于用户已有 Vite 占用 5173，使用 `outputs/restore-generation-conversation.mjs` 仅替换测试端口为 5187/9237 及模块定位，不停止用户服务。分别设置 `UNICOMP_THREAD_FIRST`/`VITE_UNICOMP_THREAD_FIRST` 为 1、0，旧模式另设 `UNICOMP_E2E_THREAD_FILE=0`，两次均设 `UNICOMP_E2E_RESTART=1`。日志 `outputs/restore-generation-thread-electron.log`、`outputs/restore-generation-legacy-electron.log`。
- `UNICOMP_THREAD_FIRST=1` 下运行 `scripts/verify-agent-provider-mock-electron.cjs`：普通 Agent、执行身份、取消入口、工具调用链路、Word/Excel 物理文件登记通过。其报告 `toolCalling.artifactRegistered=false`，不计为 PPT 生成或 Thread artifact 登记验收，亦不声称真实外部 Provider 可用。
- `pnpm exec electron outputs/restore-generation-active-switch.cjs`：复用上述真实 IPC 和受控 Provider，等请求进入 transport 后，通过生产 `ProjectSessionController` 发起打开另一隔离项目和排队关闭；运行真实结果维护 Worker，并把生产会话/文档生命周期等待函数接入切换屏障。确认请求活跃时仍归属原项目，取消触发一次 transport abort，等待落盘后目标打开成功，排队关闭最终清空 session。日志 `outputs/restore-generation-active-switch.log` 中 `ACTIVE_PROJECT_SWITCH_PASS`，退出码 0。这是控制器组合验证，不是用户鼠标点击完整侧栏的录像。
- `pnpm exec electron outputs/provider-single-scroll/verify.cjs`：生产 CSS 加同结构合成长列表，三个尺寸各覆盖展开/收起，共六场景通过。右侧只有一层滚动，末项可达，左侧独立滚动；日志 `outputs/restore-generation-provider-scroll.log`。

| 本地提交指标（各两次） | 最新 develop 原实现 | 恢复分支 |
| --- | --- | --- |
| 视频提交耗时 | 7.54–7.64 秒 | 0.48–0.52 秒 |
| 视频主线程最大定时器延迟 | 627–638 毫秒 | 28–29 毫秒 |
| 图片提交耗时 | 9.17–9.40 秒 | 0.61–0.63 秒 |
| 图片主线程最大定时器延迟 | 668–688 毫秒 | 27–28 毫秒 |

这些数字不含外部生成耗时，不是物理鼠标延迟，也不是多机器总体分位数。合成项目与原用户项目分离；未重启用户原应用、未调用真实凭证或付费模型。

### 审核与人工验收边界

1. 在恢复分支重新启动开发版，先使用项目副本。检查旧图片预览/视频播放、关闭重开后的历史完整性；结果外置是持久化格式变化，Git 撤回不还原项目数据。
2. 图片和视频分别点击生成并滚动历史前 5 秒，观察缩略图和最终状态。真实服务商端到端生成仍由负责人验收。
3. 视频完成或失败后切换其他页再返回，确认进度记录仍在；新生成更新本次记录。内存进度不保证软件重启保留，不把它扩展成图片面板已新增同样缓存。
4. 有会话运行时切换项目、再关闭项目，检查取消/完成、作品归属和最终关闭状态；自动验证使用受控 Provider，不覆盖所有真实服务商取消行为。
5. 模型管理展开设置、缩小窗口，确认右侧单层滚动、末项可达。

当前恢复内容留在功能分支工作区，未创建新提交、未推送、未合入 develop。原功能分支本地/远程均保留 `a8348ee`，develop 本地/远程均保持 `d863d3f`。是否提交、发布和合并由后续授权决定。

---

日期：2026-10-10。分支：`feature/generation-history-scroll`。

后续验收：负责人于 2026-10-10 明确确认验收通过，并授权上传功能分支、无冲突时合并 develop。下方未完成项与“未提交”描述为自动验收结束时的历史状态；真实服务商自动化覆盖范围不因人工确认而扩大。

## 范围与方案校正

负责人在解释与方案后授权“在当前分支按方案实施”。本轮范围为造成提交卡顿的图片结果持久化、历史整理、结果恢复和项目打开时的必要接线。此项是本地存储性能修复，无法仅靠 UI 根治。保留进入本轮前已有的历史列表、时间线及视频提交面板未提交改动；本轮没有重做页面。

原方案中“最多三次过程账落盘”和“删除过程账中的完整回执”未照搬。源码审查确认授权取得、请求开始的节点有独立恢复意义，而且过程账与执行回执使用不同记录 ID。最终保留原顺序和双份小回执，让它们引用同一个结果文件，避免破坏防重复提交及崩溃恢复。此前“回执账只追加一行”表述也不准确：当前仍是小 JSON 文件整份原子替换，没有引入数据库或追加日志格式。

## 实际改动

1. `ProviderImmediateResultReference` 新增主机使用的 `stored_base64` 引用，保存 SHA-256 摘要和 MIME。服务商仍通过原适配器返回 URL/base64，不改变请求、价格和协议。
2. `ProviderResultPayloadStore` 将 base64 结果单独保存为 `results/provider-payloads/<hash>.json`。摘要包含 MIME 与原内容；先原子写入并读回核验，再发布引用。两本账中相同图片去重为同一个文件。此文件是私有结果凭据，不是未经校验的正式作品。
3. 受理保存/推进、操作回执保存接入外置。普通 `list/get` 只读取记录，不触发整理或读取所有历史图片。收图时只解析本次引用，经摘要核对后继续已有图片校验、文件发布及 Work 登记。
4. 历史整理是显式且可重复运行的 `compactResultHistory()`。只转换内嵌 base64，保留任务、执行、事件、状态、原结果和无关元数据。无变化时不增加 revision、不写盘。原子替换及 `.bak` 机制保留，不自动删除 payload。
5. Electron 打开项目时，在 Worker 中整理已有历史；主线程只协调锁和小消息。整理完成后再等待旧项目操作结束，然后切换 session。打开、新建、关闭操作串行，避免长整理导致后到的关闭请求被覆盖。
6. 整理失败记录本地诊断并允许以旧格式打开项目，不会因为整理失败重新生成。主文件损坏、从 `.bak` 读取时跳过整理，避免覆盖唯一有效备份。取消在原子操作之间处理，不强杀正在持锁的线程。

实际结果文件仍使用 JSON/base64，以保留既有回执语义；本轮收益来自将大内容移出热路径，不声称消除了所有 base64 开销。有效备份、其他回执都可能引用 payload，因此不可单独删除 `results/provider-payloads/`。迁移/复制项目时必须包含整个项目目录；现有目录迁移递归包含该目录，清理缓存功能不包含该目录。

## 复现与性能证据

脚本：`scripts/verify-provider-result-history-electron.cjs`。

修复前代码取自 Git `bd1f583d18a488b8bd8b01e218c0fd49bd34b534` 中两个原仓储实现；修复后使用当前生产构建。相同合成历史：267 条受理、52 份不同的约 800 KiB 图片 payload。受理账 58,015,031 字节，回执账 56,830,301 字节，与用户先前测得的数十 MB 规模相当，但并非用户原始项目数据。

测试运行真实 Electron 主线程、真实 JSON 仓储、提交编排、日志及 Worker；候选/授权外部依赖和服务商返回为本地合成，HTTP(S) 请求为 0。分别执行图片同步完成和视频异步受理分支，并验证相同提交重入不会再次 dispatch。窗口显示为专用滚轮探针页面，不是完整生成页面。

在可见窗口中以 Electron `sendInputEvent` 注入滚轮，验证收到事件且页面滚动。注入定时器位于主线程，因此用于观察主线程阻塞对输入派发的影响；不能把这些数字称作物理鼠标的端到端延迟。隐藏窗口初测受节流影响，不作为滚轮验收依据。

最终报告：`outputs/provider-result-history/1791613599925/report.json`，`passed=true`。每种模式、每个版本运行两次，以下为范围，不是总体 P95。

| 指标 | 修复前 | 修复后 |
|---|---:|---:|
| 视频本地提交链路 | 8.37–8.40 秒 | 0.51–0.53 秒 |
| 视频主线程最大定时器延迟 | 688–741 毫秒 | 30–31 毫秒 |
| 图片本地提交链路 | 9.34–9.43 秒 | 0.61–0.62 秒 |
| 图片主线程最大定时器延迟 | 646–656 毫秒 | 27–28 毫秒 |
| 视频滚轮事件最大间隔 | 700–767 毫秒 | 约 67 毫秒 |
| 图片滚轮事件最大间隔 | 666–684 毫秒 | 约 67 毫秒 |
| 受理账主文件 | 58.02 MB | 1.22 MB |
| 回执账主文件 | 56.83 MB | 0.036 MB |

首次后台整理约 3.75–3.93 秒，期间主线程最大延迟约 8–15 毫秒，滚轮持续到达。此时间属于首次打开旧项目的准备时间，不含外部服务生成时间；后续没有内嵌 base64 时不会重写历史。

修复前后页面帧间隔均约 16.8–16.9 毫秒，而输入事件间隔明显不同，说明仅测 Renderer 帧率不足以发现这次提交阻塞。该证据支持本次历史存储原因及改善，不宣称所有历史规模、所有媒体大小和所有机器均零卡顿。

脚本保留 JSON 报告与合成项目副本。本轮清理这些副本的命令被自动审批策略拒绝，未换方式删除。执行方式：

```powershell
pnpm build
pnpm exec electron scripts/verify-provider-result-history-electron.cjs bd1f583d18a488b8bd8b01e218c0fd49bd34b534
```

## 回归验收

- 定向 Vitest 共 345 项通过：原定向组 93 项、结果/元数据/UI 行为组 60 项、共享图片/视频/适配器/恢复组 189 项，以及最终补入的 3 项安全边界测试。重复执行不重复计数。
- Node UI/IPC 合同 9 项通过。
- 最终类型检查、变更范围 ESLint、生产构建和平台审计通过；构建保留原有 Vite CJS API、大 chunk 提示。
- 覆盖新旧结果恢复、内容去重、篡改/缺失/目录穿越、迁移中断、原子替换失败、仅备份有效、重复整理零写入、同一提交重入、图片正式接收和视频后续完成/失败，以及迁移期间项目切换顺序。
- 代码审查发现的两个 P1（有效备份可能被覆盖、迁移扩大切换等待窗口）已修复并补测；最终只读审查无未关闭 P1。

日志：`outputs/provider-result-history-tests.log`、`provider-result-history-regression.log`、`provider-result-history-shared-regression.log`、`provider-result-history-safety-regression.log`、`provider-result-history-ui-contract.log`、`provider-result-history-typecheck-final.log`、`provider-result-history-lint-final.log`、`provider-result-history-build-final.log`、`provider-result-history-platform-audit.log`、`provider-result-history-electron-final.log`。

未覆盖：真实收费服务商生成、本次用户原项目的实鼠操作、macOS 实机。没有修改用户项目数据、重启用户原应用、提交 Git、推送或合并。

## 人工验收清单

使用重新启动的当前分支开发版。旧 Electron 主进程不会因前端热更新自动加载这次存储修复。第一次打开历史较多的旧项目会先后台整理，等待项目打开完成后开始验收。

- [ ] 打开原来会卡顿的项目，确认历史任务数量、状态、已有图片预览和视频播放正常；关闭重开后再查一次。
- [ ] 视频页点击生成后立即持续滚动历史列表，重点检查前 5 秒，再观察进入生成中后的滚动。预期不再出现此前数百毫秒的停顿。
- [ ] 图片页重复上述过程，同时检查缩略图、提交中状态和最终作品。新结果应能正常保存和重新打开。
- [ ] 连续生成至少两次，确认第二次及后续提交没有再次搬运大历史账；快速双击不能产生两个收费任务。
- [ ] 切换其他页面再返回，确认此前时间线和历史状态修复仍正常；远端完成、本地登记、最终成功/失败须一致。
- [ ] 重启后打开已有图片；如存在原本可恢复的本地接收失败任务，使用“恢复结果”，确认只恢复本地结果，不重新提交生成。
- [ ] 有任务运行时切换项目，确认等待及作品归属正确；切换期间再关闭项目，最终应保持关闭。

如仍有卡顿，请记录模式、项目规模、点击后第几秒、是否首次打开或结果刚返回。剩余文本索引仍随任务数量增长；此轮解决大图片反复进入账本造成的写放大，不承诺文本记录无限增长时恒定耗时。若整理因磁盘空间或数据损坏失败，旧项目仍可打开，但不能视为性能整理成功。
