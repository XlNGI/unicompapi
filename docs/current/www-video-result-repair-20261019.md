# WWW MiniMax-H3 真实视频结果接收修复

2026-10-19。负责人反馈真实调用无法正常生成视频。本轮属于维护，依据最新负责人故障反馈、AGENTS.md、PLANS.md 顶部维护记录、当前源码、既有 WWW 视频合同及本次原任务响应定位。继续在 `feature/www-model-binding-repair-20261019` 工作，保留前轮合同入口修复、启动恢复和全部既有未提交修改；未提交、合并、推送或发布。

## 确认的原因

本机今天 14:48 提交的 MiniMax-H3 文生视频已经由网站受理，原任务为 `b8b8109a-5d6b-431c-b0b8-25d7f1aa80fa`。应用持续查询至 14:52:44，最后一次 HTTP 200 后进入本地 failed/unknown_outcome，未登记作品。对原任务执行 GET 确认远端实际为 `succeeded`，已扣费 7.04 元、预留为 0、无需补结算。

旧实现将 H3 结果套用通用媒体响应，存在三个实际不匹配：

| 实际 H3 响应 | 旧实现假定 | 结果 |
| --- | --- | --- |
| `output_type=video`，不含 `review_phase` | 必须 `review_phase=output_approved` | 成功结果被拒绝 |
| `data` 是单个 `{asset_id, url, mime_type}` 对象 | `data` 必须为单元素数组 | 结果无法提取 |
| 私有结果路径是 `/v1/videos/:id/content` | H3 下载也走 `/v1/h3/tasks/:id/content` | 即使解析成功仍使用错误下载路径 |

此前合成 H3 响应使用了通用媒体数组/审核字段与假定的下载路径，因此没有暴露真实差异；本轮将夹具和 Electron 验证改为实际 H3 结构。审计与合同绑定通过不代表已覆盖这次真实接收问题。

## 修复范围

- `src/platform/providers/newapi/www-video-adapter.ts` 按 H3 协议接收已成功的视频对象；没有审核字段时必须声明视频类型，显式审核拒绝仍阻断。其他网关视频继续要求 output approval 和数组结构；非视频类型、外站/其他任务的 URL、多输出及待结算状态继续拒绝或保持等待。
- `src/platform/providers/newapi/newapi-runtime.ts` 保留 H3 提交和查询路径，下载使用共享 videos content 路径。下载目标由 Host 使用固定原任务及 asset_id 构造，不跟随任意响应 URL。
- 更新 WWW 夹具、增加 8 个 H3 结果及边界回归，并更新真实 Electron 隔离响应。
- 增加 `scripts/inspect-www-video-task.cjs` 和 `scripts/recover-www-video-task.cjs`。前者只查询指定已受理原任务并输出脱敏摘要；后者默认仅核对，`--apply` 通过生产恢复 Runtime、适配器和本地接收器恢复原视频。传输层硬性拒绝所有 POST，限定本站、原任务路径和最多 12 次请求；无提交入口、无自动结算、无自动循环重试。凭证仅在原生加密库回调内使用。

## 实际原任务恢复

已使用生产恢复流程将原任务恢复到所属项目，执行状态为 `completed`，正式作品恰好 1 件。接收经过原 Key 私有下载、本地 MP4 结构/元数据、Hash、原子落盘和作品登记门禁。

| 事实 | 结果 |
| --- | --- |
| 本地文件 | `files/results/work-video-result-e05041f2-f7c3-4971-a188-e5a5132c69ea.mp4` |
| 分辨率 / 时长 / 大小 | 2560 × 1440 / 4459 ms / 11,128,282 字节 |
| SHA-256 | `5c4c28b29dc54433d20f3da1df1635185eb413dfd5946c2c5d6adfbe829955c8` |
| 原单费用观测 | charged_amount=7,040,000 CNY_MICRO，即 7.04 元 |
| 成功恢复外发 | 4 次原任务 GET、1 次原内容 GET；生成/上传/结算 POST 均为 0 |
| 重复恢复核验 | 已完成作品读回一致，额外请求 0、作品仍为 1 |
| 文件验证 | NodeVideoInspector、SHA-256、FFprobe 均通过；FFmpeg 全音视频解码 exit 0、错误日志为空 |

7.04 元为负责人此次已有原单的扣费，本轮没有新发起收费生成或追加结算。实际模型注册表、原 Task、提交记录、路由、草稿及项目 manifest 在恢复前后 Hash 一致；只更新该任务执行、结果文件/索引、正式作品、原调用费用与本地结果观测。未修改其他模型或旧验收预算。

证据：[原单检查](../evidence/www-video-result-repair-20261019/original-task-inspection.json)、[实际恢复](../evidence/www-video-result-repair-20261019/recovery-validation.json)、[重复核验](../evidence/www-video-result-repair-20261019/recovery-repeat-validation.json)、[媒体探测](../evidence/www-video-result-repair-20261019/ffprobe.json)。不把用户视频复制到 Git 证据目录，不保存原始提示词或凭证。

## 本轮验证与中间失败

- 最终相关 Vitest 8 文件、254/254，0 失败/跳过，覆盖 WWW、NewAPI、恢复、接收、HTTP 传输、模型管理和旧视频路由；前一组 212 项与其重叠，不重复累计。
- Node/UI 393/393；本轮唯一自动回归共 647 项。未重新运行全仓 Vitest，不将前轮 3859 项当成本轮结果。
- 隔离生产 Electron/preload/IPC/Host 九型号 13 个功能组合全部通过，包括真实 H3 响应格式；外部请求和收费 POST 为 0。
- 类型检查、全仓 lint、真实生产构建、平台审计和 diff 检查通过。构建仍有既有 Vite CJS 与大 chunk 提示；macOS 未实机验收。
- 先补真实 H3 响应回归，旧实现 44/45，唯一失败为 H3 成功结果接收，已保存 red.json；修复后通过。中间夹具的重复 review_phase 被 TypeScript 检出，调整字段分支后类型检查通过。
- 首次实际恢复返回 network_error，未获得足以区分底层网络原因的诊断，也未登记作品；没有生成或结算 POST。随后为恢复脚本增加请求阶段诊断，再次沿原单 GET 恢复成功，未把该失败覆盖或算作首次成功。原始 recovery.log 保留。

完整验收、源文件和证据 Hash 见[机器记录](../evidence/www-video-result-repair-20261019/validation.json)。

## 剩余边界和下一步

已解决本次 H3 成功结果被误判且无法接收的问题，并恢复负责人这笔真实作品。没有新发起一次 H3 生成，也没有宣称其他八个型号全部通过真实服务验收；旧 HappyHorse 未知原单、预算和未覆盖型号边界继续保留。前轮六文本型号兼容声明、37 个来源缺口及 WWW 图片协议不在本轮修改范围。

当前正在运行的应用主进程早于本轮修复，未代为重启；正常重启后才会在后续调用中加载新接收逻辑。已恢复的作品在原项目中，重新打开原项目/刷新作品后可查看。没有替换安装包或发布。
