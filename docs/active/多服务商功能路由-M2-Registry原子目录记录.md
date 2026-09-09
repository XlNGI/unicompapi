# 多服务商功能路由 M2｜Registry 原子目录记录

日期：2026-08-03

分支：`feature/provider-registry-atomic-catalog`

执行基线：`develop@1dc653c`

实现提交：`d2688f9`

验收方式：项目负责人授权 Codex 按冻结门禁自行验收；全部条件通过后允许非快进合并 `develop`，并按既定顺序继续托管执行阶段 10 之前的 M2—M6 计划。

## 一、批准边界

本分支只修改 Provider Registry 的 revision/CAS/原子 mutation、目录状态、Model Definition/Profile 合同、模型启停与目录同步并发路径、相关 Vidu 兼容写入、共享 DTO、测试和工程记录。未修改 React 页面、preload、Electron UI、通用 RuntimeAccessPolicy、真实协议适配器或阶段 10 文件。

本分支禁止真实服务商 HTTP、真实凭证读取、凭证验证和收费调用。Vidu `q3-lite` 图片与 `viduq3-turbo` 视频预算继续封存，Image V1 未验证事实不变。

## 二、实际实现

- Registry 快照增加单调 `registryRevision`；`save` 使用期望 revision/CAS，冲突返回 `ProviderRegistryConflictError`，并复用项目共享绝对路径写入协调器，覆盖多个 Store 实例；
- 新增同一写队列内读取最新快照、执行 mutator、校验领域不变量和原子落盘的 `JsonProviderRegistryStore.mutate`，避免控制器 `load -> 修改 -> save` 覆盖并发更新；
- ProviderModel 增加 `present | missing | retired` 目录状态、目录 revision、`lastSeenAt` 和活动 Profile 引用；目录同步保留消失模型、强制退出启用状态并阻止其进入候选；同步失败不会覆盖上次成功目录；
- 新增 `ProviderModelDefinition`、`ModelFeatureProfileTemplate` 和 `ModelFeatureProfile` 持久化合同；Profile 只能由精确 `providerModelKey`、Package 归属、Adapter/Protocol Binding 和已注册模板实例化；未知名称、相似名称或错误 Binding 不会生成 Profile；
- Profile 初始状态固定为 `declared`，只有 `verified` Profile 才能进入路由候选；`enabled`、目录 `present` 或单独 Evidence 不再替代 Profile；
- 连接验证、模型目录同步、手工模型登记、能力验证、用户能力记录、路由偏好和模型/连接启停改用最新快照 mutation；并发操作不丢更新；
- 调整 Vidu 合成验证在 Registry 写入后重新读取最新快照，保持新 revision/CAS 合同兼容；未恢复流程 8，也未发起真实调用。

## 三、验证结果

- `npm.cmd test`：Node 179 项、Vitest 409 项，共 588 项通过，0 失败、0 跳过；
- `npm.cmd run typecheck`：通过；
- `npm.cmd run lint`：通过；
- `npm.cmd run build`：通过；
- `npm.cmd run audit:platform`：229 个生产侧文件，0 违规；
- `npm.cmd run verify:handoff`：50 个校验项、27 个资源，0 失败；
- `npm.cmd run verify:recovery-audit`：16 个恢复用例、9 类故障、7 个域、5 条不变量和 17 个证据引用通过，安全违规与禁止制品均为 0；
- `npm.cmd run verify:runtime-integrations`：Windows x64 Electron、通知、快捷键、代理、电源与开发态 FFmpeg 集成通过；
- `npm.cmd run verify:secure-storage`：安全存储可用，持久化明文为 false；
- `npm.cmd run verify:phase9-closeout`：通过，Windows 必需目标保持通过，macOS 保持延期；
- `git diff --check`：通过。

专项测试证明：跨 Store 实例的 stale save 在 HTTP 前返回 revision conflict；并发 mutation 保留两个独立更新；目录模型消失后变为 `missing` 并禁用；`missing/retired` 模型不能重新启用；错误 Model Definition、模板或 Protocol Binding 不会生成 Profile；`declared` Profile 不进入候选，升级为 `verified` 后才可进入候选；Profile、Evidence、Binding 和 Provider Package 引用保持一致。

本分支没有修改 Electron、preload 或 React 页面，因此不触发新增可见 Electron 烟测要求。真实 HTTP 为 0，真实凭证读取为 0，收费调用为 0，费用为 0。

## 四、未包含项

- 未实现通用 `RuntimeAccessPolicy`、授权账本、claim、过期和 nonce；
- 未实现 ProductFeature/ParameterSchema V2、Context、Invocation/Usage、RouteSnapshot、文本流式、候选选择令牌、提交编排或历史迁移；
- 未实现真实 Provider 管理 UI 或真实协议适配器；
- 未创建安装包、签名、公证、生产更新、SBOM 或生产媒体分发制品；
- macOS 实机与媒体工具链继续保持 `not_run/deferred`，不声明 macOS 已支持；
- 阶段 10 未启动。

## 五、验收结论

本分支满足批准范围和合并条件，自验收结论为 `passed`，允许非快进合并 `develop`。合并后从最新 `develop` 创建 `feature/provider-runtime-authorization-contracts`；依照项目负责人 2026-08-03 最新授权，无需中途手工确认，但仍必须独立分支、完整验收、推送、非快进合并并保留本地与远程分支。
