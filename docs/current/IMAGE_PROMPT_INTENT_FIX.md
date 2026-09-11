# 附图“生成提示词”误追问修复

日期：2026-09-11。负责人截图显示单张图片与“生成提示词”已发送，助手却追问“咨询问题还是创建/修改文档”，输入框未选模型。按 `AGENTS.md` 顶部维护决策与当前源码在 `feature/provider-chat-availability-fix` 修复；保留前批联网体验、模型配置及兼容性改动。

## 原因与修复

通用意图判定把“生成”识别为强创建动词，但“提示词”没有 Office 类型，于是产生 `unknown/intent_operation`。此前单图传输测试未覆盖该原句从 UI 进入工作流的完整路径。无选中模型时，语义分类兜底无法执行，因此直接显示错误意图追问；缺模型是执行条件，不应让明确需求变成意图不明。

在现有本地规则中加入行内提示词/图像分析请求识别：“生成提示词”“根据这张图片生成提示词”“优化刚才的提示词”“生成 PPT 的提示词”等直接生成聊天计划，允许覆盖旧 PPT 追问或旧输出偏好，仍执行现有权限、模型和图片范围校验。明确要求生成 PPT 文件、保存为 Word、导出 Excel 或制作图片分析报告时保留文档流程。未增加图片/视频生成入口。

未选择模型的就绪任务明确提示“请先选择一个可用模型，再点继续执行”，请求与附件已经保留；选择模型不自动重发请求或开始付费调用。图片传输沿用既有单图、本地 Hash/大小/格式/范围校验，没有通过提示词规则跳过授权或读取附件内指令。

## 验证

- 全量 Vitest 210 文件、1615/1615 通过，零失败/跳过；新增 13 项应用用例，Golden V1.3.0 共 73 个语义案例。覆盖旧文档任务、文档偏好、行内输出和明确文件交付边界。
- Node/UI 356/357，通过项与前轮一致；唯一失败仍为既有 `handoff/.../manifests/SHA256SUMS.txt` 缺失。未恢复已删除文件或放宽检查。
- 类型检查、lint、生产构建、平台审计、恢复审计和差异检查通过，Vite 保留既有大包提示。
- 新增 `validation/image-prompt-production.cjs`，使用真实生产 Renderer/preload/IPC/导入/工作流/图片校验/仓储及隔离合成 transport。已选模型与未选模型两场景共 5 项通过。界面真实粘贴一张合成 PNG，发送截图原句及“生成英文提示词”；每条输入恰好一次回答请求，无额外分类请求，无 Office 追问、生成或作品登记。两次模型请求都携带恰好一张图片，解码后的 Hash 与导入图片一致；后续复用附件，不重复导入。未选模型时 0 次模型请求，选择模型并点击继续后使用原消息，不重复追加用户输入。
- 截图检查附图与回答均显示正常。隐藏窗口的 Chromium 延迟解码通过测试脚本提前解码真实预览 URL 后截图，不替换图片内容或修改生产预览逻辑。
- 现有 GLM 最新资料授权、即时来源提示、真实三页 PPTX 和 Work 登记生产回归通过；6 项独立生产对话 IPC 冒烟通过。
- 真实网络和付费模型调用为 0，未读取真实凭证，未向用户实际项目发送测试消息。本地合成 transport 证明请求与图片传输正确，不宣称用户网关真实模型输出验收。

证据：`tmp/image-prompt-vitest.log`、`tmp/image-prompt-node.log`、`tmp/image-prompt-typecheck.log`、`tmp/image-prompt-lint.log`、`tmp/image-prompt-build.log`、`tmp/image-prompt-platform.log`、`tmp/image-prompt-recovery.log`、`tmp/image-prompt-ipc.log`。

生产截图及结果：已选模型 `tmp/image-prompt-e2e-BkkQlr/`；未选模型 `tmp/image-prompt-e2e-wLsF0J/`；联网 PPT 回归 `tmp/native-e2e-S9g4E7/`。复现执行 `pnpm exec electron validation/image-prompt-production.cjs`，未选模型场景设置 `UNICOMP_TEST_IMAGE_PROMPT_SCENARIO=no-model`。

## 交付与后续

最终前端资源 `index-SqwgzYAe.js`，联网及 Office 逻辑保留。旧进程 PID 6720 正常关闭，新构建 PID 7980、窗口 UniComp 已显示并响应，启动日志无错误。当前模型选择仍需用户明确选择；原会话错误追问作为历史消息保留，重新发送“生成提示词”会按新规则继续，已有图片仍受当前会话附件范围控制。未修改历史会话文件，未提交、推送或合并。实际启动信息同时登记到 `PLANS.md` 顶部。macOS 未做实机验证。
