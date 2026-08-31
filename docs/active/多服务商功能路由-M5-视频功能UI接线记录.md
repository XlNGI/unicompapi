# 多服务商功能路由 M5｜视频功能 UI 接线记录

日期：2026-08-03

分支：`feature/ui-video-feature-wiring`

来源：`develop@b23675b`

实现提交：`574eafc`

## 一、范围与边界

本支只完成 M5 第四支视频功能 UI 后置接线：快速视频、文生视频、图生视频、安全候选查询、动态参数、外发确认和受控提交，以及旧视频草稿的确定性迁移或显式清理。

页面只消费已合并的安全视频功能 DTO、固定草稿 revision、ProjectContext 固定版本、受控单图、一次性路由选择令牌和提交端口。在线视频运行授权保持关闭，不读取或验证真实凭证，不发起真实服务商 HTTP/DNS，不产生收费调用。本支未启动后续 M5 分支、阶段 10、macOS 实机或媒体工具链；阶段 9 权威方案原件保持只读。

## 二、实际实现

- 三类视频草稿新增显式功能选择：快速视频与文生视频固定为 `text_to_video`，图生视频固定为 `image_to_video`；候选与提交不再按页面名、服务商名或模型名猜测功能。
- 快速视频固定为纯文本输入，图片、视频和上下文入口全部移除。旧单图草稿只能显式派生到图生视频，旧无素材上下文草稿只能显式派生到文生视频；旧视频参考没有不确定或伪造的迁移路径。
- 文生视频不接收任何素材槽位，只允许固定 revision 且明确 `includeInPrompt` 的 ProjectContext。旧动态素材和不受支持的旧上下文均会阻断提交并提供显式移除操作。
- 图生视频要求恰好一张经过主进程本地校验的图片，图片选择、预览和清理只通过受控媒体端口完成；旧动态素材只有在唯一图片可确定时才显式迁移，否则明确移除后要求重新选图。
- 新增安全视频候选、准备确认和确认提交 IPC。renderer 只可见服务商、连接、模型显示名、`ParameterSchema`、费用事实、可用性和阻断原因，不接收 RouteSnapshot、Package、Adapter、Endpoint、凭证、Prompt、路径、Hash、远端 operation 或原始响应。
- 候选令牌绑定项目、草稿、revision、功能、上下文、图片和 Registry 事实；项目切换、关闭、草稿变化、候选事实变化、过期或重复使用都会失败关闭。
- Electron 组合只注册现有 Vidu 包中合同完整的 `image_to_video` Schema；Seedance、Kling、NewAPI 以及 `text_to_video` 在缺少精确动态 Schema 时保持无候选，不伪造模型、参数或协议支持。
- Electron 只安装视频功能控制器，在线运行授权保持关闭；当前确认提交返回明确 `runtime_not_allowed`，不创建请求、费用、假进度、假结果或未校验 Work。
- 视频动态参数按安全 `ParameterSchema` 渲染；对象参数使用受校验的 JSON 对象编辑器，不把对象值降级成普通字符串，也不透传未知字段。
- 三个页面移除旧 `preflight/createTask/createExecution/invokeExecution` 业务按钮，每页只保留一个“准备生成/确认并提交”主操作；保存草稿与提交继续严格分离。
- 补齐领域、Controller、项目视频功能组合、受控单图、IPC/preload 和 UI 静态合同测试，覆盖纯文生视频、单图图生视频、旧草稿迁移、显式清理、一次性令牌、revision 失效、项目切换和安全公开投影。

## 三、验证结果

- `npm.cmd test`：Node 188 项与 Vitest 581 项，共 769 项通过，0 失败、0 跳过；
- `npm.cmd run typecheck`：通过；
- `npm.cmd run lint`：通过；
- `npm.cmd run build`：通过，Vite 88 个模块完成生产构建；
- `npm.cmd run audit:platform`：扫描 290 个文件，0 违规；
- `npm.cmd run verify:handoff`：50 项 checksum、27 个权威资源通过；
- `npm.cmd run verify:recovery-audit`：`passed`，安全违规 0、禁止制品 0；
- `npm.cmd run verify:phase9-closeout`：Windows 九类必需套件保持 `passed`，macOS 保持 deferred；
- `npm.cmd run verify:secure-storage`：Windows x64 可用，明文未持久化；
- `npm.cmd run verify:runtime-integrations`：通过；
- `git diff --check`：通过。

浏览器可见检查覆盖 `1440x900` 与权威最小窗口 `800x720`：快速视频、文生视频和图生视频无横向溢出、控件重叠或文字裁切，紧凑导航、单列内容、滚动和焦点路径可达，零尺寸可用控件为 0，控制台 0 警告、0 错误。浏览器无 Electron preload，本项验证布局与真实禁用状态，不替代主进程端口验证。Windows 生产 Electron 隔离烟测新增 4 个进程、4/4 响应、1 个可见 `UniComp` 窗口，正常关闭后残留 0，错误日志为空。

真实服务商 HTTP 0 次、真实 DNS 0 次、真实凭证读取/验证 0 次、收费调用 0 次、费用 0。Vidu 已用尽预算未恢复，Image V1 未晋级。

## 四、结论与下一步

自验收结论：`passed`。允许推送并非快进合并 `develop`，本地与远程功能分支继续保留。

合并后从最新 `develop` 创建 M5 第五支 `feature/ui-task-call-records-wiring`，只把任务中心接到已合并的安全调用读模型、状态、时间线、用量完整性和本地结果事实；不得公开 RouteSnapshot、Endpoint、凭证、Prompt、远端 operation、签名 URL、绝对路径、Hash 或原始响应，不得新增真实服务商调用、凭证验证、收费测试或阶段 10。
