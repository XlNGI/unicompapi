import { clipboard } from 'electron';
import type { TextClipboardApi } from '../src/shared/text-clipboard';

/** Keep the native clipboard module in preload; expose no read or object access. */
export const textClipboard: TextClipboardApi = {
  async writeText(text: string): Promise<void> {
    if (typeof text !== 'string' || text.length > 2_000_000) throw new TypeError('Invalid clipboard text');
    clipboard.writeText(text);
  }
};
