# M3｜Seedance 视频官方合同证据

日期：2026-08-03

适用分支：`feature/volcengine-seedance-video-adapter`

证据用途：冻结 `VolcengineProviderPackage / SeedanceVideoAdapter` 的官方异步视频协议边界，只支持 `text_to_video` 与单张受控首帧 `image_to_video`。本记录不是实时可用性证明，不批准真实 API、凭证验证或收费调用。

## 一、官方资料

- 视频生成 API 目录：<https://www.volcengine.com/docs/82379/1520758>
- 创建视频生成任务：<https://www.volcengine.com/docs/82379/1520757>
- 查询视频生成任务：<https://www.volcengine.com/docs/82379/1521309>
- 取消或删除视频生成任务：<https://www.volcengine.com/docs/82379/1521720>
- Base URL 与鉴权：<https://www.volcengine.com/docs/82379/1298459>
- 错误码：<https://www.volcengine.com/docs/82379/1299023>

资料通过火山引擎官方公开只读文档接口核实；未登录控制台，未提交 API Key、用户媒体、Prompt 或业务数据，未调用方舟数据面生成接口。

## 二、冻结的异步接口

官方数据面 Base URL 为：

```text
https://ark.cn-beijing.volces.com/api/v3
```

本版本只使用：

```text
POST   /contents/generations/tasks
GET    /contents/generations/tasks/{id}
DELETE /contents/generations/tasks/{id}
```

全部请求使用结构化 API Key 的 Bearer 鉴权、固定官方 HTTPS Origin 和手动重定向。创建接口为异步接口，成功响应返回任务 `id`；Adapter 必须保存该 ID 并按提交时不可变 `RouteSnapshot` 查询同一任务，不允许根据当前默认路由切换 Provider、Connection、模型或协议。

DELETE 只取消 `queued` 任务；对 `failed`、`succeeded`、`expired` 任务执行删除记录语义。官方接口无响应参数，本版本只接受空响应体。运行中任务拒绝取消时回到 `processing`；网络结果不确定时进入 `unknown`，不自动重试。

## 三、输入与参数合同

Package 不发布固定 Seedance 模型名。`model` 只能来自用户精确登记并由受控 Profile 绑定的 Model ID 或 Endpoint ID；ProductFeature、ParameterSchema 与可选参数来自该精确 Profile，不按模型名称猜测。

文生视频只发送纯文本：

```json
{
  "model": "<exact Model/Endpoint ID>",
  "content": [
    { "type": "text", "text": "<controlled prompt>" }
  ]
}
```

图生视频只允许一张项目内已复检首帧：

```json
{
  "model": "<exact Model/Endpoint ID>",
  "content": [
    { "type": "text", "text": "<controlled prompt>" },
    {
      "type": "image_url",
      "image_url": { "url": "data:image/png;base64,..." },
      "role": "first_frame"
    }
  ]
}
```

本地图片门禁固定为：

- 只接受主进程受控项目素材端口返回的字节、MIME、宽高和字节数；
- 只接受 JPEG、PNG、WebP、BMP、TIFF 与 GIF；
- 宽、高均位于 `[300, 6000]`，宽高比位于 `[0.4, 2.5]`；
- 单图严格小于 30,000,000 字节，整个序列化请求不超过 64,000,000 字节；
- 不接受 renderer 路径、任意公网 URL、素材库 ID、视频、音频、多图、首尾帧或多模态参考。

参数白名单为：

- `resolution`；
- `ratio`；
- `duration`；
- `frames`；
- `seed`；
- `camera_fixed`；
- `watermark`；
- `generate_audio`；
- `return_last_frame`。

每项是否出现、枚举值或范围必须来自 RouteSnapshot 对应的精确 ParameterSchema。`duration` 与 `frames` 在本项目中互斥，避免依赖服务端优先级覆盖。`seed=-1` 等于随机语义，本项目通过省略字段使用服务商默认值，不开放负数参数。请求不发送 `tools`、`safety_identifier`、`priority`、`service_tier`、`draft` 或未知 JSON。

## 四、状态、结果与用量合同

查询状态只接受：

- `queued`；
- `running`；
- `cancelled`；
- `succeeded`；
- `failed`；
- `expired`。

成功结果来自 `content.video_url`，官方声明 URL 有效期为 24 小时。签名 URL 只保存在 Adapter 的短期内存结果快照中，不进入安全日志或公开结果描述；下载仍使用手动重定向、受控 HTTPS URL 和 512 MiB 上限。远端结果必须经过现有本地下载、媒体探测和文件校验流程后才能登记 Work。

Usage 白名单固定为：

- `completion_tokens`；
- `total_tokens`；
- 可选 `tool_usage.web_search`，映射为 `web_search_calls`。

视频生成不统计输入 token，因此必须满足 `total_tokens = completion_tokens`。未知 usage 字段、负数、非整数或数量矛盾进入 `invalid_response`；终态未返回 usage 时记录 `not_reported`；未知提交结果记录 `unknown_outcome`。可重试属性只保存为事实，Adapter 不自动重试或切换路由。

HTTP 404 与 410 在视频任务路径映射为 `operation_not_found`。401、403、409/422、429、5xx、超时、代理和网络错误保持结构化安全码；错误正文、远端模型名、任务失败详情和原始响应不进入公开 DTO 或安全日志。

## 五、未验证与停止边界

- 未读取或验证真实 API Key；
- 未确认任一真实 Model/Endpoint 当前支持哪些分辨率、比例、时长、帧数或音频能力；
- 未验证真实任务状态、失败正文、Usage、签名 URL、下载 MIME 或 24 小时失效行为；
- 未执行真实服务商数据面 HTTP、费用、余额或用量对账；
- 不支持多图、首尾帧、多模态参考、素材库 ID、音频、视频输入、联网搜索和 Draft；
- 真实能力开放必须另立专项批准，并先验证精确 Model/Endpoint Profile、费用、结果下载和安全失败事实。
