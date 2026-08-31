# 多服务商功能路由 M3｜DeepSeek 官方合同证据

日期：2026-08-03

适用分支：`feature/deepseek-chat-adapter`

证据版本：`deepseek-api-docs@2026-08-03`

验证方式：只读访问 DeepSeek 官方 API 文档；未登录、未提交凭证、未调用真实 API、未读取原始生产响应、未产生费用。

## 一、官方来源

- API 文档入口：<https://api-docs.deepseek.com/>
- 创建聊天补全：<https://api-docs.deepseek.com/api/create-chat-completion>
- Thinking Mode：<https://api-docs.deepseek.com/guides/thinking_mode>
- 模型列表：<https://api-docs.deepseek.com/api/list-models>
- Token Usage：<https://api-docs.deepseek.com/quick_start/token_usage>
- 错误码：<https://api-docs.deepseek.com/quick_start/error_codes>

## 二、冻结合同

### 2.1 Endpoint 与传输

- 固定 HTTPS Origin：`https://api.deepseek.com`
- 聊天提交：`POST /chat/completions`
- 模型目录：`GET /models`
- 流式响应采用 data-only SSE，以 `data: [DONE]` 结束。
- 请求 `stream_options.include_usage=true` 时，`[DONE]` 前可出现一次 `choices=[]` 的最终 Usage chunk。
- 本版本拒绝重定向、非官方 Origin、非白名单 Content-Type、超限请求/响应和未知响应字段。

### 2.2 文本与推理参数

- 普通文本能力使用 `thinking.type=disabled`，允许可选 `max_tokens`、`temperature` 或 `top_p`。
- 本地约束禁止同时发送 `temperature` 与 `top_p`，避免含糊采样配置。
- 推理能力使用 `thinking.type=enabled`，允许可选 `max_tokens` 与 `reasoning_effort`。
- `reasoning_effort` 冻结为 `low | high | max`。
- 推理能力不发送 `temperature` 或 `top_p`。
- 所有聊天请求固定 `stream=true` 与 `stream_options.include_usage=true`。
- 本版本不发送 `tools`、`user_id`、`response_format`、未知 JSON 字段或额外隐私标识。

### 2.3 流式响应

- 受控内容增量只接受 `delta.content`。
- `delta.reasoning_content` 只做协议类型验证，不写入受控回答内容流，也不进入公开结果。
- 终止原因冻结为：`stop | length | content_filter | tool_calls | insufficient_system_resource`。
- 只有 `stop` 被视为正常完成；其他官方终止原因映射为明确失败码，不自动重试或切换服务商。
- 远端响应 ID 只用于单次流内一致性校验，不作为本地 operation ID，也不进入公开 DTO。

### 2.4 Usage

本版本只接受以下官方字段：

- `completion_tokens`
- `prompt_tokens`
- `total_tokens`
- `prompt_cache_hit_tokens`
- `prompt_cache_miss_tokens`
- `completion_tokens_details.reasoning_tokens`

本地校验要求 `total_tokens = prompt_tokens + completion_tokens`；同时存在缓存命中与未命中字段时，要求二者之和等于 `prompt_tokens`；推理 token 不得超过 `completion_tokens`。未知字段、负数、非整数或不一致统计均标记为无效响应，不猜测价格或费用。

### 2.5 模型目录与错误码

- `GET /models` 响应合同冻结为 `object=list` 与 `data[]`；目录项只接受 `id`、`object=model`、`owned_by`。
- 2026-08-03 官方文档中用于本版本精确定义的模型键为 `deepseek-v4-flash`、`deepseek-v4-pro`。
- 官方 HTTP 错误冻结为：400、401、402、422、429、500、503。
- 本地分别映射为无效请求、鉴权失败、余额不足、参数无效、限流、服务商不可用；单次请求失败不触发自动重试。

## 三、安全与停止边界

- 本证据不包含 API Key、Token、Prompt、响应正文、签名 URL、价格或账户信息。
- 连接验证与目录同步仅定义为 `GET /models` 的无生成费用能力；本支仍未执行真实凭证验证。
- 本支只通过合成 transport 验证协议，不声明真实 DeepSeek API 已联调通过。
- 模型、参数和 Usage 均由版本化 DeepSeek Package 拥有，不进入通用 UI 或通用路由硬编码。
- 真实 API、真实凭证、收费验证、macOS 实机与媒体工具链以及阶段 10 均不在本证据和本分支范围内。
