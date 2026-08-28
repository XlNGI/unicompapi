# Windows 安装包 ExcelJS 运行时依赖修复记录

日期：2026-08-28

分支：`feature/fix-windows-packaged-dependencies`

适用范围：阶段 9 收口后的 Windows x64 本地未签名测试打包修复；不代表阶段 10 正式完成。

## 问题

安装 `UniComp-0.1.0-setup-x64.exe` 后，Electron 主进程启动时抛出：

```text
Error: Cannot find module 'tmp'
Require stack:
- exceljs/lib/xlsx/xform/book/workbook-reader.js
- exceljs/exceljs.nodejs.js
- exceljs/exceljs.js
- office-document-generator.js
```

主进程因此在创建正常应用窗口前退出。

## 根因

`exceljs@4.4.0` 的生产依赖包含 `tmp@0.2.7`。原 `electron-builder.yml` 使用以下递归排除：

```yaml
- '!**/tmp{,/**}'
```

该规则不仅排除项目根目录临时文件，也会匹配并删除 Electron Builder 收集到的 `node_modules/tmp`。同类 tests/docs/.tools/.cache/temp 规则也存在误删同名生产依赖的风险。

## 修复

- 将上述目录的排除规则限定为项目根目录，不再使用 `!**/<name>`。
- 保留 `.tools/`、根目录临时目录和开发资料不进入安装包的原有边界。
- 新增 `tests/windows-packaging-contract.test.mjs`，拒绝会递归删除同名生产依赖的配置。
- 未写死或复制 `tmp` 包；生产依赖仍由 pnpm 锁文件与 Electron Builder 正常收集。

## 验证

- 新合同测试通过。
- 默认全量 `pnpm test` 通过。
- `pnpm typecheck`、`pnpm lint`、`pnpm build`、`git diff --check` 通过。
- 修复后的 ASAR 实际包含：
  - `node_modules/tmp/package.json`
  - `node_modules/tmp/lib/tmp.js`
  - `node_modules/exceljs`
- `release-nsis-fixed/win-unpacked/UniComp.exe` 真实启动后，主进程、GPU、网络服务和 Renderer 共 4/4 进程存活；10 秒观察期无缺模块崩溃，关闭后残留 0。
- Electron Builder 成功生成新的 Windows x64 NSIS 安装器与 blockmap。

## 未完成边界

- 安装包未签名，Windows SmartScreen 仍可能提示风险。
- 本机 rcedit 版本资源编辑发生僵死，本次本地测试包继续使用默认 Electron 图标与 Electron 文件版本信息。
- 未完成正式安装/卸载矩阵、代码签名、SBOM、生产更新、正式媒体组件分发和发布准入。
- 不声明阶段 10 已完成，不声明该包可正式对外发布。
