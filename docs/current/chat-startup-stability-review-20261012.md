# 会话启动、页面恢复与持久化审查（2026-10-12）

本轮继续 `feature/office-agent-thread-model-convergence`，检查点 `78718ed`；`develop = origin/develop = d863d3f`，进入审查时工作区干净。依据负责人当前维护决策、AGENTS.md、PLANS.md 顶部维护事实和当前源码；历史阶段标签不覆盖源码。范围为 ChatPage、现有 Thread Read Adapter/Agent Runtime 接线、Response Lifecycle/Repository 和定向测试，不重建执行系统、不修改真实用户项目、不发起收费 Provider 请求。

## 今天现场与时间线

截图显示新对话欢迎页、输入草稿仍在、`正在准备回复…` 和停止按钮。`renderer-trace.log` 最后更新于 10 月 10 日，仅能确认源码有显式 trace 开关，不能断言当天停写原因。今天的证据来自 `application.log` 和项目内已持久化 Response Execution、Production Trace、Document Runtime、Agent Run、Work 数据，只输出安全字段和数量。

对应执行 `response-execution-7faf306f-d346-4469-a84b-830709d6ec87`，会话 `conversation-38f57364-9165-4229-8043-a43c0ff64cff`。以下为北京时间：

| 时间 | 持久事实 | 判断 |
|---|---|---|
| 14:42:07.659 | `execution_created` | 后端已创建执行 |
| 14:42:33.092 | `stream_started` | 创建后约 25.4 秒开始流；HTTP 200 只表示收到响应头 |
| 14:43:22 | 第一笔生成工具结果 failed | 已调用生成工具，不能解释为模型没有调用 |
| 14:43:59 | 第二笔 `generate_pptx` started | 同一执行内再次生成；缺少第一笔具体校验诊断，不能判为已完成 Work 重复生成 |
| 14:44:05—14:44:09 | Art Direction 请求/HTTP 200 | 尚未代表完整结果 |
| 14:45:09—14:46:06 | Art Direction 增量后 cancelled | 只形成约 302 字符，不足以归因于 Provider 或本地持久化其中之一 |
| 14:46:12 | fallback compile | 进入后续编译/检查 |
| 14:46:56 | 工具超时，`childElapsedMs=180055`、`parentElapsedMs=293299` | 工具上限约 180 秒；父执行仍约剩 66.7 秒 |
| 14:46:57.259 | `stream_failed:newapi.tool_loop_unknown_result` | 结果未知，不能自动重发 |
| 14:47:00 | compile completed | 晚到编译事实不等于正式发布/登记 |
| 14:47:17—14:47:25 | Agent/Document Runtime 为 `needs_reconciliation` | 工具记录 unknown、Observation 为空；此后未新增正式 Work |

此前普通回复也出现创建→开始约 24—26 秒，首段正文约 45—60 秒后才到达，完整回复约 11—12 分钟。网络请求日志的 `elapsedMs` 不是端到端流式耗时。没有清空、重放或核对关闭现场任务；未知结果继续由现有门禁冻结。

## 问题、修复和剩余边界

| 优先级 | 问题与实际触发 | 本批处理 |
|---|---|---|
| P1 | Agent start 等 IPC 返回后才绑定会话，启动阶段没有按 command 订阅进度；欢迎页和草稿长期不变 | 共用 Workflow/Agent command 进度订阅；首个持久事件后快读绑定会话和已接受 User Item，保留草稿直到接受/停止结果；不等待完整 Legacy 终态读取 |
| P1 | React 渲染前 Enter+点击触发两次，生成不同 command id | 同步 startup ref 拦截；修复前定向测试观察到两次真实 JSX handler 调用，修复后一次 |
| P1 | Thread 切页返回只恢复消息；Summary/Page 不含 parent/session，因此澄清、授权、核对和停止订阅消失 | 已有 `getThread` DTO 接入现有 Runtime/Completion Journal；后台恢复控制状态和 active execution，继续使用 Thread Items 作为正文来源；项目切换/过期异步返回守卫 |
| P1 | 每个 stream append 先分别 get/listEvents，再全量校验写入；每个 execution 又扫描全部 events | 改用一次 committed snapshot；按 execution id 分组校验，保留孤儿/重复身份/重试/连续序列/原子 CAS/备份校验 |
| P1 | 共享 `project-metadata.json` 达 33,773,845 bytes，Provider acceptance value 约 31,024,683 bytes | 已实测并记录；未改变存储格式或删除历史。Agent Session/Completion 更新仍共享大文件，需要后续拆分和一致性/迁移门禁 |
| P1 | 工具预算耗尽后仍有晚到 compile；最终 unknown 无正式 Work | 保留 unknown 门禁；剩余需用离线迟到工具结果用例量化取消传播与诊断，不能靠延长超时或再发真实生成掩盖 |
| P2 | Provider operation 文件约 29.4 MB，25 条记录中大记录达 3.5 MB；13 个 base64 结果值共约 29.34 MB | 会放大 acceptance/metadata；后续应把结果持久引用和恢复收据分离，保留完整结果与 Hash，不原地裁剪用户数据 |
| P2 | Trace、Legacy Assistant、Thread Projection 仍重复持久写入；模型与主线程间缺少阶段耗时证据 | Trace 分组/批量治理及无敏感内容耗时观测仍待处理；本轮不能宣称稳定帧率或完整消除实际等待 |

