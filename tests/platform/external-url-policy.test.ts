import { describe, expect, it } from 'vitest';
import { normalizeTrustedExternalUrl } from '../../src/platform/runtime';

describe('external URL policy', () => {
  it('allows normalized HTTPS destinations', () => {
    expect(normalizeTrustedExternalUrl('https://example.com/docs?q=1#start'))
      .toBe('https://example.com/docs?q=1#start');
  });

  it.each([
    'http://example.com/',
    'file:///C:/secret.txt',
    'javascript:alert(1)',
    'data:text/plain,secret',
    'https://user:secret@example.com/',
    'not a url'
  ])('rejects renderer-controlled unsafe destination %s', (value) => {
    expect(normalizeTrustedExternalUrl(value)).toBeUndefined();
  });
});
