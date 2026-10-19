# WWW 模型合同入口与启用校验修复

2026-10-19。负责人在模型适配审计后明确要求“实行”，据此实施审计中的文本合同入口和启用状态修复。当前属于维护，依据最新负责人决定、AGENTS.md、PLANS.md 顶部记录、当前源码及[本轮前置审计](model-adaptation-audit-20261019.md)，不按历史阶段推进，不覆盖权威交接原件。

分支为 `feature/www-model-binding-repair-20261019`，从 `develop@e29b7a8` 创建；基线完整提交以[机器记录](../evidence/model-binding-repair-20261019/validation.json)为准。本轮未提交、合并、推送或发布。原有启动恢复的 Vite 监听排除、PLANS.md 记录与证据继续保留。

## 实际修改

- 合同选择器为 WWW 显示型号精确匹配的厂商文本合同。已有精确网关视频合同的型号继续只显示对应网关合同，不混入厂商文本合同。已确认使用相同文本协议的中转别名，可主动开启“显示其他已确认兼容的文本合同”；已有别名绑定仍可查看。打开列表不会自动绑定或启用。
- Host 启用前要求存在可用功能配置，并核对功能、服务包、协议、连接发布的适配器及合同的连接/凭证版本。无配置或绑定版本过期时返回 `model_profile_unavailable`，界面给出适配/重新确认提示。停用继续允许；保留旧媒体多配置路径及九个精确 WWW 视频合同的既有自动接线。
- 模型管理列表及详情准确显示“待适配”或“已绑定”；“已绑定”仍是 declared，不代表真实调用验收通过。
- 真实 Electron 连续切换型号时发现合同组件与联网搜索区域使用相同的 React sibling key，旧合同表单可能残留。两者增加不同 key 前缀，确保切换后只显示当前型号的合同表单。

业务修改范围为 `src/pages/providers/ModelContractBinding.tsx`、`ProviderManageView.tsx`、`provider-page-shared.ts`、`src/platform/providers/provider-management-framework.ts` 与 `src/shared/provider-ipc.ts`。新增/更新相关组件行为、Host 管理及 UI 合同回归，增加真实 Electron 页面验证脚本和隔离 harness。未修改依赖清单或锁文件。

六个恢复手动绑定入口的精确型号如下；它们使用既有来源合同，本轮没有新增协议或来源声明：

| 型号 | 合同 |
| --- | --- |
| `deepseek-v4-flash` | `official.deepseek.v4.chat` |
| `glm-4.6` | `official.zhipu.glm-4.6.chat` |
| `glm-4.7` | `official.zhipu.glm-4.7.chat` |
| `glm-5.2` | `official.zhipu.glm-5.2.chat` |
| `kimi-k2.6` | `official.moonshot.kimi-k2.6.chat` |
| `kimi-k3` | `official.moonshot.kimi-k3.chat` |

## 验收与证据

| 检查 | 实际结果 | 证据 |
| --- | --- | --- |
| 全量 Vitest | 348 文件、3466/3466，0 失败/跳过 | [JSON](../evidence/model-binding-repair-20261019/vitest-full.json)、[日志](../evidence/model-binding-repair-20261019/vitest-full.log) |
| 最终相关 Vitest | 9 文件、125/125，0 失败/跳过 | [JSON](../evidence/model-binding-repair-20261019/targeted-final.json) |
| 最终 Node/UI | 393/393，0 失败/跳过 | [日志](../evidence/model-binding-repair-20261019/node-ui-final-fixed.log) |
| 类型检查 | 通过；最终生产构建再次执行生产源码类型检查 | [日志](../evidence/model-binding-repair-20261019/typecheck.log) |
| 全仓 lint、生产构建 | 均通过；构建保留既有 Vite CJS/大 chunk 提示 | [lint](../evidence/model-binding-repair-20261019/lint-final.log)、[构建](../evidence/model-binding-repair-20261019/build-final.log) |
| 平台审计 | 通过，violations 为空 | [日志](../evidence/model-binding-repair-20261019/platform-audit.log) |
| 隔离真实 Electron | 10 场景通过，Renderer 错误 0，凭证读取 0，外部请求 0 | [记录](../evidence/model-binding-repair-20261019/electron/validation.json)、[截图](../evidence/model-binding-repair-20261019/electron/video-bound.png) |

