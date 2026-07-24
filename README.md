# UniComp 桌面应用

本仓库用于承接 UniComp V1.2.1 产品、UI 与技术交接资料，并基于 Electron 构建完整桌面应用。

后台服务已由已有后台提供，本仓库负责桌面端体验、本地状态、模型/服务商连接配置、任务流程、作品管理和与后台/API 的调用集成。

当前状态：阶段 7｜视频基础编辑。B1、B2、A1、A2 与 A3 已完成并合并 develop；项目许可证采用 Apache-2.0，媒体引擎选型方向为 FFmpeg 8.1.2 LGPL-only。仅限本地开发/测试的外部 FFmpeg 路径例外已启用，真实媒体引擎二进制、编码器白名单和正式导出仍等待独立许可与分发审查。

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

阶段 2 起采用双人分工：

| 角色 | 方向 | 当前职责 |
| --- | --- | --- |
| 开发者 A | UI 状态系统 | 状态组件、主题、可访问性、UI 测试与阶段 3 页面准备 |
| 开发者 B | 本地领域与平台 | 实体、目录、索引、状态机、恢复和受控 IPC |

详细分工见 `docs/active/阶段2-任务拆分.md`。

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

如需临时启用仓库外的本地 FFmpeg 预览适配器，仅可在开发模式设置：

```powershell
$env:UNICOMP_ENABLE_LOCAL_FFMPEG = '1'
$env:UNICOMP_FFMPEG_PATH = 'D:\tools\ffmpeg\8.1.2\bin\ffmpeg.exe'
npm.cmd run dev
```

生产启动不会读取这条开发例外，也不会将外部 FFmpeg 自动打进安装包。

## 下一步

1. 完成 FFmpeg 编解码器白名单、专利/商业分发审查和跨平台构建记录；
2. 在批准后实现 B3 `MediaEngineAdapter`，并保持参数数组、输出校验和软件回退边界；
3. 通过 B3 后再推进 B4 正式导出、恢复和 Work 登记。
