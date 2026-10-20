# WWW 视频参数适配专项审计

> 本文保留修复前审计快照；后续实现、验收和剩余边界见[修复记录](video-parameter-repair-20261020.md)。

2026-10-20，维护审计。负责人要求“先审核一下代码，官方的必填项，参数的数据类型，范围，等等”。依据本轮要求、AGENTS.md、PLANS.md 顶部维护事实、当前源码和当日九个 WWW 视频型号公开文档；沿用 feature/video-h3-audit-20261020，基线 develop@1142611913cb5f68efe053571d156348a5b9d8a9。允许修改范围仅为本工程记录、审计脚本、脱敏证据和 PLANS.md；未修复业务代码、修改真实配置或用户项目，未提交、合并、推送或发布。

## 结论

模型参数适配不完整，且来源、表单和 Host 的规则没有形成同一套可验收合同。现有通用校验器已实现类型、枚举、数值范围、帧数离散值及未知字段拒绝，不能把它们描述为完全不存在；问题集中在 H3 未知要求被错误变成可省略、Seedance 提示词长度、组合条件、素材透明通道和实际文件上限。

本轮核对 9 个型号、58 个 catalog 字段：H3 的 5 字段只有请求示例和基础类型；其余 53 个在公开参数表中均标“可选”。没有证据支持把这 53 个全部改为必填，也不能仅凭 H3 五字段示例宣布它们全部是官方必填。提示词、生成方式和素材角色/数量属于另外的请求层与条件约束，应单独建模。

H3 当前 revision 3 与实际绑定相符，前轮真实空参报价 400 / invalid_h3_parameters、官网五字段示例报价 200 的证据仍有效。这说明已知无效的空请求被本地放行；不能据此推断所有单字段必填性或 5 秒是否受支持。此前诊断丢失与任务快照问题见 [H3 业务审计](video-h3-audit-20261020.md)，本轮不重复执行真实报价。

## 已确认缺陷

### F1 / P1：H3 将未知必填与默认事实转成“允许省略”

位置：`src/platform/providers/newapi/www-video-catalog.json:23`、`src/platform/providers/newapi/www-video-contracts.ts:48`、`src/components/DynamicParameterForm.tsx:105`。

H3 的 resolution/ratio 是任意 string，duration 是无最小/最大/离散范围的 integer，generate_audio/watermark 是 boolean；五字段 required 均为 null。Schema 投影只区分 documentedRequired===true，其他一律 required=false / user_optional / omit_use_provider_default。“文档未知”由此成为“用户可省略、服务商会默认”的产品承诺，UI 通用说明又强化了这个承诺。

离线调用真实源码与表单转换函数：`{}`、`{duration:5}`、任意 resolution/ratio 字符串、duration=0/999999999 均通过 UI 和 Host，并进入合成报价。duration=-1 则 UI 拒绝而 Host 接受，说明附加业务规则没有统一到 Schema。前轮真实网关已拒绝空对象；本轮其它数值/字符串仅证明本地无约束，不宣称已向网关实测或取得完整合法范围。

建议保留 unknown/optional/required 三态及证据来源；阻止已知失败的空 H3 路径，提供可明确选用且标明来源的已验证示例组合。取得正式 generate 合同或有界服务证据前，不发明枚举、固定默认或必填清单。类型判断本身已存在，例如字符串 `"5"`、小数时长及字符串 `"false"` 不应被当成 integer/boolean。

### F2 / P2：Seedance 官方提示词上限 20,000，本地却限制为 2,500

位置：`scripts/compile-www-video-contracts.cjs:54`、`src/platform/providers/newapi/www-video-catalog.json:298`、`src/platform/providers/newapi/www-video-adapter.ts:65`。

编译器以型号前缀决定 `wan ? 20000 : 2500`，没有从对应型号的公开规则取得提示词上限。Seedance 当前文档明确“最多 20000 字符”并进一步说明“20,000 个 Unicode 字符”。真实适配器对 2500 个 ASCII 字符继续进入合成报价，3000 个 ASCII 字符在任何传输前失败。表单只检查非空，没有模型上限反馈；适配器 catch 又抹掉了具体失败原因。

同时，`.length` 统计 UTF-16 代码单元，与文档 Unicode 字符语义不同：1500 个 emoji 的离线输入也被当前 2500 限制拒绝。应同时修正来源上限与字符计数，并将同一约束提供给表单和 Host。不能仅放宽 catalog 数字而保留两层规则分歧。

### F3 / P2：条件与组合规则只存在于适配器，表单无法提前判断

位置：`src/domain/entities/product-feature.ts:98`、`src/platform/providers/newapi/www-video-adapter.ts:76`、`:260`、`src/pages/creation/video/VideoFeatureSubmissionPanel.tsx:311`。

ParameterSchemaV2 仅包含字段列表，每个 validationSchema 只校验单字段值，缺少整个请求对象或跨字段/素材条件。通用 JSON 校验器虽有组合能力，目前没有接到这个对象层级。

