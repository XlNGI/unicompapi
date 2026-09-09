# 多服务商功能路由 M3｜NewAPI 官方合同证据

日期：2026-08-03

适用分支：`feature/newapi-provider-package`

证据用途：冻结 `NewApiProviderPackage` 及其 Chat、Image、Video 三个适配器的兼容协议边界。本记录只证明公开文档中的接口合同，不证明任一自定义 NewAPI 实例、模型或部署实际支持对应功能，也不批准真实凭证验证、数据面调用或收费测试。

## 一、官方资料

- 模型目录：<https://docs.newapi.pro/zh/docs/api/ai-model/models/list/listmodels>
- Chat Completions：<https://docs.newapi.pro/zh/docs/api/ai-model/chat/openai/createchatcompletion>
- 图片生成：<https://docs.newapi.pro/zh/docs/api/ai-model/images/openai/post-v1-images-generations>
- 图片编辑：<https://docs.newapi.pro/zh/docs/api/ai-model/images/openai/post-v1-images-edits>
- 视频创建：<https://docs.newapi.pro/zh/docs/api/ai-model/videos/sora/createvideo>
- 视频查询：<https://docs.newapi.pro/zh/docs/api/ai-model/videos/sora/getvideo>
- 视频内容：<https://docs.newapi.pro/zh/docs/api/ai-model/videos/sora/getvideocontent>
- OpenAI 视频对象状态补充证据：<https://developers.openai.com/api/reference/resources/videos.md>

资料于 2026-08-03 通过官方公开只读文档核实。未登录 NewAPI 控制台，未提交 Base URL、API Key、Prompt、媒体或业务数据，未调用任何 NewAPI 实例的数据面接口。

NewAPI 视频页面将状态字段声明为字符串并明确采用 OpenAI 视频协议，但未在页面中列出枚举；因此本支只以 OpenAI 官方视频对象公开的 `queued / in_progress / completed / failed` 作为补充协议证据。若目标 NewAPI 实例返回其他状态，当前协议版本失败关闭，不按名称猜测。

## 二、Package、鉴权与自定义地址

首批只提供一个 `compatible_custom` 模板。用户必须填写精确 Base URL，当前版本要求 URL 路径以 `/v1` 结束；API 使用 Bearer Token：

```text
Authorization: Bearer <API Key>
```

允许的入口固定为：

```text
GET  /v1/models
POST /v1/chat/completions
POST /v1/images/generations
POST /v1/videos
GET  /v1/videos/{task_id}
GET  /v1/videos/{task_id}/content
```

公网地址默认只允许 HTTPS。HTTP 只允许用户在连接创建时明确确认的本机回环地址；私网地址默认拒绝。运行时要求手动重定向、同一 Origin、系统代理策略、请求/响应上限和 DNS 重绑定防护；凭证不得跨 Origin 或随图片结果 URL 发送。

`GET /v1/models` 的响应只同步 `id` 和安全显示名。目录中的模型不自动获得 Profile，不根据模型 ID、前缀、后缀或相似名称推断文本、图片或视频能力。只有工程侧显式登记、版本化并精确匹配的 Model Definition/Profile 才能进入候选。

## 三、文本合同

文本适配器只使用：

```text
POST /v1/chat/completions
```

请求固定为流式并请求最终 Usage：

```json
{
  "model": "<exact provider model key>",
  "messages": [{ "role": "user", "content": "<controlled text>" }],
  "stream": true,
  "stream_options": { "include_usage": true }
}
```

可调字段只能来自精确 ParameterSchema，首批白名单为 `max_tokens`、`temperature`、`top_p` 和推理 Profile 的 `reasoning_effort`。`temperature` 与 `top_p` 不同时发送。禁止 `tools`、`user`、`audio`、多模态消息、任意 response format 和未知 JSON。

