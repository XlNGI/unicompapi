# 模型能力、计费与参数输入优化方案

状态：待负责人审核，未授权实施

日期：2026-09-18

项目：UniComp

## 1. 文档边界

本文件是本次接管审计后的唯一执行方案。当前只写入本地方案文档，不修改业务源码、用户注册表、项目数据、外部中转站、Git 历史或远程分支。

方案批准不等于实施授权。负责人确认后，按阶段执行；每个阶段完成后暂停，提交变更清单、测试证据和未验证项，得到继续指令后再进入下一阶段。

明确不在本次范围内：恢复首页、批量创作、多图参考、登录/会员/充值/云同步；写死服务商、模型或价格；读取或输出 API Key、Token；用真实付费调用证明方案；直接改写 `C:\Users\Administrator\AppData\Roaming\unicomp-desktop\provider-registry.json`。

## 2. 审计结论

本任务是 `开发执行 / 阶段计划` 路线，深度为 D2：模型能力路由、计费读模型、参数输入组件是三个语义所有者，需要共同的可见行为契约，但不需要更换框架、SDK、数据库或部署架构。

当前 Git 状态：`develop`，提交 `5b9e2cc`，与 `origin/develop` 一致，工作区干净。当前项目已完成既定阶段，任务属于维护、稳定性和性能治理。

唯一推荐主线：先补齐现场证据，再修正能力真源和旧数据门禁，随后让计费链路可关联且可解释，最后解除参数输入与父级草稿同步的即时耦合，完成组合回归和 Electron 验收。

### 2.1 问题一：视频页出现生图模型

已确认根因不是视频页单纯漏过滤，而是通用 NewAPI/OpenAI Compatible 路由在平台层伪造了模型能力。

调用链：

```text
VideoFeatureSubmissionPanel
  -> preload videoFeatures.listCandidates
  -> VideoFeatureController.listCandidates
  -> ProviderFeatureCandidateService.listFeatureCandidates
  -> RegistryFeatureCandidateSource.list
  -> routeOpenAiCompatibleVideoProfilesForEnabledModels
  -> 持久化 video profile
  -> ModelSelect
```

证据：

- `src/platform/providers/newapi/openai-compatible-video-routing.ts` 对普通 `provider-package-newapi` 不检查逐模型能力声明；连接模板存在 `newapi.video` 适配器时，就为启用模型创建 `text_to_video` 和 `image_to_video` profile。
- `src/platform/providers/newapi/newapi-contracts.ts` 的通用模板同时注册 chat、image、video 适配器。适配器只证明连接存在调用通道，不证明连接下每个模型支持视频。
- `src/platform/providers/provider-registry-feature-candidates.ts` 在候选查询时再次执行路由并持久化结果；候选层按已经生成的 `productFeature` 筛选，无法识别最初伪造的能力。
- `src/platform/providers/provider-feature-candidates.ts` 只校验 profile、route、参数 Schema 的内部一致性；伪造 profile 的三者可以自洽，因此不会被拒绝。
- `src/pages/creation/video/VideoFeatureSubmissionPanel.tsx` 和 `src/components/ModelSelect.tsx` 直接展示返回候选。错误 profile 的 `available` 为真，所以会进入可用分组。
- 本机真实注册表中，`gpt-image-2.5`、`gpt-image-2-auto`、`ergouzi/e-image` 等 `mediaKind=unknown` 模型同时具有图像和视频 profile，证明错误状态已被持久化。
- 现有 `tests/platform/openai-compatible-video-routing.test.ts` 的 8/8 通过并不能证明正确性；其中“普通 OpenAI Compatible 同名模型自动获得视频能力”的测试语义正好固化了缺陷。

结论：普通中转站只有在具体模型存在可信能力证据时才能进入视频候选。不能用模型名称关键词过滤，也不能只在 UI 隐藏。

### 2.2 问题二：`weq / gpt-image-2.5` 显示无法估算费用

