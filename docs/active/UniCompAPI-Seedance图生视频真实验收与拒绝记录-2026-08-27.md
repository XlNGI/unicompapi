# UniCompAPI Seedance 图生视频真实验收与拒绝记录

日期：2026-08-27

适用阶段：阶段 9 收口边界内的独立工程修复；阶段 10 未启动。

适用分支：`feature/fix-unicompapi-seedance-i2v-request`

## 一、验收范围与资料

本次只验收 UniCompAPI 精确 Seedance 2.0 图生视频路由，不扩大到其他服务商、其他模型或 macOS。实现依据为：

- `AGENTS.md` 阶段 9 与真实收费调用停止规则；
- `docs/active/多服务商功能路由-M3-NewAPI官方合同证据.md`；
- `docs/active/多服务商功能路由-M3-Seedance官方合同证据.md`；
- `docs/active/Seedance请求体字段对齐-验收记录.md`；
- `docs/active/Seedance视频候选合同修复记录.md`。

执行前确认了当前阶段、允许修改范围（NewAPI 请求映射、提交状态、诊断日志、对应测试与工程记录）和验收方式（重启 Electron，通过现有草稿的受控 IPC 准备；结果按成功、明确拒绝或未知分类）。未读取、输出或提交任何凭证内容。

## 二、实现内容

- UniCompAPI 精确 `doubao-seedance-2-0-260128` 与 `doubao-seedance-2-0-fast-260128` 的图生视频请求现对齐官网 Seedance 页面使用 `model`、`metadata`、`content[]` 结构；受控本地图片暂以 data-URL 放入 `content[].image_url.url`，官网生产路径使用 MinIO 公网 URL。
- 普通 NewAPI 模型仍使用既有 `prompt`/`image` 兼容结构，不因同名模型误套 Seedance 专用映射。
- 请求已开始后，HTTP 400/401/402/403/404/409/413/422/429 等明确拒绝会记录为 `failed`；超时、断网、代理失败、响应损坏或无法确认的传输结果继续记录为 `unknown_outcome`，均禁止自动重试。
- NewAPI 运行时仅记录安全的操作名、方法、HTTP 状态、序列化请求字节数、白名单上游 `code/type`、受控 request ID 和耗时；不记录 Token、URL、Prompt、图片 Base64 或原始错误正文。
- 图片、视频运行时和调用读模型新增明确拒绝的失败反馈及执行状态落盘。

## 三、两次真实提交验收记录

验收前已重启旧 Electron 主进程并加载最新构建，打开已有项目和保存完成的单图草稿。候选、参数 Schema、受控 PNG 素材和外发确认均通过本地门禁；费用状态保持 `unknown`。

本地持久化事实显示实际有两次 `POST /v1/videos` 提交尝试；两次使用同一固定 UniCompAPI 连接、同一精确 Seedance 图生视频路由和同一模型，均在收到 HTTP 400 后结束。关键本地事实如下：

这两次尝试发生在切换到官网的 `metadata`/`content[]` 结构之前，不能作为当前结构已被业务网关验证的证据。

| 项目 | 结果 |
| --- | --- |
| 第一次 Task / Invocation | `task-video-d5bce72a-920c-400e-b07f-662dce851ed8` / `attempt-7bce577d-7efe-4d0b-9827-2b1761c2aeeb` |
| 第二次 Task / Invocation | `task-video-8aae986e-e491-403b-a64d-dba11f2f7c0a` / `attempt-a5833996-a7c1-40ce-889b-8b915dccaa59` |
| 模型 | `doubao-seedance-2-0-260128` |
| HTTP 结果 | `400` |
| 安全上游码 | `invalid_tokenpony_request` |
| 本地安全码 | `newapi.invalid_request` |
| 提交状态 | `failed`，`retryAllowed=false` |
| 执行状态 | `failed`，阶段 `submitting`，不可重试 |
| 远端 operation ID | 无 |
| 轮询/下载 | 未发生 |
| Usage / 正式 Work | 均未产生 |

本地 `network.log` 新增两组脱敏记录：每组均为 `video_submit` 的 `request_started`，随后 HTTP 400 的 `request_failed`，含安全上游码和耗时，不含敏感正文。两组调用事件、提交意图和执行均已落盘为 `failed`，没有远端 operation ID；旧的未知结果任务未被重试。

对照事实：同一固定连接、同一 Seedance 模型的文生视频路由在
`2026-08-27T02:15:16Z` 曾被本地记录为 `accepted_async` 并获得远端任务 ID。
因此不能把当前问题概括为 UniCompAPI 地址或凭证全局不可用；失败范围至少收敛到
图生视频路由的请求信封、前置校验、模型通道或其记录链路。该对照不代表图生视频已获支持。

## 四、结论与阻断项

本次修复已证明：应用能从当前草稿走完受控准备、鉴权声明、请求开始和明确拒绝落盘；客户端对固定地址发起了两次 HTTP 请求，并均收到前置层返回的机器可识别拒绝。负责人反馈 UniCompAPI 后台没有相应调用记录，因此当前不能证明任一次请求已进入 UniCompAPI 业务网关、TokenPony 适配器或模型通道；`invalid_tokenpony_request` 更可能来自边缘/前置校验层，也不能排除实例路由或记录链路差异。结果不是网络或超时未知，因此按规则停止，没有轮询、下载或重复收费请求。

`invalid_tokenpony_request` 仍不足以判断是前置层不接受当前请求信封、请求被转发到错误实例/路径、TokenPony 字段不匹配，还是后台只记录已创建的异步任务。当前没有足够的 UniCompAPI 实例级视频合同和请求记录链路证据，不能继续猜测请求字段或再次发送收费生成。

## 五、后续建议

1. 由 UniCompAPI 维护方确认固定地址对应的前置层、业务网关和后台记录链路，并提供该实例对 `doubao-seedance-2-0-260128` 图生视频的精确请求/响应合同及 `invalid_tokenpony_request` 的字段级原因。
2. 在取得合同、确认记录链路并得到新的明确批准后，先补充脱敏 fixture、请求体回归和错误码映射，再安排一次新的、独立编号的真实验收。
3. 在此之前保留当前 `failed` 事实，不把任务标记为成功，不自动重试，不切换服务商或模型。
