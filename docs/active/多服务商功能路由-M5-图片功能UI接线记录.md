# 多服务商功能路由 M5｜图片功能 UI 接线记录

日期：2026-08-03

分支：`feature/ui-image-feature-wiring`

来源：`develop@bc91fda`

实现提交：`1ed2772`

## 一、范围与边界

本支只完成 M5 第三支图片功能 UI 后置接线：快速生图、专业生图、图片候选查询、动态参数、外发确认和受控提交，以及旧快速草稿向专业生图的确定性迁移。

页面只消费已合并的安全图片功能 DTO、固定草稿 revision、ProjectContext 固定版本、一次性路由选择令牌和提交端口。在线图片运行授权保持关闭，不读取或验证真实凭证，不发起真实服务商 HTTP/DNS，不产生收费调用。本支未启动后续 M5 分支、阶段 10、macOS 实机或媒体工具链；阶段 9 权威方案原件保持只读。

## 二、实际实现

- 快速生图固定为纯 `text_to_image`，只接收文字需求，图片素材和上下文数量均为 0；页面移除参考素材、上下文、旧 Provider Registry 以及直接创建 Task/Execution/远端调用的工程按钮。
- 旧快速草稿若包含图片或上下文，只能显式派生到专业生图；带单图的旧草稿确定性迁移为 `reference_to_image`，不会在快速页静默切换协议，也不会丢弃历史输入。
- 专业生图使用显式“文生图/图生图”分段控件。文生图要求 0 张图片，图生图要求恰好 1 张受控项目图片；图片选择、预览和清理继续只通过主进程受控端口完成。
- 专业页只接受固定 revision 的 `ProjectContext`；未固定 revision、旧类型或不受支持的上下文会阻断提交并提供显式清理，不把保存的对话摘要解释为消息内容或外发授权。
- 新增安全图片候选、准备确认和确认提交 IPC。renderer 只可见服务商、连接、模型显示名、`ParameterSchema`、费用事实、可用性和阻断原因，不接收 RouteSnapshot、Package、Adapter、Endpoint、凭证、Prompt、路径、Hash、远端 operation 或原始响应。
- 候选令牌绑定项目、草稿、revision、功能、上下文、媒体和 Registry 事实；项目切换、关闭、草稿变化、候选事实变化、过期或重复使用都会失败关闭。
- Electron 组合仅安装图片功能控制器，在线运行授权保持关闭；当前提交返回明确 `runtime_not_allowed`，不创建请求、费用、假进度、假结果或未校验 Work。
- 图片合同注册表过滤视频 Schema，快速/专业页只展示当前功能的精确动态参数；每页只保留一个业务主操作。
- 按权威方案把 Electron 与根节点最小宽度从旧 `1080px` 调整为 `800px`，增加紧凑标题栏与导航规则；`800x720` 下单列内容、主操作和滚动区域可达。
- 补齐领域、Controller、项目图片功能组合、受控本地媒体、IPC/preload 和 UI 静态合同测试，覆盖纯文生图、单图图生图、旧草稿迁移、一次性令牌、revision 失效、项目切换和安全公开投影。

## 三、验证结果

- `npm.cmd test`：Node 185 项与 Vitest 571 项，共 756 项通过，0 失败、0 跳过；
- `npm.cmd run typecheck`：通过；
- `npm.cmd run lint`：通过；
- `npm.cmd run build`：通过，Vite 88 个模块完成生产构建；
- `npm.cmd run audit:platform`：扫描 286 个文件，0 违规；
- `npm.cmd run verify:handoff`：50 项 checksum、27 个权威资源通过；
- `npm.cmd run verify:recovery-audit`：`passed`，安全违规 0、禁止制品 0；
- `npm.cmd run verify:phase9-closeout`：Windows 九类必需套件保持 `passed`，macOS 保持 deferred；
- `npm.cmd run verify:secure-storage`：Windows x64 可用，明文未持久化；
- `npm.cmd run verify:runtime-integrations`：通过；
- `git diff --check`：通过。

浏览器可见检查覆盖 `1440x900` 与权威最小窗口 `800x720`：快速生图和专业生图无横向溢出、控件重叠或文字裁切，紧凑导航、单列内容、滚动和焦点路径可达，控制台 0 警告、0 错误。Windows 生产 Electron 隔离烟测新增 4 个进程、4/4 响应、1 个可见 `UniComp` 窗口，正常关闭后残留 0，错误日志为空。

真实服务商 HTTP 0 次、真实 DNS 0 次、真实凭证读取/验证 0 次、收费调用 0 次、费用 0。Vidu 已用尽预算未恢复，Image V1 未晋级。

## 四、结论与下一步

自验收结论：`passed`。允许推送并非快进合并 `develop`，本地与远程功能分支继续保留。

合并后从最新 `develop` 创建 M5 第四支 `feature/ui-video-feature-wiring`，只把快速视频、文生视频和图生视频接到已合并的安全候选、动态参数、外发确认、提交、异步恢复与 Work 登记端口。快速视频固定为纯文生视频，不接收参考图片、参考视频或其他参考素材；不得访问真实服务商、真实凭证、产生收费调用或启动阶段 10。
