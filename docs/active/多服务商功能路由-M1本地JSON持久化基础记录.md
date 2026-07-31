# 多服务商功能路由 M1｜本地 JSON 持久化基础记录

日期：2026-07-31

分支：`feature/local-json-persistence-foundation`

执行基线：`develop@5542e20`

实现提交：`f0e6ecc`

验收方式：项目负责人授权 Codex 按冻结门禁自行验收；全部条件通过后允许非快进合并 `develop`。

## 一、批准边界

本分支只修改本地存储、JSON 仓储、相关测试和工程记录。未修改 React 页面、页面样式、preload、Electron 页面组合、服务商适配器或真实网络调用路径。

项目负责人允许普通工程联网且未设置通用费用上限；但本分支合同明确禁止真实 HTTP、凭证验证、收费调用和 Vidu 预算恢复，因此本次真实服务商请求为 0，实际费用为 0。该授权不继承到后续分支。

## 二、实际实现

- 冻结应用级与项目级相对路径；新增项目元数据单元和 SubmissionIntent journal 路径；
- 建立按规范化绝对路径共享的可重入写入协调器，多路径锁按稳定顺序获取；不同仓储实例和不同 `NodeProjectStorage` 实例写同一路径不再使用各自独立队列；
- 扩展项目存储端口，提供共享独占访问、原子 JSON 变更、主文件/有效备份读取和可选备份写入；保留同目录临时文件、文件 `fsync`、原子替换和目录同步；
- 新增故障注入阶段，证明替换前中断不会破坏旧主文件且不遗留临时文件；
- 新增通用 Schema envelope、revision、显式顺序迁移、只读 legacy 读模型和敏感字段拒绝规则；
- 新增 `ProjectMetadataUnitOfWork`，提供单文件事务边界、revision/CAS、稳定键序和有效备份；
- 新增追加式 SubmissionIntent journal，严格验证阶段转换、事件幂等键和不透明标识；
- 恢复扫描明确区分：未 claim 的意图丢弃、已 claim 未请求则释放 claim、请求已开始但结果未知则标记 `unknown_outcome` 且禁止自动重试、服务商已接受则只允许按原路由 query/cancel/receive_result；
- 通用实体仓储升级为带 revision 的 V2 集合并兼容读取 V1；文件索引和 ProviderOperation 文档增加 revision；会话、项目上下文和设置仓储接入共享路径协调；
- 保留并继续使用既有文件索引重建服务；索引仍为可重建数据，不成为事实源。

## 三、验证结果

- `npm.cmd test`：Node 178 项、Vitest 395 项，共 573 项通过，0 失败、0 跳过；
- `npm.cmd run typecheck`：通过；
- `npm.cmd run lint`：通过；
- `npm.cmd run build`：通过；
- `npm.cmd run audit:platform`：223 个文件，0 违规；
- `npm.cmd run verify:handoff`：50 个校验项、27 个资源，0 失败；
- `npm.cmd run verify:recovery-audit`：16 个恢复用例、9 类故障、7 个域、5 条不变量、17 个证据引用通过，安全违规和禁止制品均为 0；
- `git diff --check`：通过。

本分支新增 7 项专项平台测试，覆盖跨实例共享写入、CAS 冲突、有效备份、替换前故障、顺序迁移、秘密不落盘、journal 幂等和四类恢复决策。设置仓储的并发用例同步加强为两个独立仓储实例竞争同一 revision。

## 四、未包含项

- 本分支只产生恢复决策，不提前实现全局授权账本的真实 release/commit，也不发起远端 query/cancel/receive_result；
- 未创建 ProviderInvocation、Usage、RouteSnapshot 或供应商 Package 的业务合同；
- 未修改快速生图、快速视频或其他 UI；
- 未联网验证任何凭证，未发起 Vidu 或其他服务商请求；
- macOS 实机与媒体工具链继续延期。

## 五、验收结论

本分支满足批准范围和合并条件，自验收结论为 `passed`，允许非快进合并 `develop`。合并后立即停止，不自动启动 `feature/vidu-runtime-authorization-closure`；M2 第一支仍需项目负责人单独批准。
