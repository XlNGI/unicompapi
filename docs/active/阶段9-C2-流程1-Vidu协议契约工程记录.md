# 阶段 9 C2 流程 1｜Vidu 协议契约工程记录

日期：2026-07-28

状态：实现和分支门禁已完成，等待项目负责人验收；尚未合并 `develop`

分支：`feature/vidu-protocol-contracts`

基线：`develop@a6a04a58e685a57e9706eb6f14e8cd3daeb86a2a`

## 一、允许范围与权威依据

本流程只实现 Provider 协议绑定、模型注册表迁移、能力证据历史、强类型 Router、对应测试和工程记录。未实现 HTTP、凭证读取、真实适配器、收费调用或生成页面改动。

协议和模型名称依据项目负责人冻结的三份生数科技官方文档：Vidu Q3 参考生视频、Image2 同步生图与图片编辑、Gemini 协议同步参考生图。文档未确认的价格、时长、分辨率、参数、Image2 鉴权和其他能力均未登记为已验证事实。

## 二、实际修改

1. 新增 `ProtocolBindingId`、`ProviderProtocolBinding` 与 `ProviderSubmitOutcome`，协议绑定包含媒体类型、协议 ID、协议版本、适配器种类、鉴权状态、执行生命周期和受支持目的。
2. `ProviderModel` 升级到 Schema v2，增加 `providerModelKey`、`protocolBindingId`、`mediaKind`、单调 revision 和当前 Evidence 指针；Provider Registry 升级到 Schema v2，并提供显式 Schema v1 迁移入口。
3. `ModelCapabilityEvidence` 升级为不可变版本历史，增加 revision、`supersedesEvidenceId`、`recordedAt`；连接验证和用户确认只追加新 Evidence，不再覆盖或删除旧记录。仓储拒绝删除或修改已经落盘的历史 Evidence。
4. 旧模型迁移为 `legacy.unclassified` 协议绑定；媒体类型无法可靠判断时保持 `unknown`，不推断协议或适配器能力。旧 Task 冻结的 Evidence ID 仍可读取和路由。
5. 登记 3 个冻结 Vidu 协议绑定与 10 个模型记录。图片与视频使用不同内部 modelId 命名空间；全部模型默认禁用，能力证据仅为 `declared_supported`，不包含价格、参数 Schema、时长或分辨率。
6. 新增 `ImageOperationRouter` 与 `VideoOperationRouter`。Router 同时核验 Task 业务类型、操作目的、冻结 provider/connection、模型媒体类型、协议绑定、Evidence 所属关系和状态、连接可用性及适配器执行生命周期。
7. 任意图片/视频跨类型组合、Task 类型篡改或 provider/connection 篡改均在适配器调用前返回稳定错误 `operation_model_mismatch`；测试确认适配器调用数为 0。适配器提交结果与协议生命周期冲突时返回 `adapter_contract_violation`。
8. 图片/视频预检增加媒体类型、协议绑定和目的过滤；Provider renderer DTO 只公开安全的协议摘要，不公开 endpoint、authScheme、adapterKind、凭证或内部仓储信息。`ProvidersPage` 仅补充空 DTO 兼容字段，未修改任何生成页面。

## 三、自动化验证

- Provider Registry 与 Router 定向测试：13 项通过；
- `npm test`：Node 157 项、Vitest 331 项，合计 488 项通过，0 失败、0 跳过；
- `npm run typecheck`：通过；
- `npm run lint`：通过；
- `npm run build`：通过；
- `npm run audit:platform`：扫描 200 个文件，0 违规；
- `npm run verify:handoff`：50 个 checksum 条目、27 个资产，0 失败；
- `git diff --check`：通过。

本流程未修改 Electron 主进程或 preload，不需要 Electron 启动烟测。测试和实现没有发起 Vidu HTTP 请求，没有读取 Token，也没有执行真实或收费生成。

## 四、未完成项与边界

- 三个真实协议适配器、共享 HTTP 运行时、代理、超时、轮询、取消、结果下载和 Work 登记均未实现；
- 冻结 Vidu 模型仍为 disabled，Evidence 仍为 `declared_supported`，不能作为真实提交授权；
- `reference_to_image` 与 `reference_to_video` 的 Task/提交端口兼容迁移不在本流程中，必须等待后续小 PR 明确批准；
- Image2 鉴权和请求结构等文档歧义仍保持 unknown，不得在后续实现前自行推断；
- 未启动流程 2、A3、B4、A4 或真实联网验证。

## 五、下一步

提交并推送 `feature/vidu-protocol-contracts`，等待项目负责人验收。只有本分支获批并合并最新 `develop` 后，项目负责人才能单独批准下一功能分支；本记录不构成后续实施授权。