已确认这不是“所有其他中转站都不能计费”的事实。当前代码只对支持 NewAPI 计费协议的连接启用站点日志/价格对账；通用 OpenAI Compatible 若无同等协议，则只能使用官方价格规则或回退到未估算。

截图对应本地项目 `D:\测试` 的调用事实：

- route：`route-47824ee9-b030-4239-abca-83de493e71bb`，连接 `weq`，模型 `gpt-image-2.5`，创建时间 `2026-09-17T03:34:46.257Z`。
- invocation：`attempt-10c9a6c2-7637-44f9-bc17-cd36023b1abf`，状态 `completed`。
- operation：`newapi-image-985a8b9a-c770-40a2-b862-594168c3b202`，同步完成，产生 1 个有效本地图像结果。
- usage observation：状态 `not_reported`，`facts=[]`，没有 `providerRequestId`。
- `image_submit` 返回 HTTP 200，但本次日志未记录响应请求 ID；因此无法凭请求 ID 在账单日志中关联该次调用。
- 随后的 `billing_logs`、`site_status`、`model_pricing` 查询在日志中出现 HTTP 404 `model_not_found`，也出现过 HTTP 429 `rate_limited`；不能把这些响应概括为“接口正常”。
- `provider-invocation-read-model-controller.ts` 只有在请求 ID/操作 ID关联到账单金额，或价格快照和用量足够时才生成金额；其他异常被捕获后回退为 `unestimated`。
- `src/pages/tasks/call-fees.ts` 只显示“无法估算”，没有展示缺少关联 ID、缺少用量、缺少价格、账单端点不支持或暂时限流等实际原因。

仍未验证：无法从当前脱敏日志证明 `weq` 当时 `/api/pricing` 响应是否包含精确键 `gpt-image-2.5`；也未读取任何凭证重新请求。该项必须在实施前通过脱敏 fixture 或负责人授权的只读诊断确认。

结论：先保证每次成功提交都尽可能持久化可关联的上游 request ID，并把账单查询的状态/错误原因结构化保留；对有真实站点协议的中转站支持实际账单，对仅有价格但无账单协议的连接支持明确标注的站点预估，对没有足够事实的调用继续显示未估算但要能解释原因。

### 2.3 问题三：填写模型参数卡顿

已确认当前输入链路存在同步耦合：

```text
控件 onChange
  -> changeParameter
  -> onDraftChange
  -> 替换整个工作区 draft
  -> setDirty
  -> autosave.queue
  -> 页面/参数区重渲染
  -> 参数校验和候选相关 effect 重新评估
```

证据：

- `src/components/DynamicParameterForm.tsx` 的普通字符串和数字控件每次按键都调用 `onChange`；数组和 JSON 控件虽然有局部 `text`，解析成功时仍立即提交父级。
- `src/pages/creation/video/VideoFeatureSubmissionPanel.tsx` 的 `changeParameter` 复制整个 `parameterValues` 并通过 `onDraftChange` 替换工作区草稿。
- `src/pages/creation/video/VideoWorkbenchPage.tsx` 随后更新 dirty 状态并排队最新快照自动保存。1 秒 debounce 只减少磁盘写入，不能消除按键期间的 React 状态更新和重渲染。
- 当前测试验证了候选读取期间的状态保护，但没有输入延迟、渲染次数或 IPC 频率基线。

尚未验证：需要真实 Electron 性能记录区分工作区重渲染、参数校验、候选 effect 和 IPC/保存回写的耗时占比。静态调用链已足以确定耦合存在，但不能仅凭静态代码断言唯一的 CPU 热点。

结论：输入控件维护本地编辑缓冲；停止输入、失焦或明确提交时才向父级提交稳定值；父级继续使用现有最新快照协调器；参数编辑期间不刷新候选；提交前保留完整校验。

## 3. 博客依据与适用边界

以下内容来自本次直接读取的博客页面原文，不使用旧蒸馏摘要。

