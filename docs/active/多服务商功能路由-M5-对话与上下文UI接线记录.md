# 多服务商功能路由 M5｜对话与上下文 UI 接线记录

日期：2026-08-03

分支：`feature/ui-conversation-context-wiring`

来源：`develop@82ca9c4`

实现提交：`4e55567`

## 一、范围与边界

本支只完成 M5 第二支对话与项目上下文 UI 后置接线：对话写入、项目上下文固定版本选择、文本候选查询、外发确认、文本提交、流式事件回放、取消和恢复读取。

页面只消费已合并的安全 DTO、不可变 ProjectContext 快照、选择令牌和文本执行端口。对话页没有图片或视频生成入口，不接收媒体参考素材，不读取真实凭证，不发起真实服务商 HTTP/DNS 或收费调用。本支未启动后续 M5 分支、阶段 10、macOS 实机或媒体工具链；阶段 9 权威方案原件保持只读。

## 二、实际实现

- 对话页明确区分应用级旧对话和当前项目对话；旧对话保持只读，用户可将其中符合条件的已完成纯文本消息复制为当前项目完整副本，复制采用内存构建与单次原子落盘，不修改旧记录。
- 项目上下文继续只从当前项目、可写对话的已完成消息登记；已登记上下文必须先读取固定 revision，随后由用户显式勾选，才会进入本次文本回复的不可变外发快照。
- 新增项目范围文本回复 Draft、候选列表、准备提交、确认提交、执行读取和事件重放控制器；renderer 不传 projectId、RouteSnapshot、Package、Adapter、Endpoint、凭证、Prompt、路径、Hash 或远端 operation。
- 候选由 Registry、精确 Model Profile、Feature Contract、ParameterSchema 和 RuntimeAccessPolicy 共同生成；页面只展示安全名称、可用性和 Schema，不按服务商名、模型名、协议或 Usage 字段路径分支。
- 提交前必须展示并确认接收方、内容类别、上下文数量和费用事实；选择令牌、确认记录、Draft revision 或上下文固定版本任一过期即失败关闭，不静默换路由。
- 文本执行只通过已合并的流式端口读取已持久化事件；页面可显示 pending、streaming、completed、failed、cancelled 和 interrupted 状态，取消与重放沿用主进程状态机，不伪造片段、进度、费用或成功。
- 无当前项目统一返回 `project_not_open`；ProjectContext DTO 固定 revision，公开 DTO 与错误不泄漏正文快照之外的内部事实、Hash、Prompt、文件路径或原始响应。
- 补齐 IPC、Controller、Runtime、Repository 和 UI 静态合同测试，覆盖无项目、旧对话复制、并发复制、超长标题、只读阻断、固定上下文版本、候选令牌、确认、提交、重放、取消和安全投影。

## 三、验证结果

- `npm.cmd test`：Node 179 项与 Vitest 563 项，共 742 项通过，0 失败、0 跳过；
- `npm.cmd run typecheck`：通过；
- `npm.cmd run lint`：通过；
- `npm.cmd run build`：通过，Vite 87 个模块完成生产构建；
- `npm.cmd run audit:platform`：扫描 282 个文件，0 违规；
- `npm.cmd run verify:handoff`：50 项 checksum、27 个权威资源通过；
- `npm.cmd run verify:recovery-audit`：`passed`，安全违规 0、禁止制品 0；
- `npm.cmd run verify:phase9-closeout`：Windows 九类必需套件保持 `passed`，macOS 保持 deferred；
- `npm.cmd run verify:secure-storage`：Windows x64 可用，明文未持久化；
- `npm.cmd run verify:runtime-integrations`：通过；
- `git diff --check`：通过。

浏览器只读可见检查覆盖 `1440x900`：对话三列、空状态、模式切换和操作区无横向溢出、按钮裁切或元素重叠，控制台 0 警告、0 错误。Windows 生产 Electron 隔离烟测在 `1080x720` 新增 4 个进程、4/4 响应、1 个可见 `UniComp` 窗口，正常关闭后残留 0；隔离用户目录已移入回收站。

真实服务商 HTTP 0 次、真实 DNS 0 次、真实凭证读取/验证 0 次、收费调用 0 次、费用 0。Vidu 已用尽预算未恢复，Image V1 未晋级。

## 四、结论与下一步

自验收结论：`passed`。允许推送并非快进合并 `develop`，本地与远程功能分支继续保留。

合并后从最新 `develop` 创建 M5 第三支 `feature/ui-image-feature-wiring`，只把快速生图、专业生图和图片工具接到已合并的候选、参数、外发确认、提交、结果接收与 Work 登记端口。快速生图固定为纯文生图，不接收参考图或其他参考素材；不得访问真实服务商、真实凭证或启动阶段 10。
