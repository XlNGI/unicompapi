# 安装包与快捷方式图标修复

日期：2026-09-11。负责人反馈安装包和快捷方式没有设置 Logo。按当前维护决策处理安装品牌资源，不恢复旧交接资料，不启动商店提交或修改业务功能。

## 实际修改

沿用当前 `src/assets/brand/unicomp-mark.png`，新增 `build-resources/icon.ico`、`icon.png`、`icon.icns` 和 `installer-header.bmp`。Windows ICO 含 16、20、24、32、40、48、64、128、256 像素图层；黑色标志置于浅色圆角底板，在深浅桌面上均可辨认。原图为 149×167 PNG，高分辨率输出为重采样，不冒称已有矢量原稿。

`electron-builder.yml` 为主程序、安装程序、卸载程序配置同一 ICO；当前 `oneClick:false` 的向导使用 150×57 BMP 页眉。单击进度图标字段也有配置，但不把该字段视为当前向导页眉的实现。桌面/开始菜单快捷方式由 electron-builder 的 NSIS 模板指向安装后的 UniComp.exe，IconLocation 同为主 EXE、索引 0，因此继承已嵌入的应用图标。

`electron/main.ts` 通过 `app.getAppPath()/build-resources/icon.png` 设置窗口图标，PNG 用独立 files 映射打入 ASAR。Windows AppUserModelID 与安装配置保持 `com.unicomp.desktop` 一致。macOS 提供 ICNS 资源及配置，未执行 macOS 构建、签名、公证或实机验收。

`scripts/generate-app-icons.py` 可由维护者以 Python + Pillow 重新生成资源；正常构建直接使用已生成文件，不增加应用运行时依赖。资源说明见 `build-resources/README.md`。

## 真实验证

- 实际执行 TypeScript/Vite/Electron 生产构建，以及 electron-builder 25.1.8 Windows x64 NSIS 打包，均通过；类型检查、定向 lint、平台审计、配置 Schema、打包 matcher 和差异检查通过。
- 检查 ICO 的 9 个尺寸及 ICNS/PNG/BMP 结构，查看 16～64 像素在深浅背景下的真实预览。
- 用 Windows 资源 API 以只读数据方式打开主程序和安装程序，逐帧提取 PE 图标，全部 9 个尺寸的图像数据 SHA-256 与源 ICO 一致。
- ASAR 内 icon.png 与源文件完全一致；编译 main.js 与最终编译产物一致，包含窗口图标和 AppUserModelID；应用包无项目 `.tools`、tests、docs、tmp、validation 等目录。
- NSIS 模板和有效配置确认快捷方式目标/图标索引及卸载程序图标接线。没有执行安装或改写用户桌面/开始菜单/注册表，因此不声称已经验证用户实际安装后的快捷方式或卸载行为。

第一次打包因本机无法解压工具包中的 macOS 符号链接失败；保留失败日志。随后从同一次官方工具下载的归档中提取 Windows 工具到本地专用缓存，保持图标资源编辑功能开启，重新打包成功。标准缓存中原先不存在的 `winCodeSign-2.6.0` 也已补齐 Windows 工具，未删除原缓存或修改系统权限。未配置签名凭证，样包未签名。

## 交付与边界

实现位于从 develop `3e2fc80` 创建的 `feature/windows-package-icons`，并已将同样的配置、main.ts 增量和资源同步到当前主工作区，后续主工作区打包会使用新图标。开始时的 29 个修改/未跟踪文件先逐项校验未变，之后仅在 PLANS.md 顶部追加本轮维护记录；之前删除的资料继续保持删除。未切换主工作区分支，未自动合并、推送或重启当前应用。

本次安装包仅作为图标工程验证样包，源码基线为 `3e2fc80` 加本轮图标修改，不包含主工作区尚未提交的对话/联网体验修复，也不作为正式上架包。正式媒体组件、签名、商店身份和安装环境验收仍按发布准备任务单独处理。

样包位置：隔离工作树 `release-nsis/UniComp-0.1.0-setup-x64.exe`，128149528 字节，SHA-256：`E8E7C5D0C0CD2BC53D2F159F074B7EF926E807553FF72151DC3574EF1EEC9ECC`。本地证据：隔离工作树 `tmp/icons-package-final.log`、`tmp/icons-pe-proof.json`、`tmp/icons-asar-proof.json`、`tmp/icons-preview.png`。打包结果和开发工具不进入 Git。

下一步重新构建实际交付版本后安装复验；现有旧安装包不会因源码配置更新而自动换图标。
