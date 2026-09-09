# 会话自然语言执行优化实施记录

更新时间：2026-09-09

负责人已授权直接实施 D-01～D-03。本轮完成范围：问答与 Office 意图识别、附件引用和问答、受控语义规划、取消与恢复、多 Office 顺序交付、文档结果结算及重复 Work 防护。

负责人随后明确要求上传代码、合并 `develop` 并确保本地与仓库同步。本次交付在独立工作区 `E:\unicompapi-conversation-integration`、分支 `feature/conversation-natural-language-integration` 进行，基于 `origin/develop` 的 `df6905e`。交付只转入本轮会话优化及必要维护事实说明，保留远程底栏变更；原工作区未合入的性能提交、其他未提交维护改动及既有删除状态不随本次交付转入。

已落地的关键行为：

- 取消、纠正和问答优先于旧任务字段；明确的礼貌创建、主题“如何”、分析后创建和否定风格约束均保留语义。
- 语义分类器通过现有 Provider、授权、参数 schema 和审计链路执行单次有界调用；超时、非法结构、越权目标和迟到结果均失败关闭。
- 选定附件按项目、会话、文件 Hash 固定引用，支持全文预算内读取、问题片段定位、版本变化检测、图片元数据边界和注入文本隔离。
- 长附件摘要最多 4 段、每段 8000 字符、每段最多 1000 输出 token、总时限 120 秒；逐段缓存并校验连续全文覆盖，未知外部结果禁止自动重发。
- 文档生成成功只有在文件、内容、布局、Hash 和 Work 登记完成后才推进工作流。多个 Office 交付物按顺序执行，部分成功保留；已知本地失败复用已完成模型正文和持久化渲染参数，只重做失败文件步骤。
- 启动恢复会中断孤儿响应、投影 assistant 失败状态，并尝试结算已持久化的文档 Work；快速响应绑定竞态、重复点击、规划取消和关闭期间迟到结果均有保护。

原工作区验证结果（`E:\unicompapi`，`feature/conversation-natural-language`；该工作区同时含其他维护改动，以下结果不替代本次隔离集成验收）：

- `pnpm.cmd exec vitest run tests/application tests/domain tests/platform validation tests/evaluation`：193 个文件、1284 个用例全部通过。随后完善生成指纹中的父作品、配图和文档结构，同范围定向 4 文件、67 项再次通过。
- Node 合同测试：364/365 通过；唯一失败为工作开始前已缺失的权威交接包 `manifests/SHA256SUMS.txt`。
- `pnpm.cmd run typecheck`、`pnpm.cmd run lint`、`pnpm.cmd run build` 已通过；`audit:platform` 与 `verify:phase9-closeout` 已通过。
- `pnpm.cmd exec electron scripts/verify-conversation-runtime.cjs`：退出码 0，6 项检查通过，覆盖生产 preload/IPC、礼貌 PPT、自然语言取消、多 Office 顺序、附件问答与清空、新会话隔离和非法 renderer schema；无网络请求、无模型调用、无付费生成。脚本在断言完成后有界退出；Chromium 锁定的专用临时目录可能延迟清理。

限制与后续：本次未执行真实外部模型、联网检索或付费 Office 端到端任务；因此不宣称真实模型成功率、统计数据准确率、费用指标或外部服务可用性。macOS 保持合同约束但未实测。原工作区 `pnpm.cmd test` 与 `verify:handoff` 的 checksum 阻断保留为该工作区事实；隔离交付工作区重新运行门禁并单独记录。多交付物当前为 Word/Excel/PPT 各最多一份；同类多份、跨文件同时修订和超预算全表统计会明确提示范围。媒体会话入口、新搜索供应商和额外 OCR/视觉能力仍不在本轮范围。

隔离集成验收（2026-09-09，功能提交 `91942e4`，基线 `df6905e`）：

- `pnpm.cmd test`：退出码 0；Node/UI 合同 358/358，Vitest 194 个文件、1271/1271 个用例，零失败、零跳过。
- `pnpm.cmd run typecheck`、`pnpm.cmd run lint`、`pnpm.cmd run build`：全部退出码 0；构建包含 Electron 主进程编译。Vite 保留既有 CJS 与大 chunk 提示，不包含另一个本地性能分支的路由拆分。
- `pnpm.cmd run audit:platform`：退出码 0，扫描 423 文件，无违规。
- `pnpm.cmd run verify:handoff`：退出码 0，50 条 checksum、27 个资源均通过；隔离区使用仓库已有原件，原工作区删除状态未更改。
- `pnpm.cmd run verify:phase9-closeout`：退出码 0，Windows 必需套件与恢复审计通过；macOS 实机验证仍为既有延期项。
- `pnpm.cmd exec electron scripts/verify-conversation-runtime.cjs`：退出码 0，Electron 33.4.11 的生产 preload/IPC 六项检查通过；网络请求与模型调用均为 0。
- `git diff --check`：通过；独立审查确认新文档任务兼容远程现有底栏读取链路。

隔离环境复用与原工作区相同 lockfile/依赖，并通过 junction 使用已有本地 FFmpeg。pnpm 12 设置单次进程变量 `pnpm_config_verify_deps_before_run=warn`，避免因隔离工作区路径变化而重装共享依赖；依赖清单和锁文件没有修改。首轮媒体测试因 FFmpeg 路径缺失跳过 5 项，接入现有本地工具后已重新执行完整测试并全部通过。测试生成的 Office 临时目录已移至工作区外，不参与提交。

交付方式：功能提交和本验收记录保留在 `feature/conversation-natural-language-integration`，按负责人明确授权上传并以合并提交纳入 `develop`；功能分支保留。最终合并号及本地/远程一致性以 Git 引用和本次交付回复为准。原 `E:\unicompapi` 的其他维护改动、旧性能提交和既有交接包删除状态保留，已验收的同步工作区为 `E:\unicompapi-conversation-integration`。