| 文章 | 页面 | 博客明确提出 | 结合项目推导 | 尚未验证 |
|---|---|---|---|---|
| 《问题解决篇：一个bug反复解决不了怎么办》 | https://blog.openbeetles.com/223.html | 固定现象，建立原因假设，用排除证据定位所有者；修复失败时回到原因表。 | 三个问题必须分别建立可复现输入、调用链和所有者，不能先改 UI 再猜根因。 | 方案实施后每阶段是否达到目标，需要新鲜测试和 Electron 证据。 |
| 《问题解决篇：一个项目需要几种环境？几台服务器？运用流程是什么？》 | https://blog.openbeetles.com/287.html | 开发、测试、生产证据分开；开发验证不能替代真实用户验收。 | 本机 registry、`D:\测试` 数据、仓库测试和 Electron 手工验收分别标注，不能互相冒充。 | 生产中转站是否提供稳定账单协议，当前没有生产合同证据。 |
| 《前端篇：loading》 | https://blog.openbeetles.com/273.html | 加载状态应服务于真实等待和状态反馈。 | 计费刷新、候选读取和参数提交应有可解释的状态，不能用一个模糊的“无法估算”掩盖多个原因。 | 具体文中的交互规范是否覆盖本项目全部控件，未逐条验证。 |
| 《前端篇：下拉刷新和加载更多》 | https://blog.openbeetles.com/283.html | 异步列表需要边界、状态和重复触发控制。 | 候选列表应在编辑参数时保持稳定，刷新必须由明确依赖触发，避免输入每个字符触发异步读取。 | 文章对 Electron/React 性能的具体阈值未提供项目级证据。 |

博客内容是方法论参考，不覆盖本项目的 provider contract、计费协议或性能实现；源码和运行证据优先。

## 4. 唯一推荐方案

### 4.1 能力真源和候选门禁

在平台路由层建立“连接适配器能力”和“具体模型能力”两级事实：

1. 普通 OpenAI Compatible 连接的 video adapter 只允许发起视频协议调用，不自动给全部模型挂载视频 profile。
2. 只有逐模型能力声明、用户对具体模型的显式确认并版本化保存、或可信包级精确模型映射，才能生成对应视频 profile。
3. 未知能力模型从视频候选中排除，不放入“暂不可用”分组，避免用户误选；管理页可另行显示“未确认能力”，但不属于本次视频提交候选。
4. 候选服务增加 capability evidence、adapter route、productFeature、parameter schema、result/usage schema 一致性门禁；门禁放在平台层，UI 只消费结果。
5. 对已持久化的错误 profile 使用版本化迁移或查询时失效：删除/改写前先备份并提供回滚；不能直接改用户 registry。迁移后旧 profile 必须带失效原因和迁移版本，避免下次候选查询重新生成。
6. 重写当前两个错误语义测试，补充 image-only/unknown model 的视频候选回归测试；保留 UniCompAPI 精确映射和显式能力证据的正例。

### 4.2 中转站计费关联、估算和诊断

保持现有 NewAPI 读模型作为协议适配器，扩展其事实表达，不复制一套独立计费真相：

1. 成功响应中的 allowlisted request ID 统一写入 usage observation；若上游没有响应头 ID，要记录 `request_id_unavailable` 诊断状态，而不是静默丢失。
2. 账单 reconciliation 区分 `logs_unavailable_404`、`logs_rate_limited`、`logs_transport_error`、`request_id_missing`、`usage_not_reported`、`pricing_model_missing`、`pricing_invalid`、`currency_unconvertible` 等 bounded reason code。
3. 任务中心显示金额状态和短原因：实际账单、站点预估、官方价格预估、等待对账、无法估算（缺什么）。原始 URL、响应体、凭证和内部错误文本不展示。
4. 对有 NewAPI `/api/log/token`、`/api/status`、`/api/pricing` 协议的中转站，优先请求日志对账；日志无法关联时才使用价格快照和已验证用量进行预估。
5. 对仅提供 OpenAI Compatible 生成接口、没有账单协议的站点，不虚构实际账单；若用户显式配置并确认官方价格规则，显示“官方价格预估”，否则显示可解释的未估算。
6. 价格键必须使用 route 的 `providerModelKey`，并支持经验证的站点别名映射；禁止按模型名称猜价格或写死价格。
7. `/api/pricing` 的精确键、账单日志关联和响应 ID提取先用脱敏 fixture 测试；不以 HTTP 200 作为计费成功证据。

