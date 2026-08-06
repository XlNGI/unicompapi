# Vidu 文生视频官方 API 适配记录

日期：2026-08-06

状态：工程适配已落地；未做真实收费调用

官方文档：https://platform.vidu.cn/docs/text-to-video

## 一、官方契约

1. 提交：`POST https://api.vidu.cn/ent/v2/text2video`，鉴权 `Authorization: Token {api_key}`。
2. 官方模型：`viduq3-turbo`、`viduq3-pro`、`viduq2`、`viduq1`。
3. 必填：`model`、`prompt`（≤5000 字符）；异步响应含 `task_id`。
4. 查询/取消沿用现有任务接口：`GET/POST /ent/v2/tasks/{id}/creations|cancel`。
5. 本适配首期暴露可选参数：`audio`、`duration`、`resolution`、`aspect_ratio`。q3 时长按官方 1—16 秒。

## 二、工程落点

1. 新增协议/适配器：`vidu.ent.v2.text2video` / `vidu_text_video_v2`，模型 `viduq3-pro` 纯文生视频。
2. `viduq3-turbo` 在现有参考视频适配器上增加 `text_to_video`（capability=`video_generation`），提交时改走 `/ent/v2/text2video`。
3. 官方同名 `viduq2`/`viduq1` 已占用为官方参考生图模型，本阶段不重复挂载为视频键，避免 mediaKind/协议冲突。
4. 目录安装、路由适配、功能提交分发桥与 Electron 轮询/落盘均已接线；积分不足等错误映射沿用共享运行时。

## 三、候选为空根因与修复

快速/文生视频页曾持续“没有可选模型”，根因不是页面，而是
`createVideoProviderFeatureContracts()` 历史只注册 `image_to_video`，
把官方 `text_to_video` Schema 全部过滤掉，候选解析时 `contracts.resolve` 失败后静默跳过。

已改为同时注册 `image_to_video` 与 `text_to_video`。已有连接还需在「模型与服务商」里对 Vidu 做一次目录同步/重新保存连接，以写入 `viduq3-pro` 并给 `viduq3-turbo` 挂上文生能力。

## 四、全链路复查结论（2026-08-07）

| 环节 | 结论 |
| --- | --- |
| 候选合同 | 已注册 `text_to_video`；旧问题已修 |
| 目录数据 | 已有连接必须点「同步目录」才写入 `viduq3-pro` / turbo 文生能力 |
| 提交分发 | reference + text 双适配器已注册；turbo 文生走 reference 适配器的 text2video 分支 |
| 轮询/落盘 | 同会话靠 remember 正确；已修“多 binding 时猜第一个”导致 pro 走错适配器 |
| 真实调用 | 仍不做；`viduq3-turbo` 历史预算可能已耗尽 |

## 五、验收边界

- 合成 transport / 单元测试覆盖提交路径与零 HTTP 拒绝路径。
- 不读取真实 Token，不发起真实收费调用；预算耗尽模型不得继续实网调用。
