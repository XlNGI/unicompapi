# 实际启动目录会话修复证据（2026-10-17）

本轮针对负责人真实截图中的先讨论误制作、已有 PPT 后本地准备失败和错误提示失真。实际验收对象为原启动目录，不将工作树启动成功视作用户窗口已加载修复。

- [修复记录](../../current/conversation-discussion-runtime-fix-20261017.md)
- [最终机器验证](validation.json)：实际目录、分支基线、命令、结果、限制及副作用。
- [源码快照](source-snapshot.json)与[构建快照](build-snapshot.json)：最终验收后逐文件重验 SHA-256；只保存清单，不收录构建二进制。
- [默认模式](electron-native.json)、[模板兜底](electron-fallback.json)、[旧存储模式](electron-legacy.json)：真实隐藏 BrowserWindow、生产 preload/IPC、本地文件和渲染，Provider 为隔离进程内 Transport。
- [进程与端口核对](process-cleanup.json)：仅记录归属，不结束用户实例；测试没有启动新的开发服务器。
- [原始日志清单](log-manifest.json)：每份原始日志 gzip 后逐字节核验解压结果及 SHA-256。

每种 Electron 模式都检查三个讨论场景：首次先讨论天空内容、同一会话质问误生成、已有真实 PPT 后继续讨论。全部要求 completed、无额外语义规划、无写工具和无新增 Work；生成/修改/实际文件读回作为其他独立场景检验。

最终日志为 typecheck.log、lint.log、build.log、node-ui.log、platform-audit.log、regression-final.log、vitest-full.log 和三个 electron 模式日志。包含 before、interrupted、diagnostic、intermediate 或 worktree 前缀的日志是过程证据，不表示最终全量结果。定向套件包含在全量中，不重复加总。

最终整仓命令使用最多 2 个 worker、每项 15 秒测试框架上限；未改变产品执行预算、工具超时、取消门禁或专门的性能断言。原有 73 条意图黄金样本没有改写，明确取消的兼容语义保持。

只读诊断访问了截图所指会话的失败码和必要元数据；未导出完整会话/附件，未写用户项目、读取真实凭证、调用真实模型或重发用户请求。源码移植在原视频分支的本地工作区完成，保留既有视频提交及未提交资料，没有切换分支、合并历史或推送。实际文件回退镜像保留于本地忽略目录。

修复代码和本轮证据同步到独立会话工作树，但验收目标始终是机器记录里的 actualStartupDirectory。此前 4110 项和启动恢复记录均是早期快照；不追认为本轮验收。真实模型回答/审美、实际用户 PPT 逐页效果和 macOS 实机没有本轮通过结论。
