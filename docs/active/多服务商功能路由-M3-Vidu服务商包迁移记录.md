# 多服务商功能路由 M3｜Vidu 服务商包迁移记录

日期：2026-08-03

分支：`feature/vidu-provider-package-migration`

来源：`develop@99583cf`

实现提交：`f7f4cc6`

## 一、范围

本支只把阶段 9 C2 已有的 `ViduProviderPackage`、三个协议适配器和冻结模型目录迁移到通用 Provider Package、Model Definition/Profile、ParameterSchema V2、UsageSchema 与 RouteSnapshot 合同。

未修改 React UI 或 preload，未启动 M4、M5、阶段 10、macOS 实机与媒体工具链；未恢复流程 8、未访问真实 Vidu、未读取或验证真实凭证、未产生收费请求。Vidu Image V1 的鉴权和 `images` 结构仍未验证，继续在 HTTP 前禁用。

## 二、实际实现

- 新增单一官方 Vidu Package，冻结结构化 Token CredentialSchema、固定 `https://api.vidu.cn` EndpointPolicy 和 Image V1、Gemini Image V2、Reference Video V2 三个精确 Adapter/Protocol；
- 为 10 个冻结模型生成精确 Model Definition、Profile 与 ParameterSchema V2，不按模型名称猜测新能力，不登记未确认的价格、数量或输出规格；
- Image V1 Profile 固定为 `disabled`；Gemini 图片与 Q3 视频 Profile 默认 `restricted`，流程 8 历史证据不自动转化为正式运行授权；
- Vidu UsageSchema 不伪造计费指标，终态只记录空事实的 `not_reported`，未知提交记录 `unknown_outcome`；
- Registry 迁移幂等补齐旧 Provider/Connection 的 Package ownership、连接合同、Definition/Profile，同时保留连接状态、身份状态、凭证引用和既有能力证据；重复执行不增加 Registry revision；
- 新增 RouteSnapshot 薄适配层，提交、查询、取消与结果接收都精确校验原 Package、Adapter、Connection revision/config、Credential version、Model revision、Profile、Binding 和 Schema，不读取当前默认连接或回退版本；
- 图片结果在重启后必须显式 `attachResult`，视频 operation 必须显式 `attachOperation`，不得把远端结果或 operation 重新绑定到其他路由；
- 共享 transport 合同要求 `dnsRebindingProtection=required`；M4 继续验收生产 transport 的实际 DNS 解析和重绑定防护；
- Electron 旧 Vidu 提交、查询、取消和结果接收共五条网络入口全部硬关闭，新 RouteSnapshot 适配器未提前接入 UI/IPC；
- 移除依赖 `protocolBindings[0]` 的隐含顺序，改为按冻结的 Reference Video V2 binding ID 精确查找。

## 三、验证结果

- Vidu 迁移专项：4 项通过；Vidu/Registry 相关专项：43 项通过；旧 Electron 网络入口静态合同：4 项通过；
- `npm.cmd test`：Node 179 项与 Vitest 546 项，共 725 项通过，0 失败、0 跳过；
- `npm.cmd run typecheck`：通过；
- `npm.cmd run lint`：通过；
- `npm.cmd run build`：通过；
- `npm.cmd run audit:platform`：扫描 277 个文件，0 违规；
- `npm.cmd run verify:handoff`：50 条 checksum、27 个权威资源通过；
- `npm.cmd run verify:recovery-audit`：`passed`，安全违规 0、禁止制品 0；
- `npm.cmd run verify:phase9-closeout`：Windows 九类必需套件保持 `passed`，macOS 继续 deferred；
- `npm.cmd run verify:secure-storage`：Windows x64 可用，明文未持久化；
- `npm.cmd run verify:runtime-integrations`：运行时集成和开发态 FFmpeg 8.1.2 通过；
- Windows 生产 Electron 隔离烟测：新增 4 个进程、4/4 响应、1 个可见 `UniComp` 窗口，正常关闭后残留 0；隔离目录已移入回收站；
- `git diff --check`：通过；Vidu 范围敏感值扫描未发现真实凭证。

所有 Provider 响应均来自内存合成 transport。真实服务商数据面 HTTP 0 次、真实凭证读取/验证 0 次、收费调用 0 次、费用 0。

## 四、未完成与下一步

- 通用 RuntimeAccessPolicy、候选选择、提交编排、调用读模型与各 Provider Adapter 的统一组合尚未完成，进入 M4 `feature/provider-backend-integration-acceptance`；
- M4 必须用合成 transport 覆盖官方/兼容连接、模型/Profile、快速与专业输入投影、上下文快照、同步/异步/文本状态、取消、恢复与 Usage 完整性；
- 生产 transport 的 DNS 重绑定防护必须在 M4 证明，不能只依赖类型字段；
- UI 必须等待 M4 通过后再按六个独立 `feature/ui-*` 分支接线；
- Vidu Image V1 继续禁用，Gemini 图片与 Q3 视频继续等待新的正式运行授权；不得恢复真实预算或调用真实 Vidu。

自验收结论：`passed`，允许推送并非快进合并 `develop`；本地与远程功能分支继续保留。