### 4.3 参数输入性能

1. 在 `DynamicParameterForm` 内按字段维护编辑缓冲：文本、数字中间态、数组和 JSON 无效文本都先留在控件本地。
2. onChange 只更新本地输入和轻量本地错误；失焦、回车/明确提交或提交前统一把稳定值发送给父级。
3. 父级只在稳定值变化时替换 draft；参数编辑期间不重新调用 `listCandidates`，不重建不相关工作区节点。
4. 提交前执行完整 schema 校验，阻止无效中间态进入 provider dispatch；取消、切换模型和切换页面时按现有草稿语义 flush 或回滚。
5. 保留现有 autosave 最新快照和冲突保护，不通过无限延长 debounce 掩盖同步渲染问题。
6. 增加开发期性能诊断（输入事件到可见文本更新时间、父级提交次数、候选请求次数、autosave IPC 次数、参数区 render 次数），日志只记录计数和耗时，不记录提示词、凭证或完整参数内容。

## 5. 拒绝的替代方案

| 替代方案 | 拒绝原因 |
|---|---|
| 只在视频页按模型名包含 `image`/`video` 过滤 | 名称不是能力证据，会误伤自定义模型，也无法处理旧 profile 和其他入口。 |
| 只把错误模型在 UI 中隐藏 | 平台仍会持久化错误 route，其他入口和提交链路仍可能使用，根因未修复。 |
| 看到中转站有 video adapter 就默认所有模型支持视频 | 正是当前缺陷的来源，适配器能力与模型能力是两个事实层。 |
| 所有中转站统一套用 NewAPI 账单接口 | 协议不成立时会制造 404/429 和虚假金额；实际账单、站点预估、官方预估必须区分。 |
| 只延长 autosave debounce | debounce 只影响磁盘写入，不能消除每次按键的受控状态更新和重渲染。 |
| 每次输入都发异步保存/候选刷新 | 会放大 IPC、网络和竞态，无法保证最新值且更容易卡顿。 |
| 直接清空本机 registry 中的错误 profile | 破坏用户数据、不可审计、不可回滚，不符合当前授权边界。 |

## 6. 分阶段执行与验收

每阶段完成后暂停。RED/GREEN 指该阶段先写失败断言再实现使其通过；未完成阶段不得宣称整体完成。

### P0：补齐证据和性能基线

范围：测试 fixture、脱敏诊断、开发期性能记录；不改变业务行为。

RED：计费 fixture 缺少 request ID、usage、精确价格键或返回 404/429 时，当前模型无法区分原因；参数性能脚本无法给出按键延迟、render、候选请求和 autosave 次数。

GREEN：能对截图调用重建四类事实；能在 Electron 中记录至少 30 次连续输入的 p50/p95 可见延迟、父级提交次数、候选请求次数和 autosave IPC 次数；所有输出脱敏。

停止条件：无法在不读取凭证的情况下重建现场，或性能采集本身改变交互行为。

### P1：修正模型能力真源和旧 profile 门禁

范围：`openai-compatible-video-routing`、候选服务、能力/route contract、相关测试；不改 UI 样式。

RED：普通未知模型被自动生成视频 profile；已有错误 profile 仍能进入视频候选。

GREEN：普通未知/image-only 模型不生成视频 profile；显式能力证据和可信精确映射仍可生成；旧错误 profile 被查询门禁排除且迁移可回滚；候选内部 contract、平台测试和类型检查通过。

停止条件：无法定义能力证据版本，或迁移会不可逆覆盖用户 registry。

### P2：补齐计费关联和可解释失败状态

范围：NewAPI billing adapter、usage schema/read model、任务中心文案和 contract tests；不调用真实付费接口。

