# 阶段 9 C2 流程 4｜Vidu 同步图片适配器工程记录

日期：2026-07-29

状态：已通过 `d629d9c` 非快进合并并推送 `develop`

分支：`feature/vidu-image-adapters`

基线：`develop@3a09d292c45b333475de36bbc0f15dad1a31710e`

## 一、允许范围

本流程只实现 `ViduImageV1Adapter`、`ViduGeminiImageV2Adapter`、受控单图素材复核、同步结果 receipt 的解码/下载以及现有图片结果接收和 Work 登记兼容。未修改 Electron、preload 或 React 页面，未实现 Q3 视频或第四种异步图片协议，未访问真实 Vidu。

## 二、官方契约核对

1. Image V1 官方页面确认 `/ent/v1/images/generations`、`/ent/v1/images/edits` 为同步接口，响应可提供 URL 或 `b64_json`；请求表格写 `images: array<String>`，调用示例却写 `[{image_url}]`，两者冲突。
2. Image V1 调用示例只写 `Authorization: xxx`，未给出可验证的鉴权 scheme。因此冻结协议绑定继续保持 `authScheme=unknown`；适配器在鉴权未验证时于 transport 前返回失败。合成测试通过显式测试画像覆盖请求序列化，不代表生产鉴权已确认。
3. Gemini V2 官方页面明确 `/ent/v2/image/reference2image/{model}`、`Authorization: Token {API_KEY}`、`content/part/inlineData` 请求和 `candidates[].content.parts[].fileData.fileUri` 响应。本流程未发送 `tools`，`q3-fast.imageSearch` 继续保持 restricted。

## 三、实际修改

1. 在唯一 `ViduProviderPackage` 下提供两个协议族适配器工厂；没有按模型创建适配器，也未合并成巨型 ViduAdapter。
2. 两个适配器都验证 Task、Execution、Model、Evidence、ProtocolBinding、mediaKind 和生命周期，强制单图、单输出；Image V1 固定 `n=1`，Gemini 固定 `responseModalities=[IMAGE]`。
3. POST Body 在 JSON 序列化及 Base64 展开后检查不超过 20MB；不接受 renderer 路径、endpoint、Token、远端 operation ID 或任意 URL 参数。
4. 新增项目范围素材解析器，只按受控 AssetId 解析当前项目 FileReference，重新检查文件状态、MIME、尺寸、字节与 SHA-256 后在主进程内部生成 Base64；素材变化、跨项目、损坏或超限均在 HTTP 前阻断。
5. Image V1 严格解析单个 URL 或 `b64_json`；Gemini V2 严格解析单个 `fileData.fileUri`。同步调用产生本地 `providerOperationId` 并持久化私有 receipt，不把同步接口伪装为 queued/processing，也不把响应中的 task_id 当作远端异步任务。
6. 共享运行时新增无凭证的受控结果下载：只允许 HTTPS、拒绝本机/IP 字面量和重定向、限制响应大小、沿用代理/超时/取消与脱敏日志。URL、file URI 和 Base64 最终都进入现有图片探测、SHA-256、同目录原子发布、FileReference、索引和 Work 登记链路。
7. 图片结果接收器兼容 `completed_sync` receipt，并把 Work 写入放在 Execution 最终完成之前；已验证文件或已登记 Work 可在重启/失败后幂等恢复，不重复下载或重复登记。

## 四、自动化验证

- `npm test`：Node 157 项、Vitest 359 项，合计 516 项通过，0 失败、0 跳过；
- `npm run typecheck`：通过；
- `npm run lint`：通过；
- `npm run build`：通过；
- `npm run audit:platform`：扫描 210 个文件，0 违规；
- `npm run verify:handoff`：50 个 checksum 条目、27 个资产，0 失败；
- `git diff --check`：通过。

新增定向测试覆盖两协议请求/响应、URL/base64/file URI、未知鉴权阻断、单图/单输出、20MB 上限、素材变化、跨项目拒绝、超限/损坏结果、HTTPS/重定向边界、同步 receipt 恢复、Work 幂等登记和未知提交零自动重试。所有 HTTP 均为内存合成 transport；真实 Vidu HTTP、真实 Token 和收费请求均为 0。未修改 Electron/preload 或页面，因此无需 Electron 烟测。

## 五、未完成项与风险

- Image V1 的准确 Authorization 格式与 `images` 最终结构仍未确认；生产绑定保持 unknown，不能启用真实调用；
- Gemini 的 file URI 有效期、下载域名、完整 MIME/数量/请求上限、错误和幂等事实仍未由真实验证确认；
- 冻结模型仍 disabled，Evidence 仍为 `declared_supported`，本流程不构成模型启用或收费授权；
- DNS 解析后的私网地址复核属于流程 6 实际 Electron transport 的实现责任，本流程仅验证 URL 结构、HTTPS 和 IP 字面量；
- Q3 视频、Electron 组合根、页面接线、完整合成服务和真实最小闭环分别属于流程 5—8。

## 六、下一步

提交并推送本功能分支，非快进合并并复验最新 `develop`。只有合并后才能创建 `feature/vidu-video-adapter` 实现 Q3 异步视频协议；仍不得启动 Electron/页面接线、真实联网或收费验证。
