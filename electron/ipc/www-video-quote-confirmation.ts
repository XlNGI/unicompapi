import { BrowserWindow, dialog } from 'electron';
import type { WwwVideoQuoteApprovalPort } from '../../src/platform/providers/newapi/www-video-adapter';

/** Native approval stays in the Host; renderer parameters cannot approve a quote. */
export const wwwVideoQuoteApproval: WwwVideoQuoteApprovalPort = {
  async confirm(input) {
    const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows().find(window => !window.isDestroyed());
    if (!parent || input.signal?.aborted) return false;
    const timeout = AbortSignal.timeout(120_000);
    const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
    const amount = (input.quotedAmountCnyMicro / 1_000_000).toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
    const result = await dialog.showMessageBox(parent, {
      type: 'question', title: '确认本次视频费用',
      message: `本次报价 ¥${amount}`,
      detail: `模型：${input.modelKey}\n确认后按此报价提交本次生成，最终结算以服务商账单为准。取消不会提交生成。`,
      buttons: ['取消', '确认报价并生成'], defaultId: 0, cancelId: 0, noLink: true, signal
    });
    return !signal.aborted && result.response === 1;
  }
};
