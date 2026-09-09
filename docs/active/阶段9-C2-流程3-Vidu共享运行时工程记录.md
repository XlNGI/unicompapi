# 阶段 9 C2 流程 3｜Vidu 共享安全运行时工程记录

日期：2026-07-29

状态：实现和分支门禁已完成，等待连续授权下提交、推送与非快进合并 `develop`

分支：`feature/vidu-runtime`

基线：`develop@701562472d25917735fbc548aa69ecc567a1c92d`

## 一、允许范围

本流程只建立 Vidu 服务商包骨架、共享安全运行时、主进程凭证回调边界、受控 HTTP transport 契约、连接验证端口和合成测试。未修改 Electron 组合根、preload、生成页面或真实适配器；未访问真实 Vidu。

## 二、实际修改

1. 新增唯一 `ViduProviderPackage`，内部创建共享 `ViduSharedRuntime` 与 `ViduConnectionValidationPort`；两个同步图片适配器和视频适配器继续留在后续独立流程。
2. Token 只能由 `SecureCredentialVault.useValue` 的主进程回调取用，并仅在调用受控 transport 时组成 Authorization 头；运行时 API、日志和异常消息不返回 Token、路径、签名 URL、Hash 或响应正文。
3. 受控 HTTP transport 请求包含固定方法、HTTPS URL、手工重定向策略、代理模式、超时、取消 signal、请求/响应字节上限；renderer 不参与 transport 构造或 channel 选择。
4. 运行时验证 Vidu provider/connection、协议绑定、固定基础 origin、协议路径白名单、HTTPS、无 URL 用户信息和无 fragment。连接或协议不一致、非 HTTPS、跨 origin 或跨协议路径都会在 transport 调用前失败，且不静默切换 endpoint、协议或模型。
5. 实现请求超时、外部取消、运行时退出时取消在途请求、响应长度限制、302/3xx 拒绝，以及 401/403/429/5xx、网络、代理、超时和取消的稳定脱敏错误映射。
6. 代理仅由主进程受控 `ProxyMode` 注入 transport；本流程不新增 renderer 代理设置，也不读取代理凭证。
7. `ViduConnectionValidationPort` 只请求 `/ent/v2/credits`，不读取或返回余额、账户或费用正文；合成结果仅更新可用性、身份与凭证状态。

## 三、自动化验证

- `npm test`：Node 157 项、Vitest 345 项，合计 502 项通过，0 失败、0 跳过；
- `npm run typecheck`：通过；
- `npm run lint`：通过；
- `npm run build`：通过；
- `npm run audit:platform`：扫描 207 个文件，0 违规；
- `npm run verify:handoff`：50 个 checksum 条目、27 个资产，0 失败；
- `git diff --check`：通过。

新增定向测试覆盖 Token 脱敏、白名单与跨协议零 transport 调用、受控代理/超时/取消/退出、重定向和响应上限、429 退避事实、连接验证，以及缺失凭证和低层网络错误的稳定安全映射。测试只使用内存合成 transport；真实 Vidu HTTP 调用、真实 Token 读取和收费请求均为 0。未修改 Electron/preload 或页面，因此无需 Electron 烟测。

## 四、未完成项与风险

- 运行时定义受控 transport 边界；实际 Electron `net`/session transport 的组合根注入属于流程 6；
- Image2 鉴权格式仍未确认，继续保持 `unknown`，不得据此推断 Token 格式；
- 两个同步图片协议适配器、Q3 视频协议适配器、结果下载/探测/原子落盘/Work 登记和页面接线尚未实现；
- 冻结模型仍 disabled，能力证据仍为 `declared_supported`，不是实际调用授权。

## 五、下一步

提交并推送本功能分支，非快进合并并复验最新 `develop`。只有合并后才能创建 `feature/vidu-image-adapters`，实现两个同步图片协议适配器；仍不得启动 Q3 视频、应用接线、真实联网或收费验证。
