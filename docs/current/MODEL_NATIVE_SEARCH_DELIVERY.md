# 模型原生搜索接入与生产交付记录

日期：2026-09-11。属于独立维护任务，依据负责人“继续完成”、本次公开 API 文档读取授权、AGENTS.md 最新维护事实和对话式 PPT 总体计划。这里只记录原生搜索这一批实际交付；不把逐页 PPT 或全协议覆盖标为完成。

## 原因与实现

旧应用检索入口默认关闭，且与模型原生搜索是两条路径。原生工具未序列化到实际聊天请求，因此“需要联网”的语义本身不能触发模型搜索。

现增加独立原生搜索协议、精确模型 profile 能力声明、持久授权和执行事实记录，并接通 Renderer → preload → IPC → response draft → dispatch → provider adapter。没有扩展文档 function 白名单。官方 Kimi 文本模型启用原先还被两个媒体/文本 package 校验拦截，本批一并修复。

- 当前支持 Kimi builtin 与智谱 Chat Completions web_search 两个协议。NewAPI/UniCompAPI 网关必须在模型设置中声明实际透传协议并保存 HTTPS 文档依据；同名模型不会自动获得能力。声明支持与真实验证严格区分。
- 默认不联网。助手在会话中说明正文范围、当前服务商/模型、无法保证的搜索次数/域名/费用上限以及取消限制；精确回复“允许本次联网”或“允许本会话联网”后才可发送 native tools。单次问题有效 10 分钟，会话范围授权为一小时，可用“不要联网”撤销。
- 授权绑定 workflow/计划版本、连接/模型/profile/协议/凭证版本、正文及参数 Hash。引用同意、泛化“继续”、过期或模型变化不能授权。当前外发仅限当前任务正文与格式指令，不发送历史对话；含附件、项目上下文或页面读取的搜索请求先阻断。mixed 模式保留本地资料优先。
- Kimi 至多三次 HTTP 请求、最多四个工具调用，不自动重试或换服务。只接受 `$web_search`；保留供应方要求的 tool_call 与 reasoning 字段，但不展示内部推理。协议结果原样回送服务端；系统上下文始终把网页和工具结果视为不可信资料。
- 只把协议工具调用/引用字段当搜索证据，不把正文的“已搜索”或普通 URL 当证据。自动模式未检索时明确说明未获证据；必须搜索时无证据就失败。
- 保存 started/completed/unobserved/failed/cancelled、接收时间、来源、逐次 token 用量。搜索费用未报告，不能记零；Kimi search content tokens 不与已含它们的 prompt tokens 重复累加。来源未被应用另行抓取核实。取消/撤销后的晚到事件不能恢复授权；会话消息并发写入只对幂等本地投影最多重试三次，不重放付费请求。

## 官方公开依据与覆盖边界

2026-09-11 在明确授权后读取，未上传项目或企业资料：

| 协议 | 实际读取的公开文档 | 本批状态 |
| --- | --- | --- |
| Kimi builtin | https://platform.kimi.com/docs/guide/use-web-search.md | `builtin_function/$web_search`、tool 消息回送、reasoning 保留与 tokens 语义已核对，合成生产链路通过 |
| 智谱 | https://docs.bigmodel.cn/cn/guide/tools/web-search.md 和 https://docs.bigmodel.cn/api-reference/模型-api/对话补全.md | `tools.web_search`、默认 `search_std` 引擎、自动意图/强制字段与返回来源已核对，声明协议后的网关合成生产链路通过 |
| OpenAI Responses/搜索模型 | OpenAI 官方文档站返回 HTTP 403，包括 developers.openai.com/api/docs/guides/tools-web-search | 未取得可读依据，当前没有实现，不声称 GPT 已支持 |
| Gemini/Anthropic/其他网关协议 | 当前注册文本传输没有对应原生协议适配器 | 未实施；不能用上述工具格式冒充支持 |
| DeepSeek 当前接口 | 当前未配置原生搜索证据 | 保持未知，不把产品网页搜索能力当成 API 支持 |

