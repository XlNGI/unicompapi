# 服务商画廊与连接编排 PR 1｜连接编排管线工程记录

日期：2026-08-05

分支：`feature/provider-connection-orchestration`（自 `develop` 建立）

提交：

```text
9e68629 feat: orchestrate connection save with pre-validation and catalog sync
28f6efe docs: track phase 9 final UI and routing authority document
3678b9b docs: approve provider gallery and connection orchestration plan
```

权威计划：`docs/active/服务商画廊与连接编排分阶段实施计划.md`（项目负责人 2026-08-05 批准并授权连续托管）。

## 一、本支范围

只做 PR 1「连接编排管线 + OpenAI 兼容管理探针生产装配」。不包含画廊 UI、Vidu 拉平、路由动态化、代码收编（PR 2—5）。

## 二、关键发现

NewAPI 与 DeepSeek 的管理适配器（`NewApiManagementAdapter`、`DeepSeekManagementAdapter`，均实现 `validateConnection` + `discoverModels`，走 `GET {endpoint}/models`）在阶段 9 已由专项批准实现并测试，但从未在生产装配——`electron/main.ts` 的管理适配器注册表被显式初始化为空数组。PR 1 的实际缺口是：生产传输层、注册装配与「验证 → 落库 → 拉目录」编排管线，而不是探针本身。

## 三、实现内容

1. `src/platform/providers/provider-management-framework.ts`
   - 新增 `addConnection(input, progress?)` 编排方法：解析请求（新增可选 `allowUnavailableSave`）→ 模板无免费验证或未装适配器时回退纯保存（`saved`，`validated=false`）→ 否则用瞬态草稿连接（不落库）调管理适配器探针 → 验证失败且未强制时返回 `connection_validation_failed`（消息携带远程 safeCode），连接、凭证、注册表零落盘 → 通过后 `persistConnection` 落库（复用原三次重试与审计）→ `applyValidationObservation` 以修订守卫回写验证观测 → 目录类模板自动 `syncModelCatalog`；目录失败保留已验证连接并返回 `catalog: 'failed'` + 警告码。
   - 步骤事件：`validating → saving → syncing`，经回调传给 IPC 层。
   - 新错误码 `connection_validation_failed`。
   - `createConnection` 与 `addConnection` 共用 `persistConnection` 私有助手；`createConnection` 对外行为不变。
   - `registerExactModel` 移除 `manual_exact` 模板限制，按计划对所有已验证（`available`）连接开放，仍不创建 Profile。
2. `electron/ipc/management-adapters.ts`（新增）：生产传输层（Electron `net.fetch`，限界读取、中止映射、代理模式跟随设置），装配 `DeepSeekSharedRuntime` + `NewApiSharedRuntime` 并导出两个管理适配器实例。
3. `electron/main.ts`：管理适配器注册表接入两个生产适配器（原空数组）。
4. `src/shared/provider-ipc.ts`、`electron/ipc/provider-ipc.ts`、`electron/preload.ts`：新通道 `providers:add-managed-connection` 与进度事件通道 `providers:add-managed-connection-progress`；`ProviderApi` 新增 `addConnection` 与 `onAddConnectionProgress`。
5. `src/pages/providers/ProvidersPage.tsx`
   - 保存连接改走编排：订阅进度显示「正在测试远程连通性…/正在保存连接与凭证…/正在获取模型目录…」；验证失败弹确认「仍要保存为不可用状态吗」，确认后带 `allowUnavailableSave` 重试；成功按结果给出「已验证并同步 N 个模型 / 目录获取失败可稍后重试 / 已保存为不可用 / 已保存未验证」消息。
   - 手动登记表单从仅 `manual_exact` 放开为所有 `available` 连接。
   - 顶部提示与错误文案同步更新。
6. 测试
   - 新增 `tests/platform/provider-connection-orchestration.test.ts`（7 项）：完整编排与进度顺序、验证失败零落盘（注册表快照与凭证库文件逐字节不变、审计含失败事件）、强制保存为不可用、无免费验证回退纯保存、目录失败保留连接、目录连接手动登记、非法请求前置拒绝。
   - 更新 `provider-management-framework.test.ts`：目录模板连接手动登记改为允许。
   - 更新 `tests/ui/providers-page-contract.test.mjs`、`tests/ui/provider-ipc-contract.test.mjs`：钉住编排管线、强制保存、生产适配器装配与 handler 无网络代码边界。

## 四、验收结果

- `npm test`：Node 195 项 + Vitest 588 项（113 文件，新增 7 项），共 783 项通过，0 失败、0 跳过。
- `npm run typecheck`：通过（src + tests 双工程）。
- `npm run lint`：ESLint 0 问题。
- `npm run build`：渲染端 + Electron 生产构建通过。
- `npm run audit:platform`：0 违规。
- `npm run verify:handoff`：50 校验项、27 资源，0 失败。
- `npm run verify:recovery-audit`：698 跟踪文件，0 违禁、0 违规。
- `git diff --check`：通过。
- Windows Electron 隔离烟测：首轮因晨间孤儿实例占用 userData 缓存锁出现 Chromium 缓存日志，清退孤儿后重跑——12 秒存活、窗口标题正常、优雅关闭、进程树残留 0、stdout/stderr 全空。

## 五、安全与费用边界

- 真实服务商 HTTP/DNS 0 次、真实凭证读取/验证 0 次、收费调用 0 次、费用 0；全部测试使用合成适配器与临时目录。
- 凭证保持只写不回显；编排探针全程在主进程内，凭证不经渲染层之外的通道。
- NewAPI 自定义端点经端点策略校验（禁私网、禁 `.local`、HTTP 仅限显式同意的回环）；DNS 重绑定钉扎在 `net.fetch` 层不可直接实现，记录为未来加固项，不声明已具备。
- Vidu 生成接口未触碰；Vidu 冻结种子逻辑不变（PR 4 退役）。

## 六、已知边界

- 编排探针复用 `GET /models`（验证与目录各一次 HTTP）；目录同步失败不自动重试，由管理页手动重试。
- 延迟验证模板（无免费探针）仍保存为 `saved`（待验证），沿用既有行为。
- PR 1 不动列表过滤默认值；墓碑默认隐藏属 PR 2。

## 七、下一步

按计划进入 PR 2 `feature/provider-gallery-ui`：画廊数据装配、卡片视图、管理视图默认隐藏已删除、空态求适配卡。
