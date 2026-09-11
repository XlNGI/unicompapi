# Microsoft Store 正式发布

当前分支 `feature/microsoft-store-packaging` 已加入 Windows x64 AppX 构建入口，首发版本设为 `1.0.0`，但尚未完成正式包交付。`package:store:check` 只做门禁，不会上传；`package:store` 在 Windows 上构建 `release-store/UniComp-1.0.0-store-x64.appx`，并写出同名 SHA-256 文件。正式包身份、正式媒体分发材料、安装验收及商店认证仍未完成。

负责人最新请求“打包上传微软商店、将 FFmpeg 打包进去、要正式发布”授权本次生产媒体分发接入，覆盖旧阶段禁止 FFmpeg 进入发布物的边界；`.tools` 开发目录和二进制不进入 Git。当前属于整体维护后的发布准备，不重新开启历史功能阶段，不恢复已删除资料。

## 发布前必须准备

1. 在 [Partner Center](https://partner.microsoft.com/dashboard) 注册并完成开发者验证，创建应用、预留名称，打开“产品管理 → 产品标识”，将真实身份写入 `config/microsoft-store.local.json`。该文件已忽略；这里需要公开身份信息，不需要提供账号密码或私钥。
2. 工程侧准备固定、可回溯的 LGPLv3 FFmpeg 分发组件及对应源码/依赖/构建材料，放在 `build/production-media/media-engine/`。本次脚本按 LGPLv3 组件结构校验，未泛化到其他许可证方案。版本和 Hash 校验通过只能证明材料一致，不能证明源码及第三方许可内容已经完整。
3. 应用版本已经设为 `1.0.0`，AppX 清单版本为 `1.0.0.0`；后续更新须递增前三段，第四段保持 `0`。FFmpeg 使用自身版本号，不要求与应用版本相同。目标 x64，最低 Windows 10 22H2（10.0.19045.0）。

| 本地配置字段 | Partner Center 内容 |
| --- | --- |
| `identityName` | `Package/Identity/Name` |
| `publisher` | `Package/Identity/Publisher`（完整 `CN=...`） |
| `publisherDisplayName` | `Package/Properties/PublisherDisplayName` |
| `displayName` | 已预留的应用显示名称 |

初始化身份配置后填写准确值：

```powershell
Copy-Item config/microsoft-store.example.json config/microsoft-store.local.json
```

媒体清单模板 `config/media-engine-production.example.json` 复制为组件根目录的 `media-engine.json`；`config/media-engine-source.example.json` 复制为 `source-information.json`。必须包含：

```text
build/production-media/media-engine/
  media-engine.json
  source-information.json
  bin/ffmpeg.exe
  bin/ffprobe.exe
  bin/<清单列出的依赖 DLL，可选>
  licenses/LGPL-3.0.txt
  licenses/GPL-3.0.txt
  licenses/THIRD_PARTY_NOTICES.txt
  licenses/SOURCE.md
  sources/<完整对应源码及构建材料.zip 或 .tar.xz>
```

`SOURCE.md` 说明对应源码、构建配方、依赖及修改，`THIRD_PARTY_NOTICES.txt` 包含实际依赖的许可与署名；源码可分多个归档。`bin` 目录与二进制清单必须完全一致，禁止未列出的 DLL 或路径链接。仅校验过的清单、二进制、源码归档和四份许可说明文件随包分发。安装后的媒体探测、缩略图和导出共享 `resources/media-engine` 中的引擎；资源损坏时应用继续启动并显示不可用，不回退到开发环境变量。

## 构建与验证

```powershell
pnpm package:store:check
pnpm package:store
Get-FileHash release-store\UniComp-1.0.0-store-x64.appx -Algorithm SHA256
```

脚本使用 electron-builder 25 的 `appx` 目标，Microsoft Store 接受这种格式。脚本会先删除同名旧产物，构建成功后重新检查媒体组件、产物并生成 Hash，防止把残留包或构建中被修改的媒体二进制误报成功。AppX 内配置独立 `Application.Id=UniComp`、品牌图标与系统分配的应用身份。

构建之后，在隔离 Windows 测试环境安装验收：首次启动、设置、模型配置与对话、文件选择/写入、文档生成、视频缩略图、软件导出、卸载与更新。未签名 AppX 不能直接当作受信包侧载；本地测试需用测试证书签名并仅在测试机信任，或通过 Partner Center 的受控测试分发取得商店签名包。测试签名不冒充正式签名。本机已发现 Windows App Certification Kit，可在候选包安装后运行并保存报告。

Partner Center 提交还需要应用简介和详情、真实截图、隐私政策 URL、支持方式、年龄分级、定价/市场和审核说明；当前需要用户配置模型服务商/API Key，应在介绍与审核步骤中如实说明。`runFullTrust` 用于 Electron 桌面运行、本地文件处理及 FFmpeg 子进程，应填写实际用途。提交审核通过且发布后才是正式上架。上传 AppX 的商店路线由微软签名，不需要为该上传路线购买商业签名证书；这不适用于独立 EXE/MSI 分发。

## 当前媒体阻断和实际补齐路线

现有开发二进制实际为 `n8.1.2-30-g45f1910444-20260723`，与开发清单记录版本不同。它启用了 `--enable-version3`，未启用 GPL/nonfree；只有 LGPL 文本不足以覆盖全部静态链接依赖。FFmpeg 对应提交是 `45f1910444f34b02621f9f0426ea1a538a613c41`，对应 BtbN 日构建产物已过期。未将其复制到生产媒体目录。

新候选 BtbN `autobuild-2026-09-10-15-31` 的 win64 LGPL 8.1 版本是 `n8.1.2-51-g7ba069f4f1`，源码提交 `7ba069f4f11d126f52a740156dbab6476a8a865a`。release 只提供二进制和校验值；自动生成的 Source code.zip 只含构建脚本。Actions 的 dependency download-cache 是对应源码候选，尚未取得或验证，不能声称材料已完整。

工程侧后续固定构建配方和所有依赖提交，取得完整源码缓存或逐项归档，再确认二进制对应关系；无法确认则从固定源码重建，同时产出二进制、完整源码、许可和构建记录。当前本机虽有 MSVC/CMake/Ninja 和 Git Bash，但缺 GNU make/pkg-config/依赖开发包，WSL 无发行版、Docker daemon 未启动，尚无完整构建环境。导出必须保留 `libvpx-vp9`、`libopus`、WebM、图像输出、`drawtext`/Fontconfig 等滤镜；简单换成只有 H.264/AAC 的精简包会破坏现有功能。

## 本次验证

- TypeScript、Electron 编译、生产构建、全量 lint、平台审计通过；构建资源 `index-B4C8vmhj.js` / `index-cuCteA3P.css`。
- 全量 Vitest 214 文件、1652/1652 通过；运行时新增 21 项及设置行为测试通过。
- Node/UI 最终 369/370，唯一失败仍为此前已删除的 handoff `SHA256SUMS.txt` 缺失；未恢复删除资料或跳过该项。打包定向 Node 9/9 通过。
- 隔离资源目录真实媒体检查通过：Hash、能力探测、MP4 probe、VP9 软件导出及文件验证。证据 `tmp/store-media-smoke-ILg4a2/results.json`。使用开发二进制测试运行时接线，不构成正式分发组件或商店安装验收。
- 早期 AppX 构建已通过，但使用合成身份且不含新媒体组件，不能上传。正式 `package:store:check` 当前在缺少身份时如实停止，未生成可上传正式包、未签名安装、未提交审核。
- 最终接线的真实 AppX 验证包再次构建成功，284,056,568 字节，SHA-256 `46dc1fc02b8e299d3f8479defb406c0b922eab5078d287a4ad024a4cfbaac4e9`。检查了 AppX 清单、两个嵌入二进制 Hash、无 `.tools` 路径，以及打包后资源目录的真实能力探测。证据 `tmp/store-packaged-runtime-validation/verification.json`；此包使用合成身份和开发媒体夹具，没有通过生产素材门禁，仍不可上传，不作为正式交付。
- 一次测试命令误将 Node 用例交给 Vitest 并扫描临时工作树，产生“无测试套件”；纠正框架和搜索范围后定向通过，全量验收只统计正式源码测试。真实付费 API 调用 0，测试未写真实用户项目。

官方参考：[包要求](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/app-package-requirements)、[身份字段](https://learn.microsoft.com/en-us/windows/apps/publish/view-app-identity-details)、[桌面能力声明](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/app-capability-declarations)、[FFmpeg 分发说明](https://ffmpeg.org/legal.html)。
