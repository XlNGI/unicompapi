# UniCompAPI Vidu 官方参数映射补齐记录

日期：2026-08-27

当前阶段：阶段 9 正式收口后的缺陷修复；阶段 10 未启动。

## 问题与结论

UniCompAPI 目录此前虽然声明了 Vidu 视频能力，但实际仍绑定通用 NewAPI 视频参数 Schema，`NewApiVideoAdapter` 也会把 `aspect_ratio`、`audio`、`seed` 等字段聚合到 `metadata`，没有像精确 Seedance 映射一样复用官方模型合同。这导致参数 UI、提交前校验和请求投影均无法表达 Vidu 官方字段语义。

现按 `docs/active/模型官方参数合同与中转映射实施方案.md` 的精确映射边界补齐：

- `viduq3-turbo`：保留 `text_to_video`、`image_to_video`；
- `viduq3-pro`：保留 `text_to_video`；
- `viduq3`、`viduq3-mix`：当前实例已有 `unsupported_model` 证据，保留为封闭世界中的已知模型键，但能力数组为空，不产生可提交候选；
- 普通 NewAPI 或其他 OpenAI-compatible 包中的同名模型不继承此映射，继续使用通用网关合同。

## 实际修改

1. 从 `createViduModelContract()` 取得官方 revision 2 参数 Schema，克隆字段并赋予三个 UniCompAPI 专用 Schema ID，避免把官方 Vidu 的结果、用量和约束合同错误绑定到 NewAPI 路由。
2. 将三个映射 Schema 注册到视频共享合同集合，结果与用量继续使用 NewAPI 视频合同，文生/图生分别使用对应 NewAPI 约束合同。
3. 复用既有 generic → precise Profile 迁移逻辑，使已有 `viduq3-turbo` / `viduq3-pro` 通用 Profile 在目录路由时自动迁移到精确 Schema。
4. 为精确 Vidu 映射增加 UniCompAPI 请求投影：仍提交到 `POST /v1/videos`，顶层发送 `model`、`prompt`、`audio`、`duration`、`resolution`、`aspect_ratio`、`seed`；图生视频继续发送单张顶层 `image` data-URL。没有切换到仅在 Vidu 官方端点使用、但未在该网关验证的 `images[]`。
5. `audio` 未显式设置时发送 `true`，与官方 q3 适配器默认一致；适配器在 HTTP 前防御性拒绝非官方字段、非法时长、分辨率、比例和 seed。

## 验证结果

- 定向 Vitest：5 个文件，93/93 通过；覆盖能力边界、官方字段克隆、跨包合同注册、旧 Profile 迁移、同名普通 NewAPI 隔离、Vidu 文生/图生请求快照及非法值 HTTP 前拒绝。
- 全量测试：Node 323/323、Vitest 873/873 通过，0 失败、0 跳过。
- TypeScript 应用与测试类型检查通过。
- 涉及文件的定向 ESLint 通过。
- `git diff --check` 通过；仅有工作区既存的 Windows LF/CRLF 提示。
- 未发起任何真实 UniCompAPI/Vidu 请求，未读取或输出凭证，未产生费用。

## 未完成项与边界

- 本次不重新验证真实服务商。官方 Vidu `q3-lite` 图片和 `viduq3-turbo` 视频预算均已用尽，禁止继续调用。
- `viduq3-turbo` 近期任务异步失败的上游具体原因仍缺少安全失败码透出；失败详情解析可作为独立后续修复，不影响本次参数合同映射结论。
- `viduq3`、`viduq3-mix` 只有在取得更高优先级的实例支持证据并完成单独验收后，才能恢复能力。
- 阶段 10、macOS 实机与发布准入均未启动。

## 映射后失败复核

负责人在精确映射生效后再次提交 `viduq3-turbo` 图生视频。本次只读取既有本地脱敏日志和不可变工程实体，没有发起新的网络请求：

- 路由快照为 `image_to_video`，参数 Schema 为 `parameters.unicompapi.viduq3_turbo.image_to_video.official_mapping` revision 2，证明不是旧 Profile 或通用 Schema 残留；
- `POST /v1/videos` 返回 HTTP 200 并形成远端 operation，后续任务查询持续返回 HTTP 200；
- 远端任务约 18 秒后明确进入 `failed`，客户端执行与任务均按不可重试失败落盘；
- 同一模型在本次映射之前已有三次图生视频请求呈现相同的“创建成功后异步失败”，且另有文生视频异步失败，因此没有证据支持继续调整媒体字段或官方参数投影；
- 客户端旧实现只保留了泛化文案 `NewApi reported that the video task failed`，没有保存远端失败对象，故无法从历史本地数据恢复此次具体上游码。

本次随后补齐了异步失败终态的安全解析。若响应包含余额/额度、模型不可用、内容安全或图片不可用信号，任务失败原因使用固定脱敏文案；其他原因仅保留格式和长度受限的机器码。上游原始错误正文不会进入执行记录，避免 Prompt、媒体或供应商内部信息泄露。

复核后的门禁为：Node 323/323、Vitest 875/875、TypeScript、涉及文件 ESLint 和 `git diff --check` 全部通过。当前结论是 UniCompAPI 已接受创建请求，但其 Vidu turbo 上游任务失败；使模型恢复生成需要 UniCompAPI 根据已有任务/request ID 核对上游失败原因或通道状态，不能由客户端继续猜测请求字段完成。

## 下一步建议

由 UniCompAPI 后台根据现有任务/request ID 核对 Vidu turbo 上游失败码、额度和通道状态；在拿到可复核的失败原因或网关合同前，不再发起收费测试，也不继续切换 `image`/`images[]`/`content[]` 猜测。
