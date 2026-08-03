# 多服务商功能路由 M3｜Kling 官方合同证据

日期：2026-08-03

适用分支：`feature/kling-video-adapter`

证据用途：冻结 `KlingProviderPackage / KlingVideoAdapter` 的 API 2.0 官方异步视频协议边界，只支持纯文本 `text_to_video` 与单张受控首帧 `image_to_video`。本记录不是实时可用性证明，不批准真实 API、凭证验证或收费调用。

## 一、官方资料

- 接口鉴权：<https://klingai.com/document-api/api/get-started/authentication>
- Kling 3.0 Turbo 文生视频：<https://klingai.com/document-api/api/video/3-0-turbo/text-to-video>
- Kling 3.0 Turbo 图生视频：<https://klingai.com/document-api/api/video/3-0-turbo/image-to-video>
- API 更新公告：<https://klingai.com/document-api/updates/api>

资料于 2026-08-03 通过 Kling AI 官方公开只读文档核实。未登录控制台，未提交 API Key、媒体、Prompt 或业务数据，未调用 Kling 数据面接口。

## 二、鉴权与端点

中国地区新系统固定 Origin 为：

```text
https://api-beijing.klingai.com
```

API 2.0 使用 API Key Bearer 鉴权：

```text
Authorization: Bearer <API Key>
```

本适配器只使用：

```text
POST /text-to-video/{exact-model-endpoint-key}
POST /image-to-video/{exact-model-endpoint-key}
GET  /tasks?task_ids={exact-task-id}
```

模型版本是端点路径的一部分。Package 不按模型名称推断参数，也不发布未经当前分支逐项冻结的固定模型清单；Model Definition 和 ParameterSchema 只从用户精确登记的端点键与受控 Profile 生成。

官方文生和图生页面只公开创建与查询接口，没有公开任务取消端点。Adapter 的 `cancel` 生命周期操作因此不得发送 DELETE、POST 或其他猜测请求，只能明确返回远端仍在处理并继续保留同一任务的查询能力。

## 三、文生视频合同

官方创建路径格式为：

```text
POST /text-to-video/{model}
```

本版本只投影：

```json
{
  "prompt": "<controlled prompt>",
  "settings": {
    "resolution": "<declared value>",
    "aspect_ratio": "<declared value>",
    "duration": 5
  },
  "options": {
    "watermark_info": { "enabled": false }
  }
}
```

官方页面声明 Prompt 不超过 3072 字符；分辨率、画面比例、时长和水印开关是否可用以及可选值，必须来自精确 Profile 对应的 ParameterSchema。快速文生视频不接受 `assetId`、任意 URL、多图、尾帧、音视频、主体、回调、外部任务 ID、tools 或未知 JSON。

## 四、图生视频合同

官方创建路径格式为：

```text
POST /image-to-video/{model}
```

本版本只发送一段 Prompt 和一张首帧：

```json
{
  "contents": [
    { "type": "prompt", "text": "<controlled prompt>" },
    { "type": "first_frame", "url": "data:image/png;base64,..." }
  ],
  "settings": {
    "resolution": "<declared value>",
    "duration": 5
  },
  "options": {
    "watermark_info": { "enabled": false }
  }
}
```

官方页面声明图生视频 Prompt 不超过 2500 字符；图片只支持 JPG/JPEG/PNG，文件不超过 50 MB，宽高均不小于 300 px，宽高比位于 `1:2.5` 至 `2.5:1`，当前只支持首帧，不支持首帧加尾帧或仅尾帧。

工程门禁进一步要求图片必须由主进程项目素材端口按 `projectId + assetId` 解析，并复检 MIME、宽高、比例、字节数和实际字节长度。Renderer 路径、任意公网 URL、素材库远端 ID、多图和尾帧均不得进入请求。

## 五、异步状态、结果与用量

创建响应和查询任务只接受以下状态：

- `submitted`；
- `processing`；
- `succeeded`；
- `failed`。

查询只使用单个系统任务 ID，并要求响应恰好返回同一任务。成功结果只接受单个 `type=video` 的 HTTPS `url`；公开 Result Descriptor 不包含防盗链 URL。官方说明图片和视频结果会在 30 天后清理，因此 Adapter 以任务 `create_time + 30 天` 作为本地结果下载硬失效边界。下载固定为无鉴权头、手动重定向、公网 HTTPS 和 512 MiB 上限；远端结果仍须经过既有本地文件与媒体校验后才能登记正式 Work。

查询响应的 `billing` 数组是当前官方用量事实源：

- `charge_type=cash`：记录 `amount` 与 `list_price`，可验证 `cash_type`；
- `charge_type=unit`：只接受 `package_type=video` 并记录 `amount`；
- 多条同类型记录使用精确十进制求和，不使用浮点数；
- 未返回 `billing` 记为 `not_reported`；畸形、负数、未知类型或字段冲突记为 `invalid_response`；未知提交结果记为 `unknown_outcome`。

失败消息、远端原始响应、模型键、任务 ID、防盗链 URL、API Key 和请求正文不进入公开 DTO 或安全日志。Adapter 不自动重试，也不静默切换 Provider、Connection、Model 或 NewAPI。

## 六、未验证与停止边界

- 未读取或验证真实 API Key；
- 未验证任一真实模型端点当前实际参数范围；
- 未验证真实状态、失败正文、billing、结果 MIME、30 天清理或防盗链行为；
- 未发起真实服务商数据面 HTTP、余额查询或收费调用；
- 未实现回调、外部任务 ID、多图、首尾帧、仅尾帧、主体、音频或任意自定义请求体；
- 官方后续若发布取消接口，必须另立协议修订和专项分支，不得在当前版本中猜测补齐；
- 真实能力开放必须另立专项批准，并先验证精确 Model Profile、费用、结果下载和安全失败事实。