Thread Runtime 读取复用现有恢复和权限边界，作为后台操作不阻塞 Item 首屏。它仍可能受到共享元数据和 Completion inspect 的读取成本影响；后端写门禁始终保留。临时进度 User/Assistant 属于显示投影，不作为模型历史或正式 Work 来源。Agent 启动快读仍是现有 Legacy 兼容 DTO；剩余直接写入与事实读取见 [统一接线审计](office-agent-convergence-audit-20261012.md)，Thread 唯一会话事实源尚未全面达成。

## 本地性能证据

新增 `scripts/verify-chat-history-persistence.cjs`：隔离合成 165 个 execution/22,037 个 event/7,103 个 trace event，不读用户目录；比较 `78718ed` 实现和本批实现，保持原子落盘和备份。每组 5 次，单机样本不设硬件相关的测试阈值。

| 指标 | 原实现中位数 | 本批中位数 |
|---|---:|---:|
| Response document 纯校验 | 101.9 ms | 73.2 ms |
| 一次 content append（两次读→一次快照、全量原子写/备份） | 457.6 ms | 247.5 ms |
| Trace append（仍未优化，简化合成 trace） | — | 13.3 ms |

单次 append 约减少 46%，不是整条生成链路减少 46%。基准未包含生产 Thread/Legacy callback、canonical WAL、多文件队列、杀毒软件或真实 Provider 时延。原子写完整 JSON 的开销仍存在。机器证据：[持久化合成基准](../evidence/chat-history-persistence-20261012.json)。

用户数据只读测量另得：33.8 MB metadata 单次读/JSON/校验约 48/31/39 ms、45/39/35 ms、49/27/34 ms；Response document（8.7 MB）当前验证约 95—104 ms。此证据没有改变真实文件，也没有基于时间戳推算全部等待来自磁盘。

## 验证与后续

ChatPage、Thread Adapter、Lifecycle、取消、Runtime、Continuation、Completion Journal、Trace、Batcher 共 159 项定向测试通过，UI 合同 27/27；类型检查、lint、生产构建通过。ChatPage 新增 5 个失败复现先红后绿，覆盖启动、重复提交、澄清/未知恢复与 active execution 的真实卸载重挂。Repository 另覆盖并发晚到追加拒绝、Legacy 无 snapshot fallback、孤儿事件和非法重试。

真实 Electron Thread/Legacy 各 3 会话 × 120 消息，连续 3 次切页返回、会话切换和更早分页通过。真实 Electron/preload/IPC + Mock Transport 普通响应、取消、PPT Tool/Artifact、Word/Excel 物理文件登记和 `getThread` Runtime controls 通过。Mock 脚本的窗口不加载 React 页面，因此启动 JSX 行为由 ChatPage handler 测试覆盖；两者不冒称完整真实外部 Provider UI 验收。

Legacy Electron 切页门禁本轮曾有一次末条内容等待超时，首轮没有保留足够现场，不能断言为产品缺陷或测试测量原因。脚本已增加失败时选中会话、滚动几何和虚拟行的合成诊断；复跑通过，保留偶发风险，不把复跑覆盖成首轮无失败。

下一批应先隔离量化共享 acceptance/metadata 与 canonical event 持久写放大，再补 Art Direction/文档工具迟到取消场景及用户可读失败诊断，最后继续统一接线审计剩余 Legacy/Capability 调用方。本轮收费请求 0、未知结果自动重试 0；未重启用户运行中的应用，保留源分支和用户数据。
