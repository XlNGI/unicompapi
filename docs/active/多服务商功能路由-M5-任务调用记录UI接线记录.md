# 多服务商功能路由 M5｜任务调用记录 UI 接线记录

日期：2026-08-03

分支：`feature/ui-task-call-records-wiring`

来源：`develop@f1ec7e8`

实现提交：`b7db775`

## 一、范围与边界

本支只完成 M5 第五支任务/调用记录 UI 后置接线：保留原任务视图，在任务中心增加调用记录分段、筛选、列表和安全详情，并消费已合并的调用读模型、状态、时间线、用量完整性和本地结果事实。

页面不公开 RouteSnapshot、Endpoint、凭证、Prompt、远端 operation、签名 URL、绝对路径、Hash、原始响应或内部错误堆栈。本支未新增业务一级页面，未修改调用执行、路由或适配器，不读取或验证真实凭证，不发起真实服务商 HTTP/DNS，不产生收费调用，也未启动阶段 10、macOS 实机或媒体工具链；阶段 9 权威方案原件保持只读。

## 二、实际实现

- 任务中心保留原“任务”视图，并新增带完整 `tab/tabpanel` 关联的“调用记录”分段视图；切换视图不会把服务商调用混入本地任务事实。
- 调用记录支持按项目、功能、服务商、连接、模型、状态和起止日期筛选；日期范围倒置时在 renderer 阻断读取并给出明确提示。
- 列表展示提交时固化的服务商、连接、模型显示名、产品功能、状态、开始时间和用量完整性；不依据当前 Registry 反向改写历史显示事实。
- 详情展示脱敏时间线、总耗时和重试归属；轮询或流片段保持在事件时间线，不伪造成多条顶层调用。
- 用量区域只渲染安全白名单指标、单位、来源和完整性状态；缺失、部分、无效、未知与不适用分别显示，不把未知补写为 0，也不从价格或结果属性推导费用。
- 本地结果区域只展示媒体类型、字节数、尺寸、时长、本地校验状态和 Work 登记状态，不返回路径、Hash 或远端下载事实。
- 补齐调用记录 UI 静态合同测试，覆盖安全读取端口、筛选、日期阻断、时间线、用量、本地结果、重试关系、可访问性关联和受保护字段禁入。

## 三、验证结果

- `npm.cmd test`：Node 192 项与 Vitest 581 项，共 773 项通过，0 失败、0 跳过；
- `npm.cmd run typecheck`：通过；
- `npm.cmd run lint`：通过；
- `npm.cmd run build`：通过，Vite 89 个模块完成生产构建；
- `npm.cmd run audit:platform`：扫描 291 个文件，0 违规；
- `npm.cmd run verify:handoff`：50 项 checksum、27 个权威资源通过；
- `npm.cmd run verify:recovery-audit`：`passed`，安全违规 0、禁止制品 0；
- `npm.cmd run verify:phase9-closeout`：Windows 九类必需套件保持 `passed`，macOS 保持 deferred；
- `npm.cmd run verify:secure-storage`：Windows x64 可用，明文未持久化；
- `npm.cmd run verify:runtime-integrations`：通过；
- `git diff --check` 与暂存差异检查：通过。

浏览器可见检查覆盖 `1440x900` 与权威最小窗口 `800x720`：任务/调用记录切换、筛选、列表、详情、时间线、用量和本地结果区域无横向溢出、控件重叠或文字裁切，零尺寸可用控件为 0，控制台 0 警告、0 错误；`tab/tabpanel` 关联完整。浏览器无 Electron preload，本项验证布局与真实禁用状态，不替代主进程端口验证。

Windows 生产 Electron 隔离烟测新增 4 个进程、4/4 响应、1 个可见 `UniComp` 窗口，正常关闭后残留 0，错误日志为空。

真实服务商 HTTP 0 次、真实 DNS 0 次、真实凭证读取/验证 0 次、收费调用 0 次、费用 0。Vidu 已用尽预算未恢复，Image V1 未晋级。

## 四、结论与下一步

自验收结论：`passed`。允许推送并非快进合并 `develop`，本地与远程功能分支继续保留。

合并后从最新 `develop` 创建 M5 第六支 `feature/ui-provider-acceptance-closeout`，只做多服务商 UI 的响应式、逐按钮、安全边界、Electron 可见窗口和完整回归收口；不得新增真实服务商联网、凭证读取/验证、收费调用、macOS 实机与媒体工具链或阶段 10 工作。
