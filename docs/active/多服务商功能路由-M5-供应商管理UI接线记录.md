# 多服务商功能路由 M5｜供应商管理 UI 接线记录

日期：2026-08-03

分支：`feature/ui-provider-management-wiring`

来源：`develop@957e710`

实现提交：`8d845a9`

## 一、范围与边界

本支只完成 M5 第一支供应商管理 UI 后置接线：官方/兼容连接入口、结构化凭证写入与轮换、连接验证动作、模型目录同步、精确手工模型登记，以及连接/模型启停和本地软删除。

页面只消费已合并的安全 Registry、Package Template 和 `ProviderManagementFramework` 端口。真实在线管理 Adapter 未获专项批准，因此 Electron 组合明确安装空 `ProviderManagementAdapterRegistry`；验证和目录同步在 UI 中显示但禁用，不发起真实 HTTP，不读取或验证真实凭证，不产生收费调用。本支未启动后续 M5 分支、阶段 10、macOS 实机或媒体工具链；阶段 9 权威方案原件保持只读。

## 二、实际实现

- Provider IPC、preload 和 renderer 公共面统一为 `listTemplates/createConnection/rotateCredential/validateConnection/syncModelCatalog/registerExactModel/setConnectionEnabled/setModelEnabled/deleteConnection`，旧任意 Provider/Connection 创建、任意能力写入、路由偏好和凭证读取入口不再暴露。
- Electron 组合 DeepSeek、Volcengine、Kling、NewAPI、Vidu 五个精确 Package；管理 Adapter Registry 保持为空，模板动作以 `requires_live_api_approval` 或 `unsupported` 安全投影，不会因按钮点击触发真实网络。
- 供应商页面由 Package Template 驱动官方/兼容入口、Base URL 模式和结构化 CredentialSchema 字段；凭证只写入本机安全存储，renderer 不提供读取、复制、解密或回显 API。
- Registry 安全 DTO 增加 Package/Template ownership、活动 Profile 状态和 ProductFeature 投影；页面不按服务商名、模型名、协议或 Usage 路径分支。
- 模型目录只提供精确目录同步或 `manual_exact` 登记；没有已验证 Profile 的模型不能通过后台门禁进入候选，页面不伪造能力成功。
- 从 renderer、preload 和 Provider IPC 移除 Vidu 流程 8 收费验证启动入口；历史关闭控制器所需状态 DTO 收回 controller 本地，运行授权关闭保持不变。
- 补齐 UI 静态合同、跨页合同和管理框架测试，覆盖有 Adapter、等待真实 API 专项批准、手工精确登记和不支持四种动作状态。

## 三、验证结果

- `npm.cmd test`：Node 179 项与 Vitest 562 项，共 741 项通过，0 失败、0 跳过；
- `npm.cmd run typecheck`：通过；
- `npm.cmd run lint`：通过；
- `npm.cmd run build`：通过，Vite 87 个模块完成生产构建；
- `npm.cmd run audit:platform`：扫描 280 个文件，0 违规；
- `npm.cmd run verify:handoff`：50 项 checksum、27 个权威资源通过；
- `npm.cmd run verify:recovery-audit`：`passed`，安全违规 0、禁止制品 0；
- `npm.cmd run verify:phase9-closeout`：Windows 九类必需套件保持 `passed`，macOS 保持 deferred；
- `npm.cmd run verify:secure-storage`：Windows x64 可用，明文未持久化；
- `npm.cmd run verify:runtime-integrations`：通过；
- `git diff --check`：通过。

浏览器只读可见检查覆盖 `1440x900` 和 Electron 冻结最小窗口 `1080x720`：供应商页无横向溢出，标题、操作区、状态提示和空状态不重叠；无 preload 环境保持诚实禁用。Windows 生产 Electron 隔离烟测新增 4 个进程、4/4 响应、1 个可见 `UniComp` 窗口，正常关闭后残留 0；隔离用户目录已移入回收站。

真实服务商 HTTP 0 次、真实 DNS 0 次、真实凭证读取/验证 0 次、收费调用 0 次、费用 0。Vidu 已用尽预算未恢复，Image V1 未晋级。

## 四、结论与下一步

自验收结论：`passed`。允许推送并非快进合并 `develop`，本地与远程功能分支继续保留。

合并后从最新 `develop` 创建 M5 第二支 `feature/ui-conversation-context-wiring`，只把对话和项目上下文 UI 接到已合并的候选选择令牌、不可变上下文快照和文本提交/流式端口；不得把对话页改成图片或视频直接生成入口，不得访问真实服务商、真实凭证或启动阶段 10。
