# 阶段 9 C2 流程 6｜Electron、页面与 Work 接线工程记录

日期：2026-07-29

状态：实现和分支门禁已完成，等待连续授权下提交、推送与非快进合并 `develop`

分支：`feature/vidu-app-wiring`

基线：`develop@f53b33146828680d863df8f635403d024f9d93f5`

## 一、允许范围

本流程只接线唯一 Electron Vidu 组合根、provider/storage IPC 注入、命名 preload 方法、现有图片/图生视频页面真实状态，以及图片 Work 到图生视频草稿的受控端口。未新增一级页面，未实现第四种图片协议，未读取真实 Token，未访问真实 Vidu，未产生收费请求。

## 二、实际修改

1. 主进程只创建一个 `ElectronViduComposition`，Provider 管理、凭证、图片提交、视频提交和结果接收复用同一 Registry、Vault、ProviderPackage 与受控 Electron transport；退出时统一取消在途运行时。
2. Provider 和 Storage IPC 改为依赖注入共享组合根；preload 只增加 `createFromImageWork`、`refreshExecution`、`cancelExecution` 和 `recoverExecutions` 等命名方法，不暴露通用 Electron/Node、远端 operation ID、下载 URL、路径或 Hash。
3. 图片生成有受控输入时使用 `reference_to_image`，无输入时继续使用 `image_generation`，图片编辑使用 `image_editing`；页面和通用领域不判断 Vidu 模型名称。
4. 快速生图、专业生图和图片编辑页面复用显式 Task、Execution、提交、同步结果接收与 Work 登记流程。创建 Task 前必须完成全部确认，结果只有通过主进程下载/解码、探测、SHA-256、原子发布与 Work 登记后才显示完成。
5. 图生视频页面增加重启恢复、带退避抖动的自动查询、手工刷新、取消、结果接收和真实 Execution/Work 状态。`remote_completed` 不等于本地作品完成，renderer 不接收远端 `task_id` 或 URL。
6. 用户可从图片 Work 显式创建图生视频草稿。主进程重新校验当前项目、图片 Work、FileReference 状态、SHA-256 与图片探测，创建或复用受控 Asset 并保存来源；该操作不创建视频 Task、Execution，也不自动提交。
7. 图片与视频提交控制器对请求字段使用精确白名单；已知 channel 夹带路径、endpoint 或其他字段时返回 `invalid_request`，不产生副作用。

## 三、自动化与界面验证

- `npm test`：Node 160 项、Vitest 371 项，合计 531 项通过，0 失败、0 跳过；
- `npm run typecheck`：通过；
- `npm run lint`：通过；
- `npm run build`：通过；
- `npm run audit:platform`：扫描 213 个文件，0 违规；
- `npm run verify:handoff`：50 个 checksum 条目、27 个资产，0 失败；
- `git diff --check`：通过；
- Windows Electron 生产构建烟测：本次新增 4 个进程，4 个全部响应，退出后本次残留 0。

新增或更新测试覆盖唯一组合根、共享 Registry/Vault/runtime、preload 命名白名单、敏感字段扫描、`reference_to_image` 路由、精确 IPC 字段、视频刷新/取消/按草稿恢复、远端 ID 隐藏、图片 Work SHA-256 复核、文件变化拒绝、派生草稿不创建 Task，以及图片/图生视频页面真实状态。全部适配器测试继续使用内存合成 transport，真实 HTTP 调用为 0。

本地浏览器在产品支持的 1080px 最小桌面宽度下确认无横向溢出、按钮裁切或重叠。390px 窄视口会按既有 Electron 桌面壳 `min-width: 1080px` 横向滚动；该事实不标记为移动端通过，也不在本流程越界重构全局壳。烟测前已有 4 个从前一日运行的 Electron 进程，本次按进程基线隔离且未终止这些既有进程。

## 四、未完成项与风险

- 冻结 Vidu 模型仍 disabled，CapabilityEvidence 仍为 `declared_supported`；当前页面会保持真实阻断，不会为了演示制造可用状态；
- Image V1 的准确鉴权格式与 `images` 请求结构仍未确认，生产路径继续在 HTTP 前阻断；
- 流程 7 尚需以本地合成服务覆盖三协议路由、断线、未知提交、429/5xx、取消/恢复、恶意下载、损坏媒体、磁盘不足和 Work 恢复；
- 流程 8 的真实联网、真实 Token 和收费测试仍未批准；
- macOS 实机及阶段 9 A3、B4、A4 均不因本流程完成而标记通过。

## 五、下一步

提交并推送 `feature/vidu-app-wiring`，按连续授权非快进合并并复验最新 `develop`。只有流程 6 合并后才能从最新 `develop` 创建 `feature/vidu-e2e-validation`；流程 7 完成并合并后必须停止，不得启动流程 8。
