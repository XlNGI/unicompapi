import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import {
  downloadImageWithNativeRequest,
  requestBinaryWithNativeRequest,
  type NativeBinaryRequest,
  type NativeBinaryResponse
} from '../../electron/ipc/native-binary-request';

class FakeResponse extends EventEmitter implements NativeBinaryResponse {
  constructor(
    readonly statusCode: number,
    readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>
  ) {
    super();
  }
}

class FakeRequest extends EventEmitter implements NativeBinaryRequest {
  readonly headers: Record<string, string> = {};
  aborted = false;

  constructor(private readonly response: FakeResponse) {
    super();
  }

  setHeader(name: string, value: string): void {
    this.headers[name] = value;
  }

  abort(): void {
    this.aborted = true;
  }

  end(): void {
    queueMicrotask(() => {
      this.emit('response', this.response);
      this.response.emit('data', Buffer.from('image bytes'));
      this.response.emit('end');
    });
  }
}

describe('downloadImageWithNativeRequest', () => {
  it('ignores a Unicode content-disposition header and returns image bytes', async () => {
    const response = new FakeResponse(200, {
      'content-type': 'image/png',
      'content-length': '11',
      'content-disposition': 'attachment; filename="自动生成图片.png"'
    });
    const request = new FakeRequest(response);

    const result = await downloadImageWithNativeRequest({
      url: 'https://example.test/result.png',
      maximumResponseBytes: 1024,
      createRequest: () => request
    });

    expect(Buffer.from(result.body).toString()).toBe('image bytes');
    expect(result.contentType).toBe('image/png');
    expect(request.headers).toEqual({ accept: 'image/*' });
    expect(request.aborted).toBe(false);
  });

  it('aborts a response whose declared size exceeds the limit', async () => {
    const response = new FakeResponse(200, {
      'content-type': 'image/png',
      'content-length': '2048'
    });
    const request = new FakeRequest(response);

    await expect(downloadImageWithNativeRequest({
      url: 'https://example.test/result.png',
      maximumResponseBytes: 1024,
      createRequest: () => request
    })).rejects.toMatchObject({
      code: 'response_too_large'
    });
    expect(request.aborted).toBe(true);
  });

  it('downloads video bytes without exposing a Unicode filename header', async () => {
    const response = new FakeResponse(200, {
      'content-type': 'video/mp4',
      'content-length': '11',
      'content-disposition': 'attachment; filename="自动生成视频.mp4"'
    });
    const request = new FakeRequest(response);

    const result = await requestBinaryWithNativeRequest({
      url: 'https://example.test/v1/videos/task-1/content',
      headers: {
        accept: 'video/mp4',
        authorization: 'Bearer test-token'
      },
      maximumResponseBytes: 1024,
      createRequest: () => request
    });

    expect(result.status).toBe(200);
    expect(Buffer.from(result.body).toString()).toBe('image bytes');
    expect(result.headers).toEqual({
      'content-type': 'video/mp4',
      'content-length': '11'
    });
    expect(request.headers).toEqual({
      accept: 'video/mp4',
      authorization: 'Bearer test-token'
    });
  });
});
