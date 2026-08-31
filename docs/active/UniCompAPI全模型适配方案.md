# UniCompAPI 全模型适配方案

## 1. 文档定位

本文档用于指导 UniCompAPI 当前模型目录的统一适配实现，属于工程侧方案文档，不覆盖任何权威 UI 原件，也不代表本方案已经完成实现或通过最终验收。

当前方案基于以下事实：

- UniCompAPI 对外返回 OpenAI Compatible 协议格式；
- 本轮暂不使用服务商返回的 `supported_endpoint_types`；
- UniCompAPI 仍复用现有 `newapi.chat`、`newapi.image`、`newapi.video` 适配器；
- 模型能力必须按精确 `providerModelKey` 显式声明，不能仅根据模型名称或接口存在进行推断；
- 不进行真实服务商 HTTP、真实凭证验证或收费调用；
- 受控图片输入继续遵守项目单图边界，不恢复多图参考、批量创作或任意外部 URL。

## 2. 当前阶段与权威依据

### 2.1 当前阶段

项目当前处于阶段 9 收口状态，阶段 10 尚未启动。本方案只涉及服务商适配工程侧设计，不新增业务一级页面，不启动阶段 10 的安装包、签名、公证或发布工作。

### 2.2 依据

1. 项目负责人在“接”会话中的最新模型接口和参数确认；
2. `AGENTS.md` 中的阶段边界、安全约束和跨平台约束；
3. 现有 NewAPI / UniCompAPI 共享适配代码；
4. 现有 Provider Definition、Profile、ParameterSchema、RouteSnapshot 和测试体系；
5. 已有 Vidu、Seedance、DeepSeek 等官方适配记录，仅用于协议边界参考，不直接复制官方供应商适配器到 UniCompAPI。

## 3. 方案结论

采用“保留现有基础设施、增加 UniCompAPI 精确模型合同层、替换宽泛自动挂载逻辑”的渐进改造方案。

不采用以下方案：

- 不重写现有 `newapi.chat`、`newapi.image`、`newapi.video`；
- 不为 UniCompAPI 复制 DeepSeek、Vidu、Kling、Seedance 或其他官方供应商适配器；
- 不为所有 OpenAI Compatible 模型自动挂载聊天、图片和视频 Profile；
- 不把所有模型强行压缩成一套公共参数 Schema；
- 不使用一个全局默认 Profile 覆盖所有模型能力。

## 4. 目标架构

```text
UniCompAPI 模型目录
        ↓
精确 providerModelKey
        ↓
UniCompAPI 模型合同注册表
        ↓
Definition / Profile / ParameterSchema
        ↓
RouteSnapshot
        ↓
newapi.chat / newapi.image / newapi.video
        ↓
模型族参数投影器
        ↓
UniCompAPI OpenAI Compatible 请求
```

### 4.1 统一适配器

| 适配器 | 功能 | 主要接口 |
|---|---|---|
| `newapi.chat` | 文本聊天、文本推理 | `POST /v1/chat/completions` |
| `newapi.image` | 文生图、图片编辑 | `POST /v1/images/generations`、`POST /v1/images/edits` |
| `newapi.video` | 异步文生视频、图生视频 | `POST /v1/videos`、`GET /v1/videos/{task_id}`、`GET /v1/videos/{task_id}/content` |

### 4.2 包隔离

现有普通 NewAPI 兼容供应商必须保持原有行为；新的严格能力合同只对 `provider-package-unicompapi` 生效。

```text
provider-package-newapi
  保留通用 OpenAI Compatible 兼容行为

provider-package-unicompapi
  使用 UniCompAPI 精确模型合同
```

## 5. UniCompAPI 模型矩阵

### 5.1 文本模型

