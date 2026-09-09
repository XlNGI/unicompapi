# M3｜Seedance 视频适配器记录

日期：2026-08-03

分支：`feature/volcengine-seedance-video-adapter`

来源：`develop@ac7cb96`

实现提交：`f905ade`

## 一、范围

本支只实现 `VolcengineProviderPackage / SeedanceVideoAdapter` 的后台合同、合成 transport 和专项测试，承载：

- 纯文本 `text_to_video`；
- 专业页单张受控首帧 `image_to_video`；
- 异步提交、查询、取消、恢复、结果接收和 UsageObservation。

未修改 Electron、preload 或 React UI；未启动 M4、M5、阶段 10、macOS 实机与媒体工具链；未调用真实服务商数据面、读取或验证真实凭证、产生收费请求或恢复 Vidu 预算。

## 二、实际实现

- Volcengine Ark Package 新增版本化 Seedance Adapter/Protocol，声明 `submit/query/cancel/receive_result`；共享 Runtime 新增受控 GET、POST、DELETE、视频任务路径、视频任务 404/410 和受控结果下载；
- `createSeedanceVideoModelContract` 只从用户登记的精确 Model/Endpoint ID 与显式 Profile 声明生成 Definition、Profile 和动态 ParameterSchema，不发布固定模型清单，不按名称推断能力；
- 动态 Profile 可精确声明分辨率、比例、时长、帧数、seed 范围以及 camera/watermark/audio/last-frame 开关；RouteSnapshot 必须匹配相同版本的 ParameterSchema、ResultSchema、UsageSchema 和 constraint；
- 文生视频拒绝全部素材；图生视频只从项目内受控端口解析一张图片，复检 MIME、尺寸、比例和字节后固定为 Base64 `role=first_frame`；
- 请求只投影 Schema 白名单参数，`duration/frames` 互斥；不发送任意 URL、tools、safety identifier、priority、service tier、Draft 或未知 JSON；
- 创建响应只接受任务 ID；网络、超时、过大或畸形创建响应进入 `submission_outcome_unknown`，记录 `unknown_outcome` 且不自动重试；已知 HTTP 拒绝记录 `not_reported`；
- 查询严格映射六种官方状态，终态只解析白名单结果和 Usage；失败错误正文、远端模型名、原始响应与签名 URL 不公开；
- DELETE 空响应确认取消并记录 `not_reported`；运行中拒绝回到 `processing`，网络结果不确定进入 `unknown`；
- 结果描述只公开稳定本地 ID 与 MP4 声明，签名 URL 仅保留 24 小时内存快照；下载固定 HTTPS、手动重定向、无鉴权头和 512 MiB 上限；
- 应用重启通过原 RouteSnapshot、远端任务 ID 与 invocation attempt 重新 attach 同一 operation，不创建新任务；未知提交结果不能 attach，必须由用户显式新建 attempt；
- Usage 完整项为 `completion_tokens` 与 `total_tokens` 且必须相等，可选记录 `web_search_calls`；缺失、畸形和未知结果分别记为 `not_reported`、`invalid_response`、`unknown_outcome`。

## 三、验证结果

- Seedance 专项测试：15 项通过；原豆包视觉专项 10 项继续通过；
- `npm.cmd test`：Node 179 项与 Vitest 510 项，共 689 项通过，0 失败、0 跳过；
- `npm.cmd run typecheck`：通过；
- `npm.cmd run lint`：通过；
- `npm.cmd run build`：通过；
- `npm.cmd run audit:platform`：扫描 264 个文件，0 违规；
- `npm.cmd run verify:handoff`：50 条 checksum、27 个资源通过；
- `npm.cmd run verify:recovery-audit`：`passed`，安全违规 0、禁止制品 0；
- `npm.cmd run verify:phase9-closeout`：Windows 九类必需套件保持 `passed`，macOS 继续 deferred；
- `git diff --check`：通过。

本支没有 Electron、preload 或 UI 修改，因此不新增 Windows Electron 可见窗口烟测。测试 transport 全部为内存合成响应；真实服务商数据面 HTTP 0 次、真实凭证读取/验证 0 次、收费调用 0 次、费用 0。

## 四、未完成与下一步

- 官方模板仍没有获批的免费连接验证操作，保存连接不等于远端可用；
- 真实 Model/Endpoint 的参数、状态、Usage、取消和结果下载行为仍未验证，不开放真实运行；
- 当前只完成 Adapter 合同，不接入视频页面或 Work 登记编排；UI 必须等待 M4 后台集成验收通过；
- 下一支从合并后的最新 `develop` 创建 `feature/kling-video-adapter`，继续只使用官方合同证据和合成 transport。

自验收结论：`passed`，允许推送并非快进合并 `develop`，本地与远程功能分支继续保留。
