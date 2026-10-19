# 模型适配与 WWW 合同绑定审计

2026-10-19。当前属于维护审计，基线为 `e29b7a8`，工作目录为负责人实际启动目录，分支为 `feature/dev-startup-recovery-20261019`。范围是模型发现、合同目录、绑定管理、功能配置、启用、候选与适配器接线；本轮未实施业务修复。

## 结论与实际覆盖

负责人所担心的未绑定情况确实存在。本机 `www.unicompapi.com` 当前连接目录中有 52 个模型，9 个已绑定 WWW 视频合同，43 个没有活动功能配置或 API 合同。不能把“模型已同步到列表”理解为“已适配”，也不能把 43 个未绑定项全部认定为应当开放的产品能力。

| 本机当前状态 | 数量 | 核对结果 |
| --- | ---: | --- |
| 已绑定 WWW 视频合同 | 9 | 均为 declared，合同指纹和连接/凭证版本 pin 全部匹配 |
| 未绑定，但已有精确型号官方文本合同候选 | 6 | 临时配置副本中，后端绑定及文本候选生成均成功；管理界面却过滤掉这些合同 |
| 未绑定，本地无精确型号来源合同候选 | 37 | 需要核实资料、网关协议和产品范围，不能猜测绑定相邻型号 |
| 合计 | 52 | 仅为本机已保存目录快照，未请求网站最新模型目录 |

9 个已绑定视频型号为 `MiniMax-H3`、`happyhorse-1.1-i2v`、`happyhorse-1.1-r2v`、`happyhorse-1.1-t2v`、`happyhorse-1.0-video-edit`、`wan3.0-video`、`wan3.0-video-ali`、`wan3.0-video-prime-ali`、`doubao-seedance-2-0-260128`。当前只有 `MiniMax-H3` 启用，另外 8 个处于停用；停用和未绑定是不同状态。没有证据推定停用的原因，也没有更改这些状态。合同绑定不代表这些型号已全部真实验收通过，10 月 15 日的预算与未知原单边界继续保留。

## 发现一：WWW 合同选择器阻断已有文本合同绑定（P1）

