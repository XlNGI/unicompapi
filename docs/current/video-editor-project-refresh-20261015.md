# 基础剪辑项目切换刷新

## 范围与原因

- 基线：远程 develop `f08b2822a209033dc3a02843f67c816f9f398c6f`。
- 分支：`feature/video-editor-project-refresh`。
- 隔离目录：`D:/unicompapi-worktrees/video-editor-project-refresh`。
- 基础剪辑在 App 中常驻以保留普通导航状态。加载 effect 依赖 `active`，未感知项目切换，导致顶部更新而工作区保留旧项目。
- App 接收已有项目切换通知后更新编辑器 key。React 卸载旧实例，运行原有清理并创建新实例，因此草稿、时间线、属性和预览全部跟随新项目。未更改后端、项目文件格式或生成逻辑。

## 已执行验证

- `pnpm typecheck`：通过。
- `pnpm lint`：通过。
- `pnpm build`：通过；保留现有大 bundle 警告。
- `node --test tests/ui/*.test.mjs`：353/353。
- `pnpm exec vitest run tests/application/video-editor-visibility-behavior.test.ts tests/platform/video-editor-controller.test.ts`：11/11。
- `electron scripts/verify-video-editor-project-switch-electron.cjs --baseline`：复现旧版顶部 B / 编辑区 A。该模式固定读取 `f08b282` 的 App 源码。
- `electron scripts/verify-video-editor-project-switch-electron.cjs`：11 项检查通过，renderer 错误 0。
- `git diff --check`：通过。

运行时检查使用真实 React App、标题栏、导航、基础剪辑及原有生命周期清理；其余导航到达的聊天/快速视频页面为测试空页面，IPC 数据为独立合成项目，视频由本机 Canvas/MediaRecorder 生成。验证包含真实鼠标事件、DOM、媒体状态与截图，不调用服务商、不读写用户项目。它不代替实际项目、真实 preload/IPC 或 macOS 验收。

覆盖 A→B 更新、B 项目素材隔离、旧播放停止、普通导航保持实例、慢草稿返回、慢预览返回、空项目、读取失败、切换失败、后台切换、关闭项目。结果与截图保存在 `outputs/video-editor-project-switch/fixed/`。

## 人工验收

在 PowerShell 执行本地便捷脚本（不进入 Git）：

```powershell
& 'D:\unicompapi-worktrees\video-editor-project-refresh\outputs\start-manual-acceptance.ps1'
```

脚本使用独立 `outputs/manual-profile`，首次启动需要在应用中打开待验收的两个项目。可使用测试项目，确保两边有不同草稿或视频。Vite 固定为 5174，已占用时明确退出；关闭桌面窗口会连带结束 Vite。只打开网页不能代替桌面验收。

1. 在项目 A 进入基础剪辑，确认草稿、时间线与预览；顶部切到 B，不离开基础剪辑，内容应立即更新。
2. A 播放期间切到 B：A 视频应停止，B 的预览和属性对应 B 的片段；项目素材也属于 B。
3. A/B 连续切换后停在 B：等待数秒，不能跳回 A。
4. 切到没有剪辑草稿的项目：旧时间线、预览和属性清空；切回原项目可以正常读取已保存草稿。
5. 不切项目，只去其他页面再返回：草稿仍可用，保留原有导航行为。

源码和 node_modules 位于隔离目录；`.tools` 只链接本机已有媒体二进制（原目录 `D:/unicompapi-git/.tools`），已通过项目现有媒体工具验证。自动验证进程已经退出，没有启动网页端口；人工验收结束后关闭本脚本启动的桌面窗口，确认脚本退出。

负责人后续已明确授权上传功能分支，并要求先模拟合并，无冲突时直接合入 develop。交付保留本地与远程功能分支；最终推送结果以远程引用核验为准。