智谱 search_std 是文档中的协议默认值，不是独立搜索服务商绑定，也不是价格或收费承诺。网关首页返回 New API 页面，不能证明具体模型透传能力。真实连接和所有模型的在线覆盖尚未验收。

## 验证与保留问题

- 独立工作树完整 Node/UI 356/356；全量 Vitest 209 文件 1544/1544。初次 UI select 契约失败已改用带明确无障碍名称的 RSuite；一次默认并发全量中七项文件密集用例超时，降低并发后原全量通过，不放宽断言或业务超时。
- 主工作区集成后完整 Vitest 209 文件 1545/1545（新增撤销晚到事件用例）；最后新增会话并发投影回归后，相关 16/16 通过。最后仅改动原生搜索 service 与其测试，没有重复宣称全量 1546 的单次执行。
- 主工作区 Node/UI 355/356；唯一失败为负责人此前删除 handoff/SHA256SUMS.txt 导致旧交接验收 ENOENT。独立完整工作树同项通过。62 项原有交接删除保持原样，没有恢复或夹带提交。
- 应用及测试类型检查、全仓 lint、生产构建和差异检查通过；完整工作树平台/交接/恢复/既有关闭门禁通过。已有 macOS 延期状态不变，未声明 macOS 实机通过。
- `validation/native-search-production.cjs` 用真实 dist/preload/IPC/Schema/授权/存储/生成器，只注入独立项目/userData 和合成 HTTP 响应，并阻断真实 HTTP。验证授权前 0 次模型请求；Kimi 两轮握手、GLM 一轮引用；授权/执行事实在会话可见、无历史或授权回复外发；搜索后实际生成并登记三页 PPTX，解压检查实际 slide 数。独立工作树与主工作区都通过。原“我要生成一个ppt”生产回归也通过，主题追问可见且模型请求为零。
- 初次生产授权后出现一次“本地保存失败”，未保留内部异常栈；随后七次独立重跑成功。针对搜索消息与生成状态并发写入的确实存在的竞态增加幂等重试和强制冲突回归；不能倒推初次异常原因已得到唯一证明。
- 所有模型/搜索响应均为合成运输层数据；仅使用隔离测试凭据，不读取真实密钥、不调用付费服务。这些结果证明实现链路，不能代替真实服务商验收。

本地结果和截图在主工作区 `tmp/native-e2e-*`、`.cache/ppt-live-fix/native-*`；公开协议原文缓存位于独立工作树 `tmp/native-search-docs/`，均不进入发布物。可复现命令：构建后以 Electron 运行 `validation/native-search-production.cjs`；`UNICOMP_TEST_NATIVE_PROTOCOL=glm` 验证 GLM，`UNICOMP_TEST_NATIVE_DOCUMENT=ppt` 验证 Kimi 搜索到 PPT 交付。脚本只操作自己的隔离目录。

## 交付与剩余任务

源码、测试和生产验收脚本已增量同步到主工作区，保留既有清理变更。生产构建与隔离验收完成，运行应用重启结果另记下方。功能分支保留，不推送或合并。

P4—P6 的 Deck/Page 稳定身份、制作中真实逐页预览、草稿页单独重做/锁定/重排和暂停恢复仍未实现。当前成功的三页生成沿用完整文档工作流，不是豆包式逐页制作验收。P1 全部状态回复持久化/outbox、其他原生协议及 P7 真实服务商调用也未关闭。下一批应独立实施页面任务与真正图像渲染，不用假预览或阶段动画替代。

运行交付（2026-09-11 09:00）：旧 PID 9572 已通过正常关闭退出；主工作区新构建 `index-Dof89821.js` 已启动，PID 7060、窗口 UniComp 正常响应，启动日志无错误。最终主工作区 Kimi→三页 PPT 生产复测通过，证据 `tmp/native-e2e-UUz1ig`；原有项目/作品保留。
