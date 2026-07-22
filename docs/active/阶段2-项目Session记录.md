# 阶段 2｜项目 Session 记录

日期：2026-07-22
分支：`feature/project-storage-session`
负责人：开发者 B｜本地领域与平台

## 一、本次实现

- 建立主进程 `StorageProjectSessionRegistry`，保存当前项目 ID、名称和根目录。
- 增加原生目录选择操作；渲染进程不提交项目路径。
- 选中目录后读取 `project.json`，通过 `JsonProjectRepository` 验证版本、项目 ID、名称和时间戳。
- 只有完整验证成功后才替换当前 session。
- 取消选择不改变 session；无效目录或损坏清单不覆盖已有 session。
- 增加查询和关闭项目 session 操作。
- 打开、关闭或切换项目之前等待存储变更队列完成，避免校验/relink/索引重建与 session 切换交叉。
- 存储控制器与项目控制器共享同一注册表。

## 二、新增 IPC

```text
storage:open-project
storage:close-project
storage:get-project-session
```

preload 返回内容仅包含：

- 项目 ID；
- 项目名称；
- 是否取消。

明确不返回项目根目录、项目文件内容、绝对路径或文件系统对象。

## 三、安全边界

- 项目目录只能由主进程原生目录选择器产生。
- 不提供 renderer 设置 `rootDirectory` 的 API。
- 不创建或自动迁移未知项目。
- 清单验证失败时保留当前已验证 session。
- 当前实现只打开已有项目；新建项目属于后续项目页面流程。

## 四、验证结果

- 项目 session 控制器测试：5 项通过。
- 存储 IPC 控制器测试：3 项通过。
- 平台测试：29 项通过。
- 领域测试：18 项通过。
- UI 与 IPC 安全契约：12 项通过。
- 完整测试：59 项通过。
- TypeScript、ESLint、生产构建和 `git diff --check`：通过。
- Windows 生产 Electron 隐藏启动：4 个进程均响应；不作为可见窗口交互验收。

## 五、未完成项

1. 项目页面调用 `openProject`、`closeProject` 和 `getProjectSession`；
2. Windows Electron 可见窗口中的原生目录选择联调；
3. 新建项目流程；
4. 备份恢复执行器；
5. 已验证能力下的重新下载执行器；
6. macOS 实机验证。

## 六、下一步

项目负责人验收阶段 2 基础能力后，可进入阶段 3 全局页面。项目页面必须复用本 session API，不得自行读取目录或在 renderer 保存项目根路径。