全量 Vitest 执行期间及结束后补了 Toggle 标注和 React key 修正，随后重跑上述最终相关 125 项、Node/UI、lint、生产构建及真实 Electron；不将全量结果表述为最终源码冻结后的再次全量回归。全量 Node/UI 与 Vitest 合计 3859 项；125 项为重叠复验，不重复累计。Electron 10 场景另计。

Electron 验证使用实际 ProvidersPage、生产编译 preload、真实 IPC 注册和 Host，以及操作系统临时目录中的合成注册表。覆盖无配置文本启用拒绝、六型号逐个精确选合同/绑定后仍停用/显式启用、无图片适配器拒绝、视频合同隔离、别名主动展开；真实 React 切换覆盖了残留表单问题。未使用用户实际注册表进行写入。

主要复现命令：`pnpm typecheck`、`pnpm lint`、`pnpm build`、`pnpm audit:platform`、`node --test tests/*.test.mjs tests/ui/*.test.mjs`、`pnpm exec vitest run tests/application tests/domain tests/platform validation tests/evaluation --maxWorkers=1 --minWorkers=1`；实际 Electron 使用构建后的 `node scripts/verify-provider-model-binding.cjs`。汇总与原始文件 Hash 见[机器验收记录](../evidence/model-binding-repair-20261019/validation.json)。

## 中间失败与处理

原始记录保留，不用最终成功覆盖失败：

- 首轮 Host 测试夹具错误使用不合法的 accessCategory，改为实际允许的 `online` 后，复现无配置启用及过期 pin 被放行；修复后更新两个明确依赖旧行为的管理断言。
- 最初 Electron 选择器假定 RSuite 保留输入 aria-label，实际被组件 locale 覆盖；改为按模型行定位 switch。早期 Electron 在 Chromium 退出前清理 userData 触发 EBUSY，后改由 Node 父进程在子进程退出后清理精确临时目录。
- 连续切换模型暴露实际重复 React key 问题，修复后 Electron 10 场景全部通过；早期 failure.json/html/png 保留，内容仅为合成数据。
- 最终 Node/UI 首次复验仍有一个静态断言要求旧 key；更新为两个不同 key 的断言后 393/393 通过。
- 自动审批以 `blocked by policy` 拒绝清理早期验证遗留的 `uc-model-binding-electron-17248` 临时目录，未提供更具体原因；没有绕过清理。该目录保留，不影响修复和验收，后续成功运行由正常父进程清理其自身临时目录。

## 配置、未完成项与下一步

实际注册表仍是审计时的 52 模型、9 个视频绑定、43 个未绑定快照；没有把六个文本合同自动写入用户配置，也没有改变现有启用状态。只读 Hash 复核仍为 `c09ecacf4bb11e9287e0b29fe5d2cfb8f31fe8be8aa58bba036dff75b9786e52`。未读取真实凭证、用户项目或执行收费模型调用，未联网检索或请求网站新目录，未重启现有应用。

六型号的实际网关协议兼容和真实服务验收仍未确认；手动绑定要求用户确认兼容声明。其余 37 个无精确来源候选的型号与 WWW 图片适配器/提交/结果/费用协议仍未实现，本轮不能宣称 52 模型全部可用。10 月 15 日未知原单与预算边界继续有效，macOS 未实机验收。

本轮没有阻断已完成修复的剩余事项。下一步正常重启当前开发应用，使新主进程启用校验生效，再按已确认的兼容关系手动绑定及启用所需文本型号；后续另行核对缺失来源与图片协议。现有运行窗口未代为重启。
