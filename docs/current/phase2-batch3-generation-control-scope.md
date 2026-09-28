# 第二阶段第三批：生成工具与运行控制范围

当前状态：`completed`（2026-09-28；第三批限定范围已收口，第四批 CRUD 未启动）。

2026-09-28 函数边界诊断补记：已通过合成 Host 状态的同步对照执行证明，旧 Bridge 在生成后新增 workId 时抛出 runtime_scope_mismatch，尚未进入 providerToolsFromContracts。当前工作树已有身份修复保留；首轮 generate_pptx、次轮 read_document_structure 的 Schema 投影均同步返回。此结论不依赖异步 Trace 队列。新的同步标记及跨项目/跨任务拒绝回归均纳入全量测试。详见 docs/evidence/phase2-batch3-available-tool-boundary.json。

此前真实报告的模型应更正为 deepseek-v4-flash；报告 passed 仅表明当前脚本通过，不能替代指定 kimi-k3 的真实文件读回及最终回答验收。当前缓存 Outline IR 和 answerUsesObservation 校验的限制尚未处理，本轮按负责人最新指令只结束诊断，不标记整个第三批完成。

上述诊断记录保留为过程事实。最终验收已由指定 `kimi-k3` 完成：从空隔离项目生成一份真实 PPTX，Runner/渲染 QA/Hash/Work 登记通过，同一 Runtime 重新读取物理页面并完成最终回答；详见 `docs/evidence/phase2-batch3-kimi-readback-real-provider.json`。

本批从安全点继续，上一批正确提交为 `3a373b8`（生产只读接线）和 `6b63a96`（验收记录）；独立 Runtime 身份修复提交为 `ba6f75d`。当前增量包含 Canonical `generate_pptx`、生成 Binding、真实文件读回 Session、Runner/QA 桥接、授权状态、动态 Loop 安全控制、Provider 安全结果 DTO 和回归测试。本批已完成真实验收，未进入 CRUD。

## 职责边界

| 角色 | 允许职责 | 明确不承担 |
| --- | --- | --- |
| LLM | 理解需求、判断信息是否足够、自然追问、请求生成确认、选择业务级工具参数 | 路径、凭证、权限、项目、revision、预算、沙箱、任意代码、正式发布 |
| 用户 | 明确点击开始生成；随时点击停止 | 直接操作内部 Runtime 状态或 Provider 参数 |
| Runtime | 授权、安全、权限、预算、沙箱、任务状态、取消、幂等、真实执行结果和审计 | 通过字段是否齐全判断需求是否充分；替 LLM 决定是否应该生成 |

Runtime 必须验证“本次生成授权是否有效”，但不能把参数完整性当作需求充分性判断。Schema、类型、长度和安全校验仍然属于 Application/Contract 门禁；它们只决定请求是否安全可执行，不决定用户需求是否已经足够。

## 自然交互规则

PPT 意图出现时，系统提示词应要求模型结合当前对话、上下文和已有资料判断信息是否足够：

1. 信息不足时自然追问，避免固定问卷、重复询问已有信息，并允许合理默认值。
2. 信息足够时先询问：“现在开始生成吗？”
3. 用户一开始明确说“直接生成”等同义表达时，视为本次生成授权，不重复询问。
4. 只有用户明确同意后，才允许模型请求 `generate_pptx`；用户未确认时不得生成。

这组规则必须作为系统提示词/生产请求的自然交互约束，同时通过授权状态防止模型绕过确认。

## 生成授权状态

Runtime 为每个生成任务保存轻量授权状态：

```text
not_requested → awaiting_user → approved
approved → revoked
awaiting_user → revoked
```

状态必须绑定 conversation、user message、task 和授权版本。`generate_pptx` 执行前再次验证 `approved`、项目范围、权限、预算和任务未取消；Runtime 不根据 `title/content` 是否齐全推断 `approved`。

## 取消语义

用户停止必须调用 `cancel(taskId)` 进入 Runtime，而不是向 LLM 发送“别生成了”。Runtime 至少执行：

- 标记 `cancel_requested`，触发 AbortController；
- 阻止新的 Tool Call；
- 阻止尚未启动的 Adapter；
- 将 AbortSignal 传入 Provider 请求和 `generate_pptx` 执行链；
- 在安全可取消点退出已启动操作；
- 记录取消 Trace、任务终态和真实 Artifact 状态；
- 取消和重试保持幂等。

必须覆盖三种时机：

| 时机 | 必须结果 |
| --- | --- |
| A. Tool Call 已准备，Adapter 尚未启动 | 不启动 Adapter，不产生文件，Loop 停止 |
| B. `generate_pptx` 执行中 | AbortSignal 到达 Runner/生成器的安全取消点，未发布时清理临时产物，Loop 停止 |
| C. Artifact 已真实写入完成 | 不撤销事实，不谎报未生成；停止后续 Loop，报告已完成 Artifact 和 Work |

## 生产 Loop 边界

本批不得用固定 `maxToolRounds` 作为业务完成条件。Loop 应由任务状态、工具结果、用户取消、授权、预算、超时、重复调用、无进展和未知结果保护驱动；状态已完成、等待用户、取消、失败或需要对账时停止。不得继续引入 `allowedToolNames`，Provider Schema 必须从 Canonical Contract 派生。

`generate_pptx` 只能看到业务参数，例如标题、内容、主题、模板和可选页数。Runtime 注入项目、输出目录、revision、authorization、AbortSignal、task/checkpoint 和真实执行上下文。底层 PptxGenJS 只能由 Platform Runner 调用。

## 幂等要求

生成幂等必须同时绑定 Canonical Tool Call/Runtime task 和业务输入指纹，复用现有 `DocumentGenerationRunner` 的本地 Work/File/Hash 校验。重试或重复 Tool Call 不得生成第二份 PPT；Artifact 已注册时返回已验证结果，并明确 `idempotent_replay`，不重复执行 Adapter。

## 必须新增的自动化验收

- 需求不足：LLM 追问，不广告或执行 `generate_pptx`。
- 信息足够但未确认：不生成、不启动 Adapter。
- 用户明确确认：动态 Available Tool Set 包含 `generate_pptx`，参数由 Canonical Contract 校验，Runner 完成真实 PPTX、结构/渲染 QA、Hash 和 Work 登记。
- 生成后继续读取：同一 Runtime 中由 `read_document_structure` 读取刚生成的 Artifact。
- 取消时机 A/B/C：分别覆盖未启动、执行中、Artifact 已写入后的行为。
- 生成授权状态、Runtime 边界、路径/Runtime 上下文不泄漏。
- 重复调用和重试只产生一个已验证 Work。
- `pnpm test`、`pnpm typecheck`、`pnpm lint`、`pnpm build` 全部通过。

## 真实 Provider 最小验收

真实 Provider 必须分别覆盖：需求不足不生成；需求足够但未确认不生成；用户确认后生成简单测试 PPT；生成后读取文档结构；生成中用户取消。报告必须包含工具可见性、授权状态、取消时机、真实 Artifact 状态、调用 ID 和泄漏检查，不记录凭证、路径、原始请求正文或完整文档内容。

完成本批后立即停止。CRUD、复杂 UI、暂停/恢复和第四批能力不属于本批。
