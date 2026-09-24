# UniComp 开发计划

### 剪辑分支合并前验证补齐与 develop 集成（2026-09-24，进行中）

负责人明确授权：补齐失败验证，将最新 develop 普通合并进 feature/basic-editing-mp4-export，解决冲突、推送，经 PR 使用 merge commit 合入 develop，保留本地和远端功能分支。本轮在维护范围内执行，不重写共享历史，不改用户项目或调用付费服务。

补齐可见性测试的 window 计时方法，原 4 个行为断言通过。静态图片读取集中到 read-preview-image，仅允许受控 unicomp-media://local 单令牌地址和 Blob；拒绝 HTTP(S)、file、data、其他主机、用户信息和端口，禁用凭证和重定向，保留取消及 5 秒截止。新增负向/成功/过期响应测试 11/11，原页面禁止直接 fetch 的合同保持不变。拖动脚本增加前台聚焦与播放头命中前置检查，原方向/时延断言不放宽；旧失败报告没有采集到绘制帧，不能据此宣称产品存在反向拖动缺陷。

功能分支新鲜验证：相关 Vitest 88/88、UI/媒体合同 54/54、Electron 时间线恢复 20/20、过期恢复 17/17、完整预览 19/19、typecheck、目标 ESLint、生产构建通过。构建保留既有 chunk 大小提示。正在进行真实 Windows Electron 最小化超过 20 分钟的隔离验收，使用真实时间、5 分钟本地媒体有效期和生产 Range 响应逻辑；素材与 IPC 仍为隔离夹具，不写用户项目，睡眠/锁屏不在本轮自动执行范围。结果到达后更新本记录，再进行最终合入。

### 主轨缩略图与片段封面闲置不刷新（2026-09-24，专项自验通过）

负责人重申：软件未退出、素材未改动时，闲置后已经显示的主轨缩略图和片段封面不得重新刷新加载。本轮为维护 D1/T2，仅涉及编辑页静态图片缓存、隔离测试及本记录。确认先前联系表缓存错误地复用了播放句柄 TTL；后续尺寸/视口变化先移除过期图片再重新申请。另有页面重建后缓存存在但显示状态未恢复的问题。测试在模拟 20 分钟过期后观察到请求增长、图片 URL 改变，红灯报告 outputs/editing-static-idle/before/report.json。

修复：联系表首次从受控媒体地址读取并校验后保存为会话内 Blob URL；缓存中不再保存或按播放地址 expiresAt 淘汰静态图片。重新进入编辑页恢复缓存 URL，不重新生成图片；素材/片段范围发生变化、图片损坏或用户显式清缓存才释放对应 Blob。播放句柄的短期授权与恢复机制保持独立。已生成的片段封面本来就是 Blob，本轮验证它们在过期及页面重建前后 URL 不变；没有证据证明封面本身存在 TTL 淘汰，不能把所有闪动都归因同一分支。读取使用现有协议权限，取消和 5 秒读取超时，不新增外部访问或用户文件写入。

验证：静态专项 5/5，通过真实 Chromium 解码、与生产同配置的 unicomp-media 协议并在过期后返回 404，验证图片与封面地址稳定、无新制品请求、页面重建复用、主动清缓存重新生成。完整预览 19/19、UI 合同 17/17、typecheck、目标 ESLint、生产构建和 diff 检查通过；既有 Vite chunk 大小提示保留。普通预览降级测试修正为显式清缓存后再注入图片/视频不可用，避免把“复用已有缓存”误当成降级失败；上一条记录的缩略图降级超时已在本轮通过。证据 outputs/editing-static-idle/after/report.json 与 outputs/editing-preview-fix/after/report.json。

未验证：真实 Windows 后台闲置 20 分钟/数小时及睡眠锁屏、macOS、全量应用回归。上一轮时间线拖动方向断言失败本轮未处理。未提交/推送/合并，也未确认用户正在运行的窗口已加载本次构建。后续真实验收重点是无需操作即保留原缩略图与封面，回到窗口、播放、缩放与切换编辑页后不发生整轨清空重载。

### 导出成功播放器闲置恢复（2026-09-24，专项自验通过，真实长闲置待验）

负责人实测“导出成功”成品播放器初次可播放，后台闲置约 20 分钟后卡住。当前属维护优化，D1/T2；责任范围为 ExportInspector、隔离媒体夹具及对应 Electron 验证脚本。确认该播放器仅首次获取 Work 临时媒体句柄，没有过期续取或停滞恢复，前轮时间线修复未覆盖它。红灯：模拟句柄过期并撤销旧 URL 后，旧实现无法换源接续原播放位置（outputs/editing-export-idle/before/report.json）。此证据确认一个缺陷机制，不能证明用户现场只有这一种原因。

现通过已有 Storage API 重新核验获取作品句柄；播放/定位及重新打开面板时检查有效期，播放意图存在但 4 秒无时间推进时单轮最多恢复一次，IPC/加载/定位共享 12 秒截止。即使有效 Work 句柄复用同一 URL 也执行 load，恢复位置、音量与倍速；用户在请求期间暂停则不自动续播；旧媒体事件、超时后的迟到 IPC 与卸载结果不能覆盖新恢复。持续失败停止并给出重试播放入口，文件及导出任务不变。未扩大 TTL、改协议权限、改真实草稿或调用外部服务。安全边界仍由已有受控 Work API 持有。

验证：导出专项 10/10 通过，覆盖地址过期、原位置续播、音量/倍速、playing 但无进度、同 URL 重载、持续失败限次、显式重试、请求期间暂停及过期后重新打开面板；报告 outputs/editing-export-idle/after/report.json。UI 合同 17/17、typecheck、目标 ESLint、生产构建通过（既有 chunk 大小警告）。扩大回归未全通过：时间线 --idle-recovery 最后结果 19/20，播放恢复项通过但边缘拖动方向断言失败；普通预览前 16 项通过，随后缩略图降级 Canvas 加载超时。并发回归初次还发现固定等待 150ms 的播放拒绝恢复采样不稳定，已改成有界等待实际进度，保留原断言与失败报告 report-concurrent-failed.json。未把这些回归失败认定为本次新增或既有，原因待进一步核实；不扩大修改拖动/缩略图产品代码。

未完成：真实 Windows 项目后台闲置 20 分钟及数小时、睡眠/锁屏恢复未验证；全量测试与 macOS 未运行；扩大回归两项失败未关闭。当前源码和构建已更新，未提交、推送或合并，也未确认用户当前运行进程加载了本次构建。下一步应使用本次构建验证真实长闲置，并继续定位上述回归失败，不能把专项模拟通过等同用户实际验收通过。

### 基础剪辑播放与边缘拖动续修（2026-09-23，自验通过，真实窗口长闲置待复验）

后续负责人明确接受“能看到剪辑效果、用户体验影响不大”的低清拖动方案，授权继续实施。D2 合同：现有受控 requestPreviewArtifact 新增 scrub_video，FFmpeg 只取片段源范围、保留源帧率、最长边 640 像素、静音全关键帧 MP4，不烘焙速度/空间变换；拖动缓存将源时间减去 sourceRange.inUs，按来源与范围缓存。原视频先可用，低清缓存后台单并发、最多跟随 8 个活跃解码器；失败保留原视频，无额外用户控件。编辑页继续拥有显示、播放和松手交接，主进程继续拥有文件校验/路径/制品发布，导出不变。另补上导出预览句柄到达后的重载时序、跨片段已预加载视频接管和模块级抽帧缓存，页面重建不再主动撤销已生成帧。验收先验证真实制品帧数/尺寸/关键帧和时间映射，再同素材对比 4K 拖动、正常播放、首尾定位及回归。Task Decision 验证通过；Host 自动前置门禁未验证。

负责人要求完成自验后再交付人工清单。当前为维护优化，D1/T2，同一编辑预览责任边界；本轮仅修改编辑页、拖动解码缓存、对应测试和本记录，未改布局、媒体 IPC、导出实现、用户草稿或服务商。已就绪媒体在点击处理内直接播放，按钮由实际 playing 事件置为暂停；终点定位最后片段有效末帧；拖动滚动先读取几何再写入位置。拖动解码保留请求自身回调，同方向允许已完成中间帧，反向/跨来源时丢弃失效结果，松手后精确定位。最初严格只呈现最新目标的方案在高分辨率压力下导致持续丢帧等待，已由新鲜证据修正，不把中间帧伪称为最新目标帧。

红灯证据：修复前末帧定位、未完成 play 的按钮状态失败；解码单测复现回调归属及方向失效。当前通过：用户提供 caa12f32b39b3b3fb1ad2bc9511d1acb.mp4 作为首片段源的真实 React/Chromium 隔离交互 15/15（仅前 5 秒编辑区间，配合两个合成片段），预览回归 19/19，领域/平台定向 67/67，UI/媒体工具合同 51/51，类型与 lint。UI 合同同步当前已批准布局及终点边界调用，未改变产品布局。证据位于 outputs/editing-interaction-fix/user-media/report.json、stress/report.json、ui-contract.log 及 outputs/editing-preview-fix/after/report.json。用户素材此次松手稳定耗时 61ms，拖动最大绘制间隔约 315ms；这不是逐帧零延迟。

最终自验：用户提供的本机 MP4 真实 Electron 交互通过 16/16，普通合成场景通过 16/16，代理首次生成约 254-471ms，播放在代理未就绪前已开始，松手定位约 3ms（隔离脚本）；低清代理失败会回退原视频，拖动期间不显示新状态控件。压力场景 15/16：唯一未通过项是采样器未捕获 Canvas 绘制帧（`dragFrames: []`），其余边界拖动、松手定位和时序检查通过，不能将其记为完整压力通过。定向领域/平台测试 75/75、UI 合同 51/51、类型、lint、生产构建和 `git diff --check` 通过。完整 `pnpm test` 仍有两个既有合同失败（冻结交接校验、动态参数 autosave），未发现与本分支编辑器改动相关的失败。不能宣称任意视频绝对零延迟；本验收覆盖合成高分辨率素材和用户素材，任意编码/损坏文件/不同硬件仍需人工观察。

当前未提交、未推送、未合并。未覆盖任意格式、长视频、macOS、用户真实草稿全部编辑组合或完整应用全量测试；隔离 IPC 不等同真实项目全链路验收。

负责人在上一轮 TTL 修正后实测闲置 20 余分钟仍复现，否定了“只要重取过期句柄就足够”的判断。进一步故障注入确认恢复中的竞态：强制换预览时，定位先绑定到仍挂载的旧 `<video>`；旧元素可提前完成定位并清掉待定位状态，异步返回的新句柄随后被丢弃，实际继续使用旧媒体地址。现恢复定位会等候新预览句柄与 DOM `video.src` 一致后才应用；`playing` 事件后每 3 秒核对一次 `currentTime` 是否推进，停滞时同片段最多强制换源恢复一次，仍失败则停止并提示重试。Electron 故障注入覆盖“`play()` 已解决且收到 `playing`、但播放头不动”，以及旧句柄过期、首次新预览加载损坏、播放拒绝和持续失败限次；`--idle-recovery` 20/20、`--idle-expiry` 17/17。定向领域/平台 13/13、UI 合同 17/17、类型检查、目标文件 ESLint、生产构建和 `git diff --check` 通过。以上是合成媒体隔离 Electron/Chromium 验证；负责人此次 20 余分钟复现发生在上一修正版，新修正版尚未在真实 Windows 项目窗口中闲置 20 分钟复验，睡眠/锁屏恢复也未验证。

### 基础编辑播放、菜单与时间线修复（2026-09-22，待真实项目人工验收）

负责人已授权按批准方案实施。根因证据来自隔离真实页面：播放按钮此前只依据播放意图，媒体一次 `pause()` 后仍显示暂停并需两次点击；菜单浮层改变文档高度；时间线约有 9px 纵向溢出且标尺与工具栏间有约 8px 空隙；抽帧整批提交造成缩略图延迟。当前修复仅涉及 `VideoEditingPage.tsx`、编辑器 `pages.css`、隔离诊断脚本和维护文档：播放状态改由媒体事件校正，保留旧帧并对预览请求/播放 promise/定位设置代际和 15 秒有界超时，预取一个后继片段，菜单按视口固定定位，时间线取消纵向滚动并逐帧发布缩略图。未改播放键 DOM 位置、媒体 IPC、导出合同、用户数据或外部系统。

证据：`verify-editing-interaction-electron.cjs` 6/6 通过；`verify-editing-preview-electron.cjs` 19/19 通过；`pnpm typecheck`、`pnpm lint`、`pnpm build`、`git diff --check` 通过。旧 UI 契约套件仍有 5 项失败，均为源码字符串或旧布局断言，与本次已批准的逐帧刷新、时间线无纵向溢出和工具栏对齐目标冲突，未据此回退产品行为。隔离验证不替代真实项目素材、Windows 可见窗口人工验收或 macOS 验收。当前未提交、未推送、未合并。

### 基础编辑主预览播放状态与属性布局（2026-09-22，待人工验收）

按负责人批准的 V2 方案在当前 `feature/basic-editing-mp4-export` 实施：主预览按钮改由实际媒体 `playing/pause/waiting/error` 事件校正，播放准备、缓冲和失败提供可见状态；切片切换中的内部暂停保留续播意图，预览请求失败停止并提示重试。编辑器网格调整为素材 280px / 舞台剩余 / 属性面板 400–560px，属性面板贯通上下两排，时间轴只占素材与舞台列；中等容器和窄屏继续使用现有收窄/单列规则。未改媒体 IPC、导出合同、服务商或用户数据。

验证：`pnpm typecheck`、`pnpm lint`、`pnpm build`、定向 `video-scrub-decoder` 2/2 通过，`git diff --check` 通过。UI 契约套件 43/44 通过，唯一失败是仓库缺失既有 handoff `manifests/SHA256SUMS.txt`，与本次改动无关。上一轮编辑器 Electron 缩略图/导出预览 19/19 证据仍有效；本次主时间线需用户在实际项目中人工验收播放卡住恢复、跨片段、缓冲及四类窗口布局。当前未提交、未推送、未合并。

### 基础编辑帧图与导出预览维护（2026-09-21，隔离验收通过）

负责人确认方案后，在当前 `feature/basic-editing-mp4-export` 保留既有未提交 MP4 改动，修复时间轴缩略图句柄丢失到期信息、图片失败无恢复及空槽遮挡；导出成功按钮采用紧凑同行布局，放大预览约束视口尺寸并完整等比显示。修复前真实 Electron 复现：失效后请求保持 3→3，按钮 y=414/458，竖屏视频高2133 px超出785 px视口；修复后重取3→6、按钮同行、三种比例均适配。用户原截图的确切缺帧触发条件未直接取证，不一概归因于五分钟到期。

最终 Electron 19/19、相关 Vitest 37/37、编辑器 UI 契约34/34，类型/lint/生产构建/平台审计/diff检查通过。验证使用真实页面、主题与合成媒体、隔离 IPC/profile，未动真实项目，未调用服务商；未重启已有应用，用户项目和 macOS 人工验收待进行，未跑全应用全量测试。记录、命令及证据见 [基础编辑预览修复](docs/current/BASIC_EDITING_PREVIEW_FIX.md)，截图与报告位于 `outputs/editing-preview-fix/`。未提交、推送或合并。

### 基础剪辑导出 MP4（2026-09-21，Windows 开发路径已验证）

在 `feature/basic-editing-mp4-export` 将基础剪辑新导出固定为软件 MP4/H.264/AAC，保留历史 WebM 计划可读性与旧文件，不改布局、不调用服务商、不迁移用户数据。导出前置能力检查、冻结计划、文件名、FFmpeg 单源/组合参数和 IPC 合同已同步；本地探针在原子发布前检查 MP4 容器及 H.264/AAC 流，控制器在 Work 登记前再次检查容器、尺寸和时长。旧 WebM 不自动转换，重新导出草稿生成 MP4。

证据：相关 Vitest 30/30、媒体工具 Node 8/8、`pnpm typecheck`、`pnpm lint`、`pnpm build` 和 `git diff --check` 通过；真实控制器生成 `outputs/editing-mp4/controller-export.mp4`，FFmpeg 全解码通过。Electron 隔离验证中，MP4 在 MIME 省略和显式 `video/mp4` 两种响应下均加载、播放、定位、播放到结束并重新打开成功，报告为 `outputs/editing-mp4/after.json`。未验证 macOS、原生系统播放器、正式打包和人工点击作品库页面；这些不影响本地导出合同，但不能据此宣称跨平台或发布验收完成。未提交、推送或合并。

### develop 同步到当前功能分支（2026-09-21）

负责人批准解决冲突并上传。本次合并方向为 `origin/develop`（`4d070c1`）进入 `feature/model-selection-text-video-parameters`（合并前 `adf5763`），不更新 develop。唯一内容冲突是本文顶部双方新增记录，完整保留两边记录；`storage-ipc.ts` 自动合并保留消费事件逻辑并加入 H3 接线。类型检查、lint、生产构建、定向 Vitest 27/27、UI 契约 65/65 通过。未重跑全量测试、Electron 人工验收或真实服务调用。远端原有 MiniMax 文档尾空行及构建 CJS/大包警告保留。上传后以远端功能分支提交号核对，原功能分支和 develop 均保留。

### 任务中心消费统计按调用事实更新（2026-09-21，待人工验收）

负责人授权在当前 `feature/model-selection-text-video-parameters` 按方案实施，保留其他任务未提交工作。此记录覆盖下方 9 月 20 日方案的“30 秒刷新”部分：取消消费图表定时轮询，renderer 生命周期缓存跨切页保留；`storage:consumption-changed` 只由调用/用量/远端任务/结果/作品事实或项目集合变化触发，普通草稿和全局状态通知不触发消费读取。60 秒健康检查保留给原有状态功能，消费侧只检查本地文件元数据是否真的变化，不无条件对账。首次读取、后台更新、失败保留旧值、真实零消费及滚轮主动折叠继续沿用已验证的稳定布局。显示更新不创建模型请求或新增费用。

跨层合同：主进程共享逐调用账单缓存，按调用事实签名失效；已确认结果不随页面读取重复查询，未确认/估算结果在 5 秒、30 秒、120 秒间隔至多补查三次，同连接同批次复用对账。摘要可携带 `nextBillingRefreshAt`，前端只在该期限、实际变化或上海午夜读取；请求串行合并，过期响应不覆盖新值，读取失败保留旧值并有限重试。启动/跨日重新校准，退款重新计算原记录而非追加消费。本次不改收费口径、账单持久化、凭证、真实数据或其他页面；仅使用临时 profile 和合成账单验证，不发真实付费请求。D2 的 IPC、监听与读模型联合验收记录以此节为准，无新增阶段或架构迁移。

Electron 初轮空闲 60 秒失败已保留在 `outputs/task-consumption-events/idle-failure-report.json`；追踪进一步确认新项目的 session 回调发生在目录登记之前，监控直到 60 秒兜底才发现项目（`idle-registration-failure-report.json`）。现创建 IPC 完成后立即同步监听，文件事件与兜底共用元数据基线。最新生产 main/preload/renderer 可见 Electron 16 组检查通过：70 秒空闲请求数 4→4、切页/离页变化、真实临时文件监听、延迟/失败/乱序、零消费、金额/柱长/占比、首次启动、期限补查、1024/1440、深浅主题及滚轮折叠；固定窗口图表 256 px、筛选栏 top 380 px。调用文件变化触发一次读取后再空闲 70 秒，请求数保持 5→5；切页返回亦为 5→5，确认不重复通知。证据/截图与源文件、实际加载构建的 SHA256：`outputs/task-consumption-events/after/report.json`；复现命令为清空 `ELECTRON_RUN_AS_NODE` / `NODE_OPTIONS` 后运行 `node_modules/.bin/electron.cmd scripts/verify-task-consumption-electron.cjs --trace`。

定向 Vitest 33/33、Node/UI 契约 19/19、类型检查、lint、生产构建、平台审计与 diff 检查通过；退款回归覆盖初始费用 13.14→跨日补入退款后 5.7238、反复读取消重。Task Decision 结构校验通过；Host 级前置自动执行门禁未验证，不能将本次补充校验追认为此前每次写入的门禁证据。未跑全量测试、macOS 实机或真实服务商对账。无本地事件的远端延迟退款不会即时推送，需下次启动/跨日校准；补查耗尽后仍保留真实估算/待确认状态。人工验收：重启当前分支，任务中心空闲 70 秒并反复切页，确认无汇总占位和抖动；下一次正常调用结束后确认金额/次数/柱长/占比原位更新。未提交、推送或合并，自动接续检查保持暂停。

### 生图候选状态与必填提示（2026-09-21，待人工验收）

负责人批准后在 `feature/model-selection-text-video-parameters` 实施：快速生图与专业生图共享必填/失败/空候选等状态提示，增加仅重读候选的重试、保存后前往服务商入口，保留同草稿模型选择并隔离过期响应。本次不调整模型过滤或协议，保留此前参数性能、计费和任务中心修改。Electron 隔离工作区 11 组检查、UI 契约 70 项、定向测试 20 项、类型/lint/生产构建通过；真实服务商生成和用户项目关闭重开未验证。详细证据、范围与人工步骤统一记录在 `docs/current/MODEL_CAPABILITY_BILLING_PARAMETER_OPTIMIZATION_PLAN.md` 顶部；截图和报告位于 `outputs/image-candidate-status/`。未提交、推送或合并。

### 撤回本对话最初模型过滤改动（2026-09-21，覆盖此前回退基线）

负责人提供模型读取失败截图，明确要求回到本对话模型过滤从未修改的状态。此前 `ab4eb31` / `4d070c1` 已包含最初过滤提交 `6fc4ad4`，因此此前基线不符合最新明确范围。现按其父提交 `28265a6` 恢复视频路由、候选源与对应导出/测试，移除该次新增能力门禁；恢复 `986c3df` 之前的模型加载展示，保留同文件的参数缓冲、最新值合并及保存/关闭刷新。计费和任务中心修改不动。恢复旧兼容模型选择会恢复原先宽松归类的行为，不宣称已修正最初误分类。

当前原视频请求解析在空提示词时仍拒绝候选读取，这是最初版本也有的校验；截图二的空提示词与此路径相符，尚未现场复现用户进程，不宣称截图故障已消失。测试 32/32、UI 契约 32/32、类型/lint/生产构建/diff 检查通过，旧模型行为 Electron 验证见原方案最新节。未动真实配置或用户数据，未提交/合并；备份 `outputs/model-filter-original-20260921/`。

### 负责人验收与撤回决定（2026-09-21）

截图目标补充核对：远端 `develop` 实时提交为 `4d070c1`，领先 main 717 个提交，与截图一致；本地 develop 仍为 `ab4eb31`。拉取引用后逐文件比较，当前 14 个模型过滤/能力合同/管理显示相关文件与 `4d070c1` 完全一致，无需再次回退。差异为远端两个提交新增的 MiniMax H3 / Studio H3 独立适配及接线，本次仅恢复模型过滤，没有导入该独立功能，也未宣称完整服务商目录与远端相同。参数和任务中心改动保留；对比清单 `outputs/model-filter-rollback-20260921/develop-filter-comparison.json`。

负责人明确确认参数卡顿修复人工验收通过，保留该修复；明确要求“恢复本轮修改前的选择行为和界面”。已按本轮基线 `ab4eb31` 撤回模型过滤、管理界面、能力发现、异步图片/视频协议及其接线/测试；恢复本轮以前的模型选择行为，不表示旧模型归属问题已解决。参数性能、多字段保存和关闭前刷新修复，以及任务中心消费统计静默刷新保留。撤回内容备份于已忽略的 `outputs/model-filter-rollback-20260921/`。本记录覆盖下方被撤回模型方案的实施结论；未更改用户注册表、凭证或项目数据，未提交、推送或合并。回退后验证结果见原方案顶部记录。

### 任务中心消费统计静默刷新（2026-09-20，待人工验收）

在 `feature/model-selection-text-video-parameters` 保留前置任务全部改动后实施。真实生产 main/preload/renderer 的可见 Electron 复现确认：刷新分支卸载柱图和环图，统计区由 256 px 缩至 124 px，筛选栏上移 132 px。移除刷新时替换图表的 loading 分支，保留上次摘要直至新结果成功返回；首次读取使用静态 `--`，失败在原摘要行标注保留旧结果；空态说明并入固定摘要行，换算提示不再随刷新隐藏。计费算法、接口、真实数据及滚轮主动折叠不变。

新增 `scripts/verify-task-consumption-electron.cjs`，修复前同一几何断言失败，修复后 12 组 Electron 检查通过：慢响应、事件刷新、连续两轮真实 30 秒定时刷新、失败恢复、乱序响应、首次读取/失败/空结果、金额/柱长/供应商占比更新、换算说明、1024/1440 窗口、浅深主题及原滚轮折叠。固定 1280 窗口下首次读取、成功、刷新、失败和空结果均为 256 px，筛选栏位置保持 380 px。证据与源码/构建 SHA256 位于 `outputs/task-consumption-refresh/before/` 和 `after/`；该输出不纳入 Git。复现命令：清除 `ELECTRON_RUN_AS_NODE`、`NODE_OPTIONS` 后运行 `node_modules/.bin/electron scripts/verify-task-consumption-electron.cjs`（Windows 使用 `.cmd`）。

任务中心/弹层 Node 契约 12/12、消费读模型 Vitest 9/9、类型检查、全仓 lint、生产构建、平台审计和本次 diff 检查通过。验证使用隔离临时 profile，统计 IPC 注入受控合成响应，生产 UI/主程序/preload 为真实构建；网络阻断，无真实服务商请求、无用户账单写入。未替代真实项目人工验收、未跑全量测试或 macOS 实机；未提交、推送或合并。人工验收：启动当前分支，进入有计费记录的任务中心停留至少 70 秒，确认无汇总提示和布局跳动；切走再返回及正常任务完成后核对数据更新。技能的 Host 级自动门禁执行未验证，本轮为单组件局部状态修复，无独立 UI 设计产物。

### 已启用异步图片模型补修（2026-09-20，真实型号待核实）

按负责人“可以”继续在原功能分支修复：新增受限 predictions 图片发现与执行链、按连接隔离远端任务、原任务恢复及本地作品校验；增补旧连接绑定、详情轮转公平性与相同声明的 Schema 保留，图片空列表改为准确提示。详情及证据边界见[原方案新增实施节](docs/current/MODEL_CAPABILITY_BILLING_PARAMETER_OPTIMIZATION_PLAN.md)。新增定向组 75、149、49 项通过（有 4 项重叠），UI 22 项通过；随后首次提交/重复提交新回归及原图片提交合计 20 项通过，修复调用记录幂等冲突。生产 IPC 已验证异步图片候选隔离，100 次数字输入 p95 11.7ms、长任务 0。真实 HTTP 仅创建/查询，下载使用 PNG 夹具后真实校验登记；完整新生成编排在候选/授权/传输夹具下通过，真实服务未验。e-image 真实鉴权 Schema 仍待只读查询授权，不能宣称目标型号已可用。未提交、推送或合并，最终人工验收待负责人完成。

### 统一模型选择与文生视频参数修复（2026-09-20，待人工审核）

按负责人批准在 `feature/model-selection-text-video-parameters` 实施，未在 develop 开发，未提交/推送/合并。详见[同一方案的实施结果](docs/current/MODEL_CAPABILITY_BILLING_PARAMETER_OPTIMIZATION_PLAN.md)。修复目录能力丢失、合成图片授权、跨连接/凭证能力混用、能力更新后的 profile 漏迁移；加入受限 predictions 视频执行及安全下载。文生视频移除实测布局瓶颈并修复多字段刷新覆盖。生产联调另修复空提示词/未选首帧时无法先查询模型的问题，生成校验保持严格。

完整 AppLayout 工作台文生 19 项、图生 14 项通过；实际生产 main/preload/IPC/磁盘验收通过，100 次前台数字输入 p95 13.5ms、派发 p95 27.2ms、长任务 0，两个本地中转站同模型 ID 正确隔离。类型、lint、构建、平台审计、diff 检查通过。最终全量 Vitest 1807/1808（唯一临时目录 ENOTEMPTY 清理失败，相关文件独跑 10/10）；Node/UI 既有 handoff SHA256 清单缺失仍失败。性能初轮异常和窗口失焦证据保留在方案，不将重跑通过解释为全场景保证。

待人工审核：真实服务商 Schema/Key 和付费调用、现有项目交互、中文输入法、macOS。普通 e-video 与 Seedance 2.5 真实可执行合同资料仍不足，不能声称截图型号全部可用。新增 predictions 公共结果下载暂不支持实际代理链路。未更改计费、界面结构或用户 AppData；测试临时目录清理遭自动审批拒绝，保留且不纳入产品提交。
### UniCompAPI Studio H3 文生视频未发出请求（2026-09-20）

负责人用测试连接 `hailuo` 提交文生视频后，界面报请求未发出。现场验收记录为 `failed_before_request` / `adapter.failed_before_submission`，远端 HTTP 0。根因是工作台 dispatch 会带 `taskId` / `executionId`，Studio H3 测试适配按精确字段拒绝了整单，官方 MiniMax 适配也有同样缺口。现已把这两个身份字段列为可忽略可选字段，未知字段仍拒绝。密钥未写入仓库。

### UniCompAPI Studio H3 临时测试适配（2026-09-20）

在独立目录落地可删除的 Studio H3 测试包 `provider-package-unicompapi-studio-h3`，不并入官方 MiniMax H3，不写入 UniCompAPI `/v1` 能力表。只接 `https://unicompapi.com/studio/h3/v1` 的 `minimax-h3` 文生视频，变体冻结 `fl2va`，参数为 `generation_mode` / `duration` / `aspect_ratio`。添加/同步连接时安装打包目录，工作台提交/轮询共用长生命周期适配器。密钥未写入代码、环境文件、日志或 Git。

本轮新鲜验证：Studio H3 定向 Vitest 11/11，官方 MiniMax 14/14，相关探测/分发/视频合同 13/13，合计 38/38；`tests/ui/providers-page-contract.test.mjs` 16/16；`tsconfig.app.json`、`electron/tsconfig.json`、`tsconfig.test.json` 与 `tsc -b` 通过；变更文件 ESLint 0 error；`git diff --check` 通过。测试全部使用合成 HTTP，真实 Studio H3 / MiniMax 调用 0。未跑全量 Vitest、生产构建或 Electron 人工验收。抽检阶段为确认 422 字段误创建过 prompt 为 `x` 的任务；其中两条已取消，一条当时仍为 running。测试适配不再用真实令牌发 HTTP，也不把该次创建记为成功生成。实现边界见 [UniCompAPI Studio H3 临时测试适配](docs/current/UNICOMPAPI_STUDIO_H3_TEST_ADAPTER.md)。

### UniCompAPI Studio H3 真实连通抽检（2026-09-20）

负责人提供的是 UniCompAPI Studio H3 网关与 `sk-acp-` 令牌，不是官方 MiniMax 源站 Key。抽检只发 GET，不创建视频，不把令牌写入代码、环境文件、日志或 Git。

结果：`https://unicompapi.com/studio/h3/v1/models` 200，目录为 `minimax-h3` 两个变体 `fl2va` / `ref2va`；`/videos` 200，可列出既有任务。同一令牌访问官方 MiniMax `api.minimaxi.com` / `api.minimax.io` 的免费探测返回业务码 1004（非 MiniMax 官方 Key）；访问 `https://unicompapi.com/v1/models` 返回 401 Invalid token。Studio H3 不是 MiniMax V2 `/video_generation`，当前官方 MiniMax 适配器与 UniCompAPI 固定 `/v1` 模板都不能直接吃这条地址。令牌未保存。

### 官方 MiniMax H3 视频适配（2026-09-20）

在独立分支 `feature/minimax-h3-adapter` 落地官方 MiniMax H3 视频适配，不改 UniCompAPI 能力表，不启动 S1/S2/S3 精简。包 ID 固定为 `provider-package-minimax-h3`，只接 `MiniMax-H3` / `MiniMax-H3-Max` 的文生视频和单张受控首帧图生视频；图生视频先上传本地受控资产，再创建任务，不发送任意用户 URL。连通探测走免费 `GET /v1/files/retrieve?file_id=0`，添加/同步连接时安装打包目录，行为对齐 Vidu。实现与接线未提交。

本轮新鲜验证：MiniMax 定向 Vitest 14/14，相关探测/分发/视频合同 13/13，合计 27/27；`tests/ui/providers-page-contract.test.mjs` 16/16；`tsconfig.app.json`、`electron/tsconfig.json`、`tsconfig.test.json` 与 `tsc -b` 通过；`npx eslint .` 全仓 0 error；`git diff --check` 通过。测试全部使用合成 HTTP，真实 MiniMax 调用 0。未跑全量 Vitest、生产构建或 Electron 人工验收；未验证 macOS、真实密钥、计费或尾帧/R2V。下一步由负责人决定是否提交/合并，以及是否做真实官方连通抽检。

实现与合同边界见 [MiniMax H3 官方适配](docs/current/MINIMAX_H3_ADAPTER.md)。

### 模型能力优化分支合并检查（2026-09-20）

负责人授权检查并提交当前未提交修复，一并合并 `feature/model-capability-billing-parameter-optimization` 至本地 `develop`，不推送远端，保留功能分支。合并前 develop 为 `5b9e2cc`，功能分支已提交基线为 `135aff8`；两者与远端一致，develop 为功能分支祖先，模拟合并无内容冲突。提交范围排除 `.workbuddy/`、本地报告、用户资料与凭证。

本轮新鲜验证：定向 Vitest 104/104、UI 契约 338/338、类型检查、全仓 lint、生产构建、平台审计及 diff 检查通过。新增工作台脚本的平台字段改用现有验收脚本的 `os.platform()`；点击前增加有界的按钮可用状态等待，保留原业务断言。Electron 最终 14 项检查通过，108 次输入整页渲染 0、p95 约 16.9 ms、渲染器错误 0。首轮出现 1 次额外整页渲染，次轮数字纠正后生成超时；不能因最终通过而宣称性能时序完全稳定，首轮原因未确认。本轮未重跑全量 Vitest，未验证真实服务调用、OS 中文输入法或 macOS；真实业务人工验收边界沿用下方记录。

### 模型列表缺失与图生视频输入回归修复（2026-09-20）

负责人已授权修复两处并补完整工作台回归，随后自行人工验收。根因与证据更新在[原方案的最新维护节](docs/current/MODEL_CAPABILITY_BILLING_PARAMETER_OPTIMIZATION_PLAN.md)：可信视频映射与旧能力记录版本冲突导致整个列表读取失败；此前局部表单优化遗漏图生视频两个提示词框。保留历史并递增版本，区分读取失败与空列表、支持重试；本地输入缓冲接入生成/增强/新建/卸载/关闭前保存，同时修复回归检出的未完成可选数字被提交为旧值的问题。

当前真实注册表内存副本两次查询均恢复 Seedance 2.0，生图模型仍被排除，原文件未改变。H3 的历史 profile 对应服务包未在当前主程序注册，仍不可用，不伪造适配支持。完整图生视频 Electron 回归使用真实组件、主题、十条历史和本地可播放视频，IPC 为隔离夹具；108 次原生字符输入整页渲染由 108 次降至 0，修复 p95 16.6 ms（至下一次渲染机会）。此前 4-7 ms 仅为单独表单结果，不能代表工作台或用户现场。

定向 Vitest 79/79、UI 契约 338/338，类型/lint/生产构建/diff 检查与原参数表单 Electron 验证通过；工作台回归报告与截图位于 `outputs/video-workbench-regression/`。Sliver 阶段模板结构检查返回缺少 stage schema，未宣称该文档门禁通过。本次不改计费、不调用付费服务、不提交/推送/合并。真实项目输入手感、真实中文输入法、正常关闭重开、模型选择及真实服务调用由负责人最终人工验收；不声称 macOS 或整个应用全流程已通过。

### 模型能力、计费与参数输入优化 P0–P4 完成（2026-09-18）

按 [模型能力、计费与参数输入优化方案](docs/current/MODEL_CAPABILITY_BILLING_PARAMETER_OPTIMIZATION_PLAN.md) 分五阶段实施完毕，修复三个原始问题：视频页出现生图模型、`weq / gpt-image-2.5` 显示「无法估算费用」、填写模型参数卡顿。提交链：P0 基线 `3dfe26b`（证据与性能基线）→ P1 `6fc4ad4`（模型能力真源与旧 profile 门禁）→ P2 `434fd4d`（计费关联与可解释失败状态）→ P3 `f6ff84f`（解除参数即时输入耦合）→ P4 `f0ca17b`（组合回归、构建与 Electron 验收）。

方案 P4 的自动化 GREEN 全部通过：定向 Vitest 30/30；全量 Vitest 1740/1741；Node/UI 契约 381/382；`tsconfig.app.json` / `tsconfig.test.json` / `tsc -b` 类型检查通过；`npx eslint .` 全仓无 error；生产构建通过；`git diff --check` 干净；diff 中无 secret/token。上述数字均在清除沙箱注入的 `NODE_OPTIONS`（`genie-safe-delete.cjs`）后取得，否则会出现大量伪失败。

方案 P4 的四条 Electron GREEN 均已由真实 Electron 验收脚本覆盖，不是仅靠源码契约：

1. 视频页不出现未确认生图模型 —— `scripts/verify-p4-capability-billing-electron.cjs` 走真实 `RegistryFeatureCandidateSource` / `ProviderFeatureCandidateService`，候选 0 条且失效报告含 `router_synthesized_evidence` 与 `gateVersion`；补上 `user_confirmed` 证据后正常进入 1 条，证明门禁是「按能力证据」而非「一律屏蔽」。
2. 计费状态与失败原因文案 —— 同一脚本用脱敏 fixture 覆盖 `request_id_unavailable` / `logs_unavailable_404` / `logs_rate_limited` / `usage_not_reported` / `pricing_model_missing` 五类，各给不同原因文案，已结算项只显示金额；上游地址、`sk-` 前缀等诱饵串断言不出现在文案中。
3. 参数连续输入不卡死、失焦/提交后重开为最新值 —— `scripts/verify-parameter-input-electron.cjs` 挂载真实表单控件并派发真实 `input`/`focusout`/`click`，连续 6 次全绿（可见延迟 p50 约 4.1–4.6 ms、p95 4.8–7.2 ms，上限 100 ms）。
4. 候选不因输入字符刷新 —— 同脚本按单次按键结算计数，窗口期中间态（`-`、`+`、`.`、数字数组尾随逗号）不触发父级提交与候选请求。

复现命令：`env -u ELECTRON_RUN_AS_NODE NODE_OPTIONS= npx electron scripts/verify-parameter-input-electron.cjs` 与 `... scripts/verify-p4-capability-billing-electron.cjs`，或 `pnpm verify:parameter-input` / `pnpm verify:capability-billing`。

诚实标注的未通过/未验证项：`handoff/` 校验清单（`manifests/SHA256SUMS.txt`）不在工作树，为历史既有失败，本次不恢复、不标记通过；Windows 下 `.tools` 的回收站删除不可用，相关 Node 契约用 `finally` 清理时抛错，其自身两条断言均通过；`presentation-revision-save.test.ts` 在全量满载下偶发 5 s 超时（单独运行 13/13 通过，邻居用例 2.1–3.6 s，属负载诱发），不修改其超时阈值掩盖。

本轮实现过程另修正三个真实缺陷：`DynamicParameterForm.tsx` 在 rsuite 选择器关闭时读 `overlay` 抛错、性能探针四个计数器缺 `pendingStart` 窗口守卫导致空闲边界工作被归给前一次按键、P1 提交遗留未使用导入使 lint 失败。另修正一处平台审计违规：验收脚本曾硬编码 `platform: "win32"` 字面量，改为不写该字段而非扩大审计白名单。

自动化只覆盖到「参数表单 + 平台模块」层，工作台级接线由源码契约 `tests/ui/parameter-input-decoupling.test.mjs` 保证。待人工实机验收：真实视频页模型列表、真实图片/视频工作台内的计费状态与原因文案、真实工作台中的连续输入手感。

### 开发服务器避开 Windows 文件锁（2026-09-17）

`npm run dev` 在 Windows 上会被 Vite 监视 `outputs/video-controls-repro/chrome-profile` 的 Cookies 文件锁打断，报 `EBUSY` 后整组退出。产品 `vite.config.ts` 已排除 `outputs/`、`.cache/`、`.tools/`、临时目录和 Chrome profile 路径的文件监视；`outputs/` 同步加入 `.gitignore`。这不影响从开发服务器读取这些静态文件。未启动完整 Electron 人工验收。

### H3 视频 UI 分支本地合并（2026-09-17）

负责人授权将 `feature/h3-video-ui-optimization`（`8add238`）合并至本地 `develop`（合并前 `637fee6`），本次不推送远端，保留本地和远程功能分支。范围包含生成参数、共享图片/视频生成历史与预览、任务失败诊断及其调用链、测试和配套文档。唯一 Git 内容冲突位于 `DynamicParameterForm.tsx` 的导入：保留 develop 的共享 `SelectPicker`，补齐分支新增的 React/Tooltip 导入，并移除下拉框显式 `document.body` 容器覆盖，使其沿用统一弹层。

新鲜验证：参数表单/弹层定向 Node 8/8；类型检查、lint、生产构建、平台审计通过；Vitest 218 文件、1684/1684 通过；全量 Node/UI 374/375，唯一失败为历史 handoff `manifests/SHA256SUMS.txt` 缺失。该测试及其校验脚本相对合并前 develop 均未修改，合并前 develop 已无 handoff 跟踪文件；不恢复已删除交接资料，不把此项标记为通过。构建仍提示大 chunk 与 Vite CJS 弃用。全合并 diff 检查提示功能分支原有文档尾随空格及 `VideoPreview.tsx` 文件末尾空行；本次冲突修复 diff 检查通过，未扩大到无关格式清理。

未执行真实 Electron 人工播放/交互验收或付费服务商调用；未验证 macOS 实机。下一步为人工验收图片/视频生成历史、视频预览、参数下拉与失败诊断，再按负责人指示决定是否推送 develop。原有 `.workbuddy/`、`files/`、`outputs/` 不纳入提交。

### 新增维护代码上传与 develop 同步（2026-09-11）

负责人明确授权将新增代码上传并合并 develop。本次以 `feature/microsoft-store-packaging` 为来源，包含此前本地对话修复 `12b9a64`、视频缩略图运行工作区集成 `22fbf72`，以及商店打包/媒体加载实现 `7e72311`；来源分支已推送，保留本地与远程功能分支。相对原 develop `1608d05` 共 63 个变更文件，非快进合并无冲突，合并代码树与已验证来源一致，仅追加本同步记录。此前删除的 64 个路径恢复 0；提交范围不含 `.tools`、FFmpeg 二进制、安装包、真实身份配置或测试运行产物。

复用本会话同一代码树的验收：全量 Vitest 1652/1652、Node/UI 369/370（唯一既有失败为已删除 handoff 校验清单缺失），类型/lint/生产构建/平台审计与真实 AppX 接线验证通过；本次提交前打包专项 Node 再次 9/9 通过。上传后以本地 develop、origin/develop 和远端 refs 提交号相等、工作区干净为同步验收条件。代码同步不代表已上架，真实商店身份、正式 FFmpeg 分发材料、安装/WACK 和微软审核仍待完成。

### 微软商店正式发布与 FFmpeg 随包分发（2026-09-11）

已加入 Windows x64 AppX 构建脚本、Partner Center 身份门禁、AppX 图标生成、生产媒体组件哈希/路径/源码归档校验，以及安装后从 `resources/media-engine` 加载 FFmpeg 的运行时接线。正式发布仍被两项外部材料阻断：Partner Center 产品标识尚未填入，当前 `.tools` FFmpeg 与记录版本不一致且缺少可审计的完整源码/依赖许可归档。不得用开发目录或合成身份生成可上传包。具体命令和材料清单见 [微软商店正式发布](docs/current/MICROSOFT_STORE_FORMAL_RELEASE.md)。

首发版本已设为 `1.0.0`。TypeScript、lint、生产构建与平台审计通过；全量 Vitest 214 文件 1652/1652，Node/UI 最终 369/370（唯一既有失败仍是已删除 handoff 校验清单缺失），打包定向 9/9。隔离资源目录真实 MP4 探测、VP9 软件导出通过；包含媒体测试夹具的真实 AppX 构建及内置二进制 Hash 核对通过。验证包使用合成身份，不可上传。尚未执行真实身份打包、生产媒体来源完整性复核、安装/WACK、商店审核；下一步由负责人提供 Partner Center 四项公开身份字段，工程侧固定媒体构建和完整源码归档，再做安装验收与提交。实现已提交为 `7e72311`，本次上传与合并记录见顶部，不恢复之前删除文件。

### 安装包与快捷方式 Logo 补齐（2026-09-11）

负责人指出安装包和快捷方式未设置 Logo。基于最新 develop `3e2fc80` 在独立维护分支补齐现有品牌 ICO/PNG/ICNS、NSIS 向导页眉、主程序/安装器/卸载器图标，以及窗口图标与 Windows AppUserModelID。图标变更已增量同步主工作区，原有未提交修复保留。真实生产构建和 Windows x64 NSIS 打包通过，主 EXE/安装器 9 层图标逐帧 Hash 与源 ICO 一致，ASAR 内 PNG/最终 main.js 校验通过；类型/lint/平台审计通过。首轮工具缓存符号链接权限失败已记录，补齐 Windows 工具缓存后重打成功；未用禁用资源编辑绕过。样包未签名、未安装、未上架；不含主工作区未提交对话修复，不作为正式交付版本。实现、证据和后续安装验收边界见 [安装图标维护记录](docs/current/WINDOWS_PACKAGE_ICONS.md)。

### 视频缩略图分支删除文件保护核对（2026-09-11）

负责人要求检查 `fix/video-thumbnail-preview`，避免旧删除文件进入 develop。获取远端后以 develop `97d924a` 与 fix `fb7eb69` 模拟三方合并：develop 已提交删除 64 文件（handoff 62、旧源码 2），fix 未修改这些路径，模拟结果恢复 0。只有 PLANS 内容冲突；分支共 3 个独有提交、31 文件，另含作品库/选择器/任务筛选改动，不能仅按分支名称判断范围。本次未实际合并、切换工作区或执行功能测试，保留所有原有未提交修复。证据和后续集成边界见 [合并前核对记录](docs/current/VIDEO_THUMBNAIL_MERGE_AUDIT.md)。

### 软件商店发布准备说明（2026-09-11）

负责人明确希望打包后上架软件商店。已只读核对当前 Windows x64 NSIS 配置及微软官方 MSIX/EXE 要求；当前没有可验收安装包，正式媒体分发、商店身份/图标、签名和安装环境验收需落实。整理 [发布准备说明](docs/current/STORE_RELEASE_PREPARATION.md)，建议首发微软商店时评估 MSIX，保留现有 NSIS 作为其他渠道路线；具体商店/主体未确定。本轮仅新增说明，没有修改业务代码、执行打包或上传审核，未读取凭证；公开文档访问不外发项目资料。下一步为选定渠道后的候选包与安装验收。

### 附图生成提示词误分流修复（2026-09-11）

运行交付：旧进程 PID 6720 正常关闭，新构建 PID 7980、窗口 UniComp 已显示并响应，启动日志无错误。资源 `index-SqwgzYAe.js`，原真实会话未改写。

负责人截图原句“生成提示词”被通用“生成”动词规则识别为不明文档操作；未选模型时语义兜底无法执行。补充行内提示词/图片描述分析的本地 chat 识别，覆盖旧文档工作流/偏好；明确 Word/PPT/Excel 交付保留文档流程。未选模型的就绪任务提示先选模型再继续。全量 Vitest 1615/1615，Node/UI 356/357 唯一既有失败仍为 handoff 校验资料缺失；类型/lint/build/平台与恢复审计通过。两类真实生产附图提示词场景共 5 项通过，原句及英文后续各恰好一次响应，实际单图字节 Hash 一致，无 Office 生成；GLM 搜索三页 PPT 回归和 6 项对话 IPC 通过。真实网络/付费调用 0，未写用户测试会话，未提交/推送/合并。详见 [修复记录](docs/current/IMAGE_PROMPT_INTENT_FIX.md)。

### 制作过程联网感知与资料说明优化（2026-09-11）

运行交付：旧生产进程已退出，新构建 PID 6720、窗口 UniComp 已显示并响应，沿用本地媒体工具配置；启动日志无错误，未写入真实测试会话。最终资源 `index-Df2e-SMY.js` / `index-DvX1i4sK.css`。

依据负责人反馈并确认，按独立维护补齐最新政策/数据/行业现状的检索建议，保留逐次授权与本地优先。制作前说明是否联网及资料依据；缺能力给出配置入口；传输建立后提示等待，真实工具/来源事件到达后才标记搜索，GLM 来源即时显示。拒绝先于会话授权复用，取消/撤销后的迟到事件不再追加成功提示。实际截图发现提示被输入框遮挡，修复消息容器高度和自动滚动跟随。全量 Vitest 1602/1602；最终界面调整后 UI 契约 322/322、类型/lint/build 通过；Node/UI 356/357 的唯一失败仍为既有 handoff 校验文件缺失。六类隔离生产搜索/制作场景、前批界面 10 项、对话 IPC 6 项通过，GLM 流未结束时来源提示可见且三页 PPTX 正式登记。真实网关搜索声明仍为 0，本批未配置真实服务商、读取凭证或发起付费调用。代码未提交、推送或合并。详见 [维护与验证记录](docs/current/DOCUMENT_WEB_SEARCH_EXPERIENCE.md)。

### 模型配置遮挡与对话候选不可用修复（2026-09-11）

依据负责人两张截图按独立维护实施。确认模型概要固定底栏被完整搜索表单撑高，且错误向图片模型显示默认 Kimi 设置；改为正常内容流、文本模型按需展开，并按模型回填配置。实际项目一条旧 CRUD `documentCommand` 导致整个启动恢复失败，进而候选加载显示“0 个可用”和“本地保存失败”；增加精确旧结构兼容，保留请求数据并禁止旧命令执行。纯模型查询与项目恢复解耦，响应写入/执行门禁保留；普通/推理候选失败分别显示并可重试，保留输入。只读真实候选为普通 17/17、推理 14/14，真实 workflow 主/备份均 59/59 可解析且未改文件。最终全量 Vitest 1558/1558，最后兼容性补充后相关 61/61；Node/UI 356/357，唯一既有失败为 handoff 校验资料缺失。类型/lint/生产构建/平台与恢复审计通过，生产界面 10 项和对话 IPC 6 项通过，真实网络与模型调用为 0。新构建已启动，窗口显示并响应；本批未提交、推送或合并。详见 [修复与验证记录](docs/current/PROVIDER_CHAT_AVAILABILITY_FIX.md)。

### 视频缩略图分支合并与删除保护（2026-09-11）

负责人在删除保护核对后明确授权将 `fix/video-thumbnail-preview` 合入 develop。以 develop `97d924a` 和 fix `fb7eb69` 在隔离维护分支执行三方合并，PLANS 两处冲突保留双方追加记录及最新维护事实；此前删除的 64 路径保持缺失，恢复 0。补齐隐藏视频页初始化取消边界、develop 新增服务商选择器的公共包装，并清除聊天页无用 import。全量 Vitest 212 文件 1560/1560、Node/UI 359/360，唯一既有失败为已删除 handoff 校验资料缺失；未恢复资料或跳过校验。类型/lint/build/平台与恢复审计、6 项真实 Electron preload/IPC 冒烟通过，真实媒体 40 帧测试执行通过。默认并发首轮 3 项 Office 超时已记录，降低并发后全量通过。原工作区 29 个修改/未跟踪文件 Hash 一致，未混入此次合并；保留来源与集成分支。具体范围、验收和交付边界见 [合并交付记录](docs/current/VIDEO_THUMBNAIL_MERGE_DELIVERY.md)。

### 模型原生搜索维护与主工作区交付（2026-09-11）

负责人明确允许读取公开 API 文档。本批补齐 Kimi builtin、智谱 web_search 协议，精确模型能力声明、对话内本次/会话授权、范围与版本绑定、真实协议事件/来源/费用未报告事实、取消/撤销保护；并修复 Kimi 文本启用的既有阻断。已增量同步主工作区并构建，旧进程正常退出，新构建 PID 7060 已显示并响应；以隔离生产 Renderer/preload/IPC/存储和合成 HTTP 验证 Kimi 两轮工具握手、GLM 来源以及搜索后真实三页 PPTX 登记；没有真实付费调用或真实密钥读取。主工作区全量 Vitest 1545/1545，最后并发投影修正相关 16/16；Node/UI 355/356 的唯一失败仍为既有 handoff 删除，完整工作树 356/356。类型/lint/构建及完整工作树各审计通过。其他搜索协议、PPT 制作中逐页预览/草稿修订恢复和完整 P7 未完成，不宣称整体计划达标。详细依据、失败记录、交付与后续边界见 [原生搜索交付记录](docs/current/MODEL_NATIVE_SEARCH_DELIVERY.md)。


### PPT 主题追问接入实际运行工作区（2026-09-11）

负责人截图反馈“我要生成一个ppt”仍直接生成并出现旧步骤卡片。确认上轮 `f9b61cc` 仅在独立工作树提交，主工作区及正在运行的应用没有加载，属于交付未接入。本轮将该提交的 src/tests 补丁应用到主工作区，保留全部原有清理改动和交接资料删除，并加入截图原句回归。真实生产 Renderer、preload、IPC、Application 与 JSON 仓储链路通过：点击发送后返回主题追问，只有用户和助手两条持久消息，模型响应调用 0、网络请求 0、旧步骤卡片 false。使用独立合成项目及用户数据，未改写用户实际会话。主工作区 Vitest 207 文件 1527/1527、Node/UI 355/356；唯一失败为既有 handoff 文件缺失，未通过恢复删除或跳过校验绕过。类型、lint、生产 build、平台审计和差异检查通过。旧应用 PID 13452 已通过正常关闭流程退出，新构建已启动，结果见 [运行交付记录](docs/current/PPT_CLARIFICATION_LIVE_DELIVERY.md)。完整原生联网和逐页 PPT 计划仍未关闭。

更新时间：2026-09-10

当前维护事实：项目负责人已于 2026-09-08 确认全部既定阶段、功能系列和验收已完成，当前按独立维护任务开展整体优化、稳定性治理和性能改进。本条最新负责人决策覆盖下方历史记录中的旧阶段状态，不恢复历史阶段计划；原有记录完整保留供追溯，不能据此判断当前功能尚未完成。

### 模型联网搜索与对话式逐页 PPT 制作计划（2026-09-10）

负责人已确认统一模型原生联网能力、PPT 逐页制作/预览/单页修改、需求不完整时追问，以及全部提示通过助手对话表达。本轮仅编写 [实施计划 V1.0](docs/current/CONVERSATIONAL_PPT_AND_MODEL_WEB_SEARCH_PLAN.md)，覆盖能力证据与协议适配、自然语言授权、真实过程事件、页面版本与检查点、预览/导出一致性、有限修复、恢复和正式作品门禁；按 P0—P7 拆分实施与验收。方案确认不等于功能已实现、真实联网已授权或实机验收通过。本次未调用真实模型/搜索服务，未读取凭证，未修改业务代码。下一步先进行协议覆盖盘点和逐页渲染验证，再实施统一对话事件与追问；既有清理改动和 handoff 删除保持原样。

### 未使用代码清理（2026-09-10）

从 `feature/cleanup-unused-code` 清理已确认无生产入口的早期页面骨架、未使用的导出别名/包装函数，以及 3 处由严格 TypeScript 检查发现的未使用成员；保留 `StateSystemPreview` 作为现有 UI 契约测试夹具。`typecheck`、`lint`、生产 `build` 和 `git diff --check` 通过。UI 契约套件 34/35 通过，唯一失败为工作区原有的 62 项 handoff 资料删除导致 `verifyHandoff` 找不到 `manifests/SHA256SUMS.txt`，与本次代码清理无关；未恢复、提交或上传这些既有删除。

### 对话响应修复合并验收（2026-09-10）

负责人明确授权上传新增修复并合并 `develop`。本轮从最新同步的 `develop` 建立 `feature/chat-stream-response-fix` 独立验收工作树，提取本次响应传输、解析、失败分类、提示和相关测试，共 17 个文件；原工作区未完成的文档 CRUD 改动及交接资料删除保持原样。完整 Node/UI 356/356、Vitest 1508 通过且 5 项因未配置本地媒体工具跳过；接入已有本地媒体工具后，相关 11/11 补跑通过，累计唯一测试 1869/1869，无未验证跳过项。类型、全量 lint、生产构建、平台/交接/恢复/关闭审计和 6 项真实 Electron preload/IPC 冒烟通过，真实模型及搜索调用为 0。独立工作树使用现有依赖运行与 package scripts 等价的直接命令，避免 pnpm 尝试重装共享依赖。合并和远程一致性以本轮实际 Git 操作结果为准；历史记录中的未提交状态仅指当时事实。真实原场景及上游状态仍未验证。详见 [交付记录](docs/current/CHAT_PROVIDER_REJECTION_FIX.md)。

### 对话失败二次排查与流式兼容修复（2026-09-10）

负责人反馈“还是有问题”，本轮继续按独立维护排查。确认应用已于 17:19:30 重启并加载上一轮修复，不能归因于未重启。17:16:58 的 `glm-5` 为 HTTP 404 / `model_not_found`；17:20:18 和 17:23:32 的 `glm-5.2` 为 HTTP 400，新增脱敏字段确认网关报告 `bad_response_status_code`，不等于已证明用户参数错误；17:24:55 的 `gpt-5.6-sol` 为 HTTP 200，收到 313 字符后发生 `newapi.invalid_response`，保留内容但不标记完整成功。旧记录没有原始 SSE，不能还原具体失败谓词。

修改范围限 NewAPI runtime/流式解析、消息失败分类与提示、相关测试、受授权保护的合成诊断脚本和工程记录。离线复现并修复跨分块 CRLF、多处可选 usage `null`、空/非空工具字段吞正文问题；增加固定枚举诊断码、本地写入失败分类、上游拒绝和模型不可用分类。仍严格校验响应身份、必填用量与总和、finish 和 DONE，不自动重试或将部分回答降级判定为成功。最终定向 Vitest 13 文件 242/242、Node/UI 22/22，类型检查、定向 lint、生产构建、平台审计和差异检查通过；本轮未重跑全量，前轮登记的 4 项 CRUD/澄清失败和 1 项 handoff 删除失败未关闭。真实接口合成测试仍待用户明确授权，实际模型请求、凭证读取和新增调用费用均为 0；本轮新构建未替用户重启。详见 [二次排查记录](docs/current/CHAT_PROVIDER_REJECTION_FIX.md)。

### 对话服务商拒绝被误报为格式异常（2026-09-10）

依据负责人截图，在现有 `feature/conversation-document-crud` 维护分支排查。只读本地执行事件与脱敏网络记录确认：16:27:06 的 `gpt-5.6-sol` 请求为 HTTP 403 / `newapi.permission_denied`，16:27:55 的 `glm-5.2` 请求为 HTTP 400 / `newapi.invalid_request`，均未开始接收正文。修复请求拒绝与权限拒绝的消息分类、消息内持久失败提示，并让 Electron NewAPI transport 对非 2xx 响应复用有界错误正文读取，保留现有安全错误字段提取，避免把错误正文当 SSE 丢失诊断。原始错误文本、凭证和附件内容不进入新增日志；历史会话实体未迁移，当前用户进程未重启，未重新调用模型。HTTP 400 的具体参数/图片能力原因仍待服务商事实核对，不能宣称模型请求已经恢复。

相关 8 文件 175/175 回归通过，`typecheck`、`build`、平台审计、恢复审计与差异检查通过；lint 无错误，本轮临时页面生成文件产生 2 条警告。最终 Node/UI 355/356（既有 handoff 校验文件删除导致 1 项失败）；Vitest 211 文件，1635 通过 / 4 失败 / 0 跳过。4 项既有 CRUD/澄清失败独立重跑一致，发生在本地 workflow，未进入本轮响应链路；文件名选择、新建误分流、旧文档命令残留和澄清测试断言详见 [排查与修复记录](docs/current/CHAT_PROVIDER_REJECTION_FIX.md)。浏览器 URL 策略拒绝本地测试页面，本轮不声明视觉截图验收；临时测试目录删除被自动审批拒绝，保留在忽略目录。未提交、推送或合并，保留所有原有改动。下一步先修复已登记的 CRUD 回归，再在当前服务商后台核对拒绝原因及模型权限/输入要求。

### 会话自然语言执行优化计划（CO-001～CO-008）

2026-09-10 远程同步交付：负责人明确授权上传新增代码并合并 develop。拉取确认远程没有独立新增提交后，已原子推送本地 14 个维护提交，远程 develop 更新至实现集成提交 `2c8f05b`；PPT 页码/保存与单输入框、图片真实输入、连续追问版本同步、出字与附件预览均已包含。四条相关功能分支已上传并保留本地和远程副本。交付源码/测试与通过 1801 项验收的 `2713ab9` 完全一致；此次只补充交付记录，不重复构建相同代码。下方旧记录的“不推送远程”仅描述当时状态，现由本条覆盖；原有 62 项 handoff 删除未上传。最终分支提交一致性以推送后的远程查询核对，详见 [对话体验优化交付记录](docs/current/CHAT_STREAMING_ATTACHMENT_EXPERIENCE.md)。

2026-09-10 对话体验优化：依据负责人出字卡顿、文件制作过程和附件 UI 反馈，新增约 100 ms 的显示缓冲与底部跟随，终态立即补齐已接收文字；文档按实际状态显示生成内容/检查结构/排版保存/完成交付；输入框与历史消息图片改为缩略图、点击本地大图预览，其他附件用紧凑卡片。新增当前项目附件媒体句柄入口，保持格式/范围/大小/已有 Hash 校验。实现 `0518893`、契约更新 `2713ab9`；完整 Node/UI 356/356、Vitest 1445/1445，共 1801 项，零失败、零跳过；类型/lint/构建、平台/交接/既有关闭门禁、六项生产对话 IPC 和三项图片预览 IPC/协议检查通过，三个宽度的真实界面和流式帧验证通过。首次旧文案契约失败已修正复测，原有 handoff 删除不变。代码本地集成 develop，保留功能分支，不推送远程；工作区旧进程正常退出，新构建启动并包含上轮会话同步修复。未调用真实模型/搜索/付费接口；详情见 [对话出字与附件体验优化](docs/current/CHAT_STREAMING_ATTACHMENT_EXPERIENCE.md)。

2026-09-10 连续追问版本冲突修复：图片分析后发送“生成提示词”触发 revision_conflict，确认原完成事件早于助手终态保存，界面可能读取旧 revision。实现 `b008d31` 调整为保存后通知，后续新消息/澄清提交前同步最新会话，禁止旧异步快照覆盖新版；保留真实并发冲突及输入，不自动重放写操作。定向 37 项、完整 Node/UI 356/356 与 Vitest 1441/1441（共 1797 项）通过，零失败、零跳过；类型/lint/构建、平台/交接/既有关闭门禁和六项生产 Electron 冒烟通过。全量校验使用已有工作树的精确实现提交，原有 handoff 删除不变。代码本地合入 develop，保留 feature/conversation-completion-sync，不推送远程。旧工作区窗口在正常关闭请求后仍未退出，未强制结束，尚待保留未发送输入后退出重开才能加载新构建；详见 [回复完成后的会话版本同步修复](docs/current/CONVERSATION_COMPLETION_SYNC_FIX.md)。

2026-09-10 对话图片输入维护：修复“附图分析仍称未读取图像”的实际传输缺失。单输入框接入粘贴预览；普通聊天按明确请求或所选单图，经项目/格式/大小/Hash/授权校验后，将真实图片发送给兼容聊天接口；执行前复核，字节不进入会话持久化，明确不支持图片的通道/模型本地拦截。实现 `e34e285` 在 `feature/conversation-image-understanding` 完成，采用本地 develop 非快进集成并保留分支，不推送远程。完整 Node/UI 356/356、Vitest 202 文件 1433/1433，共 1789 项，零失败、零跳过；类型/lint/构建、平台/交接/既有关闭门禁、六项生产 Electron IPC 冒烟与三个宽度的真实组件验证通过。原有 62 项 handoff 删除造成初次交接校验失败，完整复测在已有校验工作树的精确实现提交通过，用户删除未恢复或提交。主工作区新构建已正常重启，窗口响应正常、启动错误日志为空。未调用真实模型/搜索/付费接口，未知模型视觉能力仍取决于实际服务；详见 [对话图片输入实施记录](docs/current/CONVERSATION_IMAGE_INPUT_IMPLEMENTATION.md)。

2026-09-10 主工作区集成：负责人明确要求直接集成实际使用版本。维护实现以 `6f7c1c4` 提交，经 `dbe7054` 非快进合并到主工作区本地 `develop`，功能分支保留。合并源码与上一轮 1765 项全通过的测试版本一致；主工作区重新构建成功，PPT 页问答/修订保存/输入事件 36 项定向回归和六项生产 Electron preload/IPC 检查通过。原有 62 项 handoff 删除逐项比较保持原样，未加入提交。此前记录中的“尚未集成”是当时状态，现由本条覆盖；未推送远程。运行交付事实见 [单输入框实施记录](docs/current/CONVERSATION_SINGLE_INPUT_IMPLEMENTATION.md)。

2026-09-09 对话单输入框维护已实施：按负责人最新截图要求移除文档模式、类型、主题、PPT 模板、AI 配图/模型及检索资料常驻按钮与跨请求状态。每条输入直接进入既有语义 workflow，文档类型/资料范围使用受控计划，模板主题按当前需求匹配；AI 配图只在明确请求后进入费用确认。保留模型设置、发送/停止和必要澄清、授权及恢复门禁。真实 JSX 事件与需求偏好定向 22/22；完整 Node/UI 356/356、Vitest 200 文件 1409/1409，共 1765 项，零失败、零跳过。类型、lint、构建、平台审计、交接与关闭校验、六项生产 Electron preload/IPC 冒烟通过。真实组件在 800/900/1400 像素宽度验证单输入框、旧控件为零且无横向溢出。未调用真实模型/搜索/付费接口，未更新用户当前应用；仍在隔离维护分支，未提交/推送/合并。详见 [对话单输入框实施记录](docs/current/CONVERSATION_SINGLE_INPUT_IMPLEMENTATION.md)。

2026-09-09 PPT 修改与保存维护已实施：负责人确认“直接实施”。实际取证确认原 PPT 与会话早已保存，原第 7 章修改失败源于固定偏移把第 10–11 页误定位为第 8 页。现统一实际演示顺序和可重建章节页映射，移除局部修订的页码推算回退，执行前确认文件/版本/标题/实际范围并复核源 Hash；补齐范围、校验、写入、登记与结果同步错误，禁止不可恢复请求原样重试，已登记作品只补写状态。真实 13 页回归、逐项压缩包保护、连续局部修订、写入/登记故障和重开后的幂等恢复通过。最终 Node/UI 358/358、Vitest 199 文件 1398/1398，共 1756 项，零失败、零跳过；类型、lint、构建、平台审计、交接与既有关闭门禁、六项 Electron preload/IPC 冒烟均通过。没有真实模型、搜索或付费调用。改动仍在隔离维护分支，未提交/推送/合并，用户原文件及历史失败执行未修改；详见 [PPT 修改与保存实施记录](docs/current/CONVERSATION_DOCUMENT_REVISION_SAVE_REVIEW.md)。

2026-09-09 生成 PPT 页码问答维护：负责人反馈“问第 5 页却回答第 7 页”，并确认是对话内刚生成的 PPT。源码确认原问答只传历史正文而未读取已登记成品的实际页，封面/续页使大纲序号与页码错位。本轮在既有隔离维护分支补充按实际演示顺序读取单页、Work/File/Hash 校验、授权范围绑定、发送前重读和完整页预算保护；当前与旧草稿入口均接入并保留旧版生成/修订消息兼容，页问答排除旧大纲及其他资料，越界/不明版本/变更/超限则拒绝猜测。最终 Node/UI 358/358、Vitest 198 文件 1384/1384，共 1742 项且零跳过，类型/lint/构建/平台审计/交接/既有关闭门禁和六项 Electron 冒烟均通过。并行验收曾有两项 5 秒超时，独立重跑和最终门禁均通过，过程已记录。不宣称已核对负责人原 PPT 或调用真实模型；记录见 [交付后复核记录](docs/current/CONVERSATION_OPTIMIZATION_REVIEW.md)，改动仍未提交/推送/合并。

2026-09-09 交付后继续复核：确认 CO-001～CO-008 已通过 `a207687` 合入 `develop`。依据负责人本轮继续实施指令，在 `feature/conversation-closeout-review` 开展原计划的代码复核，离线复现并修复已登记 Work 终态写入失败导致重复生成、正文完成后的本地文件中断恢复、追问后资料处理沿用旧摘要要求三处边界。新增回归先失败后通过；最终 Node/UI 358/358、Vitest 195 文件 1300/1300，零失败、零跳过；typecheck、lint、build、平台审计、交接校验、既有关闭门禁和六项真实 Electron preload/IPC 冒烟均通过。无真实外部模型、搜索或付费调用。修复保留在隔离分支工作区，尚未提交/推送/合并；验收及未验边界见 [交付后复核记录](docs/current/CONVERSATION_OPTIMIZATION_REVIEW.md)。原工作区交接资料既有删除保持不变。

已完成当前会话链路审查并定稿，负责人于 2026-09-09 确认采用三项建议并授权“直接实施”。实现与实际验收见 [会话自然语言执行优化计划](docs/current/CONVERSATION_OPTIMIZATION_PLAN.md) 和 [实施记录](docs/current/CONVERSATION_OPTIMIZATION_IMPLEMENTATION.md)。本轮已完成 CO-001～CO-007 的批准范围：问答、附件、受控语义规划、取消/恢复、Office 多交付物和结果门禁；CO-008 收口验证已执行。媒体会话接入等范围另行规划。

负责人随后明确要求上传代码、合并 `develop` 并确保本地与仓库同步。交付分支 `feature/conversation-natural-language-integration` 基于 `origin/develop` 的 `df6905e` 创建，仅转入本轮会话优化及必要维护事实说明，保留远程已合入的底栏变更。隔离集成的最终验收和提交同步结果以实施记录中的交付记录为准。


2026-09-09 会话优化隔离验收完成：功能提交 `91942e4`；Node/UI 358/358、Vitest 194 文件/1271 用例全部通过且零跳过；类型检查、lint、构建、平台审计、50 条 checksum/27 资源交接校验、阶段 9 关闭门禁与六项 Electron preload/IPC 冒烟均通过。真实外部模型与联网付费测试未执行，macOS 未实测。依据负责人授权上传并合并 develop，保留功能分支；实际范围及环境边界见本轮实施记录。

2026-09-08 底栏合并验证完成：功能提交 `31ace2b` 已同步 origin/develop `ceaab5e`，仅 PLANS.md 新增记录冲突并完整保留双方。Node/UI 357/357、Vitest 1168 通过/5 项 FFmpeg 集成跳过，typecheck、lint、build 及差异检查通过。共享依赖入口失效/安装文件锁已通过隔离目录离线安装恢复，依赖清单与锁文件未改。按负责人指令执行上传和 develop 合并，保留功能分支；此记录不宣称安装包发布或 macOS 实机通过。

2026-09-08 底栏交付决策更新：负责人明确要求上传 `feature/status-dock-refinement` 并合并 develop，覆盖此前仅本地验收的交付限制；功能分支保留。详细结果以 `docs/active/底部任务状态栏优化实施记录.md` 的最新交付记录为准。

本次底栏验收环境问题：Vite 监视隔离 Electron 配置目录产生 EBUSY，已由独立验收启动器排除 .cache 后恢复；产品配置无变更，详见本次实施记录。

2026-09-08 底部任务状态栏优化：负责人批准 V1 方案后在隔离分支 `feature/status-dock-refinement` 实施。三阶段自动验证完成，默认收起、页面反馈与任务摘要共存、真实读取/异常状态、刷新与键盘焦点、导航后收起均已落地。Node 356/356、Vitest 1149 通过/5 跳过（隔离区缺少 FFmpeg 的真实媒体测试）；最终构建、全仓 lint 与定向任务测试通过。15 组页面/窗口布局无底栏重叠及页面横向溢出，独立生产 Electron 已启动。尚待负责人最终人工验收；macOS 未实测，未提交、推送或合并。逐阶段证据与入口见 `docs/active/底部任务状态栏优化实施记录.md`。
2026-09-07 明确清空操作与 Provider 解耦：截图中的“将第二章的内容清空”在任何本地文档修订开始前被 `newapi.authentication_failed` 中断，根因是 Renderer 把所有文档修改都强制绑定一次模型响应。现新增受控的本地确定性修订准备 IPC；仅当已有父 Work 带 Application 验证大纲、已确认 workflow、单一页/章目标、计划目标与原始用户消息一致、无资料外发且整句只表达清空/删除内容时，Application 才创建本地完成消息并沿用现有 Revision Agent、Office 结构读取、范围校验、渲染、布局、Hash、原子发布、Work 登记和父版本链。否定句、多目标、清空并改写、附件/检索、越界、旧版无验证状态及普通改写仍 fail-closed 或进入原模型链路。真实 JSON 仓储回归确认本地完成消息只推进一个 conversation revision 并可在重开仓储后读回。完整测试为 Node/UI 354/354、Vitest 183 文件 1158/1158，共 1512 项；`typecheck`、`lint`、`build`、平台审计、交接校验、恢复审计、阶段 9 关闭门禁和 `git diff --check` 通过。未调用真实 Provider、未读取或修改凭证、未产生费用；NewAPI 鉴权配置本身仍需单独检查，Windows Electron/PowerPoint 人工复验未执行。

2026-09-08 负责人要求精简时间线工具栏：移除“适配全部”按钮及其点击处理，保留缩放滑杆、放大/缩小图标与 Ctrl 滚轮。此决策覆盖此前方案中的适配全部入口，默认 5 秒约 8 帧规则不变。

2026-09-08 时间线验收白条修复：负责人截图确认抽帧格之间出现规律白条，原因是约 50 px 格宽中居中放置约 32 px 的固定竖向裁片，上一轮浏览器验证仅核对数量与拼图比例，漏检单格覆盖范围。现裁片宽度填满格子，并按拼图单帧比例推导最小高度后居中裁切；独立帧改为 cover。默认约 8 帧和 Ctrl 滚轮密度规则不变。新增浏览器覆盖检查在修改前失败、修改后通过，默认和放大均无格内露白；领域 17/17、UI 20/20 通过。用户原视频 Electron 效果仍待复验。“适配全部”仅调整显示比例以完整展示所有片段，不恢复默认抽帧密度，不改变素材和导出。

2026-09-08 视频时间线布局：负责人确认静态方案并补充“5 秒约 8 帧，Ctrl 加滚轮增加图片”。在当前 `fix/video-thumbnail-preview` 分支调整默认时间比例为 80 px/s，5.042 秒宽约 403 px、8 个抽帧槽，右侧留空；增加显式缩放和适配全部，主轨 76 px、标题带与胶片分离，同步播放头/标尺/文字/音乐坐标。超过 40 帧缓存密度时复用按源时间提帧与取消/缓存边界。领域 17/17、相关 UI 合同 29/29、构建、定向 ESLint、diff 检查通过。浏览器实际组件配合编号测试拼图验证默认 8 帧、Ctrl 放大后 15 帧、适配约 90%、1024 宽无页面横向溢出。真实 Electron 原视频、长片连续滚动及导出未人工验收；未提交推送。方案与证据：`docs/discussions/video-timeline-layout/prototype.md`。

2026-09-08 选择器弹层错位修复：实测菜单滚轮经 React Portal 传回任务中心导致统计区折叠，触发框上移约 199px 而菜单不动。任务中心现隔离 Portal 滚轮并在弹层打开时暂停图表折叠。全部现有 SelectPicker/DateRangePicker 使用公共 Pickers 包装显式传递定位参数（RSuite 6.2.2 部分 overlay 参数绕过 Provider defaults），统一挂载在避开标题栏与状态栏的弹层容器，自动上下定位、限制高度并允许内部滚动。任务状态菜单滚动后保持对齐；日期面板底边与输入框顶边实测均为 339px，快捷项可滚动到达。UI 合同 322 项与新增回归 2 项通过，构建通过；未逐页执行 Electron 人工验收，未提交推送。

2026-09-08 任务中心时间范围筛选：负责人审核布局预览后批准在当前分支实施。复用 RSuite DateRangePicker，按任务 createdAt 的本地自然日筛选；默认全部时间，支持今天、近 7 天、近 30 天、自选区间及清空。筛选栏采用搜索、项目、状态、时间范围排列，窄屏换行；消费图表保持原统计口径。日期边界单测 3/3、任务中心合同测试 10/10、构建通过。浏览器已验证快捷选择、清空和宽屏布局；真实 Electron 任务数据筛选及完整窄屏交互仍待人工验收。未提交、未推送。

2026-09-04 联网不可用状态回归修复：截图复核确认，`feature/web-research-foundation` 引入授权预览后，只在 preload API 缺失时复用旧的 workflow 取消逻辑；当预览返回 `unavailable/failed`、IPC 失败或授权后检索失败时仍保留 `ready` workflow，导致页面同时显示“继续执行”和“任务未执行”。现统一在这些终止路径取消联网 session 并持久化取消 workflow，成功后同步清除 `activeWorkflow` 与 UI 联网 session；只有 `authorization_required` 保留继续入口。定向 UI 合同 21/21、`typecheck`、`lint`、`build`、完整 `pnpm.cmd test`、`audit:platform`、`verify:handoff` 与 `git diff --check` 通过。真实搜索服务商、搜索凭证、HTTP 与收费调用仍为 0，W0/W2/W5/W6 状态不变。

2026-09-04 会话自然语言 PPT 创建修复：截图复核发现“帮我只做一个关于龙的ppt”虽包含明确类型与创建意图，却因 `hasStrongCreateCommand` 未允许“只”等副词而落入 unknown；后续“制作ppt”又只能补类型，无法恢复上一轮主题。现将受控创建副词纳入 Application 意图识别，并让 unknown 追问态基于当前 workflow 源消息后的最多 8 条用户消息重建完整计划，保持否定句、多文档歧义和确认门禁不变。黄金集升级为 `conversation-intent-offline-golden@1.0.1`，截图原句纳入第 46 条样本；自然语言创建、多轮恢复和黄金集定向回归 27/27，Node/UI 353/353、Vitest 183 文件 1128/1128、`typecheck`、`lint`、`build` 与 `git diff --check` 通过。真实 LLM、联网、Provider、Office 人工验收仍未执行。

2026-09-04 受控联网基础接入执行记录：从同步后的 `develop` 创建 `feature/web-research-foundation`，完成 W1/W3/W4 的 provider-neutral 与会话接线。新增共享 `conversation.web.preview/authorize/cancel/getStatus` DTO、严格字段解析、Application 本地 BM25 优先编排、workflow/revision/planHash 授权绑定、取消与过期 fail-closed、主进程默认 `UnconfiguredWebSearchTransport`、凭证回调端口和 UI 外发预览/明确授权。新增 Application 3/3、联网合同 5/5、受控 transport 4/4 和 IPC 合同 2/2 测试；`typecheck`、`lint`、`git diff --check` 通过。当前未配置真实服务商、未读取凭证、未发起 HTTP 或收费调用；W0/W2/W5/W6 仍未完成，真实联网仍不可用。

2026-09-04 建立《阶段9-受控联网搜索真实接入计划》：当前只冻结 provider-neutral transport、主进程凭证端口、RAG 优先、联网授权预览、IPC/UI、来源证据、失败码、缓存治理和 Windows 真实请求准入；真实搜索服务商、真实 transport、凭证读取、联网 IPC/UI 和收费调用均未启动。后续按 PR-W0 至 PR-W6 从最新 `develop` 分支实施，未完成前继续保留 `web/mixed` 阻断和本地 RAG 回退，不把计划或 E3 合同验收描述为联网已支持。

2026-09-04 会话联网任务状态与重复提交修复：截图复核确认，同一输入可在 React `busy` 状态完成重渲染前被连续提交，产生不同 `clientCommandId` 和重复用户消息；同时 `web/mixed` 计划在真实联网能力未接入时只显示阻断提示但继续保留为 `ready`，导致页面同时出现“继续执行”和“任务未执行”。现为 workflow 提交增加同步 in-flight 门禁，并在当前不支持联网时通过现有 workflow 端口持久化取消任务、清除活动任务卡且明确提示未执行；历史重复消息不做破坏性删除。UI 定向合同 19/19、workflow 应用测试 10/10、`typecheck`、`lint`、完整 `pnpm.cmd test`、`build` 与 `git diff --check` 均通过；本地页面对话页渲染正常且控制台 0 错误。真实联网 transport、授权 UI、搜索服务商及收费调用仍未接入，本次真实 HTTP/凭证读取/费用均为 0。

2026-09-03 会话业务重设计第一阶段自动化收口：在 `feature/document-prompt-safety-hardening` 上将 chat/document 路由从 Renderer 上移到 Application `Intent Orchestrator`，新增三态意图、持久化 workflow、多轮追问、计划绑定确认、取消/过期/revision 冲突、执行闭环、重启恢复和带预算的 Context Builder。同会话新任务在 JSON 仓储原子写入中取消旧 pending，并发创建只保留一个 pending；内部文档 Prompt 只存主进程响应草稿并作为当前 Provider 输入，共享 IPC/Renderer DTO 明确禁止 `promptContent`。`conversation-intent-offline-golden@1.0.0` 共 45/45 样本通过并已纳入默认测试门禁，报告见 `docs/active/会话意图离线评测报告-V1.0.0.md`。最终 `lint`、`build`、`git diff --check`、Node/UI 338/338 与 Vitest 180 文件 1097/1097 均通过。未调用真实 Provider、联网搜索、向量数据库或收费接口；真实 LLM 分类兜底、RAG、联网授权、受控 Agent 工具循环、真实 Office/Electron 人工验收与阶段 10 均未启动，总计划保持 `in_progress`。完整测试新增的 8 个 `.e7-office-batch-*` 未跟踪临时目录因本地删除策略拒绝清理而保留，未进入 Git 或生产构建；仓库原有同名目录未触碰。

2026-09-03 PR-A PPT continuation-scope hotfix: a scoped chapter revision changed only the first physical slide because PPT continuation slides can repeat the same heading before a later `（续 N）` title. Added a real PPTX regression and made both the platform executor and runner authorization expand from the authorized page through consecutive headings that match the target heading or its `（续` continuation form; unrelated duplicate headings remain outside scope and fine-grained Word/Excel behavior is unchanged. Focused document tests were 50/50; full `pnpm test`, `typecheck`, `lint`, `build` and `git diff --check` passed. Windows x64 manual Office acceptance remains pending; PR-B through PR-F remain not started.

2026-09-03 PR-A runtime completion retry: document response completion polling previously treated one transient local read exception as fatal, so an execution that had already reached `completed` could surface as “文档生成失败，请重试。” Added a bounded recovery of up to four transient polling failures with a one-second delay; a successful read resets the count and five consecutive failures still fail closed. Added a polling-transient regression. After the retry fix, focused regression was 19/19; full `pnpm test`, `typecheck`, `lint`, `build` and `git diff --check` passed. Windows x64 manual Office acceptance remains pending.

2026-09-03 PR-A runtime notice hotfix: the document revision flow exposed a provider `authentication_failed` safe code, but the chat/document failure notice only handled generic `unavailable` afterward and therefore mislabeled the provider 401 as “连接超时或服务暂时不可用”. Extracted `failedResponseNotice` into `src/ui/chat-response-failure-notice.ts` and added an authentication branch before generic timeout/unavailable handling; the notice now says credential/permission should be checked or the model switched, without exposing prompts, credentials or provider routing facts. Added `validation/chat-response-failure-notice.test.ts` and updated the moved UI contract assertions. Focused regression was 17/17 before the completion-retry change. Cleanup of existing `.e7-office-batch-*` directories was blocked by the local execution policy, so those untracked directories remain and must be removed outside this command path. PR-B–PR-F remain not started.

2026-09-03 PR-A hotfix: allowed the local revision agent contract state completed_unvalidated to reach the rendering runner only after revision.changed, a concrete patch, target validation and untouched-section validation all pass. This state means structural validation completed while final Office rendering remains with the runner; it previously caused clear_section revisions in the production IPC wiring to fail closed. Added a regression proving a bounded clear-section patch reaches the runner. Focused application/validation tests, typecheck and lint pass.

2026-09-03 PR-A revision fail-closed: isolated legacy-document recovery, stopped revision/patch/scope failures from falling back to a model-wide outline, added revision_scope_violation/revision_patch_failed/revision_conflict/unvalidated_output codes, and validated title, section, page-map and untouched-section invariants before execution. Added validation/document-generation-revision-failclosed.test.ts. Typecheck, lint, build and git diff --check passed. Full pnpm test was 1404/1405; the sole failure is an environment EPERM from realpath C:/Users/MSI in the sandbox. Windows x64 acceptance is pending; PR-B through PR-F are not started, so the overall plan remains in_progress.

2026-09-03 智能文档提示词工程与安全加固计划：根据本轮评审新增工程侧计划文档 `docs/active/阶段9-智能文档提示词工程与安全加固计划.md`，状态为 `planned/not_started`。计划优先处理修订 fail-closed、否定句与破坏性操作确认、章节/页面目标分离、unknown 意图的 LLM 结构化 fallback、system/developer 规则与不可信资料边界、RAG 必需/可选资料策略及严格 JSON Schema 失败协议。本文只冻结实施顺序、状态/失败码、评测样本和 Windows x64 验收门禁，不表示相关能力已实现；本轮未修改业务代码。

2026-09-02 PPT 页面类型兼容性补充：文档大纲解析器对 `pageKind` 增加受控的大小写、首尾空白及空格/连字符归一化，仍仅接受既有枚举或已登记语义别名；新增回归覆盖 `Summary` 与 `IMAGE-TEXT`，避免模型轻微格式漂移触发“AI 内容格式异常，文档未生成”。定向解析测试 34/34、完整 `pnpm test`、`typecheck`、`lint`、`build` 和 `git diff --check` 均通过。未执行真实 Provider 调用或 Windows Office 人工验收，下一步按负责人安排在最新 Electron 构建中复测 PPT 生成与 PowerPoint 打开。

2026-09-02 PPT 局部修改反馈：截图中的“将第二章的内容删掉”未命中本地修订代理原有的清空规则（规则只识别“清空第二章”或“删掉本章内容”），导致修订大纲保持不变。已将匹配扩展为受控的前后置“删除/删掉 + 目标内容”表达；章节序号仍必须先通过 `parseRevisionOrdinal` 校验，避免泛化删除请求误触发。新增精确回归测试，验证意图识别、只清空第二章且保留其余章节。

2026-09-02 新对话 PPT 创建分流修复：Office 意图层原先把修订动词与单字版面词（如“行”）直接组合，导致“生成 PPT，删除重复内容并保留风险和行动建议”被误判为 `revise`，在没有当前对话上一版时错误提示“请补充可修改的上一版 PPT”。现改为：明确创建动词优先走创建；只有文件名、上一/前一版、刚才版本或编号章节/页面等受控既有文档引用才升级为修订；无创建动词时仍可凭当前对话 Office 上下文处理自然追改。新增回归覆盖该完整创建请求，定向 Office 意图与修订测试 14/14、完整 `pnpm test` 已通过。尚未执行真实 Provider 调用或 Windows Office 人工验收，需重启并使用最新 Electron 构建复测。

2026-09-02 PPT 修订基底修复：原 `applyLocalPptRevision` 要求父版与新生成目标页的文本 run 数和总页数完全相同；删除章节内容时必然触发回退，最终整份 PPT 看起来像重新生成。现以父版 PPTX 压缩包为修订基底，仅替换命中的目标页文本，删除场景对父页多余文本 run 做清空；父版多出的目标章节续页改为隐藏而不是继续展示旧内容，并保留未命中页及父版结构。新增真实生成 PPT 的回归测试验证非目标页仍保留原内容。Office 生成器定向测试 35/35 通过，完整 `pnpm test` 通过；未执行真实 Provider 调用或 Windows PowerPoint 人工验收。

## 2026-09-01｜负责人重新制定阶段九智能文档规则

项目负责人明确批准在阶段 9 已收口的 Windows x64 工程基线上新增“智能文档工作流扩展”。原阶段 9 跨平台基线、Windows 必需目标、macOS `required=false/not_run/deferred`、阶段 10 发布边界和历史验收记录继续有效；本条只新增阶段 9 扩展，不把未实施能力写成已完成。

2026-09-01 生成工资表样式反馈：定位到模型响应存在表格 JSON 尾部括号错位（`rows` 结束后提前关闭 `blocks/section`），旧恢复器将其降级为单列文本。已在 Excel 内容解析前增加受控的表格尾部修复，并将工资表“实发工资”统一生成为公式，即使模型返回了数值示例也不会丢失该列。解析器/生成器回归 61/61 通过，已重新构建 `dist-electron`；原始失败文件不覆盖，需完整重启 Electron 后重新生成并人工打开 Excel 验收。

2026-09-01 14:25 PPT 反馈：模型将 `pageKind` 输出为 `summary/detail/roadmap/risk/action`，这些是合理的语义标签但不在渲染器内部枚举，旧逻辑因此在生成前返回 `invalid_outline`。已增加小范围别名归一化（`summary/detail/risk → insight`、`roadmap/action → process`），未知值仍拒绝；对应响应离线重放解析通过，已重新构建 `dist-electron`。

2026-09-01 局部改稿反馈：原流程虽然提示“局部修改”，但仍直接使用模型返回的完整大纲重建文件，缺少应用层的范围保护。现生成服务根据用户明确的“第 N 章/节/页/部分”目标，将非目标章节恢复为上一版，目标章节仅允许正文语义变化，并保留原标题、层级和页面类型；新增语义改稿回归，完整测试继续通过。文件仍以新版本交付，原 Work 不覆盖。

2026-09-01 局部改稿二次修复：补充面向非技术管理者的语义验收提示，要求目标章节发生完整句式、解释或行动建议的实质变化，不能只换标题或重新排版；异常重试路径继续携带 `parentWorkId`。PPT 有父版本且目标章节可定位时，生成器以原 PPTX 为基底，仅替换目标章节页面的文字节点，其他页面的 OOXML、媒体、版式和关系保持不变；页面结构不一致时安全回退到完整生成。若模型返回目标正文未变化，则启用受控白话化与管理行动兜底。定向测试、类型检查通过，仍需 Windows PowerPoint 人工打开确认。

2026-09-01 PPT 内容反馈：实际文件出现“谢谢”重复页和数据表碎片，根因为模型把封面/致谢等装饰性节点作为正文 section，同时尾部表格被继续分页。渲染器现过滤首个“封面”和末尾“谢谢/感谢观看”装饰 section，仍保留有实际内容的 `section`/`closing` 页面；生成前后验证同步过滤规则，新增回归测试，避免重复封面、致谢页和错误表格分页。原文件不覆盖，需重启最新 Electron 后重新生成并人工检查页数与内容完整性。

### 批准的目标闭环

```text
用户自然语言
→ LLM 意图判断与主题/受众/目的/页数/风格等参数抽取
→ 需求完整性和歧义检查
→ 必要时向用户追问
→ 企业资料分层检索（项目附件、产品信息、品牌规范、模板）
→ 经明确授权的联网搜索（需要最新公开信息时）
→ LLM 生成内容大纲
→ 用户可选确认大纲
→ LLM 生成页面结构和视觉设计方案
→ 受控工具准备图表、图片、图标和素材
→ 受控工具创建 PPT 页面和内容
→ 渲染为 PDF/图片预览
→ 结构与视觉校验（布局、字体、溢出、重叠、一致性）
→ LLM 根据诊断生成有限修正计划
→ 受控工具自动修正并重新校验
→ 交付 PPT 文件、来源和生成说明
```

### 实施规则

- LLM 只能输出受控语义计划、内容和修正计划；不得直接决定路径、凭证、Provider、权限、费用、Work 登记或执行任意代码。
- 本地规则处理高置信度明确请求；复杂或歧义请求才调用 LLM。LLM 结果必须经过 Schema、会话实体、文档范围和权限校验。
- 企业内部资料优先走本地 RAG；现有 BM25 继续作为基础和回退。向量检索须先有脱敏评测、数据治理和负责人批准，不预先绑定具体向量数据库或 embedding 服务。
- 联网搜索不是默认能力。只有用户明确授权，或用户明确要求最新公开信息且确认外发范围后，才能调用受控搜索适配器；不得自动上传企业附件全文。
- 外部网页、附件和项目上下文均是不可信参考资料，不得覆盖系统指令；必须保留来源、检索时间、内容 Hash 和引用关系。
- Agent 采用有限工作流，不使用无界循环。工具、重试和修正必须有白名单、超时、费用/资源预算、最大步数、取消和失败恢复。
- 大纲确认按风险和置信度自适应：简单请求可跳过；品牌、管理层、资料冲突或低置信度请求必须确认。大纲和中间计划是草稿，最终文件仍须通过本地验证后才登记正式 Work。
- 阶段 9 扩展复用现有对话页和文档工作区，不新增业务一级页面；不恢复已废止入口，不改变阶段 10 安装包、签名、公证、更新、SBOM 和正式发布范围。

### 修改流程与工具调用循环补充规则

- 当前 v1 的对话式改稿仍是“上一版内容作为上下文 → 一次模型生成完整大纲 → 本地生成新文件”；这属于已完成基线，不得描述为已经具备 Agent 工具循环。
- 后续改稿必须优先采用结构化 `RevisionPlan` 和文档补丁操作。计划至少包含目标文档/基础版本、页面/章节/表格/单元格范围、操作、保留条件、幂等键和可回滚信息；LLM 不得直接返回绝对路径、文件句柄、内部凭证或任意代码。
- Agent 循环由 Application 层控制，标准顺序为“读取受控结构 → 校验计划 → 调用一个白名单工具 → 追加结构化观察结果 → 判断下一步”；LLM 只能根据脱敏的工具结果继续规划，不能自行发起未注册工具或绕过确认门禁。
- 每次修改都先写入临时版本并携带 `expectedRevision`，渲染和结构/视觉检查通过后才原子发布并登记新的 Work；原 Work、源文件和失败临时文件不得被覆盖，失败时必须可恢复到旧版本。
- 质量修正分两层：先执行确定性修复，再允许 LLM 输出受限 `RepairPlan`。修正计划只能针对诊断指出的范围，并受最大工具步数、最大修正次数、超时、费用/资源预算、取消、重复错误熔断和失败隔离约束；具体数值须在 E5 验收时冻结。
- 生命周期轮询/冲突重试与 Agent 工具循环必须分别记录、分别验收；取消、超时、权限拒绝、预算耗尽、来源不足或连续相同诊断都必须结束循环并给出可理解状态。

### 分阶段任务

1. 语义计划：LLM 意图、参数抽取、`DocumentIntentPlan`/`RevisionPlan`、缺失项、置信度、歧义追问和自然语言评测集。
2. 分层 RAG：附件/产品/品牌/模板元数据、BM25 与可选向量混合检索、来源引用和索引治理。
3. 受控联网：搜索授权、域名/来源策略、证据 DTO、缓存、预算、脱敏和离线回退。
4. 文档中间表示：内容大纲、页面结构、视觉布局、数据来源、可修改范围和保留条件分离。
5. 工具执行与渲染：工具注册表、补丁调度器、图表/素材/PPTX/预览工具白名单、受控 IPC 和真实渲染入口。
6. 校验与有限修正：结构/视觉诊断、确定性修复、`RepairPlan`、最大修正次数、循环审计、交付说明和失败隔离。

每项任务必须从最新 `develop` 创建 `feature/*` 分支，按小 PR 实施；真实 Provider、联网搜索、embedding 和收费调用需要独立批准与脱敏验收证据。

### E1 实施登记（2026-09-01）

`feature/phase9-document-intent-plan` 已从 `develop@16772d9` 建立并完成 E1：新增 `DocumentIntentPlan`、`RevisionPlan` 严格 Schema、解析器、置信度/完整性评估和本地规则快速路径；新增 9 项领域/应用测试。`pnpm.cmd test`、`typecheck`、`lint`、`build`、`audit:platform`、`verify:handoff` 与 `git diff --check` 全部通过。E1 不接入真实 Provider、联网、向量检索、工具调用或收费请求；E2 已在同一功能分支完成，E3-E6 和完整智能文档 Agent 仍为 `planned/not_started`。详细记录见 `docs/active/阶段9-E1-意图与需求计划验收记录.md`。

### E2 实施登记（2026-09-01）

同一功能分支完成 E2：统一 `DocumentRetrievalSource`/`RagContextChunkDto`、BM25 `document-bm25-v2` 可重建快照、来源类型/片段 Hash/索引版本/位置元数据、Provider 失败隔离和检索评测指标（Recall@k、MRR、空结果率、引用准确率、资料支持率）。RAG 与评测定向测试 6 项通过，`typecheck` 和 `lint` 通过；E2 未引入向量数据库、embedding、联网或收费调用。详细记录见 `docs/active/阶段9-E2-企业资料分层RAG验收记录.md`。E3-E6 和完整智能文档 Agent 仍为 `planned/not_started`。

### E3 实施登记（2026-09-01）

同一功能分支完成 E3 的本地受控搜索合同：`ControlledWebResearchService` 实现资料策略、授权门禁、HTTPS/域名过滤、外部证据 DTO、Hash、去重、缓存、超时、取消、提示词注入隔离和离线回退；新增 5 项定向测试，`typecheck` 与 `lint` 通过。E3 未绑定真实服务商、未读取凭证、未发起 HTTP 或收费调用；真实网络 transport、联网 IPC/UI 和端到端验收仍需负责人单独批准，E4-E6 与完整 Agent 仍为 `planned/not_started`。详细记录见 `docs/active/阶段9-E3-受控联网搜索验收记录.md`。

### E4 实施登记（2026-09-01）

在同一功能分支完成 E4：新增严格 `PresentationPlan` 中间表示与 `buildPresentationPlanFromOutline` 本地规划器。计划覆盖封面、内容页和结尾页，复用现有五套 PPT 模板、页面类型、布局和构图选择器；每页记录可重放的来源章节、元素、容量快照、来源引用与保留条件，并支持 `baseWorkId`、`expectedRevision` 和目标页校验。新增领域/平台定向测试 5 项；`typecheck`、`lint`、定向 Vitest 通过。E4 不接入真实 LLM、联网、向量数据库或 PPT 生成器改写；E5 Agent 工具循环与 E6 端到端验收仍为 `planned/not_started`。详细记录见 `docs/active/阶段9-E4-内容大纲与页面视觉计划验收记录.md`。

### E5.1/E5.2 实施登记（2026-09-01）

继续在同一功能分支完成 E5.1/E5.2：新增八类白名单 `DocumentToolDefinition` 注册表、严格工具请求 Schema 和 `runDocumentAgentLoop` 有界调度器。每轮最多执行一个注册工具，支持最大步数、预算、总超时、取消、允许工具集和连续相同诊断熔断；工具结果返回脱敏结构化观察 DTO。新增定向测试 5 项，`typecheck` 与 `lint` 通过。执行器与决策器均为依赖注入，本轮未连接真实文档工具、IPC、网络、Provider 或收费服务；E5.3-E5.6、E6 仍为 `planned/not_started`。详细记录见 `docs/active/阶段9-E5.1-E5.2-工具注册与Agent循环验收记录.md`。

### E5.3 实施登记（2026-09-01）

继续在同一功能分支完成 E5.3：新增 `readStructuredDocument`、`parseDocumentPatch` 和 `applyStructuredDocumentPatch`，覆盖统一大纲的 Word/Excel/PPT 结构读取、文本/章节/表格/PPT 页面布局/图表补丁；补丁目标采用结构化索引、不可变更新并重新经过大纲 Schema 校验，未知字段、越界目标、路径、URL 和受保护值均拒绝。新增 4 项定向测试，`typecheck` 与 `lint` 通过。E5.3 尚未接入真实 Office 文件 I/O、临时版本或渲染器；E5.4-E5.6、E6 仍为 `planned/not_started`。详细记录见 `docs/active/阶段9-E5.3-文档结构读取与补丁工具验收记录.md`。

### E5.4 实施登记（2026-09-01）

继续在同一功能分支完成 E5.4 的本地临时版本与确定性诊断合同：新增 `prepareTemporaryDocumentVersion`，补丁和容量诊断通过后才调用注入的临时文件生成器；渲染适配器返回结构化警告，失败或取消时清理临时文件且不登记 Work。新增 4 项定向测试，`typecheck` 与 `lint` 通过。真实 PDF/图片渲染、字体/溢出/重叠诊断、E5.5-E5.6 和 E6 仍为 `planned/not_started`。详细记录见 `docs/active/阶段9-E5.4-临时版本与渲染诊断验收记录.md`。

### E5.5 实施登记（2026-09-01）

继续在同一功能分支完成 E5.5：新增严格 `RepairPlan` Schema 与 `runBoundedRepairWorkflow`，确定性修复优先，LLM 仅输出受限结构化计划；每轮重新诊断并校验 revision、范围、最大尝试次数、取消和连续相同诊断熔断。新增 5 项定向测试，`typecheck` 与 `lint` 通过。E5.5 尚未连接真实渲染诊断和发布登记；E5.6、E6 仍为 `planned/not_started`。详细记录见 `docs/active/阶段9-E5.5-RepairPlan与有限修正验收记录.md`。

### E5.6 实施登记（2026-09-01）

继续在同一功能分支完成 E5.6 本地原子发布合同：新增 `publishDocumentCandidate` 和 `DocumentPublishPort`，发布前校验临时包存在性、Office 包有效性、大小、SHA-256、诊断、幂等键和 expected revision；幂等重放不重复发布，冲突/取消/校验失败不登记新的 Work，真实路径和持久化由主进程端口控制。新增 3 项定向测试，`typecheck` 与 `lint` 通过。E6 Windows x64 实机验收仍为 `planned/not_started`。详细记录见 `docs/active/阶段9-E5.6-原子发布与Work登记验收记录.md`。

### E6 preflight 实施登记（2026-09-01）

在当前 Windows 环境完成 E6 自动化 preflight：真实生成 docx/xlsx/pptx 临时产物，校验文件大小、SHA-256 和 OOXML 必需部件，并通过原子发布端口完成受控发布模拟；新增 1 项三格式烟囱测试。随后复跑完整门禁：168 个 Vitest 文件、1013 个测试全部通过，`typecheck`、`lint`、`build`、`audit:platform`、`verify:handoff` 与 `git diff --check` 全部通过。Electron 会话、Microsoft Office 打开、渲染视觉、失败恢复、任务中心/作品库展示和负责人签署仍未完成，E6 继续保持 `planned/not_started`。详细记录见 `docs/active/阶段9-E6-Windows文档产物烟囱验收记录.md`。
环境探测补充：当前工作区未发现 `WINWORD.EXE`、`EXCEL.EXE` 或 `POWERPNT.EXE`，因此本轮无法执行 Office GUI 打开/修改/保存人工验收；该项记录为环境阻断，不改变 `macOS required=false/not_run/deferred` 边界。

### E7 实施登记（2026-09-01，负责人批准）

负责人批准在 E1-E6 的本地合同基础上启动 E7“生产 Agent 接入与语义局部修改闭环”。E7 属于阶段 9 收口后的独立 Office 扩展，不重开已完成的跨平台基线，不启动阶段 10，也不将本地合同测试通过误记为生产能力完成。

范围：

- 将文档请求接入 Application 层 `runDocumentAgentLoop`，由 Provider 通过受控 tool calling 产生工具请求和结构化观察轮次；
- 为 `read_document_structure`、`apply_document_patch`、`render_preview`、`inspect_layout` 提供真实 Office 文件执行器，并通过受控 IPC/主进程端口访问文件；
- 增加“清空/改写指定章节（页面、工作表范围或段落）”语义操作，保留目标章节标题、层级、版式和非目标内容；
- 文档修改只能基于 `baseWorkId` 与 `expectedRevision` 写临时版本，完成结构/视觉校验后原子发布；失败、取消、冲突或超限不得登记新 Work；
- UI 只展示执行阶段、目标范围、工具步骤摘要、修正结果和新版文档卡片，不展示机器大纲 JSON 作为最终回复。

E7 验收门禁：

- 输入“清空第二章”或等价自然语言时，实际调用读取/补丁工具并修改原 Office 文档，不能退化为完整大纲重建；
- 目标章节正文发生语义变化或被清空，标题和结构保留，非目标页面/章节/单元格内容 Hash 不变；
- 生成的 docx/xlsx/pptx 能在 Windows Office 打开，渲染、布局、字体、溢出和重叠诊断可复现；
- tool calling、取消、超时、预算、revision 冲突、重复诊断和失败恢复均有结构化状态与审计记录；
- 自动化门禁、Windows Office 人工证据、失败矩阵和交付审计全部完成后，E7 才能标记 `passed`。在此之前状态为 `approved/not_started` 或对应失败状态。

### E7.1 实施登记（2026-09-01，进行中）

已从最新 `develop` 建立 `feature/phase9-e7-agent-integration`，开始 E7 第一增量：明确的“清空第 N 章/节/页/部分”请求进入 Application 层的有界本地 Agent 工作流，按“读取结构 → `clear_section` 补丁 → 渲染预览 → 布局检查”顺序最多执行一个白名单工具；补丁保持章节标题、层级和非目标内容不变。`clear_section` 已加入受控 Revision 操作，Electron 文档生成组合根已接入该本地规则端口。

同时增强 Agent 观察结果的递归脱敏，并支持决策/工具执行中的 AbortSignal 立即取消。当前增量尚未接入真实 Office 文件 I/O、Provider tool calling、渲染器视觉诊断或 Windows Office GUI；E7 整体仍为 `approved/in_progress`，不得标记 `passed`。

本增量验证：定向应用/平台测试 13/13 通过；完整 `pnpm.cmd test` 为 169 个 Vitest 文件、1029 项及 Node/UI 合同全部通过；`typecheck`、`lint`、`build`、`audit:platform`、`verify:handoff` 和 `git diff --check` 通过。未调用真实 Provider、未读取凭证、未发起联网或收费请求。

### E7.2 实施登记（2026-09-01，进行中）

新增 `office-document-tool-executor` 第一版真实文件适配器：仅接受项目内相对路径，执行 DOCX/XLSX/PPTX 格式、大小和 OOXML 包校验；`readOfficeDocumentStructure` 从实际 Office 包生成脱敏结构摘要；`applyOfficeDocumentPatch` 当前支持 `clear_section`，对 Word/PPT 保留段落/文本节点结构，对 Excel 保留首行表头并清空目标工作表数据行，结果只写调用方提供的临时目标，禁止覆盖源文件。

E7.2 当前仍未完成真实 Electron 文件句柄/Work 解析接线，尚未替换现有生成器的正式发布路径，也未完成渲染视觉诊断、取消恢复端到端和 Windows Office GUI 签署。适配器定向测试 2/2 通过；随后完整 `pnpm.cmd test` 为 170 个 Vitest 文件、1031 项及 Node/UI 合同全部通过，`typecheck`、`lint`、`build`、`audit:platform` 和差异检查通过。未调用真实 Provider、未读取凭证、未发起联网或收费请求；E7 整体仍为 `approved/in_progress`。

### E7.3 实施登记（2026-09-02，进行中）

已把 E7.1/E7.2 接入正式文档生成链路：明确清空请求和 Provider 候选大纲中的指定章节改写由 Application 层归一化为 `clear_section` / `replace_section`，模型不能指定工具、路径或内部 ID；Runner 从 `parentWorkId` 解析项目内已验证父文件，Platform 执行器直接读取真实 DOCX/XLSX/PPTX 并写独立临时版本。发布前重新读取父文件与临时文件，要求目标内容 Hash 发生变化、标题/层级/版式保持稳定、全部非目标章节内容 Hash 不变；随后继续经过既有 OOXML、关键内容、SHA-256、原子 rename、FileReference 和 Work 登记门禁。映射失败、目标未变化或越界修改均失败关闭，不回退为整篇重建，也不登记新 Work。父 Work、FileReference 或父文件失效时同样以 `storage_error` 失败关闭，不再退化为整篇重建。

新增 `replace_section` 严格补丁、结构摘要 `contentHash`、真实三格式清空回归、DOCX 改写回归和 Runner 父子 Work 发布回归。完整 `pnpm.cmd test` 为 170 个 Vitest 文件、1041 项及 Node/UI 合同全部通过；`typecheck`、`lint`、`build`、`audit:platform`、`verify:handoff` 与 `git diff --check` 通过。未调用真实 Provider、未读取凭证、未发起联网或收费请求。

E7 仍为 `approved/in_progress`，不得标记 `passed`：Provider 原生 tool calling 已完成受控工具定义发送与调用增量安全校验，但当前响应生命周期尚无工具结果回传与多轮执行合同；自动化 `render_preview` / `inspect_layout` 已新增本地 LibreOffice/Poppler 适配器，但本机未安装渲染器，真实 PDF/PNG 视觉诊断尚未运行。负责人已确认 Windows Office 打开、保存、重新打开及 PDF/图片视觉检查无字体、截断、溢出、重叠或目标范围异常，本轮人工结论尚未附 Office 版本、样例文件名、截图或导出物哈希等独立证据元数据。2026-09-02 修复增量已补齐外层 `kind` 感知的 `replace_section` 校验、PPT 封面/重复标题/续页映射、PPT 重复标题无精确页码失败关闭、Word 段落级和 Excel 单元格级受控修改、目标块/单元格 Hash 门禁、首章节前置段落定位、Excel 非空数据行物理坐标映射、细粒度值失败关闭、Word 展开块回退、失效父 Work/FileReference/父文件失败关闭、最多 8 个去重多目标补丁、显式渲染器配置接入和 `completed_unvalidated` 结构状态；正式 Vitest 目录门禁为 172 个文件、1062 项通过，Office 执行器局部回归 13/13、Runner 15/15。详细记录见 `docs/active/阶段9-E7-生产Agent局部修改闭环验收记录.md` 与 `docs/active/阶段9-E7-修复增量验收记录-2026-09-02.md`。

2026-09-01 Excel 大纲兼容性修复：负责人实际验收发现 DeepSeek 返回的合法 Excel JSON 使用数值单元格（金额、年龄）并以 `footers.label/values` 表达汇总行，旧解析器仅接受字符串行且未归一化 footer，因而在文件生成前错误返回 `invalid_outline`。现仅对 Excel 表格接受有限值类型并统一转为内部字符串契约，同时把受控 footer 归一化为“合计”行；Word/PPT 仍拒绝数值表格单元格。结合本轮 Excel 生成器改进，工资模板的金额字段转为可填写数值、实发工资和合计使用公式，表头/列宽/冻结/筛选补齐。新增解析与生成回归，完整 168 个 Vitest 文件、1014 个测试通过，typecheck、lint、build、平台审计、交接校验和差异检查通过。原始验收文件保持不变，需重新构建并生成新版 XLSX。

## 当前状态

2026-08-28 Windows 本地未签名测试包修复：首次安装包启动时主进程因 `Cannot find module 'tmp'` 崩溃。根因是 `electron-builder.yml` 的递归排除规则 `!**/tmp{,/**}` 将 `exceljs@4.4.0` 的生产依赖 `tmp@0.2.7` 一并从 ASAR 删除；现将 tests/docs/.tools/.cache/tmp/temp 排除限定到项目根目录，并增加 Windows 打包合同测试，禁止重新引入会删除同名生产依赖的递归规则。修复 ASAR 已确认包含 `node_modules/tmp/package.json` 与 `lib/tmp.js`，解包生产应用真实启动 4/4 进程并在 10 秒观察期保持运行，关闭后残留 0；全量测试、typecheck、lint、build、差异检查与 NSIS 生成通过。安装包仍为未签名、本地测试产物，默认 Electron 图标且未完成阶段 10 的签名、SBOM、生产更新、正式媒体组件分发或发布准入。记录见 `docs/active/Windows安装包ExcelJS运行时依赖修复-2026-08-28.md`。

2026-08-28 人工验收修复：对话内 Office 修改补齐 Excel 口语表达，“给表格加几列”“当前工资表在加年龄跟性别”在当前对话存在可修改表格时进入 revise；Office 问句和“加油”等非修改表达仍走普通聊天。一次已在服务商后台产生费用的 PPT 请求在本地 62.5 秒报 `newapi.timeout`，证据确认客户端命中既有 60 秒响应头等待上限；默认首包等待已改为 5 分钟，流空闲 60 秒和总上限 15 分钟不变。timeout 现在标记为远端结果/费用未知，UI 要求先核对服务商后台并避免立即重复发送，不自动重试。定向与相邻回归为 Vitest 75/75、Node UI 18/18，typecheck、lint、build 通过；本轮未调用真实 Provider，未运行默认全量测试，Windows Electron 口语修改和长首包/费用提示仍待人工复验。详见 `docs/active/对话内Office文档生成-PPT质量优化验收记录.md` 第 12 节。

2026-08-24 工程补充：按用户需求在“对话内 Office 文档生成”系列内新增 EPUB 电子书上传与解析（分支 `feature/chat-epub-upload`）。对话页文档模式附件白名单扩展为 txt/md/csv/docx/pdf/xlsx/pptx/epub：EPUB 按 mimetype/container.xml/OPF 的 manifest+spine 顺序解析 XHTML 章节正文（标签剥离、HTML 实体解码、章节标题分隔），沿用文件 20MB/ZIP 条目 500/全文 2,000,000 字符/预览 4,000 字符上限，非法 EPUB 返回 failed 并给中文警告；RAG 检索复用全文提取自动纳入。UI 文案补充“EPUB 电子书”提示。全量门禁 146 文件 / 822 项通过，0 失败、0 跳过；typecheck/lint/build/git diff --check 通过。记录见 `docs/active/对话内Office文档生成-EPUB电子书上传解析验收记录.md`。

2026-08-23 工程补充：按负责人批准顺序完成对话内 Office 文档生成候选功能并推送 `develop`。对话式改稿（上一版正文作为上下文改写、旧版保留）；PPTX 模板风格迁移（提取 clrScheme 主题色作为自定义主题）；AI 生图配图（默认关、生成前确认、图片模型选择器、按分节生成并 SHA-256 校验登记、临时草稿生成后自动清理）；成品模板 v1（封面色带、分节强调条、内容卡片，主题色确定性派生）；结构化内容契约（开场白剥离、JSON 大纲优先解析 + Markdown 回退、行内 Markdown 剥离）；BM25 关键词检索与 RAG 集成（附件全文切块索引、检索 top-3 作为生成上下文、指令强制基于资料撰写）。全量门禁 805/805 通过，0 失败、0 跳过；Windows 人工验收完成。记录见 `docs/active/对话内Office文档生成-候选功能验收记录.md`。后续候选：模型直接输出 JSON 契约、程序化生图端口彻底去草稿、Excel/Word 图表图文版式、文本溢出策略、PPT 转图片预览、向量 RAG（需批准引入 embedding 模型）。

工作流偏差登记：PR1—PR6 在功能分支 `feature/chat-office-doc-pr1-domain-generator` 开发并保留；候选功能（对话式改稿、模板迁移、AI 配图、RAG 等）与 Vidu 独立提交在合并后直接提交于 `develop`，未按“功能开发从 develop 创建 feature/* 分支”规则执行。原因：候选功能以连续小步迭代方式托管实施，未逐一建分支。影响：develop 历史缺少逐功能分支回溯点，但提交粒度小、验收记录完整，无功能缺失。纠正：后续所有功能严格走 `feature/*` 分支 + 非快进合并 + 保留本地与远程分支。

2026-08-22 工程补充：`feature/chat-office-doc-pr1-domain-generator` 完成“对话内 Office 文档生成”PR1—PR6 并非快进合入 `develop`（`68e33e0`），功能分支保留。对话页新增“文档”模式：输入需求后由已选文本模型撰写 Markdown 正文，主进程解析为大纲并本地生成 Word/Excel/PPT（docx/exceljs/pptxgenjs），经 SHA-256 校验后登记为 `mediaKind: document` 正式作品并挂载文档卡片（打开/作品库/重试）；支持拖拽文件（白名单 txt/md/csv/docx/pdf/xlsx/pptx，魔数/大小/页数/行数/ZIP 炸弹校验，项目内副本登记）、图片附件嵌入 PPT 图片槽、chart 块渲染为原生 PPT 图表、内置主题（商务蓝/墨色/松绿）与版式引擎；受控 IPC/preload，renderer 不接触路径/Hash/凭证。全量门禁 801/802（唯一失败为工作区既有 Vidu 未提交改动的旧断言，已随 `232980e` 独立提交）。项目负责人确认覆盖 AGENTS.md“不得把对话页做成直接生成入口”旧规则。后续候选：对话式改稿、模板风格迁移、AI 生图配图、关键词检索/RAG，待负责人批准。

2026-08-21 工程补充：按 Vidu 官方当前文档核对并更新参数适配。文生视频与参考生视频新增可选 `seed`；参考生视频 q3 系列 `audio` 默认修正为 `true`，`viduq3-turbo/mix/q3` 时长范围修正为 `3–16` 秒；`resolution`、`aspect_ratio` 改为官方枚举并在适配器 HTTP 前校验；官方参考生图 `viduq2/viduq1` 的比例与分辨率同步枚举；变更参数 Schema 升级 revision 2，路由解析器移除 revision 1 硬编码，旧 revision 路由按精确 Schema 校验。`model`、`prompt` 与参考生视频 `images` 继续由产品约束和适配器强制必填。TypeScript（应用与测试）和定向 ESLint 通过，`git diff --check` 通过；当前沙箱阻止 Vitest 的 Vite 配置加载，完整门禁待正常环境复跑。未调用真实服务商、未读取凭证、未产生收费请求；阶段 10 与 macOS 延期边界不变。记录见 `docs/active/2026-08-21-Vidu官方参数核对更新记录.md`。

2026-08-21 最终收口：`feature/remove-text-video-shot-ui` 汇总今日已批准的生成界面与状态反馈调整。应用级底栏升级为多任务生产状态栏，生成生命周期不再重复弹出全局通知；文生视频移除镜头 UI，图生视频移除独立运动约束控件并改为与图生图一致的“大提示词输入 + 右下角单图缩略位 + 项目上下文/提示词增强”结构；专业生图支持把已校验本地作品拖回参考图槽；Qwen Image 尺寸值统一为上游要求的 `<width>x<height>`，对应参数模式升至 revision 2，适配器接受正整数参数模式版本。底层草稿兼容字段、模型选择、动态参数、提交合同、本地文件校验和正式作品登记门禁保持不变。全量 Node/UI/工具链 312 项与 Vitest 752 项，共 1064 项通过，0 失败、0 跳过；TypeScript、ESLint、生产构建与 `git diff --check` 通过。未调用真实服务商、未读取凭证或产生收费请求；阶段 10 未启动，macOS 仍为延期目标。统一工程记录见 `docs/active/2026-08-21-生成界面与状态栏收口记录.md`。

2026-08-21 工程补充：`feature/remove-text-video-shot-ui` 按负责人确认效果将应用级项目状态栏升级为多任务生产状态栏。底栏基于现有安全任务读模型聚合处理中与需处理数量，使用不确定进度动画而不伪造百分比；展开面板按需处理、失败、接收校验、生成、等待、最近完成排序并最多显示 4 条，支持任务中心、待处理和本地作品入口，展开后点击状态栏组件以外区域自动收起，组件内部操作不误触关闭。完成、普通失败与过期终态只在最近 10 分钟进入快捷状态栏，其他运行、等待、恢复或未知提交状态只在最近 1 小时有活动时显示；最近创建的 Execution 以等待处理进入状态栏，完全没有 Execution 的 Task 不属于正在生产，历史积压只保留在任务中心。完成态继续服从 Execution 完成及 Work 登记门禁，不以远端完成冒充正式作品；不存在通用重试能力时不展示虚假重试操作。按最新交互决策，图片与视频生成的提交中、生成中、成功、失败、状态待确认和结果待接收均不再创建或显示全局浮层通知，统一由页面进度、底部状态栏、展开面板、作品预览和任务中心承载；提交面板已移除生成通知依赖，全局通知层已移除生成任务轮询并拒绝同类通知 ID，普通非生成通知不受影响。未新增一级页面，未修改模型选择与生成链路，未调用真实服务商、未读取凭证或产生收费请求，阶段 10 未启动。验收记录见 `docs/active/多任务生产状态栏动态UI验收记录.md`。

2026-08-20 工程补充：`feature/professional-image-history-timeline` 按负责人确认稿实现共享生成历史组件，并接入专业生图、文生视频和图生视频。右侧上方展示当前选中的本地作品，下方以横向时间线展示当前草稿的生成历史；鼠标位于历史区域时，纵向滚轮与触控板手势可驱动横向滚动，到达边界后交还外层页面。成功作品按时间从左到右排列且可点击切换，生成中、失败和待确认仅作为真实状态节点展示。图片与视频均按原始比例受画布最大宽高约束并居中显示；时间线按媒体类型渲染图片或视频缩略预览。正式作品必须同时满足当前项目与草稿任务关联、媒体类型一致、文件可用、存在校验时间、作品详情可读且受控本地媒体句柄创建成功；未使用远端 URL 或虚构作品。移除宽泛存储变更订阅，避免草稿自动保存期间反复扫描历史造成输入抖动，仅在草稿切换和真实提交完成后刷新。未调用真实服务商、未读取凭证或产生收费请求，阶段 10 未启动。验收记录见 `docs/active/生成历史通用组件验收记录.md`。

2026-08-20 工程补充：`feature/dynamic-parameter-ui` 优化创作页动态参数表单。每个字段改为左侧参数名、右侧控件的紧凑横向表单行；参数列表按父级容器宽度响应，不足 620px 时单列，达到 620px 后自动分为两列，JSON 多行输入始终跨列。移除常驻的“已设置/使用默认值”状态与圆点，可选字段仅在空输入框内显示“可留空”；数值范围与步长、数组分隔及 JSON 格式要求移入参数详情浮层，不再占用表单行高度，并保留必填状态和参数说明。内部 `runtime_not_allowed` 不再作为模型不可用组件或错误弹窗展示，图片、视频和提示词增强仍保留底层授权门禁与禁用状态，其他可操作原因继续显示。普通字段、控件与留白进一步收紧；布尔参数使用带“开启/关闭”文本的开关，并保留控件可访问名称与错误态。修复图片与视频动态参数编辑期间因自动保存清空候选、卸载表单造成的跳动和焦点丢失：未保存时仅暂停候选刷新并保留当前参数合同。专业生图把“项目上下文”和“提示词增强”收敛为紧凑操作行；增强入口显式展开动态模型选择器，只有“确认增强”触发增强提交；模型下方重复的参数合同、费用和可准备信息块不再展示，底层提交校验保持不变。参数字段 ID、原始值、默认值与提交合同保持不变；完整门禁结果见验收记录。未调用真实服务商、未读取凭证或产生收费请求，阶段 10 未启动。验收记录见 `docs/active/动态参数UI优化验收记录.md`。

2026-08-20 工程补充：按负责人确认稿将底部状态区域提升为应用级唯一项目状态栏。AppLayout 统一渲染固定底栏，页面通过兼容的 `FloatingStatusBar` 注册当前场景状态；项目、对话、图片/视频创作子模式、任务中心、作品库、模型与服务商、本地设置都有默认场景状态，页面级保存、生成、调用记录异常以更高优先级覆盖。状态栏不替代右上角生成错误/成功通知，不改变业务状态来源和授权门禁。验收记录见 `docs/active/项目级全局状态栏验收记录.md`。

2026-08-19 工程补充：`feature/generation-preview-loading-refinement` 按 UI 反馈统一生图/生视频等待态。共享作品预览改为细线双环、中心星芒和阶段文案，移除粗重光晕与扫描线；图片与快速/文生/图生视频均接入真实准备、提交、服务商处理中阶段，`provider_accepted` 不再提前清空当前画布。新增等待态 UI 契约测试；Node/UI 契约、TypeScript、ESLint、生产构建和 `git diff --check` 通过。未调用真实服务商、未读取凭证或产生收费请求。记录见 `docs/active/生图生视频等待态视觉优化记录.md`。

2026-08-19 工程补充：`feature/hide-professional-final-prompt` 按截图反馈默认隐藏专业生图最终提示词结果卡片，将增强入口放在原始创作需求区域；展开时仅显示模型选择和“确认增强”，真实增强完成后再显示可编辑结果。typecheck、lint 和专业生图 UI 契约测试通过。工程记录见 `docs/active/专业生图最终提示词按需显示记录.md`。

2026-08-19 工程补充：`feature/simplify-prompt-enhancement-ui` 精简提示词增强交互，默认隐藏增强流程，仅保留模型选择与“确认增强”；原始创作需求为空时禁用，增强结果自动写入可编辑的最终提示词，后端继续提交原始需求、拼接结构化文案与语义优化指令。全量门禁为 Node/UI 265 项与 Vitest 725 项，共 990 项通过，0 失败、0 跳过；typecheck、lint、build 和差异检查通过。工程记录见 `docs/active/提示词增强交互精简记录.md`。

2026-08-19 工程补充：`feature/remove-professional-image-status-summary` 按 UI 反馈移除专业生图右侧状态摘要卡与四步进度条，仅保留“本地作品预览”及其真实阶段加载动画；内部提交状态机不变。全量门禁为 Node/UI 265 项与 Vitest 725 项，共 990 项通过，0 失败、0 跳过；typecheck、lint、build 和差异检查通过。工程记录见 `docs/active/专业生图状态摘要移除记录.md`。

当前状态：阶段 8 已正式收口；阶段 9 B1-B4、A1-A4、C1 与 C2 流程 1-8 已全部完成，并在 Windows x64 必需目标、macOS `required=false` 延期目标边界内正式收口。最终门禁为 Node 178 项与 Vitest 388 项，共 566 项通过，0 失败、0 跳过；Windows 九类套件全部 `passed`，Electron 4/4 响应且残留 0。macOS 保持 `not_run/deferred`，不声明已支持。Vidu 两项真实收费预算已用尽，Image V1 未决协议不晋级。阶段 10、服务商优化、安装包、签名、公证、生产更新、生产媒体分发、SBOM 和正式发布准入均未启动。

2026-08-18 工程补充：`feature/chat-renderer-diagnostics` 修复新建会话首条消息正文不出现的问题。根因是发送成功后新会话 `selectedId` 变化触发会话切换 effect，无条件 `clearResponseDraftState()` 清空刚建立的 `responseExecution`，流式订阅随后被 cleanup 取消；后端事件正常持久化，但 renderer 不再接收。修复后仅在活动执行不属于当前选中会话时清理回复状态，并新增仅开发环境启用的 ChatPage/preload 打点及主进程 console 转发（`userData/logs/renderer-trace.log`）。Electron + Vite 本地探针复现并验证：修复前 subscribe 后立即 unsubscribe、正文始终为“正在接收…”，修复后订阅保持到终态、正文正常渲染。完整门禁为 Node/UI 264 项与 Vitest 725 项，共 989 项通过，0 失败、0 跳过；typecheck、lint、build、平台审计、交接校验和差异检查通过。未调用真实服务商、未读取真实凭据、未产生收费请求。记录见 `docs/active/chat-renderer-diagnostics-验收记录.md`。

2026-08-18 工程补充：`feature/chat-model-selection-persistence` 按项目负责人规则将聊天页模型选择提升到 `App` 层，跨页面切换保持选择；候选刷新时仅保留仍存在且 `available` 的模型，不可用或已移除则清空选择。新增 ChatPage `initialCandidateId`/`onCandidateChange` 受控入口及 UI 合同断言。完整门禁为 Node/UI 264 项与 Vitest 725 项，共 989 项通过，0 失败、0 跳过；typecheck、lint、build、平台审计、交接校验和差异检查通过。未调用真实服务商、未读取真实凭据、未产生收费请求。记录见 `docs/active/chat-model-selection-persistence-验收记录.md`。

2026-08-17 工程补充：`feature/daily-changes-2026-08-17` 汇总今日已验证改动。会话链路新增 `ConversationExecutionCoordinator`、真实 adapter 取消、同会话活动 execution 拦截、受控事件订阅/确认/重放、启动恢复屏障，以及 Submission Intent、Provider Invocation 与 Usage 的终态回写；聊天页移除 200ms 全量轮询和乐观伪终态，并补齐归档/恢复入口。媒体链路为受控本地视频响应增加 HTTP Byte Range，作品库提供应用内全屏预览并隐藏不可用的 Chromium 原生全屏按钮；Vidu 结果下载使用独立的 5 分钟默认超时；此前 `feature/fix-video-result-recovery` 已恢复 Vidu 失败下载的原任务接收路径。完整门禁为 Node/UI 260 项与 Vitest 704 项，共 964 项通过，0 失败、0 跳过；typecheck、lint、build、332 文件平台审计、50 项交接校验和差异检查通过。`.tools/` 仅用于本地真实 FFmpeg 验证，未进入 Git；未调用真实服务商、未读取凭证、未产生收费请求。记录见 `docs/active/会话PR1-统一执行协调与真实取消验收记录.md`。PR2 跨实体补偿、远端 operation 重启重绑、PR5-PR8、阶段 10 与 macOS 实机目标仍未完成，不得由本次改动宣称支持。

2026-08-17 工程补充：`feature/task-parameter-reuse` 按项目负责人确认的规则实施三项改动。提示词增强判定从“仅项目上下文触发”扩展为“基础提示词之外存在结构化提示词内容即必须增强”：图片用途/编辑区域/编辑要求、视频镜头/动作/约束和已选项目上下文会合成 `<structured_input>` 参与增强指纹，增强结果直接写入可编辑的最终提示词；专业生图、文生视频与图生视频在准备/提交前由主进程门禁校验，图片编辑页接入同一增强面板并在检查编辑条件前阻断。仅选择项目上下文、未填写正文的草稿也允许增强；空结构化输入不改变旧增强指纹，避免历史结果全部失效。专业生图提示词区按负责人要求只保留可编辑的最终提示词，不再并列展示原始输入与系统补充，最终提示词区域改为 flex 顶满可用宽度。文生视频的镜头计划与“添加镜头”移动到第一步；图生视频的主体动作、镜头运动、节奏、景深及必须保持/允许变化/禁止变化也移动到第一步，与图片和项目上下文同区整理。生成完成后创建新的空白本地草稿并选中，原草稿与结果保留，即“清空的是 UI”。任务中心新增“复用参数”，按原草稿直接跳转对应图片/视频/基础编辑页并带出全部参数；跨项目复制直接报错且不执行。完整门禁为 Node/UI 262 项与 Vitest 714 项，共 976 项通过，0 失败、0 跳过；typecheck、lint、build 和 `git diff --check` 通过。未调用真实服务商、未读取真实凭证、未产生收费请求；阶段 10 与 macOS 延期边界不变。

2026-08-14 工程补充：`feature/text-stream-timeout-policy` 将文本模型流式超时统一为公共策略，并接入 DeepSeek、NewAPI、UniCompAPI 及其他经 NewAPI 运行时承载的 OpenAI 兼容文本模型。统一策略包含默认 60 秒响应头连接超时、只在等待上游下一分片时运行的 60 秒空闲超时，以及默认 15 分钟最终安全上限；本地解析、事件投影和保存当前分片的时间不计入上游空闲。配置采用公共默认值加服务商覆盖，`defaultTimeoutMs` 保持普通请求行为并作为连接/空闲配置兼容回退。图片、视频和轮询请求保持原有独立策略。实际完整门禁为 Node/UI 259 项与 Vitest 680 项，共 939 项通过，0 失败、0 跳过；typecheck、lint、build、平台审计、交接包校验和差异检查通过。未调用真实服务商、未读取真实凭证、未产生收费请求。记录见 `docs/active/文本模型流式超时统一化验收记录.md`。

2026-08-14 工程补充：同一 `feature/text-stream-timeout-policy` 继续修复文本流逐分片同步重写 execution JSON 导致的本地阻塞。共享 linked lifecycle 新增 execution 级有界批处理：相邻同类增量按 120ms 或 8KB UTF-8 合并持久化，未完成写入达到 256KB 时恢复上游背压，终态前 seal 并 drain，写入失败不得静默完成；DTO、IPC、仓储 Schema 和图片/视频调用语义不变。真实 JSON 仓储集成测试证明 100 个连续小正文分片只产生 1 个增量事件，并保持连续 sequence 与终态顺序。完整门禁为 Node/UI 260 项与 Vitest 688 项，共 948 项通过，0 失败、0 跳过；TypeScript、ESLint、生产构建、331 文件平台审计、50 项交接校验和差异检查通过。未调用真实服务商、未读取真实凭证、未产生收费请求。记录见 `docs/active/文本流增量持久化批处理验收记录.md`。

2026-08-14 工程补充：同一分支修正 UniCompAPI DeepSeek V4 推理请求回归。第一次实现错误地注入未出现在 UniCompAPI 公开 Chat Completions 合同中的 `thinking.type=enabled`；时间线确认 14:12 成功调用属于旧进程且只有正文、无思考分片，14:39 新进程首次请求以 `newapi.invalid_response` 失败。现按 UniCompAPI 官方 Apifox 合同改为仅对 `provider-package-unicompapi` 的 `deepseek-v4-flash/pro` 推理路由发送 `reasoning_effort`，空参数默认 `medium`，用户显式值优先；普通对话不注入，返回端继续只持久化真实 `reasoning_content`。聚焦测试 41 项通过；完整门禁为 Node/UI 260 项与 Vitest 691 项，共 951 项通过，0 失败、0 跳过；TypeScript、ESLint、生产构建、331 文件平台审计、50 项交接校验和差异检查通过。未由工程验证发起真实收费调用、未读取真实凭证。记录见 `docs/active/UniCompAPI-DeepSeek思考链修复验收记录.md`。

2026-08-14 工程补充：按项目负责人最新决策，模型与服务商画廊将 UniCompAPI 作为推荐供应商突出展示。推荐语义集中在本地品牌展示配置，不按供应商显示名称分支；画廊将推荐卡稳定排在首位，并以“推荐使用”标识、主题强调边框、轻量强调底色和独立品牌头像层级区别于普通卡片。连接、验证、模型目录和凭证业务逻辑保持不变。供应商页面合同测试新增推荐语义、排序、样式与名称解耦约束；浏览器真实 React 渲染覆盖 `1440x900` 深色与 `800x720` 浅色，UniCompAPI 名称无裁切、卡片与页面无横向溢出、按钮无重叠。实际完整门禁为 Node/UI 260 项与 Vitest 680 项，共 940 项通过，0 失败、0 跳过；typecheck、目标 ESLint、生产构建和差异检查通过。未调用真实服务商、未读取真实凭证、未产生收费请求，阶段 10 与 macOS 延期边界不变。

2026-08-12 工程补充：`feature/prompt-enhance-generalization` 在 PR1 → PR6 基础上完成提示词增强一次性令牌并发消费修复、`prompt_once` route/invocation/usage 审计接线和调用记录 `prompt_once` 主体扩展；模型/参数变化会在 UI 侧立即作废准备令牌，不伪造临时草稿状态参与结果指纹。实际完整门禁为 Node/UI 249 项与 Vitest 659 项，共 908 项通过，0 失败、0 跳过；typecheck、lint、build 和差异检查通过。未调用真实服务商与 Vidu，未进入阶段 10，当前待合并 `develop` 并保留本地/远程功能分支。记录见 `docs/active/提示词增强通用化与非流式改造验收记录.md`。

2026-08-13 工程补充：`feature/remove-outbound-reconfirmation` 按项目负责人最新决策，将专业生图、文生视频与图生视频的“准备生成 → 确认本次外发 → 确认并提交”合并为单次“生成”操作；动态参数填写完成后，页面自动保存草稿、准备并校验外发事实快照后立即提交，不再要求用户二次确认。IPC DTO、一次性选择令牌、`confirmationId`、主进程快照匹配与过期/篡改校验保持不变。实际完整门禁为 Node/UI 254 项与 Vitest 661 项，共 915 项通过，0 失败、0 跳过；typecheck、lint、build 和差异检查通过。未调用真实服务商或 Vidu，未进入阶段 10。

2026-08-13 工程补充：`feature/remove-outbound-reconfirmation` 按项目负责人“真实渲染效果”决策，将推理模型服务商流式响应中实际返回的公开 `reasoning_content` 独立投影为 `reasoningContent`，通过受控 `reasoning_delta` 事件实时渲染“模型返回的思考内容”，并在正常完成或失败终态持久化到 assistant 历史消息；最终回答仍只来自 `content`。普通 `text_chat` 即使收到网关非预期推理字段也不接受、不持久化、不展示；服务商未返回该字段时 UI 不模拟、不补写。历史消息使用可折叠安全 Markdown 展示，旧版对话 JSON 无需迁移且 user 消息禁止携带该字段。完整门禁为 Node/UI 254 项与 Vitest 662 项，共 916 项通过，0 失败、0 跳过；typecheck、lint、build 和 `git diff --check` 通过。未调用真实服务商、未读取真实凭证、未产生收费调用，阶段 10 与 macOS 延期边界不变。

仓库原始状态为空仓库，已开始建立工程基线，并已归档产品经理交接资料。

项目边界已确认：本仓库承接完整 UniComp 桌面应用，技术栈采用 Electron + React + TypeScript。已有后台服务作为外部依赖接入，本仓库不重做后台。

## 阶段 0｜接管审计与工程基线

目标：

- 建立仓库结构；
- 归档交接资料；
- 明确资料优先级；
- 明确开发分工；
- 确认技术栈；
- 建立最小可运行 Electron 应用；
- 建立测试、构建和验收记录方式。

验收：

- [x] 建立 `handoff/` 资料归档目录；
- [x] 建立 `AGENTS.md`；
- [x] 建立 `PLANS.md`；
- [x] 建立基础 `README.md`；
- [x] Git 远程已指向 `https://github.com/XlNGI/unicompapi.git`；
- [x] 项目负责人确认本仓库边界：完整桌面应用；
- [x] 项目负责人确认技术栈：Electron + React + TypeScript；
- [ ] 后台团队提供接口地址、鉴权方式和请求/响应示例（阶段 4 启动前置依赖，不阻塞阶段 2）；
- [x] 建立最小可运行 Electron 应用；
- [x] 建立基础构建命令；
- [x] 建立基础测试命令；
- [x] 形成阶段 1 任务拆分。

阶段 1 任务拆分文档：

```text
docs/active/阶段1-任务拆分.md
```

阶段 1 以“两名 UI 开发者版本”完成。阶段 2 起按最新双人分工执行：开发者 B 负责本地领域与平台，开发者 A 负责 UI 状态系统与后续页面准备。

## 当前关键问题

本仓库边界已经确认为完整桌面应用。现在需要先完成 Electron 工程基线，同时向后台团队确认接口契约：

1. 后台 Base URL；
2. 鉴权方式：无鉴权、API Key、Bearer Token、签名，还是其他方式；
3. 目标接口路径、HTTP 方法、请求体、响应体；
4. 错误码和重试策略；
5. 是否需要代理、超时、日志脱敏；
6. 是否需要支持 Windows 终端和 macOS 终端。

当前验证记录：

- TypeScript 工程校验已通过；
- Vite 渲染端生产构建已通过；
- Electron 依赖、Windows 主窗口启动和窗口控制已在本机验证通过。
- 阶段 1 桌面壳已接入八个一级页面及图片 5 项、视频 4 项二级导航；测试、类型检查、ESLint、生产构建和 Windows 人工验收通过。
- 阶段 1 已加入无面包屑全局上边栏和统一三态主题；主题切换、持久化和 Windows 系统主题联动人工验收通过。
- Windows 截图证据已归档到 `docs/active/evidence/phase1/windows/`。
- macOS 实机验收按当前项目安排暂缓，移入阶段 9，不标记为通过。
- 阶段 2 第一批领域契约已建立：项目、草稿、素材、文件引用、任务、执行记录和作品实体，以及执行、文件和任务状态规则；存储、索引、恢复实现和 IPC 尚未开始。
- Vitest 2 已作为 TypeScript 领域单元测试基础接入；当前领域测试 18 项通过，UI 契约测试 11 项通过。
- 阶段 2 第二批本地存储契约已建立：安全相对路径、固定目录布局、文件索引纯函数、仓储端口和原子 JSON 写入接口；真实文件系统适配器尚未开始。
- 阶段 2 Node 文件系统适配器已建立：项目根目录约束、JSON 读取、同目录临时文件写入、`fsync`、原子替换、幂等删除和目录创建已在 Windows 临时目录测试通过；仓储实现、SHA-256 执行器、恢复服务和 IPC 尚未开始。
- 阶段 2 JSON 仓储已建立：项目、草稿、素材、文件引用、任务、执行记录和作品支持版本化读取、按 ID 保存、作用域查询、运行时校验及并发写入串行化；Schema 迁移和 IPC 尚未开始。
- 阶段 2 SHA-256 校验与文件状态探测已建立：流式校验、真实字节进度、缺失/断盘/权限/损坏判定和恢复建议已在 Windows 临时目录通过；备份恢复、重新下载和 IPC 尚未开始。
- 阶段 2 校验持久化和安全 relink 已建立：基准 Hash 与最后观察证据分离，FileReference 和派生索引按顺序保存，用户确认且 Hash 匹配后才更新 locator；备份恢复、重新下载、索引自动重建和 IPC 尚未开始。
- 阶段 2 文件索引自动重建已建立：以 FileReference 为事实源完整替换派生索引，外部文件跳过，路径冲突时不覆盖旧索引；备份恢复和重新下载尚未开始。
- 阶段 2 最小受控存储 IPC 已建立：渲染进程仅能按 fileId 调用探测、校验、原生文件选择 relink 和索引重建；主进程持有项目根目录，DTO 不返回绝对路径或原始 Hash。
- 阶段 2 活动项目 session 已建立：主进程原生目录选择、`project.json` 验证、session 设置/查询/清理和存储变更队列协调已通过平台测试；项目页面调用与 Windows 可见窗口联调已在阶段 2 收口前完成。
- 阶段 2 首次 `develop` 联调验收已完成：29 项测试、类型检查、ESLint、生产构建、Windows Electron 启动和 UI 状态预览通过；真实文件系统适配器、仓储/原子写入执行器、恢复服务和存储 IPC 尚未实现，阶段 2 暂不关闭。
- 阶段 2 Windows 文件系统适配器已合并并复验：32 项测试及完整构建门禁通过；真实仓储、SHA-256 校验/恢复服务和存储 IPC 尚未实现，等待项目负责人验收。
- 阶段 2 联调记录见 `docs/active/阶段2-联调验收记录.md`。

## 阶段 2｜收口结论

项目负责人于 2026-07-22 确认阶段 2 工程门禁通过并正式关闭。

已完成：

- 本地领域实体、状态机和仓储契约；
- Windows Node 文件系统适配器、原子 JSON 写入和版本化仓储；
- SHA-256 校验、状态探测、持久化、安全 relink 和索引重建；
- 项目 Session、项目页面接入和 Windows 可见窗口联调；
- 备份恢复执行器及仅接受 `fileId` 的受控 IPC；
- 66 项自动化测试、TypeScript、ESLint、生产构建和差异检查通过。

后置事项：恢复 UI 与新建项目页面进入阶段 3；重新下载等待阶段 4 后台契约；macOS 实机验证进入阶段 9；真实备份生命周期和 Schema 迁移按后续需求单独设计。

阶段 3 启动前必须先形成任务拆分，继续保持开发者 A 负责 UI/页面、开发者 B 负责领域/平台的边界。

阶段 3 任务拆分文档：

```text
docs/active/阶段3-任务拆分.md
```

首轮顺序：开发者 B 先实现项目目录与新建项目契约；合并到 `develop` 后，开发者 A 接入项目中心 UI。任务中心、作品库和对话页继续按小 PR 推进。

阶段 3 B1 已完成：项目目录目录服务、新建项目、最近项目摘要和 `createProject/listProjects` 受控 IPC 已通过平台与完整测试，等待开发者 A 接入项目中心 UI。

阶段 3 B2 已完成：跨项目任务/作品摘要与详情读模型、项目级断盘/损坏隔离和 `listTasks/getTaskDetails/listWorks/getWorkDetails` 受控 IPC 已通过完整测试。开发者 A 可据此接入项目中心、任务中心和作品库。

阶段 3 B3 已完成：按 `workId` 创建短期 `unicomp-media` 媒体句柄和系统文件定位的受控主进程流程已建立；renderer 不接收绝对路径，句柄过期、文件缺失和不可预览类型均有真实错误状态。

阶段 3 收口记录：

```text
docs/active/阶段3-联调验收记录.md
```

项目负责人已确认阶段 3 通过并关闭。最终门禁为 30 项 UI/安全契约测试、59 项领域与平台测试、TypeScript、ESLint、生产构建和 Windows 四页可见窗口验收通过。

阶段 4 任务拆分文档：

```text
docs/active/阶段4-任务拆分.md
```

阶段 4 首轮由开发者 B 实现服务商/连接/模型领域契约。后台 Base URL、鉴权和接口示例仍为真实阻断项，不影响本地契约与安全凭证边界先行。

阶段 4 B1 已完成：服务商、连接、模型、能力证据和路由偏好领域契约、版本化本地注册表及只读 `providers:get-registry` IPC 已建立；DTO 不返回 endpoint 或凭证引用，未预置任何厂商和模型。

阶段 4 B2 已完成：本机安全凭证库、Electron `safeStorage` 适配及保存/替换、本地删除、状态查询和本地安全存储检查 IPC 已建立；renderer 不提供明文读取，密文仅保存在应用用户目录。删除本地凭证明确不等于撤销服务商侧凭证；真实远端验证继续等待 B3 与后台契约。

阶段 4 B3 已完成：连接验证、能力验证和模型目录同步端口相互分离；手工模型登记、用户能力证据、路由偏好及提交前路由计划已建立。未配置真实适配器时返回 `adapter_unavailable`，不伪造连接成功、模型目录或已验证能力；费用、隐私和地区继续保持 `unknown`，自动路由始终要求提交前确认。

阶段 4 B 侧补充项已完成：根据开发者 A 联调反馈，补齐服务商创建、连接创建/更新/启停/软删除以及模型启停受控 IPC。连接软删除会清除 endpoint 和本地凭证、停用关联模型与路由，但保留连接、模型和能力事实 ID，不删除历史任务、作品或来源记录。

## 阶段 4｜收口结论

项目负责人完成开发者 A/B 最新 `develop` 联调。服务商、连接、模型、能力证据、安全凭证、目录同步端口、路由偏好和模型与服务商页面均已接通；默认 Windows 窗口真实 preload/IPC 验证通过。

最终门禁为 39 项 UI/IPC/安全契约测试、72 项领域与平台测试、TypeScript、ESLint、生产构建、差异检查和 Windows 可见窗口验收通过。联调证据与结论见：

```text
docs/active/阶段4-联调验收记录.md
```

后台接口契约和真实 HTTP 适配器继续作为外部后置阻断；macOS 实机验证进入阶段 9。阶段 5 启动前必须先形成图片创作任务拆分。

阶段 4 A 页面已完成：模型与服务商页面已接入真实本地注册表和受控 IPC，覆盖服务添加、自定义兼容接口、连接筛选与启停、模型目录与启停、连接信息、凭证安全、历史验证、能力证据和默认用途；未配置后台适配器时保持真实不可验证状态。联调同时修复停用连接仍可能进入路由候选的问题。

## 阶段 5｜图片创作

阶段 5 任务拆分文档：

```text
docs/active/阶段5-任务拆分.md
```

阶段 5 仅包含快速生图、专业生图、图片识别、图片编辑和图片转提示词五个模式。多图参考、图片批量创作继续禁止；保存草稿不得自动创建任务，选择图片不得自动上传或分析。

首轮由开发者 B 从最新 `develop` 创建 `feature/image-workspace-contracts`，建立五类工作区草稿、单图输入、上下文引用、提示词分层、动态能力证据参数和非破坏版本关系契约。开发者 A 可同步整理五张页面与图片转提示词双状态的组件清单，但在 B1 DTO 合并前不得写死模型、参数、费用或伪造结果。

阶段 5 B1 已完成：新增五模式图片工作区判别联合、单图输入与区域、项目上下文、提示词三层、动态能力证据参数、识别原始结果与用户修订、编辑父版本关系、图片转提示词过期状态和派生草稿契约；新增版本化 JSON 仓储、运行时校验及 `create/get/update/list/derive` 本地受控 IPC。草稿操作必须依赖当前已打开项目，保存和派生均不创建任务；renderer DTO 不包含项目路径、原始 Hash、凭证、endpoint 或内部错误堆栈。

B1 完整门禁为 40 项 UI/IPC/安全契约测试、86 项领域与平台测试，共 126 项且 0 失败；TypeScript、ESLint、生产构建和差异检查通过。工程记录见：

```text
docs/active/阶段5-B1-图片工作区领域契约记录.md
```

B1 已通过 `dda88a7 Merge image workspace contracts` 合并到 `develop`。开发者 A、B 均从该基线分别推进 A1 公共工作区和 B2 本地单图输入；真实上传、生成、识别、编辑、提示词分析和 HTTP 适配器仍未开始，继续等待后台契约。

阶段 5 A1 已完成：五个图片入口复用公共工作区，接入当前项目、图片草稿列表、创建与保存本地草稿，以及阶段 4 已启用模型数量；覆盖读取中、未打开项目、无草稿、无图片输入、无已启用模型、能力未知、适配器不可用和草稿保存失败状态。当前选择图片、受控预览、动态参数、能力预检和任务提交均保持禁用，不显示示例结果或假进度。

A1 完整门禁为 44 项 UI/IPC/安全契约测试、86 项领域与平台测试，共 130 项且 0 失败；TypeScript、ESLint、生产构建和差异检查通过。浏览器 1080×720 与 1280×720 可见布局无横向溢出，控制台无警告或错误。Windows Electron 自动捕获工具不支持当前窗口，真实桌面点击验收等待项目负责人手工完成。工程记录见：

```text
docs/active/阶段5-开发者A公共工作区记录.md
```

阶段 5 B2 已完成：图片只通过主进程原生文件选择器获得明确授权，不接收 renderer 路径；本地检查按文件内容识别 PNG、JPEG、GIF、WebP 和 BMP，读取真实像素尺寸、字节数并流式计算 SHA-256。通过校验后登记外部 FileReference 与 imported Asset，图片工作区只保存 Asset ID；预览前重新校验文件并生成短期 `unicomp-media` 句柄，协议响应使用已识别 MIME，不向 renderer 返回绝对路径或原始 Hash。图片、区域、用途和要求变化会保留旧分析并标记过期；整个流程不上传、不分析、不创建任务、执行或作品。

B2 分支原始门禁为 40 项 UI/IPC/安全契约测试、95 项领域与平台测试，共 135 项且 0 失败；TypeScript、ESLint、生产构建和差异检查通过。工程记录见：

```text
docs/active/阶段5-B2-本地图片输入与预览记录.md
```

A1+B2 集成门禁为 44 项 UI/IPC/安全契约测试、95 项领域与平台测试，共 139 项且 0 失败；TypeScript、ESLint、生产构建和差异检查通过。集成时补齐 A1 对 B2 新增 `input_not_found`、`image_unreadable`、`unsupported_image` 和 `preview_unavailable` 错误码的真实提示。

阶段 5 B3 已完成：阶段 4 能力证据新增通用动态参数 Schema，不预置参数名；图片预检按用途、可用连接、已启用模型、路由偏好、已验证能力、Schema 和草稿参数筛选候选。预检、显式确认创建任务、创建执行、远端调用和结果接收保持独立；确认快照冻结接收方、外发范围、费用/隐私/地区未知状态、模型、能力证据、最终提示词和参数。无真实调用或结果适配器时返回 `adapter_unavailable`，不创建假进度或假结果。

结果接收端口按远端完成、下载到 `tmp`、内容类型/字节/Hash 校验、`fsync` 与原子移动、FileReference、Execution 完成和 Work 登记顺序执行；失败不登记作品，重试创建新 Execution。

B3 完整门禁为 45 项 UI/IPC/安全契约测试、106 项领域与平台测试，共 151 项且 0 失败；TypeScript、ESLint、生产构建和差异检查通过。工程记录见：

```text
docs/active/阶段5-B3-能力预检提交与结果接收记录.md
```

阶段 5 A2 快速生图已完成：接入一句话需求、可选单张受控参考图与本地预览、注册表动态模型和参数 Schema、能力预检，以及接收方/外发范围/费用/最终提示词/模型五项确认。进入专业创作只创建派生草稿；无真实适配器时只允许保存本地草稿和查看 `adapter_unavailable` 等真实阻断原因，提交任务、重新生成和保存结果保持禁用。

A2 快速生图完整门禁为 48 项 UI/IPC/安全契约测试、106 项领域与平台测试，共 154 项且 0 失败；TypeScript、ESLint、生产构建和差异检查通过。浏览器 1080×720 与 1280×720 无横向溢出，控制台无警告或错误。工程记录见：

```text
docs/active/阶段5-A2-快速生图页面记录.md
```

快速生图已通过 `b27d6bc Merge quick image workspace` 合并到 `develop`。专业生图从该基线单独创建 `feature/professional-image-ui`；图片识别、图片编辑和图片转提示词不混入当前分支。

阶段 5 A2 专业生图已完成：分别展示项目素材、项目上下文和已保存对话上下文及真实已选数量；由于 B1 DTO 尚未提供三类候选列表接口，新增选择保持禁用并解释原因。页面接入原始需求、单张受控参考图及用途、原始输入/系统补充/最终提示词三层对比、注册表动态模型与参数 Schema、能力预检和五项提交确认。保存草稿、预检、提交、重新生成与保存结果保持独立；缺少真实适配器时不创建任务、不展示假结果或假进度。

A2 专业生图完整门禁为 51 项 UI/IPC/安全契约测试、106 项领域与平台测试，共 157 项且 0 失败；TypeScript、ESLint、生产构建和差异检查通过。浏览器 1080×720 与 1280×720 无横向溢出。工程记录见：

```text
docs/active/阶段5-A2-专业生图页面记录.md
```

专业生图已通过 `70bc588 Merge professional image workspace` 合并到 `develop`。

阶段 5 A3 图片识别已完成：接入单张受控源图片与预览、识别目的、自定义归一化区域、真实能力预检和动态候选模型；可见事实、模型推断、不确定、无法识别和用户修改五类结果分别展示。用户修订追加为独立记录，不覆盖模型原始观察；图片、区域或目的变化后，旧结果继续保留并明确标记过期原因。

结果保存范围可记录为仅草稿或项目上下文；由于项目上下文登记端口尚未提供，页面只保存真实范围意图并解释边界。转入图片转提示词、图片编辑或专业生图只创建派生草稿；没有真实识别适配器时不创建任务、不上传图片、不显示假结果或假进度。

A3 图片识别完整门禁为 54 项 UI/IPC/安全契约测试、106 项领域与平台测试，共 160 项且 0 失败；TypeScript、ESLint、生产构建和差异检查通过。浏览器 1080×720 与 1280×720 的入口、标题和未打开项目状态无横向溢出。工程记录见：

```text
docs/active/阶段5-A3-图片识别页面记录.md
```

图片识别已通过 `cad83dc Merge image understanding workspace` 合并到 `develop`。

阶段 5 A3 图片编辑已完成：接入单张受控原图与预览、原始编辑要求、必须保留/必须修改/禁止出现三类清单、归一化编辑区域、动态模型与参数 Schema、真实能力预检和五项提交确认。蒙版选择接口尚未提供，页面明确禁用并解释，不接收 renderer 任意路径。

版本关系分别展示源 Asset、父草稿和父作品；真实结果适配器缺失时不覆盖原图、不创建任务、不显示假结果。转入图片转提示词或专业生图只创建派生草稿。共享模型控件按 `image_generation` 与 `image_editing` 用途筛选真实路由，未新增依赖。

A3 图片编辑完整门禁为 57 项 UI/IPC/安全契约测试、106 项领域与平台测试，共 163 项且 0 失败；TypeScript、ESLint、生产构建和差异检查通过。浏览器 1080×720 与 1280×720 的入口、标题和未打开项目状态无横向溢出。工程记录见：

```text
docs/active/阶段5-A3-图片编辑页面记录.md
```

图片编辑已通过 `ea79ed3 Merge image editing workspace` 合并到 `develop`。

阶段 5 A3 图片转提示词已完成：同时覆盖未分析、当前结果和结果过期三种状态；接入单张受控源图片、目标用途、逐行补充要求、归一化分析区域、真实能力预检和动态候选模型。结果将图片可见事实、模型推断、不确定、无法识别、系统补充和最终提示词草稿分开呈现，用户编辑最终草稿不会覆盖原始观察。

图片、区域、用途或补充要求变化后，旧观察和旧提示词继续保留并分别显示过期原因。转入专业生图或图片编辑只创建派生草稿；缺少真实分析适配器时不创建任务、不上传图片、不显示假提示词或假进度。

A3 图片转提示词完整门禁为 60 项 UI/IPC/安全契约测试、106 项领域与平台测试，共 166 项且 0 失败；TypeScript、ESLint、生产构建和差异检查通过。浏览器 1080×720 与 1280×720 的入口、标题和未打开项目状态无横向溢出。工程记录见：

```text
docs/active/阶段5-A3-图片转提示词页面记录.md
```

开发者 A 的公共工作区、快速生图、专业生图、图片识别、图片编辑和图片转提示词已经全部完成；本轮合并后在最新 `develop` 执行统一回归与 Windows Electron 手工验收。

图片转提示词已通过 `85d75e0 Merge image to prompt workspace` 合并到 `develop`。最新 `develop` 统一回归为 60 项 UI/IPC/安全契约测试、106 项领域与平台测试，共 166 项且 0 失败；TypeScript、ESLint、生产构建和差异检查通过。五个图片入口在 1080×720 与 1280×720 下逐页检查，标题正确且无横向溢出。统一记录见：

```text
docs/active/阶段5-开发者A图片页面统一验收记录.md
```

真实生成、识别、编辑和提示词分析 HTTP 适配器继续等待后台 Base URL、鉴权、接口、错误码和媒体限制契约；该阻断不影响本地工作区与离线页面先行。

## 阶段 5｜收口结论

项目负责人在开发者 A/B 最新 `develop`（`e2ca5e9`）完成统一联调。五个图片模式、项目内草稿、受控单图输入与预览端口、动态能力预检、确认快照、任务/执行/调用分层、结果接收边界和真实离线页面已经接通。

最终门禁为 60 项 UI/IPC/安全契约测试、106 项领域与平台测试，共 166 项且 0 失败；TypeScript、ESLint、生产构建和差异检查通过。Windows 生产 Electron 在 `1280×820` 下完成五入口切换、未打开项目门禁、真实项目打开、本地草稿创建/保存与派生、无模型和 `adapter_unavailable` 状态检查；联调测试数据已经清理。验收记录见：

```text
docs/active/阶段5-联调验收记录.md
```

项目负责人统一手工验收已确认受控选图、本地预览、草稿保存和派生草稿切换通过；单图内容签名、尺寸、字节、Hash、登记、短期预览和异常路径同时由 5 项本地媒体平台测试覆盖。该结论仍只覆盖本地/离线能力，不等同于真实在线图片能力完成。

后台 Base URL、鉴权、接口、错误码、动态媒体限制和结果契约仍为外部后置阻断；项目上下文候选、蒙版选择和上下文登记端口按后续小 PR 补充；macOS 实机验证进入阶段 9。阶段 6 实现前必须先形成视频创作任务拆分。

## 阶段 6｜视频创作

阶段 6 任务拆分文档：

```text
docs/active/阶段6-任务拆分.md
```

阶段 6 只推进快速视频、文生视频和图生视频的项目内本地草稿、显式素材选择、提示词三层、镜头方案、动态能力预检、确认快照、任务/执行边界、结果接收端口和真实离线页面。视频批量创作继续禁止；保存草稿、提示词增强和进入其他页面不得自动创建任务。

“基础编辑”继续保留第四个冻结入口，但阶段 6 不实现时间线、媒体引擎、代理文件或正式导出。阶段 7 开始前必须按 `handoff/UniComp-技术开发启动包-V1.0.0/03-最终UI交接包-已解压/UniComp-AI-最终UI与开发交接包-V1.2.1/docs/09-视频基础编辑技术架构与能力边界-V1.2.1.md` 完成编辑草稿 Schema、媒体引擎接口、预览/导出分层、导出状态机、文件策略、硬件回退、跨平台边界和测试计划并由项目负责人批准。

开发者 B 首个任务为 `feature/video-workspace-contracts`；开发者 A 可同步整理四张冻结设计图的页面区域和状态清单，但在 B1 DTO 合并前不得写死模型、时长、比例、分辨率、帧率、数量、费用或示例结果。

阶段 6 B1 已完成：新增快速视频、文生视频和图生视频三模式严格判别联合，建立提示词三层、显式上下文、快速视频单参考素材、能力证据绑定的动态素材槽位、镜头草稿、分镜状态、图生视频变化要求、增强/预检过期和派生草稿关系。新增版本化 JSON 仓储及 `create/get/update/list/derive` 受控 IPC；未打开项目不能创建草稿，DTO 不返回路径、原始 Hash、凭证、endpoint、远端 operation ID 或编辑器内部状态。

B1 完整门禁为 63 项 UI/IPC/安全契约测试、122 项领域与平台测试，共 185 项且 0 失败；TypeScript、ESLint、生产构建和差异检查通过。工程记录见：

```text
docs/active/阶段6-B1-视频工作区领域契约记录.md
```

阶段 6 A1 已完成：快速视频、文生视频和图生视频复用公共视频工作区，接入当前项目及 B1 的 `list/create/update` 本地草稿操作，覆盖读取中、未打开项目、无草稿、保存失败、无视频路由、能力未知、素材端口未接入、旧预检过期、适配器不可用和费用未知状态。四个视频入口继续由 `creationModes.ts` 单一来源驱动；基础编辑只显示阶段 7 准入阻断，不创建编辑草稿、时间线或导出任务。

A1 完整门禁为 67 项 UI/IPC/安全契约测试、122 项领域与平台测试，共 189 项且 0 失败；TypeScript、ESLint、生产构建和差异检查通过。浏览器 1080×720 与 1280×720 下四个入口无横向溢出，控制台无警告或错误；Windows Electron 生产窗口启动和初始可访问状态通过，真实桌面点击等待项目负责人手工验收。工程记录见：

```text
docs/active/阶段6-A1-公共视频工作区记录.md
```

阶段 6 B2 已完成：视频工作区只能通过 Electron 主进程原生选择器取得图片或视频；图片继续复用内容签名与像素探测，视频通过独立 `VideoInspector` 端口按文件内容识别 ISO BMFF MP4/MOV 容器、时长、宽高和可读性，不信任扩展名，也未引入阶段 7 FFmpeg/媒体引擎。检查前后元数据必须一致，并使用流式 SHA-256 建立 FileReference；项目内文件与外部授权引用显式区分，Asset 保存受控视频元数据，草稿只保存 Asset ID、媒体类型、槽位角色和选择时间。

B2 新增 `selectMaterial/getMaterial/clearMaterial/createMaterialPreview` 受控 IPC。快速视频只允许一个参考素材；文生/图生视频只能绑定已有能力证据槽位，媒体类型和角色必须匹配。预览前重新校验本地内容，仅返回短期 `unicomp-media` 句柄、MIME 和安全元数据；文件丢失、变化或不可读时保留草稿并返回真实异常状态，不创建 Task、Execution 或 Work。当前可信内置视频探测范围为 ISO BMFF MP4/MOV；其他容器明确返回不支持，等待后续经过批准的探测适配器，不伪造元数据。工程记录见：

```text
docs/active/阶段6-B2-受控参考媒体与本地预览记录.md
```

B2 完整门禁为 63 项 UI/IPC/安全契约测试、129 项领域与平台测试，共 192 项且 0 失败；TypeScript、ESLint、生产构建和差异检查通过。

A1+B2 集成门禁为 67 项 UI/IPC/安全契约测试、129 项领域与平台测试，共 196 项且 0 失败；TypeScript、ESLint、生产构建和差异检查通过。集成时补齐 A1 对 B2 新增素材目标、类型不匹配、文件不支持、素材变化和预览不可用错误码的真实提示，并将页面状态更新为“B2 端口已具备、A1 页面尚未接线”；未提前实现素材选择或预览 UI。

阶段 6 B3 已完成：Provider 能力证据新增版本化视频生成模式 Schema，动态声明模型支持的快速视频、文生视频和图生视频模式、快速视频可接受参考类型、专业模式素材槽位以及镜头方案约束；未提供参数 Schema、模式 Schema、已验证能力证据或 `video_generation` 路由时明确阻断，不推测模型限制。视频预检同时校验草稿状态、最终提示词、模型/能力快照、动态参数、素材槽位版本、必需素材、Asset/FileReference 本地状态、媒体类型/角色和镜头数量约束。

B3 新增六项显式确认快照，冻结接收方、访问类型、外发范围、素材范围、费用/隐私/地区未知状态、最终提示词、模型、能力证据、动态参数、上下文和模式特有输入。新增分离的 `preflight/createTask/createExecution/invokeExecution` IPC 与视频生成提交端口；Task 不自动创建 Execution，远端 operation ID 只保存在主进程 Execution。默认没有视频适配器，预检和调用返回真实 `adapter_unavailable`；没有新增进度、轮询、取消、结果接收或下载接口。工程记录见：

```text
docs/active/阶段6-B3-能力预检与提交流水线记录.md
```

B3 完整门禁为 70 项 UI/IPC/安全契约测试、139 项领域与平台测试，共 209 项且 0 失败；TypeScript、ESLint、生产构建和差异检查通过。A1 页面仅更新为“B3 端口已具备、页面尚未接线”，未提前实现开发者 A 后续页面交互。

阶段 6 A2 快速视频页面已完成：接入一句话需求、由当前视频模式能力 Schema 决定媒体类型的单个可选参考素材、受控图片/视频预览、动态模型与参数、预检、六项提交确认，以及相互独立的 Task、Execution 和远端调用操作。保存草稿、移除素材、重新生成、保存结果和进入文生视频均为独立操作；进入文生视频只创建派生草稿。结果数量不写死，无真实适配器或 B4 作品登记时不创建任务、不展示假进度、假费用或假结果。

A2 完整门禁为 74 项 UI/IPC/安全契约测试、139 项领域与平台测试，共 213 项且 0 失败；TypeScript、ESLint、生产构建和差异检查通过。浏览器 1080×720 与 1280×720 无横向溢出，控制台无警告或错误；项目负责人已完成 Windows Electron 项目、真实 preload 和页面交互手工验收并确认通过。工程记录见：

```text
docs/active/阶段6-A2-快速视频页面记录.md
```

阶段 6 A3 文生视频页面已完成：区分短创意与长文本/故事/脚本，分别展示项目素材、项目上下文和已保存对话上下文的明确选择数量；当前 DTO 没有上下文候选接口时新增选择保持禁用，且不自动读取。页面按能力 Schema 建立动态素材槽位和镜头数量约束，支持手工添加、编辑、排序和删除本地镜头草稿，并展示分镜当前/过期状态；生成镜头、生成分镜和提示词增强缺少真实端口时保持禁用。

A3 同时接入用户原始输入、系统补充与最终提交提示词三层、动态模型/参数、预检、六项确认和相互独立的 Task、Execution、远端调用操作。宽屏验收反馈后已改为连续主工作流和独立提交侧栏，消除三列等高网格造成的空白断层。完整门禁为 79 项 UI/IPC/安全契约测试、139 项领域与平台测试，共 218 项且 0 失败；TypeScript、ESLint、生产构建和差异检查通过。浏览器宽屏布局夹具与 1280×720 响应式状态无横向溢出；项目负责人已完成 Windows Electron 项目、动态槽位、镜头保存、真实 preload 交互和修订布局手工验收并确认通过。工程记录见：

```text
docs/active/阶段6-A3-文生视频页面记录.md
```

阶段 6 A4 图生视频页面已完成：素材槽位、角色、数量、必填状态与可接受媒体类型只从图生视频能力 Schema 建立，不写死首帧、尾帧或主体参考；本地素材选择、可信登记、短期预览与移除复用 B2 受控端口，不自动识图、增强提示词、上传或创建任务。必须保持、允许变化、必须避免、主体动作、运镜、节奏和景深分别保存，不根据图片静默推断。

A4 同时接入用户原始输入、系统补充与最终提交提示词三层、旧增强/预检过期状态、动态模型/参数、六项确认和相互独立的预检、Task、Execution、远端调用操作。1—4 区采用连续主工作流，第 5 区作为宽屏提交侧栏，避免动态槽位高度造成空白断层；阶段 7 与正式 Work 未接入时“进入基础编辑”保持禁用并说明原因。完整工程门禁为 84 项 UI/IPC/安全契约测试、139 项领域与平台测试，共 223 项且 0 失败；TypeScript、ESLint、生产构建和差异检查通过。浏览器宽屏布局夹具与 1500px 以下响应式状态无横向溢出；项目负责人已完成 Windows Electron 页面交互与布局手工验收并确认 A4 通过。工程记录见：

```text
docs/active/阶段6-A4-图生视频页面记录.md
```

阶段 6 B4 已完成：新增视频结果端口，严格分离远端完成事实、结果发现和分块下载流。每个结果必须由服务完整声明 MIME、容器、字节数、SHA-256、时长和宽高；主进程使用 pipeline 流式写项目临时文件，超过声明字节数立即终止，并依次执行 fsync、常规文件检查、B2 可信视频探测和流式 Hash 校验，不把完整视频送入 renderer 或缓冲进主进程内存。

通过临时校验的结果使用同卷排他硬链接原子发布到独立项目结果文件，不覆盖历史版本；正式路径再次完成媒体与 Hash 校验。全部结果的 available FileReference 和索引持久化成功后 Execution 才能 completed，随后每个结果分别登记独立 Work 和来源 Task/Execution 关系。任一下载、探测、声明、Hash、fsync、发布或本地记录失败均不创建 Work；Work 登记失败不返回成功，并保留 completed Execution 与可恢复的正式文件事实。

B4 新增 `receiveResult(executionId)` 安全 IPC，renderer 只接收 Execution ID、Work ID 和显示名称。当前 Electron 未注入真实视频结果适配器，调用保持 `adapter_unavailable`，不伪造完成、进度、下载或视频作品。完整门禁为 84 项 UI/IPC/安全契约测试、147 项领域与平台测试，共 231 项且 0 失败；TypeScript、ESLint、生产构建和差异检查通过。工程记录见：

```text
docs/active/阶段6-B4-视频结果接收与作品登记记录.md
```

## 阶段 6｜收口结论

阶段 6 的视频工作区领域、本地草稿、快速视频单参考素材、专业模式动态素材槽位、可信 MP4/MOV 探测、受控预览、动态能力预检、六项确认快照、Task/Execution 分层、视频结果流式下载/校验/原子发布、正式 Work 登记端口，以及快速视频、文生视频和图生视频三个真实离线页面均已接通并合并最新 `develop`。

最终门禁为 84 项 UI/IPC/安全契约测试、147 项领域与平台测试，共 231 项且 0 失败；TypeScript、ESLint、生产构建和差异检查通过。项目负责人已完成 A2/A3/A4 Windows Electron 真实 preload、项目状态、本地素材、动态槽位、草稿保存/重载和页面交互手工验收；最终合并生产构建的 Electron 启动烟测保持 4 个新进程响应。

收口联调修复 B4 已合并后页面仍显示“等待 B4”的过期状态。页面现在明确显示 B4 结果登记端口已具备，但真实视频生成与结果适配器尚未配置；不会伪造进度、费用、结果、下载或基础编辑能力。验收记录见：

```text
docs/active/阶段6-联调验收记录.md
```

后台视频生成/结果契约、真实适配器、更多视频容器、自动镜头/分镜/增强/识别端口和 macOS 实机验证继续作为后置项。阶段 7 必须先按权威编辑架构文档形成独立任务拆分、引擎选型、许可与分发、状态机、文件策略、硬件回退和跨平台测试计划，并由项目负责人批准后再实施。

## 阶段 7｜视频基础编辑

阶段 7 规划文档：

    docs/active/阶段7-技术架构.md
    docs/active/阶段7-任务拆分.md

规划结论：V1.0 采用本地优先、非破坏式、轻量单轨架构。编辑草稿使用严格版本化 EditDraft 和结构化命令；快速预览与正式导出共享领域语义但使用独立计划；正式导出冻结 ExportPlan，通过后台 Task 与独立 Execution/attempt 执行，并在媒体校验、原子发布、FileReference 和 Work 登记全部成功后完成。

范围包含多视频片段顺序拼接、裁剪、分割、删除/恢复、复制、排序、经引擎真实验证的基础转场、基础画布变换、统一/单片段变速、多个基础文字层、原声设置、一条背景音乐、封面、自动保存、撤销/重做、草稿复制以及本地导出、取消、失败、重试和恢复。

范围明确排除专业多轨、画中画、复杂关键帧、曲线变速、自动字幕、AI 配音、数字人、自动剪辑、高级调色、插件、复杂混音和在编辑页调用生成模型。不得恢复视频批量创作。

架构已明确以下准入项：

1. EditDraft Schema、版本迁移、微秒整数时间和严格判别联合；
2. 编辑命令、撤销/重做、revision 与原子自动保存；
3. 领域模块和 renderer/IPC/application/domain/infrastructure 依赖边界；
4. 外部引用、项目复制、作品引用、源文件指纹和重定位确认；
5. 预览代理、缩略图、波形缓存与正式导出双路径；
6. MediaEngineAdapter 结构化端口，禁止任意 shell 拼接；
7. ExportPlan 冻结、详细本地导出状态机、取消、恢复和重试；
8. 临时输出、fsync、可信探测、Hash、不覆盖发布和作品版本登记；
9. 硬件失败保留原尝试并创建 software_only 新 attempt；
10. Windows/macOS 文件、权限、字体、进程、休眠和硬件差异；
11. 许可与分发准入以及领域、平台、媒体、IPC、UI、故障注入和实机测试计划。

双人实现顺序已拆分为 B1 EditDraft/命令/仓储、A1 页面壳、B2 源文件/重定位/预览缓存、A2 时间线、A3 文字/声音/封面、媒体引擎许可审批、B3 引擎适配、B4 导出/恢复/Work 登记、A4 导出任务 UI，最后在最新 develop 联调收口。

规划已由项目负责人批准并完成实施。阶段收口后的发布阻断：

- 当前 FFmpeg 工具链只批准本地开发/测试，生产版本、来源、编解码器白名单、签名与分发方式仍待审批；
- macOS 实机完整证据按阶段 9 计划执行，但阶段 7 接口不得写死 Windows 假设。

B1 已完成独立 EditDraft、严格命令联合、撤销/重做、有界历史、revision、项目范围仓储、原子自动保存、保存失败内存恢复和安全 IPC。renderer DTO 不返回路径、原始 Hash、命令历史或媒体引擎内部事实。

B1 工程记录：

    docs/active/阶段7-B1-编辑草稿与命令契约记录.md

B2 已完成外部引用、项目托管副本和作品引用三类源视频登记；项目副本使用临时文件、内容探测、流式 SHA-256、`fsync`、二次校验和同卷原子发布。新增文件身份与丢失/变化状态、两阶段重定位、显式不匹配确认、可撤销 `set_clip_source` 命令和短期受控原片预览。renderer 不接收路径、原始 Hash、修改时间指纹、缓存位置或内部命令。

B2 同时建立版本化 PreviewPlan、代理/缩略图/波形产物端口和按源身份、参数、产物类型、适配器 ID/版本生成的缓存键。缓存位于项目缓存目录，可删除、可重建、不进入作品库。媒体引擎尚未审批，因此默认适配器真实返回 `adapter_unavailable`，没有生成或伪造代理、缩略图和波形。

B2 完整门禁为 88 项 UI/IPC/安全契约测试、172 项领域与平台测试，共 260 项且 0 失败；TypeScript、ESLint、生产构建和差异检查通过。工程记录见：

    docs/active/阶段7-B2-源文件重定位与预览缓存记录.md

阶段 7 B2 已通过 `543406b Merge phase 7 B2 editor preview media` 合并 develop，功能分支本地与远程均保留。A1 已通过项目负责人验收并进入 develop 集成；下一步 A 从同时包含 B2 与 A1 的最新 develop 启动 A2 视频主轨与属性编辑。B3 继续等待媒体引擎许可与分发书面批准，不得提前安装或绑定。

A1 已完成基础编辑页面壳：接入 B1 的创建、打开、复制、标题自动保存、撤销和重做，覆盖未打开项目、空草稿、读取、保存、保存失败、revision 冲突和来源不可用状态；素材、预览、时间线和导出等后续能力保持明确禁用。工程记录：

    docs/active/阶段7-A1-基础编辑页面壳记录.md

A1 独立分支门禁为 91 项 UI/IPC/安全契约测试与 163 项领域/平台测试，共 254 项且 0 失败；TypeScript、ESLint、生产构建和差异检查通过。浏览器在 1920×1080、1280×720 和 1080×720 下无横向溢出，控制台无警告或错误。项目负责人已完成 Windows Electron 手工验收并确认通过。

A2 已接入 B2 的受控视频选择、项目作品、源状态、两阶段重定位、原片预览和预览缓存操作；主轨的裁剪、播放头分割、删除/恢复、复制、移动、变速、画面变换和画布设置只发送现有领域命令。时间线按顺序、裁剪、速度和转场实时计算，不持久化第二份起点。工程记录：

    docs/active/阶段7-A2-视频主轨与属性编辑记录.md

A2 分支门禁为 96 项 UI/IPC/安全契约测试与 173 项领域/平台测试，共 269 项且 0 失败；TypeScript、ESLint、生产构建和差异检查通过。浏览器在 1920×1080、1280×720 和 1080×720 下无横向溢出，控制台无警告或错误。项目负责人已完成 Windows Electron 手工验收并确认通过。

A3 已完成多个基础文字层、系统字体可用性检查、逐片段原声设置、单条背景音乐、视频选帧、本机图片与项目图片封面。背景音乐与本机封面只通过主进程受控选择和内容校验建立；封面默认不改变视频内容，拼接到开头必须显式选择。未获批媒体引擎前背景音乐仅接受可由本机安全解析的 PCM/浮点 WAV，不伪造 MP3/M4A 能力。工程记录：

    docs/active/阶段7-A3-文字声音与封面记录.md

A3 分支门禁为 100 项 UI/IPC/安全契约测试与 174 项领域/平台测试，共 274 项且 0 失败；TypeScript、ESLint、生产构建和差异检查通过。浏览器在 1920×1080、1280×900 和 1080×800 下无横向溢出，三个 A3 属性面板交互正常且控制台无警告或错误；生产构建 Electron 启动烟测进程保持响应。项目负责人已确认 Windows Electron 手工验收通过，A3 已合并到 `develop`。真实视频生成、媒体引擎适配和正式导出仍按已批准边界作为后续工作。

项目负责人随后批准仅限开发/测试的项目本地媒体工具链。`config/media-engine-development.json` 固定 Windows x64 FFmpeg 8.1.2 LGPL 包来源、SHA-256、目录、版本、构建参数和编码器要求；`setup:media-engine` 在哈希和归档路径校验后解压到被 Git 忽略的 `.tools/`，验证通过才替换安装；`verify:media-engine` 可独立复核；`npm run dev` 通过后自动注入 `ffmpeg`/`ffprobe` 绝对路径。真实安装、重复替换与验证通过；新增 8 项工具链安全测试后，全量门禁为 108 项 UI/IPC/工具链契约测试与 177 项领域/平台测试，共 285 项且 0 失败，类型检查、lint、生产构建和差异检查通过。二进制、压缩包、生产构建和发布物边界没有改变，macOS 安装清单与正式分发审查仍未完成。

阶段 7 B3 已在 `feature/video-media-engine-adapter` 实现并合并真实 `MediaEngineAdapter`：动态能力、ffprobe 探测、参数数组预览/导出、真实 progress、取消确认和独立输出校验；主进程现有预览 IPC 已优先使用该适配器。B4 的 ExportPlan/Task/Execution/Work 后台闭环也已合并。生产媒体引擎构建签名、在线后台契约和跨平台证据仍阻断最终上线。

## 技术栈

### 已选方案：Electron + React + TypeScript

优点：

- Electron 生态成熟，适合复杂桌面应用；
- React + TypeScript 适合快速搭建 UI 与状态结构；
- 后续可以集成本地文件、任务状态、后台接口、日志诊断和跨平台打包。

风险：

- 包体积较大；
- 主进程和渲染进程边界必须严格控制；
- API Key、Token、用户文件路径和日志都必须脱敏处理。

## 当前双人分工

### 开发者 A｜UI 状态系统与页面准备

- 基于统一领域契约实现状态组件；
- 维护 Design Tokens、主题和页面状态表现；
- 维护 UI 测试、可访问性和对照记录；
- 为阶段 3 全局页面准备可复用组件。

### 开发者 B｜本地领域与平台

- 设计项目、草稿、素材、文件、任务和作品模型；
- 设计本地目录、索引、状态机和恢复边界；
- 维护 Electron 受控 IPC 与平台适配；
- 阶段 4 起在后台契约齐备后封装服务调用。

阶段 2 的具体边界和合并顺序以 `docs/active/阶段2-任务拆分.md` 为准。

## 后续阶段

1. 阶段 1｜桌面壳、导航、主题与组件；
2. 阶段 2｜本地领域基础；
3. 阶段 3｜全局页面；
4. 阶段 4｜模型与服务商；
5. 阶段 5｜图片创作；
6. 阶段 6｜视频创作；
7. 阶段 7｜视频基础编辑；
8. 阶段 8｜本地设置；
9. 阶段 9｜跨平台与完整验收；
10. 阶段 10｜打包与发布准备。

## 最近增量（2026-07-22）

- 实际修改：`ProjectsPage` 接入 `getProjectSession`、`openProject`、`closeProject`，增加读取中、未打开、已打开和操作反馈状态；同步更新阶段 2 Session 记录。
- 验证结果：14 项 UI/契约测试、47 项领域与平台测试，以及 `npm.cmd run typecheck`、`npm.cmd run lint`、`npm.cmd run build`、`git diff --check` 全部通过；Windows Electron 生产窗口启动并保持响应。
- 未完成项：新建项目流程、重新下载、备份来源/生命周期策略、恢复 UI、macOS 实机验证。Windows Electron 可见窗口已完成项目 Session 联调；备份恢复已接入仅接受 `fileId` 的受控 IPC，路径仍由主进程原生选择器持有。
- 负责人决策：阶段 2 已正式收口，阶段 3 双人任务拆分已形成。下一步由开发者 B 从最新 `develop` 创建 `feature/project-catalog-create`。

## 阶段 7 B4 增量（2026-07-27）

实际修改：

- 新增不可变 `VideoExportPlan`、计划完整性 Hash 和项目范围仓储；
- 新增本地视频导出 Task/Execution 编排、状态投影、取消、重试和启动恢复；
- 接入真实 FFmpeg/ffprobe 多片段合成、进度、取消、临时文件同步、独立输出校验、SHA-256 和不覆盖发布；
- 仅在源、输出和 Work 事实均通过校验后登记 FileReference/Work 并完成 Execution；
- 持久化 `needs_user_action` 的来源/目标处理原因，修正 `conflictPolicy` 与文件扩展名语义；
- 新增 B4 领域、控制器、故障和真实 FFmpeg 集成测试，并扩展 UI/IPC 契约测试。

验证结果：

- 109 项 Node UI/IPC/工具链契约测试通过；
- 194 项 Vitest 领域与平台测试通过；
- 共 303 项，0 失败；
- `npm.cmd run typecheck`、`npm.cmd run lint`、`npm.cmd run build` 和 `git diff --check` 通过；
- Windows Electron 生产构建启动冒烟保持响应 8 秒，通过且无残留项目进程。

未完成项或阻断项（B4 合并时状态）：

- A4 导出/任务中心 UI 当时尚未接入，现已完成并合并；
- 当前批准 FFmpeg 工具链没有已验证硬件编码器，硬件失败回退测试保留到能力获批后；
- `.tools/` 仅限本地开发/测试，生产媒体引擎分发、签名、编解码器白名单、专利/商业审查和 macOS 实机验证未完成。

后续结果：A4 已通过 Windows Electron 真实业务闭环验收，并通过 `f50b598 Merge phase 7 A4 video editor export UI` 合并 `develop`。

## 阶段 7 A4 增量（2026-07-27）

A4 已接入 B4 的真实预检、创建、查询、取消与重试端口；导出确认动态展示来源、目标、格式、质量、软件编码事实和空间校验时机。未保存的文件名或冲突策略会阻止预检与开始导出，避免使用旧设置冻结计划。

后台任务展示真实阶段、进度、取消中、失败、需要用户处理、执行中断和恢复状态；重试明确创建新 attempt 并保留旧记录。只有 B4 返回 `completed` 且存在已登记 `workId` 时，页面才创建受控预览并开放文件定位与作品库入口。

A4 合并后的统一门禁为 113 项 Node UI/IPC/工具链契约测试与 194 项 Vitest 领域/平台测试，共 307 项通过、0 失败、0 跳过；TypeScript、ESLint、生产构建和差异检查通过。浏览器在 1920×1080、1280×900 和 1080×800 下无横向溢出，预检、确认与恢复重试交互正常且控制台无警告或错误；生产构建 Electron 启动烟测保持响应并完成清理。

本机获批 `.tools` 已恢复并通过固定版本、构建参数和编码器验证。项目负责人在生产 Electron 中完成 3 秒 MP4 的受控导入、原片预览、未保存设置阻断、真实预检、FFmpeg 8.1.2 软件导出、进度、独立输出探测、SHA-256、Work 登记、任务中心、作品库和重进页面恢复验收。工程记录：

    docs/active/阶段7-A4-导出任务与恢复界面记录.md

## 阶段 7｜收口结论（2026-07-27）

阶段 7 已在 `develop@f50b598` 完成 A/B 最新实现联调。真实 Windows Electron 闭环生成 VP9 + Opus WebM，输出探测为 640×360、3.006 秒，文件 SHA-256 与 FileReference 登记值一致；只有 `completed + workId` 后页面才显示导出成功和作品入口。测试项目、媒体和隔离用户目录在验收后已清理，仓库只保留不含本机路径的界面证据。

统一门禁为 113 项 Node UI/IPC/工具链测试与 194 项 Vitest 领域/平台测试，共 307 项通过、0 失败、0 跳过；TypeScript、ESLint、生产构建和 `git diff --check` 通过。阶段 7 可以正式关闭，收口记录：

    docs/active/阶段7-联调验收记录.md

该结论只覆盖当前批准的本地开发/测试软件编码闭环，不批准 `.tools` 或 FFmpeg 二进制进入生产构建或发布物。真实硬件编码失败回退证据、macOS 实机、生产媒体引擎签名、编解码器白名单及专利/商业分发审查继续作为阶段 9/10 准入项。下一步先规划阶段 8｜本地设置，不直接在 `develop` 开发。

## 阶段 8｜规划状态（2026-07-27）

阶段 8 技术架构与任务拆分已在 `feature/phase8-planning` 形成，覆盖冻结的常规、存储与文件、任务与性能、本地媒体处理、隐私与权限、网络与代理、通知、快捷键、日志与诊断、应用更新 10 个分类。

架构采用应用级版本化设置、原子持久化、revision 并发控制、能力/状态与用户选择分离，以及高风险操作的 plan/confirm/execute 两阶段协议。普通偏好自动保存；目录迁移、代理、并发、硬件、清理、重置和清除数据必须明确确认。代理凭证独立保存在本机安全存储；目录迁移失败保留原目录；活动任务不被设置变更静默重写；诊断包只在本地生成并默认脱敏；不存在真实更新适配器时只返回不可用。

A/B 计划拆为 B1-B4 与 A1-A4 小分支，先由 B1 建立设置 Schema、仓储、迁移和受控 IPC，再由 A1 接入固定分类与常规设置；后续存储/性能/媒体、隐私/代理/通知/快捷键、诊断/更新分别按对应 B 端口和 A 面板推进。

规划门禁：10 张冻结稿 SHA-256 全部与权威清单一致；113 项 Node 测试与 194 项 Vitest 测试共 307 项通过、0 失败、0 跳过；TypeScript、ESLint、生产构建和差异检查通过。

批准结果：项目负责人于 2026-07-27 通过“继续下一步”批准规划，允许合并 `feature/phase8-planning` 并从最新 `develop` 启动 B1。A1 仍等待 B1 合并；生产更新源与签名安装链路、生产媒体组件分发、硬件能力和 macOS 实机证据仍未具备，不得把这些能力伪装为可用。

## 阶段 8 B1｜设置契约与仓储（2026-07-27）

`feature/local-settings-contracts` 已完成覆盖 10 分类的 `SettingsDocumentV1`、严格运行时校验、版本化默认值、revision 乐观并发、便携设置边界和高风险差异检测。

应用级设置仓储位于 Electron `userData`，不进入项目目录；写入使用串行队列、同目录临时文件、文件同步、原子替换和已验证备份。正式文件损坏时只读取有效备份，双损坏时失败关闭；Schema 迁移必须逐版本显式注册。

受控 IPC 提供快照、普通更新、便携导出、导入预检、高风险计划和确认执行。目录、并发、代理、硬件、清理和快捷键不能通过普通更新绕过确认；一次性确认句柄会过期，并在 revision 变化后失效。renderer 不接收路径、日志原文、凭证、代理密码或更新地址。B2-B4 平台能力当前统一返回真实不可用。

验证结果：117 项 Node 契约测试与 210 项 Vitest 测试共 327 项通过、0 失败、0 跳过；TypeScript、ESLint、生产构建和差异检查通过；Windows Electron 生产构建隐藏启动烟测新增 4 个进程且全部响应，结束后已清理。

下一步：B1 已合并，A1 与 B2 分别按批准拆分推进。工程记录见 `docs/active/阶段8-B1-设置契约与仓储记录.md`。

## 阶段 8 A1｜设置页壳与常规设置（2026-07-27）

`feature/local-settings-shell` 已按冻结顺序建立常规、存储与文件、任务与性能、本地媒体处理、隐私与权限、网络与代理、通知、快捷键、日志与诊断、应用更新 10 个分类。A1 只接 B1 快照、普通更新和恢复默认计划，不建立 renderer 设置仓储；后续分类只展示对应 B2-B4 能力的真实不可用状态。

常规面板覆盖启动意图、主题、界面缩放与密度、动画、侧栏、工具提示、语言与格式和关闭意图。普通修改使用 B1 revision 自动保存；保存失败保留页面值，revision 冲突要求重新载入。恢复常规默认先展示 B1 返回的变化数量、可回退性、待重启项和过期时间，再使用一次性确认句柄执行。平台探测尚未接入时，开机启动和关闭行为保持禁用。

A1 分支门禁为 121 项 Node UI/IPC/工具链契约测试与 205 项 Vitest 领域/平台测试，共 326 项通过、0 失败；5 项真实 FFmpeg 测试因隔离工作树没有本地 `.tools` 跳过。TypeScript、ESLint、生产构建和差异检查通过。浏览器在 1920×1080、1280×900、1080×800 下无横向溢出，自动保存、主题应用、分类搜索、未接能力和恢复确认通过，控制台无警告或错误；Electron 生产构建启动烟测 4 个进程均响应并完成清理。工程记录：

    docs/active/阶段8-A1-设置页壳与常规设置记录.md

## 阶段 8 B2｜存储、任务策略与本地媒体能力（2026-07-27）

`feature/local-settings-storage-performance-media` 已从合并 B1 的 `develop@1eb3dd8` 建立。目录授权独立保存在应用 `userData` 的原子注册表中，renderer 只接收不透明 ID、用途、显示名、读写/可用空间状态；绝对路径、迁移文件清单和 SHA-256 保持在主进程。

目录迁移先完成受控源/目标、禁止磁盘根目录与主目录扫描、权限、冲突、空间和流式 SHA-256 清单预检，再复制到目标同卷临时目录、逐文件校验并发布，最后才更新设置 revision。失败、断盘、复制中断、校验失败或设置并发冲突时原目录和原设置继续有效，旧位置不会在首次迁移中删除。

清理只覆盖应用缓存、预览代理、`tmp/editor` 临时导出和超过保留期的日志；正式结果、Works、源媒体和 `tmp/editor-sources` 不进入删除集合，缓存目录与受保护目录重叠时整组跳过。性能端口按当前 CPU/内存动态给出推荐与上限，并为新任务/attempt 生成冻结策略快照，不取消或改写活动任务。媒体状态调用真实 FFmpeg 能力探测；未配置或探测失败保持不可用/失败，硬件加速继续因未获批准而不可用，且软件导出不会被硬件失败阻断。

受控 IPC 新增系统状态和原生目录选择，目录迁移、清理、性能/并发、高性能和硬件偏好复用 B1 的一次性 plan/confirm/execute 句柄、过期与 revision 复检。B2 独立门禁为 117 项 Node UI/IPC/工具链测试与 229 项 Vitest 领域/平台测试，共 346 项通过、0 失败、0 跳过；同步 A1 后的集成门禁为 121 项 Node 与 229 项 Vitest，共 350 项通过、0 失败、0 跳过。TypeScript、ESLint、生产构建和差异检查通过。Windows Electron 生产构建隐藏启动新增 4 个进程，全部保持响应，结束后无本次残留进程。

B2 合并时 A2 尚未接入；当前 A2 已完成并合并。B3/B4 的隐私、代理、通知、快捷键、诊断和更新不在 B2 范围；硬件编码、生产 FFmpeg 分发、签名、编解码器白名单、专利/商业审查和 macOS 实机证据继续等待阶段 9/10。工程记录见 `docs/active/阶段8-B2-存储性能与媒体能力记录.md`。

## 阶段 8 B3｜隐私、代理、通知与快捷键平台端口（2026-07-27）

`feature/local-settings-platform-controls` 已从 `develop@eb160c9` 完成权限状态与系统设置白名单、最小授权固定策略、系统默认/系统代理/自定义 HTTP/HTTPS/SOCKS5/直连模式，以及只发送固定空 GET 的隔离代理探测。代理失败区分 DNS、证书、认证、超时和未知；切换只影响新请求，活动请求不盲目重试。

代理写入值通过主进程一次性短期句柄进入独立 `userData/settings/proxy-credentials.json`，由 Electron `safeStorage` 加密；设置 JSON、便携设置、renderer DTO、操作计划和日志不含明文、加密引用或绝对路径。代理运行态、凭证和设置写入形成可回滚事务，探测、平台应用或落盘失败均保留旧配置。

通知端口分别返回应用内、系统和声音结果，系统拒绝时应用内渠道仍保留，结果不依赖或修改 Task/Execution。快捷键使用版本 1 动作注册表、Windows/macOS 独立有效值、非法/重复/系统保留键检测和原生注册回滚；只在 Electron ready 后注册并在退出时释放。隐私、代理、快捷键及恢复默认均复用两阶段高风险协议。

独立验证结果：121 项 Node UI/IPC/工具链测试与 244 项 Vitest 领域/平台测试，共 365 项通过、0 失败、0 跳过；Windows Electron 生产构建隐藏启动 4 个进程全部响应，清理后残留 0。同步 A2 后集成门禁为 125 项 Node 与 244 项 Vitest，共 369 项通过、0 失败、0 跳过；TypeScript、ESLint、生产构建和差异检查通过。工程记录见 `docs/active/阶段8-B3-隐私代理通知与快捷键记录.md`。

未完成项：A3 四个用户控制面板尚未接入；B4 诊断/导入执行/重置/更新仍未实现；macOS 实机完整证据留到阶段 9。B3 已同步 A2 最新基线并合并 `develop`，A3 现在可从最新 `develop` 启动。

## 阶段 8 A2｜存储、任务性能与本地媒体面板（2026-07-27）

`feature/local-settings-system-panels` 从 `develop@eb160c9` 建立，直接复用 B2 的 `getSystemStatus/selectDirectory/planOperation/executeOperation`，没有增加 renderer 路径能力、第二套设置仓储或新依赖。

“存储与文件”展示 7 类受控目录的显示名、可用性与空间，以及应用管理范围内的真实容量和文件数；目录迁移、清理均先展示文件数、容量、阻断、可回退性、旧位置保留和重启要求。“任务与性能”展示实时 CPU、内存、负载、活动任务、动态推荐与上限；模式、并发、后台、电源和恢复策略只在确认后作用于后续任务/attempt。“本地媒体处理”展示真实引擎、组件范围、软件能力和硬件状态；未获批硬件不可执行，自动软件回退与原文件导出边界不可关闭，`.tools` 明确只限开发/测试。

本地门禁为 125 项 Node UI/IPC/工具链测试与 224 项 Vitest 领域/平台测试，共 349 项通过、0 失败；另有 5 项真实 FFmpeg 集成测试因主工作目录没有已批准 `.tools` 而跳过。尝试按固定清单安装时，下载包 SHA-256 与已批准值不一致，安装脚本按设计失败关闭且未保留二进制；A2 未修改清单、Hash 或 B2 平台代码。TypeScript、ESLint、生产构建和差异检查通过。浏览器完成目录迁移、清理、性能和媒体策略的真实两阶段交互，1920×1080、1280×900、1080×800（应用最小宽度）无横向溢出，控制台 0 警告、0 错误。生产 Electron 新增 4 个项目进程且主进程保持响应，错误日志为空，测试进程已全部清理。

项目负责人已完成 Windows Electron 手工验收并确认通过；A2 已合并 `develop`，功能分支本地与远程保留。工程记录：

    docs/active/阶段8-A2-存储性能与媒体面板记录.md

## 阶段 8 B4｜诊断、设置导入执行、重置与更新边界（2026-07-27）

`feature/local-settings-diagnostics-update` 从已合并 B3 的 `develop@916b4eb` 建立，复用 B1 的便携设置差异计划与确认句柄、B2 的受控清理边界以及 B3 的代理/快捷键事务，没有引入第二套设置仓储或 renderer 文件权限。

诊断端口实现分类开关、级别过滤、按 `maxFileBytes` 滚动、保留期自动清理和分级清理。预览只返回脱敏文件名/大小、排除清单和固定脱敏事实；生成在用户原生选择的本地目录写出 JSON+gzip 包，写入使用临时文件、失败清理，绝不自动上传。凭证、Token、Cookie、请求头、代理秘密、绝对路径、用户媒体和完整提示词在写入前脱敏或排除；打开日志/最后包只经主进程受控端口。

设置导入继续使用严格 `PortableSettingsV1` 兼容校验、差异计划和一次性确认执行。分类默认、全部默认保持可回退设置事务；新增清除本机应用数据计划只允许 `userData` 白名单范围（设置备份、目录授权、服务商注册、本地凭证、项目目录索引、日志、缓存），计划明确文件数、容量、不可恢复性以及项目/作品/任务/源媒体和外部文件排除，执行不会扫描或删除项目目录。

更新端口按应用、媒体组件、内置适配器、服务商预设和帮助资源建模，返回当前版本、渠道、检查、完整性、签名和活动任务/未保存草稿阻断事实。当前没有获批生产更新源时稳定返回 `unavailable`；检查异常或完整性/签名失败返回 `failed`，无可用版本、安装、修复或回退命令，不显示“已是最新”。

验证结果：125 项 Node UI/IPC/工具链测试与 253 项 Vitest 领域/平台测试，共 378 项通过、0 失败、0 跳过；`npm.cmd run typecheck`、`npm.cmd run lint`、`npm.cmd run build` 和 `git diff --check` 通过；Windows Electron 生产构建隐藏启动 4 个进程全部响应，清理后残留 0。B4 已合并 `develop`，A4 随后完成并合并；生产更新源、签名安装/回退、macOS 实机证据继续不属于本分支。

## 阶段 8｜最终联调与正式收口（2026-07-27）

阶段 8 的 B1、A1、B2、A2、B3、A3、B4、A4 已全部合并到 `develop@db9e94d`。最终统一门禁为 Node/UI 134 项与 Vitest 253 项，共 387 项通过、0 失败、0 跳过；TypeScript、ESLint、生产构建、差异检查和 Windows Electron 4/4 进程响应烟测通过，结束后本次残留进程为 0。

本地设置 10 个分类已完成统一联调；`1920x1080`、`1280x900`、`1080x800` 三个视口无横向溢出或文字裁切，焦点轮廓可见，浏览器控制台 0 警告、0 错误。生产预览未连接 Electron 设置端口时诚实显示不可用，没有假控件或假成功状态。

阶段 8 正式收口，详细证据见：

    docs/active/阶段8-联调验收记录.md

本结论不批准生产更新、签名安装/修复/回退、生产媒体组件分发、硬件矩阵、macOS 实机或正式安装包发布。下一阶段不自动启动，必须先完成技术架构、任务拆分和验收边界审批。

## 阶段 9｜跨平台与完整验收规划（2026-07-27）

阶段 9 技术架构与任务拆分已在 `feature/phase9-planning` 形成：

    docs/active/阶段9-技术架构.md
    docs/active/阶段9-任务拆分.md

规划采用“同一业务事实、平台适配隔离、真实设备执行、证据驱动收口”。Windows 与 macOS 共用领域实体、状态机、IPC 语义、页面 IA、错误语义和成功条件；文件、权限、安全存储、窗口、输入、通知、快捷键、代理、进程、休眠、媒体和字体差异由平台适配层承担。

任务拆为 B1-B4 与 A1-A4：B 依次负责目标矩阵/契约/证据工具、文件权限与安全存储、进程媒体与系统生命周期、故障恢复与安全收口；A 依次负责桌面壳/视觉/可访问性、项目与创作工作区、视频编辑与本地设置、完整实机验收与阶段收口。

阶段完成必须满足项目负责人批准的目标操作系统/架构矩阵，每个必需单元在对应真实系统执行，自动化 0 失败、0 未解释跳过，权威资源 Hash/字节全部匹配，并完成可见 Electron、文件/权限/安全存储/通知/快捷键/代理/休眠/媒体/恢复和全产品页面矩阵证据。`blocked`、`not_run` 不能计入通过。

阶段 9 不新增业务一级页面，也不生成安装包或发布制品。Windows/macOS 代码签名、公证、生产更新、生产媒体组件分发、编解码器与专利/商业审查、SBOM、发布密钥和正式发布准入继续属于阶段 10。`.tools/` 与 FFmpeg 仍只限本地开发/测试；macOS 工具链必须先单独批准固定版本、来源、架构、SHA-256 和许可。

批准结果：项目负责人于 2026-07-28 通过“合并，合并后没有问题便开始 B1”批准规划、目标矩阵原则与验收边界。具体目标版本、架构与设备元数据由 B1 按真实环境冻结；macOS 实机执行资源尚待落实，macOS 本地开发/测试媒体工具链尚未批准。下一步合并规划分支并启动 B1；A1 等待 B1 合并。

## 阶段 9 B1｜平台矩阵、契约审计与证据工具（2026-07-28）

阶段 9 规划已通过 `398aa3d Merge phase 9 planning` 合并 `develop`。`feature/cross-platform-contracts` 从该基线建立，冻结 Windows x64 与 macOS 观测架构真实设备目标、九类必需验收套件、严格状态联合、运行时事实端口和证据 manifest；`blocked`、`not_run` 与缺失套件均不能计入完成。

新增平台假设审计、权威交接包校验和证据采集命令。当前审计扫描 177 个生产侧 TypeScript/TSX/MJS 文件，登记 17 处直接运行时平台访问和 46 处平台字面量，0 项违规；权威交接包 50 条 SHA-256 与 27 个资源 Hash/字节全部匹配。B1 完整门禁为 140 项 Node UI/IPC/工具链测试与 257 项 Vitest 领域/平台测试，共 397 项通过、0 失败、0 跳过；TypeScript、ESLint、生产构建和差异检查通过，真实 FFmpeg 测试已执行。

Windows x64 工程完整性证据已按实现提交 `674b603` 采集，记录运行时为 Windows `10.0.19045`、x64、Node `26.5.0`；只将 `engineering_integrity` 标记为 `passed`，Electron 生命周期、文件与权限、安全存储、系统集成、电源恢复、媒体软件、全产品 UI 和安全审计仍为 `not_run`。macOS 实机套件尚未执行，macOS 本地开发/测试媒体工具链仍待单独批准。工程记录见：

    docs/active/阶段9-B1-平台矩阵与证据工具记录.md

B1 已通过 `bb862a3 Merge phase 9 cross-platform contracts` 合并并推送 `develop`，本地与远程功能分支保留。A1 已具备启动条件，B2 已从该最新基线启动；不得将 B1 工程基线解释为阶段 9 完成。

## 阶段 9 B2｜文件、权限、安全存储与仓储跨平台化（2026-07-28）

`feature/cross-platform-storage-security` 从 `develop@bb862a3` 建立。实现提交 `5db899f` 新增统一可移植路径策略，支持 Unicode NFC、空格与深层长路径，同时拒绝目录逃逸、控制字符、Windows 保留名、尾随点/空格及项目根内符号链接/目录联接绕过。项目 JSON 仓储、Hash 校验、状态探测、备份恢复、受控图片/视频媒体和编辑/导出读取均在实际访问前执行安全解析。

目录注册表升级到 Schema v2，旧版自动迁移并保留最后一个有效备份；目录只保存主进程绝对路径和授权记录，renderer 继续只接收不透明 ID。Electron 组合根支持 macOS 安全作用域书签激活、撤销状态和重新授权更新；Windows/普通非沙盒选择器保持受控路径访问。清除本机目录授权时同时删除主文件和备份。

安全凭证写入前必须完成保护/解保护闭环；替换失败保留旧凭证，主文件损坏时只读取有效备份且不覆盖损坏证据，新实例可恢复旧值。Windows Electron `safeStorage` 在 Windows `10.0.19045` x64、Electron `33.4.11`/Node `20.18.3` 上真实通过，密文字节不包含明文。日志与诊断新增 SHA-256、设备标识、Windows/macOS/Linux 用户路径和 `file://` 脱敏；清除本机凭证会同步删除主密文与备份。

B2 当前门禁为 140 项 Node UI/IPC/工具链测试与 267 项 Vitest 领域/平台测试，共 407 项通过、0 失败、0 跳过；TypeScript、ESLint、生产构建、平台审计、交接包完整性和差异检查通过，真实 FFmpeg 测试已执行。平台审计扫描 180 个生产侧文件，登记 18 处直接运行时平台访问和 47 处平台字面量，0 项违规。工程记录见：

    docs/active/阶段9-B2-文件权限与安全存储记录.md

未完成：Windows 原生目录选择器人工授权/撤销尚未执行；macOS 文件系统、目录书签、撤销/重授权、外接卷和 `safeStorage` 实机证据尚未执行。项目负责人于 2026-07-28 明确批准“先合并 B2”，因此 B2 已通过 `f47be6b Merge phase 9 cross-platform storage security` 合并并推送 `develop`，本地与远程功能分支保留。该决策只改变集成顺序，不把 `not_run` 改为通过，也不代表 B2 跨平台验收完成；本次未自动启动 B3，B3 仍须负责人单独确认并满足媒体工具链批准边界。

## 阶段 9 B3｜进程、媒体、网络与系统生命周期（2026-07-28）

项目负责人通过“b3启动”明确批准启动 B3。`feature/cross-platform-runtime-media` 从 `develop@a76890d` 建立，实现提交 `7aac020` 新增统一受控进程监督器，媒体命令固定结构化参数与 `shell: false`，能力探测、ffprobe、预览、缩略图、波形和软件导出均具有超时、有界输出、进程树终止和退出清理。Windows 使用 `taskkill /T /F`，macOS/POSIX 使用独立进程组、`SIGTERM` 与 `SIGKILL` 回退。开发者 A 在 B3 实施期间完成 A1，B3 已通过 `596e2ab` 同步 `origin/develop@b7169b6` 并保留双方窗口与生命周期实现。

视频导出追踪真实活动 Execution；休眠、锁屏、禁止后台处理和应用退出会中断活动导出并落到 `recovery_required`，用户取消仍保持 `cancelled`，不创建假 Work 或重复完成。Electron 退出先停止媒体与导出，再释放快捷键、目录授权、代理运行时、短期媒体句柄和休眠阻止器。renderer 外链只允许无凭证 HTTPS URL。

B3 同步 A1 后的当前门禁为 147 项 Node UI/IPC/工具链测试与 279 项 Vitest 领域/平台测试，共 426 项通过、0 失败、0 跳过；TypeScript、ESLint、生产构建、平台审计、交接包完整性和差异检查通过。平台审计扫描 184 个生产侧文件，登记 23 处直接运行时平台访问和 49 处平台字面量，0 违规。Windows `safeStorage`、快捷键、direct/system 代理解析、电源状态、FFmpeg `8.1.2` 开发工具链、真实媒体闭环和 4/4 Electron 进程响应/优雅退出残留 0 通过。工程记录见：

    docs/active/阶段9-B3-进程媒体与系统生命周期记录.md

未完成：Windows 真实睡眠/唤醒、锁屏/解锁、可见通知、通知声音和系统设置跳转未执行；B2 原生目录选择器人工项仍未执行；macOS 全部 B3 实机证据与媒体工具链批准仍缺失。项目负责人于 2026-07-28 明确批准“合并”，B3 已通过 `8b32ba7 Merge phase 9 cross-platform runtime media` 合并并推送 `develop`，本地与远程功能分支继续保留。该合并不把任何 `not_run` 改为通过，不代表 B3 或阶段 9 跨平台验收完成，也不自动启动 B4。

## 阶段 9 C1 第一批｜对话领域与本地仓储（2026-07-28）

项目负责人正式批准 C1 作为阶段 9 业务范围例外，并要求在真实供应商适配器、B4 和 A4 前完成。`feature/chat-domain-contracts` 从已合并 B3 的最新 `develop@134d406` 建立，工作区创建前保持干净。

本分支新增 Conversation/Message 强类型 ID、应用级全局 Conversation 聚合、可选显式 `projectId`、active/archived/deleted 状态、软删除墓碑、Message 的 pending/streaming/completed/failed/cancelled 严格判别联合及双层 revision。用户消息作为 completed 不可变事实；assistant 消息只能按批准状态机转换，终态不可继续写入。未绑定项目的 Conversation 不能持久化附件；已绑定项目只允许同项目 AssetId/FileReferenceId，不保存绝对路径、Hash、endpoint 或原始附件内容。

应用级 JSON 仓储实现 Schema version、文档 revision、严格运行时校验、显式连续迁移入口、聚合乐观并发、同路径跨实例串行写入、同目录临时文件、文件 `fsync`、原子替换、目录同步和最后有效备份。主文件损坏时只读取有效备份且不覆盖损坏证据；主文件和备份均无效时失败关闭。普通列表默认隐藏 archived/deleted，墓碑仍可显式读取。

新增 14 项领域与仓储测试。完整门禁为 147 项 Node UI/IPC/工具链测试与 293 项 Vitest 领域/平台测试，共 440 项通过、0 失败、0 跳过；TypeScript、ESLint、生产构建通过，真实 FFmpeg 集成测试已执行。本分支未修改 Electron 主进程或 preload，不新增 Electron 烟测要求。工程记录见：

    docs/active/阶段9-C1-对话领域与本地仓储记录.md

未完成：ProjectContext 项目内版本仓储、登记草稿/预览/确认、应用服务、主进程控制器、受控 IPC/preload、附件内容解析和任何 React 接线均不在本分支。下一步先推送并合并本分支，再从最新 `develop` 创建 `feature/project-context-registry`；其后才启动 `feature/chat-context-ipc`。页面接线等待 A2 合并后另建独立小分支。

第一批随后已通过 `b245f86 Merge phase 9 conversation domain contracts` 合并并推送 `develop`；`feature/chat-domain-contracts` 本地与远程分支继续保留。第二批已从该最新基线创建 `feature/project-context-registry`。

## 阶段 9 C1 第二批｜项目上下文登记（2026-07-28）

`feature/project-context-registry` 从包含第一批的 `develop@b245f86` 建立。本分支新增 ProjectContext 草稿、消息选择片段、稳定 contextId、不可变 revision 历史、currentRevision、active/deleted、sourceStatus、显式登记、内容/标签更新、墓碑删除和安全查询 DTO。

草稿必须显式选择目标项目和一个已保存 Conversation；允许同一 Conversation 的多个 completed Message 片段，冻结 Message revision、角色、UTF-16 选择范围、顺序和规范化内容快照。跨 Conversation、未保存 Conversation、未完成 Message 和登记前来源变化均失败关闭。草稿不会进入候选列表；只有显式确认后才在项目仓储中原子移除草稿并创建正式 context revision 1。

正式上下文的内容、标签、sourceStatus 和删除均追加新 revision，不覆盖旧版本。Conversation 后续软删除时上下文继续有效，只追加 `source_deleted`，登记内容快照与历史版本保持可读。普通删除上下文形成纯墓碑，不删除来源 Conversation。当前实现的版本化宽泛来源为 `conversation_selection`，不包含供应商、模型或页面名称；其他批准类别仅预留，不伪造具体来源流程。

项目范围注册表位于 `entities/project-contexts.json`，草稿与正式上下文共享一个 Schema v1 文档。仓储实现严格校验、显式迁移入口、文档与实体 revision、串行写入、项目存储原子替换、有效备份和历史只追加验证。应用层 DTO 不返回路径、Hash、凭证、endpoint 或仓储信息，也不创建 Task、Execution 或 Work。

新增 17 项领域、应用服务和仓储测试。完整门禁为 147 项 Node UI/IPC/工具链测试与 310 项 Vitest 领域/平台测试，共 457 项通过、0 失败、0 跳过；TypeScript、ESLint 和生产构建通过，真实 FFmpeg 集成测试已执行。本分支未修改 Electron 主进程或 preload，不新增 Electron 烟测要求。工程记录见：

    docs/active/阶段9-C1-项目上下文登记记录.md

未完成：第三批主进程控制器、共享 IPC、preload 白名单、Electron 组合根、Conversation 流式应用服务、adapter_unavailable 映射、受控附件接入和所有 React UI 均未实现。第二批必须先合并最新 `develop`，之后才允许创建 `feature/chat-context-ipc`；第三批修改 Electron/preload 后必须执行真实 Electron 启动烟测。

第二批随后已通过 `9df9ce0 Merge phase 9 project context registry` 合并并推送 `develop`；`feature/project-context-registry` 本地与远程分支继续保留。第三批已从该最新基线创建 `feature/chat-context-ipc`。

## 阶段 9 C1 第三批｜对话与项目上下文受控 IPC（2026-07-28）

`feature/chat-context-ipc` 从同时包含第一批和第二批的 `develop@9df9ce0` 建立并已推送保留。本分支新增 Conversation 非 UI 应用服务、供应商无关流式应用服务端口、ConversationController、ProjectContextController、共享 IPC DTO/严格请求校验/稳定错误码、preload 命名白名单和 Electron 组合根。

Conversation 创建可由用户显式选择是否绑定当前受控项目；未打开项目仍可保存未绑定纯文本 Conversation。renderer 只能提交受控 ID、文本、布尔确认和 revision，不能传绝对路径、仓储位置、任意附件位置、远端 operation ID、凭证或 endpoint。用户消息保存不接受附件；没有真实对话适配器时 `requestAssistantResponse` 返回 `adapter_unavailable` 且不创建 assistant Message、不制造片段、进度、费用或成功状态。流式 start/append/complete/fail/cancel 只存在于主进程应用服务边界。

ProjectContext 控制器只从当前主进程 Project Session 派生项目范围，renderer 不传 projectId；未打开项目和其他项目 ID 均失败关闭。保存 Conversation、创建上下文草稿和显式登记保持独立；草稿登记必须确认，查询上下文不构成外发授权。应用级 Conversation 仓储继续位于 Electron userData，项目上下文继续位于目标项目 `entities/project-contexts.json`，不建立第二套事实源或 renderer 仓储。项目切换、关闭和应用退出会等待受控操作结束。

新增 3 项 Node IPC/preload 契约测试和 9 项 Vitest 控制器/组合根测试。完整门禁为 150 项 Node 与 319 项 Vitest，共 469 项通过、0 失败、0 跳过；TypeScript、ESLint、生产构建和差异检查通过，真实 FFmpeg 集成测试已执行。Windows Electron 生产构建启动烟测新增 4 个进程，4/4 响应，清理后本次残留 0。工程记录见：

    docs/active/阶段9-C1-对话与项目上下文受控IPC记录.md

未完成：React 页面与创作工作区接线、`readProjectContext`/`readSavedProjectChats` 的页面候选语义、真实供应商/HTTP 适配器、供应商提交前确认、新原生附件选择、受控附件展示与内容解析均不在本分支。第三批实现等待项目负责人验收；未经批准不得合并 `develop`。

## 阶段 9 C1 UI 接线｜对话与项目上下文（2026-07-28）

`feature/chat-context-ui-wiring` 从包含 A2 与三批 C1 后端的 `develop@c0ca757` 建立并推送保留。对话页接入真实应用级对话列表、创建、显式项目绑定、读取、重命名、归档/恢复、墓碑删除、用户消息保存和 `adapter_unavailable`；没有真实适配器时用户消息仍可本地保存，但不会创建 assistant Message、假进度、费用或结果。附件保持禁用，未通过浏览器文件输入绕过原生受控登记边界。

对话页允许从同一已保存 Conversation 选择多个 completed Message 整段，创建项目上下文草稿、增删片段、查看内容预览、编辑标签并显式确认登记。保存 Conversation 与登记 ProjectContext 保持独立；未打开项目、未完成消息和未选择内容均不能登记。普通删除对话只形成墓碑，页面明确说明已登记上下文不会级联删除。

专业生图与文生视频复用一个上下文选择器。选择器先读取 `readProjectContext`/`readSavedProjectChats`，只在用户点击后查询候选；项目上下文保存受控 contextId，已保存对话新增安全候选 DTO，只返回当前项目显式绑定对话的 ID、标题、状态、消息计数和更新时间，不返回消息正文。选择器只保存 `kind + referenceId`，不读取对话内容、不自动进入提示词、不构成外发授权。项目素材候选和已保存对话的消息级内容选择继续等待独立受控端口，不在本分支伪造。

完整门禁为 157 项 Node UI/IPC/工具链测试与 320 项 Vitest 领域/平台测试，共 477 项通过、0 失败、0 跳过；TypeScript、ESLint、生产构建、平台审计、交接包校验和差异检查通过。平台审计扫描 198 个生产侧文件，登记 23 处运行时平台访问与 49 处平台字面量，0 违规。浏览器 1280×720、1080×800 无横向溢出，控制台 0 警告、0 错误。Windows Electron 生产构建新增 4 个进程，4/4 响应，受控关闭后残留 0。工程记录见：

    docs/active/阶段9-C1-对话与项目上下文UI接线记录.md

未完成：真实 LLM/图片/视频适配器、HTTP、收费调用、原生附件选择、项目素材候选、对话消息级创作引用、供应商提交前外发确认均未实现；不得把保存的对话 candidate ID 解释为读取全部消息或外发授权。macOS 实机按项目负责人最新决策保持 `not_run/deferred`。项目负责人验收后已通过非快进提交 `e278b63` 合并并推送 `develop`；合并后完整门禁与 Windows Electron 4/4 响应、受控关闭残留 0 再次通过，未自动启动 Vidu 或 B4。

## 阶段 9 C2｜Vidu 官方 API 开发态适配规划（2026-07-28）

项目负责人最新决策批准将 Vidu 官方 API 接入拆为八个小 PR 写入工程计划。该决策自本记录起形成阶段 9 的显式业务范围例外，不倒改阶段 4—6 与 C1 在当时“真实适配器缺失或尚未授权”的历史事实，也不修改原阶段 9 A/B 验收任务的完成定义。

正式技术架构与任务拆分见：

    docs/active/阶段9-C2-Vidu官方API接入技术架构.md
    docs/active/阶段9-C2-Vidu官方API接入任务拆分.md

冻结架构为一个 `ViduProviderPackage`、一个共享安全运行时、三个协议适配器与多个模型记录：

```text
ViduProviderPackage
├─ ViduSharedRuntime
├─ ViduImageV1Adapter
├─ ViduGeminiImageV2Adapter
└─ ViduReferenceVideoV2Adapter
```

模型必须通过 `mediaKind + protocolId + protocolVersion + executionLifecycle` 绑定协议；图片/视频强类型 Router 在类型不匹配时返回 `operation_model_mismatch`，HTTP 调用数为 0。`POST /ent/v2/reference2image` 标准异步图片接口属于未批准的第四协议，不得塞入现有三个适配器。

八个流程依次为：

1. `feature/vidu-protocol-contracts`：协议、模型记录、注册表迁移、不可变能力证据与强类型 Router；
2. `feature/vidu-execution-lifecycle`：同步图片、异步视频、结果 receipt、`submission_outcome_unknown`、轮询/取消/恢复契约；
3. `feature/vidu-runtime`：共享凭证、受控 HTTP、代理、超时、端点限制、错误映射与日志脱敏；
4. `feature/vidu-image-adapters`：Image V1 与 Gemini Image V2 两个同步图片适配器；
5. `feature/vidu-video-adapter`：Q3 异步视频提交、轮询、取消、恢复和受控结果暂存桥；
6. `feature/vidu-app-wiring`：唯一 Electron 组合根、图片/视频页面真实状态和图片 Work 显式进入图生视频草稿；
7. `feature/vidu-e2e-validation`：本地合成服务的全协议、故障、安全与完整业务闭环；
8. `feature/vidu-live-validation`：再次获批后执行一次最小图片和一次最小视频的真实开发态验证。

流程 1—7 只能使用本地合成服务，不得访问真实 Vidu。流程 8 必须在前七个流程全部验收并合并后，由项目负责人再次批准联网范围和收费次数；Token 只能由用户在应用凭证界面录入。真实验证成功只能记录为“Vidu 官方 API Windows 开发态最小闭环通过”，不能记录为阶段 9 跨平台完成、阶段 10 完成或发布就绪。

流程 1 实际结果：已新增协议绑定、ProviderModel Schema v2 迁移、不可变 CapabilityEvidence 历史、冻结的 3 个 Vidu 协议绑定与 10 个模型记录，以及图片/视频强类型 Router。类型、Task 业务种类、provider/connection、协议媒体类型或目的不一致时，统一在适配器调用前返回 `operation_model_mismatch`；测试明确确认适配器调用数为 0。冻结记录默认禁用，能力仅为 `declared_supported`，未登记价格、参数、时长、分辨率或已验证支持事实。

验证结果：`npm test` 为 Node 157 项与 Vitest 331 项，合计 488 项通过，0 失败、0 跳过；`npm run typecheck`、`npm run lint`、`npm run build`、`npm run audit:platform`、`npm run verify:handoff` 与 `git diff --check` 全部通过。平台审计扫描 200 个文件且 0 违规，交接包 50 个校验项、27 个资产均无失败。本流程未修改 Electron/preload，未执行 Electron 烟测；未实现 HTTP、未读取 Token、未发起真实或收费请求，也未修改任何生成页面。

流程 1 已提交并推送 `feature/vidu-protocol-contracts`，随后通过 `c03693f Merge phase 9 C2 Vidu protocol contracts` 非快进合并并推送 `develop`；合并后完整门禁再次通过，功能分支本地和远程均保留。

流程 2 实际结果：新增不可变 `ProviderOperationRecord` 与 Schema v1→v2 迁移，统一记录 `accepted_async`、`completed_sync`、`submission_outcome_unknown` 和 `failed_before_submission`。同步图片结果 URL/base64/file URI 先保存到主进程私有项目仓储，再把 Execution 推进到 `remote_completed`；异步提交持久化 provider operation ID，并提供查询、取消和重启恢复端口。收据先于 Execution 更新落盘，重启时可以幂等补齐状态；未知收费提交结果的自动重试次数固定为 0，图片和视频控制器均拒绝在同一 Task 上普通重试。

流程 2 验证结果：`npm test` 为 Node 157 项与 Vitest 339 项，合计 496 项通过，0 失败、0 跳过；`npm run typecheck`、`npm run lint`、`npm run build`、`npm run audit:platform`、`npm run verify:handoff` 与 `git diff --check` 全部通过。平台审计扫描 203 个文件且 0 违规，交接包 50 个校验项、27 个资产均无失败。本流程未修改 Electron 主进程或 preload，不需要 Electron 烟测；没有 HTTP、Token、真实联网或收费请求。

流程 2 已提交并推送 `feature/vidu-execution-lifecycle`，随后通过 `7015624 Merge phase 9 C2 provider execution lifecycle` 非快进合并并推送 `develop`；合并后完整门禁再次通过，功能分支本地和远程均保留。

流程 3 实际结果：新增唯一 `ViduProviderPackage` 与 `ViduSharedRuntime`。共享运行时只能在 `SecureCredentialVault.useValue` 主进程回调内取用 Token，向受控 HTTP transport 发送固定 `Authorization: Token`，日志只记录方法、协议、状态、错误码和耗时。运行时强制 HTTPS、固定 Vidu 基础 origin、协议路径白名单、连接/协议绑定一致性、手工重定向拒绝、20MB 默认请求上限、受限响应上限、超时、外部取消、运行时退出时取消全部在途请求，以及稳定、无敏感信息的错误映射。代理选择以受控 `ProxyMode` 传递给 transport，未在 renderer 创建网络能力。`ViduConnectionValidationPort` 仅通过 `/ent/v2/credits` 合成调用更新可用性事实，不返回账户、费用、Token 或响应正文。

流程 3 验证结果：`npm test` 为 Node 157 项与 Vitest 345 项，合计 502 项通过，0 失败、0 跳过；`npm run typecheck`、`npm run lint`、`npm run build`、`npm run audit:platform`、`npm run verify:handoff` 与 `git diff --check` 全部通过。平台审计扫描 207 个文件且 0 违规，交接包 50 个校验项、27 个资产均无失败。本流程未修改 Electron/preload 或页面，不需要 Electron 启动烟测；测试只使用内存合成 transport，真实 Vidu HTTP 调用为 0。

流程 3 未完成：Electron 组合根的实际 transport 注入、两个同步图片协议适配器、Q3 视频协议适配器、受控结果接收与 Work 流转、可见页面接线和合成服务端到端验证属于后续流程。Image2 鉴权仍保持 unknown；冻结模型仍为 disabled，Evidence 仍为 `declared_supported`。

流程 4 实际结果：在唯一 `ViduProviderPackage` 下新增 `ViduImageV1Adapter` 与 `ViduGeminiImageV2Adapter`，没有按模型拆适配器，也未引入第四种异步图片协议。两个适配器都强制单图、单输出，序列化和 Base64 后的 POST Body 上限为 20MB；Gemini V2 严格使用官方 `Token` 鉴权、`content/part/inlineData` 请求结构并只解析单个 `fileData.fileUri`，不发送受限 `imageSearch`。Image V1 支持 generations/edits 与 URL/`b64_json` 解析，但官方资料中的 `Authorization: xxx` 以及 `images` 表格/示例结构冲突仍未解决，因此冻结生产绑定继续保持 `authScheme=unknown`，未显式注入已验证协议画像时在 HTTP 前阻断。

流程 4 同时新增项目范围的受控图片素材解析器：只按当前受控项目的 AssetId 解析 FileReference，重新检查存在性、媒体类型、尺寸、字节与 SHA-256 后才产生内部 Base64，不向 renderer 返回路径或 Hash。同步结果继续保存在私有 ProviderOperationRecord；URL/file URI 经 HTTPS、非本机地址、手工重定向、响应上限和图片 Content-Type 边界下载，Base64 严格解码。现有结果接收器已兼容 `completed_sync`，并在图片探测、SHA-256、原子发布、FileReference、索引和 Work 登记之间保留幂等恢复点，避免 Work 写入或 Execution 收口之间形成不可恢复断裂。

流程 4 验证结果：`npm test` 为 Node 157 项与 Vitest 359 项，合计 516 项通过，0 失败、0 跳过；`npm run typecheck`、`npm run lint`、`npm run build`、`npm run audit:platform`、`npm run verify:handoff` 与 `git diff --check` 全部通过。平台审计扫描 210 个文件且 0 违规，交接包 50 个校验项、27 个资产均无失败。测试只使用内存合成 transport 和临时项目，不读取真实 Token、不访问真实 Vidu、不产生收费请求。本流程未修改 Electron/preload 或页面，因此无需 Electron 烟测。

流程 4 未完成：Image V1 鉴权格式与 `images` 的最终请求结构必须保持未验证；冻结模型仍 disabled，Evidence 仍为 `declared_supported`。Q3 异步视频适配器、Electron 实际 transport 与组合根、页面接线、完整合成服务和真实收费验证分别属于流程 5—8，不得由本流程提前启动。

流程 4 已提交并推送 `feature/vidu-image-adapters`，随后通过 `d629d9c Merge phase 9 C2 Vidu synchronous image adapters` 非快进合并并推送 `develop`；合并后完整门禁再次通过，功能分支本地和远程均保留。

流程 5 实际结果：在唯一 `ViduProviderPackage` 下新增 `ViduReferenceVideoV2Adapter`，只覆盖冻结的五个 Q3 模型和 `vidu.ent.v2.reference2video` 协议。适配器强制单张受控图片、单个结果、5000 字提示词上限、序列化后 20MB 请求上限，并显式发送 `audio`；未发送 Q3 不支持的 `movement_amplitude` 或 `bgm`。五个模型时长按批准的官方保守交集校验，未在页面写死参数或启用冻结模型。

异步实现严格解析 `task_id`，映射 `created/queueing/processing/success/failed`，提供有界指数退避与抖动轮询、取消和基于持久化 ProviderOperationRecord 的重启重发现。请求可能已送达但超时、断网、5xx 或响应损坏时返回 `submission_outcome_unknown`，不自动重提。查询成功后只保存私有结果 URL；同一 URL 保留首次发现时间并执行 24 小时到期门禁。视频下载继续走 HTTPS、重定向、响应大小和 Content-Type 边界；Vidu 未声明 MIME、容器、字节、Hash、时长或尺寸时不伪造远端事实，而由本地视频探测、SHA-256、原子发布、FileReference、索引和 Work 登记形成可信事实。

流程 5 验证结果：`npm test` 为 Node 157 项与 Vitest 367 项，合计 524 项通过，0 失败、0 跳过；`npm run typecheck`、`npm run lint`、`npm run build`、`npm run audit:platform`、`npm run verify:handoff` 与 `git diff --check` 全部通过。平台审计扫描 211 个文件且 0 违规，交接包 50 个校验项、27 个资产均无失败。所有 HTTP 都是内存合成 transport；真实 Vidu HTTP、真实 Token 和收费请求均为 0。本流程未修改 Electron/preload 或页面，因此无需 Electron 烟测。

流程 5 未完成：实际 Electron transport、组合根、preload/IPC 和现有生成页面接线属于流程 6；本地合成服务的全协议故障矩阵与端到端闭环属于流程 7；真实 Vidu 联网和收费验证属于仍未批准的流程 8。Image V1 未决鉴权和请求结构不因本流程改变，冻结模型仍 disabled，Evidence 仍为 `declared_supported`。

流程 5 已提交并推送 `feature/vidu-video-adapter`，随后通过 `f53b331 Merge phase 9 C2 Vidu Q3 video adapter` 非快进合并并推送 `develop`；合并后完整门禁再次通过，功能分支本地和远程均保留。

流程 6 实际结果：Electron 主进程现在只创建一个共享 Vidu 组合根，Provider 管理、凭证、图片提交、视频提交和结果接收复用同一 `JsonProviderRegistryStore`、`SecureCredentialVault`、`ViduProviderPackage` 与受控 Electron transport。preload 只增加命名方法；图片和视频提交控制器执行精确请求字段校验，renderer 不能传路径、endpoint、远端 operation ID 或下载 URL。

快速生图、专业生图和图片编辑页面复用显式 Task→Execution→提交→结果校验→Work 登记流程；带单图输入时使用 `reference_to_image` 强类型路由，不按模型名分支。图生视频页面接入恢复、带退避抖动的查询、手工刷新、取消与结果登记；图片 Work 只有在主进程重新核对项目归属、FileReference、SHA-256 与图片探测后，才能由用户显式创建图生视频草稿，不自动创建视频 Task 或 Execution。

流程 6 验证结果：`npm test` 为 Node 160 项与 Vitest 371 项，合计 531 项通过，0 失败、0 跳过；`npm run typecheck`、`npm run lint`、`npm run build`、`npm run audit:platform`、`npm run verify:handoff` 与 `git diff --check` 全部通过。平台审计扫描 213 个文件且 0 违规，交接包 50 个校验项、27 个资产均无失败。Windows Electron 生产构建烟测新增 4 个进程且 4 个全部响应，本次退出后残留 0；烟测前已有的 4 个旧 Electron 进程未被终止。浏览器在产品支持的 1080px 最小桌面宽度下无横向溢出、按钮裁切或重叠；390px 窄视口按既有桌面壳 `min-width: 1080px` 产生横向滚动，不作为移动端通过证据。真实 Vidu HTTP、Token 和收费请求均为 0。

流程 6 未完成：冻结 Vidu 模型仍 disabled，CapabilityEvidence 仍为 `declared_supported`；Image V1 鉴权与 `images` 请求结构仍未确认。流程 7 负责本地合成服务全协议与故障矩阵，流程 8 的真实联网和收费仍未批准；本流程不等于阶段 9 A3、B4、A4 或跨平台验收完成。

流程 6 已提交并推送 `feature/vidu-app-wiring`，随后通过 `90a2d58 Merge phase 9 C2 Vidu application wiring` 非快进合并并推送 `develop`；合并后 531 项完整门禁和 Windows Electron 4/4 响应、受控关闭后本次残留 0 再次通过，功能分支本地和远程均保留。

流程 7 实际结果：新增只实现 `ViduHttpTransport` 的本地合成服务与独立 `test:vidu-e2e` 命令，覆盖正确/错误鉴权、三个协议族、URL/base64/file URI、Q3 异步 task、跨媒体 `operation_model_mismatch` 且零 transport、未知提交零自动重试、429/5xx 退避、取消、重启重发现、结果 URL 到期、重定向、超限、截断与敏感字段扫描。完整闭环从显式图片 Task/Execution 开始，经过下载、图片探测、SHA-256、原子发布和图片 Work，用户再显式创建图生视频草稿、重新确认、提交、刷新、下载探测并登记视频 Work；未自动连续执行。

流程 7 验收发现并最小修复三项实现缺陷：图生视频预检按 `reference_to_video` 查找协议与证据；已刷新到 `remote_completed` 的视频执行可继续进入结果接收且不重复状态转换；带 `Content-Length` 的响应必须与实际字节严格一致，拒绝截断。图片结果原子发布增加主进程内部测试注入点，生产默认仍使用同目录 `rename`，合成 `ENOSPC` 时临时文件清理、Execution 保留失败事实且不登记 Work。

流程 7 分支验证结果：`npm test` 为 Node 160 项与 Vitest 377 项，合计 537 项通过，0 失败、0 跳过；`npm run test:vidu-e2e` 4 项通过；`npm run typecheck`、`npm run lint`、`npm run build`、`npm run audit:platform`、`npm run verify:handoff` 与 `git diff --check` 全部通过。平台审计扫描 213 个文件且 0 违规，交接包 50 个校验项、27 个资产均无失败。Windows Electron 生产构建烟测新增 4 个进程、4/4 响应并出现 1 个窗口；程序化关闭未让主进程自行退出，随后仅清理本次仓库进程，清理后本次残留 0；烟测前已有 4 个旧 Electron 进程未被终止。真实 Vidu HTTP、真实 Token 和收费请求均为 0。

流程 7 未完成与风险：合成测试中的 test-only Token、Image V1 `token` 鉴权和输入形状只属于协议夹具，不构成官方验证；冻结生产模型继续 disabled，Evidence 继续 `declared_supported`。Image V1 鉴权与 `images` 结构、真实账户权限、模型可用性、费用和远端结果域名仍待流程 8。流程 8 尚未获准，不得创建分支、读取凭证、联网或收费；A3、B4、A4 和 macOS 实机也未因本流程完成而启动或通过。

流程 7 已提交并推送 `feature/vidu-e2e-validation`，实现与截断响应修复随后分别通过 `e4ba8c4 Merge phase 9 C2 Vidu synthetic end-to-end validation` 和 `bd86cbf Merge Vidu decoded response length fix` 非快进合并 `develop`；`origin/develop` 已同步至 `bd86cbf`，功能分支本地与远程均保留。

流程 8 已获项目负责人明确批准并在 `feature/vidu-live-validation` 启动。分支增加严格持久化的流程 8 验证记录、单次图片/视频预算、`GET /ent/v2/credits` 启动门禁、只启用 `q3-lite` 与 `viduq3-turbo` 的临时用户确认 Evidence、Work 成功后的不可变系统观察 Evidence，以及提交、轮询、本地结果和凭证轮换边界。Provider 页面增加四项显式批准和脱敏状态时间线；真实图片与视频仍复用现有 Task、Execution、结果接收、FileReference、索引与 Work 链路。记录观察失败会保留真实业务结果，同时尽力将验证终止为 `local_state_failed`，不以假成功掩盖本地状态故障。

流程 8 实现门禁当前结果：`npm test` 为 Node 161 项与 Vitest 387 项，合计 548 项通过，0 失败、0 跳过；`npm run typecheck`、`npm run lint`、`npm run build`、`npm run audit:platform`、`npm run verify:handoff` 与 `git diff --check` 全部通过。平台审计扫描 216 个文件且 0 违规，交接包 50 个校验项、27 个资产均无失败。Windows Electron 生产构建烟测新增 4 个进程、4/4 响应、1 个窗口，清理后本次残留 0。1280×720 可见检查覆盖 Provider 流程 8 面板、快速生图与图生视频页面，未见布局重叠或控制台错误。旧版 Schema v2 服务商注册表现会在主窗口创建前幂等补齐缺失的冻结 Vidu 目录；自定义记录、同 ID 记录、墓碑、凭证引用和不可变能力历史保持不变。

流程 8 在 A 的图片视觉分支与用户流程修复依次合并 `develop` 后，通过 `55c0457 Merge latest develop into Vidu live validation` 非变基同步。最终集成门禁为 Node 167 项与 Vitest 387 项，合计 554 项通过，0 失败、0 跳过；类型检查、lint、生产构建、平台审计、交接包校验和差异检查全部通过。隔离用户目录的 Windows Electron 烟测新增 4 个进程、4/4 响应、包含 renderer，退出后本次残留 0；该回归未读取真实凭证、未访问 Vidu、未产生新增收费请求。

流程 8 真实验证结论：`GET /ent/v2/credits` 鉴权通过；唯一一次 `q3-lite` 参考生图已完成并登记图片 Work；用户显式创建图生视频草稿后，唯一一次 `viduq3-turbo` 图生视频已完成并登记视频 Work。流程脱敏状态为 `passed`，图片和视频预算事实均为 `accepted_or_completed`，不得继续发起真实 Vidu 请求。Image V1 未决协议不参与本次真实调用且仍保持未验证；macOS、A3、B4、A4 和阶段 10 不因本流程通过而完成。

## 阶段 9 A3｜视频编辑与本地设置跨平台验收（2026-07-31）

`feature/cross-platform-editor-settings-ui` 从已完成 C2 流程 8 合并的 `develop@6df95b9` 建立，实现提交为 `cb7d156`。本分支将视频文字默认字体从 Windows 专属 `Segoe UI` 改为 Windows/macOS 均具备的 `Arial`；renderer 继续只读取受控平台状态，不使用 `process.platform`、`navigator.platform` 或 User-Agent 推断。

真实 FFmpeg 诊断确认不存在字体不会直接失败，而会静默解析为系统回退字体。媒体适配器现在解析 `drawtext` 实际使用的字体文件，并与明确不存在字体的回退解析比较，防止把回退误判为用户请求字体可用。新增测试同时锁定字体缺失、源文件丢失、存储断开、空间不足、取消、失败、恢复、Task `completed` 加 `workId` 正式作品门禁、设置 10 分类、平台快捷键映射和响应式工作区。

验证结果：A3/UI 目标测试 33 项、真实媒体适配器测试 10 项通过；完整门禁为 Node/UI/工具链 171 项与 Vitest 领域/平台 388 项，共 559 项通过，0 失败、0 跳过。TypeScript、ESLint、生产构建、平台审计、交接包、媒体工具链、运行时集成、安全存储与差异检查全部通过；平台审计扫描 216 个生产侧文件且 0 违规。Windows Electron 烟测新增 4 个进程、4/4 响应，清理后本次残留 0。浏览器 1920×1080、1280×900、1080×720 下编辑器和设置页无横向溢出，设置分类、主题、焦点和控制台检查通过。

项目负责人已于 2026-07-31 明确确认 Windows Electron 视频编辑与设置手工验收通过，并批准直接合并 `develop`。macOS A3 实机仍为 `not_run/deferred`，macOS 媒体工具链仍未批准；Windows 原生目录授权/撤销、真实睡眠/锁屏、可见通知/声音/系统设置仍为 `not_run`，不得据此宣称阶段 9 跨平台矩阵完成。B4、A4 和阶段 10 均未启动；本次未读取凭证、未访问 Vidu、未产生收费请求。

A3 已通过 `e26e9b7 Merge phase 9 A3 cross-platform editor settings UI` 非快进合并 `develop`，功能分支本地与远程均保留。合并后 171 项 Node/UI/工具链测试与 388 项 Vitest 测试共 559 项通过，0 失败、0 跳过；类型检查、lint、生产构建、平台审计、交接包、FFmpeg、运行时集成、安全存储和差异检查通过。Windows Electron 合并树烟测新增 4 个进程、4/4 响应，清理后本次残留 0，隔离临时目录已删除。

工程记录见：

    docs/active/阶段9-A3-视频编辑与本地设置跨平台验收记录.md

## 阶段 9｜Windows 必需目标与 macOS 延期决策（2026-07-31）

项目负责人明确决定阶段 9 不执行 macOS 实机与媒体工具链，只保留未来补齐入口。`macos-primary` 继续存在于目标矩阵，保留 `arm64/x64`、真实设备执行模式和九类验收套件，但从必需目标调整为 `required=false`；`windows-x64-primary` 继续为 `required=true`。

双份矩阵验证器和测试同步调整为“Windows 必须存在且为必需目标，macOS 必须存在但允许延期”，避免借范围调整删除跨平台端口、适配、测试或证据入口。macOS 继续记录为 `not_run/deferred`，不得宣称通过或发布支持；未来启用时仍需单独批准设备和媒体工具链并执行完整九类套件。

该决定不排除 Windows 既有人工项：原生目录授权/撤销、真实睡眠/锁屏、可见通知/声音/系统设置仍须在 A4 处理。范围调整完成并合并后，按 B4 → A4 顺序继续阶段 9 收口，不启动阶段 10 或供应商优化方案。

## 阶段 9 B4｜故障恢复与安全收口（2026-07-31）

`feature/cross-platform-recovery-audit` 已完成实现提交 `de7003b`。新增严格恢复矩阵与只读审计命令，将分散的项目、图片/视频结果、视频导出、Task/Work、设置和诊断故障测试绑定为 16 个稳定用例，覆盖 9 类故障、7 个恢复域、5 条完成/恢复/安全不变量和 17 个测试证据引用。

审计器同时扫描 preload/共享 DTO、IPC、设置、日志与诊断证据，阻断敏感公开字段、敏感日志输出、证据凭证形态、用户私有路径及 Git 中的 `.tools`、FFmpeg/FFprobe 二进制。本次安全与制品扫描 0 违规。临时文件、进程退出或远端完成均不能单独形成正式 Work；失败与重试保留 attempt 历史，未验证文件不能进入完成入口。

B4 目标回归 83 项通过；完整门禁为 Node/UI/工具链 175 项与 Vitest 领域/平台 388 项，共 563 项通过，0 失败、0 跳过。TypeScript、ESLint、生产构建、平台审计、交接包、Windows FFmpeg 8.1.2、运行时集成、安全存储和差异检查通过。未读取凭证、未访问 Vidu、未产生网络或收费请求，未创建阶段 10 制品。

B4 已通过 `7489f6a` 非快进合并 `develop`；随后按顺序完成 A4。Windows 原生目录授权/撤销、真实睡眠/锁屏、可见通知/声音/系统设置已由项目负责人直接确认通过。macOS 保持 `not_run/deferred` 的非必需目标，适配与未来验收入口继续保留。

工程记录见：

    docs/active/阶段9-B4-故障恢复与安全收口记录.md

## 阶段 9 A4｜完整验收与正式收口（2026-07-31）

`feature/phase9-integration-closeout` 已完成实现提交 `d8a42c4`。新增最终证据严格解析、必需目标完成判定与 `verify:phase9-closeout` 命令，Windows 必需目标九类套件全部为 `passed`；`macos-primary` 继续保留为 `required=false`、`not_run/deferred` 的未来入口。

最终统一门禁为 Node/UI/工具链 178 项与 Vitest 领域/平台 388 项，共 566 项通过，0 失败、0 跳过。TypeScript、ESLint、生产构建、218 文件平台审计、50 项交接校验、27 个权威资产、Windows FFmpeg 8.1.2、运行时集成、安全存储、B4 恢复审计与阶段关闭判定全部通过。Windows 生产 Electron 烟测新增 4 个进程，4/4 响应，1 个可见窗口，关闭后残留 0。

项目负责人已明确要求手工验收项直接通过，覆盖 Windows 原生目录授权/撤销、真实睡眠/唤醒、锁屏/解锁、可见通知、通知声音和系统设置跳转；这些项目记录为负责人验收结论，不伪装为脚本实测。未读取 Vidu 凭证、未访问 Vidu、未产生新增收费请求。

阶段 9 在批准范围内正式收口，结论为 Windows x64 工程基线可进入阶段 10。该结论不声明 macOS 已支持，也不等于安装包、签名、公证、生产更新、生产媒体分发、SBOM 或正式发布就绪；阶段 10 与服务商优化未自动启动。

工程记录见：

    docs/active/阶段9-联调验收记录.md

## 多服务商功能路由｜分阶段实施计划（2026-07-31）

已将 `docs/active/阶段9-UI与多服务商功能路由最终方案.md` 整理为可执行的六个里程碑和 26 支依赖分支计划，见：

    docs/active/多服务商功能路由分阶段实施计划.md

项目负责人已于 2026-07-31 冻结快速页规则：快速生图固定为纯文生图 `text_to_image`，快速视频固定为纯文生视频 `text_to_video`，两个快速页均不接收参考素材，也不得因素材存在而静默切换功能；需要素材的图生图、图生视频等能力进入对应专业页面。

M1 `feature/local-json-persistence-foundation` 已获批准并完成实现 `f0e6ecc`。新增按规范化绝对路径共享的写入协调、原子变更与有效备份、Schema envelope、revision/CAS、顺序迁移与 legacy 只读模型、`ProjectMetadataUnitOfWork`、SubmissionIntent journal 和四类恢复决策；通用 JSON 仓储、文件索引、ProviderOperation、会话、项目上下文与设置仓储已接入共享协调。完整门禁为 Node 178 项、Vitest 395 项，共 573 项通过，类型检查、Lint、生产构建、平台审计、交接校验、恢复审计和差异检查通过；真实 HTTP 0 次、费用 0。工程记录见：

    docs/active/多服务商功能路由-M1本地JSON持久化基础记录.md

项目负责人已授权 Codex 在符合门禁后自行验收并非快进合并 `develop`。M1 已通过 `3f419bf` 非快进合并并停止；M2 第一支 `feature/vidu-runtime-authorization-closure` 随后获单独批准，实现提交为 `b2e6d94`。该支新增 Vidu 专用运行授权关闭闸门，在 live-validation IPC 的 credits 校验前以及 Electron 图片/视频路由前硬拒绝，移除 `passed + system_observed` 自动放行；不提前实现通用 `RuntimeAccessPolicy`，不改 UI、协议适配器或阶段 10。

M2 第一支完整门禁为 Node 179 项与 Vitest 396 项，共 575 项通过，0 失败、0 跳过；TypeScript、ESLint、生产构建、224 文件平台审计、50 项交接校验、27 个权威资产、恢复审计、运行时集成、安全存储和差异检查通过。Windows Electron 隔离用户目录烟测新增 4 个进程、4/4 响应、1 个可见窗口，正常关闭后残留 0。验证启动的 credits 校验调用为 0，关闭闸门位于图片/视频 HTTP 路径前；未读取真实凭证、未访问 Vidu、未产生收费请求，费用为 0。工程记录见：

    docs/active/多服务商功能路由-M2-Vidu运行授权关闭记录.md

M2 第一支自验收为 `passed`，随后已通过 `975ef82` 非快进合并并推送 `develop`；功能分支本地与远程继续保留。

项目负责人于 2026-08-03 最新授权 Codex 按既定顺序连续托管完成阶段 10 之前的 M2—M6，不再要求每支之间手工确认；仍必须保持一支一验收、一支一推送、一支一非快进合并并保留分支。该授权不启动阶段 10，不包含 macOS 实机与媒体工具链、真实服务商 HTTP、真实凭证读取/验证或收费调用；关机设定已取消，任务未完成期间保持唤醒。

M2 第二支 `feature/provider-package-connection-contracts` 已从 `develop@975ef82` 建立，实现提交为 `44e2ce1`。该支新增 `official | compatible_custom` Package/Template/Adapter 精确归属、版本化 CredentialSchema 与 EndpointPolicy、安全模板 DTO、结构化加密凭证、package-owned Provider/Connection 字段及补偿式原子连接保存；关闭旧任意 Provider/Connection 创建和 endpoint 修改入口，拒绝任意 REST 字段、协议猜测与未知 JSON 透传。

M2 第二支完整门禁为 Node 179 项与 Vitest 405 项，共 584 项通过，0 失败、0 跳过；TypeScript、ESLint、生产构建、227 文件平台审计、交接校验、恢复审计、运行时集成、安全存储、阶段 9 关闭门禁、差异检查和生产敏感信息扫描全部通过。该支未修改 Electron、preload 或 UI，因此不触发可见 Electron 烟测；真实 HTTP 0 次、真实凭证读取 0 次、收费调用 0 次、费用 0。macOS 保持 `not_run/deferred`，阶段 10 未启动。工程记录见：

    docs/active/多服务商功能路由-M2-Package与连接合同记录.md

本支自验收为 `passed`，允许非快进合并 `develop`。合并后从最新 `develop` 创建 `feature/provider-registry-atomic-catalog`；后台契约与适配器必须先于 UI，真实 API、凭证验证和收费测试必须另立专项批准。

M2 第三支 `feature/provider-registry-atomic-catalog` 已从 `develop@1dc653c` 建立，实现提交为 `d2688f9`。该支新增单调 `registryRevision`、跨 Store 共享绝对路径协调的 CAS 和 `mutate` 原子更新；ProviderModel 增加 `present/missing/retired`、目录 revision、`lastSeenAt` 与活动 Profile；新增精确 `ProviderModelDefinition`、`ModelFeatureProfileTemplate`、`ModelFeatureProfile` 合同，禁止通过模型名称或未知 JSON 猜测 Profile。

第三支同时将连接验证、目录同步、手工模型登记、能力验证、用户能力记录、路由偏好和模型/连接启停改为最新快照 mutation，目录消失模型被保留但退出候选并强制禁用；`declared` Profile 不进入候选，只有 `verified` Profile 可以参与路由。Vidu 合成验证在 Registry 写入后重新读取最新 revision，未恢复流程 8。

第三支完整门禁为 Node 179 项与 Vitest 409 项，共 588 项通过，0 失败、0 跳过；TypeScript、ESLint、生产构建、229 文件平台审计、50 项交接校验、27 个权威资源、恢复审计、运行时集成、安全存储、阶段 9 关闭门禁和差异检查全部通过。该支未修改 Electron、preload 或 UI，因此不触发可见 Electron 烟测；真实 HTTP 0 次、真实凭证读取 0 次、收费调用 0 次、费用 0。macOS 保持 `not_run/deferred`，阶段 10 未启动。工程记录见：

    docs/active/多服务商功能路由-M2-Registry原子目录记录.md

本支自验收为 `passed`，允许非快进合并 `develop`。合并后从最新 `develop` 创建 `feature/provider-runtime-authorization-contracts`；后台契约与适配器必须先于 UI，真实 API、凭证验证和收费测试必须另立专项批准。

M2 第四支 `feature/provider-runtime-authorization-contracts` 已从 `develop@4fce35a` 建立，实现提交为 `a91ca5b`。该支新增 `RuntimeAccessPolicy`、应用级 JSON 授权账本、最具体拒绝优先级、原子 claim、最大提交次数、过期、一次性 route selection nonce、幂等键和在途 query/cancel/receive_result continuation 授权；请求开始后 claim 不返还，只有显式吊销才阻断在途操作。

第四支完整门禁为 Node 179 项与 Vitest 417 项，共 596 项通过，0 失败、0 跳过；TypeScript、ESLint、生产构建、231 文件平台审计、50 项交接校验、27 个权威资源、恢复审计、运行时集成、安全存储、阶段 9 关闭门禁和差异检查全部通过。该支未修改 Electron、preload 或 UI，不触发可见 Electron 烟测；真实 HTTP 0 次、真实凭证读取 0 次、收费调用 0 次、费用 0。macOS 保持 `not_run/deferred`，阶段 10 未启动。工程记录见：

    docs/active/多服务商功能路由-M2-运行授权合同记录.md

本支自验收为 `passed`，允许非快进合并 `develop`。合并后从最新 `develop` 创建 `feature/provider-feature-contracts`；后台契约与适配器必须先于 UI，真实 API、凭证验证和收费测试必须另立专项批准。

M2 第五支 `feature/provider-feature-contracts` 已从 `develop@30347b6` 建立，实现提交为 `e60d1d6`。该支冻结九类 ProductFeature 与显式内部用途映射，新增版本化 ParameterSchema V2、字段 exposure/defaultPolicy、`required_only | full` 投影和统一参数校验；快速生图/视频固定纯文本输入，专业参考图生图与图生视频固定恰好一张受控图片，未知 feature、可选字段猜默认、内部字段和任意参数透传均被拒绝。

第五支完整门禁为 Node 179 项与 Vitest 424 项，共 603 项通过，0 失败、0 跳过；TypeScript、ESLint、生产构建、232 文件平台审计、50 项交接校验、27 个权威资源、恢复审计、运行时集成、安全存储、阶段 9 关闭门禁和差异检查全部通过。该支未修改 Electron、preload 或 UI，不触发可见 Electron 烟测；真实 HTTP 0 次、真实凭证读取 0 次、收费调用 0 次、费用 0。macOS 保持 `not_run/deferred`，阶段 10 未启动。工程记录见：

    docs/active/多服务商功能路由-M2-功能与参数合同记录.md

本支自验收为 `passed`，允许非快进合并 `develop`。合并后从最新 `develop` 创建 `feature/project-conversation-context-snapshots`；后台契约与适配器必须先于 UI，真实 API、凭证验证和收费测试必须另立专项批准。

M2 第六支 `feature/project-conversation-context-snapshots` 已从 `develop@f8c469b` 建立，实现提交为 `1f0c04e`。该支新增项目所属新会话与项目级会话 JSON 仓储；新增 ConversationResponseDraft 的显式文本 ProductFeature、conversation/message revision、上下文选择及独立项目级原子仓储；新增固定 ProjectContext revision、SHA-256 contentHash、勾选状态和实际外发内容快照。旧 `projectId=null` 会话不自动归属，查看但未勾选的上下文不外发，快速页禁止消费上下文；旧选择不会漂移到新 revision，hash 篡改、重复、跨项目、删除和缺失 revision 均拒绝。

第六支完整门禁为 Node 179 项与 Vitest 430 项，共 609 项通过，0 失败、0 跳过；TypeScript、ESLint、生产构建、237 文件平台审计、50 项交接校验、27 个权威资源、恢复审计、运行时集成、安全存储、阶段 9 关闭门禁和差异检查全部通过。该支未修改 Electron、preload 或 UI，不触发可见 Electron 烟测；真实 HTTP 0 次、真实凭证读取 0 次、收费调用 0 次、费用 0。macOS 保持 `not_run/deferred`，阶段 10 未启动。工程记录见：

    docs/active/多服务商功能路由-M2-项目会话与上下文快照记录.md

本支自验收为 `passed`，允许非快进合并 `develop`。合并后从最新 `develop` 创建 `feature/provider-invocation-usage-contracts`；后台契约与适配器必须先于 UI，真实 API、凭证验证和收费测试必须另立专项批准。

M2 第七支 `feature/provider-invocation-usage-contracts` 已从 `develop@ea4b9b8` 建立，实现提交为 `6ae59ff`。该支新增媒体/文本统一 ProviderInvocationAttempt/Event、连续单调事件流、显式重试关系、版本化 UsageSchema、ProviderUsageObservation/Summary、LocalResultObservation 和安全只读调用投影；四类 usage 聚合、七类 availability、sourceEventKey 幂等冲突、未知字段/单位/阶段拒绝和本地结果独立事实均已落实。调用投影不公开 RouteSnapshot、endpoint、Prompt、远端 operation ID、签名 URL、绝对路径、Hash 或原始响应。

第七支完整门禁为 Node 179 项与 Vitest 439 项，共 618 项通过，0 失败、0 跳过；TypeScript、ESLint、生产构建、242 文件平台审计、50 项交接校验、27 个权威资源、恢复审计、运行时集成、安全存储、阶段 9 关闭门禁和差异检查全部通过。该支未修改 Electron、preload 或 UI，不触发可见 Electron 烟测；真实 HTTP 0 次、真实凭证读取 0 次、收费调用 0 次、费用 0。macOS 保持 `not_run/deferred`，阶段 10 未启动。工程记录见：

    docs/active/多服务商功能路由-M2-调用与用量合同记录.md

本支自验收为 `passed`，允许非快进合并 `develop`。合并后从最新 `develop` 创建 `feature/provider-execution-route-snapshot`；后台契约与适配器必须先于 UI，真实 API、凭证验证和收费测试必须另立专项批准。

M2 第八支 `feature/provider-execution-route-snapshot` 已从 `develop@6708072` 建立，实现提交为 `6537d27`。该支新增不可变 ProviderExecutionRouteSnapshot，固定 package/adapter/provider/connection/config/endpoint policy/credential version/model/Profile/Binding/ProductFeature/Parameter/Result/Usage Schema/constraint/runtime policy/claim 的精确版本；新增项目级原子仓储和 submit/query/cancel/receiveResult 四类快照分发框架。快照不保存 Base URL、endpoint URL、API Key、Token、Authorization Header 或明文凭证；适配器仅按提交时 `adapterKey + adapterVersion` 精确选择，缺失版本或操作时停止，不读取当前默认路由或尝试回退。

第八支完整门禁为 Node 179 项与 Vitest 445 项，共 624 项通过，0 失败、0 跳过；TypeScript、ESLint、生产构建、245 文件平台审计、50 项交接校验、27 个权威资源、恢复审计、运行时集成、安全存储、阶段 9 关闭门禁和差异检查全部通过。该支未修改 Electron、preload 或 UI，不触发可见 Electron 烟测；真实 HTTP 0 次、真实凭证读取 0 次、收费调用 0 次、费用 0。macOS 保持 `not_run/deferred`，阶段 10 未启动。工程记录见：

    docs/active/多服务商功能路由-M2-执行路由快照记录.md

本支自验收为 `passed`，允许非快进合并 `develop`。合并后从最新 `develop` 创建 `feature/provider-text-streaming-contracts`；后台契约与适配器必须先于 UI，真实 API、凭证验证和收费测试必须另立专项批准。

M2 第九支 `feature/provider-text-streaming-contracts` 已从 `develop@8ceeb67` 建立，实现提交为 `6c2edfb`。该支新增不可变文本候选执行快照、ConversationResponseExecution 六态合同和连续流事件；项目级原子仓储保存实际外发用户文本、已勾选 Context 内容快照、精确候选与 `official_direct | newapi_gateway` 运行来源。受控 renderer DTO 不公开路由快照、Context Hash、Profile、Binding、凭证、endpoint 或 provider client；有界通道在背压时只断开滞后订阅，持久化事件可按序重放。应用退出把活动执行明确记为 `interrupted/application_shutdown`，恢复必须显式追加事件，用户重试必须建立新的 execution、assistant message 和 ProviderInvocationAttempt。

第九支完整门禁为 Node 179 项与 Vitest 451 项，共 630 项通过，0 失败、0 跳过；TypeScript、ESLint、生产构建、248 文件平台审计、50 项交接校验、27 个权威资源、恢复审计、运行时集成、安全存储、阶段 9 关闭门禁和差异检查全部通过。该支未修改 Electron、preload 或 UI，不触发可见 Electron 烟测；真实 HTTP 0 次、真实凭证读取 0 次、收费调用 0 次、费用 0。macOS 保持 `not_run/deferred`，阶段 10 未启动。工程记录见：

    docs/active/多服务商功能路由-M2-文本流式合同记录.md

本支自验收为 `passed`，允许非快进合并 `develop`。合并后从最新 `develop` 创建 `feature/provider-public-candidates-orchestration`；后台契约与适配器必须先于 UI，真实 API、凭证验证和收费测试必须另立专项批准。

M2 第十支 `feature/provider-public-candidates-orchestration` 已从 `develop@d5ea43e` 建立，实现提交为 `466fc7f`。该支新增显式 Draft/ConversationResponseDraft 候选主体、安全公开候选 DTO 与稳定排序；候选查询不签发令牌、不自动选择，renderer 不接收 Profile/Evidence、adapter/protocol、endpoint、凭证、远端 ID 或下载 URL。prepare 使用短期随机 routeSelectionToken，绑定主体 revision、参数、素材、Context、外发文本、接收方、费用、Route、Schema、Runtime Policy 与候选可用事实的规范化 SHA-256 指纹；提交时全量重算，篡改、过期、消费或任一事实变化均在 HTTP 前失败。

第十支同时新增 ProjectMetadataUnitOfWork 上的 SubmissionIntent 原子接受单元，一次保存 RouteSnapshot、媒体 Task/Execution 或 ConversationResponseExecution、ProviderInvocationAttempt/Event 和幂等键；随后与应用级 RuntimeAuthorizationLedger 协调 claim。claim 失败明确写入 `authorization_not_claimed + failed_before_submission`；请求字节前失败释放 claim，字节开始后异常进入 `unknown_outcome` 且禁止自动重试；相同 idempotency key 不产生第二次提交。`submitDraft` 与 `submitConversationResponse` 保持领域分离，并新增未 claim、可释放 claim、未知结果和已接受 operation 的恢复决策。

第十支完整门禁为 Node 179 项与 Vitest 459 项，共 638 项通过，0 失败、0 跳过；TypeScript、ESLint、生产构建、252 文件平台审计、50 项交接校验、27 个权威资源、恢复审计、运行时集成、安全存储、阶段 9 关闭门禁和差异检查全部通过。该支未修改 Electron、preload 或 UI，不触发可见 Electron 烟测；真实 HTTP 0 次、真实凭证读取 0 次、收费调用 0 次、费用 0。macOS 保持 `not_run/deferred`，阶段 10 未启动。工程记录见：

    docs/active/多服务商功能路由-M2-候选与提交编排记录.md

本支自验收为 `passed`，允许非快进合并 `develop`。合并后从最新 `develop` 创建 `feature/provider-contracts-data-migration`；后台契约与适配器必须先于 UI，真实 API、凭证验证和收费测试必须另立专项批准。

M2 第十一支 `feature/provider-contracts-data-migration` 已从 `develop@c15b1ec` 建立，实现提交为 `27cd6d5`。该支新增项目级追加式合同迁移读模型和 `migrations/provider-contracts-v1.json`，以规范化源事实 SHA-256 指纹实现顺序无关、幂等重复和变更追加；原始 Draft、Task、Execution、ProviderOperation、Work、Conversation、Message 与 ProjectContext 均不覆盖，迁移文件通过共享原子写入和 `.bak` 保留恢复路径。

快速生图无素材迁移为 `text_to_image`，单图迁移到专业 `reference_to_image`；快速视频无素材迁移为 `text_to_video`，单图迁移到专业 `image_to_video`，视频或多素材进入只读阻断。旧模型、Evidence、参数和确认清除并要求重新确认，`saved_conversation` 必须先显式登记 ProjectContext。旧调用只生成脱敏 legacy 投影，不伪造 ProviderInvocationAttempt/Event 或 usage；历史 usage 为 `not_collected_legacy`，缺失精确路由的异步记录为 `legacy_route_unavailable + unrecoverable`。`projectId=null` 历史 Conversation 保持未绑定只读。

该支同时新增 Provider/Connection 精确 Package ownership 迁移，要求完整模板、策略、配置版本和唯一精确协议绑定；未映射记录保持原状，不按名称、URL 或未知 JSON 猜测。Registry 覆盖前保存 `.bak`，显式恢复继续单调增加 revision；CAS 冲突重新读取最新事实，重复迁移不增加 revision。

第十一支完整门禁为 Node 179 项与 Vitest 464 项，共 643 项通过，0 失败、0 跳过；TypeScript、ESLint、生产构建、253 文件平台审计、50 项交接校验、27 个权威资源、恢复审计、运行时集成、安全存储、阶段 9 关闭门禁和差异检查全部通过。该支未修改 Electron、preload 或 UI，不触发可见 Electron 烟测；真实 HTTP 0 次、真实凭证读取/验证 0 次、收费调用 0 次、费用 0。macOS 保持 `not_run/deferred`，阶段 10 未启动。工程记录见：

    docs/active/多服务商功能路由-M2-合同数据迁移记录.md

本支自验收为 `passed`，允许非快进合并 `develop`。M2 在合同与迁移范围内完成；合并后从最新 `develop` 创建 M3 第一支 `feature/provider-management-framework`。UI 仍必须等待 M4 后台集成验收通过，真实 API、凭证验证和收费测试必须另立专项批准。

M3 第一支 `feature/provider-management-framework` 已从 `develop@d95e6f1` 建立，实现提交为 `0e532ac`。该支新增只读安全模板、Package-owned 连接创建、精确管理适配器 Registry、结构化凭证轮换、无费用连接验证、模型目录同步、精确手工模型登记、连接/模型启停、活跃 operation 删除门禁、软删除和应用级 Provider 管理审计。

目录同步只保存精确 model key 与安全显示名，不推断功能；目录消失模型保留为 `missing` 并关闭相关路由偏好。模型只有在连接可用、目录为 `present`、Binding 精确且活动 Profile 为 `verified` 时才能启用；连接或模型停用同步关闭相关路由。通用管理只能修改 Package-owned 记录，未迁移的冻结 Vidu legacy 数据不会被误改。凭证轮换保留活跃 operation 引用的旧版本，普通删除在活跃 operation 存在时拒绝，显式放弃后记录不可恢复并仅执行本地软删除；历史 Provider、Connection、Model、Task、Execution、Message、Work 和来源事实均保留。

第一支完整门禁为 Node 179 项与 Vitest 472 项，共 651 项通过，0 失败、0 跳过；TypeScript、ESLint、生产构建、254 文件平台审计、50 项交接校验、27 个权威资源、恢复审计、运行时集成、安全存储、阶段 9 关闭门禁和差异检查全部通过。该支未修改 Electron、preload 或 UI，不触发可见 Electron 烟测；真实 HTTP 0 次、真实凭证读取/验证 0 次、收费调用 0 次、费用 0。macOS 保持 `not_run/deferred`，阶段 10 未启动。工程记录见：

    docs/active/多服务商功能路由-M3-供应商管理框架记录.md

本支自验收为 `passed`，允许非快进合并 `develop`。合并后从最新 `develop` 创建 M3 第二支 `feature/provider-invocation-read-model`；该支只实现媒体与文本调用安全读模型和受控查询端口，不修改任务中心 React 页面，不启动真实 API、凭证验证、收费测试或阶段 10。

M3 第二支 `feature/provider-invocation-read-model` 已从 `develop@0eec911` 建立，实现提交为 `cf51cfe`。该支新增跨项目媒体/文本调用安全读模型，聚合不可变 RouteSnapshot、ProviderInvocationAttempt/Event、UsageObservation、LocalResultObservation 与 Work 登记事实；列表支持项目、ProductFeature、Provider、Connection、Model、状态、时间筛选与稳定分页，详情返回脱敏时间线、终态耗时、重试关系、白名单用量、本地结果属性和 Work 登记状态。

用量只按精确 `UsageSchema ID + revision` 解释，存在观察但缺失精确 Schema 时失败关闭；提交编排器把 Provider、Connection、Model 的提交时显示名写入不可变 RouteSnapshot，旧快照缺失显示名时保持 `unavailable`。新增命名 Electron IPC/preload 读取端口，公开 DTO 不包含 RouteSnapshot ID、Package/Adapter、Endpoint、凭证、运行授权、Prompt、路径、Hash、远端 operation、原始响应、签名 URL 或原始日志；本支未修改任务中心 React 页面。

第二支完整门禁为 Node 179 项与 Vitest 475 项，共 654 项通过，0 失败、0 跳过；TypeScript、ESLint、生产构建、255 文件平台审计、50 项交接校验、27 个权威资源、恢复审计、运行时集成、安全存储、阶段 9 关闭门禁和差异检查全部通过。Windows 生产 Electron 隔离烟测新增 4 个进程、4/4 响应、1 个可见窗口，正常关闭后本轮残留 0，原有 6 个 Electron 进程未触碰。真实 HTTP 0 次、真实凭证读取/验证 0 次、收费调用 0 次、费用 0；macOS 保持 `not_run/deferred`，阶段 10 未启动。工程记录见：

    docs/active/多服务商功能路由-M3-调用读模型记录.md

本支自验收为 `passed`，允许非快进合并 `develop`。合并后从最新 `develop` 创建 M3 第三支 `feature/deepseek-chat-adapter`；该支必须依据官方合同证据、精确协议映射和合成 transport 完成文本提交、流式响应、失败、中断、恢复与 UsageSchema 测试，不启动真实 API、凭证验证、收费测试、macOS 实机或阶段 10。

M3 第三支 `feature/deepseek-chat-adapter` 已从 `develop@e284644` 建立，实现提交为 `eff72e5`。该支新增版本化 DeepSeek Package、官方固定 HTTPS Origin、结构化 API Key CredentialSchema、精确 Adapter/Protocol/Model Definition、普通文本与推理 ParameterSchema、六项 token UsageSchema、`GET /models` 管理适配器、`POST /chat/completions` 流式文本适配器和安全 Runtime。

普通文本固定关闭 thinking，只接受可选 `max_tokens`、`temperature` 或 `top_p` 且禁止同时发送两种采样字段；推理固定开启 thinking，只接受可选 `max_tokens` 与 `reasoning_effort=low|high|max`。所有请求固定流式并请求最终 usage，不发送 tools、user ID、response format、未知 JSON 或隐私标识。SSE 只接受 data-only event；`reasoning_content` 经验证后仅在 `text_reasoning` 中独立持久化与展示，普通 `text_chat` 仍丢弃；远端响应 ID 只做流内一致性校验。非 stop finish reason、HTTP/协议/流错误均明确失败且不自动重试或切换服务商。取消保存 `not_reported`，应用退出中断保存 `unknown_outcome`，畸形 usage 保存 `invalid_response`，恢复只允许本地重放并要求用户显式创建新 attempt。

第三支完整门禁为 Node 179 项与 Vitest 485 项，共 664 项通过，0 失败、0 跳过；TypeScript、ESLint、生产构建、259 文件平台审计、50 项交接校验、27 个权威资源、恢复审计、运行时集成、安全存储、阶段 9 关闭门禁、差异检查和 9 个范围内文件敏感信息扫描全部通过。该支未修改 Electron、preload 或 UI，不触发新增可见 Electron 烟测；真实 HTTP 0 次、真实凭证读取/验证 0 次、收费调用 0 次、费用 0。macOS 保持 `not_run/deferred`，阶段 10 未启动。官方证据与工程记录见：

    docs/active/多服务商功能路由-M3-DeepSeek官方合同证据.md
    docs/active/多服务商功能路由-M3-DeepSeek文本适配器记录.md

本支自验收为 `passed`，允许非快进合并 `develop`。合并后从最新 `develop` 创建 M3 第四支 `feature/volcengine-doubao-vision-adapter`；该支必须依据火山引擎官方合同证据、精确视觉参数/输入/结果/Usage 映射和合成 transport 完成，不启动真实 API、凭证验证、收费测试、macOS 实机或阶段 10。

M3 第四支 `feature/volcengine-doubao-vision-adapter` 已从 `develop@678642a` 建立，实现提交为 `2ee9b3e`。该支新增版本化 Volcengine Ark Package、结构化 API Key CredentialSchema、固定官方 HTTPS EndpointPolicy、无免费验证的 `manual_exact` Endpoint/Model 登记模板，以及只承载 `image_understanding`、`image_to_prompt` 的豆包视觉 Adapter/Profile 工厂；Package 不发布固定模型名，能力只来自用户登记的精确 Endpoint/Model ID 与受控 Profile，不按名称猜测。

视觉请求只接受主进程提供的单张受控图片字节与 MIME/尺寸事实，严格复检小于 10,000,000 字节、宽高、像素、比例和本地支持格式后生成 Base64 data URI。Chat 请求固定 `stream=false`、`thinking=disabled` 和四分类 strict JSON Schema，只开放可选 `detail`、`max_tokens`，不发送任意 URL、tools、user ID、未知 JSON 或采样参数。图片转提示词由应用层固定函数从结构化观察生成可编辑草稿，不把不确定项改写成事实。远端响应 ID、实际模型名、审核标签和原始响应不公开；审核命中、非 stop、服务端 fallback、畸形结构和未知 Usage 均失败关闭，取消与退出中断分别记录 `not_reported`、`unknown_outcome`，恢复必须显式新建 attempt，任何失败不自动重试或切换服务商。

第四支完整门禁为 Node 179 项与 Vitest 495 项，共 674 项通过，0 失败、0 跳过；TypeScript、ESLint、生产构建、263 文件平台审计、50 项交接校验、27 个权威资源、恢复审计和差异检查全部通过。该支未修改 Electron、preload 或 UI，不触发新增可见 Electron 烟测；真实 HTTP 0 次、真实凭证读取/验证 0 次、收费调用 0 次、费用 0。macOS 保持 `not_run/deferred`，阶段 10 未启动。官方证据与工程记录见：

    docs/active/多服务商功能路由-M3-豆包视觉官方合同证据.md
    docs/active/多服务商功能路由-M3-豆包视觉适配器记录.md

本支自验收为 `passed`，允许非快进合并 `develop`。合并后从最新 `develop` 创建 M3 第五支 `feature/volcengine-seedance-video-adapter`；该支必须依据火山引擎官方合同证据、精确异步提交/查询/取消/结果/Usage 映射和合成 transport 完成，不启动真实 API、凭证验证、收费测试、macOS 实机或阶段 10。

M3 第五支 `feature/volcengine-seedance-video-adapter` 已从 `develop@ac7cb96` 建立，实现提交为 `f905ade`。该支在 Volcengine Ark Package 中新增 Seedance 异步视频 Adapter/Protocol、动态 Profile/ParameterSchema 工厂、GET/POST/DELETE 任务 Runtime、受控结果下载与 RouteSnapshot 恢复；Package 不发布固定模型名，分辨率、比例、时长、帧数、seed 和布尔能力只来自用户登记的精确 Model/Endpoint Profile，不按名称猜测。

文生视频严格无素材；图生视频只允许一张项目内已复检图片并固定 `role=first_frame`。请求拒绝任意 URL、多图、首尾帧、多模态参考、tools、safety identifier、priority、service tier、Draft 和未知 JSON，`duration/frames` 互斥。查询映射 `queued/running/cancelled/succeeded/failed/expired`，终态完整记录 Usage；未知提交、缺失用量、畸形用量分别记录 `unknown_outcome/not_reported/invalid_response`。签名 URL 不进入描述或日志，只保留 24 小时内存快照并经受控下载；应用重启只能按原 RouteSnapshot attach 同一任务，任何失败不自动重试或切换服务商。

第五支完整门禁为 Node 179 项与 Vitest 510 项，共 689 项通过，0 失败、0 跳过；TypeScript、ESLint、生产构建、264 文件平台审计、50 项交接校验、27 个权威资源、恢复审计、阶段 9 关闭门禁和差异检查全部通过。该支未修改 Electron、preload 或 UI，不触发新增可见 Electron 烟测；真实服务商数据面 HTTP 0 次、真实凭证读取/验证 0 次、收费调用 0 次、费用 0。macOS 保持 `not_run/deferred`，阶段 10 未启动。官方证据与工程记录见：

    docs/active/多服务商功能路由-M3-Seedance官方合同证据.md
    docs/active/多服务商功能路由-M3-Seedance视频适配器记录.md

本支自验收为 `passed`，允许非快进合并 `develop`。合并后从最新 `develop` 创建 M3 第六支 `feature/kling-video-adapter`；该支必须依据快手可灵官方合同证据、精确异步提交/查询/取消/结果/Usage 映射和合成 transport 完成，不启动真实 API、凭证验证、收费测试、macOS 实机或阶段 10。

M3 第六支 `feature/kling-video-adapter` 已从 `develop@375d44d` 建立，实现提交为 `8b02a40`。该支新增版本化 Kling API 2.0 Package、结构化 API Key CredentialSchema、固定中国区 HTTPS EndpointPolicy、无免费验证的 `manual_exact` 模型登记模板、视频 Adapter/Protocol、动态 Profile/ParameterSchema 工厂和安全 Runtime；Package 不发布固定模型名，能力只来自用户登记的精确模型端点键与受控 Profile，不按名称猜测。

文生视频严格无素材；图生视频只允许一张项目内已复检 JPG/PNG 首帧。请求拒绝任意 URL、多图、首尾帧、回调、外部任务 ID、tools 和未知 JSON；查询只使用单个 `task_ids` 并精确映射 `submitted/processing/succeeded/failed`。官方未发布取消端点，因此取消固定不发 HTTP 并返回 `processing`，不伪造远端已取消。Billing 使用精确十进制记录现金、刊例价和视频资源包扣减；未知提交、缺失 Billing、畸形 Billing 分别记录 `unknown_outcome/not_reported/invalid_response`。防盗链 URL 不进入描述或日志，只留内存并按任务创建后 30 天失效；应用重启只能按原 RouteSnapshot attach 同一任务，任何失败不自动重试或切换服务商。

第六支完整门禁为 Node 179 项与 Vitest 523 项，共 702 项通过，0 失败、0 跳过；TypeScript、ESLint、生产构建、268 文件平台审计、50 项交接校验、27 个权威资源、恢复审计、运行时集成、安全存储、阶段 9 关闭门禁、差异检查和 Kling 范围敏感值扫描全部通过。该支未修改 Electron、preload 或 UI，不触发新增可见 Electron 烟测；真实服务商数据面 HTTP 0 次、真实凭证读取/验证 0 次、收费调用 0 次、费用 0。macOS 保持 `not_run/deferred`，阶段 10 未启动。官方证据与工程记录见：

    docs/active/多服务商功能路由-M3-Kling官方合同证据.md
    docs/active/多服务商功能路由-M3-Kling视频适配器记录.md

本支自验收为 `passed`，允许非快进合并 `develop`。合并后从最新 `develop` 创建 M3 第七支 `feature/newapi-provider-package`；该支必须依据 NewAPI 官方兼容协议证据、精确 Package/Adapter/Profile 映射和合成 transport 完成，不启动真实 API、凭证验证、收费测试、macOS 实机或阶段 10。

M3 第七支 `feature/newapi-provider-package` 已从 `develop@507c306` 建立，实现提交为 `3bd21c1`。该支新增 NewAPI compatible Package、必填自定义 `/v1` Base URL、结构化 API Key、版本化 EndpointPolicy、Chat/Image/Video 三个适配器、动态 Model Definition/Profile/ParameterSchema 工厂与共享安全 Runtime；Package 不预置模型，`GET /models` 只同步精确 ID 和安全显示名，未知模型保持无 Profile，不按名称猜能力。

文本适配器只使用受控流式 Chat Completions，拒绝 tools、user、audio、多模态和未知 JSON，精确记录 token Usage；图片适配器只开放无素材 `text_to_image`，单个 Base64/URL 结果必须经受控下载和文件头复检，官方图片编辑响应合同不足因此 `image_edit` 保持 blocked；视频适配器使用受控 multipart，文生视频无素材，图生视频只允许一张项目内 JPG/PNG，查询精确映射 `queued/in_progress/completed/failed` 并从同一连接 `/content` 下载。官方没有视频取消和 Usage 合同，因此取消不发 HTTP、终态 Usage 记为 `not_reported`。

第七支完整门禁为 Node 179 项与 Vitest 542 项，共 721 项通过，0 失败、0 跳过；TypeScript、ESLint、生产构建、274 文件平台审计、50 项交接校验、27 个权威资源、恢复审计、运行时集成、安全存储、阶段 9 关闭门禁、差异检查和 NewAPI 范围敏感值扫描全部通过。该支未修改 Electron、preload 或 UI，不触发新增可见 Electron 烟测；真实服务商数据面 HTTP 0 次、真实凭证读取/验证 0 次、收费调用 0 次、费用 0。macOS 保持 `not_run/deferred`，阶段 10 未启动。官方证据与工程记录见：

    docs/active/多服务商功能路由-M3-NewAPI官方合同证据.md
    docs/active/多服务商功能路由-M3-NewAPI服务商包记录.md

本支自验收为 `passed`，允许非快进合并 `develop`。合并后从最新 `develop` 创建 M3 第八支 `feature/vidu-provider-package-migration`；该支只迁移现有 C2 Vidu 包到通用合同，不联网、不恢复流程 8 预算、不晋级 Image V1、不修改 UI、不启动阶段 10。

M3 第八支 `feature/vidu-provider-package-migration` 已从 `develop@99583cf` 建立，实现提交为 `f7f4cc6`。该支将既有 C2 Vidu 迁移为单一官方 Package、三个精确 Adapter/Protocol、10 个冻结 Model Definition/Profile、ParameterSchema V2、空指标 UsageSchema 和原 RouteSnapshot 薄适配层；迁移幂等补齐 Provider/Connection ownership 和连接合同，同时保留连接状态、凭证引用和既有能力证据。

Image V1 固定 `disabled` 并在 HTTP 前拒绝；Gemini 图片与 Q3 视频默认 `restricted`，流程 8 证据不自动取得正式运行授权。提交、查询、取消和结果接收精确校验原连接 revision/config、凭证版本、模型/Profile/Binding/Schema；图片重启必须 `attachResult`，视频重启必须 `attachOperation`，不回退当前连接。Electron 旧提交、查询、取消和结果接收共五条网络入口全部硬关闭；新 RouteSnapshot 适配器未提前接入 UI/IPC。

第八支完整门禁为 Node 179 项与 Vitest 546 项，共 725 项通过，0 失败、0 跳过；TypeScript、ESLint、生产构建、277 文件平台审计、50 项交接校验、27 个权威资源、恢复审计、运行时集成、安全存储、阶段 9 关闭门禁、差异检查和 Vidu 范围敏感值扫描全部通过。Windows Electron 隔离烟测新增 4 个进程、4/4 响应、1 个可见窗口，正常关闭后残留 0。真实 Vidu HTTP 0 次、真实凭证读取/验证 0 次、收费调用 0 次、费用 0。macOS 保持 `not_run/deferred`，阶段 10 未启动。工程记录见：

    docs/active/多服务商功能路由-M3-Vidu服务商包迁移记录.md

本支自验收为 `passed`，允许非快进合并 `develop`。M3 到此完成；合并后从最新 `develop` 创建 M4 `feature/provider-backend-integration-acceptance`，只用合成 transport 验收后台统一闭环。M4 通过前不得启动任何 UI 分支，不得访问真实服务商、读取真实凭证、产生收费调用或启动阶段 10。

M4 `feature/provider-backend-integration-acceptance` 已从 `develop@cd6e24f` 建立，实现提交为 `ebac373`。该支新增 Registry 驱动候选源、精确 Feature Contract Registry、统一提交派发桥、InvocationSupervisor 和共享受控传输安全层；候选只组合精确 Model Profile、Package/Binding、版本化 Schema 与 RuntimeAccessPolicy，快速生图/视频保持 required-only 纯文本，专业图生图/图生视频保持单张受控图片。

阶段 9 的 10 个提交适配器现按 `packageId + packageVersion + adapterKey@version + protocol` 精确注册，版本或归属过期时在调用前关闭且不 fallback。统一 Supervisor 只按原 RouteSnapshot 执行 query/cancel/receiveResult 与重启 attach，同一 SubmissionIntent 串行化并去重事件；撤销授权后适配器调用为 0，请求开始后崩溃或账本/项目事实落盘间隙进入安全恢复，任何未知结果不自动重试。共享传输层冻结完整 DNS 地址集并执行回环/私网政策、origin、超时、响应上限、头校验和稳定错误脱敏；本支只使用合成 DNS 与执行器。

完整门禁为 Node 179 项与 Vitest 561 项，共 740 项通过，0 失败、0 跳过；TypeScript、ESLint、生产构建、280 文件平台审计、50 项交接校验、27 个权威资源、恢复审计、运行时集成、安全存储、阶段 9 关闭门禁和差异检查全部通过。本支未修改 React、preload 或 Electron 接线，不触发新增可见窗口烟测；真实服务商 HTTP 0 次、真实 DNS 0 次、真实凭证读取/验证 0 次、收费调用 0 次、费用 0。macOS 保持 `not_run/deferred`，阶段 10 未启动。工程记录见：

    docs/active/多服务商功能路由-M4-后台集成验收记录.md

本支自验收为 `passed`，允许非快进合并 `develop`。M4 合并后从最新 `develop` 创建 M5 第一支 `feature/ui-provider-management-wiring`，只接通官方/自定义入口、凭证、验证、模型发现和启停，并只消费已合并安全 DTO 与管理端口；不得访问真实服务商、读取真实凭证、产生收费调用或启动阶段 10。

M5 第一支 `feature/ui-provider-management-wiring` 已从 `develop@957e710` 建立，实现提交为 `8d845a9`。该支把 Provider IPC、preload 和供应商页面统一接到 `ProviderManagementFramework`：页面由 Package Template 驱动官方/兼容连接、Base URL 模式和结构化 CredentialSchema 字段，提供连接创建、凭证轮换、验证、目录同步、精确模型登记、连接/模型启停和本地软删除；renderer 不读取或回显凭证，不按服务商名、模型名、协议或 Usage 路径分支。

Electron 组合 DeepSeek、Volcengine、Kling、NewAPI、Vidu 五个精确 Package，但在线管理 Adapter Registry 明确为空；验证与目录同步安全投影为等待真实 API 专项批准并在 UI 禁用。Registry DTO 增加 Package/Template ownership、活动 Profile 状态和 ProductFeature 安全投影。Vidu 流程 8 收费验证启动入口已从 renderer、preload 和 Provider IPC 公共面移除，历史内部关闭控制器不重新授权。

完整门禁为 Node 179 项与 Vitest 562 项，共 741 项通过，0 失败、0 跳过；TypeScript、ESLint、生产构建、280 文件平台审计、50 项交接校验、27 个权威资源、恢复审计、运行时集成、安全存储、阶段 9 关闭门禁和差异检查全部通过。浏览器可见检查覆盖 `1440x900` 与 Electron 最小窗口 `1080x720`，无横向溢出或元素重叠；Windows 生产 Electron 隔离烟测新增 4 个进程、4/4 响应、1 个可见窗口，正常关闭后残留 0，隔离目录已移入回收站。真实服务商 HTTP/DNS 0 次、真实凭证读取/验证 0 次、收费调用 0 次、费用 0；macOS 保持 `not_run/deferred`，阶段 10 未启动。工程记录见：

    docs/active/多服务商功能路由-M5-供应商管理UI接线记录.md

本支自验收为 `passed`，允许非快进合并 `develop`。合并后从最新 `develop` 创建 M5 第二支 `feature/ui-conversation-context-wiring`，只接通对话、项目上下文、候选选择令牌和文本提交/流式端口；不得把对话页改成图片或视频直接生成入口，不得访问真实服务商、真实凭证、收费调用或启动阶段 10。

M5 第二支 `feature/ui-conversation-context-wiring` 已从 `develop@82ca9c4` 建立，实现提交为 `4e55567`。该支把对话页接到项目范围 Conversation、不可变 ProjectContext 快照、文本候选选择令牌、外发确认、文本提交、流式事件重放、取消和恢复读取端口；应用级旧对话保持只读，可将符合条件的已完成纯文本消息以完整副本单次原子导入当前项目，原记录不变。

候选只由精确 Package/Profile、Feature Contract、ParameterSchema 和 RuntimeAccessPolicy 生成；renderer 不传 projectId、内部 RouteSnapshot、Package/Adapter、Endpoint、凭证、Prompt、路径、Hash 或远端 operation，不按服务商名、模型名、协议或 Usage 路径分支。对话页没有图片/视频生成入口，只有显式勾选并读取固定 revision 的 ProjectContext 才进入本次文本外发快照。

完整门禁为 Node 179 项与 Vitest 563 项，共 742 项通过，0 失败、0 跳过；TypeScript、ESLint、生产构建、282 文件平台审计、50 项交接校验、27 个权威资源、恢复审计、运行时集成、安全存储、阶段 9 关闭门禁和差异检查全部通过。浏览器 `1440x900` 可见检查无横向溢出、裁切、重叠或控制台告警；Windows 生产 Electron 隔离烟测在 `1080x720` 新增 4 个进程、4/4 响应、1 个可见窗口，正常关闭后残留 0，隔离目录已移入回收站。真实服务商 HTTP/DNS 0 次、真实凭证读取/验证 0 次、收费调用 0 次、费用 0；macOS 保持 `not_run/deferred`，阶段 10 未启动。工程记录见：

    docs/active/多服务商功能路由-M5-对话与上下文UI接线记录.md

本支自验收为 `passed`，允许非快进合并 `develop`。合并后从最新 `develop` 创建 M5 第三支 `feature/ui-image-feature-wiring`；快速生图固定为纯文生图，不接收参考图或其他参考素材，只消费已合并安全 DTO 与提交端口，不访问真实服务商、真实凭证、收费调用或阶段 10。

M5 第三支 `feature/ui-image-feature-wiring` 已从 `develop@bc91fda` 建立，实现提交为 `1ed2772`。该支把快速生图和专业生图接到安全图片候选、动态 `ParameterSchema`、固定草稿 revision、一次性路由选择令牌、外发确认和受控提交端口；快速生图固定为纯文生图，旧带图或上下文草稿只能显式迁移到专业生图，专业页显式区分文生图和恰好单图的图生图，并只接受固定 revision 的 ProjectContext。

权威最小窗口同步从旧 `1080x720` 落实为 `800x720`，紧凑标题栏、导航和图片页单列布局无横向溢出。完整门禁为 Node 185 项与 Vitest 571 项，共 756 项通过，0 失败、0 跳过；TypeScript、ESLint、生产构建、平台审计、交接包校验、恢复审计、阶段 9 关闭门禁、安全存储、运行时集成和差异检查通过。浏览器 `1440x900`、`800x720` 无横向溢出或控件重叠，控制台 0 警告、0 错误；Windows Electron 隔离烟测 4/4 响应、1 个可见窗口、正常关闭残留 0。工程记录见：

    docs/active/多服务商功能路由-M5-图片功能UI接线记录.md

本支自验收为 `passed`，允许非快进合并 `develop`。合并后从最新 `develop` 创建 M5 第四支 `feature/ui-video-feature-wiring`；快速视频固定为纯文生视频，不接收参考图片、参考视频或其他参考素材，只消费已合并安全 DTO、异步恢复与提交端口，不访问真实服务商、真实凭证、收费调用或阶段 10。

M5 第四支 `feature/ui-video-feature-wiring` 已从 `develop@b23675b` 建立，实现提交为 `574eafc`。该支把快速视频、文生视频和图生视频接到安全视频候选、动态 `ParameterSchema`、固定草稿 revision、一次性路由选择令牌、外发确认和受控提交端口；快速视频固定为纯文生视频且无素材/上下文入口，文生视频只接受固定 revision 的 ProjectContext，图生视频只接受恰好一张受控图片。旧草稿必须显式迁移或清理，不静默切换功能或丢弃历史输入。

Electron 只注册现有 Vidu 包中合同完整的 `image_to_video` Schema；Seedance、Kling、NewAPI 和 `text_to_video` 缺少精确动态 Schema 时保持无候选，不伪造能力。完整门禁为 Node 188 项与 Vitest 581 项，共 769 项通过，0 失败、0 跳过；TypeScript、ESLint、生产构建、290 文件平台审计、50 项交接校验、27 个权威资源、恢复审计、运行时集成、安全存储、阶段 9 关闭门禁和差异检查全部通过。浏览器 `1440x900`、`800x720` 无横向溢出、控件重叠或文字裁切，零尺寸可用控件为 0，控制台 0 警告、0 错误；Windows Electron 隔离烟测 4/4 响应、1 个可见窗口、正常关闭残留 0、错误日志为空。真实服务商 HTTP/DNS 0 次、真实凭证读取/验证 0 次、收费调用 0 次、费用 0。工程记录见：

    docs/active/多服务商功能路由-M5-视频功能UI接线记录.md

本支自验收为 `passed`，允许非快进合并 `develop`。合并后从最新 `develop` 创建 M5 第五支 `feature/ui-task-call-records-wiring`；只把任务中心接到已合并的安全调用读模型、状态、时间线、用量完整性和本地结果事实，不公开 RouteSnapshot、Endpoint、凭证、Prompt、远端 operation、签名 URL、绝对路径、Hash 或原始响应，不访问真实服务商、真实凭证、收费调用或阶段 10。

M5 第五支 `feature/ui-task-call-records-wiring` 已从 `develop@f1ec7e8` 建立，实现提交为 `b7db775`。该支在任务中心保留原本地任务视图并新增调用记录分段，接通项目、功能、服务商、连接、模型、状态和日期筛选，以及安全调用列表与详情、脱敏时间线、总耗时、重试归属、用量完整性和本地结果事实；renderer 不接收 RouteSnapshot、Endpoint、凭证、Prompt、远端 operation、签名 URL、绝对路径、Hash 或原始响应。

完整门禁为 Node 192 项与 Vitest 581 项，共 773 项通过，0 失败、0 跳过；TypeScript、ESLint、生产构建、291 文件平台审计、50 项交接校验、27 个权威资源、恢复审计、阶段 9 关闭门禁、安全存储、运行时集成和差异检查全部通过。浏览器 `1440x900`、`800x720` 无横向溢出、控件重叠或文字裁切，零尺寸可用控件为 0，控制台 0 警告、0 错误；Windows Electron 隔离烟测 4/4 响应、1 个可见窗口、正常关闭残留 0、错误日志为空。真实服务商 HTTP/DNS 0 次、真实凭证读取/验证 0 次、收费调用 0 次、费用 0。工程记录见：

    docs/active/多服务商功能路由-M5-任务调用记录UI接线记录.md

本支自验收为 `passed`，允许非快进合并 `develop`。合并后从最新 `develop` 创建 M5 第六支 `feature/ui-provider-acceptance-closeout`；只做多服务商 UI 的响应式、逐按钮、安全边界、Electron 可见窗口和完整回归收口，不新增后台能力、真实服务商联网、真实凭证读取/验证、收费调用、macOS 实机与媒体工具链或阶段 10。

M5 第六支 `feature/ui-provider-acceptance-closeout` 已从 `develop@61fe3c1` 建立，实现提交为 `5a29edd`。该支完成服务商、对话、图片五页、视频四页、任务与调用记录的最终 UI 验收，并把空状态添加、创建项目对话、保存图片草稿和保存编辑草稿调整为次级操作，保留真正提交或导出为唯一主操作；快速生图与快速视频的空状态说明同步固定为纯文本输入，不再引导参考素材。

深浅主题与 `800x720`、`960x720`、`1280x820`、`1440x900`、`1920x1080` 五档窗口共 130 个组合，无页面/容器横向溢出、按钮重叠、单行文字裁切、零尺寸可用控件或多主操作问题。完整门禁为 Node 195 项与 Vitest 581 项，共 776 项通过，0 失败、0 跳过；TypeScript、ESLint、生产构建、291 文件平台审计、50 项交接校验、27 个权威资源、恢复审计、阶段 9 关闭门禁、安全存储、运行时集成和差异检查全部通过。

Windows Electron 首轮已满足 4/4 响应、1 个窗口和残留 0，但关闭瞬间出现两条 Chromium GPU command-buffer 日志，未计为通过；延长稳定时间后重试为 4/4 响应、1 个可见窗口、正常关闭残留 0、错误日志为空。该硬件加速瞬时日志未阻断软件导出。真实服务商 HTTP/DNS 0 次、真实凭证读取/验证 0 次、收费调用 0 次、费用 0。工程记录见：

    docs/active/多服务商功能路由-M5-UI验收收口记录.md

M5 自验收为 `passed`，允许非快进合并 `develop`。合并后从最新 `develop` 创建 M6 单独收口分支 `feature/provider-routing-optimization-closeout`，只执行完整回归、证据汇总、计划状态和阶段 10 前停止边界；不新增业务能力、真实服务商联网、真实凭证读取/验证、收费调用、macOS 实机与媒体工具链或阶段 10。

M6 `feature/provider-routing-optimization-closeout` 已从 `develop@24dcb9b` 建立，证据提交为 `254db45`。该支没有修改业务代码，只完成 M1—M5 合并树的最终统一回归、分支保留审计、安全与费用边界、Windows Electron 捕获式烟测和机器可读证据。

最终门禁为 Node 195 项与 Vitest 581 项，共 776 项通过，0 失败、0 跳过；TypeScript、ESLint、生产构建、291 文件平台审计、50 项交接校验、27 个权威资源、恢复审计、阶段 9 关闭门禁、安全存储、运行时集成和差异检查全部通过。M5 深浅主题与五档窗口共 130 个 UI 组合继续有效。最终 Electron 隔离烟测 4/4 响应、1 个可见窗口、显式 stdout/stderr 捕获为空、正常关闭残留 0、仓库制品 0。

计划内 M1—M5 共 27 个功能分支本地与远程均为 27/27。M5 首轮 GPU 关闭日志和 M6 早期继承 stderr/TLS 临时文件均已记录并解决；最终证据不包含未解释失败或跳过。真实服务商 HTTP/DNS 0 次、真实凭证读取/验证 0 次、收费调用 0 次、费用 0。证据与记录见：

    docs/active/evidence/provider-routing/m6-closeout.json
    docs/active/evidence/provider-routing/m6-closeout-summary.md
    docs/active/多服务商功能路由-M6-优化收口记录.md

M0—M6 在批准边界内全部完成，M6 自验收为 `passed`，允许非快进合并 `develop`。合并后停止在阶段 10 准入前；阶段 10、真实 API 专项、macOS 实机与媒体工具链扩展均未启动，后续必须由项目负责人单独批准。

M6 已通过 `a0c75d8` 非快进合并并推送 `develop`，`feature/provider-routing-optimization-closeout` 本地与远程分支继续保留。多服务商功能路由 M0—M6 至此正式完成；当前停止在阶段 10 准入前，没有自动启动阶段 10 或任何真实 API、macOS 实机与媒体工具链扩展工作。

## 服务商优化专项｜服务商画廊与连接编排（2026-08-05 启动）

项目负责人于 2026-08-05 启动服务商优化专项，批准《服务商画廊与连接编排分阶段实施计划》并授权 Codex 直接连续托管 PR 1—PR 4 全部实施（PR 5 可选，收口时决定）；声明该计划为最高权威、不受计划外限制，计划自含的联网与数据安全闸门、停止条件继续有效。

计划文档：

    docs/active/服务商画廊与连接编排分阶段实施计划.md

产品决策要点：模型与服务商页改为画廊首屏（只展示真实适配供应商 + 自定义兼容入口 + 求适配卡）；保存连接改为主进程自动编排（测连通 → 落库 → 自动拉目录），验证失败可强制保存为不可用；目录按供应商能力自动拉取或手动登记，手动登记对所有已验证连接开放；模型一律声明态未启用；管理视图默认隐藏已删除墓碑；Vidu 随 PR 4 拉平为普通供应商，创作路由动态化，冻结种子与联调脚手架退役。

代码量目标：以 src 85,630 行（2026-08-05 实测）为基线，PR 1—3 新增约 2,500 行，PR 4—5 收回 4,500—7,000 行，收口时净量不高于基线。

执行记录：

- 2026-08-05：PR 1 `feature/provider-connection-orchestration` 启动。
- 2026-08-05：PR 1 实现完成，实现提交 `9e68629`。保存连接改为主进程自动编排（瞬态草稿探针验证 → 落库 → 目录类模板自动同步），验证失败零落盘并可确认后强制保存为不可用；NewAPI 与 DeepSeek 既有管理适配器完成生产装配（Electron `net.fetch` 传输层）；手动登记对所有已验证连接开放。门禁为 Node 195 项与 Vitest 588 项，共 783 项通过，0 失败、0 跳过；TypeScript、ESLint、生产构建、平台审计、交接校验、恢复审计、差异检查全部通过；Windows Electron 烟测窗口正常、优雅关闭、残留 0、日志为空。真实服务商 HTTP/DNS 0 次、真实凭证读取/验证 0 次、收费调用 0 次、费用 0。工程记录见：

    docs/active/服务商画廊与连接编排-PR1-连接编排管线记录.md

- 2026-08-05：PR 2 `feature/provider-gallery-ui` 实现完成。模型与服务商页改为画廊首屏 + 管理视图双视图：`ProvidersPage` 拆为壳组件与 `ProviderGalleryView`、`ProviderManageView`、`provider-page-shared`；画廊按模板动态渲染卡片（状态角标、能力标签、验证标签）与求适配卡，无写死供应商名；添加连接表单由卡片触发、模板预选固定、保存走 PR 1 编排管线；管理视图默认隐藏已删除墓碑并提供显式开关。一并提交 PR 1 遗留的编排测试导入修正（原修复未提交，`develop` 上 typecheck 必挂）。门禁为 Node 195 项与 Vitest 588 项，共 783 项通过，0 失败、0 跳过；TypeScript、ESLint、生产构建、平台审计、交接校验、恢复审计、差异检查全部通过；窗口档 640/768/1024/1280/1600 画廊列数 1/2/2/3/5、零新增横向溢出，深浅主题 × 双视图截图核验干净；生产 Electron 烟测 4/4 响应、优雅关闭、残留 0、日志为空。真实服务商 HTTP/DNS 0 次、真实凭证读取/验证 0 次、收费调用 0 次、费用 0。工程记录见：

    docs/active/服务商画廊与连接编排-PR2-服务商画廊UI记录.md

- 2026-08-05：PR 3 `feature/provider-management-probes-expansion` 实现完成。可灵管理探针落地：凭证模式由单一 `api_key` 升级为 AccessKey + SecretKey 双字段（`credential.kling.ak-sk`），主进程内 HMAC-SHA256 即时铸造 JWT（`iss`/`exp`/`nbf`），新增官方免费账户探针 `GET /v1/account/costs` 与 `KlingManagementAdapter` 错误映射（1000/1001/1002 与 HTTP 401 → 凭证无效；1102 → 凭证有效但账户不可用），并完成生产装配（`ElectronKlingHttpTransport`）；火山引擎 ARK 定案保持 `deferred`（控制面 `ListFoundationModels` 需 AK/SK HMAC，与模板 API Key 不兼容，推理端点无免费模型列表）；Vidu `deferred` 策略钉住（预算已用尽，验证不得触发生成接口）。新增 `kling-management-probe`（9 项）与 `provider-probe-decisions`（3 项决策钉住）测试，IPC 合同测试补管理适配器组合断言。门禁为 Node 200 项与 Vitest 601 项，共 801 项通过，0 失败、0 跳过；TypeScript、ESLint、生产构建、平台审计、交接校验、恢复审计、差异检查全部通过；生产 Electron 烟测 4/4 响应、优雅关闭退出码 0、残留 0、日志为空。真实服务商 HTTP/DNS 0 次、真实凭证读取/验证 0 次、收费调用 0 次、费用 0。工程记录见：

    docs/active/服务商画廊与连接编排-PR3-管理探针扩展记录.md

- 2026-08-05：PR 4 `feature/provider-dynamic-routing` 实现完成。创作路由动态化落地：`ViduReferenceVideoV2Adapter` 由写死绑定/连接改为 `ViduVideoOperationContextPort`（提交记忆 + 单候选注册表回退，多连接绝不猜测）；运行时授权台账正式接管创作候选资格——`ProviderManagementFramework` 在添加/验证/启停/删除连接后尽力同步策略（`available` → `interactive_allowed`，其余 → `blocked`），启动时 `reconcileConnections` 对存量连接全量对账，`storage-ipc` 与 `chat-context-runtime` 的候选源由永远拒绝桩改为真台账（缺省 fail-closed）。冻结资产退役：删除 `vidu-protocol-catalog.ts`、Vidu live-validation 四件套、运行时授权硬封锁与 `ensureFrozenViduCatalog` 播种；`emptySnapshot` 返回真正空注册表，全新安装零预置。老数据迁移语义钉住：既有用户 Vidu 行原样保留、凭证引用不动、绝不补种缺失行。测试迁移至 `tests/fixtures/vidu-user-registry.ts` 夹具；布线合同断言由硬封锁改为台账门控。门禁为 Node 200 项与 Vitest 593 项，共 793 项通过，0 失败、0 跳过；TypeScript（含 electron）、ESLint、生产构建全部通过；生产 Electron 烟测全新 userData 启动响应、优雅关闭、日志 0 错误行、不创建注册表文件、无冻结行。真实服务商 HTTP 0 次、真实凭证 0 次、收费调用 0 次、费用 0。工程记录见：

    docs/active/服务商画廊与连接编排-PR4-创作路由动态化记录.md

- 2026-08-05：画廊增补 UniCompAPI 官方卡（`feature/unicompapi-official-card`，合并 `46e24fa`）。项目负责人定案：UniCompAPI 本质为 OpenAI 兼容接口，卡片名独立、baseURL 固定预置 `https://unicompapi.com/v1` 不需用户填写，其余与 OpenAI Compatible 完全一致。落地方式：新增 `provider-package-unicompapi` 包描述符（`kind: 'official'` + `baseUrlMode: 'fixed'`，端点政策 `fixedBaseUrl` 钉死、仅 https/443/`/v1`、禁环回与内网），凭证为单一 `api_key`，复用 NewAPI 三个适配器描述与全部能力；`NewApiManagementAdapter` 身份改为可按包参数化，主进程以同一运行时为 newapi 与 unicompapi 各注册一个管理端口，验证与目录发现探针完全同构；添加表单因 `fixed` 模式自动隐藏接口地址。探针决策测试钉住：模板动作 `available`/`catalog_available`、编排添加端点固定、目录同步、端点覆盖被拒（`invalid_request`）。门禁 Node + Vitest 共 594 项通过、0 失败、0 跳过；TypeScript、ESLint、清洁生产构建全部通过；真实服务商 HTTP 0 次、真实凭证 0 次、收费调用 0 次、费用 0。

- 2026-08-11：`feature/qwen-image-edit-selection` 按项目负责人最新决策，将 `qwen-image-edit-2509` 从历史 `image_edit` / `/v1/images/edits` 调整为 `reference_to_image` / `/v1/images/generations`。类型检查、ESLint、生产构建、领域与平台 Vitest 640 项、图片 UI 17 项通过；统一 `pnpm test` 仍被既有 `tests/ui/video-workspace-ipc-contract.test.mjs` 阻断，该测试继续要求 Unicode 媒体协议修复已移除的 `headers: request.headers`，与本次 UniCompAPI 图片路由改动无关，待单独修正测试合同。

- 2026-08-12：`feature/fix-newapi-reference-image-request-size` 修复 UniCompAPI/NewAPI 图生图在发送前被遗留 2 MiB JSON 上限拦截的问题。素材层仍保持单图 15 MiB；图像适配器与共享运行时统一使用 24 MiB 序列化请求预算，覆盖 15 MiB 原图转换成约 20 MiB Base64 后的数据 URL、最长提示词及 JSON 开销，聊天与视频预算不变。请求超限文案改为共享稳定常量，编排层继续通过精确白名单映射为 `newapi.request_too_large`。回归测试覆盖完整 15 MiB 参考图进入合成传输、超过预算时零 HTTP 请求，以及具体安全错误码传播。目标测试 40 项、全量 Node/UI 253 项与 Vitest 661 项共 914 项通过，0 失败、0 跳过；TypeScript、ESLint、生产构建与 `git diff --check` 通过。真实服务商 HTTP/DNS 0 次、真实凭证读取/验证 0 次、收费调用 0 次、费用 0；真实 UniCompAPI 网关接收上限仍需在获批的非收费验证中确认，阶段 10 与 macOS 延期边界不变。

- 2026-08-12：`feature/windows-packaging-baseline` 新增 Electron Builder Windows x64 NSIS 打包命令 `pnpm package:win` 与目录烟测命令 `pnpm package:win:dir`。配置只纳入 `dist`、`dist-electron` 和运行所需生产依赖，明确排除 `.tools`、测试、文档与本地运行数据；当前生成未签名安装包，未启用自动更新、公证或生产媒体组件分发。阶段 10 的签名、安装升级、生产 FFmpeg 分发、SBOM 与正式发布准入仍未宣称完成。

- 2026-08-13：`feature/remove-outbound-reconfirmation` 修复专业生图第一次成功后第二次生成持续卡在“正在自动保存”的竞态。父工作台自动保存改用真实编辑 revision 判断请求是否被新输入取代，不再把保存结果造成的草稿对象引用变化误判为新编辑；专业生图候选读取在父工作台保存完成后启动，图片与视频候选 effect 均通过 ref 使用最新回调，避免父组件内联回调变更反复取消读取。新增 UI 合同钉住自动保存依赖和回调稳定性。目标 Node/UI 27 项、图片领域与控制器 Vitest 19 项通过；全量 Node/UI 254 项与 Vitest 662 项，共 916 项通过，0 失败、0 跳过；TypeScript、ESLint、生产构建与 `git diff --check` 通过。未执行真实服务商第二次收费生成；当前会话没有可用的 Electron 浏览器控制运行时，仍需在现有开发窗口人工连续生成两次，确认第二次恢复为“已自动保存”、模型候选可选且生成按钮启用。阶段 10 与 macOS 延期边界不变。

- 2026-08-13：修复 Windows 中文项目路径下展示本地生成结果时的 Electron 主进程 ByteString 崩溃。根因不是 API Key：旧 `unicomp-media` 协议通过 `net.fetch(file://...)` 读取本地文件，Chromium 会先为中文文件名构造含非 ASCII 字符的 `Content-Disposition`，异常发生在代码过滤响应头之前。协议现改为 Node 文件流直接响应，仅设置经约束的 `content-type` 与数字 `content-length`，不再经过 `file://` 网络栈。新增“中文项目/自动生成图片.png”真实流测试并更新图片、视频协议合同。全量 Node/UI 254 项与 Vitest 664 项，共 918 项通过，0 失败、0 跳过；TypeScript、ESLint、生产构建与 `git diff --check` 通过。现有 Electron 主进程必须完整退出后重启才能加载修复；未产生真实服务商请求或费用，阶段 10 与 macOS 延期边界不变。

- 2026-08-13：`feature/fix-unicode-image-download-headers` 补全 Electron 主进程 ByteString 崩溃修复。前一项只覆盖本地作品预览；应用完整重启后复现及本地时间线确认，剩余异常发生在远端生成已完成、结果下载尚未登记为本地作品时。服务商下载响应可能携带 `Content-Disposition: attachment; filename="自动生成图片.png"` 或中文视频文件名，旧 `net.fetch` 会在业务代码读取或过滤响应头之前将全部响应头转换为 Web `Headers`，非 Latin-1 文件名因此触发 ByteString 转换异常。图片结果与 UniCompAPI/NewAPI 视频内容下载现统一改用 Electron `net.request` 原生响应流，仅消费状态码、ASCII 安全的 `content-type`/`content-length`/`retry-after` 与正文，不读取或转发 `Content-Disposition`；继续保持凭证只进入受控请求头、禁止重定向、取消和响应体大小上限。真实 Seedance 执行 `execution-video-368d50f4-2bca-4caa-b09d-e94ba15c4fc1` 已证明远端任务成功并轮询完成，最终在 `downloading` 失败；同一 `newapi.video` 下 Vidu 与 HappyHorse 成功的差异来自下载响应头，而非 API Key 或提交/轮询协议。任务中心新增严格受控的“重新接收结果”：仅当前打开项目中已有远端任务 ID、NewAPI 视频原路由完整、失败阶段为 `downloading` 且 `retryable` 的执行可复用原远端结果，绝不创建新执行或重新提交收费生成；恢复后仍需通过视频检查、哈希校验、作品登记与本地结果事实落盘。新增原生图片/视频下载、状态机、控制器、读模型与 UI/IPC 合同测试。全量 Node/UI 258 项与 Vitest 669 项，共 927 项通过，0 失败、0 跳过；TypeScript、ESLint、生产构建与 `git diff --check` 通过。浏览器真实渲染核验覆盖 `1440x900` 与最小窗口 `800x720`，无横向溢出、重叠或裁切；浏览器环境不连接 Electron 项目数据，故仅核验布局，真实按钮资格由主进程读模型验证。未执行新的真实收费生成，也未自动点击恢复按钮访问远端视频；修复加载要求完整退出并重启 Electron，阶段 10 与 macOS 延期边界不变。

- 2026-08-13：同一分支补齐图片结果的受控恢复。图片在远端已 `completed_sync`、本地失败阶段为 `downloading` 且错误明确为 `retryable` 时，任务中心显示“重新接收结果”；读模型额外核对当前打开项目、原 provider operation record 的任务/执行归属、媒体类型和同步完成结果，记录缺失或损坏时不开放按钮。恢复复用同一 task、execution 与持久化 URL/Base64 结果引用，不调用 `submitDraft`、不创建新 execution、不会重复收费；接收后仍执行图片类型检查、大小限制、哈希验证、原子落盘和 Work 登记。新增跨 runtime 重建的本地持久化闭环测试，证明应用重启后仍可从原结果记录完成恢复；下载端口的明确重试性现会保留到 execution failure。全量 Node/UI 258 项与 Vitest 673 项，共 931 项通过，0 失败、0 跳过；TypeScript、ESLint、生产构建与 `git diff --check` 通过。浏览器真实 React 渲染核验覆盖 `1440x900` 与 `800x720`，无横向溢出且可见按钮零尺寸为 0；浏览器不连接 Electron 项目数据，按钮资格与点击闭环由主进程/持久化测试验证。未执行真实服务商请求、真实图片恢复或收费生成，阶段 10 与 macOS 延期边界不变。

- 2026-08-18：`feature/image-generation-preview-loading` 为专业生图页右侧“本地作品预览”增加真实生成过程加载态。共享 `GenerationResultPreview` 新增可选的阶段文案、进度环、呼吸光、扫描线和完成淡入；专业生图只在 `preparing`、`requesting`、`waiting` 真实状态传入加载态，未加入虚假百分比，也未改变本地文件校验、作品登记或远端结果回退逻辑。新增 `prefers-reduced-motion` 处理，固定预览画布最小高度以避免生成期间布局跳动。Node 265 项与 Vitest 720 项通过，Vitest 5 项既有媒体条件测试跳过；TypeScript、ESLint、生产构建和 `git diff --check` 通过。浏览器本地夹具在 `1440x900` 与 `800x720` 核验进度环、呼吸光、扫描线可见且无横向溢出；由于浏览器环境未连接 Electron 项目数据，未执行真实生成、真实服务商请求或收费调用。工程记录见 `docs/active/图片生成预览加载效果记录.md`；阶段 10、macOS 实机与媒体工具链边界不变。

- 2026-08-19：`feature/workspace-autosave-hardening` 按项目负责人确认的企业级方案完成创作草稿自动保存重构。图片快速/专业生图、快速视频/文生视频/图生视频统一使用 1 秒尾部防抖、单 `inFlight` + 单 latest-only `pending`、成功 ACK rebasing、1/2/4/8/8 秒重试、真实冲突停机与重新载入/另存为恢复；生成、提示词增强、草稿切换和窗口关闭前调用 `flush()`，关闭最多等待 3 秒。提交面板移除旧的自行保存路径，新增 `AutosaveStatus` 和脱敏 `autosave.log` 诊断通道，诊断 IPC 严格拒绝 prompt、路径、参数、Token 及未知字段。应用层 10 项与 Node/UI 295 项通过；Vitest 全量并发运行有 5 个既有重型持久化/服务商测试因资源争用触发 5 秒超时，逐文件串行复跑 28 项全部通过；TypeScript、ESLint、生产构建和 `git diff --check` 通过。浏览器 1280×720 图片/视频页无横向溢出、控制台 0 warning/0 error；Windows Electron 单实例真实验收证明 100 次输入最终只保存最新状态，延迟保存期间仅 2 次请求且最大并发 1，`%APPDATA%\\unicomp-desktop\\logs\\autosave.log` 仅含安全元数据，关闭后残留 0。未调用真实服务商、未读取凭证、未产生收费请求；阶段 10、macOS 实机与媒体工具链边界不变。工程记录见 `docs/active/阶段9-自动保存竞态治理记录.md`。

- 2026-08-21：`feature/remove-text-video-shot-ui` 按项目负责人确认的紧凑布局移除文生视频镜头功能 UI。文生视频输入区收敛为“视频创意”，删除镜头新增、编辑、删除处理与镜头列表组件；快速生图、专业生图、快速视频、文生视频、图生视频的双栏工作台统一延伸至底部项目状态栏上方，填满旧高度上限与悬浮状态栏布局遗留的页面空白，卡片内部控件、模型选择、动态参数、提交面板、生成历史及本地作品校验保持不变。快速视频与图生视频底部重复的“调用记录”提示卡一并删除，任务中心正式调用记录功能和底部项目状态栏保留。领域 DTO 与存量草稿的 `shots`、`storyboard` 字段保留兼容，不执行破坏性迁移。定向 Node/UI 20 项通过；全量 Node/UI/工具链 308 项与 Vitest 745 项，共 1053 项通过，0 失败、0 跳过；TypeScript、ESLint、生产构建与 `git diff --check` 通过。实际 React 页面烟测确认镜头控件零命中、服务与动态能力区域保留、横向溢出 0、控制台 0 warning/0 error。未调用真实服务商、未读取凭证、未产生收费请求；阶段 10、macOS 实机与媒体工具链边界不变。工程记录见 `docs/active/文生视频镜头UI移除记录.md`。

- 2026-08-21：`feature/fix-qwen-image-required-size` 修复 `qwen-image` 快速生图请求缺少 `size`。根因是上游必填参数在本地契约中被声明为可选，进入快速页面的 `required_only` 候选投影后被移除。现将 `size` 改为用户必填并把 schema revision 升至 3；快速生图自动采用候选首个合法尺寸，专业生图继续显示尺寸选择，适配器继续按 `<width>x<height>` 序列化。新增快速候选投影与契约回归测试；未调用真实服务商、未读取凭证、未产生收费请求。工程记录见 `docs/active/2026-08-21-Qwen-Image必填尺寸修复记录.md`。
2026-08-24 工程补充：`feature/word-document-content-rendering` 完成对话页 Word 内容与排版修复，并追加修复数组 JSON 失败关闭、请求校验前去重、顺序重复生成、不同生成选项误合并、失败码执行隔离、错误信息脱敏和独立编号列表实例。应用测试 22/22、平台测试 681/681（5 skipped）、UI 合同 5/5、类型检查、lint、生产构建和完整 `pnpm test` 均通过；完整测试为 826 passed、5 skipped。合成 DOCX XML 检查确认无 JSON 标记；LibreOffice/WPS 视觉验收因环境工具错误未完成。记录见 `docs/active/对话内Office文档生成-Word内容与排版修复验收记录.md`。未调用真实 Provider、未读取凭证、未提交或推送。

2026-08-27 工程补充：`feature/ppt-quality-layouts-current` 完成对话内 PPT 质量优化的代码与自动化收口。新增工作汇报、自然简约、极简商务、科技风、融资演讲稿五套原创本地模板；PPT 提示词改为结论、解释和行动结构；平台层以单一渲染器完成固定 16:9、语义布局、无截断续页、宽表行列续页、图表/表格专用版式和实际最多 40 页资源门禁。IPC 只接受精确模板枚举和字段白名单，Runner 增加临时文件、OOXML/大小/Hash 复验、原子发布、取消、回滚和脱敏日志。交付自验收发现并按 RED→GREEN 修复“选择 PPT 后隐藏文档类型、无法切回 Word/Excel”的 UI 回归；PPT 继续只隐藏无效旧主题。本轮交付前重新验证：PPT 定向 7 个文件、87 项通过，全量 147 个文件、873 项通过，UI 合同 34/34 与聊天文档合同 12/12 通过，类型检查、ESLint、生产构建和差异检查通过；五份最终样例均为有效 OOXML、8 页、固定 16:9，文本总量约 1354—1366 字符。真实 Electron 成功启动，可访问树完整；Renderer 在 `800×720` 与 `1440×900` 无横向溢出，关键控件可见；结束后仓库开发进程、5173 监听和本轮 PowerPoint 进程均为 0。此前五份样例均由 PowerPoint 成功打开并识别为 8 页，但 PowerPoint 对任意原生表格页（包括参考 PPTX）自动导出 PNG/PDF 的本机故障仍存在；五模板真实生成交互、键盘完整路径、取消/重复点击、作品登记、WPS、真实 Provider、打包、提交与推送仍未验证或未执行，不能据此宣称产品验收或发布完成。验收记录见 `docs/active/对话内Office文档生成-PPT质量优化验收记录.md`。

2026-08-27 阶段性诊断记录：真实 `kimi-k3` 会话失败根因为模型大纲 JSON 的表格行缺少开头 `[`，在 PPT Runner 执行前返回 `invalid_outline`；同类提示词另一会话输出合法，确认是跨模型都可能出现的结构化输出非确定性。该阶段曾实现 Renderer 最多追加一次模型修正，但随后按负责人要求和 Application owner 边界完成最终纠偏，已删除此二次调用路径；最终行为以下一条“最终纠偏与自验收”为准。PPT 模板输入框内上拉选择、自动匹配和五模板 IPC 枚举继续保留。阶段性门禁为全量 147 文件、877 项通过；不作为最终证据。

2026-08-27 最终纠偏与自验收：撤销 Renderer “第二次模型修正”方案，将文档业务编排上移到 `src/application/document-generation-service.ts`。一次模型响应后由 Application 等待终态、严格编译并在 PPT 结构错误时调用 Platform 本地恢复；缺逗号、长标题、长结论、详细内容组和长行动项可从同一响应恢复，不追加 Provider 调用。Platform Controller 改薄，Renderer 只提交意图并展示用户原始 `displayContent`，不显示内部 prompt 或 assistant JSON。长行动项最多按 240 字集中为一页，避免拆成稀疏大字页。最终新鲜门禁为 148 个测试文件、886 项通过，typecheck、lint、build、`git diff --check` 通过；五模板共 40 页和异常恢复样例 5 页均由 PowerPoint 原生导出逐页检查，固定 16:9、Canvas 越界 0、无实际裁切或非预期重叠。真实 Electron 窗口文本可访问树可读取，但本机图形捕获和按元素点击驱动不可用；真实多模型、上拉菜单实点、取消/重复点击、WPS、打包、暂存、提交与推送仍未执行或未验证。

2026-08-28 工程补充：按负责人最终审核决定，Office 后续修改统一覆盖 Word/Excel/PPT，并由 Application 结合当前对话文档顺序自动返回精确 `targetMessageId`；明确文件名/格式优先，省略表达默认最近 Office 结果，同类型默认最新，“不是这个，改前一个”向前选择，“重新做一份”保持新建。Renderer 删除“新建/修改上一版/Office 操作预览”常驻条，高置信度路径只保留既有进度、取消和最终文档卡；成功提示说明基于哪份原文件且原文件保留。项目上下文从 system 降为带不可信资料边界的 user 消息，不增加模型调用。PPT 删除模板展示名称，普通文本续页取消机械“续 N”，4+1 孤页重平衡为 3+2，五模板继续复用单一生成器和已有差异化 frame/composition。定向 Application/Provider/PPT 37/37、UI 13/13、失败文件隔离复跑 40/40、typecheck、lint、build 通过；默认 `pnpm test` 两次分别 896/900、898/900，剩余均为全量并行下既有 5 秒文件 I/O/文档生成超时，故不声明全量门禁通过。实际 Vite Renderer 确认旧常驻条消失；真实 Electron 捕获仍被 `0x80004002` 阻断。未调用真实 Provider、未读取凭证、未打包、未暂存、未提交或推送；记录见 `docs/active/对话内Office文档生成-PPT质量优化验收记录.md`。

2026-08-28 Office 便利性与终态修复补充：Application 现将自然表格创建硬路由到 Excel，显式 Word/PPT 优先于内容中的“表格”，未明确格式的 Office 成果请求使用固定默认推断而不阻断确认；Word/Excel/PPT 统一做轻微 JSON 本地恢复，Excel 支持常见 `columns/data`、`headers/rows` 归一化。助手消息持久化独立 Office 生成状态，刷新保留失败，重启遗留活动状态收敛为 interrupted；Renderer 删除 `documentDraftMessageIds` 内存真源并只显示安全原因。修改上一版通过受控 `parentWorkId` 由 Application 校验当前对话和格式，生成新 Work、保留原文件。Runner 在 OOXML/Hash/原子发布之外核对标题、章节与 Excel 表头，拒绝缺关键内容的空壳文件。最终完整 `pnpm test` 为 151 个 Vitest 文件、912/912 通过且 Node/UI 合同全部通过，typecheck、lint、build、差异检查通过。未调用真实 Provider、读取凭证、打包、暂存、提交或推送；Windows Electron 人工验收待负责人执行，记录见同一 Office 验收记录第 13 节。

2026-08-28 Excel 人工验收阻断修复：两次工资表请求均确认 Provider completed、Excel 大纲合法，但 Runner 在 `writing_file` 将合法 XLSX 错判为无效包。离线重放证明文件包含完整 OOXML、工资明细工作表和 12 个表头，误判来自统一内容校验要求 Excel 总标题必须出现在工作簿 XML，而表格型 Excel 实际由文件名承载总标题、章节标题承载工作表名。修复后 Excel 总标题核对受控文件名，工作簿内部继续核对章节和全部表头；包损坏与内容缺失错误分离，失败阶段归为 `verifying_file`。真实结构 RED 稳定失败、GREEN 成功登记 Work，缺表头反向用例继续失败且零 Work。Office 相邻 87/87、完整 Vitest 151 文件 914/914、Node/UI 合同、typecheck、lint、build、差异检查通过。需要完整退出并重启 Electron 后由负责人重试同一句工资表请求；未产生新的真实 Provider 调用、费用、打包或 Git 外部状态变更。

2026-09-02 工程记录：`feature/editor-workspace-layout` 完成编辑页工作台布局重构（UI 重构系列 PR1，待负责人人工审核）。工作区改为显式 Grid 放置：媒体库居左、预览居中、属性栏独占右侧整列并内部滚动，单轨时间线横跨左+中两列底部（max-height 260px 内部滚动）；属性栏顶部常驻所选片段摘要（序号、时长、分辨率、源状态）；媒体列表增加吸顶计数头与内部滚动；新增两步删除（首次点击布防、3 秒自动复位、再次点击确认，仅移除主轨引用不删源文件）；页面级 `workspace--video-editing` 溢出控制；1280/1180px 容器断点保持响应式。门禁：Node/UI 合同 338/338 通过；Vitest 全量 1027/1031，4 项为全量并行下既有资源争用抖动（单文件复跑通过），1 项 `office-document-tool-executor` 清理失败为存量环境问题（干净 develop 基线同样失败，疑与本机 WPS 进程文件锁有关，未改动业务代码）；TypeScript、ESLint 通过。环境治理：本机 git 在 `gc --auto` 触发 `pack-refs --all --prune` 时 packed-refs 重写失败但松散 ref 删除生效，导致分支引用丢失（历史上多次"分支消失"的根因），已设置 `gc.auto=0`、`gc.autoPackLimit=0` 并重建 `feature/editor-workspace-layout` 松散引用；`.git/objects/pack` 存在 17 个无对应 .pack 的孤立 .idx（历史失败 repack 残留，暂不清理）。未执行真实 Electron 手工验收（待负责人）；PR2（对话页思考过程）、PR3（居中回底箭头）、PR4（技能下拉菜单）、PR5（缩略图/自动预览/删除撤销）未开始；未调用真实服务商、未推送。

2026-09-02 工程记录：视频编辑页 UI 改造线（原 PR1/PR1.5）经负责人审核"做出来还没有原来的布局好看"后决策**整线废弃**。已在 `develop` 上以两个 revert 提交回滚：`ee702ae` Revert 92a45ca（媒体卡片/playhead/缩屏重做）、`de4952f` Revert 86ba3bb（编辑工作区布局重构），编辑页恢复改造前基线；旧分支 `feature/editor-workspace-layout` 仅留档不推进。负责人同时决策：对话页改造（思考过程可视化 + 回底箭头居中 + 输入框技能菜单，即原 PR2/PR3/PR4）**合并为单一分支任务**，从对话页先改，逐项人工审核。完整自包含交接文档见 `.workbuddy/artifacts/handoff-chat-ux-upgrade-2026-09-02.md`（含 git 环境缺陷规避、现状代码行号、验收标准、门禁流程），负责人将凭此文档开新任务。基线验证：Node/UI 338/338 通过，tsc 通过；Vitest 仅余 §1.2 存量失败项。

2026-09-02 工程记录：基础剪辑页 V2 方案的中屏/窄屏三处响应式细节按负责人截图反馈对齐，仅改两份资产，未动 React 代码、IPC、domain 与任何 `pages.css`。变更 1）`.workbuddy/artifacts/video-editor-v2-preview.html` 上 `media-item` 媒体卡：`.m-name` 单行 ellipsis 改为两行 `-webkit-line-clamp:2` + `word-break:break-word`，`.m-meta` 加 `padding-right:14px` 让删除按钮/状态点不再压在标题上，W2 媒体帧宽 88→72px 让标题区多出 16px；变更 2）状态点分档：宽/中屏 8px，窄屏（W3 `<1024`）11px 并加 `box-shadow:0 0 0 2px var(--surface-base)` 描边便于小屏看清；变更 3）窄屏 Inspector 不再 `display:none` 整段隐藏，改为折叠抽屉：占第 4 行、`max-height:0` 默认收起，标题区新增 `▾ 展开` toggle 按钮（窄屏外隐藏）控制 `max-height:0→80vh` 过渡，宽度切换事件复位抽屉状态。预览 HTML 顶部加 hint-pill 标注本次三处调整，底部说明从"省略属性面板"改为"折叠抽屉默认收起可展开"。变更 4）`.workbuddy/artifacts/plan-video-editor-v2-2026-09-02.md`：顶部适用范围段加"V2 已与负责人对齐中屏/窄屏三处响应式细节"，§5 断点表 W2 行注明"帧缩 72px"+W3 行注明"折叠抽屉默认收起"+表格下方注明"状态点分档"，新增 §5.1 "中屏/窄屏细节（与负责人对齐）"三行表格把上述三处固定为设计规格避免退回，§7 验收顺序新增 §6.5"中屏/窄屏细节审核"清单（标题不溢出 / 状态点放大 / 抽屉默认收起）。`feature/editor-workspace-layout` 仍为"旧分支仅留档"，未复活任何提交；develop 基线未触动，gate 不变。验收 = 负责人重新打开预览 HTML 用顶部宽/中/窄三个模拟按钮逐条对照 §6.5 清单。未调用真实 Provider、未读取凭证、未打包、未暂存、未提交或推送；阶段 10 与 macOS 延期边界不变。

2026-09-02 工程记录：应负责人要求产出**完整实施方案送审稿** `.workbuddy/artifacts/implementation-plan-video-editor-v2-2026-09-02.md`（401 行，供独立专业人士审核），取代 `plan-video-editor-v2-2026-09-02.md` 作为实施依据（旧稿留档），交互预览 HTML 继续作视觉规格。文档含：现状基线核查（逐文件行号）、S1–S6 分步实施（各自独立提交 + 人工验收）、响应式三档断点表、测试门禁、风险登记 R1–R7、git 纪律、开放问题 Q1–Q6（请审核方裁决，各带默认值）。**本次成稿新核实的现状事实修正（推翻旧认知）**：① 原布局并非完全无断点——`pages.css` L2992 `@media(max-width:1280px)` 会把 workspace 缩为两列并把 inspector 拉成 `grid-column:1/-1` 整宽下移，V2 三档体系需在同一媒体查询内收编该组 `.uc-video-editor` 规则（§7-S6-3）；② `thumbnail_strip`（缩略条）IPC 与主进程实现均存在但**仅开发环境**（`ffmpeg-video-editor-preview.ts` 需 VITE dev URL + `UNICOMP_ENABLE_LOCAL_FFMPEG` + `UNICOMP_FFMPEG_PATH`，单帧 320 jpg），生产帧来源只能走渲染进程内 `<video>`+`<canvas>` 提帧（S2 路径 A），taint 风险 R1 需先 spike，不可行走路径 C（纯 CSS 帧条）；③ "切项目素材当前时间消失"根因不在 mediaTab 切换（现状仅切左栏渲染不重置 state），而在 `selectClip` L824-831 每次 `setPreview(undefined)` 清空预览——S3 据此改为保留/自动重建 + 竞态防护。develop 基线未动，React/IPC/domain/pages.css 均未修改，门禁不变。对话页三合一（handoff-chat-ux-upgrade）与本方案互不依赖。

2026-09-02 工程记录：视频编辑页 V2 方案 **S1（视口锁定 + 三栏 Grid + 属性栏全高 + 时间线跨栏）** 已在单分支 `feature/video-editor-v2` 落地并自验通过（提交 c7d75d0，父提交 = develop 8e5b3dd）。改动 4 文件：`src/ui/layout/AppLayout.tsx` 新增三行 `workspaceVariant` 常量（chat/tasks/video-editing），main 的 className 保持字面 `workspace uc-scrollbar` 且 `<main` 至 `id="main-content"` 间距低于 200 字符，同时满足两条 UI 合同；`src/styles.css` 新增 `.workspace--video-editing{min-height:0;overflow:hidden}` 视口锁定；`src/styles/pages.css` 工作区 Grid 重写为两行三栏 `minmax(230px,.65fr) minmax(480px,1.55fr) minmax(320px,.8fr)` + `rows:minmax(0,1fr) auto`，inspector `grid-column:3;grid-row:1/3` 独占右列全高、timeline `grid-column:1/3;grid-row:2` 跨左+中底行，卡片改 flex-column 使 media-list/inspector-content 内部滚动，移除 1280px 媒体查询内旧 `.uc-video-editor__workspace/.uc-video-editor__inspector` 规则，新增 `@media(max-height:560px)` 矮窗回退（workspace 恢复 auto 滚动）；`src/pages/creation/video/VideoEditingPage.tsx` 将 timeline Card 从 center 列移出为 workspace 直接子元素，split/delete/duplicate/左右移/restore/text/music/cover 全部按钮与功能保留。门禁：TypeScript、ESLint 通过；Node/UI 合同 338/338 通过；Vitest 全量并行仅余既有环境性失败（`office-document-tool-executor` WPS 文件锁 + 4 项并行时序抖动，干净 develop 单文件复跑通过，属环境非代码）。git 环境治理：本机 `git commit` 提交对象成功但删除嵌套 `refs/heads/feature/*` 松散引用使分支变 unborn（第二次复现），已重建松散 ref 并固化 `packed-refs` 条目；此前误产生的 976 文件孤儿 root-commit `c2daa6a` 无引用留待 gc。未推送；未调用真实服务商。待负责人按 S1 验收清单审核（视口锁定/三栏比例/inspector 全高右列/timeline 跨栏底行/矮窗回退/全部片段按钮可用/1280px 断点无旧规则冲突）。S0+S2（canvas taint spike + 视频帧显示）待 S1 验收通过后启动。

2026-09-02 工程记录：视频编辑页 V2 S1 负责人人工验收反馈"单轨时间线区域过大、挤压上方预览区"。按 §5.1 断点表 W1 规格修正 `src/styles/pages.css`：`.uc-video-editor__timeline` 加 `max-height:320px; overflow-y:auto; gap:var(--uc-space-2); padding:var(--uc-space-3)`，视频主轨（timeline 内第一个 `.uc-video-editor__track`）高度固定 92px，文字轨/背景音乐轨固定 44px，辅助轨道超出可滚动。上方工作区（media-bin/preview/inspector）因此获得更多可用高度，与设计稿"轻量单轨时间线贴底"比例一致。未改 JSX、未改 React 状态、未改其他页面；tsc/ESLint/Node+UI 合同 338/338 通过； Vitest 仅余 §1.2 既有环境性失败。提交 f650a59，父提交 9583640。

2026-09-02 工程记录：S1 负责人验收反馈三处显示问题已修复（提交 `2be1f92`）。问题 1）预览舞台 EmptyState 可读性差：icon 放大到 56px 并使用 accent-fill 反白、title 提升到 title-2 加深为 text-primary、description 恢复 body 字号并加深为 text-primary，覆盖 `.app-shell--compact` 造成的 caption 缩小；问题 2）时间线下方状态栏被遮挡：根因是 `.uc-video-editor__status` 在工作区 div 外部，S1 的 `overflow:hidden` 视口锁定将其推出可视区；修复为 `.uc-video-editor` 顶层 Grid 改为三行 `auto minmax(0,1fr) auto`，status 占第三行可见，同时 row-gap 从 space-4 缩为 space-2、column-gap 保持 space-4 消除行间多余空白；问题 3）不合理空白：`.uc-video-editor__preview .uc-empty-state` 取消强制 `min-height:250px` 改为 `flex:1 1 0; min-height:0`，让 EmptyState 占满 preview 剩余空间且不撑大，同时加 `surface-base` 背景让可读性更好。门禁：typecheck、eslint、Node/UI 合同 338/338 均通过；Vitest 环境性失败未变。继续沿用 commit-tree + 手工更新 loose/packed ref 的 git 缺陷规避流程；未调用真实服务商、未推送。请负责人按更新后的 S1 验收清单重新审核，重点确认三处修复效果。

2026-09-03 工程记录：视频编辑页 V2 全线（S0–S6）代码收口，交付总验收清单。分支 `feature/video-editor-v2`，提交链（新→旧）`1eb8e84`(S2–S6) → `e946284`(S0 CORS) → `69a2af1`/`f650a59`/`2be1f92`(S1 及修正) → `c7d75d0`(S1) → `develop 8e5b3dd`。S2 真实帧：模块 `extractVideoFrame`（隐藏 video `crossOrigin='anonymous'` + canvas seek `sourceRange.inUs` → `toDataURL('image/jpeg',0.72)`，`frameCacheRef` 内存缓存，失败降级黑底序号+时长角标，无彩色渐变），MediaList/VideoTimelineTrack/ClipInspector 摘要卡接 frames/names props。S3 选中即自动预览：`selectClip` 不再清空预览，`ensurePreview` 自动建预览；`previewRequestRef` token 丢弃过期异步响应；`previewHandleRef` 持最新句柄防 acceptDraft 陈旧闭包；30s 缓冲内复用句柄并 seek；手动入口降级“刷新原片”；失败空态“源文件不可用可重新定位”。S4 命名：`resolveClipDisplayName` 三分支（作品名 / 片段 N·fileId 前 6 位 / 片段 N），mediaTab 只切左栏渲染不重置上下文。S5 播放头：轨道渐变 + 16px thumb（webkit/moz）+ 高 24px + lane 内竖线 + 等宽标尺。S6 三档：W1≥1340 `300px minmax(0,1fr) 320px` 主轨 92px；W2 1024–1339 250/300 列 + 帧 88→72px + 主轨 76px；W3 <1024 单列堆叠 + 属性折叠抽屉默认收起（`max-height:0`→`.inspector--expanded` 80vh，toggle aria-expanded）+ 整页滚动兜底；1280 旧断点内 `.uc-video-editor__workspace/.uc-video-editor__inspector` 规则已收编移除。门禁终态：tsc 0 错误、eslint 0 错误、Node+UI 合同 343/343、Vitest 串行单 fork 1034/1035（唯一失败 = 既有 `office-document-tool-executor` safe-delete trash 环境性失败，单文件复跑同错，与本线无关）；并行全量复现 tinypool worker 崩溃，按 §9 抖动纪律串行取证。新增测试：`video-editor-clip-display-name` 4 项、`video-editor-v2-ui-contract` 5 项。git 沿用 commit-tree + 手工同步 loose/packed ref 规避；未推送；未调用真实服务商。总验收清单见 `.workbuddy/artifacts/video-editor-v2-total-acceptance-2026-09-03.md`（§4 为 S1–S6 人工打勾表，对照 `video-editor-v2-preview.html`）；S0 CORS 须完整重启 Electron 后生效；待负责人一次性总验收。


2026-09-03 工程记录：负责人总验收发现两类回归，已在同分支提交 77fbc07(批次 D) 修复：(1) 主轨竖线与播放头/预览脱钩——根因 .uc-video-editor__seg 既有 CSS min-width:96px 与 flex-grow:durationUs 让 lane 内容宽度在中/窄窗口超过父宽，触发 overflow-x:auto，竖线 left:percent% 相对父视口而非内容总宽落点偏移。修复改为 JSX flexBasis:百分比 + CSS min-width:4px + lane overflow:hidden，保证 lane 总宽恒等于父视口，竖线百分比与片段边界严格对齐；(2) 窄屏属性面板折叠抽屉不可见——根因 @media(max-width:1023px) 把整个 .uc-video-editor__inspector 设 max-height:0;overflow:hidden，把含展开按钮的 head 一并裁掉，用户无法触发抽屉。修复为：JSX 把 head 与 body 拆分（uc-video-editor__inspector-body 包裹 tabs/title/表单），CSS W3 规则只折叠 body，head 始终可见且 position:sticky 锚定；(3) 中屏时间线标题与操作区按钮溢出——.uc-video-editor__timeline-heading 与 .uc-video-editor__timeline-actions 加 flex-wrap:wrap，中屏自动下行而非溢出卡片。同步更新 tests/ui/video-editor-v2-ui-contract.test.mjs 匹配新 .inspector--expanded .inspector-body 展开选择器；tests/domain/video-editor-timeline-view.test.ts 补 resolveTimelineDropIndex 与 resolveTimelineSegmentAt 单元（拖拽边缘映射 + 跨片段 seek 定位）。门禁：tsc 0、eslint 0、Node 合同 346/346、Vitest 串行 1036/1037（+2 新域用例，仍余 office 抖动 1 项为既有环境性失败，未触动）。本批提交链 77fbc07 ← ff114ae ← 1eb8e84 ← e946284 ← 69a2af1；未推送；未调用真实服务商；仍待负责人在重启 Electron 后再次窗口化核对（重点：拖动播放头/点击片段看主轨竖线、窄屏抽屉触发按钮可见、1280 边界两侧停留 3 秒）。

2026-09-04 工程记录：`feature/ppt-revision-page-count-fix` 完成 PPT 总页数修订失败修复。实际会话“内容太少了加到5页”后再输入“修改文档”时，两条 user message 均无 `displayContent`，旧 Application 因此丢失修订请求并误报 `invalid_outline`；真实模型的五 section 缺括号响应可由既有有限恢复器完整恢复，不是最终根因。修复后聚合当前 assistant 前连续 user 消息并回退 `content`，历史链路保留最近 user 兼容路径；新增明确总页数语义解析，5 页固定换算为 3 个正文 section，走独立全篇结构替换门禁并跳过局部 patch Agent；提示词写明封面/结束页预算与单页容量；Runner 在临时 PPTX 发布前核对真实 slide 数，不符返回 `page_count_mismatch` 且零 Work。依赖用户绝对路径的诊断测试已替换为自包含五 section 坏 JSON 回归。最终 Node/UI 353/353、Vitest 183 文件 1139/1139，合计 1492 项通过；typecheck、lint、build、415 文件平台审计、50 项/27 资产交接校验、恢复审计、阶段 9 关闭门禁和差异检查全部通过。未调用真实 Provider、未读取凭证、未产生费用；仍需完整重启 Windows Electron 后人工复验 5 页新版、旧版保留及父 Work 关系，记录见 `docs/active/对话内Office文档生成-PPT质量优化验收记录.md` 第 15 节。
2026-09-07 PPT 物理页码与确认提示修复：截图复核发现“第二页”在局部修改链路中先按 section 序号解析，再叠加封面偏移，可能把物理第 2 张误改为第 3 张；同时确认卡只显示通用文案，用户无法核对文件和目标范围。现新增受控 `targetUnit`（`section`/`page`）与物理 PPT 页映射：`第 N 页/张` 按含封面的物理页定位，`第 N 章/节/部分` 保持逻辑 section 定位；PPT 页脚数字在清空正文时保留，结构读取不再把页码计为正文块。确认卡显示文件、物理页码、操作和原文件/其他页面保留说明。继续复核截图中的 `invalid_outline` 后确认，旧 Application 会在确定性 `clear_section` Agent 运行前强制编译本轮模型大纲，导致模型即使只返回普通文本也会阻断本可由本地规则完成的清空操作；现仅在父 Work、受控序号目标、明确清空语义和本地 Revision Agent 同时存在时，以已登记父版本大纲进入补丁流程，不读取本轮模型大纲作为修改依据，范围不明确、普通改写、扩页和新建仍保持原编译门禁。新增回归用无效模型文本重放“将第二页的内容清空”，断言本轮文本不进入编译器且补丁仍限定物理第 2 张。定向 103/103、Node/UI 合同 353/353、Vitest 全量 1143/1143、typecheck、lint、build、平台/交接/恢复/阶段 9 审计和 `git diff --check` 均通过。未调用真实 Provider、联网或 Office GUI；Renderer 当前仍会发起一次内容响应，Application 已不依赖其大纲格式，完全免 Provider 的本地快速路径与 Windows Electron/PowerPoint 人工复验仍待后续处理。
2026-09-07 Office 连续多轮修改状态一致性修复：真实会话确认首轮 PPTX 已按本地补丁正确清空物理第 2 张，但 assistant 仍保存与实际文件不一致的模型建议大纲；第二轮沿用该陈旧文本后误判无变化并返回 `unvalidated_output`。现取消轮次差异，所有后续修改统一读取父 Work 消息的 Application 规范化 `validatedContent`，成功后把实际传给 Runner 并生成登记 Work 的最终大纲挂回新消息；模型原文只作审计，历史消息无规范化字段时兼容回退原内容。Renderer 下一轮提示同样优先规范化状态；IPC 和刷新后的失败状态保留范围越界、补丁失败、无可验证变化三类具体提示并说明原文件未改变。新增连续两轮错位模型大纲回归、领域解析/长度/旧数据测试、JSON 仓储往返、IPC 错误码和 UI 合同。定向 51/51 + UI 19/19，完整 `pnpm test` 退出码 0（Node/UI 353、Vitest 清单 1153，共 1506）；typecheck、lint、build、平台/交接/恢复/阶段 9 审计和 `git diff --check` 全部通过。未调用 Provider、联网、凭证或 Office GUI；支持且可校验的修改可连续任意轮次，含糊、越界或不支持请求仍安全失败并保留原 Work；Windows Electron 的“清空第 2 张→基于新版清空第 3 张”人工复验仍待执行，详见 PPT 质量验收记录第 17 节。



2026-09-07 工程记录：视频基础编辑缩略图修复继续阶段 1（用户已批准实施）。在 fix/video-thumbnail-preview 现有未提交补丁上修正：FFmpeg 联系表固定 40 格，每格 112px；派生缓存版本升级；时间线联系表与单帧封面缓存分离，已有联系表不因滚动/缩放重复请求；裁切位置按 frameIndex/39 正向计算；预加载失败/超时保留当前画面并停止播放，新请求清除旧 pending，旧 token 不得提交；撤下无限 shimmer，Canvas 等待上限恢复 10 秒。保留作品库及其他现有修改，未提交/推送/合并。验证：typecheck、lint、定向 Vitest 32/32、UI 合同 19/19、build、git diff --check 通过；本机 FFmpeg 从真实视频截取 5 秒生成 4480x64 联系表（临时目录），宽度符合 40x112。未验证：Windows Electron 第 5 片段最终画面、快速切换/滚动/缩放真实体验、冷启动耗时与无 FFmpeg 回退体验；仅图片尺寸与自动测试不能证明无黑格和流畅度。下一阶段须重启主进程加载新缓存版本并完成上述视觉/性能验收，不能据此声明整体优化完成。未修改 D:\测试 草稿或清理其缓存。


2026-09-07 视觉验收前修复：确认运行缓存中存在 320px 单帧 JPG，被旧代码误当作联系表，导致截图中的横向条纹；并确认固定低分辨率/强制拉伸会造成抽帧越来越模糊。修复为 thumbnail-strip-v3：每格 320x180、40 格、JPEG q=2、保持比例中心裁切；前端只接受恰好 12800x180 的联系表，旧 poster/旧联系表走 Canvas 单帧兜底；联系表使用真实 img 横向位移而非 background 拉伸。新增尺寸拒绝测试。验证：typecheck、lint、build、UI 合同 19/19、定向 Vitest 33/33、真实 FFmpeg 生成 12800x180 联系表并抽取首尾格成功。Windows Computer Use 可读取 UniComp 无障碍树，但截图捕获返回系统错误 SetIsBorderRequired 不支持此接口，因此真实 Electron 视觉/滚动手感尚未通过；不得把自动化结果当人工验收。未提交、未推送、未修改 D:\测试草稿。

2026-09-08 工程记录：视频基础编辑优化方案的自动化实施与验收已全部收口。基于截图进一步发现 v3 的横向 320x180 联系表虽已隔离旧缓存，却与时间线约 56px 宽、92px 高的槽位比例不匹配，仍会在竖屏素材中显得裁切或发虚；已升级为 `thumbnail-strip-v4`：固定 40 格、每格 160x264、JPEG q=2、`force_original_aspect_ratio=increase` 后中心裁切，前端只接受恰好 6400x264 的联系表，并用等比 `<img>` 平移显示，旧单帧、v2/v3 联系表一律回退 Canvas 单帧抽取。缓存版本同步升级，旧缓存不会命中。新增真实 FFmpeg 竖屏 720x1280、5 秒素材回归，实际输出 6400x264 且非空；更新旧缓存尺寸负向测试与 UI 合同。完整验收：`npm run verify:media-engine` 通过；typecheck、lint、build、`git diff --check` 通过；定向视频编辑/媒体引擎套件 40/40；全部 `npm test` 183 文件、1151 测试通过，0 失败。最终开发 Electron 已完整重启，日志确认本地 FFmpeg 与 renderer 连接正常。Windows 自动化窗口截图仍因宿主 `SetIsBorderRequired (0x80004002)` 无法取证，故这不是自动视觉判定；负责人可现在打开项目进行最终人工视觉与手感验收。未提交、未推送、未合并；未清除或改写 D:\测试 的草稿、缓存或素材。

2026-09-08 旧补丁剥离与冗余审计：截图中的 `contactSheetClips`、联系表混入普通帧缓存、CSS `background-image/background-position` 切片及 112px 旧规格均已不存在；保留 FFmpeg 联系表主路径、预览双缓冲和 Canvas 受控回退，后者仍负责联系表不可用时的时间线帧与素材封面，不是重复 owner。本次将联系表版本、格数和尺寸收口到 `src/shared/video-editor-thumbnail-spec.ts`，供 renderer、FFmpeg preview 与 media-engine 共同消费，并删除时间线缩略图相同的 JSX 条件分支及失效的 `background-repeat`。验证：typecheck、lint、build、UI 合同 19/19、定向视频/媒体引擎 40/40（包含真实 FFmpeg 6400x264 联系表）和 `git diff --check` 通过。未修改作品库实现，未提交、未推送、未合并。
2026-09-08 黑屏与拖动修复：复现确认 `acceptDraft` 清空舞台预览后等待异步句柄会暴露黑色画布；时间线拖动在同片段内重复走 `ensurePreview`，反复创建 seek 状态并暂停/等待。修改为加载时使用已有封面或明确占位、用非黑加载层覆盖未就绪帧、同片段拖动直接复用当前 video 元素 seek，并固定跨片段预加载 video 的 key，避免每个指针事件重建解码器。新增 UI 合同 V2-S17。验证：typecheck、lint、build、定向 24 项平台/领域测试和 20 项 UI 合同通过，git diff --check 通过。开发 Electron 重启尝试被宿主审批策略拒绝，真实窗口黑屏消失与拖动手感仍待人工验收。
本次清理后另行完成全量 npm test：Node/UI 356/356、Vitest 183 文件 1151/1151，0 失败、0 跳过。最终视觉清晰度、黑屏与滚动手感仍须在实际 Electron 中验收，本次代码去重与自动测试不代替该结论。
本轮全量 npm test：Node/UI 357/357；Vitest 1150/1151，图片登记测试清理临时 logs 时 ENOTEMPTY，单独复跑该文件 10/10 通过。不能把此次全量首跑记录为全通过。尚未在真实 Electron 复现/测量导入、重新进入页面及拖动延迟；静态合同测试不证明视觉或性能验收。

2026-09-08 连续拖动预览重做（负责人批准，实施中，未验收）：前述黑/浅色整块加载遮罩方案被负责人否决，不能沿用其完成结论。当前已移除 pendingPreview 隐藏视频及 readyPreviewUrl 遮罩；新增受控 scrub_frames 类型及 chunkIndex 参数，由主进程校验片段范围后生成一秒/20帧、640px 方格、5x4的 JPEG 块，复用现有派生磁盘缓存。前端 VideoScrubCache 单任务执行、最新请求覆盖、最多6块解码缓存、最多12个预取目标；舞台 Canvas 保留最后有效画面，拖动时绘制专用帧，松手回到原视频定位。基础编辑实例跨页面保留，隐藏时暂停，返回时检查草稿修订。未触碰作品库、任务日期等其他并行修改。

本轮证据：类型检查、lint、build通过；拖动时间映射与请求合并/旧帧抑制测试通过；媒体控制器拒绝负数/小数/超范围 chunk；真实 FFmpeg 输出3200x2560图片块通过；视频/IPC合同21项通过。所有证据仅覆盖已跑路径。尚缺：真实 Electron 冷/暖缓存及跨片段性能与像素验收、首次导入首帧时序、松手精确帧交接、项目切换及返回布局验证、磁盘缓存容量淘汰策略和最终全量回归。现有Electron与5173均未运行；此前重启命令被策略拒绝，不绕过，已请求用户正常运行npm run dev以继续真实验收。不得将本条标为全部完成或交由负责人作为最终人工验收版本。

续验收记录：用户已启动真实Electron；截图捕获再次报SetIsBorderRequired (0x80004002)，无障碍仅空文档树，未获取视觉证据。一次完整npm test已通过（Vitest186文件1156项，包含其他任务当时新增测试），随后增加实际视频帧回调交接保护。工作区并行下拉框/主题改动随后导致最新typecheck出现12项错误，涉及ModelSelect、ImageGenerationControls、VideoEditingPage表单、LibraryPage、CallRecordsView、TasksPage；不覆盖这些外部修改，已请求协调同文件写入。当前全量构建和真实验收均未通过，前述绿灯不代表当前工作区。独立拖动缓存模块可继续验证；稳定版本后须重新构建、运行真实交互并补齐磁盘限额、首帧与交接验收后再交付。

独立缓存补验：scrub-v1磁盘缓存隔离到既有video-editor-preview目录下的子目录，512MiB上限，仅淘汰hash命名的旧JPEG，不删除当前输出、part文件或原素材。稀疏文件配额测试通过；媒体预览文件9/9通过（含真实FFmpeg）。仍不代表真实首帧、拖动流畅或最终验收通过。

11:45最新门禁：并行修改后的typecheck已恢复通过，lint、build、git diff --check通过，全量npm test退出0，Vitest186文件1157项通过。真实窗口截图仍受SetIsBorderRequired阻断，无障碍无法取得编辑内容；因此整体未验收，不能宣称达到参考视频效果。仍需实测首次导入、往返页面、冷缓存连续拖动、松手交接；当前一秒分块按需生成与有限预取是否满足目标延迟尚未证实。

2026-09-08 负责人录屏反馈后的布局恢复：最新录屏抽帧显示预览停留后跳变，参考录屏显示更连续的画面变化；不从手机录屏推定精确延迟或剪映内部实现。恢复本轮新增页面保留包装层造成的高度回归：App移除外层div，VideoEditingPage根section直接承接工作区高度并使用hidden，CSS明确隐藏规则，保留切页实例状态。仅修改此布局边界，不覆盖并行表单和主题修改。使用真实pages.css的标准模式Edge浏览器隔离布局复现：1710、1280、900宽度，920px容器内旧结构高度694px、新结构920px；隐藏及重新显示通过。该证据是布局夹具，不是完整Electron实机验收。新鲜typecheck、build、29项视频UI合同和git diff --check通过。

拖动问题仍未修复验收：当前未解码块请求串行经过原文件校验/校验结果持久化、派生图片获取和图片加载，正在运行的预取无法让位；最后画面保留只能避免空屏，不能消除等待。各环节真实耗时、首次导入首帧、返回页面及松手交接仍需实测，不能宣称达到参考效果。本次只恢复已确认的布局回归；不继续叠加未经验证的性能补丁。未提交、未推送、未改用户草稿或原素材。

2026-09-08 再次接管后的根因纠正与实施：负责人继续授权修复导入黑屏、主轨刷新及拖动卡顿。主线为已有预览owner内修正状态失效与解码调度，不变更框架/媒体权限。实测用户5秒H264素材：JPEG一秒块冷生成133–146ms，校验结果持久化23.6–34.8ms，独立Edge首次图片decode约26ms；六块平方JPEG只覆盖六秒并占约187.5MiB解码内存。相同原片使用常驻video合并最新seek，seeked p95 7.5–8.6ms、rVFC间隔p95约16.8ms；全帧内VP9代理没有明显优势，生成约1.394秒且体积更大。因此拒绝继续调大JPEG缓存或默认转码，删除本轮scrub_frames/chunkIndex/spec/磁盘配额/对应旧测试；保留thumbnail v4。

实际修复：VideoScrubCache改为各源文件独立常驻video，最多8个解码器，源句柄预取，目标合并，不在每次拖动调用IPC。seek按已提交目标去重，避免浏览器帧时间量化触发重复seek；当前目标变化时允许显示该素材刚解码的进度帧，禁止非当前素材回写。加载错误和15秒加载超时反馈到页面，清理取消事件与迟到句柄。主轨光标和读数在拖动RAF内更新，页面只在片段/文字有效范围改变及松手时同步。acceptDraft同草稿只失效删除/源或裁剪变化的片段缓存，保留原主轨图片、缩放与滚动。暂停首帧已就绪后用RAF交接，不等不存在的下一视频帧；空Canvas不再默认覆盖舞台，新视频未就绪保持已有画面。React提交后重新应用待定位目标，覆盖同URL跨片段重挂载时序。

验证证据与边界：修复前真实页面组件+Edge媒体解码夹具复现0秒video已有数据但空Canvas仍可见；修复后首帧、导入、松手、隐藏返回均正常。真实素材、两片段、121次自动化鼠标事件约118次Canvas绘制，事件至绘制p95约20–22ms；自动化事件发送间隔p95约51–68ms，不能把此测量称为稳定60fps。导入仅新增片段请求预览和主轨图片，拖动/返回没有新增IPC；最终0.161290秒目标与video精确一致。夹具接口为替身，素材与React页面/解码器真实；不替代Electron原生导入对话框、真实8片段主轨或全平台验收。临时复现脚本为用户Temp/unicomp-editor-runtime.cjs，截图unicomp-editor-runtime-after.png。独立耗时脚本unicomp-video-seek-audit.cjs与unicomp-scrub-audit-*在同一Temp。

最新门禁：typecheck、lint、build、git diff --check通过；32项定向测试通过（含真实FFmpeg40帧与新增decoder合并/跨源/上限/迟到响应回归）；全量Node/UI359/359，Vitest1155/1156，图片登记测试stored-immediate-image-result-port.test.ts临时目录清理ENOTEMPTY失败，未将首跑改记全绿。当前没有可见UniComp窗口，只有后台Electron进程；原生窗口最终验收、长GOP/高分辨率/超过8源的首次跨片段性能及全量失败项仍未关闭。总体不得宣称全部验收通过。未提交、未推送、未改用户草稿及源素材。

补充夹具证据：同源片段20–22ms结果之外，改为两个不同fileId与不同真实视频URL，121次鼠标事件115次绘制，事件至绘制p95约35.7ms；松手0.161290秒精确一致，Canvas正常隐藏，隐藏返回不发新预览请求。导入新增源有两次并发句柄申请（舞台及后台准备），拖动热路径0次；没有将此结果夸大成全轨60fps或完全无卡顿。

2026-09-08 时间线两处 UI 修复：按负责人截图在当前 fix/video-thumbnail-preview 分支追加局部修改，保留既有未提交工作。片段拖动显式使用仅含当前片段的独立 DOM 快照，下一事件轮清理；播放头顶部由半圆改为内缩 2px 的完整 10px 圆点，竖线时间位置不变。验证：视频编辑 UI 合同 39/39、时间线领域测试 17/17、typecheck、lint、build、git diff --check 通过。静态合同不能证明原生拖拽浮影，实际 Electron 拖拽图、圆点视觉与边界显示尚未实机验收；下一步在真实窗口拖动不同片段并检查圆点。未提交、未推送。

2026-09-08 拖拽浮影回归修正：负责人反馈上次修复后浮影不显示。上次将独立片段副本放到视口外 -10000px，Chromium 捕获存在不可见问题；本次副本改在原片段视口位置渲染并提高层级，捕获后沿用定时清理，仅克隆当前片段。新增位置回归合同先失败后通过。视频 UI 39/39、typecheck、定向 eslint、build、差异检查通过。未取得原生 Electron 浮影视觉证据，不宣称实机验收通过；未提交或推送。

2026-09-08 拖动浮影再次回归后改正：此前两次 setDragImage 副本方案均未通过负责人实际反馈，不沿用完成结论。移除立即删除副本逻辑，使用拖动期间常驻、跟随 drag/dragover 坐标的页面 DOM 浮层，只克隆当前片段并限制宽度320px，保留名称；原生快照设透明Canvas，drop/dragend/卸载清理浮层。新鲜验证：真实VideoTimelineTrack源码与pages.css在Edge夹具中，合成拖动事件后浮层仅有片段A、尺寸240x92、位置432/312，结束清理通过；不等价于Electron原生鼠标拖动。UI39/39、typecheck、定向eslint、build通过。最终Electron鼠标视觉仍待验证。未提交、未推送。

2026-09-08 播放舞台闪色定位：负责人视频2按4fps抽帧，约0.25秒及8秒处人物仍在但左右黑边变浅灰，再恢复黑色。不是已证实的整页布局抖动。代码对应：seek期间舞台背景切浅灰、旧帧Canvas背景浅灰、video隐藏。本次取消seek隐藏视频与背景切色，Canvas背景与现有video黑底一致；保留既有帧交接，不声称与剪映等效连续播放。UI17项通过，typecheck与定向eslint通过；最终背景修正后重跑build。未进行新版本Electron真实像素验收，未提交推送。
