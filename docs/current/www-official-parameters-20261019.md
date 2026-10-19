# WWW 官方参数核对与费用输入退役（2026-10-19）

本轮响应负责人最新截图：红框“本次报价上限（元）”为什么必填、是否为官方参数。当前属于维护；依据最新用户指令、AGENTS.md、PLANS.md 顶部维护事实和 WWW 当前公开文档，在 feature/www-model-binding-repair-20261019 保留前轮未提交修改实施。范围限于九个已绑定 WWW 视频合同的参数证据/版本、费用确认、表单、旧草稿迁移、相关脚本/测试及工程记录；未修改权威交接原件。

## 核对结果

`maximum_cost_cny` 是应用自行附加的人工费用上限，原 Schema 将它标为 user_required / required=true / require_user_value；并非服务商模型字段。上一轮仅分组展示，仍要求填写，未满足负责人要求。本轮已彻底删除输入控件、标签/说明、Schema 附加项、适配器的人工 cap 校验及原生确认框的上限文案。

经负责人明确要求核对官网，实际向九个已知公开模型文档 URL 发起有界 GET；未发送凭证、企业资料、项目内容或提示词，未访问生成/结算端点，无模型费用。第一次采集在第四个成功页面后因传输错误停止，第二次逐页记录失败，合并本轮成功保存的响应取得全部九页。前两页采用首次保存响应的文件时间记录读取时间依据；失败日志和第二次采集结果均保留，未拿 10 月 15 日缓存冒充本次读取。

九页均没有 `maximum_cost_cny`。其余八个型号参数表明确使用“可选”；编译器现在保留文档的 required 证据，不再一律手工指定。图生视频的生成方式仍须明确选择，以确定素材角色/数量，不能把官方文生视频默认方式用于携图请求。

H3 当前[官方动作文档](https://www.unicompapi.com/docs/models/MiniMax-H3)提供 generate 的五个字段示例：resolution、ratio、duration、generate_audio、watermark，没有完整的 generate 必填、枚举、范围定义。证据中以 required=null 明确保留未知事实，界面不凭示例发明必填项；本地只按示例类型校验，再向服务商询价。不得将 regenerate 的 2K/音频限制或 understand 的时长限制套到 generate，也不得用 MiniMax 原生 API 的不同字段替代 WWW 网关协议。本轮没有验证任意参数组合都可被真实服务接受。

H3 文档明确要求先报价，提交时使用原 input_digest、price_version、quoted_amount。`expected_quote_amount` 是系统从报价响应填入的协议字段，不是人工填写的模型参数。仍校验正安全整数金额、CNY_MICRO、原价格版本/摘要、空 closed_reasons，Host 原生窗口确认确切金额后才提交；取消不发送收费 POST，修改输入重新询价，收费提交不重试。最终结算仍以原服务商账单为准。

## 兼容与界面

新合同为 H3 revision 3、其余八个 revision 2。保留前一版九个合同完整原对象，以及更早 H3 revision 1；仅允许已受理原单查询、下载，不接受旧合同新建收费请求。沿用前轮修复的有界轮询、下载和恢复逻辑。

旧 WWW 草稿在仓储 get/list 时只去除退役的 maximum_cost_cny，读取不写文件、不改时间/其他参数；正常保存时清理该键，IPC 保存响应也返回清理后数据。其他服务商同名字段不动，其他未知字段不作为此次迁移被清除，直接适配器请求仍严格拒绝未知参数。新合同绑定变化可能要求重新选择模型，禁止静默切换到另一服务/连接。

可选布尔值区分“默认”和显式“关闭”，并能清除显式选择、恢复服务商默认，避免界面显示关闭却实际省略字段。模型参数保存前仍同步 flush 当前输入，移除独立费用表单及其样式。

## 实际验收

- 全量 Vitest：349 文件、3531/3531；Node/UI：394/394，共 3925 项，零失败/跳过。全量期间只补强一条 WWW Schema 测试的断言，产品源码未再变化；结束后最终 WWW/仓储定向 68/68 再验。
- 类型检查、全仓 lint、生产构建、平台审计通过；最终 diff 检查和文件指纹见机器记录。构建保留既有 chunk 大小提示。
- 真实生产 Electron/preload/IPC/Host 九型号 13 合成组合通过，报价原生窗口验证无上限文案、无需预算；模拟 H3 查询与下载暂时失败后仍登记本地视频，外部请求和真实收费 POST 均为 0。
- 生产 React H3 四组与视频编辑五组验证通过，截图经实际查看；确认所有位置均没有费用上限输入、布尔默认/false/清除状态准确、当前编辑提交前保存、原视频预览及编辑选择仍可用。
- 首次定向迁移测试缺 candidateId 被仓储完整性校验拒绝，补全有效旧草稿后通过；旧布尔文本静态断言和 RSuite 内层 input 无文本的 UI 断言已更新。首次 Electron 发现 IPC 保存响应仍含退役字段，修复共同迁移后通过。均保留中间失败日志。
- 正常关闭旧实例前核对三笔执行为 failed/completed/completed；重启后原 Task、Execution、Operation、Route 与两件 Work 文件 Hash 均不变。已真实执行 pnpm dev，新 UniComp 窗口可见、响应正常、HTTP 200，保留供负责人使用。

详细机器记录：[validation.json](../evidence/www-official-parameters-20261019/validation.json)；公开来源与字段逐项证据：[official-findings.json](../evidence/www-official-parameters-20261019/official-findings.json)。本轮没有新发收费生成、重新恢复原单或结算；不宣称九型号真实服务全部成功、H3 完整官方 Schema 已公开或 macOS 实机验收。未提交、合并、推送或发布。
