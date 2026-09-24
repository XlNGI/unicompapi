import { afterEach, describe, expect, it, vi } from 'vitest';
import { readPreviewImage } from '../../src/pages/creation/video/read-preview-image';

afterEach(() => vi.unstubAllGlobals());
describe('controlled preview image reads', () => {
  it.each(['https://example.com/image.jpg', 'http://localhost/a', 'file:///C:/private.jpg',
    'data:image/png;base64,AA==', 'unicomp-media://remote/token', 'unicomp-media://user@local/token',
    'unicomp-media://local:80/token', 'unicomp-media://local/a/b'])('rejects %s before reading', async url => {
    const read = vi.fn();
    vi.stubGlobal('fetch', read);
    await expect(readPreviewImage(url, new AbortController().signal)).rejects.toThrow();
    expect(read).not.toHaveBeenCalled();
  });
  it.each(['unicomp-media://local/handle-1', 'blob:file:///cached-image'])('reads %s without credentials or redirects', async url => {
    const blob = new Blob(['image'], { type: 'image/jpeg' });
    const read = vi.fn().mockResolvedValue({ ok: true, blob: async () => blob });
    vi.stubGlobal('fetch', read);
    const controller = new AbortController();
    expect(await readPreviewImage(url, controller.signal)).toBe(blob);
    const options = read.mock.calls[0][1];
    expect(options).toMatchObject({ credentials: 'omit', redirect: 'error' });
    controller.abort();
    expect(options.signal.aborted).toBe(true);
  });
  it('does not accept an expired handle response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));
    await expect(readPreviewImage('unicomp-media://local/expired', new AbortController().signal)).rejects.toThrow();
  });
});
