# UniComp 桌面应用

本仓库用于承接 UniComp V1.2.1 产品、UI 与技术交接资料，并基于 Electron 构建完整桌面应用。

后台服务已由已有后台提供，本仓库负责桌面端体验、本地状态、模型/服务商连接配置、任务流程、作品管理和与后台/API 的调用集成。

当前状态：阶段 9｜跨平台与完整验收。B1、B2、A1、B3、A2、C1 与 C2 流程 1—8 已合并 `develop`；Vidu 官方 API 的 Windows 开发态最小图片、图生视频闭环已经真实验证。A3、B4、A4 尚未启动，当前先核对并解决现有界面与最终 UI 交接效果图的差异，UI 优化范围仍在讨论，不代表阶段 9 已完成。macOS 实机和部分 Windows 人工项继续保持 `not_run/deferred`；安装包、签名、公证、生产更新、生产媒体组件分发、SBOM 和正式发布准入仍属于阶段 10。

## 许可证

UniComp 自有代码采用 Apache-2.0，详见根目录 [`LICENSE`](LICENSE)。第三方组件按各自许可证和 `THIRD_PARTY_NOTICES.md` 中的要求分发。

## 资料位置

产品经理交接资料已归档在：

```text
handoff/UniComp-技术开发启动包-V1.0.0/
```

开发时不得直接修改交接包中的权威资料、设计图和原始压缩包。如需形成工程侧结论，请写入 `docs/active/`；冻结后的正式结论再移动或复制到 `docs/frozen/`。

## 当前优先级

发生冲突时，以以下顺序为准：

1. 项目负责人最新明确决策；
2. `handoff/UniComp-技术开发启动包-V1.0.0/03-最终UI交接包-已解压/UniComp-AI-最终UI与开发交接包-V1.2.1`；
3. 根目录 `AGENTS.md` 与 `PLANS.md`；
4. `docs/active/` 与 `docs/frozen/` 中的正式开发记录；
5. `handoff` 中的历史归档和旧资料。

## 协作方式

- `main`：稳定基线，只合并已验收内容。
- `develop`：日常集成分支。
- `feature/*`：个人功能分支。

当前开发继续采用双人分工：

| 角色 | 方向 | 当前职责 |
| --- | --- | --- |
| 开发者 A | UI 与产品交互 | 页面结构、视觉、响应式、可访问性和真实接口接线 |
| 开发者 B | 本地领域与平台 | 实体、目录、索引、状态机、恢复、安全和受控 IPC |

当前阶段与详细分工见 `PLANS.md` 和 `docs/active/阶段9-任务拆分.md`。

## 技术方向

- 桌面壳：Electron
- 前端：React + TypeScript
- 构建：Vite
- 包管理：pnpm 优先，npm 也可运行

## 本地运行

安装依赖后运行：

```bash
pnpm install
pnpm dev
```

如果使用 npm：

```bash
npm install
npm run dev
```

首次启用本地 FFmpeg 开发预览时，将负责人批准的 Windows 压缩包安装到被 Git 忽略的 `.tools/`：

```powershell
npm.cmd run setup:media-engine -- --archive "C:\path\to\ffmpeg-n8.1-latest-win64-lgpl-8.1.zip"
npm.cmd run verify:media-engine
npm.cmd run dev
```

不传 `--archive` 时安装脚本可从 manifest 中的受控 HTTPS 地址下载，但仍必须匹配固定 SHA-256；上游滚动包发生变化时会失败关闭，必须重新审批后才能更新 manifest。`npm run dev` 会先验证版本、LGPL-only 构建参数、必需编码器和许可证文件，再自动注入项目内绝对路径。生产启动和生产构建不会读取这条开发例外，也不会将 `.tools/` 自动打进安装包。

## 下一步

1. 先讨论并批准 UI 视觉、响应式和逐按钮真实接口的优化范围；
2. 批准后从最新 `develop` 创建小功能分支，按权威效果图逐批优化和验收；
3. UI 问题收口后再启动阶段 9 A3、B4、A4；
4. 阶段 9 正式关闭后再规划阶段 10。
