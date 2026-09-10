# 对话服务商拒绝误报排查与修复

日期：2026-09-10。性质：独立维护；分支：`feature/conversation-document-crud`。
依据：负责人截图、`AGENTS.md`、`PLANS.md` 顶部最新维护事实、当前源码与只读本地执行记录。不读取历史归档，不修改权威交接资料或用户会话数据。

## 已确认事实

| 本地时间 | 模型 | HTTP / 安全码 | 正文 |
| --- | --- | --- | --- |
| 16:27:06 | gpt-5.6-sol | 403 / newapi.permission_denied | 无，未收到 stream_started |
| 16:27:55 | glm-5.2 | 400 / newapi.invalid_request | 无，未收到 stream_started |

两次请求属于同一截图会话，传输记录显示请求已包含图片量级字节；本轮没有读取或复制图片内容、凭证及原始响应。400 的具体原因无法从旧日志恢复，不能凭模型名称断言不支持图片，也不能把失败归因于响应 JSON 解析。

## 实际修改

- `conversation-text-submission.ts` 将无效请求映射为 `request_rejected`，鉴权/权限拒绝映射为 `access_denied`；领域与共享消息类型允许保存这些分类，重开后仍能准确提示。
- `chat-response-failure-notice.ts` 优先使用受控安全码区分鉴权、权限、请求参数、限流及余额/额度失败；继续保留已接收正文说明，不输出原始错误字符串。
- `ChatPage.tsx` 将失败原因放入对应消息，空失败回复不再只有“尚无内容”，有正文时继续展示正文。
- `ElectronNewApiHttpTransport` 仅将成功 2xx 请求作为 SSE 返回，非 2xx 响应走既有有界正文读取，使 Runtime 能提取安全的 code/type/param/requestId；不输出原始 message、凭证、地址和模型输入，不自动重试。
- 补充 HTTP 错误传输、正常流式保持、错误体大小限制、错误分类保存/重读及真实 JSX 消息提示回归；更新旧文案契约对安全码变量名的断言。

历史失败实体没有迁移，因此旧会话中已保存的粗粒度分类保持原样。本轮解决客户端误报和诊断丢失，不代表上游权限/参数问题已经解决。

## 验证结果

- 定向 Vitest：8 文件，175/175 通过。
- 最终全量 Vitest：211 文件，1635 通过 / 4 失败 / 0 跳过；失败见下。
- 最终 Node/UI：355 通过 / 1 失败 / 0 跳过；失败为既有 handoff 的 `manifests/SHA256SUMS.txt` 已删除，未恢复用户删除。
- `pnpm.cmd typecheck`、`pnpm.cmd build`、`pnpm.cmd audit:platform`、`pnpm.cmd verify:recovery-audit`、`git diff --check` 通过。
- `pnpm.cmd lint` 无错误；本轮生成的临时页面 bundle 有 2 条未使用 eslint-disable 警告。构建有既有 chunk 大小提示。
- 首次新增 JSX 测试因 fixture 只更新单会话读取而未更新会话列表失败，已修正 fixture 并通过；首次文案契约因安全码变量重命名失败，已更新并通过。
- 本地测试页面被浏览器 URL 安全策略拒绝，未绕过该策略，未完成本轮视觉截图验收。清理 `temp/chat-failure-ui` 的请求被自动审批拒绝（仅返回 blocked by policy）；临时文件保留于 Git 忽略目录，未进入构建发布物。

## 既有失败项

独立重跑以下 2 个文件为 6 通过 / 4 失败，与两次全量一致。它们在本地 workflow 的 start/answer 断言失败，尚未进入本轮服务商传输、失败映射或界面提示链；未修改其既有实现。

1. `conversation-document-crud-runtime.test.ts`：多附件按原文件名选择失败。固定附件名采用存储文件名，选择器要求完整名称匹配。
2. 同文件：新建 PPT 中“优化”先命中文档编辑规则，文档命令在意图规划前执行，结果被分流为 chat。
3. 同文件：新聊天替代待删除文档时，旧 workflow 的 `documentCommand` 未被清空。
4. `conversation-workflow-controller.test.ts`：持久化助手追问已使 revision/messages 从 1/1 变为 2/2，旧断言尚未同步。

## 交付边界与下一步

新构建已生成，用户当前进程未重启，未修改历史会话，未提交/推送/合并；本轮没有真实模型、搜索或收费调用，也未读取凭证。没有执行 Windows Office 或 macOS 实机验收。

先处理上述 CRUD 状态与选择回归。模型调用方面，需要在服务商后台核对 403 的模型权限以及 400 的具体参数/图片输入限制；重启新构建后，新失败可提供更准确且脱敏的诊断，不应盲目重复发送相同请求。

## 二次反馈排查（2026-09-10）

负责人反馈“还是有问题”，继续按当前维护事实排查。确认应用已于本地时间 17:19:30 重启并加载上一轮修复；上节“当前用户进程未重启”仅为首轮交付时事实，不适用于二次失败。本轮未替用户重启进程。

### 新增事实

| 本地时间 | 模型 | HTTP / 安全字段 | 结论 |
| --- | --- | --- | --- |
| 17:16:58 | glm-5 | 404 / newapi.model_not_found | 当前接口未找到模型 |
| 17:20:18、17:23:32 | glm-5.2 | 400 / code、type 为 bad_response_status_code | 网关报告上游拒绝，不能据此认定为用户参数错误 |
| 17:24:55 | gpt-5.6-sol | 200 / newapi.invalid_response | 17:24:51 开始流式输出，7 批共 313 字符后失败 |

