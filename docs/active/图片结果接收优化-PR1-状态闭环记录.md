# 图片结果接收优化 PR1｜状态闭环记录

日期：2026-08-28

分支：`feature/image-result-receipt-state-fix`

## 范围与边界

- 当前阶段仍为阶段 9 正式收口后专项，阶段 10 未启动。
- 依据最终 UI 与开发交接包 V1.2.1、`AGENTS.md`、`PLANS.md`、生成历史与任务中心既有验收记录执行。
- 仅修复同步图片远端完成后的本地结果接收状态与人工恢复资格；不修改服务商提交、模型路由、计费、凭证、本地作品门禁或发布流程。
- 验证不调用真实服务商、不读取凭证、不产生收费请求。

## 实际修改

1. 图片结果接收器把 `remote_completed` 纳入失败收口。结果描述读取或校验在下载前失败时，Execution 会登记为 `failed`，并保留 `failure.stage=remote_completed` 与真实 retryability，不再永久停留在远端完成状态。
2. 领域层集中新增 `canRecoverRemoteCompletedExecution`，统一约束可恢复的失败阶段为 `remote_completed/downloading/writing`，要求原 Provider Operation Record 仍存在且失败不是明确不可重试。
3. 图片功能恢复入口与全局任务读模型复用同一领域判定；恢复继续复用原 Task、Execution 与持久化结果引用，不重新提交生成。
4. 存量 JSON 不做破坏性迁移；原有 `remote_completed` 任务继续可从任务中心人工接收，新的早期失败则明确收口并按证据开放恢复入口。

## 验证结果

- 领域转换、结果接收器、全局任务读模型与跨运行时持久化恢复定向测试：23/23 通过。
- TypeScript 应用与测试类型检查：通过。
- 变更文件定向 ESLint：通过。
- 测试覆盖远端完成后的结果描述失败、失败阶段持久化、读模型恢复资格与应用重建后复用原结果完成 Work 登记。

## 未完成项与下一步

- PR2 将修正生成历史中 `remote_completed/downloading/writing/verifying` 的可见语义，避免统一显示“生成中”。
- PR3 将把即时图片结果端口从 Vidu 命名与运行时中解耦，并补安全接收事件日志。
- 全量测试、生产构建与 Windows Electron 收口在 PR3 完成后统一执行并登记。
