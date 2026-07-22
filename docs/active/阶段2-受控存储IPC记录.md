# 阶段 2｜受控存储 IPC 记录

日期：2026-07-22
分支：`feature/storage-ipc`
负责人：开发者 B｜本地领域与平台

## 一、本次实现

- 建立四个固定 IPC 操作：文件探测、文件校验、确认 relink、索引重建。
- preload 只接受 `fileId`；不接受项目根目录、绝对路径或通用文件操作。
- relink 由主进程打开原生文件选择器，渲染进程不能直接提交候选路径。
- 主进程控制器根据活动项目 session 构造仓储、探测、持久化和索引重建服务。
- 校验和 relink 等变更操作在控制器中串行执行。
- DTO 仅返回文件 ID、状态、问题、大小、匹配结果和时间，不返回绝对路径或原始 checksum。
- 内部错误映射为固定安全错误码和消息；可选诊断钩子不进入渲染进程。
- 未打开项目时统一返回 `project_not_open`。

## 二、IPC 白名单

```text
storage:probe-file
storage:verify-file
storage:relink-file
storage:rebuild-index
```

明确不暴露：

- 任意路径读取或写入；
- 通用删除、移动或目录枚举；
- 项目根目录设置；
- Node、Shell 或文件系统对象；
- 原始文件 Hash 和用户绝对路径。

## 三、Electron 构建调整

- Electron TypeScript 编译根目录扩展到仓库根，使主进程复用 `src/domain`、`src/platform` 和 `src/shared`。
- 主入口调整为 `dist-electron/electron/main.js`。
- 生产页面路径根据新输出位置调整为 `../../dist/index.html`。
- preload 与 main 保持同目录，仍启用 `contextIsolation`，渲染进程仍禁用 Node 集成。

## 四、验证结果

- IPC 控制器测试：3 项通过。
- IPC 安全源码契约：1 项通过。
- 平台测试：24 项通过。
- 领域测试：18 项通过。
- UI 与安全契约测试：12 项通过。
- 完整测试：54 项通过。
- TypeScript、ESLint、生产构建和 `git diff --check`：通过。
- 新 Electron 生产入口启动后进程树响应正常；隐藏测试模式不记录可见窗口标题验收。

## 五、未完成项

1. 项目打开流程设置和清理活动项目 session；
2. UI 通过 preload 执行真实探测、校验、relink 和索引重建；
3. 备份恢复执行器；
4. 已验证能力下的重新下载执行器；
5. Windows Electron 可见窗口端到端验收；
6. macOS 实机验证。

## 六、下一步

阶段 3 的项目打开流程必须通过主进程验证项目清单后设置活动 session；不得新增“renderer 传 rootDirectory”的捷径。完成 session 接入后，再执行 Windows Electron 端到端存储联调。
