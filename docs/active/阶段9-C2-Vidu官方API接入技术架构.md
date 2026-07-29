# 阶段 9 C2｜Vidu 官方 API 接入技术架构

日期：2026-07-28

状态：流程 1—4 已合并，流程 5 已完成分支实现；流程 6—7 与真实联网、收费验证尚未完成

原阶段 9 规划基线：`252f5db Merge phase 8 integration closeout`

当前执行基线：`develop@d629d9c`

## 一、架构结论

Vidu 接入采用“一个服务商包、三个协议适配器、多个模型记录”的结构：

```text
ViduProviderPackage
├─ ViduSharedRuntime
├─ ViduImageV1Adapter
├─ ViduGeminiImageV2Adapter
└─ ViduReferenceVideoV2Adapter
```

每个模型通过不可变协议绑定记录连接到对应适配器，不得为每个模型创建一个适配器，也不得把视频和两种图片协议合并为巨型 `ViduAdapter`。当前冻结规划中的模型记录属于数据与能力证据，不得把价格、时长、分辨率、数量或未验证能力写死在页面和控制器中。

图片与视频必须使用强类型 Router。模型媒体类型、业务操作或协议不匹配时，主进程在任何 HTTP 调用前返回 `operation_model_mismatch`，HTTP 调用数必须为 0；renderer 请求被篡改时也必须执行同样的主进程校验。

## 二、阶段关系与范围例外

原阶段 9 原则仍是跨平台与完整验收，不新增业务一级页面。本 C2 专项由项目负责人最新决策形成明确业务范围例外，只允许在现有服务商、图片和视频页面及既有 Task、Execution、FileReference、Work 流程内接入 Vidu，不新增一级页面。

本专项可以形成 Windows 开发态的最小真实闭环，但不改变以下事实：

- 阶段 9 A3、B4、A4 尚未完成；
- macOS 实机与现有 Windows 人工阻断项仍为 `not_run/deferred`；
- Vidu Windows 开发态闭环成功不等于阶段 9 跨平台验收完成；
- 安装包、签名、公证、生产更新、生产媒体组件分发、SBOM、发布回滚和正式发布准入仍属于阶段 10；
- Vidu 不提供 LLM，对话回复仍需后续独立 LLM 适配器；ChatPage 不得成为直接生成入口。

## 三、权威协议范围

当前只批准以下三个协议适配器：

| 适配器 | 接口范围 | 生命周期 | 结果形式 |
| --- | --- | --- | --- |
| `ViduImageV1Adapter` | `POST /ent/v1/images/generations`、`POST /ent/v1/images/edits` | 同步 | URL 或 `b64_json`，`task_id` 只作关联事实 |
| `ViduGeminiImageV2Adapter` | `POST /ent/v2/image/reference2image/{model}` | 同步 | `fileData.fileUri` |
| `ViduReferenceVideoV2Adapter` | `POST /ent/v2/reference2video`、任务查询与取消 | 异步 | `task_id`、任务状态与限时结果 URL |

协议依据：

