# 讨论转生成与请求发送：只读定位

2026-10-17。负责人本轮要求解释系统意图识别与发送行为；范围为当前截图会话、本地执行记录和相关源码，不进行业务修复。依据当前维护事实、AGENTS.md、PLANS.md 和源码；不读取历史归档或修改权威 UI 原件。

## 已核实结果

第一条用户消息“我现在要制作一个ppt，先讨论内容”按讨论处理，写文件限制符合该句含义。第二条“随便生成吧，现在是测试”在本地又被判定为 chat，独立语义分类器没有被调用；真正的回复模型只有普通回答能力，没有可用文档工具。回复“我选人工智能发展趋势生成演示 PPT”并不对应实际生成操作。

两个 Workflow 均为 kind=chat/status=completed；根任务的规划提交边界均为 not_started。第二次 Agent WAL 记录 1 个模型调用、messageCount=9、toolCount=0，返回 finishReason=stop、contentLength=70、toolCallCount=0，registeredWorkIds 为空；Document Runtime 为 planning/paused，step=0。项目 files 目录为空，没有正式 PPT。

## 原因链

1. ChatPage 的普通发送进入 startAgentResponse，经主进程 startAgent/startCommand 接入 ConversationAgentContinuationRuntime。
2. chat-context-runtime 中另一个 Workflow 服务配置了 agent_first，但 continuation 实际使用的构造器仍指定 local_compat。本地判定不是 unknown 就直接返回，不调用分类器。
3. 当前语义上下文的 recentUserMessages 来自当前根任务的固定输入引用。两条消息各建一个根任务，第二次分类上下文只包含本句，没有包含前面尚未交付的 PPT 意图；完整对话仍会在最终回复请求中组装，二者覆盖范围不一致。
4. 第二句没有 PPT/文档等名词，也未命中既有本地明确创建/不完整操作模式，所以判为 chat。工具准入又独立运行 conversationDefersDocumentWrites：它只接受若干固定的“开始生成吧”等句式，或带文档名词/特定“现在生成”等措辞的请求。“随便生成吧，现在是测试”不匹配这些分支，继续继承第一句的讨论限制。
5. 工具授权最终输出 0 个可用定义。回复模型看到了前两条历史与当前请求，输出了生成承诺，服务按普通文本 stop 终结；没有开始工具或文件生成。可见回复体现了生成意图，但不足以推断模型内部判断过程。

相关位置：conversation-agent-continuations.ts 构造器及 semanticContext；conversation-intent-orchestrator.ts 本地返回；conversation-document-brief.ts 的 conversationDefersDocumentWrites；conversation-document-tool-session.ts 的 generationAllowed 与 createGenerationSession。

## 点击发送时的实际行为

先固定项目、会话、消息版本及客户端命令，保存用户消息并创建受控根任务；检查输入与当前范围，然后由本地兼容规则生成 Workflow。接着确定模型候选、执行授权、文档工具能力和剩余预算，组装系统说明、对话历史、当前用户消息及所选资料，创建执行记录后外发。

第二次只发出了 1 个模型请求，使用界面所选 kimi-k3。持久 WAL 的消息数为 9；按当前 AgentContextAssembler/ConversationResponseArtifactFactory 代码重建，是 6 条系统说明和 3 条对话消息：前一条用户消息、上一条模型回复、本句。数量与 WAL 吻合，没有选择的项目上下文或附件，也没有提供文档工具。完整 HTTP 原文未留存，因此此处是持久摘要加当前组包重建，不声称抓取了原始报文，不展示内部提示词。

收到 70 字后写入正文，标记响应流完成并结算 chat Workflow。“已完成”表示模型响应接收完毕；准备校验、序列化、发送和响应事件会产生多条进度记录，不能据显示次数认定多次 HTTP 请求。写文档 count=0 也是校验结果，不代表执行过写入。

## 本轮验证与边界

Thread 权威正文与 Legacy 投影一致；两个输入离线复现均为 local/chat，分类器调用 0，discussion deferral 均为 true。检查涉及的用户文件前后 SHA-256 一致。未修改业务代码或用户任务，未读取凭证、调用真实服务、联网搜索或产生新费用。没有本轮构建、全量测试或已修复结论；初次只读脚本漏传 projectId 被仓储范围校验拒绝，补齐后检查通过，未放宽任何范围校验。

后续修复应让实际入口结合完整且有来源的对话语义更新任务阶段，再由应用层检查权限/范围/预算，工具层执行；应让“允许你自行确定主题并开始生成”能够覆盖旧讨论状态，同时继续拒绝“先讨论/暂不生成”。模型的最终交付说法还应与工具结果及正式 Work 登记保持一致。这是系统接线和多轮准入缺陷，不应要求用户背诵某个固定句式。

机器检查见 [inspection.json](../evidence/conversation-intent-explanation-20261017/inspection.json)。
