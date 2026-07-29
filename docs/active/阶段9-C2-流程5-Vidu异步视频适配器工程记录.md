# 阶段 9 C2 流程 5｜Vidu 异步视频适配器工程记录

日期：2026-07-29

状态：实现和分支门禁已完成，等待连续授权下提交、推送与非快进合并 `develop`

分支：`feature/vidu-video-adapter`

基线：`develop@d629d9cea6e023865c763ce45308de7c82e0fac2`

## 一、允许范围

本流程只实现 Vidu Q3 参考生视频协议适配器、异步查询/取消、有界轮询、重启结果重发现、受控视频结果下载以及现有视频 Work 接收兼容。未修改 Electron、preload 或 React 页面，未实现第四种异步图片协议，未读取真实 Token，未访问真实 Vidu。

## 二、官方契约核对

1. 提交使用 `POST https://api.vidu.cn/ent/v2/reference2video` 与 `Authorization: Token {api_key}`，成功响应包含异步 `task_id`。
2. 查询使用 `GET /ent/v2/tasks/{id}/creations`，状态限定为 `created/queueing/processing/success/failed`；成功结果从 `creations[].id/url` 发现，结果 URL 按官方说明仅保留 24 小时。
3. 取消使用 `POST /ent/v2/tasks/{id}/cancel`，成功响应为空对象；非空、限流、服务异常或传输不确定均不得伪造取消成功。
4. Q3 请求提示词上限为 5000 字符，图片可用 Data URL，请求体不超过 20MB；`audio` 必须显式发送，`movement_amplitude` 与 `bgm` 不属于 Q3 有效参数。
5. 时长冲突采用负责人批准的保守交集：drama 2—15 秒，ad/mix/turbo 3—15 秒，基础 q3 3—16 秒。产品有效限制继续为单图、单输出。

## 三、实际修改

1. 在唯一 `ViduProviderPackage` 中增加一个 `ViduReferenceVideoV2Adapter` 工厂，没有按模型拆分适配器，也未把图片和视频协议合成巨型适配器。
2. 适配器复核 Task、Execution、Model、Evidence、ProtocolBinding、provider/connection、媒体类型和 `reference_to_video` purpose；单图、模型白名单、参数、提示词和 20MB 门禁失败时 HTTP 调用为 0。
3. 提交显式发送 `audio`，只允许 `duration/resolution/aspect_ratio` 可选参数；成功严格解析 `task_id`。请求可能已送达而结果未知时返回 `submission_outcome_unknown`，不制造失败前事实或自动重试。
4. 查询和取消路径加入共享运行时协议白名单；查询严格映射官方五状态，成功只保存主进程私有结果 URL。取消只在空对象响应时确认成功，重试性故障保持取消结果未知。
5. 新增有界指数退避与抖动轮询器，支持 AbortSignal，重试性 429/5xx/网络故障不会无限轮询，非重试错误立即停止。
6. 重启后可凭已持久化的 provider operation ID 重新查询并发现结果，不依赖 renderer 或内存中的远端 URL。相同 URL 保留首次发现时间并执行 24 小时到期门禁。
7. 视频结果端口允许供应商只提供结果 ID/名称；共享下载强制 HTTPS、手工重定向拒绝、512MB 上限和 `video/*`。现有接收器只在本地探测 MIME/容器/字节/时长/尺寸、计算 SHA-256、原子发布并完成 FileReference、索引、Work 后收口 Execution；供应商若声明元数据，仍逐项严格比对。

## 四、自动化验证

- `npm test`：Node 157 项、Vitest 367 项，合计 524 项通过，0 失败、0 跳过；
- `npm run typecheck`：通过；
- `npm run lint`：通过；
- `npm run build`：通过；
- `npm run audit:platform`：扫描 211 个文件，0 违规；
- `npm run verify:handoff`：50 个 checksum 条目、27 个资产，0 失败；
- `git diff --check`：通过。

新增测试覆盖 Q3 请求字段、显式 audio、五模型边界、非法参数和超限请求零 HTTP、未知提交、五状态、空取消响应、轮询退避、重启重发现、URL 到期、非 HTTPS、伪 MIME，以及远端无元数据时依靠本地探测登记 Work。所有 HTTP 都由内存合成 transport 提供，真实 Vidu HTTP、真实 Token 和收费请求均为 0。本流程未修改 Electron/preload 或页面，因此无需 Electron 烟测。

## 五、未完成项与风险

- 实际 Electron transport、DNS 解析后私网复核、组合根、IPC/preload 与页面状态属于流程 6；
- 完整合成服务、断线/磁盘不足/重启/故障矩阵与全业务闭环属于流程 7；
- 真实模型可用性、实际结果 URL 行为、费用、地区和生产参数仍未验证，冻结模型保持 disabled，Evidence 保持 `declared_supported`；
- Image V1 鉴权和 `images` 结构未决问题不因本流程改变；
- 流程 8 的真实联网与收费仍未获批准。

## 六、下一步

完成生产构建、平台审计、交接校验和差异检查后，提交并推送本功能分支，按连续授权非快进合并并复验最新 `develop`。只有流程 5 合并后才能创建 `feature/vidu-app-wiring`；不得提前启动流程 7、流程 8、阶段 9 A3、B4 或 A4。
