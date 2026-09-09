# 服务商画廊与连接编排 — PR4 创作路由动态化记录

- 分支：`feature/provider-dynamic-routing`
- 状态：已完成并通过全部门禁（待合并）
- 日期：2026-08-05

## 一、范围

按《服务商画廊与连接编排分阶段实施计划》PR4：

1. 创作路由动态化：候选由注册表能力 + 连接 `available` + 已启用模型决定，不再依赖任何写死连接/绑定。
2. 退役冻结 Vidu 播种（`ensureFrozenViduCatalog` 与 `emptySnapshot` 内置种子）。
3. 退役冻结记录工厂 `vidu-protocol-catalog.ts` 与 Vidu 联调脚手架（live-validation 四件套 + 运行时授权硬封锁）。
4. 老用户注册表迁移语义：既有 Vidu 连接作为普通用户连接原样保留，凭证引用不动，绝不补种缺失行。
5. 全新安装空注册表。
6. 运行时授权台账（Runtime Authorization Ledger）接管创作候选资格：连接 `available` → `interactive_allowed`，其余 → `blocked`。

## 二、实现

### 2.1 退役清单（删除）

- `src/platform/providers/vidu-protocol-catalog.ts`（冻结 ID 与 `createFrozenViduRegistryRecords`）
- `src/platform/providers/vidu/vidu-live-validation.ts`
- `src/platform/providers/vidu/vidu-live-validation-service.ts`
- `src/platform/providers/vidu/vidu-live-validation-controller.ts`
- `src/platform/providers/vidu/vidu-runtime-authorization-closure.ts`（`denyViduRuntimeAuthorization`）
- `tests/platform/vidu-live-validation.test.ts`
- `provider-registry.ts` 内 `ensureFrozenViduCatalog`、`mergeMissingFrozenViduRecords` 等合并助手
- `electron/main.ts` 启动时 `ensureFrozenViduCatalog()` 调用

### 2.2 全新安装空注册表

`emptySnapshot()` 现在返回真正全空的 v2 快照（providers/connections/protocolBindings/models/capabilities/routingPreferences/modelDefinitions/modelProfiles 均为空数组）。烟测验证：全新 userData 启动生产构建后不创建 `provider-registry.json`，注册表保持空。

### 2.3 动态视频操作上下文

`ViduReferenceVideoV2Adapter` 依赖从写死 `{ binding, connectionId }` 改为 `operationContext: ViduVideoOperationContextPort`：

- `submit` 接受任务后 `remember`（内存映射 taskId → {connectionId, binding}）；
- `query`/`cancel`/`receive_result` 经 `resolve(taskId)` 取上下文，取不到抛 `ViduVideoAdapterError('The Vidu video operation context is unavailable', 'unknown')`，不再回退到写死绑定；
- `vidu-composition.ts` 以 `RegistryVideoOperationContext` 实现端口：内存优先，重启后单候选注册表回退（同名适配器绑定唯一时才回退，多连接绝不乱猜）；
- `vidu-route-adapters.ts` legacy 路径同步改造。

### 2.4 运行时授权台账接线

- 新增 `electron/ipc/runtime-authorization-sync.ts`：`LedgerRuntimeAuthorizationSync` 实现 `ProviderRuntimeAuthorizationSyncPort`；`syncConnectionPolicy` 按连接态 upsert 策略（`available` → `interactive_allowed` 且允许 `submit/query/cancel/receive_result`，其余 → `blocked`），无变化时幂等跳过；`reconcileConnections` 供启动时对存量连接全量对账。
- `ProviderManagementFramework` 新增可选 `runtimeAuthorization` 依赖，`addConnection`/`validateConnection`/`setConnectionEnabled`/`deleteConnection` 成功后尽力同步（吞错不阻断管理主流程）。
- `electron/main.ts`：实例化 `RuntimeAuthorizationLedger`（`runtime-authorization-ledger.json`）与同步端口注入框架；`app.whenReady()` 内对注册表快照 `reconcileConnections`；台账作为 `ProviderCandidateRuntimeAuthorizationPort` 传入 `registerStorageIpcHandlers` 与 `registerChatContextIpcHandlers`。
- `storage-ipc.ts`/`chat-context-runtime.ts`/`chat-context-ipc.ts`：`RegistryFeatureCandidateSource` 的授权检查由「永远拒绝」桩改为可选真台账，缺省仍拒绝（fail-closed）。

### 2.5 测试迁移

- 新增 `tests/fixtures/vidu-user-registry.ts`：`createUserViduRegistryRecords`（原冻结工厂的测试专用副本，ID 字面值不变，保证老盘语义）。
- 全部 Vidu 测试改从夹具播种；`vidu-video-adapter`/`vidu-e2e-validation` 改用 `operationContext` 端口构造。
- `provider-registry.test.ts`：冻结目录断言改为「全新安装空注册表 + 只持久化用户记录」「既有用户 Vidu 行原样保留不补种」；四个依赖冻结种的拒绝类测试改用本地基线夹具。
- `provider-registry-catalog.test.ts`：两个 CAS 测试改自播种。
- `provider-management-framework.test.ts`：末段注入用户 Vidu 夹具行，继续钉住未注册包 `package_not_found`。
- `vidu-provider-package-migration.test.ts`：升级测试改为「旧行原样保留不补种」；`routeFixture` 自播种并显式链接 `activeProfileId`。
- `vidu-app-wiring-contract.test.mjs`：硬封锁五连断言改为台账门控断言（无 `denyViduRuntimeAuthorization`、无 `liveValidation`、无 `ensureFrozenViduCatalog`、台账两处注入、`reconcileConnections` 启动对账）。

## 三、验收

| 门禁 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过（含 electron tsconfig） |
| `npm run lint` | 通过 |
| Node 合同测试 | 200 通过 / 0 失败 |
| Vitest（domain+platform） | 593 通过 / 0 失败 |
| `npm run build` | 通过 |
| 生产 Electron 烟测（全新 userData） | 窗口 12s 响应、优雅关闭、日志 0 错误行、不创建注册表文件、无冻结行 |

## 四、未覆盖与后续

- 经典 routingPreferences 路径与 feature-candidate 路径均已具备动态候选输入；按声明制（claim-based）提交编排属于后续里程碑。
- 台账为本地 JSON 存储，策略变更经框架同步；启动对账兜底老连接。
- 火山/Vidu 管理探针仍 deferred（PR3 定案不变）。
