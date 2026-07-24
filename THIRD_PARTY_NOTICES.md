# UniComp 第三方许可与来源说明

本文件记录 UniComp 发布物中的第三方组件、来源、许可证和构建义务。发布前必须根据实际构建产物生成完整清单、SBOM、版本 Hash 和对应源代码归档。

## 当前仓库状态

- 当前提交没有捆绑 FFmpeg、GStreamer 或其他媒体引擎二进制。
- 当前阶段只完成媒体引擎选型与许可边界记录，不代表真实媒体引擎已接入或已进入发布物。
- 项目负责人已批准仅限本地开发/测试的临时 FFmpeg 例外；二进制可安装到被 Git 忽略的项目 `.tools/`，但仍不得提交或分发。
- npm/Electron/React 依赖的实际版本以 `pnpm-lock.yaml` 和构建产物为准，发布前必须补充逐项许可证清单。

## 计划中的 FFmpeg 组件

| 项目 | 计划值 |
| --- | --- |
| 组件 | FFmpeg 与 ffprobe |
| 版本 | 8.1.2 |
| 官方源码 | https://ffmpeg.org/releases/ffmpeg-8.1.2.tar.xz |
| 官方许可说明 | https://ffmpeg.org/legal.html |
| 构建策略 | LGPL-only；禁止 `--enable-gpl` 与 `--enable-nonfree` |
| 集成方式 | 独立受控进程，不把任意用户输入拼接为 shell |
| 当前状态 | 仅允许项目 `.tools/` 本地安装并由开发脚本验证启用；尚未进入构建或发布物 |

FFmpeg 进入发布物前，必须同时归档：

1. 官方源代码包及签名验证结果；
2. 精确构建参数、工具链和补丁；
3. 与二进制逐一对应的源代码和 SHA-256；
4. FFmpeg LGPL 文本、版权与 NOTICE 信息；
5. 实际启用的编解码器清单及专利/商业分发审查结果；
6. Windows 与 macOS 各架构的打包、签名和供应链记录。

在上述资料完成前，不得把任何预编译媒体引擎包提交到仓库或发布物中。

## 临时开发例外

临时开发适配器只在以下条件同时满足时启用：

```text
VITE_DEV_SERVER_URL 非空
UNICOMP_ENABLE_LOCAL_FFMPEG=1
UNICOMP_FFMPEG_PATH 指向已验证的项目 `.tools/` 本地可执行文件
```

仓库提交固定版本、来源、SHA-256、安装和验证脚本；FFmpeg 压缩包、可执行文件及整个 `.tools/` 均被 Git 忽略。`npm run dev` 只在版本、构建参数、编码器和许可证校验通过后注入本机路径；`npm start` 和生产构建不会启用该适配器。该例外不代表 FFmpeg 或任何编码器已经获得正式发布许可。