GPT 正文在句中截断，仍属于失败的部分回答；用量观察为 `invalid_response`、无用量事实。旧日志没有原始 SSE，无法判定是结束标记、身份、用量还是其他响应字段触发校验。不能将下列离线缺陷直接当作这次请求的已证实原因，也不能把 HTTP 200 当作回答完整成功。

### 二次实际修改

- `newapi-runtime.ts` 将 `bad_response_status_code` 分类为 `upstream_rejected`，避免误报为用户请求参数错误；不改变自动重试边界。
- `newapi-chat-adapter.ts` 在跨网络分块时保留尾部 CR，直到下一块或流结束再归一化，修复合法多行 SSE 事件被提前拆断；逐字节 UTF-8 和 CR/LF 切分回归均覆盖。
- 可选的 prompt/completion token details 及 cached/reasoning token 值允许 `null` 表示未提供；必填计数、非负整数、总数一致性和重复 usage 校验仍保留。
- `tool_calls: null/[]` 继续读取同帧正文和 reasoning；合法非空工具调用也保留同帧正文，工具白名单和执行 bridge 门禁仍有效。
- 响应失败改为 `newapi.invalid_response.<固定枚举>`，可区分 JSON、编码、身份、用量和终止标记等问题，不写入原始错误文本；本地正文/reasoning 回调失败使用 `newapi.local_response_write_failed`，用量状态保持 `unknown_outcome`。
- 消息分类与共享 DTO 增加 `upstream_rejected`、`model_unavailable`、`local_write_failed`，并补充持久化重读及 UI 回归。本地保存失败在重开会话后不再被误报为超时；已收到内容继续保留。
- 准备 `scripts/diagnose-chat-stream.cjs`：显式授权标志和两个不同模型参数校验发生在读取配置及解密凭证前；使用当前设置代理、既有生产 adapter/transport 与经当前连接凭证版本校验的历史路由。两目标先预检、每个最多一次合成文本请求，输出请求上限各 512 tokens、单次 90 秒、总截止 190 秒，无重试、工具或附件/会话历史，不写项目数据。正常、异常及截止均保留脱敏结果，费用明确为未知；脚本已静态复核，尚未执行。

历史会话和失败实体未迁移；结束原因、DONE、响应身份等完整性门禁没有放宽，不把失败的 313 字符回答改成成功。

### 二次验证与边界

- 最终定向 Vitest：13 文件，242/242 通过；其中 NewAPI 包 97/97，新增 25 项解析回归。
- Node/UI 对话及 IPC 契约：22/22 通过。
- `pnpm.cmd typecheck`、变更文件定向 ESLint、`pnpm.cmd build`、`pnpm.cmd audit:platform`、`git diff --check` 通过；诊断脚本 `node --check` 通过。构建仍有既有 chunk 大小与 Vite CJS 提示。
- 补充非空工具同帧测试时，首个 fixture 误用白名单外名称，先按预期被工具解析拒绝；改为现有白名单名称后，验证正文保留且无 bridge 时不执行工具，最终定向全部通过。
- 本轮未重跑全量；首轮登记的 4 项 CRUD/澄清失败和 1 项 handoff 文件删除失败仍保留，未宣称关闭。
- 没有调用真实模型、搜索或收费接口，没有读取凭证或重新发送用户图片/资料。两次合成接口测试已经提出授权请求，截止本轮交付尚未收到明确授权，诊断脚本未执行。没有新增视觉截图、Windows Office 或 macOS 实机验收。

新生产构建已生成，应用需要完整退出并重开后加载本轮修复。下一步在明确授权后执行最多两次合成文本诊断，结合受控诊断码区分当前上游问题与响应解析问题；合成文本成功也不代表原图片请求已经通过。仍需服务商侧解释 GLM 的上游拒绝，并验证用户原场景。工作区修改未提交、推送或合并。

## 授权合并与独立验收（2026-09-10）

负责人要求上传本次新增修复并合并 `develop`。从本地与远程一致的 `8bed9f7` 建立 `feature/chat-stream-response-fix` 独立工作树，提取本次 17 个相关文件；混合文件只提取响应失败的改动。没有包含未完成的 CRUD、自然语言确认界面、包依赖变更、交接资料删除、临时输出或媒体二进制，原工作区全部既有改动保留。

提交版本验收：Node/UI 356/356；完整 Vitest 1508 通过、5 个媒体测试因工作树缺少工具跳过，随后连接现有本地媒体工具补跑两文件 11/11 通过。累计唯一测试为 1869/1869，没有未补验的跳过项。类型检查、全量 lint、生产构建、平台审计、交接校验、恢复审计和既有关闭门禁均通过；真实生产 Electron preload/IPC 的 6 项合成冒烟通过，网络请求和模型调用为 0。验收采用现有依赖执行与 package scripts 等价的 Node/TypeScript/Vite/Vitest 命令；最初 pnpm 因独立工作树依赖状态要求重装而中止，没有清空或重装共享依赖。没有改测试以掩盖失败。

计划按非快进合并保留功能分支，并将功能分支与 `develop` 一并推送后核对远端哈希。主工作区保留文档 CRUD 开发分支和未提交改动；本地 `develop` 在独立验收工作树维护，与远程同步。前文 CRUD/交接删除失败属于原混合工作区，不属于本次提交版本；真实接口问题仍保持未验证状态。