[ModelContractBinding.tsx:23](../../src/pages/providers/ModelContractBinding.tsx#L23) 对 WWW 包只保留 `authority === 'relay'` 且型号精确匹配的合同；所有 `model_vendor` 文本合同被排除。当前网关合同目录只有九个视频型号，因此另外 43 个模型的界面合同列表为空，绑定按钮没有可选合同。

后端 [provider-management-framework.ts:503](../../src/platform/providers/provider-management-framework.ts#L503) 实际发布了厂商文本合同和 WWW 视频合同；[文本绑定分支](../../src/platform/providers/provider-management-framework.ts#L537) 接受 WWW 的 `newapi.chat` 协议绑定。前后端范围不一致。

以下六个模型在临时配置副本中均通过真实 Host `bindModelApiContract` 产生 declared 配置，并生成一个 `text_chat` 候选，`bindingAvailable` 与 `featureSupported` 为 true。没有调用网关，未证明真实协议兼容；停用模型在绑定后仍需正常启用。

| 精确模型键 | 本地官方合同候选 |
| --- | --- |
| `deepseek-v4-flash` | `official.deepseek.v4.chat` |
| `glm-4.6` | `official.zhipu.glm-4.6.chat` |
| `glm-4.7` | `official.zhipu.glm-4.7.chat` |
| `glm-5.2` | `official.zhipu.glm-5.2.chat` |
| `kimi-k2.6` | `official.moonshot.kimi-k2.6.chat` |
| `kimi-k3` | `official.moonshot.kimi-k3.chat` |

建议让合同候选同时考虑连接发布的适配器、合同适用功能与兼容声明。保留 WWW 视频合同的精确连接/型号限制，为已确认兼容的文本合同恢复入口，不因模型名称相同自动宣称已验证。

## 发现二：启用成功不代表存在可执行功能配置（P2）

[默认文本配置入口](../../src/platform/providers/provider-management-framework.ts#L2173) 对 WWW 直接返回；图像路由因没有 WWW image adapter 跳过，视频路由只识别九个精确视频合同。[assertModelRoutableForEnable](../../src/platform/providers/provider-management-framework.ts#L2146) 又仅在模型已有 `activeProfileId` 时核对配置状态，因此无配置模型仍可以成功启用。[界面](../../src/pages/providers/ProviderManageView.tsx#L445) 随后显示“已启用”。

临时配置副本复现：

- `deepseek-v4-flash`：`setModelEnabled` 返回 enabled，运行现有初始化后仍无活动配置，文本候选为 0。
- `qwen-image-2.0`：同样返回 enabled，初始化后仍无活动配置，图片候选为 0。

目前实际快照中的 43 个未绑定项仍是停用，本轮没有把副本中的启用结果写回用户配置。候选门禁保留，因此本轮没有发现这一状态会放行无合同请求；其影响是管理界面成功提示与业务可用性脱节。

建议把“已同步 / 待适配 / 已绑定 / 已启用 / 已实测”准确区分；启用时如没有可执行配置，应明确返回待适配原因，或先进入合同确认流程。

## 覆盖缺口：WWW 图片与其他型号需要补协议或来源，不能只补绑定

[WWW 服务包](../../src/platform/providers/newapi/unicompapi-contracts.ts#L121) 只发布 `newapi.chat`、`newapi.video`，没有 image adapter。[管理合同目录](../../src/platform/providers/provider-management-framework.ts#L504) 也只开放官方 `.chat` 合同与九个 WWW 视频合同，没有统一开放官方图片/视频绑定。因此 `qwen-image-2.0/2.0-pro/3.0/3.0-pro`、`doubao-seedream-5-0-pro-260628` 需要核对 WWW 的实际图片提交、结果与费用协议，并完成适配器接线；仅增加下拉选项无法完成适配。

剩余 37 个无精确来源候选的完整名单保存在机器证据中。其中特别包括旧版/新版本文本型号，以及 embedding、reranker、OCR 名称的目录项；本轮未联网确认其实际能力。目录项不应自动获得对话或生成能力，后几类也不能未经产品范围核对就当作聊天模型绑定。

当前适配体系仍包含两类生产路径：新文本合同绑定和 WWW 精确视频合同路径，以及既有固定功能表/旧 ModelFeatureProfile 路径。[unicompapi-model-capabilities.ts:366](../../src/platform/providers/newapi/unicompapi-model-capabilities.ts#L366) 的旧站功能表只适用于无 WWW 的包，不能直接用于修复 WWW；例如旧站 Qwen 图片与 Seedream 模型键也不等于本机 WWW 的新型号键。当前没有对任意新发现模型自动完成“来源核对、协议兼容、绑定、执行验收”的通用逻辑。

## 验证、修改和边界

本轮实际执行 5 个相关 Vitest 文件，共 91/91 通过，0 失败、0 跳过：WWW 视频 37 项、管理框架 15 项、官方合同 11 项、候选 12 项、参数兼容 16 项。这些现有测试通过不代表上述缺口已修复，且没有覆盖实际 WWW 合同选择器的文本入口。

另执行 8 个离线 Host 场景：文本无配置启用 1 个、六个精确文本合同绑定 6 个、无 image adapter 的图片模型启用 1 个。仅操作操作系统临时目录中的配置副本，结束后清理；真实注册表前后 SHA-256 一致，22 份审计源码/脚本 Hash 一致。没有读取凭证库或用户项目，未执行远端模型发现、公开资料请求、真实模型调用或收费生成，未重启应用。

首次离线加载器的两次运行因 CommonJS 优先解析同名 JSON、未加载 TypeScript 导出而失败；已修正为优先解析工作区 `.ts` 源码，与应用编译的解析方式一致。该问题属于审计运行器，未记为产品绑定故障。最终离线运行全部通过，原始失败说明保存在机器记录中。

只新增本审计说明、脱敏证据和 `PLANS.md` 顶部登记。现有 `vite.config.ts` 与启动恢复记录保持；未修改业务源码、真实模型配置、依赖清单或锁文件，未提交、合并、推送或发布。本轮没有重新构建、运行全量产品回归、实际 Electron 界面或 macOS 验收，不复用历史结果冒充本轮验证。

下一步建议先修复 WWW 文本合同选择入口和无配置启用状态，并补相应界面/Host 回归；随后核对六个已有来源文本合同的网关兼容声明，再按产品范围补充剩余型号及 WWW 图片协议。所有待修项在本轮结束时仍保持未修复。

证据：[脱敏清单与离线复现](../evidence/model-adaptation-audit-20261019/inspection.json)、[原始回归结果](../evidence/model-adaptation-audit-20261019/regression.json)、[可复核的离线审计脚本](../evidence/model-adaptation-audit-20261019/inspect.cjs)。复现命令为 `node docs/evidence/model-adaptation-audit-20261019/inspect.cjs`；该脚本会重新读取届时的本机配置快照并覆盖本目录审计 JSON，模型目录变化时断言可能需要相应调整。
