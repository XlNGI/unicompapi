# Seedance 请求体字段对齐验收记录

日期：2026-08-26

适用分支：`feature/model-adaptation-hardening`

## 范围

本次调整 UniCompAPI `POST /v1/videos` 的 Seedance 2.0 请求体序列化、精确模型参数 Schema 与视频 Profile 路由。未修改接口路径、响应解析、查询、取消或下载。

## 依据

- 项目冻结的官方合同证据：`docs/active/多服务商功能路由-M3-Seedance官方合同证据.md`；
- 火山方舟公开“创建视频生成任务”文档：<https://docs.volcengine.com/docs/82379/1520757?lang=zh>。

合同中列出的 Seedance 参数为 `resolution`、`ratio`、`duration`、`frames`、`seed`、`camera_fixed`、`watermark`、`generate_audio`、`return_last_frame`，均应作为请求体顶层字段出现。

## 实际修改

`newapi-video-adapter.ts` 对以下 UniCompAPI 模型启用 Seedance 顶层参数投影：

- `doubao-seedance-2-0-260128`；
- `doubao-seedance-2-0-fast-260128`。

兼容层既有 `model`、`prompt` 和受控单图 `image` 形态保持不变。Seedance 白名单参数不再写入 `metadata`；泛化的 `mode`、`audio`、`seconds`、`size`、`fps`、回调与服务等级字段不进入该模型请求体。

两个精确模型键分别绑定文生视频、图生视频 Schema。Schema 只公开已有证据的字段集合；`duration`/`frames` 最小值为 1，`seed` 最小值为 0。合同未证实 Fast 模型的必填项或枚举，因此没有猜测必填标识、默认值或下拉选项。已挂载旧通用视频 Schema 的精确 UniCompAPI Profile 会迁移到该 Schema；普通 OpenAI-compatible 中转站即使使用同名模型，也仍使用通用网关 Schema。Seedance 的 `duration` 与 `frames` 同时出现时在 HTTP 前拒绝。

## 验收

- `pnpm.cmd exec vitest run tests/platform/newapi-provider-package.test.ts tests/platform/openai-compatible-video-routing.test.ts tests/platform/unicompapi-model-capabilities.test.ts`：66/66 通过；
- `pnpm.cmd typecheck`：通过；
- `pnpm.cmd lint`：通过；
- `pnpm.cmd build`：通过；
- `pnpm.cmd test`：全量 Node/UI 与 Vitest 通过；
- `git diff --check`：通过。

新增文生视频、图生视频请求体断言，覆盖 Fast 模型的顶层参数、无 `metadata`、受控首帧保留、未知网关字段在 HTTP 前拒绝、`duration`/`frames` 互斥，以及精确/普通中转 Profile 的 Schema 边界。未读取凭证，未发送真实服务商 HTTP 请求，未产生收费调用。

## 未覆盖项

本次不声明 Fast 模型的具体必填项、取值范围或实时可用性；这些需要 UniCompAPI 对该精确模型的公开合同或经批准的非收费验证后再单独更新。
