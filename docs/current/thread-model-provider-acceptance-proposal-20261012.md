# Thread/模型统一接线的真实验收方案

2026-10-12。负责人已在本轮会话明确回复“授权，按上述范围执行”；以下单例预算和外发范围已获授权，只在最终本地门禁通过后执行。

## 已准备的具体动作

使用现有 `scripts/verify-production-document-read.cjs` 的单例生成/读回入口，在新的隔离项目和独立 profile 中生成一份合成 PPT，随后读取物理文件并校验模型最终回答、工具收据、唯一 Work、Thread Tool/Artifact 和本地文件/Hash。生产用户项目不参与该用例。

当前 dry-run 自动选出的有效文本模型为 `glm-5.2`，状态 `dry_run_passed`，网络请求 0，未解密调用凭证。真实执行显式固定该模型；原 `kimi-k3` 失败现场不重试，不更换为其他模型。

## 请求和费用边界

- 总外部请求最多 5 次，包含 Content Planning、Art Direction、工具返回后的模型续答；失败或未知结果自动重试 0。
- 普通回复输出上限 1024 token，Art Direction 输出上限 4096 token；仍由现有 Host 工具预算、取消与超时限制执行。
- 外发内容限于脚本内的合成需求、系统/工具合同、该合成文档的受控 Observation；不加入企业资料、用户附件、真实会话或联网搜索。
- 凭证只由现有加密 vault 临时读取并交给受控 transport，不写入日志、工程文件、聊天或 Git。
- 缺少可信价格证据，金额维持 `unknown`；不能把请求次数上限换算成未经证实的人民币费用。
- 保留失败/未知现场和脱敏报告。正式作品仍须本地文件、结构/视觉校验、Hash、原子发布与登记通过；HTTP 200 不等于完成。

## 授权后的命令

```text
pnpm exec electron scripts/verify-production-document-read.cjs --authorized-generation-case --model glm-5.2 --output-directory outputs/thread-authority-maintenance/provider-live
```

只在本地最终门禁通过且负责人明确接受以上预算和外发范围后执行。该单例不代表其他 Provider/协议的真实矩阵全部通过。

## 本轮实际执行

本地门禁通过后，初次夹具因直接写入 Legacy 在控制器处被拦截，网络请求 0；修正共享仓储并通过实际种子消息的 dry-run 校验后，在新的隔离 profile/project 执行原批准单例，固定 `glm-5.2`，实际 4 次请求、自动重试 0、金额 unknown。

已生成并读回唯一 4 页 PPT，文件 70,285 bytes，原子发布、登记、Hash、读回 Observation 身份/版本和最终回答核对通过。原严格验收器提前返回漏记读取比较、并在结算前采集 Thread，记录为 FAIL；原报告保留。新增只读现场复核脚本得到 `verified_delivery`，Thread 已有两组 Call/Result、一个 Artifact 与一致的 Assistant 正式收据。原逐页 wire 文本比对未记录，不追认为 PASS；验收器已补校验和结算等待，未自动再发收费请求。

负责人已明确选择“按当前交付结果收口，不再付费”。实际请求总数固定为 4，不使用原授权剩余次数，不追加新的收费用例。原严格 wire 记录缺口保留，已有作品和失败/核验报告均保留；后续不会以自动重试或补证名义继续调用。
