# 自主设计未在当前应用生效的只读诊断

日期：2026-10-14。负责人反馈生成的 PPT 仍使用旧模板。范围：当前应用启动目录、源码/编译产物、新实现分支及最近一份正式 PPT 的持久设计/QA 记录。未修改用户项目、未重试 Provider、未重启应用或合并分支。

## 已确认原因

1. 当前应用的真实 renderer `--app-path` 指向原工作区，所在分支为 `feature/chat-progress-summary@4692337`。该工作区源码与 `dist-electron` 编译产物没有 `designTree`、`requireDesignTree` 或 `planExecutablePresentationDesign`。自主设计代码实际保留在另一个管理工作树的 `feature/llm-autonomous-design@3ff8ab8`，上轮没有合入当前运行工作区。
2. 最近正式 PPT 的候选记录为 `designPath=legacy-fallback`、`fallbackReason=art_direction_invalid`，诊断为 `art_direction_timeout`，Art Direction 与 Design IR 均为 invalid，layout/render plan 均 skipped；没有 Design IR 或 Production Layout IR。该 PPT 实际生成 10 页。
3. 同一次会话的 Art Direction 记录从 `2026-10-14T15:25:22.844Z` 到 `2026-10-14T15:27:23.052Z`，历时约 120.208 秒，随后记录设计回退。候选 QA 为 passed，正式文件状态 available，实际字节 SHA-256 与 File/QA 收据一致。QA 通过证明旧路径文件通过本地检查，不证明 LLM 设计被执行。

## 源码对应

当前旧 `DocumentGenerationRunner` 在规划失败时保留 invalid 状态并继续生成；`office-document-generator` 的 `fallbackReasonFor` 将失败转为旧渲染路径。新分支默认要求自主设计树，规划超时/无效会报告 `presentation-design-rejected` 并拒绝正式发布；显式兼容模式才保留旧回退行为。新分支的该门禁没有加载到当前进程。

## 处理建议与边界

先把已验收的三个自主设计提交整合到用户实际启动应用的工作区，保留当前聊天界面/复制/输入区的未提交修改，再重建主进程并正常重启。单独重启原目录仍会加载原目录的旧源码；仅重新生成也不会加载另一工作树的实现。

新门禁生效后，设计超时会明确失败，不再把旧模板文件作为自主设计成功。真实 Provider 为何在时限内没有交付完整设计尚未进一步确定；可能需要在明确授权与预算下结合脱敏请求/响应时序评测。本轮没有联网检索、读取凭证或发起新的收费请求。

诊断仅保存去正文、去路径的运行/状态事实：[机器记录](../evidence/autonomous-design-active-workspace-diagnosis-20261014.json)。未把真实 PPT 正文、用户项目绝对路径、凭证或原始模型响应复制进工程记录。
