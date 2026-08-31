# Seedance 视频候选合同修复记录

日期：2026-08-26

## 问题

UniCompAPI 的 `doubao-seedance-2-0-260128` 与 `doubao-seedance-2-0-fast-260128` 已迁移至精确的 Seedance 文生视频、图生视频参数 Schema，但视频候选与提交运行时共享的合同注册表未登记这两个 Schema。候选源无法解析 Profile 中的参数合同后会跳过该模型，造成模型选择器中无法选择。

## 修复

`createVideoProviderFeatureContracts()` 现在登记两个精确 Seedance Schema，并复用既有 NewAPI 视频结果、用量和约束合同。候选列表和 `NewApiVideoAdapter` 的参数 Schema 解析器均从这一个合同集合取值，因此修复同时覆盖模型列出、选择后的参数展示和提交前合同解析。

未改变模型能力表、请求体字段投影、连接授权、图片约束或真实服务商调用行为。

## 验证

- 定向 Vitest：`tests/platform/project-video-feature.test.ts`、`openai-compatible-video-routing`、`newapi-provider-package`、`unicompapi-model-capabilities` 共 71 项通过；
- 新增断言：两个 Seedance 专用 Schema 均能被 `ProviderFeatureContractRegistry` 精确解析；
- 全量 `pnpm test` 通过；
- `pnpm typecheck`、`pnpm lint`、`pnpm build` 与 `git diff --check` 通过；
- 未读取真实凭证、未调用真实服务商、未产生收费请求。
