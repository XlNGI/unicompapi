# Vidu 官网能力对齐分阶段实施计划

日期：2026-08-06

状态：方案待项目负责人批准；批准前不改生产路径代码、不发起真实 Vidu 计费调用

权威来源（冲突时按此顺序）：

1. 项目负责人最新明确决策；
2. 本计划与 `AGENTS.md` / `PLANS.md`；
3. Vidu 官方 API 文档（[llms.txt](https://platform.vidu.cn/docs/llms.txt)）；
4. 现有工程实现与阶段 9 联调记录。

官方文档入口（本计划依据 2026-08-06 抓取）：

| 能力 | 文档 |
| --- | --- |
| 模型地图 | https://platform.vidu.cn/docs/model-map |
| 图片生成 | https://platform.vidu.cn/docs/reference-to-image |
| 文生视频 | https://platform.vidu.cn/docs/text-to-video |
| 图生视频 | https://platform.vidu.cn/docs/image-to-video |
| 参考生视频 | https://platform.vidu.cn/docs/reference-to-video |
| 任务查询 | https://platform.vidu.cn/docs/search-task-api |

相关约束：

- 不写死服务商、价格；模型 key / 时长 / 分辨率 / 数量以官网合同字段声明，由打包目录安装，禁止在 UI 写死；
- Token 不得进入聊天、代码、环境文件、日志或 Git；
- `q3-lite` 图片与 `viduq3-turbo` 视频真实预算已用尽，实施期只用合成服务与合同测试，不得继续真实计费调用；
- Image V1（`viduimage-2`）鉴权与 `images` 结构仍保持未验证，本计划不以 Image V1 作为官网生图主路径；
- 阶段 10（安装包/签名/发布）与本计划无关，不启动。

---

## 一、计划结论

当前工程里 Vidu **不是按官网完整能力矩阵接线**，而是阶段 9 C2 最小闭环留下的窄切片：

| 产品面 | 现状 | 官网 |
| --- | --- | --- |
| 文生图 | 仅 `viduq2`（及未验证 Image V1） | 仅 `viduq2` 明确支持；`viduq1` 仅参考生图 |
| 参考/图生图 | 多数 Gemini key 仅 `reference_to_image` | `viduq2` 0–7 张；`viduq1` 1–7 张 |
| 文生视频 | **无候选**（合同过滤掉 `text_to_video`） | `POST /ent/v2/text2video` |
| 图生视频 | 产品页有，但实现打到 `reference2video` | `POST /ent/v2/img2video`（首帧 1 张） |
| 参考生视频 | `POST /ent/v2/reference2video`（1 张图简化） | 同端点，1–7 张 / 主体模式 |

本计划目标：

1. **生图**：以官网 `reference2image` 为准，把打包生图模型能力对齐到「文生图 + 图生图（参考生图）」；参数、图片数量、分辨率/比例按模型差异声明；
2. **生视频**：严格按官网拆成三条协议——文生 / 图生 / 参考生——并分别接到 UniComp 产品功能 `text_to_video` / `image_to_video`（及内部 purpose）；
3. **候选可见**：文生视频页能列出官网支持文生视频的模型；图生视频页列出官网支持图生视频的模型；参考能力不混用端点；
4. **旧连接可升级**：打包目录扩展后，已有 Vidu 连接通过 `ensurePackagedCatalogs` / 同步目录 / 验证连接刷新模型与 profile，无需用户删连重建。

不以单一大 PR 收口；按「合同 → 适配器 → 候选接线 → UI 验收」拆支。

---

## 二、产品决策（待负责人确认）

以下默认按「官网为真」拟定；若负责人另有覆盖，以口头/书面最新决策为准并回写本表。

### 2.1 生图

| 编号 | 议题 | 方案默认 | 需确认 |
| --- | --- | --- | --- |
| I-1 | 官网生图模型集合 | 主路径仅保留官网列出的 `viduq2`、`viduq1`；遗留 `q2-fast` / `q2-pro` / `q3-fast` / `q3-lite` 迁出或标 `retired`（不再作为新装目录种子） | 遗留 key 是退役还是继续兼容 |
| I-2 | 「所有生图模型都要文生图+图生图」 | **严格官网**：`viduq2` = 文生图 + 参考生图 + 图片编辑；`viduq1` = **仅**参考生图（1–7）。不在合同里对 `viduq1` 伪称文生图 | 若负责人坚持 `viduq1` 也开文生图，需接受官网拒识风险 |
| I-3 | 生图 HTTP | 对齐 `POST https://api.vidu.cn/ent/v2/reference2image`，`model` 在 body；Token 鉴权 | — |
| I-4 | 生图生命周期 | 官网响应含 `task_id` / `state`，视为 **异步任务**；工程需从当前 Gemini 同步 `completed_sync` 迁到轮询 + 结果落盘（复用任务查询接口） | 是否允许「提交内短轮询伪同步」过渡 |
| I-5 | Image V1 `viduimage-2` | 本计划不扩能力、不作为创作主候选；保持未验证状态直至专项批准 | — |

### 2.2 生视频

| 编号 | 议题 | 方案默认 | 需确认 |
| --- | --- | --- | --- |
| V-1 | 产品「文生视频」 | → 官网文生视频 `text2video` | — |
| V-2 | 产品「图生视频」 | → 官网图生视频 `img2video`（首帧 **恰好 1 张**） | — |
| V-3 | 参考生视频 | → 官网 `reference2video`；现有实现升级为非主体 `images[]`（1–7），主体模式可作为后续 PR | 主体库 / `subjects` 是否进本阶段 |
| V-4 | 模型矩阵 | 严格按模型地图 + 各接口「可选模型」；同一物理模型可挂多个协议绑定（文生/图生/参考各自独立 binding + profile feature） | — |
| V-5 | 现有冻结视频 key | `viduq3-drama` / `ad` / `mix` / `turbo` / `viduq3` 按地图重新挂能力：例如 mix/drama/ad **无**文生与图生，仅参考生；turbo/viduq3 等按接口文档增补文生/图生 | 是否新增 `viduq3-pro`、`viduq2`、`viduq1` 等官网视频 key |
| V-6 | 参数暴露 | 时长 / 分辨率 / 比例 / audio / bgm / movement_amplitude / off_peak / seed 等按模型差异写进 `ParameterSchemaV2`；UI 只渲染 schema，不写死选项列表 | 错峰、水印、meta_data、callback 是否对用户暴露 |

### 2.3 非目标（本计划不做）

- 登录 / 会员 / 充值 / 云同步；
- 首尾帧、智能多帧、模版成片、对口型、数字人、一键成片等其它视频任务；
- 多图批量创作、视频批量创作；
- 恢复「首页」一级入口；
- 真实计费烟测（预算已尽）；
- macOS 实机与阶段 10 发布物。

---

## 三、官网能力矩阵（实施真源）

### 3.1 图像（reference2image）

端点：`POST /ent/v2/reference2image`  
鉴权：`Authorization: Token {api_key}`

| 模型 | 文生图 | 参考生图 | 图片编辑 | images | 比例 | 分辨率 |
| --- | --- | --- | --- | --- | --- | --- |
| `viduq2` | ✔️（images 空或 0） | ✔️ | ✔️ | 0–7 | 含 `auto`、21:9 等 | 1080p / 2K / 4K |
| `viduq1` | ✗ | ✔️ | ✗ | 1–7 | 16:9 等五档 | 1080p |

公共字段：`prompt`（必填，≤2000）、`seed`、`payload`、`callback_url`。

响应：异步任务（`task_id` + `state`），结果经查询任务接口取回。

### 3.2 文生视频（text2video）

端点：`POST /ent/v2/text2video`  
模型：`viduq3-turbo`、`viduq3-pro`、`viduq2`、`viduq1`  
无图片；`prompt` ≤5000；时长/分辨率/比例/audio/bgm/movement_amplitude/off_peak 等按模型差异。

### 3.3 图生视频（img2video）

端点：`POST /ent/v2/img2video`  
模型：`viduq3-turbo`、`viduq3-pro`、`viduq3-pro-fast`、`viduq2-pro-fast`、`viduq2-pro`、`viduq2-turbo`、`viduq1`、`viduq1-classic`、`vidu2.0`  
`images` **恰好 1 张**（首帧）；`prompt` 可选。

### 3.4 参考生视频（reference2video）

端点：`POST /ent/v2/reference2video`  
非主体模式：`images` 1–7；`viduq2-pro` 可带 `videos`。  
模型含：`viduq3-mix`、`viduq3-turbo`、`viduq3`、`viduq2-pro`、`viduq2`、`viduq1`、`vidu2.0` 等（以文档为准）。  
地图中 drama/ad/mix 侧重参考生，无文生/图生勾选。

### 3.5 UniComp 产品功能映射

| UniComp 产品功能 | 内部 purpose（建议） | Vidu 协议 | 素材约束 |
| --- | --- | --- | --- |
| `text_to_image` | `image_generation` | reference2image | 0 张图 |
| `reference_to_image` | `reference_to_image` | reference2image | ≥1 张（按模型） |
| `image_edit` | `image_editing` | reference2image | ≥1 张（仅 viduq2） |
| `text_to_video` | `video_generation`（或现有等价） | text2video | 无图 |
| `image_to_video` | `reference_to_video` **仅当走参考端点时**；图生端点建议新增/复用清晰 purpose，避免与参考混淆 | **默认 img2video** | 恰好 1 张首帧 |
| （后续）参考生视频专用入口 | `reference_to_video` | reference2video | 1–7 张 |

说明：当前工程把「图生视频」绑在 `reference2video`。本计划要求产品「图生视频」改绑 `img2video`；`reference2video` 保留给真正的参考生，若 UI 暂无独立入口，可先只服务目录/专业扩展，或在图生页用素材数量分支（1 张 → img2video；多张 → reference2video）。**默认推荐：产品页明确分流，禁止静默混端点。**

---

## 四、工程差距（相对现状）

### 4.1 合同与目录

- `frozenViduGeminiImageModelKeys` 含遗留 q\* key；仅 `viduq2` 声明文生图；
- `frozenViduVideoModelKeys` 仅 5 个 Q3 变体，且合同一律 `image_to_video` → `reference_to_video`；
- `createVideoProviderFeatureContracts()` **显式过滤** `productFeature !== 'image_to_video'`，导致文生视频零候选；
- 打包目录 purpose / protocolBinding 未覆盖 text2video、img2video。

### 4.2 适配器与运行时

- Gemini 生图仍走旧路径 `/ent/v2/image/reference2image/{model}` + Gemini JSON，且按同步完成处理；
- 视频仅 `ViduReferenceVideoV2Adapter`：`/ent/v2/reference2video`，强制恰好 1 张图；
- `vidu-shared-runtime` allowlist 无 `/ent/v2/text2video`、`/ent/v2/img2video`、官方 `/ent/v2/reference2image`；
- 包描述符 adapters / template bindings 未注册新协议。

### 4.3 候选与 UI

- 文生视频页依赖 `text_to_video` 候选 → 空列表（符合当前代码，非目录同步问题）；
- 图生视频页有候选，但协议与官网「图生视频」不一致；
- 旧连接缺新模型 key 时，需目录刷新（已有/在途：`ensurePackagedCatalogs`、Vidu `catalog_available`）。

---

## 五、目标架构

```text
ViduProviderPackage
├─ Image official (reference2image)     异步轮询 + 结果接收
│    models: viduq2, viduq1（+ 遗留策略见 I-1）
├─ Video text2video                    异步轮询 + 结果接收（可与现视频接收器共用）
├─ Video img2video                     异步轮询 + 结果接收
└─ Video reference2video               升级现有适配器（多图 / 参数）
```

共享：

- Token 鉴权、任务查询 `GET /ent/v2/tasks/{id}/creations`、取消、结果下载与 24h URL 寿命；
- `ViduBoundedPoller` / `LocalVideoResultReceiver` 模式可抽到「Vidu 异步任务」共用（图片异步后复用）；
- 打包目录安装：按模型 × 协议生成 binding、capability、definition、profile；已有连接幂等刷新。

---

## 六、里程碑与分支

每支从最新 `develop` 拉取；合并后保留本地与远程分支。门禁：官方 `npm test`（Node + Vitest）全绿；Windows 烟测按变更面执行。禁止真实 Vidu 计费调用。

| 里程碑 | 分支 | 范围 | 退出条件 | 粗估 |
| --- | --- | --- | --- | --- |
| PR A | `feature/vidu-official-image-contracts` | 生图合同/目录对齐官网；遗留 key 策略落地；参数 schema；测试 | 合同测试证明 viduq2 文+参+编、viduq1 仅参；旧连接刷新可装新 feature | +400 / −100 |
| PR B | `feature/vidu-official-image-async-adapter` | 生图适配器改官方 reference2image；异步轮询与结果落盘；runtime allowlist | 合成服务全链路：文生图 / 参考生图；Image V1 不动 | +800 |
| PR C | `feature/vidu-text2video` | text2video 协议+合同+适配器；`createVideoProviderFeatureContracts` 纳入 `text_to_video`；submission / route 接线 | 文生视频页出现官网模型候选；合成提交+轮询+落盘 | +900 |
| PR D | `feature/vidu-img2video` | img2video 协议+合同+适配器；产品图生视频改绑 img2video；1 张首帧约束 | 图生视频页走 img2video；合成闭环 | +700 |
| PR E | `feature/vidu-reference2video-upgrade` | reference2video 多图与官网参数；与图生分流；目录矩阵收口 | 参考生与图生端点不再混淆；合同与合成测试覆盖 | +600 |
| PR F（可选） | `feature/vidu-legacy-catalog-cleanup` | 退役遗留 image q\* / 文档与迁移说明 | 新装目录无遗留种子；旧数据可读可藏 | +200 / −300 |

建议批准顺序：**A → B → C → D → E**（F 视负责人）。其中 **C 直接解决「文生视频没有模型」**；**A/B 解决生图能力声明与官网请求形态**；**D 纠正图生视频端点**。

---

## 七、PR 范围明细

### PR A｜生图合同与目录

允许修改：

- `src/platform/providers/vidu/vidu-contracts.ts`
- `src/platform/providers/vidu/vidu-packaged-catalog-install.ts`
- 相关 `tests/platform/vidu-*.test.ts`、`tests/fixtures/vidu-*.ts`
- 必要时 `project-image-feature.ts` 仅随合同展开，不改提交运行时

验收：

- `viduq2` profile features：`text_to_image`、`reference_to_image`、`image_edit`；
- `viduq1`：仅 `reference_to_image`（除非负责人否决 I-2）；
- `purposesForModelKey` / binding `supportedPurposes` 一致；
- 安装幂等；缺 key 时 `ensurePackagedCatalogs` 或同步目录可补齐。

### PR B｜生图官方异步适配器

允许修改：

- `vidu-image-adapters.ts`（或新 `vidu-reference-image-adapter.ts`）
- `vidu-shared-runtime.ts`、`vidu-route-adapters.ts`、`vidu-provider-package.ts`
- `vidu-image-result-port.ts`、image feature 轮询接线（若尚无）
- 合成服务与适配器测试

验收：

- 请求：`POST /ent/v2/reference2image`，body 含 `model`、`prompt`、可选 `images`/`seed`/`aspect_ratio`/`resolution`；
- 0 图 → 文生图；≥1 图 → 参考/编辑；
- 异步：`accepted_async` → 查询 creations → 本地落盘；不得在无本地文件时标正式作品。

### PR C｜文生视频

允许修改：

- 新协议常量与合同（text2video 模型矩阵）
- 新/扩展视频适配器 submit 路径 `/ent/v2/text2video`（无 materials）
- `project-video-feature.ts`：`createVideoProviderFeatureContracts` 纳入 `text_to_video`
- `video-feature-submission.ts`、route adapter、package bindings、catalog install
- 文生视频 UI 仅验收候选非空与参数表单来自 schema（尽量少改 UI）

验收：

- 文生视频页列出 `viduq3-turbo` / `viduq3-pro` / `viduq2` / `viduq1`（以合同为准）；
- 合成：提交无图、轮询、结果预览；
- 不触及真实 Token 与计费。

### PR D｜图生视频（img2video）

允许修改：同 C，换成 img2video；产品 `image_to_video` 默认绑定 img2video。

验收：

- 恰好 1 张受控图；模型集合对齐官网图生视频列表（本阶段可先装子集：至少覆盖现有用户可用的 turbo/pro/q1）；
- 图生视频页不再把请求打到 `reference2video`。

### PR E｜参考生视频升级与分流

允许修改：现有 `ViduReferenceVideoV2Adapter`、约束集（多图）、目录矩阵、文档记录。

验收：

- 非主体 `images` 1–7；参数按官网；
- 与 img2video 端点分流清晰；回归合成测试。

---

## 八、测试与证据策略

1. **合同测试**：每个冻结 key 的 features / purposes / schema 字段与官网表一致；
2. **适配器合成测试**：本地合成 HTTP 断言 path、body 形状、鉴权头种类（不记录 Token 值）；
3. **候选测试**：`text_to_video` / `image_to_video` / `text_to_image` / `reference_to_image` 分别有预期模型；
4. **目录刷新测试**：缺 key 连接经 ensure/sync 后出现新模型；
5. **禁止**：对 `q3-lite` / `viduq3-turbo` 等做真实计费验收；负责人若批准新的免费探针另议。

---

## 九、风险与回滚

| 风险 | 缓解 |
| --- | --- |
| 官网生图已异步，工程仍按同步设计 | PR B 单独收口；未完成前不切换默认创作路径 |
| 图生从 reference 切到 img2video 破坏旧草稿 | 路由按 feature+adapter 版本隔离；旧 operation 仍用原 binding |
| 模型 key 增删导致旧 profile 悬空 | 打包安装幂等升级 features；retired 不删历史行 |
| 文档与模型地图短暂不一致 | 以「接口页可选模型」优先于地图勾选；差异记入 PR 记录 |
| 范围膨胀到主体库/首尾帧 | 八、停止条件硬拦 |

回滚：按 PR 分支回退；打包目录向前兼容，不强制破坏已存 connection。

---

## 十、停止条件

出现任一项即停止并升级负责人：

1. 需要真实计费调用才能证明正确性；
2. 需要恢复首页 / 批量创作 / 登录会员充值；
3. Image V1 未验证却被要求作为默认生图路径；
4. 单 PR 超过可审范围（建议 ≤1200 行净增，证据文件除外）；
5. 官网文档与当前实现无法在「不混端点」前提下映射到现有两个视频产品页，需产品改 IA。

---

## 十一、立即不做什么

- 本方案批准前：**不合并**大范围 Vidu 适配器重写；
- 不在本分支夹带未批准的输入焦点 / 目录 sync 代码（另支处理）；
- 不更新 `AGENTS.md` 阶段状态为「已完成官网对齐」。

---

## 十二、批准后第一步

1. 负责人确认「二、产品决策」表（尤其 I-1、I-2、V-3、V-5、V-6）；
2. 从 `develop` 拉 `feature/vidu-official-image-contracts` 实施 PR A；
3. PR A 合并后进入 PR B；文生视频空洞优先保证 PR C 尽早可测。

---

## 十三、附录：现状文件索引

| 区域 | 路径 |
| --- | --- |
| 合同 | `src/platform/providers/vidu/vidu-contracts.ts` |
| 目录安装 | `src/platform/providers/vidu/vidu-packaged-catalog-install.ts` |
| 生图适配器 | `src/platform/providers/vidu/vidu-image-adapters.ts` |
| 视频适配器 | `src/platform/providers/vidu/vidu-video-adapter.ts` |
| 路由适配器 | `src/platform/providers/vidu/vidu-route-adapters.ts` |
| 运行时 | `src/platform/providers/vidu/vidu-shared-runtime.ts` |
| 包组装 | `src/platform/providers/vidu/vidu-provider-package.ts` |
| 图片功能合同 | `src/platform/providers/project-image-feature.ts` |
| 视频功能合同 | `src/platform/providers/project-video-feature.ts` |
| 视频提交桥 | `src/platform/providers/video-feature-submission.ts` |
| 图片提交桥 | `src/platform/providers/image-feature-submission.ts` |
