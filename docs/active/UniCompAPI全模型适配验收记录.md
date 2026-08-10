# UniCompAPI 全模型适配验收记录

日期：2026-08-10  
分支：`feature/unicompapi-full-adaptation`  
范围：本地适配实现；不上传、不合并、不进行真实供应商调用。

## 结果摘要

| 项目 | 结果 |
|---|---|
| UniCompAPI 能力登记 | 34/34 模型 |
| 定向 Vitest | 51 通过 |
| 平台 Vitest | 529 通过，5 跳过 |
| 领域 Vitest | 102 通过 |
| 统一 `pnpm test` | 631 通过，5 跳过 |
| TypeScript | 通过（含测试配置） |
| ESLint | 通过 |
| 生产构建 | 通过 |
| `git diff --check` | 通过 |
| 真实供应商 HTTP/Token/收费调用 | 未执行 |

## 已验证的关键行为

1. 文本模型只挂载 `newapi.chat`；GPT 模型不自动获得推理 Profile；图片/视频模型不自动获得文本 Profile。
2. `qwen-image` 仅走 `text_to_image`；`qwen-image-edit-2509` 仅走 `image_edit` 与 `/v1/images/edits`。
3. 图片生成携带 `assetId` 会拒绝；图片编辑缺少 `assetId`、素材跨项目或非图片素材会拒绝。
4. 普通 `provider-package-newapi` 不会误挂载 UniCompAPI 专用 `image_edit`；未知 UniCompAPI 手动模型也不会误挂载该 Profile。
5. UniCompAPI 视频的 `size` 与 `resolution` 冲突会拒绝，`kling-v3-turbo` 时长范围受约束，`ratio` 投影到受控 metadata。
6. 快速生图不再硬编码 `1024x1024`，尺寸只来自模型参数 Schema。

## 未完成/待上游确认

- `/v1/responses` 仍按用户决策暂不接入。
- GLM `thinking`、GPT/Kimi `reasoning_effort` 的供应商最终取值范围尚未由上游正式契约确认，因此未扩展为猜测性枚举。
- Seedance、Kling 的最终时长/分辨率/音频细则，以及 `qwen-image-edit-2509` 的最终 multipart/JSON 形态，仍需真实供应商契约后再增加专用字段。
- 目录同步新增模型时，需要补充能力表、Schema、路由测试后再启用。

这些项目属于明确的上游契约或后续扩展，不阻断当前已声明能力的本地适配验收。
