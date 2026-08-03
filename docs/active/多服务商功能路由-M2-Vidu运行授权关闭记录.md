# 多服务商功能路由 M2｜Vidu 运行授权关闭记录

日期：2026-08-03

分支：`feature/vidu-runtime-authorization-closure`

执行基线：`develop@3f419bf`

实现提交：`b2e6d94`

验收方式：项目负责人授权 Codex 按冻结门禁自行验收；全部条件通过后允许非快进合并 `develop`。

## 一、批准边界

本分支只修改 Vidu 旧验证通道、Electron Vidu composition、受控 IPC 错误合同、相关测试和工程记录。未修改 React 页面、页面样式、preload、通用 `RuntimeAccessPolicy`、Provider Package/Registry/Feature 合同、服务商协议适配器或阶段 10 文件。

本分支禁止联网、读取真实凭证和收费调用，费用上限为 0。Vidu `q3-lite` 图片与 `viduq3-turbo` 视频预算继续封存，Image V1 未验证事实不变。

## 二、实际实现

- 新增 Vidu 专用运行授权关闭闸门与 `runtime_authorization_closed` 错误，不提前实现通用运行授权策略；
- live-validation IPC 在进入应用服务、读取凭证或执行 credits 连接验证前硬拒绝，旧流程 8 不能重新启动；
- Electron 图片与视频 submit 在 live-validation、路由器和受控 HTTP 之前调用同一硬闸门；
- 移除 `status=passed` 与 `CapabilityEvidence=system_observed` 的自动放行分支，历史验证结果只保留能力事实语义；
- 图片/视频提交返回明确、不可重试的提交前失败；未改动已接受 operation 的 query、cancel 和结果接收路径；
- 共享 IPC 增加安全、无凭证的关闭错误码；renderer 仍只收到受控错误，不暴露 Token、远端标识、URL、路径或 Hash。

## 三、验证结果

- `npm.cmd test`：Node 179 项、Vitest 396 项，共 575 项通过，0 失败、0 跳过；
- `npm.cmd run typecheck`：通过；
- `npm.cmd run lint`：通过；
- `npm.cmd run build`：通过；
- `npm.cmd run audit:platform`：224 个生产侧文件，0 违规；
- `npm.cmd run verify:handoff`：50 个校验项、27 个资源，0 失败；
- `npm.cmd run verify:recovery-audit`：16 个恢复用例、9 类故障、7 个域、5 条不变量和 17 个证据引用通过，安全违规与禁止制品均为 0；
- `npm.cmd run verify:runtime-integrations`：Windows x64 Electron、通知、快捷键、代理、电源与开发态 FFmpeg 集成通过；
- `npm.cmd run verify:secure-storage`：安全存储可用，持久化明文为 false；
- Windows Electron 隔离用户目录烟测：新增 4 个进程、4/4 响应、1 个可见窗口，正常关闭后残留 0，隔离目录已删除；
- `git diff --check` 与敏感信息差异扫描：通过。

专项测试证明：验证启动时 credits 校验调用数为 0；图片与视频 submit 的关闭闸门均位于路由调用之前；运行授权关闭时模拟 HTTP 调用数为 0；历史 `passed + system_observed` 不再获得新提交权限；预算重复 claim 继续返回 `billable_attempt_exhausted`。

本次未读取真实凭证，未访问 Vidu 或其他真实服务商，未产生收费请求，费用为 0。

## 四、未包含项

- 未实现通用 `RuntimeAccessPolicy`、授权账本、claim、过期、nonce 或最具体拒绝规则；
- 未实现 Provider Package、Connection、Registry、Feature、Context、Usage、RouteSnapshot、文本流式或提交编排合同；
- 未修改供应商页、快速页、专业创作页、任务中心或其他 UI；
- 未创建安装包、签名、公证、生产更新、SBOM 或生产媒体分发制品；
- macOS 实机与媒体工具链继续保持 `not_run/deferred`。

## 五、验收结论

本分支满足批准范围和合并条件，自验收结论为 `passed`，允许非快进合并 `develop`。合并后立即停止，不自动启动 `feature/provider-package-connection-contracts`；M2 第二支仍需项目负责人单独批准。
