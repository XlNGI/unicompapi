# 内容组织与关系驱动布局工程验收

日期：2026-10-06（客户 America/New_York）；样例目录时间为 UTC。负责人反馈样式改善仍不满足逐页内容设计目标，在明确下一步后要求“继续”。当前 `feature/chat-send-input-runtime-fix` 保留此前全部授权维护改动；本批不新增业务入口、预览、审美评分、图片/任意图形或 Agent Loop。

## 实际实现

Design IR 外层仍兼容 v2，page 新增可选 `organization`，内部独立版本 v1。模型声明 comparison/metrics/sequence/evidence/grouped 业务结构、header/业务组/来源说明以及 compare/sequence/supports 关系，只使用同页已有内容引用。合同封闭、16 组/32 关系、有界成员，拒绝额外事实/坐标/代码/路径、重复 ID/原始引用、无效关系、自环和有向环。Prompt 与响应 Schema 已接线，旧无组织计划继续可读取。

结束页规划库存补齐为实际 action、最近非空 takeaway 与 title；更早章节只允许实际最近 takeaway，不扩大任意跨页引用范围。规划资料继续作为不可信参考数据，模型不能决定执行权限、预算或作品身份。

Host Features 将区块别名展开为真实叶子，只允许每项正文出现一次；重复父/叶引用、缺正文、跨页引用均拒绝。真实标题单独归入 header，可由 Host 补齐；业务标签可以留在各自组内。简单且边界明确的无组织 v2 页面可以受控推断业务组，混合/歧义页面保留原路径，不猜完整业务关系。实际 resolved organization 记录 explicit/inferred 来源。

Solver 为标题、业务组和完整来源说明分配区域；比较两侧按业务对象占并列槽位，指标与标签/说明在同组，步骤顺序服从 sequence 边，支持关系把证据与结论关联为同一内容区域。首尾页保留中心表达。业务组不由 primary/supporting 随意拆分；字号层级、间距和字体下限仍受原约束。比较/指标并列组共享对应行的尺寸，按实际宽度测量紧凑文字高度，避免数值错行与大块无意义空白。

已有特殊内容角色 metric/evidence/chart 在同一引用亦属于 generic body 时优先，避免泛化 body 覆盖专业角色。文字/表格/图表仍是现有受控图元；本批没有独立卡片背景容器、图形连接线或图片。

## 合同、修正和发布

唯一 Production Layout IR 的每页可记录组织：Host 由稳定 pageId 与语义组 key 生成稳定 group ID，成员指向 canonical ID，关系也映射为 Host ID。组织不重复保存另一套可修改几何；与现有元素及 style 同一 layoutDigest、render input identity、私有候选与父链。

读回核对闭合成员库存、组 ID/边/环、与实际已确认 Design IR 的成员/关系一致性；空间检查拒绝不同业务区域交错、标题侵入正文、比较两侧未并列、步骤倒序。修改布局并重算 Hash 不能绕过明确组织关系。旧无组织记录保持兼容，成熟 physical identity/head/version pin/tombstone 不被模型组 ID 替换。

有限修正保留已声明业务组、角色和关系，通过受控密度/留白调整重新求解实际目标几何，不将 A/B 关系改成主/辅助或丢成旧模板。明确组织输入坏、完整叶子缺漏或无法实现时为受控结构/布局失败，禁止正式 Work；普通无组织旧计划的兼容路径保留。无效 plan 映射为 invalid_structure，避免被错误显示成存储失败。

## 验证与真实样例

合同、结构完整性、实际文件和几何定向门禁已验证：对比两侧各含自身标签/证据并列；指标 label/value 同组，来源说明全宽；故意乱序步骤数组由显式边形成 1→2→3，仅改变边会改变实际位置；正文/稳定来源/主题保持。来自真实规划口与 writer 口的非法组织分别验证无 Work，修正两候选均 design-aware、版本/父链/组织保持、实际目标几何改变、其他页 XML 不变。对成员/来源标签/步骤几何篡改后重算布局 Hash 的攻击也会拒绝。

原 10 秒门禁下实际七页 Office 结构 QA 通过。另用当前 compiled Runner/Reader、独立项目与严格 requireRenderForPpt 验证真实 7 页：诊断为空、登记与读回 1 Work，真实文件 Hash/组织/私有计划一致，Provider/HTTP(S) 调用 0。未读取用户凭证、重跑真实任务或重启用户应用。

第二版验收样例：`outputs/ppt-organization-proof/20261007031233113-b7964cf4/`，包含 `synthetic-grouped-organization-sample.pptx`、`preview/synthetic-grouped-organization-sample.pdf`、逐页 PNG 与 `report.json`。内容为合成 fixture，不是实际企业数据。已查看真实对比/指标/步骤页面，组边界、对应行和来源说明已落实；装饰、卡片内边距与更丰富构图仍是后续能力。

## 失败记录与完整门禁

首次 production repair fixture 缺少必需 userRequirement，使规划回退为 legacy，原测试未证明新设计；已补明确需求并断言规划器调用/两候选 design-aware，保留初轮失败日志。首次编译样例虽然生产 QA 通过，实际指标值错位约 0.8134 英寸，标签 track 空白过大；新增真实 XML 相同 y/height 与紧凑 caption 断言先复现失败，随后共享行测量修复，原 epsilon 不放宽。

首份样例 `outputs/ppt-organization-proof/20261007030455248-4ccde753/` 原样保留，第二份不覆盖。最初 lint 的未用变量已移除。Node/UI 平台审计发现两个新增 compiled 验收脚本平台访问未登记；已只向现有审计配置添加两个具名工程脚本，原扫描根/规则/禁止路径和 shell 检查不变，不把平台分支放入业务应用逻辑。

完整冻结门禁最终结果：Node/UI **387/387**、Vitest **317 文件/3307 项**，合计 **3694** 项，零失败、零跳过。类型、lint、生产构建、平台/恢复/阶段 9 基线/计划审计及 diff 检查通过。首轮 full Vitest 的旧 `evidenceCount` 断言在明确 evidence 优先级调整后重跑全绿；首轮指标错位和未登记脚本审计失败均保留日志，不以放宽断言或忽略审计收口。证据包含 `outputs/ppt-organization-vitest-final.log`、`ppt-organization-node-final.log`、最终 typecheck/build/lint/audit/diff 日志、`ppt-organization-source-manifest.json` 及两版 compiled 样例报告。

本批预算、等待、最大修正次数、取消、内容/字体下限/重叠/越界、三次 Hash、原子发布与 Work 门禁不放宽。macOS 实机仍延期；当前无 commit/push/merge/deploy。回滚只逆向本批组织扩展/解算接线与直接测试，不删除旧作品/计划证据或回退此前样式、内容、Runtime 与恢复维护。
