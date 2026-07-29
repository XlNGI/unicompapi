# 阶段 9 C2｜流程 8 Vidu 真实最小闭环验收记录

日期：2026-07-29

状态：真实 Vidu API Windows 开发态最小闭环通过；图片与视频单次预算均已用尽，禁止继续发起真实收费请求

分支：`feature/vidu-live-validation`

基线：`develop@bd86cbf113dc02019160bcc9b6ecc7830aa553ee`

## 一、批准范围与停止边界

项目负责人已明确批准真实 Vidu 联网、应用内安全凭证使用，以及最多一次图片和一次视频收费提交。Token 只能由用户在应用凭证界面录入并进入 Electron `safeStorage`，不得进入聊天、源代码、环境文件、日志、工程记录或 Git。

本次真实验证只允许：

- 先执行一次 `GET /ent/v2/credits` 鉴权与账户可用性检查；
- 使用 `q3-lite` 执行一次单参考图、单输出同步图片请求；
- 在图片完成本地探测、SHA-256、原子落盘、索引和 Work 登记后，由用户显式创建图生视频草稿；
- 使用 `viduq3-turbo` 执行一次单参考图、单输出异步视频请求；
- 持久化并轮询视频任务，下载和探测通过后登记视频 Work。

鉴权失败不初始化收费预算。图片或视频提交一经领取预算不得再次领取；`submission_outcome_unknown`、远端失败、本地结果失败或记录失败均必须停止，不得自动重试、切换协议或增加调用次数。Image V1 未决鉴权和输入结构不参与本次真实调用。

## 二、实际实现

- 增加严格运行时校验、revision、串行原子写入和同目录有效备份的流程 8 验证记录；
- 增加图片与视频各一次的持久化收费预算，记录领取、已接受/完成、提交前失败和结果未知事实；
- 启动操作先通过共享 Vidu 运行时调用 credits，再安装只包含 `q3-lite` 和 `viduq3-turbo` 的临时 `user_confirmed` Evidence 与路由；
- 主进程在 HTTP 前校验 Task、Execution、项目 Session、模型、Evidence 和来源图片 Work；跨模型或错误来源不消耗额外 HTTP；
- 图片/视频 Work 全部本地事实通过后才追加不可变 `verified_supported/system_observed` Evidence；
- Provider IPC/preload 只暴露获取状态和带四项布尔确认的启动方法，不暴露 Token、余额、路径、Hash、远端 operation ID、下载 URL、endpoint 或内部错误；
- Provider 页面显示四项明确批准、单次预算和脱敏事件时间线；图片与视频页面继续使用动态 Evidence 和 ParameterSchema；
- 凭证替换会轮换内部引用并清除旧连接验证状态；
- 提交、轮询或 Work 观察写入失败时保留真实业务结果，同时尽力将流程终止为 `local_state_failed`。
- Electron 启动时显式补齐旧版 Schema v2 注册表中缺失的冻结 Vidu Provider、Connection、协议绑定、模型和能力证据；只按稳定 ID 添加缺失记录，同 ID 现有记录、自定义连接、墓碑、凭证引用和不可变能力历史均不覆盖。

## 三、自动化与构建门禁

- `npm test`：同步最新 UI 后 Node/UI 167 项、Vitest 387 项，合计 554 项通过，0 失败、0 跳过；
- `npm run typecheck`：通过；
- `npm run lint`：通过；
- `npm run build`：通过；
- `npm run audit:platform`：扫描 216 个文件，0 违规；
- `npm run verify:handoff`：50 个 checksum 条目、27 个资产，0 失败；
- `git diff --check`：通过；
- Windows Electron 生产构建烟测：新增 4 个进程、4/4 响应、1 个窗口，退出后本次残留 0；烟测前不存在 Electron 基线进程；
- 1280×720 可见检查：Provider 流程 8 面板、快速生图和图生视频工作区无重叠，浏览器控制台 0 错误。
- `feature/image-creation-visual-alignment` 与 `feature/vidu-user-flow-ui-fixes` 已依次合并 `develop`；流程 8 通过 `55c0457` 非变基同步该 UI 基线，派生草稿跳转、素材计数、轮询状态和重复 Task/Execution 阻断均进入最终回归。

以上门禁未读取真实 Token、未访问真实 Vidu、未产生收费请求。

## 四、真实验证事实

当前状态：`passed`。

- credits 鉴权：`passed`；
- `q3-lite` 图片提交：已完成批准的唯一一次请求，预算事实为 `accepted_or_completed`；
- 图片本地结果与 Work：下载或读取、图片探测、字节校验、SHA-256、原子落盘、FileReference、索引和 Work 登记全部完成；
- 图片 Work 显式派生图生视频草稿：已由用户明确操作完成，未自动创建视频 Task 或 Execution；
- `viduq3-turbo` 视频提交：已完成批准的唯一一次请求，预算事实为 `accepted_or_completed`；
- 视频轮询、本地结果与 Work：Execution 已完成，视频下载、探测、字节校验、SHA-256、原子落盘、FileReference、索引和 Work 登记全部完成；
- 真实收费边界：图片和视频预算均已用尽，不记录价格、余额、远端 operation ID、下载 URL 或响应正文，不得继续发起真实 Vidu 请求。

本记录只保留脱敏业务结论，不记录 Authorization、账户响应正文、远端 task ID、签名 URL、绝对路径、Hash、凭证或内部仓储位置。

## 五、未完成项与结论边界

- Image V1 的准确鉴权格式与 `images` 请求结构仍未通过真实官方环境验证，不因本流程通过而晋级；
- 本次临时开放只覆盖 `q3-lite` 参考生图与 `viduq3-turbo` 图生视频，不推断其他模型、模式、价格或规格；
- macOS 实机、阶段 9 A3/B4/A4 和阶段 10 发布准入不在本流程结论内；
- 本流程结论仅为“Vidu 官方 API Windows 开发态最小闭环通过”，不代表阶段 9、跨平台验收或正式发布完成。
