# MiniMax H3 Official Adapter

维护记录：2026-09-20。官方 MiniMax H3 视频适配，不走 UniCompAPI 能力表。

## 范围

- 包 ID 固定为 `provider-package-minimax-h3`，避免历史用户配置漂移。
- 只接官方 MiniMax H3 V2：`MiniMax-H3`、`MiniMax-H3-Max`。
- 只实现文生视频和单张受控首帧图生视频。
- 不实现尾帧、首尾帧、R2V、Hailuo 2.3 v1、文本/TTS、视频编辑、H3-Context-IR、再生。
- 不把 MiniMax 写入 UniCompAPI `unicompapi-model-capabilities.ts`。
- 测试禁止真实 MiniMax HTTP。

## 官方合同

- 中国：`https://api.minimaxi.com`
- 全球：`https://api.minimax.io`
- 鉴权：`Authorization: Bearer {api_key}`
- 创建：`POST /v2/video_generation`
- 查询：`GET /v2/query/video_generation/{task_id}`
- 上传：`POST /v1/files/upload`，`purpose=video_generation_input`
- 成功查询直接使用 `task.content.url`，不再换 `file_id`
- 文生视频必须带 `ratio`，不能 `adaptive`
- 图生视频省略 `ratio`，首帧以 `mm_file://{file_id}` 和 `role=first_frame` 提交
- 连通探测：`GET /v1/files/retrieve?file_id=0`，不产生计费

## 工程接线

- 运行时按连接 `endpoint` 选择官方源站，构造器不写死 base URL。
- 图生视频先上传受控本地资产，再 `beforeRequestStarted`，再创建任务。
- 取消按 Kling 语义返回 `{ state: 'processing' }`。
- 工作台提交/轮询共用长生命周期 `MiniMaxVideoAdapter`。
- 添加/同步连接时安装打包目录，行为对齐 Vidu，不走 `manual_exact`。

## 验证（2026-09-20）

- MiniMax 定向 Vitest 14/14，相关探测/分发/视频合同 13/13，合计 27/27。
- `tests/ui/providers-page-contract.test.mjs` 16/16。
- `tsconfig.app.json`、`electron/tsconfig.json`、`tsconfig.test.json` 与 `tsc -b` 通过。
- `npx eslint .` 全仓 0 error；`git diff --check` 通过。
- 测试使用合成 HTTP，真实 MiniMax 调用 0。
- 未跑全量 Vitest、生产构建或 Electron 人工验收。