RED：请求 ID缺失、账单 404/429、usage not reported、pricing key missing 都只得到 `unestimated`，且没有 reason code。

GREEN：相同 fixture 能得到实际账单/站点预估/官方预估/等待对账/可解释未估算；金额计算使用精确小数；HTTP 200 但 payload 无效不会计费成功；无协议中转站不会伪造账单。

停止条件：无法建立中转站协议能力声明，或价格来源无法审计。

### P3：解除参数即时输入耦合

范围：`DynamicParameterForm`、视频/图片参数提交边界、性能 contract tests；保持现有 schema 校验和 autosave 语义。

RED：输入一个字符就替换整个工作区 draft，候选/保存计数随每次按键增长，JSON/数组无效中间态无法继续编辑。

GREEN：文本立即可见；稳定提交才更新父级；输入期间候选请求为 0；失焦/提交/切换模型时稳定值正确保存；无效值不会进入 dispatch；性能基线 p95 低于 100ms，且无明显输入冻结。100ms 是本项目验收目标，不是博客或系统普遍保证。

停止条件：flush 与切换模型产生旧值覆盖新值、或性能下降超过基线 20%。

### P4：组合回归、构建和 Electron 验收

范围：全部受影响契约、类型检查、lint、生产构建、`git diff --check` 和真实 Electron 手工流程。

自动化 GREEN：相关 Vitest/Node UI contracts、typecheck、lint、production build、diff check 全部通过；无 secret/token 进入 diff、日志或测试 fixture。

Electron GREEN：视频页不显示未确认生图模型；用脱敏 fixture 验证计费状态和原因文案；连续输入参数无卡死，失焦/提交后重开仍是最新值；候选不因输入字符刷新。

## 7. 风险、回滚和停止条件

- 能力收紧可能使某些中转站暂时没有视频候选；这是未知能力的诚实结果，只有拿到逐模型证据后恢复。
- 旧 profile 迁移若只在查询时失效，注册表仍保留历史数据；若增加版本化迁移，必须先备份、记录迁移版本并支持反向恢复。
- 计费接口受限或协议不兼容时，系统只能展示“无法估算/等待对账”；不得用猜测金额替代事实。
- 本地性能目标受机器、开发构建和 Electron 负载影响；必须记录环境、构建模式和样本数。
- 每阶段可独立回滚到阶段前提交；禁止直接修改用户 AppData 数据作为修复手段。
- 若同一假设连续三次修复失败，停止局部打补丁，重新检查所有者、事实真源和契约。

## 8. Git、隐私和授权

从 `develop` 创建 `feature/*` 分支实施；每阶段一个可回溯提交，保留本地和远程分支。方案阶段不创建分支、不提交源码。

测试 fixture 只允许使用脱敏 ID、状态、计数和金额；禁止 API Key、Token、完整响应体、提示词、绝对用户文件路径进入仓库。外部站点查询仅在负责人明确授权并记录范围、时间、响应状态和费用事实后进行。

## 9. 未验证项清单

1. `weq` 当时 `/api/pricing` 是否包含精确键 `gpt-image-2.5`。
2. `weq` 账单日志是否曾包含与该图像请求相同的上游 request ID；当前调用记录显示 request ID 未进入 usage。
3. 普通中转站是否能提供逐模型视频能力元数据。
4. 参数卡顿在真实 Electron 中的主要耗时分布，以及 P3 改造后的实际 p95。
5. 生产环境中各中转站的账单协议覆盖率和汇率规则。

## 10. 审核结论

当前证据支持上述唯一主线，不能支持“先改 UI 过滤”“所有中转站直接套同一计费协议”或“仅延长 debounce”。不需要推倒重来：现有 provider route、billing read model、autosave 和参数 schema 都可保留，修复集中在能力证据门禁、计费关联/诊断和输入状态边界。

负责人审核通过后，下一步只进入 P0；P0 完成后暂停并提交验证证据，不自动进入 P1。