| 模型 | 功能 | 适配器 | 当前策略 |
|---|---|---|---|
| `deepseek-r1-0528` | `text_chat`、`text_reasoning` | `newapi.chat` | 仅 `/v1/chat/completions` |
| `deepseek-v3` | `text_chat`、`text_reasoning` | `newapi.chat` | 仅 `/v1/chat/completions` |
| `deepseek-v3.2` | `text_chat`、`text_reasoning` | `newapi.chat` | 仅 `/v1/chat/completions` |
| `deepseek-v3.2-exp` | `text_chat`、`text_reasoning` | `newapi.chat` | 仅 `/v1/chat/completions` |
| `deepseek-v4-flash` | `text_chat`、`text_reasoning` | `newapi.chat` | 仅 `/v1/chat/completions` |
| `deepseek-v4-pro` | `text_chat`、`text_reasoning` | `newapi.chat` | 仅 `/v1/chat/completions` |
| `qwen3-235b-a22b` | `text_chat`、`text_reasoning` | `newapi.chat` | 暂不接 Responses / Completions / Messages |
| `qwen3-32b` | `text_chat`、`text_reasoning` | `newapi.chat` | 暂不接 Responses / Completions / Messages |
| `glm-4.6` | `text_chat`、`text_reasoning` | `newapi.chat` | `thinking` 结构待最终冻结 |
| `glm-4.7` | `text_chat`、`text_reasoning` | `newapi.chat` | `thinking` 结构待最终冻结 |
| `glm-5` | `text_chat`、`text_reasoning` | `newapi.chat` | `thinking` 结构待最终冻结 |
| `glm-5.1` | `text_chat`、`text_reasoning` | `newapi.chat` | `thinking` 结构待最终冻结 |
| `glm-5.2` | `text_chat`、`text_reasoning` | `newapi.chat` | `thinking` 结构待最终冻结 |
| `gpt-5.6-luna` | `text_chat` | `newapi.chat` | 其他 GPT 模态暂不推断 |
| `gpt-5.6-sol` | `text_chat` | `newapi.chat` | 其他 GPT 模态暂不推断 |
| `gpt-5.6-terra` | `text_chat` | `newapi.chat` | 其他 GPT 模态暂不推断 |
| `kimi-k2.6` | `text_chat`、可选 `text_reasoning` | `newapi.chat` | `thinking` / `reasoning_effort` 待上游确认 |

聊天类的公共字段包括 `model`、`messages`、`stream`、`stream_options`、输出 token 限制、采样参数、工具调用和元数据。模型专属字段必须通过模型合同控制，不能全部放入公共 Schema。

### 5.2 图片模型

| 模型 | 功能 | 适配器 | 接口 |
|---|---|---|---|
| `doubao-seedream-5-0-260128` | `text_to_image` | `newapi.image` | `POST /v1/images/generations` |
| `qwen-image` | `text_to_image` | `newapi.image` | `POST /v1/images/generations` |
| `qwen-image-edit-2509` | `image_edit` | `newapi.image` | `POST /v1/images/edits` |

`qwen-image` 不得自动获得图片编辑 Profile；`qwen-image-edit-2509` 不得被当作文生图模型使用。

### 5.3 视频模型

| 模型 | 功能 | 适配器 | 当前边界 |
|---|---|---|---|
| `viduq3` | `image_to_video` | `newapi.video` | 单张受控图片 |
| `viduq3-mix` | `image_to_video` | `newapi.video` | 单张受控图片 |
| `viduq3-pro` | `text_to_video` | `newapi.video` | 纯文本 |
| `viduq3-turbo` | `text_to_video`、`image_to_video` | `newapi.video` | 单张受控图片 |
| `happyhorse-1.0-t2v` | `text_to_video` | `newapi.video` | 纯文本 |
| `happyhorse-1.1-t2v` | `text_to_video` | `newapi.video` | 纯文本 |
| `happyhorse-1.0-i2v` | `image_to_video` | `newapi.video` | 单张受控图片 |
| `happyhorse-1.1-i2v` | `image_to_video` | `newapi.video` | 单张受控图片 |
| `happyhorse-1.0-r2v` | 暂不接 | — | 多素材参考与当前项目边界冲突 |
| `happyhorse-1.1-r2v` | 暂不接 | — | 多素材参考与当前项目边界冲突 |
| `happyhorse-1.0-video-edit` | 暂不接 | — | 当前无对应远端产品路由 |
| `doubao-seedance-2-0-260128` | `text_to_video`、`image_to_video` | `newapi.video` | 单张受控图片；模型参数待精确化 |
| `doubao-seedance-2-0-fast-260128` | `text_to_video`、`image_to_video` | `newapi.video` | 单张受控图片；模型参数待精确化 |
| `kling-v3-turbo` | `text_to_video`、`image_to_video` | `newapi.video` | 单张受控图片；`duration` 通常 3—15 秒 |

虽然上游说明可能出现 `images`、`content`、任意 URL 或多素材字段，项目适配器不得因此直接开放这些输入；必须先经过项目内受控素材端口和模型合同校验。

## 6. 代码改造范围

### 6.1 保留并复用

- `src/platform/providers/newapi/newapi-chat-adapter.ts`
- `src/platform/providers/newapi/newapi-image-adapter.ts`
- `src/platform/providers/newapi/newapi-video-adapter.ts`
- `src/platform/providers/newapi/newapi-runtime.ts`
- `src/platform/providers/newapi/unicompapi-contracts.ts`
- 现有 Provider Definition、Profile、ParameterSchema、RouteSnapshot 领域对象
- 现有模型路由、查询、取消、结果接收和测试基础设施

### 6.2 重点改造

