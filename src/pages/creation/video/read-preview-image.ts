// Only session blobs or capabilities issued by the local media protocol may be read.
export async function readPreviewImage(url: string, signal: AbortSignal): Promise<Blob> {
  const parsed = new URL(url);
  if (parsed.protocol !== 'blob:' && !(parsed.protocol === 'unicomp-media:' &&
    parsed.hostname === 'local' && !parsed.username && !parsed.password && !parsed.port &&
    /^\/[a-zA-Z0-9-]+$/.test(parsed.pathname))) {
    throw new Error('Unsupported preview image address');
  }
  const response = await fetch(url, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
    credentials: 'omit',
    redirect: 'error'
  });
  if (!response.ok) throw new Error('Thumbnail read failed');
  return response.blob();
}
