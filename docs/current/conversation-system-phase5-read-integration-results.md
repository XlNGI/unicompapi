# 会话系统第一批真实读取链路接入结果

日期：2026-10-09
状态：隔离文件迁移、ThreadFile 只读 Adapter、runtime feature flag、分页读取和 Node 文件基线完成；未进行生产切换

## 修改文件

- `src/platform/repositories/thread-migration.ts`
  - 新增 `LegacyFileMigrationRunner`。
  - 从真实 `conversations.json` 读取 primary，解析失败时按旧 Repository 语义读取 `.bak`。
  - 只读源文件，输出 source path、primary/backup 来源和 source checksum。
- `src/platform/ipc/thread-file-read-adapter.ts`
  - 新增正式只读 `ThreadFileReadAdapter`。
  - 实现 `listThreadSummaries/getThread/getThreadItemsPage/getTurn`。
  - 使用 ThreadFileRepository committed Segment 读取，不调用旧 Conversation Repository。
- `src/platform/ipc/chat-context-runtime.ts`
  - 新增 `threadFileReadEnabled` 显式依赖。
  - 默认仍使用 `ConversationThreadReadController`；只有显式开启时使用 ThreadFile Adapter。
- `electron/ipc/chat-context-ipc.ts`
  - 读取 `UNICOMP_THREAD_FILE_READ_PATH=1` 作为主进程隔离开关；默认关闭。
- `src/pages/chat/ChatPage.tsx`
  - ThreadFile Renderer 路径必须同时满足 `VITE_UNICOMP_THREAD_FILE_READ_PATH=1` 且没有 `VITE_UNICOMP_THREAD_READ_PATH=legacy`。
  - 默认继续旧完整 Conversation 读取路径。
- 新增测试：
  - `tests/platform/thread-file-read-adapter.test.ts`
  - `tests/platform/thread-migration.test.ts` 扩展真实 primary/backup 文件测试
  - `tests/performance/conversation-phase5-read-baseline.test.ts`

## 当前真实调用链

默认生产：

```tex
ChatPage
→ chatContexts.listConversations/getConversation
→ IPC
→ chat-context-runtime.conversations
→ ConversationController
→ JsonProjectConversationRepository
→ entities/conversations.json 全量 read/parse
```

隔离 ThreadFile 路径：

```tex
ChatPage（双 Feature Flag）
→ preload Thread read IPC
→ electron ipcMain
→ runtime.threadReads
→ ThreadFileReadAdapter
→ ThreadFileRepository
→ Manifest committed offsets
→ Thread/Item JSONL
```

ThreadFile 路径不调用 `ConversationControllerPort`、`JsonProjectConversationRepository`、Agent Runtime、Provider 或 Office Tool。

## Feature Flag

默认值保持旧权威：

```tex
UNICOMP_THREAD_FILE_READ_PATH 未设置 → legacy read
VITE_UNICOMP_THREAD_FILE_READ_PATH 未设置 → legacy Renderer
```

隔离项目启用时必须同时设置：

```powershell
$env:UNICOMP_THREAD_FILE_READ_PATH = '1'
$env:VITE_UNICOMP_THREAD_FILE_READ_PATH = '1'
```

这两个开关只影响读取；发送消息、Runtime、Provider Tool Calling、Office 工具和旧写入路径没有改变。

## 实际验证

通过：

- 真实格式 `entities/conversations.json` primary 文件迁移
- primary JSON 损坏时 `.bak` fallback
- 源文件迁移前后内容保持不变
- Migration Ledger 幂等续迁
- ThreadFile summary/page/turn Adapter
- cursor 分页和稳定顺序
- runtime 显式 `threadFileReadEnabled` 接线
- ThreadFile Repository 故障恢复测试
- `pnpm typecheck`
- 迁移、Adapter、Repository 性能定向测试

定向结果：

- ThreadFile/迁移/Adapter/性能测试：17/17
- 阶段 0～4 相关定向回归：此前 128/128
- UI 合同测试：14/14
- 生产 build：通过，保留原有 Vite chunk warning

## 隔离性能基线

场景：10 个会话、每会话 100 条消息、5 次重复读取。环境为 Node/Vitest 临时目录，不是 Electron/Chromium。

| 指标 | 旧 JsonProjectConversationRepository | ThreadFile Read Adapter |
|---|---:|---:|
| 会话列表 p50 | 约 4.01 ms | Summary p50 约 0.53 ms |
| 会话列表 p95 | 约 5.68 ms | Summary p95 约 0.97 ms |
| 打开单 Thread / 首屏 p50 | 旧 get p50 约 3.93 ms | 首页 p50 约 3.77 ms |
| 打开单 Thread / 首屏 p95 | 旧 get p95 约 4.81 ms | 首页 p95 约 4.63 ms |

数据文件：`outputs/conversation-phase5/read-baseline.json`。这些数字只证明隔离 Node 文件路径的基线，尚未测量：

- Electron structured clone
- 主进程 event-loop delay
- Renderer 首屏可交互时间
- Chromium React Commi
- 真实用户项目规模

因此不能把该基线写成真实 Electron 性能改善。

## 已知限制

本批已为 Message Item 增加 `legacyMessageSnapshot`，保留旧 Message 的附件、reasoning、文档状态、revision、timestamps 和未知扩展字段；ThreadFile Adapter 从该 snapshot 重建页面所需 `MessageDto`。编辑、重试、文档恢复、终态和工作流仍继续使用旧完整接口，避免把只读映射误当作执行权威。

本批没有实现虚拟列表、Markdown 增量解析、在线双写、真实 Electron/Provider/Office E2E 或生产 Cutover。

## 回滚

清除两个 Feature Flag 即恢复旧 Renderer/旧 IPC 读取路径；ThreadFile 目录和迁移目标目录可以整体保留或删除，源 `conversations.json` 不受影响。默认 runtime 不使用新 Repository，因此无需恢复生产数据。

本批停止在隔离读取验收，等待人工确认后再进入下一批。
