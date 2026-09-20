# UniCompAPI Studio H3 临时测试适配

维护记录：2026-09-20。这是独立、可删除的测试包，不并入官方 MiniMax H3，也不写入 UniCompAPI `/v1` 能力表。后期删除时只移除本目录及相关接线。

## 范围

- 包 ID：`provider-package-unicompapi-studio-h3`，版本 `0.1.0-test`。
- 展示名：`UniCompAPI Studio H3 (测试)` / 模板 `UniCompAPI Studio H3 (测试，可删除)`。
- 只接 UniCompAPI Studio H3 网关 `https://unicompapi.com/studio/h3/v1`。
- 只实现 `minimax-h3` 的文生视频，变体冻结为 `fl2va`。
- 不实现 `ref2va`、图生视频、首尾帧、参考音视频。
- 不把该模型写入 `unicompapi-model-capabilities.ts`。
- 测试禁止真实 Studio H3 HTTP。

## 网关合同（2026-09-20 抽检）

- 鉴权：`Authorization: Bearer {api_key}`
- 探测：`GET /models`，目录含 `minimax-h3` 即视为凭证可用
- 创建：`POST /videos`，接受 200/202
- 查询：`GET /videos/{id}`，`running` 映射为 `processing`；成功结果看 `result_url`
- 取消：`POST /videos/{id}/cancel`；排队可取消，运行中可能 409
- 删除：`DELETE /videos/{id}` 为 405，测试适配不实现删除
- 该网关没有 MiniMax V2 `/video_generation`
- 同一令牌不能当作 MiniMax 官方 Key，也不能访问 `https://unicompapi.com/v1`

创建体：

```json
{
  "model": "minimax-h3",
  "variant": "fl2va",
  "prompt": "...",
  "duration_seconds": 4,
  "aspect_ratio": "16:9",
  "generation_mode": "base-balanced"
}
```

参数枚举：

- `duration_seconds`：4–15
- `aspect_ratio`：`16:9` `9:16` `21:9` `4:3` `1:1` `3:4`
- `generation_mode`：`base-lossless` `base-balanced` `base-fast`

目录里的 `fasth3-t2va` / `acc8-t2va` 当时不可用，测试适配不暴露。`409 CONTENT_MODERATION_PENDING` 视为可重试，不记为已计费成功。

## 删除方式

1. 删除 `src/platform/providers/unicompapi-studio-h3/`。
2. 删除 `tests/platform/unicompapi-studio-h3-*.test.ts` 与本文档。
3. 从 Electron/管理/提交/运行时/品牌图标接线中去掉 `unicompapi-studio-h3`。
4. 不要改官方 MiniMax 包或 UniCompAPI `/v1` 能力表。

## 工作台身份字段

工作台 `dispatchRequest` 会带 `taskId` / `executionId`。测试适配按精确字段校验，必须把这两个字段列为可忽略可选字段，否则会在 HTTP 发出前失败。未知字段仍拒绝。

## 验证（2026-09-20）

- Studio H3 定向 Vitest 11/11。
- 官方 MiniMax 14/14，相关探测/分发/视频合同 13/13，合计 38/38。
- `tests/ui/providers-page-contract.test.mjs` 16/16。
- `tsconfig.app.json`、`electron/tsconfig.json`、`tsconfig.test.json` 与 `tsc -b` 通过。
- 变更文件 ESLint 0 error；`git diff --check` 通过。
- 测试使用合成 HTTP，真实 Studio H3 调用 0。
- 未跑全量 Vitest、生产构建或 Electron 人工验收。
