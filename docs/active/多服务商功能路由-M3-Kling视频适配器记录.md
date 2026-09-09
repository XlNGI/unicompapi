# 多服务商功能路由 M3｜Kling 视频适配器记录

日期：2026-08-03

分支：`feature/kling-video-adapter`

来源：`develop@375d44d`

实现提交：`8b02a40`

## 一、范围

本支只实现 `KlingProviderPackage / KlingVideoAdapter` 的后台合同、合成 transport 和专项测试，承载：

- 纯文本 `text_to_video`；
- 专业页单张受控首帧 `image_to_video`；
- 异步提交、单任务查询、本地取消决策、重启恢复、结果接收和 Billing UsageObservation。

未修改 Electron、preload 或 React UI；未启动 M4、M5、阶段 10、macOS 实机与媒体工具链；未调用真实服务商数据面、读取或验证真实凭证、产生收费请求或恢复 Vidu 预算。

## 二、实际实现

- 新增版本化 Kling Package、API 2.0 Adapter/Protocol、结构化 API Key CredentialSchema、固定中国区 HTTPS EndpointPolicy 和 `manual_exact` 模型登记模板；
- `createKlingVideoModelContract` 只从精确模型端点键和显式 Profile 生成 Definition、Profile 与动态 ParameterSchema，不发布固定模型，不按名称推断能力；
- 文生视频严格拒绝素材，图生视频只从项目内受控端口解析一张 JPG/PNG，复检 50,000,000 字节、最小 300 px、`0.4—2.5` 比例和实际字节长度后固定为 Base64 `first_frame`；
- 请求只允许 Profile 声明的 `resolution`、文生 `aspect_ratio`、`duration` 和 `watermark`，不发送任意 URL、多图、首尾帧、回调、外部任务 ID、tools 或未知 JSON；
- Runtime 只允许固定官方 Origin、Bearer API Key、受控 POST/GET、系统代理、手动重定向、请求/响应上限和结构化安全错误；安全日志不包含 URL、模型、任务、凭证、Prompt、媒体或响应正文；
- 创建结果严格解析 API 2.0 envelope 和任务 ID；请求已开始后的网络、超时、过大或畸形响应进入 `submission_outcome_unknown`，记录 `unknown_outcome` 且不自动重试；
- 查询只发送单个 `task_ids`，要求恰好返回同一任务，并精确映射 `submitted/processing/succeeded/failed`；失败正文和原始响应不公开；
- 官方文档未发布取消端点，`cancel` 固定不发 HTTP 并返回 `processing`，保留同一远端任务查询，避免伪造已取消事实；
- Billing 白名单记录条目数、现金扣减、现金刊例价和视频资源包扣减，多条记录使用 BigInt 支撑的精确十进制求和；缺失、畸形和未知提交分别记录 `not_reported`、`invalid_response`、`unknown_outcome`；
- 结果描述只公开稳定本地 ID 与 MP4 声明，防盗链 URL 只留内存并按 `create_time + 30 天` 失效；下载使用无鉴权头、公网 HTTPS、手动重定向和 512 MiB 上限；
- 应用重启只能按原 RouteSnapshot、远端任务 ID 和 invocation attempt 重新 attach 同一 operation；未知提交结果不能 attach，必须由用户显式建立新 attempt。

## 三、验证结果

- Kling 专项测试：13 项通过；
- `npm.cmd test`：Node 179 项与 Vitest 523 项，共 702 项通过，0 失败、0 跳过；
- `npm.cmd run typecheck`：通过；
- `npm.cmd run lint`：通过；
- `npm.cmd run build`：通过；
- `npm.cmd run audit:platform`：扫描 268 个文件，0 违规；
- `npm.cmd run verify:handoff`：50 条 checksum、27 个权威资源通过；
- `npm.cmd run verify:recovery-audit`：`passed`，安全违规 0、禁止制品 0；
- `npm.cmd run verify:phase9-closeout`：Windows 九类必需套件保持 `passed`，macOS 继续 deferred；
- `npm.cmd run verify:secure-storage`：Windows x64 可用，明文未持久化；
- `npm.cmd run verify:runtime-integrations`：运行时集成和开发态 FFmpeg 8.1.2 通过；
- `git diff --check`：通过；
- Kling 范围敏感值扫描：0 命中。

本支未修改 Electron、preload 或 UI，因此不触发新增可见 Electron 窗口烟测。测试 transport 全部为内存合成响应；真实服务商数据面 HTTP 0 次、真实凭证读取/验证 0 次、收费调用 0 次、费用 0。

## 四、未完成与下一步

- 官方模板没有获批的免费连接验证操作，保存连接不等于远端可用；
- 真实模型端点参数、状态、失败、Billing、结果 MIME、30 天清理和防盗链行为仍未验证，不开放真实运行；
- 官方若新增取消端点，必须以新的协议版本和专项分支实现，当前版本不得猜测；
- 当前只完成 Adapter 合同，不接入视频页面或 Work 登记编排；UI 必须等待 M4 后台集成验收通过；
- 下一支从合并后的最新 `develop` 创建 `feature/newapi-provider-package`，继续只使用公开合同证据和合成 transport。

自验收结论：`passed`，允许推送并非快进合并 `develop`；本地与远程功能分支继续保留。