两个真实源码离线反例：

| 输入 | UI / 字段 Schema | 适配器 |
| --- | --- | --- |
| Seedance frames=29 且 duration_seconds=4 | 都判有效 | 立即拒绝；分别只填其中一个可进入合成报价 |
| Seedance first_last_frame，只有 1 张图 | 字段有效；页面仅要求至少 1 张 | 立即拒绝；2 张图能按角色上传并进入合成报价 |

官网明确首尾帧各 1 件。frames 文本为“29–289 且每次递增 4；留空时使用 duration_seconds”，没有将其写成官方严格互斥条款；因此审计确认的是客户端与适配器的规则不一致，不推断服务端必然拒绝同时传两者。应由受控合同表达选用/优先/互斥语义与素材角色数量，并让 UI、Application 和 Host 共用。

### F4 / P2：Wan 阿里型号“图片无透明通道”规则缺失

位置：`src/platform/providers/newapi/www-video-adapter.ts:97`、`src/platform/providers/newapi/newapi-video-adapter.ts:104`、`src/platform/providers/video-feature-submission.ts:501`、`src/platform/files/node-image-inspector.ts:12`。

wan3.0-video-ali 与 wan3.0-video-prime-ali 当日文档明确“图片须无透明通道”。当前 ControlledNewApiImageV1 仅传 MIME、尺寸、字节数与字节，不包含 alpha 检查结果；WWW 适配器只检查 PNG/JPEG、尺寸、像素、大小、比例和总量，缺少这项约束。真实读取链也不移除或验证透明通道。

离线构造有效 300×300、429 字节、RGBA/color type 6、所有像素完全透明的 PNG，生产 inspectImageBuffer 接受为普通 PNG；真实 WWW 适配器继续调用合成 /v1/assets 和 /v1/videos/quote。测试在费用确认处取消，没有收费提交，也没有向真实网站上传该图片。

应在外发前检查并给出可操作的素材错误；是否允许用户显式转换为无透明通道图片，需保持受控素材与 Hash/报价一致性，不得静默改变已确认的上传内容。

### F5 / P2：实际素材读取上限固定 15 MiB，提前截断模型合同范围

位置：`src/platform/ipc/video-feature-runtime.ts:291`、`src/platform/providers/vidu/controlled-image-material.ts:59`、`scripts/compile-www-video-contracts.cjs:59`。

所有视频型号复用 ProjectImageMaterialResolver，组合入口没有传 maximumInputBytes，因而使用原有固定 15×1024×1024。其后 WWW 合同与适配器声明的单图上限为约 20 MiB、20,000,000 字节或 Seedance <30,000,000 字节。用户无法实际使用这些声明范围的上段，且表单没有表达 15 MiB 这一更严的本地限制。

真实文件读取器离线复现：在 outputs 隔离目录登记一张有效、不含透明通道的 2400×2400 PNG，17,285,098 字节；尺寸、像素和大小位于当前 WWW 图生视频合同范围内。默认读取器报 material_too_large；仅在合成读取器中显式传 20 MiB，同一文件读取成功。未修改应用组合入口，也未触碰真实用户项目。

这是实际产品限制与模型合同的分歧。若 15 MiB 是明确产品边界，应对候选/表单如实呈现；若按模型提供服务，应将模型上限传到受控读取链，同时保持资源预算。不能仅修改适配器中的 maximumBytes，前置读取器仍会先拒绝。WWW 上传走二进制并单独允许到 100,000,000 字节，不能用其它 Base64 图片路径的上限解释为官方模型限制。

## 已实现的校验与支持边界

调用真实 `wwwVideoParameterSchema → toDynamicParameterFields → validateDynamicParameterValues / validateParameterValues`，对全部当前特征投影执行 247 个正反向检查：合法值、错误基础类型、枚举外值、上下界越界和 frames 非法增量均符合现有 Schema。例子包括：

| 规则 | 当前实现 |
| --- | --- |
| HappyHorse duration_seconds | integer，3–15 |
| HappyHorse seed | integer，0–2147483647 |
| Seedance frames | 29、33……289；30 被拒绝 |
| Seedance priority | integer，0–9 |
| Wan duration_seconds | 整数枚举 -1、2……30；不是任意数字 |
| Wan seed | 基础版最小 0；阿里版最小 -1 |
| boolean | false 保留为 false；字符串 false 不接受 |
| 参数字段白名单 | Host 拒绝未知字段 |

这些是校验机制检查，不证明所采集的官方合同完整，也不证明真实服务对所有组合可用。提示词非空、素材本地文件/Hash/尺寸等检查同样存在；当前缺陷不应被表述为所有必填和数据类型均未实现。

产品当前只接收一段 MP4；PNG/JPEG 素材、可控图片生成方式等也是现有支持子集。未支持音视频混合参考、文档/网页参考、附加尾帧图片或 MOV，不应因官网列出它们就自动扩大产品范围。Schema 隐藏 return_last_frame 与 omni_reference_task_type 的做法与接收边界一致。

