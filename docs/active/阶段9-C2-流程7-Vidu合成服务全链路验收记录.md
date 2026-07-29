# 阶段 9 C2 流程 7｜Vidu 合成服务全链路验收记录

日期：2026-07-29

状态：实现和分支门禁已完成，等待连续授权下提交、推送与非快进合并 `develop`

分支：`feature/vidu-e2e-validation`

基线：`develop@90a2d586a29ccdac1ba044ca13d4f3f548fe5ace`

## 一、范围与安全边界

本流程只增加本地内存合成 Vidu transport、协议夹具、端到端测试命令、故障矩阵和验收发现的最小修复。测试 Token 为固定合成字符串，只存在测试进程内；真实凭证读取、真实 Vidu 网络和收费请求均为 0。未创建第四种图片协议，未启用冻结模型，未修改 React 页面，也未启动 A3、B4、A4 或流程 8。

## 二、实际实现与缺陷修复

1. `SyntheticViduService` 实现三个已批准协议族与受控结果下载，支持排队返回 401、429、5xx、重定向、超限、截断和 transport 断线；独立 `npm run test:vidu-e2e` 可重复执行。
2. 三协议测试覆盖 Image V1 URL/base64、Gemini file URI、Q3 异步 task；图片与视频 Router 的跨媒体组合在 transport 前返回 `operation_model_mismatch`。
3. 图生视频预检此前固定查询 `video_generation`，与 Q3 的 `reference_to_video` 绑定和 Evidence 不一致。本流程改为 `image_to_video` 查询 `reference_to_video`，其他视频模式继续查询 `video_generation`。
4. 视频执行经查询进入 `remote_completed` 后，结果接收器此前会拒绝接收。本流程允许该真实状态继续下载、探测、校验和登记，且不重复执行 `remote_completed` 转换。
5. Vidu 运行时现在拒绝 `Content-Length` 与实际响应字节不一致的截断响应；超过上限仍返回 `response_too_large`，截断返回 `invalid_response`。
6. 图片结果原子发布增加主进程内部 `publishFile` 测试注入点，生产默认保持同目录 `rename`。合成 `ENOSPC` 验证不登记 Work、清理临时文件并保留 Execution 写入阶段失败事实。

## 三、全链路事实

端到端测试按真实应用边界执行：配置本地合成连接和受控凭证 → 创建图片 Task/Execution → 同步提交 → 私有 ProviderOperationRecord → 下载、图片探测、SHA-256、原子落盘 → 图片 Work → 用户显式创建图生视频草稿 → 重新选择模型、参数和六项确认 → 异步提交、刷新 → 下载、视频探测、SHA-256、原子落盘 → 视频 Work。

链路没有自动从图片 Work 提交视频；renderer DTO 不含 Token、远端 task ID、签名 URL、绝对路径或 Hash。ProviderOperationRecord 仍按已批准架构在主进程私有项目仓储保存同步结果引用，以支持崩溃恢复；这些私有事实不进入 renderer 或安全日志。

## 四、故障矩阵与验证

- 正确/错误鉴权、三协议路由、URL/base64/file URI、异步 task：通过；
- 跨媒体组合零 transport：通过；
- 提交断线进入 `submission_outcome_unknown` 且零自动重试：通过；
- Q3 429/5xx 退避、取消、重启结果重发现、24 小时 URL 到期：通过；
- 非 HTTPS、重定向、超限、伪 MIME、截断、损坏媒体、磁盘不足：由流程 7 定向测试和既有结果接收回归共同覆盖并通过；
- Work 登记失败、已验证文件保留和幂等恢复：既有回归继续通过；
- Token、绝对路径、远端 task ID、签名 URL、Hash 和响应正文的 renderer/安全日志扫描：通过。

分支门禁结果：

- `npm test`：Node 160 项、Vitest 377 项，合计 537 项通过，0 失败、0 跳过；
- `npm run test:vidu-e2e`：4 项通过；
- `npm run typecheck`：通过；
- `npm run lint`：通过；
- `npm run build`：通过；
- `npm run audit:platform`：扫描 213 个文件，0 违规；
- `npm run verify:handoff`：50 个 checksum 条目、27 个资产，0 失败；
- `git diff --check`：通过；
- Windows Electron 生产构建烟测：新增 4 个进程、4/4 响应，窗口关闭后本次残留 0；烟测前已有 4 个旧 Electron 进程未被终止。

## 五、未完成项与停止边界

- 合成夹具中的 Image V1 `token` 鉴权和输入结构只用于验证架构分支，不构成官方 `verified_supported` 证据；
- Image V1 准确鉴权、`images` 结构、真实模型权限、账户、费用、远端 MIME/域名和 URL 有效期仍未通过官方环境验证；
- 冻结 Vidu 模型继续 disabled，CapabilityEvidence 继续 `declared_supported`；
- 流程 8 尚未批准。流程 7 合并并复验后立即停止，不创建 `feature/vidu-live-validation`，不读取真实 Token，不联网，不收费；
- 阶段 9 A3、B4、A4、macOS 实机和阶段 10 发布准入均未因本流程完成而通过。
