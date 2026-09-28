# 阶段 9 B2｜Windows 文件与安全存储证据摘要

日期：2026-07-28
源提交：5db899f
目标：windows-x64-primary

## 环境

- Windows：10.0.19045
- 架构：x64
- Electron：33.4.11
- Electron Node：20.18.3
- 工作区 Node：26.5.0

## 已执行

- `npm.cmd test`：Node/UI/工具链 140 项、Vitest 267 项，共 407 项通过，0 失败、0 跳过；
- `npm.cmd run typecheck`：通过；
- `npm.cmd run lint`：通过；
- `npm.cmd run build`：通过；
- `npm.cmd run audit:platform`：扫描 180 个生产侧文件，18 处直接平台访问、47 处平台字面量，0 违规；
- `npm.cmd run verify:handoff`：50 条 SHA-256 与 27 个资源 Hash/字节匹配；
- `npm.cmd run verify:secure-storage`：`safeStorage` 可用，密文字节 95，加密/解密闭环一致，密文字节不包含测试明文；
- Windows 真实文件系统测试：Unicode NFC、空格、深层长路径、Windows 保留名、目录联接逃逸、原子写入、注册表备份恢复、凭证重启/回滚和敏感产物脱敏通过；
- 真实 FFmpeg 测试已执行。

## 未执行

- Windows 可见原生目录选择器授权、撤销和重新授权；
- macOS 全部文件、目录书签、外接卷和 `safeStorage` 实机用例。

本摘要不包含用户名、主机名、绝对路径、凭证、Hash 原值、用户文件或媒体样本。