- [Vidu Reference to Video](https://platform.vidu.com/docs/reference-to-video)
- [Vidu Get Creation](https://platform.vidu.com/docs/get-generation)
- [Vidu Cancel Generation](https://platform.vidu.com/docs/cancel-generation)
- [Image2 图片协议](https://shengshu.feishu.cn/wiki/StH7wvmtqibhOCkM2eVcAZ8qnqd)
- [Gemini 图片协议](https://shengshu.feishu.cn/wiki/ScErwbsZQikKm8k8v64ccP5rnvm)

`POST /ent/v2/reference2image` 标准异步图片接口属于第四种协议，不在当前冻结范围。不得将其塞入以上三个适配器；后续若支持，必须由项目负责人单独批准第四适配器、独立协议绑定和独立 PR。

官方资料、平台模型目录或历史资料出现冲突时，冲突能力只能保持 `declared`、`restricted` 或 `unknown`，不得推断为已验证能力。Image2 鉴权、请求图片字段及模型限制存在的文档歧义必须先由本地合成服务覆盖，再在流程 8 进行最小无收费或收费验证后冻结。

## 四、模型与能力证据

`ProviderModel` 必须增加或关联以下不可变事实：

```text
mediaKind
protocolId
protocolVersion
executionLifecycle
providerPackageId
```

模型注册表升级必须具有显式连续 Schema 迁移，旧记录不得静默丢失。当前规划中的多个模型记录必须逐项绑定图片或视频协议；模型 ID 与能力只来自批准资料或真实验证。

`ModelCapabilityEvidence` 必须形成不可变版本历史。新验证追加新 Evidence，不删除旧 Task、Execution 或确认快照引用的 Evidence ID。提交前继续使用冻结的模型、连接、能力证据、参数与用户确认，不因目录同步静默改写历史任务。

## 五、同步图片与异步视频生命周期

提交结果使用判别联合，至少区分：

```text
accepted_async
completed_sync
submission_outcome_unknown
failed_before_submission
```

Image2 与 Gemini 同步返回的 URL、base64 或文件 URI 必须先持久化为 immediate result receipt，随后才能进入结果接收。不得将同步完成伪装为 `queued/processing`，也不得依赖无法查询的虚假远端任务恢复结果。

Q3 视频必须持久化 `task_id`，支持 `created`、`queueing`、`processing`、`success`、`failed` 状态映射，并建立退避轮询、429/5xx 处理、取消、应用重启恢复和结果 URL 到期处理。

若请求可能已到达 Vidu、但客户端未获得确定响应，Execution 必须进入 `submission_outcome_unknown`。此状态自动重试次数固定为 0，用户不得通过普通“重试”直接重复产生收费任务；只能依据后续批准的人工核对或服务商可恢复事实处理。

## 六、素材外发与本地结果事实

图片和视频提交不得直接使用 renderer 路径或未经复核的 Asset ID。主进程必须通过受控素材端口重新解析 FileReference，校验项目范围、文件存在性、媒体类型、大小和 Hash，再按协议允许的 URL、base64 或上传引用外发。

产品继续只允许单图、单输出。该约束必须在 UI、预检、Router 和协议适配器四层重复执行，不能因为 Vidu 官方接口支持多图或多输出而恢复多图参考、图片批量创作或视频批量创作。

Vidu 结果 URL 不提供现有作品端口要求的全部 MIME、容器、字节、SHA-256、时长和宽高事实时，不得伪造远端声明。应先由主进程受控下载到项目私有暂存区，执行 HTTPS、重定向、响应大小、常规文件、可信媒体探测和 SHA-256 校验，再原子发布到正式位置。

只有原子落盘、FileReference、索引与 Work 全部成功后，Execution 才能进入可向用户展示的正式完成态。Work 登记失败必须保留可幂等恢复事实，不能出现 Execution 已完成但作品无法恢复的终态断裂。

## 七、共享运行时与安全边界

服务商验证、图片生成与视频生成必须共享同一个 `ProviderRegistry`、`CredentialVault`、Vidu HTTP 运行时和 Electron 组合根，不得由不同 IPC 各自创建互不一致的服务商事实源。

Token 只能由主进程在安全凭证回调内短时使用，不得进入 renderer、代码、环境文件、项目、Task、Execution、日志、诊断包或 Git。HTTP 运行时统一执行：

- `Authorization` 脱敏；
- 仅批准的 HTTPS Base URL 与端点；
- 代理与超时；
- 有界请求与响应；
- 重定向限制；
- 429、4xx、5xx 与协议错误映射；
- 取消与应用退出清理；
- 禁止失败后静默切换模型、端点或协议。

`GET /ent/v2/credits` 只作为流程 8 的首次真实鉴权检查。本地开发与流程 1—7 只能使用合成服务，不得访问真实 Vidu。

## 八、页面与产品交互

流程 6 只在底层契约、共享运行时和三个适配器合并后进行页面接线：

- 生图页面显示真实预检、提交、同步结果接收和 Work 状态；
- 图生视频页面显示真实提交、轮询、取消、恢复和结果接收状态；
- 图片 Work 进入图生视频必须由用户显式创建新草稿；
- 创建视频草稿后重新确认服务商、连接、模型、最终提示词、外发图片、费用状态和数据离开本机；
- 不自动连续执行生图与生视频；
- 不把查询候选、保存对话或登记上下文解释为外发授权。

## 九、测试与收费门禁

流程 1—7 禁止真实 Token、真实联网和收费请求，只允许本地合成服务器。合成服务必须覆盖：

- 正确与错误鉴权；
- 三协议正确路由及跨类型零 HTTP；
- URL、base64、file URI 与缺失字段；
- 提交断线与 `submission_outcome_unknown`；
- Q3 全状态、退避、429/5xx、取消与重启恢复；
- 结果 URL 过期、恶意重定向、伪 MIME、截断、超限、损坏媒体和磁盘不足；
- FileReference、索引、Work 登记失败及幂等恢复；
- Token、路径、Hash、签名 URL 和响应正文脱敏。

流程 8 只有在流程 1—7 全部验收并合并后，才能由项目负责人再次批准真实联网范围和收费次数。Token 必须由用户在应用凭证界面录入。首次真实验证只允许一次最小图片与一次最小视频请求，并在两次请求前分别确认；任何鉴权、模型、协议或费用事实不明确时立即停止。

流程 8 成功只能记录为“Vidu 官方 API Windows 开发态最小闭环通过”，不得记录为阶段 9 完成、跨平台完成、发布就绪或阶段 10 完成。

## 十、实施文档与当前状态

八个小 PR 的顺序、分支、文件范围和验收门禁见：

    docs/active/阶段9-C2-Vidu官方API接入任务拆分.md

流程 1 已通过 `c03693f`、流程 2 已通过 `7015624`、流程 3 已通过 `3a09d29`、流程 4 已通过 `d629d9c` 非快进合并 `develop`。流程 5 已在 `feature/vidu-video-adapter` 完成分支实现与门禁，新增 Q3 参考视频协议适配器、官方异步状态映射、有界退避轮询、取消、重启结果重发现、URL 到期处理，以及由本地探测和 SHA-256 形成可信事实的视频 Work 接收兼容。Image V1 的鉴权和 `images` 结构仍保持未验证并在生产绑定层阻断。实现与验证事实见对应流程工程记录。流程 1—7 的连续实施授权不包含真实 Token、真实 Vidu 联网或收费调用。