1. 将 `unicompapi-model-capabilities.ts` 从零散判断表改为完整模型合同注册表。
2. 复用 `createNewApiModelContract()`，增加 UniCompAPI 专用的 `packageId`、模型声明和 Profile 生成入口。
3. 替换 `tryAttachDefaultTextChatProfile()` 对 UniCompAPI 的宽泛默认文本挂载。
4. 替换图片和视频自动路由中“未命中即使用默认能力”的行为。
5. 保持普通 NewAPI 的兼容逻辑不变，所有严格规则按 `provider-package-unicompapi` 隔离。
6. 为 `qwen-image-edit-2509` 增加 `/v1/images/edits` 请求、受控输入图片、可选 mask 和结果解析。
7. 为 Vidu、HappyHorse、Seedance、Kling 增加模型族参数投影器，复用统一视频生命周期。

### 6.3 不在本方案内修改

- 不修改一级页面和业务入口；
- 不恢复多图参考、图片批量创作或视频批量创作；
- 不新增登录、会员、充值或云同步；
- 不写入任何 API Key、Token 或远端结果；
- 不进行真实供应商调用；
- 不启动阶段 10 发布工作。

## 7. 参数 Schema 设计

采用“公共字段 + 模型专属字段”的两层结构。

### 7.1 聊天 Schema

公共字段：

```text
model
messages
stream
stream_options
max_tokens
max_completion_tokens
temperature
top_p
stop
n
presence_penalty
frequency_penalty
seed
response_format
tools
tool_choice
parallel_tool_calls
user
metadata
```

专属字段示例：

```text
Qwen3: enable_thinking, chat_template_kwargs, top_k
GLM: thinking, reasoning_effort
Kimi: thinking / reasoning_effort（确认后启用）
GPT: reasoning_effort（按模型确认）
```

### 7.2 图片 Schema

文生图与图片编辑必须是两个独立 ProductFeature。编辑请求还需要单独处理 multipart、输入图片和 mask，不能把 `image`、`images`、`mask` 放入文生图 Schema。

### 7.3 视频 Schema

统一支持基础字段，但通过模型族投影器校验和转换：

```text
prompt
image
size
resolution
duration
seconds
ratio / aspect_ratio
seed
watermark
audio / generate_audio
metadata
```

`size` 与 `resolution` 冲突时拒绝请求；不识别的字段不得自动进入 `metadata`。

## 8. 路由与快照策略

### 8.1 路由选择

```text
providerModelKey
  → UniCompAPIModelContract
  → ProductFeature
  → ParameterSchema
  → adapterKey
  → RouteSnapshot
```

### 8.2 能力变更

- 新能力生成新的 Definition/Profile 版本；
- 历史 RouteSnapshot 保持可恢复；
- 不因当前默认能力变化而切换旧任务的供应商、连接、模型或协议；
- 未确认能力默认关闭；
- 旧模型若已有历史快照，不直接删除历史记录。

## 9. 实施阶段

### P0：冻结基线

- 记录当前分支、未提交修改和定向测试结果；
- 只在 `feature/unicompapi-model-adapters` 分支继续开发；
- 不执行真实 HTTP 或收费调用。

### P1：建立完整模型合同

- 注册当前 34 个模型；
- 为每个模型声明功能集合；
- 明确暂不接入模型仍保留目录记录；
- 增加模型合同完整性测试。

### P2：替换宽泛自动挂载

- UniCompAPI 改用精确合同路由；
- 普通 NewAPI 保留旧兼容行为；
- 确保文本模型不自动获得图片/视频 Profile；
- 确保 `qwen-image` 不获得编辑 Profile。

### P3：补齐图片编辑

- 实现 `/v1/images/edits`；
- 增加单图、mask、multipart、Base64/URL 受控转换；
- 增加结果结构解析和失败归一化测试。

### P4：完善视频模型投影

- Vidu 投影；
- HappyHorse 投影；
- Seedance 投影；
- Kling 投影；
- 统一任务查询、取消、结果接收和恢复测试。

### P5：参数合同收口

- 冻结 GLM `thinking` 结构；
- 冻结 GLM / GPT / Kimi 的 `reasoning_effort` 范围；
- 确认 Seedance 两个模型的差异参数；
- 按模型补齐 Schema 和拒绝矩阵。

### P6：统一验收

- TypeScript 检查；
- ESLint；
- 定向 Vitest；
- 全量 Vitest；
- 路由快照恢复测试；
- 生产构建；
- 仅使用合成 transport，不进行真实供应商调用。

## 10. 验收标准

### 模型覆盖

- 34 个目录模型均有明确状态：已接、部分接入或暂不接；
- 不存在未声明能力的模型 Profile；
- 不存在模型名称推断能力的路由分支。

### 路由正确性

