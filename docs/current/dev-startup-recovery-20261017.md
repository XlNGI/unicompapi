# pnpm dev 启动恢复（2026-10-17）

后续维护：会话修复已落实到本启动目录，详见[运行目录修复记录](conversation-discussion-runtime-fix-20261017.md)。下文“会话新版未切换”为当时启动恢复的状态，不代表后续源码仍未交付。

状态：原目录启动已恢复；上轮遗留的验证进程已关闭，已观测负责人自己的 PowerShell 成功启动新实例。会话新版未切换，未提交、合并或推送。

## 现象与诊断

负责人在原目录执行 pnpm dev，报 ERR_PNPM_PACKAGE_MANAGER_REMOVE_MODULES_DIR / 拒绝访问。当前为维护，依据最新报错、AGENTS.md、PLANS 顶部及实际文件状态；范围仅为本地依赖恢复和工程记录，不改业务源码、开发脚本或依赖版本。

实际全局 pnpm 为 12.3.4。检查时原目录 node_modules 已缺少 .pnpm、.modules.yaml 和 .bin，残留 25 项；包链接指向会话隔离工作树，而工作树的 node_modules 又是指回原目录的 Junction。之前复用依赖导致两个根目录共享可变安装状态；当前损坏目录不宜直接反复安装清理。没有证据将报错归因于普通业务代码，也没有通过提权或批量结束用户进程处理。

## 实际恢复

1. 对原物理依赖目录及工作树共享 Junction 分别重命名保留，再移动到各自工作区内的 .cache/dependency-recovery-20261017/node_modules；操作前验证绝对源/目标路径和 Junction 目标。没有递归删除依赖目录。
2. 在两个目录分别执行 pnpm install --offline --frozen-lockfile --ignore-scripts。每次 696 个包均来自本地缓存，downloaded=0；未联网下载、升级版本或改锁文件。
3. Electron 33.4.11 使用原安装器从本地缓存恢复，使用其包内 checksums.json 校验；该恢复进程封锁 http/https 请求。未执行无关依赖生命周期脚本。
4. 两个活动 node_modules 均为各自的物理目录，包链接指向各自 .pnpm。备份放入忽略目录，避免开发文件监听跟随旧链接引起重复重载。
5. 原目录运行 pnpm dev，清除该启动子进程继承的 ELECTRON_RUN_AS_NODE，FFmpeg 验证、Electron TypeScript 编译及 Vite 启动成功，HTTP 200，实际 UniComp 可见窗口存在。首次验证后曾保留开发进程，导致负责人再次 pnpm dev 时端口冲突；后续收尾修正如下。

中间复核捕获了 PowerShell 移动旧备份时跟随包 Junction、导致工作树部分直接依赖文件被移入备份的问题。已用原子 Directory.Move 保留临时目录，并再次从缓存独立重建工作树；所有直接依赖的 package.json、实际根目录、Electron CLI/二进制和三种工具版本均已重验。此过程没有改业务源码或锁文件，没有再次执行旧链接目录的递归搬移。

## 验证及范围

- 两目录依赖恢复均 exit 0；Vite 5.4.21、TypeScript 5.9.3 可用；Electron 二进制本地恢复成功。
- 最终两个目录的全部直接依赖逐项核对，包实际路径均在各自物理 node_modules 内；会话工作树原 48 份源码/测试/脚本及 package/lock 快照保持，未将本轮环境恢复记为再次全量回归。
- pnpm-lock.yaml SHA-256 保持 6ae968526eeb765d1694b724fc3b4142da2c074aed2ac758ec3505aa6eeedda6。
- 业务源码、package.json、锁文件和开发脚本未改；本轮没有重新运行全量产品测试，不将上轮 4110 项记作本轮新测试。
- 这是启动烟测，不代表对视频、会话或真实模型做了本轮功能/收费验收。没有外部 Provider 调用或额外费用。
- 原目录仍为 feature/www-video-contract-binding；会话改进仍在 feature/conversation-document-remediation-20261017 独立工作树。未自动合并、切换分支或覆盖原有审计/方案记录。
- 本地恢复报告位于 .cache/dependency-recovery-20261017/recovery-report.json；备份保留，不自动删除。

后续验收会话新版时应先正常关闭原目录的开发进程，再从会话工作树启动，避免两个开发服务器争用 5173 端口。

## 负责人复测与验证进程收尾修正

负责人随后反馈 Port 5173 is already in use，并追问是否测试。上轮确实完成了启动烟测，但没有结束验证进程，进程交接处理不当，不能将启动通过等同于负责人可以再次启动。

核对端口所属进程及历史终端会话，确认旧 Vite PID 9232、旧 Electron 主进程 PID 12520 属于本轮创建的验证实例；已通过原终端会话发送 Ctrl+C 结束该实例。Electron 正常退出，Vite/并发脚本因主动停止返回非零退出码，属于测试收尾，不作为新启动失败。

随后再次核对，旧 Vite/Electron 及对应子进程均已不存在。此时负责人自己的 powershell.exe 已启动新的 pnpm dev：Vite PID 2384，创建时间 2026-10-17 07:48:32（本机时区）；新 UniComp 窗口 PID 17588 可见，HTTP 200。当前 5173 的监听属于这个新实例，保留用户实例，不再启动第二个测试服务，也不声称当前端口空闲。

本次只修正进程收尾和记录，没有改业务代码、开发脚本或锁文件，没有运行收费模型或重跑全量产品测试。今后启动烟测应分别记录启动成功、验证进程退出及端口交接结果。