SSE 只接受 data-only event、单 choice、稳定响应 ID 和精确响应模型；`reasoning_content` 只验证后丢弃，不进入普通回复内容。完成、失败、取消和应用退出分别进入既有文本执行生命周期；不自动重试，不静默切换连接、模型或官方服务。

Usage 只接受 `prompt_tokens / completion_tokens / total_tokens`，并可记录 `prompt_tokens_details.cached_tokens` 与 `completion_tokens_details.reasoning_tokens`。总量不一致、负数、未知字段或重复最终 Usage 均失败关闭。

`POST /v1/responses` 虽列在规划入口中，但当前分支没有足够必要性替代已冻结的 Chat Completions 文本合同，因此不实现、不自动探测、不透传。

## 四、图片合同

图片适配器只实现纯文本 `text_to_image`：

```text
POST /v1/images/generations
```

请求只发送精确模型、Prompt 和 Profile 明确声明的 `size / quality / style / output_format`；不发送参考素材、图片 URL、多图、mask、`n`、`user` 或未知 JSON。响应要求恰好一个 `data` 结果，并且 `url` 与 `b64_json` 二选一。

Base64 结果必须通过严格解码、大小上限和 PNG/JPEG/WebP 文件头识别。URL 结果只能交给无凭证、拒绝私网并要求 DNS 重绑定防护的受控下载端口；下载后再次核对声明 MIME 与实际文件头。任何远端结果仍须经过既有本地写入、媒体探测、字节校验、SHA-256 和原子发布后才能登记正式 Work。

图片 Usage 若存在，只接受 `input_tokens / output_tokens / total_tokens`，并可记录 `input_tokens_details.text_tokens / image_tokens`；缺失时记为 `not_reported`，不估算。

官方图片编辑页面要求 multipart 单图和可选 mask，但当前公开响应示例只有空对象，缺少可验证的结果引用合同。因此 `POST /v1/images/edits` 在本协议版本保持 blocked，不发布 `image_edit` Profile，不因模型名称或其他图片接口成功而晋级。

## 五、视频合同

视频适配器使用：

```text
POST /v1/videos
GET  /v1/videos/{task_id}
GET  /v1/videos/{task_id}/content
```

创建固定为受控 multipart：

- `text_to_video`：只发送精确模型、Prompt 与 Profile 声明的参数，不包含图片字段；
- `image_to_video`：额外发送一张由主进程按 `projectId + assetId` 解析并复检的 JPG/PNG 首帧；
- 首批参数白名单为 `duration / width / height / fps / seed`，可选值和范围只来自精确 Profile；
- 禁止任意图片 URL、多图、尾帧、metadata、`user`、`n`、回调和未知 JSON。

创建与查询只接受 OpenAI 视频对象的 `queued / in_progress / completed / failed` 四态，要求任务 ID 和模型与原 RouteSnapshot 一致。视频内容只能从同一连接的 `/content` 端点以原凭证下载，公开 Result Descriptor 不包含远端 URL 或任务正文。

NewAPI 官方页面没有公开视频取消接口；`cancel` 因此不得发送 DELETE、POST 或其他猜测请求，只返回远端仍在处理并保留同一任务查询。视频页面没有公开 Usage 合同，终态固定记录 `not_reported`，不估算价格、时长费用或 token。

## 六、未验证与停止边界

- 未读取、保存或验证真实 Base URL、API Key；
- 未验证任何 NewAPI 实例的部署配置、模型目录、代理、重定向或 DNS 解析；
- 未验证任一真实模型支持文本、推理、图片或视频；
- 未验证真实 SSE、图片 Base64/URL、视频对象、失败正文或内容下载；
- 未执行 `POST /v1/responses`、图片编辑、视频取消、任意 REST 自动识别或未知 JSON 透传；
- 未发起真实服务商数据面 HTTP、余额查询或收费调用；
- 真实能力开放必须另立专项批准，并验证精确实例、模型 Profile、费用、隐私和本地结果闭环。
