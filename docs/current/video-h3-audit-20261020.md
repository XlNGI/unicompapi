# 视频生成业务与 WWW MiniMax-H3 故障审计

> 本文保留修复前审计快照；后续实现、验收和剩余边界见[修复记录](video-parameter-repair-20261020.md)。

2026-10-20，维护审计。依据负责人本轮要求、AGENTS.md、PLANS.md 顶部维护记录、当前源码和 WWW 当日公开文档。基线为 develop@1142611913cb5f68efe053571d156348a5b9d8a9，审计记录分支为 feature/video-h3-audit-20261020。修改范围仅为本记录、脱敏机器证据和 PLANS.md；未修改业务代码、测试、模型绑定、用户草稿或原任务。未覆盖权威交接原件，未提交、合并或推送。

## 结论

今天四次 MiniMax-H3 失败均发生在报价阶段，WWW 返回 HTTP 400 / invalid_h3_parameters。当前 H3 revision 3 将文档中未知的字段必填状态投影为可选且省略使用服务商默认，允许整个 parameters 为空；实际网关拒绝空对象。使用同一现有连接、官网公开示例提示词，空参数报价再次得到同样错误；填写文档示例的五个参数则 HTTP 200、closed_reasons=[]、报价 7,040,000 CNY_MICRO，即 7.04 元。

此次直接原因是 H3 参数完整性与实际网关不匹配。当天模型已启用、目录存在、WWW 连接 available / 凭证 valid，绑定为当前合同 revision 3；正在运行的主进程与构建均为今天 16:03，因此不能沿用昨天“重启加载旧接收修复”的解释。本轮未收费生成，成功报价只证明该参数组合通过当时报价校验，不能扩展为真实生成与交付验收通过。

## 审计发现

### P1：H3 未知参数要求被作为可直接使用的默认值

位置：src/platform/providers/newapi/www-video-contracts.ts:48–49；www-video-catalog.json 的 H3 五字段。

H3 文档仅提供 generate 请求示例，没有完整的必填、枚举或范围表，catalog 保留 required=null 是真实的来源事实。但 Schema 编译器使用 documentedRequired===true，其余全部转成 required=false / omit_use_provider_default；这把“未知”转成了“允许不填且有服务商默认”的产品行为。用户保留空表单，快速视频和文生视频都会发送 parameters={} 并在报价时被拒绝。resolution、ratio 同时仅校验为任意字符串，没有示例值或可用范围帮助，填入任意字符串也会通过本地类型校验。

当日 16:04:53、16:05:05、16:11:20、16:15:06（Asia/Shanghai）均有 H3 报价拒绝记录、无远端任务 ID。四笔日志请求长度均为 102 字节；分别使用本地冻结的 finalPrompt 和生产序列化结构重建空参数报价，均精确为 102 字节，结合错误发生在 charge-capable submit 之前，印证了空参数路径。未读取或外发企业附件，证据不包含用户提示词。

建议：按实际报价证据阻止已知无效的空 H3 请求，提供来源清楚、用户可明确选择的已验证示例参数组合，并在缺完整协议时保留“未知”说明。不能仅凭这两次报价将五字段全部宣布为官方必填，也不能据此发明完整枚举或把示例值写成服务商固定默认。后续取得正式约束或单字段有界报价证据后，再更新合同与版本。

测试缺口：tests/platform/www-video.test.ts:13 和 :33 明确接受并提交空对象；tests/fixtures/www-video.ts:57 对所有 quote 直接返回预设成功报价，没有模拟本次真实 400。因此测试通过覆盖了合成生命周期，未证明空 H3 参数真实可用。应增加空参报价拒绝、参数补齐后重新报价和用户反馈回归，并保留取消后零收费提交的门禁。

### P2：报价错误被吞掉，仍提示已退役的报价上限

位置：src/platform/providers/newapi/www-video-adapter.ts:156；src/platform/ipc/video-feature-runtime.ts:662–663。

NewApiSharedRuntime 已生成脱敏 failureDiagnostic，包含 statusCode=400、code=invalid_h3_parameters、message=“请按所选H3动作填写参数，并使用本人素材或原任务”。但 WWW 适配器在 started=false 时丢弃原错误，返回统一英文 message，后续映射成 www_video.generation_not_submitted。应用最终显示“请检查报价上限和素材”，而人工报价上限昨天已删除；这也会掩盖同一位置的凭证、网络或服务异常。

本轮用生产编译适配器和合成 400 响应离线复现：原诊断消失，normalize 后只有上述通用 safeCode，外部请求为 0。四笔本地 invocation 事件同样只有通用 safeCode。

建议：在保留“尚未提交收费生成”的阶段事实时，传递已有脱敏诊断和机器错误码，区分报价/上传/收费提交，并删除退役上限文案。不要把原始响应或凭证直接显示给用户。

