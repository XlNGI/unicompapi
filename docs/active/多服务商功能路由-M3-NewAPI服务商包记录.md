# 多服务商功能路由 M3｜NewAPI 服务商包记录

日期：2026-08-03

分支：`feature/newapi-provider-package`

来源：`develop@507c306`

实现提交：`3bd21c1`

## 一、范围

本支只实现 `NewApiProviderPackage`、`NewApiChatAdapter`、`NewApiImageAdapter`、`NewApiVideoAdapter`、共享安全 Runtime 和合成 transport 测试，承载：

- `GET /v1/models` 免费连接验证与目录同步；
- `text_chat / text_reasoning` 流式文本；
- 无参考素材的 `text_to_image`；
- 无素材 `text_to_video` 与专业页单张受控首帧 `image_to_video`；
- 图片同步结果、视频四态轮询、结果接收、取消决策、恢复 attach 和 UsageObservation。

未修改 Electron、preload 或 React UI；未启动 M4、M5、阶段 10、macOS 实机与媒体工具链；未调用真实 NewAPI 数据面、读取或验证真实凭证、产生收费请求或恢复 Vidu 预算。

## 二、实际实现

- 新增版本化 NewAPI compatible Package、必填自定义 `/v1` Base URL、结构化 API Key CredentialSchema、HTTPS/回环 HTTP EndpointPolicy 和三个精确 Adapter/Protocol；
- EndpointPolicy 默认拒绝私网，回环 HTTP 要求连接创建时显式确认；Runtime 再校验精确连接快照、凭证版本、Origin、路径、手动重定向、请求/响应上限，并向 transport 下发 `dnsRebindingProtection=required`；
- `createNewApiModelContract` 只从精确 provider model key 与显式工程声明生成 Definition、三个适配器的 Profile 模板和动态 ParameterSchema；Package 不预置模型，不按目录名称猜功能；
- 管理适配器严格解析 OpenAI 格式模型目录，只返回 ID 和安全显示名；未知目录模型保持无 Profile、不可创作；
- 文本适配器复用既有 ConversationResponseExecution 生命周期和受控 SSE 通道，只发送白名单消息与参数；禁用 tools、user、audio、多模态和未知 JSON，取消与退出不自动重试；
- 文本 Usage 精确映射 prompt/completion/total、cached 和 reasoning token，畸形或冲突记为 `invalid_response`；
- 图片适配器只实现纯文本 `POST /images/generations`，不接收素材；响应只接受单个 URL 或 Base64，Base64 复检大小和 PNG/JPEG/WebP 文件头，URL 只进入无凭证、拒绝私网和要求 DNS 重绑定防护的受控下载端口；
- 图片编辑因官方结果响应合同不足保持 blocked，不发布 `image_edit` Profile；
- 视频适配器使用受控 multipart；文生视频无图片字段，图生视频只接受一个项目内 JPG/PNG `assetId`，不接受任意 URL、多图、尾帧、metadata、user、n 或未知 JSON；
- 视频查询精确映射 `queued/in_progress/completed/failed`，内容下载固定为原连接 `/videos/{id}/content` 与原凭证；公开描述不包含下载 URL；
- 官方未发布视频取消端点，取消不发 HTTP 并返回 `processing`；视频没有公开 Usage 合同，终态固定记录 `not_reported`；
- 请求已开始后的网络、超时、过大或畸形响应进入 `submission_outcome_unknown`，不自动重试；视频重启恢复只能按原 RouteSnapshot、任务 ID 和 invocation attempt attach 同一 operation。

## 三、验证结果

- NewAPI 专项测试：19 项通过；
- `npm.cmd test`：Node 179 项与 Vitest 542 项，共 721 项通过，0 失败、0 跳过；
- `npm.cmd run typecheck`：通过；
- `npm.cmd run lint`：通过；
- `npm.cmd run build`：通过；
- `npm.cmd run audit:platform`：扫描 274 个文件，0 违规；
- `npm.cmd run verify:handoff`：50 条 checksum、27 个权威资源通过；
- `npm.cmd run verify:recovery-audit`：`passed`，安全违规 0、禁止制品 0；
- `npm.cmd run verify:phase9-closeout`：Windows 九类必需套件保持 `passed`，macOS 继续 deferred；
- `npm.cmd run verify:secure-storage`：Windows x64 可用，明文未持久化；
- `npm.cmd run verify:runtime-integrations`：运行时集成和开发态 FFmpeg 8.1.2 通过；
- `git diff --check`：通过；
- NewAPI 范围敏感值扫描：0 个真实凭证命中。

本支未修改 Electron、preload 或 UI，因此不触发新增可见 Electron 窗口烟测。测试 transport 全部为内存合成响应；真实服务商数据面 HTTP 0 次、真实凭证读取/验证 0 次、收费调用 0 次、费用 0。

## 四、未完成与下一步

- 自定义 NewAPI 实例的 DNS 解析与重绑定防护必须由 M4 生产 transport 集成验收继续证明；本支只冻结并测试 transport 安全合同；
- 真实实例、模型 Profile、SSE、图片结果、视频状态和内容下载仍未验证，不开放真实运行；
- `POST /v1/responses` 未实现；图片编辑结果合同不足，视频取消与 Usage 无公开合同，当前版本不得猜测；
- 当前只完成 Package 和 Adapter，不接入页面或 Work 登记编排；UI 必须等待 M4 后台集成验收通过；
- 下一支从合并后的最新 `develop` 创建 `feature/vidu-provider-package-migration`，只迁移现有 C2 Vidu 包到通用合同，不联网、不恢复预算、不晋级 Image V1。

自验收结论：`passed`，允许推送并非快进合并 `develop`；本地与远程功能分支继续保留。
