# 阶段 9 C2｜Vidu 官方 API 接入任务拆分

日期：2026-07-28

状态：流程 1—7 已合并 `develop`；流程 8 已完成 Windows 开发态真实最小闭环并在 `feature/vidu-live-validation` 收口

当前执行基线：`develop@bd86cbf`（已同步 `origin/develop`）

技术架构：

    docs/active/阶段9-C2-Vidu官方API接入技术架构.md

## 一、执行原则

- 八个流程拆为独立小 PR，原则上前一流程完成验收并合并最新 `develop` 后，才从该基线启动下一流程；
- 每个功能分支合并后保留本地与远程分支，不得删除；
- 每个流程开始前重新确认最新 `develop`、权威协议、允许修改范围和验收方式；
- 每个流程结束时更新实际修改、验证结果、未完成项和下一步，不得用计划代替真实测试；
- 流程 1—7 禁止真实 Token、真实 Vidu 联网和收费请求；
- 流程 8 必须在流程 1—7 全部完成后，由项目负责人再次明确批准联网范围和收费次数；
- 不直接在 `main` 或 `develop` 开发；项目负责人已明确授权流程 1—7 在各自门禁通过后连续非快进合并并顺序启动下一流程；
- 不恢复多图参考、图片批量创作、视频批量创作或对话页直接生成。

## 二、状态总表

| 流程 | 分支 | 状态 | 前置 |
| --- | --- | --- | --- |
| 1. 协议、模型记录与强类型路由 | `feature/vidu-protocol-contracts` | `merged_develop_c03693f` | C1 UI 已合并的 `develop@a6a04a5` |
| 2. 同步与异步执行生命周期 | `feature/vidu-execution-lifecycle` | `merged_develop_7015624` | 流程 1 合并 |
| 3. Vidu 共享安全运行时 | `feature/vidu-runtime` | `merged_develop_3a09d29` | 流程 2 合并 |
| 4. 两个同步图片适配器 | `feature/vidu-image-adapters` | `merged_develop_d629d9c` | 流程 3 合并 |
| 5. Q3 异步视频适配器 | `feature/vidu-video-adapter` | `merged_develop_f53b331` | 流程 4 合并 |
| 6. Electron、页面与 Work 流转接线 | `feature/vidu-app-wiring` | `merged_develop_90a2d58` | 流程 5 合并 |
| 7. 合成服务全链路验收 | `feature/vidu-e2e-validation` | `merged_develop_e4ba8c4_bd86cbf` | 流程 6 合并 |
| 8. 真实 Vidu 最小闭环 | `feature/vidu-live-validation` | `passed_awaiting_branch_integration` | 流程 1—7 合并且负责人再次批准 |

`feature/vidu-protocol-contracts` 已通过 `c03693f`、`feature/vidu-execution-lifecycle` 已通过 `7015624`、`feature/vidu-runtime` 已通过 `3a09d29`、`feature/vidu-image-adapters` 已通过 `d629d9c`、`feature/vidu-video-adapter` 已通过 `f53b331`、`feature/vidu-app-wiring` 已通过 `90a2d58` 非快进合并 `develop`。`feature/vidu-e2e-validation` 的实现与截断响应修复分别通过 `e4ba8c4` 和 `bd86cbf` 非快进合并 `develop`；`origin/develop` 已同步至 `bd86cbf`，各功能分支本地和远程均保留。流程 7 实现与验证事实见 `docs/active/阶段9-C2-流程7-Vidu合成服务全链路验收记录.md`。

## 三、流程 1｜协议、模型记录与强类型路由

分支：`feature/vidu-protocol-contracts`

允许范围：Provider 领域实体、ID、注册表 Schema 与迁移、能力证据、协议绑定、Router、对应测试和工程记录。不修改生成页面，不实现 HTTP。

实现内容：

- 增加 `ProviderProtocolBinding`、`mediaKind`、`protocolId`、`protocolVersion`、`executionLifecycle` 与 `providerPackageId`；
- 为现有 Provider/Model 注册表建立显式连续迁移，旧记录不得静默丢失；
- 将能力证据改为不可变版本历史，旧 Task 引用继续有效；
- 登记冻结模型记录，冲突能力保持 `declared/restricted/unknown`；
- 实现图片/视频强类型 Router；
- 类型或协议不匹配返回 `operation_model_mismatch`，HTTP 调用数为 0；
- 不增加第四种异步图片协议。

验收：迁移、历史 Evidence、模型绑定、正确路由、跨类型与 renderer 篡改测试通过；全量门禁通过；无网络请求。

## 四、流程 2｜同步与异步执行生命周期

分支：`feature/vidu-execution-lifecycle`

允许范围：Execution/Task 状态与迁移、图片/视频操作端口、提交控制器、仓储 Schema 与迁移、结果 receipt、轮询/取消/恢复抽象及测试。不实现 Vidu HTTP。

