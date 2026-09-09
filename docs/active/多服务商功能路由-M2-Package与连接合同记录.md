# 多服务商功能路由 M2｜Package 与连接合同记录

日期：2026-08-03

分支：`feature/provider-package-connection-contracts`

执行基线：`develop@975ef82`

实现提交：`44e2ce1`

验收方式：项目负责人授权 Codex 按冻结门禁自行验收；全部条件通过后允许非快进合并 `develop`，并按既定顺序继续托管执行阶段 10 之前的 M2—M6 计划。

## 一、批准边界

本分支只修改 Provider Package、模板、Adapter、CredentialSchema、EndpointPolicy、Provider/Connection 持久化合同、结构化安全凭证、原子连接保存服务、相关测试和工程记录。未修改 Electron、preload、React 页面、协议适配器实现、真实服务商运行时或阶段 10 文件。

本分支禁止真实服务商 HTTP、真实凭证读取、凭证验证和收费调用。Vidu `q3-lite` 图片与 `viduq3-turbo` 视频预算继续封存，Image V1 未验证事实不变。

## 二、实际实现

- 新增版本化 `ProviderPackageDescriptor`，明确 `official | compatible_custom` 模板、Package/Template/Adapter/Protocol 精确归属和允许操作；
- 新增安全模板 DTO，只向 renderer 投影显示字段、Base URL 模式、凭证字段元数据、免费验证标记和模型发现类型，不暴露 endpoint 模板、adapter/protocol、凭证引用或内部策略 ID；
- 新增版本化 `CredentialSchema` 与结构化加密凭证记录；Vault 继续兼容旧字符串载荷，并将解密值限制在主进程回调内；
- 新增版本化 `EndpointPolicy`，校验协议、主机、端口、路径前缀、重定向、代理、回环、私网、显式回环 HTTP 确认和 DNS 重绑定策略；禁止 URL 用户信息、查询串和 fragment；
- 新增 `ProviderConnectionContractService`，在写凭证前完成请求白名单、包/模板归属、endpoint 和凭证字段校验；凭证写入后若 Registry 发布失败，执行补偿删除，避免孤立新秘密；
- Provider 与 Connection 持久化 package/template、策略版本、配置版本、凭证版本和精确 adapter/protocol binding；Registry 读取时校验连接归属一致性；
- 关闭旧任意 Provider/Connection 创建和 endpoint 修改能力，未接入新管理框架前返回 `adapter_unavailable`；
- 拒绝任意 REST 字段、协议自动识别、未知 JSON 透传、显示名或模型名推断以及失败后的静默服务商切换。

## 三、验证结果

- `npm.cmd test`：Node 179 项、Vitest 405 项，共 584 项通过，0 失败、0 跳过；
- `npm.cmd run typecheck`：通过；
- `npm.cmd run lint`：通过；
- `npm.cmd run build`：通过；
- `npm.cmd run audit:platform`：227 个生产侧文件，0 违规；
- `npm.cmd run verify:handoff`：通过；
- `npm.cmd run verify:recovery-audit`：通过；
- `npm.cmd run verify:runtime-integrations`：通过；
- `npm.cmd run verify:secure-storage`：通过；
- `npm.cmd run verify:phase9-closeout`：通过，阶段 9 关闭事实未被本分支改写；
- `git diff --check` 与生产敏感信息差异扫描：通过。

专项测试证明：包/模板/adapter/protocol 不匹配在 Vault 和 transport 之前失败；官方 endpoint 不能覆盖；非法协议、主机、端口、路径、回环、私网、凭证字段和任意请求字段被拒绝；Registry 保存失败后新凭证被删除；安全 DTO 与错误结果不包含秘密或内部路由信息；合成测试中的 `fetch` 调用数为 0。

本分支没有修改 Electron、preload 或 UI，因此不触发 Windows 可见 Electron 烟测要求。本次真实 HTTP 为 0，真实凭证读取为 0，收费调用为 0，费用为 0。

## 四、未包含项

- 未实现 Registry revision、目录状态、Model Definition/Profile 精确匹配和模型启停；
- 未实现通用 `RuntimeAccessPolicy`、ProductFeature、Context、Invocation/Usage、RouteSnapshot、文本流式、候选令牌、提交编排或历史迁移；
- 未实现 Provider 管理 UI、真实协议适配器或真实服务商验证；
- 未创建安装包、签名、公证、生产更新、SBOM 或生产媒体分发制品；
- macOS 实机与媒体工具链继续保持 `not_run/deferred`，不声明 macOS 已支持；
- 阶段 10 未启动。

## 五、验收结论

本分支满足批准范围和合并条件，自验收结论为 `passed`，允许非快进合并 `develop`。合并后从最新 `develop` 创建 `feature/provider-registry-atomic-catalog`；依照项目负责人 2026-08-03 最新授权，无需中途手工确认，但仍必须独立分支、完整验收、推送、非快进合并并保留本地与远程分支。