### P2：任务参数快照与动态参数发送来源不同

位置：src/platform/providers/video-draft-artifact-factory.ts:91、:136。

新 feature 路径实际发送 input.subject.parameterValues，来自 draft.featureSelection.parameterValues；Task 的 confirmation.parameters 却仍复制 draft.generation.parameters.values。两套参数可以不同，feature 控件的选择因此不会完整冻结进任务历史；接受记录也只持久化这个 Task 和路由，dispatchRequest 本身不保存。事后修改草稿后，历史无法准确还原当时的动态参数，影响问题复现、费用争议核对和审计。此次不能仅凭 task.video.parameters={} 就断言实际请求为空，必须另与生产请求长度和日志交叉核对。

建议：为任务保留与本次已校验投影一致、带 Schema/合同版本的不可变参数快照，兼容旧任务，并使用 feature 参数非空、旧参数不同的夹具验证历史和发送参数一致。不记录凭证或完整 HTTP 头。

## 视频业务链路核对

已核对快速视频、文生视频和图生视频/编辑的候选与参数来源、授权和提交、原 Key 报价确认、异步轮询、原单恢复以及本地接收。现有 WWW 链路包含精确合同与连接固定、受控素材与本地 Hash 校验、Host 确认原报价、单次幂等收费提交、未知提交仅原请求查询、原任务有界轮询，以及本地 MP4/元数据/Hash 检查后登记作品。

昨天已修复的 H3 对象结果、output_type=video 和共享 /v1/videos/:id/content 下载处理已在当前代码中保留；本轮对应回归通过。今天 H3 四笔均未进入轮询，不把这些下游修复当成本次参数拒绝的解释。另看到当日两笔 HappyHorse t2v 和一笔 WanAli completed，WanPrime 另一笔在报价阶段 network_error；该网络失败单列，不归因于 H3 参数错误。

## 实际验证与外发事实

| 验证 | 本轮结果 |
| --- | --- |
| 第一组：WWW、绑定、路由、控制器、恢复、接收、提交桥 | 实际 7 文件、116/116 |
| 第二组：NewAPI Runtime/适配器、Electron 受控传输、参数投影、视频合同/生命周期、MiniMax/Vidu/旧 Studio H3 | 9 文件、194/194 |
| 合计 | 16 个不同文件、310/310，0 失败、0 跳过 |
| 本地离线诊断丢失复现 | 确认；外部请求 0 |
| 公共资料读取 | GET https://www.unicompapi.com/docs/models/MiniMax-H3，2026-10-20T08:32:10.617Z；HTTP 200；不带凭证或项目资料 |
| 有界实时报价 | 两次 POST /v1/h3/tasks，严格限定 operation=quote / action=generate / MiniMax-H3；2026-10-20T08:34:04.418Z 完成；现有 Key 只在加密库回调内使用 |
| 报价输入 | 官网公开示例提示词；一次 parameters={}，一次 resolution=2K、ratio=16:9、duration=4、generate_audio=true、watermark=false |
| 费用与状态 | 收费生成 POST=0、结算 POST=0、本轮模型费用=0；报价前后真实注册表 Hash 一致；未登记或恢复作品 |

第一组命令包含一个不存在的 newapi-runtime.test.ts 过滤项，不能算成第八个文件；实际 Runtime 覆盖位于第二组真实执行的 newapi-provider-package.test.ts。报告汇总按 Vitest JSON 中实际执行的文件计数。未新增测试，也未将既有绿色用例冒充缺陷修复验收。初次证据汇总脚本误从 platform 导出调用 domain 校验器而失败，纠正导入后成功；不计作业务或测试失败。

详细脱敏记录、当日失败事件、原请求长度交叉核对、官网响应 Hash、实时报价、离线复现、测试文件与源码 Hash 见 [机器证据](../evidence/video-h3-audit-20261020/validation.json)。原始公开 HTML、完整 Vitest JSON 和本地诊断脚本位于 Git 忽略的 outputs/video-h3-audit-20261020；未保存凭证明文。

## 未完成项与下一步

三项审计发现仍未实施修复。推荐先处理 H3 参数完整性与报价诊断，再补动态参数历史快照和相应业务回归。现有页面可手工填写上述官网示例的五个参数以尝试重新报价；金额以每次原 Key 新报价为准，仍需用户确认后才能收费提交。

本轮未新发收费生成、未自动结算、未重新恢复原视频、未重跑全仓测试/类型检查/lint/生产构建或真实 Renderer UI 验收，也未进行 macOS 实机验收。官网完整 generate Schema 仍未知，不能声称任意参数组合或真实生成均已通过。所有这些边界均保留为未验证事项。
