# 阶段 10｜Windows 本地打包启动说明

状态：工程侧已接通 Windows x64 本地可分发试验包；**非正式发布准入**。

## 范围

- 仅 Windows x64
- 产物：NSIS 安装包 + portable 单文件
- 未签名、未公证
- 不打入 `.tools/`、FFmpeg/ffprobe
- 不做自动更新、SBOM、macOS 包

## 命令

```powershell
pnpm package:win
```

实现要点：

- 使用本地 `node_modules/electron/dist`，避免重复拉取 Electron 运行时
- `ELECTRON_BUILDER_BINARIES_MIRROR` 指向 npmmirror，拉取 NSIS 等构建工具
- `CSC_IDENTITY_AUTO_DISCOVERY=false` 与 `signAndEditExecutable: false`：本机无签名证书，且避免 winCodeSign 在未提权环境下因符号链接失败

## 本机验证产物（2026-08-07）

| 产物 | 说明 |
| --- | --- |
| `release/UniComp-0.1.0-win-x64-setup.exe` | 未签名 NSIS 安装包 |
| `release/UniComp-0.1.0-win-x64-portable.exe` | 未签名 portable |
| `release/win-unpacked/` | 解压目录，可用于冒烟 |

冒烟：启动 `release/win-unpacked/UniComp.exe`，进程保持响应。

已修复：`unicomp-media` 本地预览不再转发 `file://` 响应头。含中文路径的素材原先会把非 ASCII `Content-Disposition` 写入 undici `Headers`，触发主进程 `ByteString` 崩溃；现仅写入 ASCII 安全的 `content-type` / `content-length`。

包内容抽查：`app.asar` / 解压目录中无 `.tools`、无 `ffmpeg.exe` / `ffprobe.exe`。源码中仍保留 `UNICOMP_FFMPEG_*` 环境变量名字符串（开发态注入用），不表示生产包携带媒体引擎。

## 明确未完成

- 代码签名与 SmartScreen 信任链
- 生产媒体组件分发与许可审查
- 自动更新通道
- SBOM / 供应链准入
- macOS 构建与公证
- 正式发布门禁与版本冻结

以上项仍属阶段 10 后续专项，不得因本试验包宣称发布就绪。
