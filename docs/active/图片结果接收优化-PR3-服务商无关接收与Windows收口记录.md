# 图片结果接收优化 PR3｜服务商无关接收与 Windows 收口记录

日期：2026-08-28

分支：`feature/provider-neutral-image-result-receipt`

结论：图片结果接收优化 PR1—PR3 已在阶段 9 收口后的独立功能边界内完成 Windows x64 工程收口；本支未启动阶段 10，macOS 实机继续为 `not_run/deferred`。

## 实际修改

### 1. 服务商无关即时图片结果接收端口

- 新增 `src/platform/images/stored-immediate-image-result-port.ts`，删除生产接收链路对 `ViduImmediateImageResultPort` 命名空间的依赖。
- 端口只从传入 `ProviderOperationRecordId` 对应的持久化记录读取结果，并再次核对记录 ID、图片媒体类型、`synchronous_completed` 生命周期、`completed_sync` 结果和“恰好一个结果”约束。
- 同时支持 `base64`、`remote_url` 与 HTTPS 语义的 `file_uri`；base64 在分配前检查编码形状和上限，远端结果在进入下载器前检查 HTTPS、用户名/密码、fragment、IP、localhost、`.local` 和单标签主机名。
- 受控下载契约固定 `allowPrivateNetwork=false`、`dnsRebindingProtection=required`、`redirectPolicy=deny`、`sendCredential=false`，并继续执行 20 MiB 上限、空响应拒绝、声明 MIME 初筛和后续本地真实图片探测/哈希校验。
- Electron 正式装配优先复用现有无凭证图片下载端口；兼容回退只使用共享 Runtime 的结果下载结构，不读取服务商凭证。Vidu 路由适配器也复用服务商无关的字节读取函数，不保留旧生产引用。
- 结果仍以独占临时文件写入，并由 `LocalImageResultReceiver` 完成本地探测、两次哈希校验、原子发布、FileReference、索引及 Work 登记；重复接收仍最多登记一个 Work。

### 2. 安全接收事件与独立日志

- `LocalImageResultReceiver` 新增以下白名单事件：
  - `receipt_started`
  - `descriptor_loaded`
  - `download_started`
  - `download_completed`
  - `verification_completed`
  - `work_registered`
  - `receipt_failed`
- 事件只包含 `taskId`、`executionId`、安全阶段、失败时安全码、retryability 和 ISO 时间戳；不包含 URL、查询参数、base64、Token/API Key、请求/响应正文、路径、原始异常 message 或 stack。
- Electron 将事件按顺序追加到 `${app.getPath('userData')}\logs\image-result-receipt.log`。序列化器只重建白名单字段并限制 ID 字符集；目录创建、追加或回调失败均被隔离，不会替代接收结果或阻断 Work 登记。
- 失败事件使用接收器已公开的安全错误码与 retryability；Execution 失败持久化仍保留真实本地接收阶段，日志不替代项目事实文件。

### 3. 兼容性与不变量

- 未修改存量 Provider Operation、Execution、FileReference 或 Work JSON Schema，不执行破坏性迁移。
- 未恢复首页、多图/批量生成、视频批量生成或新的一级页面。
- 未弱化“本地真实文件校验后才能成为正式作品”的门禁。
- 恢复流程只复用原 Task、Execution 和 Provider Operation，不重新提交生成、不新增收费请求。

## 定向安全验收

`tests/platform/stored-immediate-image-result-port.test.ts`、`tests/platform/image-result-receiver.test.ts` 与 `tests/platform/vidu-e2e-validation.test.ts` 共 20/20 通过，覆盖：

- base64 描述读取、独占落盘和正文不外泄；
- UniCompAPI 风格签名 HTTPS URL 与 `file_uri` 受控下载；
- IP、localhost、用户名/密码、fragment、HTTP 地址在进入下载器前拒绝，HTTP 请求数为 0；
- 手动重定向拒绝、错误 MIME、空响应与超限响应；
- 正常事件顺序完整，失败事件包含安全阶段、错误码和 retryability；
- 签名 URL、查询参数、base64、Token 和响应正文均不进入 JSONL 日志；
- 日志写入失败不影响 Work 登记；
- 已验证文件恢复、跨运行时恢复与重复接收只登记一个 Work；
- NewAPI/UniCompAPI 风格远端结果不依赖 Vidu 命名端口。

## 完整验证

- Node/UI：327/327 通过，0 失败、0 跳过。
- Vitest：888 通过、0 失败、5 跳过；5 个跳过项为既有的 4 个批准媒体工具链用例与 1 个真实视频导出进程用例。仓库按规则不带 `.tools/` 或 FFmpeg 二进制，本支未伪造执行结果。
- 合计：1,215 项通过、0 失败、5 跳过。
- 应用 TypeScript、测试 TypeScript、全仓 ESLint、生产构建与 `git diff --check` 全部通过。Vite 仅保留既有大 chunk 提示，不影响构建退出码。
- 交接校验：50 个 checksum 条目、27 个 manifest 资源、0 失败。
- 平台审计：扫描 379 个文件，0 违规。
- 恢复审计：`passed`，16 个案例、9 类故障、7 个领域、0 安全违规、0 禁止制品。
- 阶段 9 收口校验：9 个 Windows 必需套件保持通过，`macos-primary` 保持延期。
- 运行时集成命令退出码 0；通知、快捷键、直连/系统代理与电源事实通过。媒体状态如实报告 `approved_media_toolchain_missing`，未把缺失 `.tools/` 伪记为已执行。
- 安全存储：可用，加密字节 95，明文持久化为 `false`。
- Windows 生产 Electron 隔离烟测：4 个进程、4/4 响应、1 个可见窗口、stderr 0 字节；请求正常关闭后残留 0，隔离 userData 已清理。

## 边界与未完成项

- 真实服务商 HTTP/DNS 0、真实凭证读取/验证 0、收费请求 0、费用 0；所有远端结果用合成传输验证。
- Vidu 图片与视频真实预算已用尽，本支没有再次调用；Image V1 鉴权与 `images` 结构仍保持未验证。
- 未执行 macOS 实机或媒体工具链；Windows 结果不代表 macOS 已支持。
- 未启动安装包、签名、公证、生产更新、生产媒体组件分发、SBOM 或其他阶段 10 工作。
- 后续若项目负责人重新批准真实服务商预算，可只观察脱敏接收日志确认真实远端结果的首次中断阶段；该观察不改变本支已经通过的本地接收、安全与恢复门禁。

本分支验收为 `passed`，允许提交、推送并非快进合并 `develop`；本地与远程功能分支必须保留。
