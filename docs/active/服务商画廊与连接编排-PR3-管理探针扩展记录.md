# 服务商画廊与连接编排 PR 3｜管理探针扩展工程记录

日期：2026-08-05

分支：`feature/provider-management-probes-expansion`（自 `develop` 建立，含 PR 2 合并 `c05f4d4`）

权威计划：`docs/active/服务商画廊与连接编排分阶段实施计划.md`（项目负责人 2026-08-05 批准并授权连续托管）。

## 一、本支范围

只做 PR 3「火山、可灵管理探针侦察与实现，Vidu deferred 策略定案」。不含路由动态化与 Vidu 拉平（PR 4）、执行收敛（PR 5）。真实收费调用 0 次、真实凭证读取 0 次、真实服务商 HTTP 0 次（全部合成 transport 测试）。

## 二、侦察结论与决策

| 供应商 | 决策 | 证据 |
| --- | --- | --- |
| 可灵 Kling | `account_probe`：官方免费端点 `GET /v1/account/costs`，鉴权为 AccessKey + SecretKey 铸造 JWT（HS256，claims `iss`/`exp`/`nbf`） | 可灵开放平台官方文档；鉴权机制与现模板单一 `api_key` 不兼容，凭证模式必须升级 |
| 火山引擎 ARK | 保持 `deferred`：控制面 `ListFoundationModels` 需 AK/SK HMAC 签名，与模板存的 ARK API Key 不兼容；推理端点无免费模型列表 | 火山方舟官方文档与实际调用报错反馈 |
| Vidu | 保持 `deferred`：模板本就 `freeConnectionValidation: false`、`modelDiscoveryKind: 'none'`；q3-lite 与 viduq3-turbo 预算已用尽，任何验证不得触发生成接口 | 阶段 9 验收记录与预算状态 |

## 三、实现内容

1. `src/platform/providers/kling/kling-contracts.ts`：凭证模式由单一 `api_key` 升级为 `access_key` + `secret_key` 双字段（`credential.kling.ak-sk`，均 `secret: true`）；视频适配器 `operations` 增加 `validate_connection`；官方模板 `freeConnectionValidation: true`。
2. `src/platform/providers/kling/kling-runtime.ts`：`parseCredential` 重写为解析 AK/SK 对（`KlingCredentialPair`）；新增 `mintKlingApiToken`（`node:crypto` HMAC-SHA256 铸造 JWT）；`requestOfficialApi` 改用 JWT `Authorization: Bearer`；新增 `requestAccountCosts`（`GET /v1/account/costs`）与 `validateManagementConnection` 管理侧校验（允许 `saved` 草稿态、拒绝 `disabled`/`deleted`，同 DeepSeek 宽松策略）；`KlingSafeLogEvent` 操作集增加 `account_costs`。
3. `src/platform/providers/kling/kling-video-adapter.ts`：新增 `KlingManagementAdapter`（实现 `ProviderManagementAdapterPort`），`validateConnection` 走账户探针并做错误映射——HTTP 401 与业务码 1000/1001/1002 → `credentialState: 'invalid'` + `authentication_failed`；业务码 1102 → `credentialState: 'valid'` + `account_unavailable`；网络/协议/信封异常 → `verification_unavailable`。新增 `KlingAccountCostsError` 业务码异常与信封解析助手。
4. `electron/ipc/management-adapters.ts`：组合 `KlingSharedRuntime` + `ElectronKlingHttpTransport`（`net.fetch` 模式，与 DeepSeek/NewAPI 一致）并注册 `KlingManagementAdapter`。
5. 测试：`tests/platform/kling-management-probe.test.ts`（新增 9 项：JWT 结构与签名、成功映射、各类 HTTP/业务码/网络错误映射、协议守卫、畸形信封、日志无 AK/SK 泄漏）；`tests/platform/provider-probe-decisions.test.ts`（新增 3 项：模板 `validationAction`/`modelDiscoveryAction` 决策钉住；可灵编排走探针且不拉目录；火山/Vidu 延迟保存且零适配器调用）；`kling-video-adapter.test.ts` 凭证夹具升级为 AK/SK、操作清单断言更新；`provider-ipc-contract.test.mjs` 增加管理适配器组合注册断言（三个管理适配器实例化 + 三个 Electron transport + 无明文密钥模式）。

## 四、验收结果

- `npm test`：Node 200 项 + Vitest 601 项（115 文件），共 801 项通过，0 失败、0 跳过。
- `npm run typecheck`：通过（src + tests 双工程）。
- `npm run lint`：ESLint 0 问题。
- `npm run build`：渲染端 + Electron 生产构建通过。
- `npm run audit:platform`：0 违规。
- `npm run verify:handoff`：50 校验项、27 资源，0 失败。
- `npm run verify:recovery-audit`：0 违禁、0 违规。
- `git diff --check`：通过。
- 生产 Electron 烟测（一次性脚本、隔离 userData、生产构建，用完即删）：12 秒存活、4 进程 4/4 响应、「UniComp」窗口、优雅关闭退出码 0、进程残留 0、stdout/stderr 全空。

## 五、安全与费用边界

- 真实服务商 HTTP/DNS 0 次、真实凭证读取/验证 0 次、收费调用 0 次、费用 0。
- AK/SK 只写不回显；JWT 在主进程内即时铸造、不落盘；安全日志新增操作不含任何密钥材料（泄漏回归断言 `not.toMatch(/probe-sk|probe-ak/)`）。
- 凭证模式升级为破坏性变更：旧 `api_key` 凭证记录在新模式下解析会报 `credential_mismatch` 并标记 `invalid`，用户需在管理视图重新录入 AK/SK（阶段 9 仅测试数据，无真实用户数据迁移负担）。
- 可灵视频提交/查询既有路径与官方最新合同存在差异（侦察发现），因无真实预算验证，本次不对齐，留待后续真实预算窗口处理；不影响本支管理探针独立性。

## 六、未完成项与下一步

- PR 4：创作路由动态化、Vidu 冻结种子与联调脚手架退役、老数据迁移。
- PR 5（可选）：OpenAI 兼容执行套件收敛，待 PR 4 收口后由项目负责人决策。
- 可灵视频路径合同对齐：待真实预算窗口。
