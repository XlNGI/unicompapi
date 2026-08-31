# 多服务商功能路由 M3｜DeepSeek 文本适配器记录

日期：2026-08-03

分支：`feature/deepseek-chat-adapter`

来源基线：`develop@e284644`

实现提交：`eff72e5`

验收结论：`passed`

## 一、范围与边界

本支是 M3 第三支，只实现版本化 DeepSeek Provider Package、官方连接管理适配器、精确文本提交、SSE 流式响应、取消、应用退出中断、恢复决策和 UsageSchema 映射。

协议依据只来自 2026-08-03 只读访问的 DeepSeek 官方文档，证据见 `docs/active/多服务商功能路由-M3-DeepSeek官方合同证据.md`。本支未登录、未发起真实 DeepSeek HTTP、未读取或验证真实凭证、未产生收费调用；未执行 macOS 实机与媒体工具链，未启动 UI 分支或阶段 10。

## 二、实际实现

### 2.1 Package 与管理合同

- 新增版本化 DeepSeek Package、官方固定 Origin 模板、结构化 API Key CredentialSchema、EndpointPolicy、精确 Adapter/Protocol 绑定、模型定义、普通文本/推理 ParameterSchema 和 UsageSchema。
- 模型键与能力映射只存在于 DeepSeek Package 数据；通用 Registry、路由和 UI 不按模型名称猜测协议能力。
- 连接验证和目录同步只定义为 `GET /models`；目录响应严格限制为 `object=list` 与 `id/object/owned_by` 白名单，不保存原始响应。
- 安全模板 DTO 不包含官方 URL、EndpointPolicy、Adapter 或 Protocol 内部事实。

### 2.2 文本请求与流式响应

- `text_chat` 固定 `thinking.type=disabled`，只允许可选 `max_tokens`、`temperature` 或 `top_p`，并禁止同时发送两种采样字段。
- `text_reasoning` 固定 `thinking.type=enabled`，只允许可选 `max_tokens` 和 `reasoning_effort=low|high|max`，不发送采样字段。
- 所有请求固定 `stream=true`、`stream_options.include_usage=true`；不发送 tools、user ID、response format、未知 JSON 或隐私标识。
- SSE 只接受 data-only event 与终止 `[DONE]`；内容流只追加 `delta.content`，`reasoning_content` 只验证后丢弃。
- 远端响应 ID 只做单次流一致性校验，不作为本地 operation ID，也不进入公开结果、日志或 DTO。
- 非 `stop` 的官方 finish reason 映射为明确失败；HTTP、协议和流解析失败均不自动重试、不自动切换服务商。

### 2.3 Usage、取消与恢复

- Usage 只接受六项版本化 token 指标，校验总量、缓存拆分与推理 token 一致性；未知字段、非整数或不一致统计失败关闭。
- 正常完成保存 `reported | not_reported`；畸形响应保存 `invalid_response`；用户取消保存 `not_reported`；应用退出中断保存 `unknown_outcome`。
- 用户取消会中断单个活动流；应用退出会中断全部活动流并等待本地终态持久化，不尝试恢复同一远端 operation。
- 中断后的恢复只允许本地重放并要求用户显式创建新 attempt，不自动重试。

### 2.4 RouteSnapshot 与安全日志

- 不可变 RouteSnapshot 新增内部可选 `providerModelKey`，使 Adapter 使用提交时精确模型键；公开调用记录 DTO 仍不返回 RouteSnapshot、Package、Adapter、Endpoint、凭证、Prompt 或远端 ID。
- 日志只记录操作类别、HTTP 方法、状态、安全错误码和耗时，不记录 URL、Header、凭证、模型、Prompt 或响应正文。

## 三、验证结果

| 门禁 | 结果 |
| --- | --- |
| DeepSeek 与 RouteSnapshot 专项 | 14 项通过，0 失败 |
| `npm.cmd test` | Node 179 项 + Vitest 485 项，共 664 项通过，0 失败、0 跳过 |
| `npm.cmd run typecheck` | 通过 |
| `npm.cmd run lint` | 通过 |
| `npm.cmd run build` | 通过，Vite 87 modules |
| `npm.cmd run audit:platform` | 259 文件，0 违规 |
| `npm.cmd run verify:handoff` | 50 项 checksum、27 个权威资源，0 失败 |
| `npm.cmd run verify:recovery-audit` | `passed`，安全违规 0，禁止制品 0 |
| `npm.cmd run verify:runtime-integrations` | Windows x64 运行时集成通过，媒体组件仅开发态 |
| `npm.cmd run verify:secure-storage` | 可用，明文持久化为 `false` |
| `npm.cmd run verify:phase9-closeout` | `passed`，macOS 延期目标保持不变 |
| `git diff --check` | 通过 |
| 变更文件敏感信息扫描 | 9 个范围内文件通过 |

本支未修改 Electron、preload 或 React UI，不触发新增可见 Electron 烟测。真实服务商 HTTP 0 次、真实凭证读取/验证 0 次、收费调用 0 次、费用 0；Vidu 预算继续封存。

## 四、未完成项与停止边界

- DeepSeek 适配器尚未进入后台统一 composition；该接线与跨 Provider 闭环属于 M4 后台集成验收，不在本支提前完成。
- 豆包视觉、Seedance、可灵、NewAPI Package 和 Vidu Package 迁移继续按 M3 后续独立分支执行。
- UI 必须等待 M3 全部目标和 M4 `provider-backend-integration-acceptance` 通过；本支不修改现有页面。
- 真实 API、真实凭证、收费验证、macOS 实机与媒体工具链和阶段 10 仍不在授权范围内。

## 五、下一步

本支通过自验收后推送并以 `--no-ff` 合并 `develop`，保留本地与远程功能分支。随后从最新 `develop` 创建 M3 第四支 `feature/volcengine-doubao-vision-adapter`，依据火山引擎官方合同证据与合成 transport 实现精确视觉适配，不进行真实联网、凭证验证或收费调用。