实现内容：

- 建立 `accepted_async`、`completed_sync`、`submission_outcome_unknown` 和提交前失败的判别联合；
- 支持同步图片结果 receipt 的持久化与重启读取；
- 支持 Q3 `task_id`、查询、取消与恢复端口；
- 请求可能已送达但响应未知时进入 `submission_outcome_unknown`；
- `submission_outcome_unknown` 自动重试次数为 0；
- 修复 Execution 完成与 Work 登记之间的幂等恢复边界。

验收：同步完成、异步接受、提交前失败、未知提交、仓储迁移、重启恢复与防重复收费测试通过；无网络请求。

## 五、流程 3｜Vidu 共享安全运行时

分支：`feature/vidu-runtime`

允许范围：Provider 平台层、凭证访问、受控 HTTP、Vidu 服务商包骨架、连接验证端口、代理/超时/取消/错误映射、合成测试和工程记录。不接页面和真实端点。

实现内容：

- 建立唯一 `ViduProviderPackage` 与 `ViduSharedRuntime`；
- 共享 `ProviderRegistry`、`CredentialVault`、受控 HTTP 和安全错误映射；
- Token 只在主进程凭证回调内使用；
- 实现 HTTPS、端点白名单、代理、超时、响应大小、重定向、取消与退出清理；
- 对 Authorization、路径、Hash、签名 URL 与响应正文执行日志脱敏；
- 实现 `GET /ent/v2/credits` 连接验证端口，但测试只连接本地合成服务；
- 禁止失败后静默切换模型、协议或端点。

验收：凭证不泄漏、端点限制、代理、超时、取消、重定向、大小限制、错误映射和日志脱敏测试通过；真实 Vidu HTTP 调用数为 0。

## 六、流程 4｜两个同步图片适配器

分支：`feature/vidu-image-adapters`

允许范围：Vidu 图片协议适配器、受控图片素材端口、同步结果 receipt、图片结果暂存/解码/接收、测试夹具和工程记录。不加入标准异步图片协议。

实现内容：

- 实现 `ViduImageV1Adapter`，仅覆盖批准的 generations 与 edits；
- 实现 `ViduGeminiImageV2Adapter`，仅覆盖批准的 reference2image model path；
- 分别解析 URL、`b64_json` 与 `fileData.fileUri`；
- 重新校验本地单图素材后才允许外发；
- 在适配器层强制单图、`n=1`、单输出；
- 对下载或解码结果执行大小限制、图片探测、SHA-256、原子落盘、FileReference、索引和 Work 登记；
- 结果或 Work 登记失败保留可幂等恢复事实。

验收：两协议成功与失败响应、缺字段、URL/base64/file URI、素材变化、超限/损坏结果、Work 恢复和类型错配测试通过；只连接合成服务。

## 七、流程 5｜Q3 异步视频适配器

分支：`feature/vidu-video-adapter`

允许范围：Vidu Q3 视频协议适配器、轮询协调器、取消与重启恢复、受控结果暂存桥、视频接收与测试。不修改页面。

实现内容：

- 实现 `ViduReferenceVideoV2Adapter` 的提交、任务查询和取消；
- 映射 `created/queueing/processing/success/failed`；
- 持久化 `task_id`，实现有界退避、429/5xx、取消和重启扫描；
- 处理结果 URL 到期，不把过期或下载失败标记为作品；
- 先下载到私有暂存区，再本地探测容器、MIME、字节、时长、宽高与 SHA-256；
- 只有 FileReference、索引和 Work 全部成功后才正式完成；
- 在适配器层强制单图输入和单输出。

验收：Q3 全状态、退避、限流、取消、空取消响应、重启恢复、URL 过期、恶意下载、损坏媒体与 Work 幂等恢复测试通过；只连接合成服务。

## 八、流程 6｜Electron、页面与 Work 流转接线

分支：`feature/vidu-app-wiring`

允许范围：Electron 组合根、provider/storage IPC 注入、preload DTO、现有图片/视频页面真实状态、图片 Work 到图生视频草稿受控端口及测试。不新增一级页面。

实现内容：

- 服务商验证、图片和视频控制器共享同一 Vidu 注册表、凭证库和运行时；
- 生图页面接入真实提交、同步结果接收和图片 Work；
- 图生视频页面接入真实提交、轮询、取消、恢复和视频 Work；
- 增加从已校验图片 Work 显式创建图生视频草稿的端口；
- 视频提交前重新确认服务商、连接、模型、最终提示词、外发图片、费用和数据离开本机；
- 不自动连续生成，不恢复批量，不把 ChatPage 改为生成入口。

验收：真实 preload 契约、主进程再校验、页面状态、取消/恢复、图片 Work 派生草稿、两次独立确认、Electron 可见烟测和完整门禁通过；仍不连接真实 Vidu。