## Schema 同步事实与文档冲突

对编译脚本使用 VM + 只捕获写入的 fs facade，未运行会覆盖产品 catalog 的普通编译命令。

- 使用 catalog 当时对应、Hash 匹配的 2026-10-19 保留文档，重新编译 58 字段与已提交 catalog 一致，字段差异 0。不能认定昨天编译时凭空漏掉这些表格字段。
- 使用本轮 2026-10-20 文档，只出现 Seedance 两个字段差异：generation_mode 新列 last_frame/first_frame_audio；output_format 新列 mov。当前产品仍只有 mp4，Seedance 当前图生模式也没有 last_frame；不能声称它们现在已出现在用户表单。
- 今日 Seedance 模式表列有 standalone last_frame，但同页说明写“不提供单尾帧生成”。这是官网内部冲突，不作为已确认的服务行为或现有代码缺陷。
- 直接把新文档喂给当前编译器会将 mov 暴露给用户，然而 WWW 查询/下载接收仍要求 video/mp4。编译器缺少对产品已支持输入/输出范围的显式交集门禁；同步应先审查支持边界与合同版本，不应盲目替换 JSON。此项是已离线确认的重新编译风险，当前源码尚未暴露 MOV。

因此，“同步一下 Schema”只能处理部分字段漂移，不能修复上述未知语义、提示词前缀规则、对象组合约束、透明通道和前置文件限制。

## 验证、来源与费用

本轮实际 Vitest：参数校验、实体、输入缓冲、WWW 适配器、视频特征路径 5 文件 96/96；素材读取器另 1 文件 3/3。Node/UI 两文件 9/9。共 8 个不同文件、108 项通过，0 失败/跳过。没有新增产品测试。247 个审计边界检查单列，不加到产品回归数量；前轮 H3 的 310 项不重复累计。

离线脚本 `docs/evidence/video-parameter-audit-20261020/inspect.cjs` 使用当前 TS/TSX 源码，Node 中仅将 Vite 的 import.meta.env 开发性能探针关闭；参数投影、校验、适配器与读取器逻辑未替换。所有 HTTP transport 和凭证为合成夹具，确认后立即取消；产品源码指纹前后一致。合成 PNG 与项目登记仅在 Git 忽略的 outputs/video-parameter-audit-20261020 下。两个开发期运行器问题如实保留：初次导入 UI 性能探针时 Node 不支持残留 import.meta；一次误将昨日输出格式也假设为 mp4/mov，进一步核对原始 HTML/Hash 后确认昨日为 mp4，修正证据断言。它们不是产品测试失败。

公开资料在 2026-10-20T09:28:23.943Z–09:28:37.510Z 读取，9/9 HTTP 200。仅 GET 以下公开 URL，无认证、项目资料、提示词或附件外发；完整时间与 SHA-256 在机器证据中：

| 型号 | 官方网关页面 |
| --- | --- |
| MiniMax-H3 | https://www.unicompapi.com/docs/models/MiniMax-H3 |
| Seedance | https://www.unicompapi.com/docs/models/doubao-seedance-2-0-260128 |
| HappyHorse t2v | https://www.unicompapi.com/docs/models/happyhorse-1.1-t2v |
| HappyHorse i2v | https://www.unicompapi.com/docs/models/happyhorse-1.1-i2v |
| HappyHorse r2v | https://www.unicompapi.com/docs/models/happyhorse-1.1-r2v |
| Wan | https://www.unicompapi.com/docs/models/wan3.0-video |
| WanAli | https://www.unicompapi.com/docs/models/wan3.0-video-ali |
| WanPrimeAli | https://www.unicompapi.com/docs/models/wan3.0-video-prime-ali |
| HappyHorse 编辑 | https://www.unicompapi.com/docs/models/happyhorse-1.0-video-edit |

本轮真实凭证读取、用户项目读取、真实上传/quote/收费生成/结算均为 0，模型费用 0。未重启应用、未运行生产构建/全仓门禁/真实 Renderer UI 或 macOS 实机验收。离线通过不代表真实服务恢复。

机器证据见 [inspection.json](../evidence/video-parameter-audit-20261020/inspection.json) 与 [validation.json](../evidence/video-parameter-audit-20261020/validation.json)。原始公开 HTML/来源摘要、完整 Vitest 输出和合成文件在 outputs/video-parameter-audit-20261020，生产代码未改。

## 未完成项与建议顺序

五项当前缺陷仍待修复。先修 H3 unknown 语义与已知空参拒绝，并接通前轮已发现的脱敏诊断；再补统一的请求对象/条件合同，修正提示词、素材属性与实际读取范围；最后补业务反例回归、任务实际参数快照及同步版本门禁。官网 H3 完整 generate 必填/枚举/范围与 Seedance last_frame 冲突仍属外部合同缺口，应单独取得可靠证据，不用猜测掩盖。