- 文本模型只能进入 `newapi.chat`；
- 图片生成模型只能进入 `newapi.image` 的 generations；
- 图片编辑模型只能进入 `newapi.image` 的 edits；
- 视频模型按功能进入 `newapi.video`；
- DeepSeek 不进入 `/v1/responses`；
- 暂不接模型不会出现在可用功能候选中。

### 参数安全

- 非法字段被拒绝或明确忽略；
- `size` 与 `resolution` 冲突被拒绝；
- 多图、任意 URL、未受控素材被拒绝；
- Token 不进入日志、错误消息、测试快照或 Git。

### 快照与恢复

- 提交后使用原始 RouteSnapshot 查询任务；
- 连接、模型或默认能力变化不影响历史任务恢复；
- 旧 Profile 不被静默覆盖。

### 工程门禁

- 无真实服务商 HTTP；
- 无真实凭证读取或验证；
- 无收费调用；
- TypeScript、Vitest、生产构建全部通过；
- 未完成项记录到 `PLANS.md` 或对应阶段记录。

## 11. 未决事项

以下事项在实现前需要继续冻结，不应通过猜测处理：

1. GLM `thinking` 对象的确切结构；
2. GLM、GPT、Kimi 的 `reasoning_effort` 允许值及模型差异；
3. GPT 三个 UniCompAPI 模型是否支持图片、音频、视频或 Responses；
4. Seedance 两个模型的精确时长、分辨率、音频和图生限制；
5. Kling `kling-v3-turbo` 的最终 `duration`、比例和受控首帧限制；
6. `qwen-image-edit-2509` 的具体 multipart / JSON 接收形式；
7. UniCompAPI 模型目录同步时是否会新增本方案之外的模型。

## 12. 结论

UniCompAPI 适配应采用现有代码基础上的增量重构：保留共享 OpenAI Compatible 适配器和执行生命周期，新增完整的 UniCompAPI 模型合同注册表，按模型精确挂载 Profile 和 ParameterSchema，再由模型族参数投影器完成最终请求序列化。

该方案能够在不破坏普通 NewAPI 兼容行为的前提下，逐步覆盖当前 34 个模型，并为后续新增模型提供可审计、可测试、可恢复的扩展入口。

## 13. 本轮一次性实施结果（2026-08-10）

本方案已在本地分支 `feature/unicompapi-full-adaptation` 按 P0→P6 顺序实施完成，未上传、未合并、未调用真实供应商接口。

### 已落地

- P1：登记目录中的 34 个 UniCompAPI 模型及显式能力集合。
- P2：按 `providerModelKey` 精确挂载文本、图片和视频 Profile；普通 NewAPI 保持旧兼容行为。
- P3：实现 `qwen-image-edit-2509` 的 `POST /v1/images/edits` 路由，要求单个受控图片 `assetId`；文生图与图片编辑输入互斥。
- P4：实现 Vidu、HappyHorse、Seedance、Kling 的 UniCompAPI 视频能力路由与模型族参数约束，复用统一异步生命周期。
- P5：实现聊天公共参数、GLM/Qwen3 专属推理字段、DeepSeek 受限 `reasoning_effort`、视频参数冲突校验和 UniCompAPI 元数据投影。
- P6：定向测试、平台/领域全量测试、统一测试、TypeScript、ESLint、生产构建和 `git diff --check` 均已通过。

### 明确保留的边界

- 暂不启用 `supported_endpoint_types`，也不接入 `/v1/responses`。
- 未获得上游正式契约的 GLM/GPT/Kimi/Seedance/Kling 细分字段不进行猜测；当前只开放已声明且有 Schema/测试覆盖的字段。
- `happyhorse` 的 r2v、video-edit 继续关闭；未声明能力不会出现在可用功能候选中。
- 不进行真实 HTTP、真实 Token、收费调用或生产媒体结果验收；图片编辑只接受项目受控素材，不接受任意外部 URL。

详细执行证据见 `docs/active/UniCompAPI全模型适配验收记录.md`。

## 14. 工程侧变更说明（2026-08-11）

项目负责人最新明确决策覆盖本文件中关于 `qwen-image-edit-2509` 的旧接口与功能映射：

- 模型功能由独立 `image_edit` 调整为专业图片页的 `reference_to_image`；
- 请求接口由 `POST /v1/images/edits` 调整为 `POST /v1/images/generations`；
- 请求仍要求单张项目受控图片，模型名 `qwen-image-edit-2509` 原封不动发送；
- 历史 `image_edit` Profile 不再作为当前 UniCompAPI 候选，避免旧注册表记录继续暴露错误路由。

本节为最新有效方案。第 4.3、6.3、8.2、11 和 13 节中与本节冲突的 `image_edit`、`/v1/images/edits` 描述仅保留为历史实施记录，不再作为当前实现依据。
