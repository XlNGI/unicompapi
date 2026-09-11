# 软件商店发布准备

日期：2026-09-11。负责人明确目标为“打包，然后上线到软件商店”。当前按 Windows 桌面版准备说明；具体商店尚待确定，以 Microsoft Store 作为首发建议，不代表已授权购买账号/证书或已提交商店审核。

本次只读核对当前源码、打包配置和微软官方文档，未修改业务功能、未生成新安装包、未上传或发布。遵循 AGENTS.md 顶部当前维护决策，不以旧阶段状态阻止本次发布准备。

## 当前事实

- Electron 桌面项目，版本 `0.1.0`。已有 `package:win`（NSIS EXE）和 `package:win:dir` 脚本；配置文件为 `electron-builder.yml`，目标 Windows x64，输出目录 `release-nsis`。
- 当前工作区没有 `release-nsis/` 安装包，尚不能验收安装/升级/卸载行为。已通过的源码和生产 Renderer 测试不等于已安装产品验收。
- 现有配置允许不签名（`forceCodeSigning: false`），未配置 MSIX/AppX 商店身份；`build-resources/` 目录不存在，安装包图标尚未配置。没有检查或读取任何本机签名凭证。
- FFmpeg/FFprobe 依赖本机绝对路径环境变量，`.tools/` 明确排除在包外，没有正式媒体组件分发配置。因此不能保证新用户安装后的视频探测、预览和导出可用。应制定独立发布组件方案和许可清单，不能把开发工具目录直接塞进安装包。
- 当前应用内生产更新源未配置。Microsoft Store 的 MSIX/AppX 路线可采用商店更新；不能向用户宣称已有应用内自动更新。
- 此前源码测试 1615/1615 通过，Node/UI 唯一已知失败为既有交接校验资料缺失。发布前需明确处理该门禁依据和安装版验证，不能将当前状态描述成全部发布门禁通过。

## 两种 Windows 商店路线

| 路线 | 需要准备 | 适用情况 |
| --- | --- | --- |
| Microsoft Store MSIX/AppX | 在 Partner Center 预留名称并取得准确包身份/发布者；配置包、图标与权限；做安装及商店认证测试 | 首发微软商店的建议路线，由商店分发和提供更新 |
| Microsoft Store EXE/MSI | 可基于现有 NSIS；签名安装程序及内部 PE 文件；提供固定版本 HTTPS 直链；支持静默、完整离线安装 | 同时维护官网/其他 Windows 渠道的传统安装包 |

微软官方说明：MSIX/AppX 通过认证后由商店重新签名，不需要为商店提交单独购买 CA 代码签名证书；EXE/MSI 不会由商店重签，需要开发者自行完成受信任 Authenticode 签名。EXE/MSI 下载 URL 必须带版本且提交后内容不可替换；升级时提交新的版本 URL。

其他 Windows 软件商店的账号、主体、软件资质与签名要求需以目标平台后台为准。Mac App Store 是单独的 macOS 打包、沙盒、签名与实机验证工作，当前 Windows 验收不覆盖。

## 建议执行顺序

1. 确定首发商店、个人/企业发布主体、应用名称和公开支持联系方式。在商店开发者后台完成账号验证、预留应用名称；微软 MSIX 路线需取回包身份与发布者字段，这些字段不应猜测。
2. 固定可回溯的发布源码版本；定义首发功能范围，处理正式媒体组件和更新渠道。补全应用图标、安装信息、第三方许可证/组件清单，检查安装包不含项目数据、测试夹具、日志或真实 API Key。
3. 生成本地候选安装包。现有 NSIS 验证命令为 `pnpm package:win`，预期输出 `release-nsis/UniComp-<version>-setup-x64.exe`；这条命令本身不代表商店合格包。MSIX 需另配置与商店身份匹配的打包目标。
4. 在干净 Windows 账户/虚拟机上安装验证：无 Node/开发环境也可启动，项目与凭证存储正确，模型配置和图文请求、Office 文件、媒体能力按首发范围可用；验证覆盖升级、卸载及用户数据保留策略。按路线完成商店认证预检查。
5. 准备真实功能截图、图标、中文简介/详情、分类、年龄分级、隐私政策 URL、支持 URL/邮箱和审核说明。隐私政策如实说明本地文件/凭证存储、用户选择的模型服务商以及联网搜索外发范围。当前产品依赖用户配置服务商/API Key，应在上架介绍和审核步骤中明确，不能宣传为无限免费模型服务；不为上架擅自加入登录、会员或充值。
6. 上传包或登记版本直链，填写可用地区/价格与审核资料，提交审核；审核通过后按商店后台设定发布。上架结果以商店实际审核和发布状态为准。

当前可先完成工程准备和本地候选包；准确商店身份、发布主体及公开政策/支持地址是商店专属配置和最终提交需要的信息，不需要把账号密码或证书私钥发到聊天里。

## 已核对官方来源

仅访问以下公开文档，没有向外部服务发送项目源码、用户资料或凭证；未调用付费模型/搜索接口。核对日期：2026-09-11。

- [Microsoft Store 发布总览](https://learn.microsoft.com/en-us/windows/apps/publish/)
- [MSI/EXE 安装包要求](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msi/app-package-requirements)
- [MSIX/AppX 安装包与签名要求](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/app-package-requirements)
- [开发者账号](https://learn.microsoft.com/en-us/windows/apps/publish/partner-center/open-a-developer-account)

后续第一步：确认首发商店后制作对应的本地候选包，并优先解决安装版媒体依赖和干净环境验收；尚未开始实际商店提交。