流程 6 会触及 Electron 组合根和页面，开始前必须同步最新 `develop`，检查与阶段 9 A3 的并行修改；不得覆盖其他分支修改。

## 九、流程 7｜合成服务全链路验收

分支：`feature/vidu-e2e-validation`

允许范围：本地合成服务、协议夹具、端到端测试、故障矩阵、测试命令与脱敏工程记录。发现实现缺陷时在本分支做最小修复；若修复扩大范围，应拆新 PR。

验收场景：

- 正确/错误 Token；
- 三协议正确路由和跨类型零 HTTP；
- 同步 URL、base64、file URI 与异步 task；
- 提交断线、未知结果和零自动重试；
- Q3 轮询、429/5xx、取消、重启恢复和 URL 过期；
- HTTPS、重定向、大小上限、伪 MIME、截断、损坏媒体和磁盘不足；
- Work 登记失败与幂等恢复；
- 配置服务商 → 生图 → 图片 Work → 显式创建图生视频草稿 → 视频 → 视频 Work；
- Token、路径、Hash、签名 URL 和响应正文不进入 renderer、项目、日志或诊断包。

本流程必须执行完整自动化、TypeScript、ESLint、生产构建、平台审计、交接包校验、差异检查和 Windows Electron 烟测。本地合成服务通过不替代阶段 9 B4 的全产品故障与安全收口。

## 十、流程 8｜真实 Vidu 最小闭环

分支：`feature/vidu-live-validation`

前置：流程 1—7 全部验收、提交、推送并合并最新 `develop`；项目负责人再次明确批准真实联网范围、一次图片与一次视频的最大收费次数。

执行规则：

1. 用户只在应用凭证界面录入 Token，聊天、代码、环境文件和 Git 不接收 Token；
2. 先调用 `GET /ent/v2/credits` 验证鉴权、账户和网络，失败立即停止；
3. 使用已批准 Image2 模型执行一次最低已验证规格的单图、单输出请求；
4. 下载或解码、探测、SHA-256、原子落盘并登记图片 Work；
5. 用户显式从图片 Work 创建图生视频草稿，并再次确认外发范围和费用；
6. 使用已验证 Q3 模型执行一次最低已验证规格的单图、单视频请求；
7. 持久化任务并轮询，成功后在结果有效期内下载、探测、Hash、原子落盘并登记视频 Work；
8. 记录脱敏后的 Task、Execution、FileReference、Work、状态迁移和收费事实。

禁止：未知提交自动重试、临时切换第四协议、静默更换模型、自动连续生成、记录 Authorization 或签名结果 URL。

验收结论只能是“真实 Vidu API Windows 开发态最小闭环通过/失败”。失败必须保留事实并停止，不得为了获得成功结论扩大调用次数。

## 十一、并行关系与阶段收口

- 阶段 9 A3 若另行获批，可与流程 1—5 并行；流程 6 合并前必须同步最新 `develop` 并解决页面、Electron 组合根冲突；
- 阶段 9 B4 未自动启动。建议在流程 7 合成全链路完成后再启动或收口，使故障矩阵覆盖同步图片、未知提交、轮询、取消、恢复和结果下载；
- 流程 7 不等于 B4 完成，流程 6 不等于 A3/A4 完成；
- 流程 8 成功不关闭阶段 9，也不启动或关闭阶段 10；
- macOS 代码不得被写死为不支持，但真实 macOS Vidu 闭环必须等待相应设备、工具链和联网验收批准。

## 十二、每个流程的统一收口门禁

每个流程完成后必须：

1. 更新本文件状态、`PLANS.md` 和对应工程记录；
2. 执行范围相关测试及完整回归；
3. 执行 `npm.cmd run typecheck`、`npm.cmd run lint`、`npm.cmd run build`；
4. 执行平台审计、交接包校验和 `git diff --check`；
5. 涉及 Electron/preload/页面时执行可见 Electron 烟测和必要人工验收；
6. 记录失败、跳过、真实网络、真实收费和人工项，不得把 `not_run` 写为通过；
7. 提交并推送功能分支，等待项目负责人验收；
8. 未经批准不合并 `develop`，不删除功能分支，不自动开始下一流程。

## 十三、当前执行入口

流程 7 已完成实现、测试、工程记录与分支门禁，并通过 `e4ba8c4` 与 `bd86cbf` 两次非快进合并 `develop`。流程 8 已在 `feature/vidu-live-validation` 完成真实 credits 鉴权、唯一一次 `q3-lite` 参考生图及图片 Work、用户显式派生图生视频草稿、唯一一次 `viduq3-turbo` 图生视频及视频 Work，脱敏状态为 `passed`。图片和视频预算均为 `accepted_or_completed`，不得继续发起真实 Vidu 请求；Token、远端标识、下载 URL、绝对路径和 Hash 不进入工程记录或 Git。下一步只允许完成分支集成、无收费回归和工程收口。
