# UniComp 安装图标

图标沿用 `src/assets/brand/unicomp-mark.png` 的现有品牌图形。为保证深浅桌面背景都可辨认，桌面应用图标使用浅色圆角底板；应用内原始 Logo 不变。

- `icon.ico`：Windows 主程序、安装程序及卸载程序，包含 16、20、24、32、40、48、64、128、256 像素图层。桌面和开始菜单快捷方式使用已嵌入主程序的图标。
- `icon.png`：1024×1024，Electron 窗口使用；随应用打入 ASAR，开发与安装环境均可读取。
- `icon.icns`：macOS 打包图标资源。提供资源不表示 macOS 构建、签名、公证或实机验收已完成。
- `installer-header.bmp`：150×57、24 位 RGB，当前 NSIS 向导安装器的顶部 Logo。

需要调整资源时，在仓库根目录运行 `python scripts/generate-app-icons.py`（Python 3 + Pillow）。正常应用构建直接使用这些已生成文件，不依赖 Python。生成器只读取现有 Logo，不访问网络；原始素材为 149×167 PNG，高分辨率输出是重采样，后续有正式矢量原稿时可替换生成源。

安装包图标配置在 `electron-builder.yml`。Windows 的应用 ID 与运行时任务栏分组保持 `com.unicomp.desktop` 一致。修改图标后需要重新打包；已有安装包及已安装快捷方式不会仅因源码改变而更新。
