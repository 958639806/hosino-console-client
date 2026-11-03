import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, ConsoleClient, readEventStream, SseParser } from '../src/api';

const pair = {
  device: { id: 'device-1', name: 'Android' }, accessToken: 'secret-access', refreshToken: 'secret-refresh',
  accessExpiresAt: 1_900_000_000_000, refreshExpiresAt: 1_901_000_000_000,
};

const capabilities = {
  apiVersion: 1, build: 'test', auth: ['device-bearer'],
  modules: { overview: true, sessions: true, chat: true, uploads: true, cli: true }, permissions: { cli: false },
};

const response = (body: unknown, status = 200, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

function setup(result: Response | (() => Promise<Response>) = response({ ok: true }), token: string | null = 'secret-access') {
  const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => typeof result === 'function' ? await result() : result);
  const client = new ConsoleClient({ baseUrl: 'https://console.example', getAccessToken: async () => token, fetch: fetcher });
  return { client, fetcher };
}

afterEach(() => vi.useRealTimers());

describe('device SDK and HTTP contracts', () => {
  it('keeps bearer credentials in headers and disables cookies and redirects', async () => {
    const { client, fetcher } = setup(response({ sessions: [], totalCount: 0 }));
    await client.sessions(200, '中文会话');
    const [url, options] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(new URL(url).origin).toBe('https://console.example');
    expect(new URL(url).searchParams.get('q')).toBe('中文会话');
    expect(url).not.toContain('secret-access');
    expect(options).toMatchObject({ credentials: 'omit', cache: 'no-store', redirect: 'error', headers: { Authorization: 'Bearer secret-access', 'X-HS': '1' } });
  });

  it.each(['http://console.example', 'https://name:password@console.example', 'https://console.example/path', 'https://console.example?token=x', 'https://console.example#x'])('rejects unsafe connection address %s', baseUrl => {
    expect(() => new ConsoleClient({ baseUrl, getAccessToken: async () => null })).toThrow(ApiError);
  });

  it('does not send stale access credentials during password login or refresh', async () => {
    const { client, fetcher } = setup(() => Promise.resolve(response(pair)));
    expect(await client.login('password', '测试手机')).toEqual(pair);
    expect(await client.refresh('refresh-old')).toEqual(pair);
    for (const call of fetcher.mock.calls) {
      const init = call[1] as RequestInit;
      expect(init.headers).not.toHaveProperty('Authorization');
      expect(init.credentials).toBe('omit');
    }
    expect(fetcher.mock.calls[0]?.[0]).toBe('https://console.example/api/mobile/login');
    expect(fetcher.mock.calls[1]?.[0]).toBe('https://console.example/api/mobile/refresh');
  });

  it('permits public capability discovery while signed out and checks response shape', async () => {
    const { client, fetcher } = setup(response(capabilities), null);
    expect(await client.capabilities()).toEqual(capabilities);
    expect(fetcher.mock.calls[0]?.[1]?.headers).not.toHaveProperty('Authorization');
    const malformed = setup(response({ apiVersion: 1 }), null);
    await expect(malformed.client.capabilities()).rejects.toMatchObject({ kind: 'protocol' });
  });

  it('rejects malformed auth responses instead of storing an invalid token pair', async () => {
    const { client } = setup(response({ ...pair, accessExpiresAt: 'tomorrow' }));
    await expect(client.login('pass', 'phone')).rejects.toMatchObject({ kind: 'protocol' });
  });

  it('does not dispatch protected requests without credentials', async () => {
    const { client, fetcher } = setup(response({}), null);
    await expect(client.overview()).rejects.toMatchObject({ status: 401, kind: 'unauthorized', code: 'AUTH_REQUIRED' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    [401, 'unauthorized'], [403, 'forbidden'], [404, 'not-found'], [409, 'conflict'], [429, 'rate-limited'], [503, 'server'],
  ])('classifies HTTP %s separately', async (status, kind) => {
    const { client } = setup(response({ error: 'failure', code: 'SERVER_CODE' }, status));
    await expect(client.overview()).rejects.toMatchObject({ status, kind, code: 'SERVER_CODE', outcomeUnknown: false });
  });

  it('preserves Retry-After without automatically retrying', async () => {
    const { client, fetcher } = setup(response({ error: 'rate' }, 429, { 'Retry-After': '12' }));
    await expect(client.overview()).rejects.toMatchObject({ retryAfterMs: 12_000 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('treats malformed success JSON as a protocol failure', async () => {
    const { client } = setup(new Response('<html>error</html>'));
    await expect(client.overview()).rejects.toMatchObject({ kind: 'protocol' });
  });

  it('marks a lost execution response unknown and never repeats the POST', async () => {
    const { client, fetcher } = setup(async () => { throw new TypeError('Failed to fetch'); });
    await expect(client.send({ key: 'session', message: 'hello', deliver: false, requestId: 'stable-1' })).rejects.toMatchObject({ kind: 'network', outcomeUnknown: true });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetcher.mock.calls[0]?.[1]?.body as string).requestId).toBe('stable-1');
  });

  it('does not treat an idempotency content conflict as an unknown execution', async () => {
    const { client } = setup(response({ code: 'request_conflict', error: 'conflict' }, 409));
    await expect(client.send({ key: 's', message: 'different', deliver: false, requestId: 'stable-1' })).rejects.toMatchObject({ kind: 'conflict', outcomeUnknown: false });
  });

  it('preserves pending/unknown request semantics and queries with GET', async () => {
    const { client, fetcher } = setup(response({ requestId: 'stable-1', state: 'completed', result: { runId: 'run-1' } }));
    expect(await client.requestStatus('stable-1')).toMatchObject({ state: 'completed' });
    expect(fetcher.mock.calls[0]?.[0]).toBe('https://console.example/api/mobile/requests/stable-1');
    expect(fetcher.mock.calls[0]?.[1]?.method).toBe('GET');
  });

  it('requires a persisted stable requestId before an execution can dispatch', async () => {
    const { client, fetcher } = setup();
    await expect(client.send({ key: 's', message: 'hello', deliver: false, requestId: '' })).rejects.toMatchObject({ kind: 'request' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('bounds timeout, aborts the fetch and marks execution state unknown', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    }));
    const client = new ConsoleClient({ baseUrl: 'https://console.example', getAccessToken: async () => 'token', fetch: fetcher });
    const request = client.send({ key: 's', message: 'hello', deliver: false, requestId: 'stable-1' });
    const assertion = expect(request).rejects.toMatchObject({ kind: 'timeout', outcomeUnknown: true });
    await vi.advanceTimersByTimeAsync(40_001);
    await assertion;
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('supports aborting local observation without calling remote cancellation', async () => {
    const controller = new AbortController();
    const fetcher = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    }));
    const client = new ConsoleClient({ baseUrl: 'https://console.example', getAccessToken: async () => 'token', fetch: fetcher });
    const request = client.overview(controller.signal);
    await Promise.resolve();
    await Promise.resolve();
    controller.abort();
    await expect(request).rejects.toMatchObject({ kind: 'aborted' });
    expect(fetcher.mock.calls.map(call => String(call[0]))).toEqual(['https://console.example/api/overview']);
  });

  it('rejects redirects even when a custom fetch ignores redirect:error', async () => {
    const redirected = response({ ok: true });
    Object.defineProperty(redirected, 'url', { value: 'https://untrusted.example/api/overview' });
    const { client } = setup(redirected);
    await expect(client.overview()).rejects.toMatchObject({ kind: 'protocol' });
  });

  it('loads authenticated media as Blob and never creates a token-bearing URL', async () => {
    const { client, fetcher } = setup(new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'image/png' } }));
    const blob = await client.media({ path: '/home/ubuntu/.openclaw/media/中文.png' });
    expect(blob.type).toBe('image/png');
    expect(blob.size).toBe(3);
    const url = new URL(fetcher.mock.calls[0]?.[0] as string);
    expect(url.searchParams.get('path')).toBe('/home/ubuntu/.openclaw/media/中文.png');
    expect(url.searchParams.has('token')).toBe(false);
    expect(fetcher.mock.calls[0]?.[1]?.headers).toMatchObject({ Authorization: 'Bearer secret-access' });
  });
});

function eventResponse(parts: Uint8Array[]): Response {
  return new Response(new ReadableStream({
    start(controller) { parts.forEach(part => controller.enqueue(part)); controller.close(); },
  }), { headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } });
}

describe('incremental CLI SSE', () => {
  it('handles CRLF split across chunks, comments and multiline data', () => {
    const parser = new SseParser();
    expect(parser.feed(': heartbeat\r')).toEqual([]);
    expect(parser.feed('\nevent: delta\r\ndata: first\r')).toEqual([]);
    expect(parser.feed('\ndata: second\r\n\r')).toEqual([]);
    expect(parser.feed('\n')).toEqual([{ event: 'delta', data: 'first\nsecond' }]);
  });

  it('decodes split UTF-8 characters before emitting events', async () => {
    const bytes = new TextEncoder().encode('event: delta\ndata: {"text":"中文"}\n\nevent: done\ndata: {"exitCode":0}\n\n');
    const events = [];
    for await (const event of readEventStream(eventResponse(Array.from(bytes, byte => new Uint8Array([byte]))).body!)) events.push(event);
    expect(events).toEqual([{ event: 'delta', data: { text: '中文' } }, { event: 'done', data: { exitCode: 0 } }]);
  });

  it('emits incrementally while the response stream is still open', async () => {
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(controller) { streamController = controller; } });
    const iterator = readEventStream(body);
    const first = iterator.next();
    streamController.enqueue(new TextEncoder().encode('event: delta\ndata: {"text":"first"}\n\n'));
    expect(await first).toMatchObject({ done: false, value: { event: 'delta', data: { text: 'first' } } });
    streamController.close();
    expect(await iterator.next()).toMatchObject({ done: true });
  });

  it('does not accept truncated data as a complete event', () => {
    const parser = new SseParser();
    expect(parser.feed('event: done\ndata: {"exitCode":0}\n')).toEqual([]);
    expect(parser.finish()).toEqual([]);
  });

  it('limits an unbounded SSE event', () => {
    const parser = new SseParser(20);
    expect(() => parser.feed('data: ' + 'x'.repeat(30))).toThrow(ApiError);
  });

  it('requires a terminal done event before marking CLI observation complete', async () => {
    const { client, fetcher } = setup(eventResponse([new TextEncoder().encode('event: start\ndata: {"runId":"run-1"}\n\n')]));
    const onEvent = vi.fn();
    await expect(client.cliRun('cli-1', { prompt: 'hello', requestId: 'stable-1' }, onEvent)).rejects.toMatchObject({ kind: 'stream-disconnected', outcomeUnknown: true });
    expect(onEvent).toHaveBeenCalledWith({ event: 'start', data: { runId: 'run-1' } });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[0]).not.toContain('/cancel');
  });

  it('distinguishes successful SSE termination from an HTTP error', async () => {
    const { client } = setup(eventResponse([new TextEncoder().encode('event: done\ndata: {"exitCode":0,"durationMs":40}\n\n')]));
    await expect(client.cliRun('cli-1', { prompt: 'hello', requestId: 'stable-1' }, () => {})).resolves.toBeUndefined();
    const denied = setup(response({ code: 'FORBIDDEN', error: 'no CLI permission' }, 403));
    await expect(denied.client.cliRun('cli-1', { prompt: 'hello', requestId: 'stable-1' }, () => {})).rejects.toMatchObject({ kind: 'forbidden', outcomeUnknown: false });
  });

  it('recognizes a replayed CLI submission receipt without assuming the task has completed', async () => {
    const receipt = { sessionId: 'cli-1', runId: 'run-1', state: 'running' };
    const { client, fetcher } = setup(response(receipt));
    const onEvent = vi.fn();
    await expect(client.cliRun('cli-1', { prompt: 'hello', requestId: 'stable-1' }, onEvent)).resolves.toEqual(receipt);
    expect(onEvent).toHaveBeenCalledWith({ event: 'receipt', data: receipt });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

class FakeXHR {
  method = '';
  url = '';
  responseURL = '';
  status = 200;
  responseText = JSON.stringify({ id: 'upload-1', name: '中文.txt', size: 3 });
  timeout = 0;
  withCredentials = false;
  headers: Record<string, string> = {};
  body: Blob | null = null;
  upload: { onprogress?: (event: ProgressEvent) => void } = {};
  onload?: () => void;
  onerror?: () => void;
  ontimeout?: () => void;
  onabort?: () => void;
  open(method: string, url: string) { this.method = method; this.url = url; }
  setRequestHeader(name: string, value: string) { this.headers[name] = value; }
  getResponseHeader(name: string) { return name === 'Retry-After' ? '2' : null; }
  send(body: Blob) { this.body = body; }
  abort() { this.onabort?.(); }
}

describe('raw binary upload transport', () => {
  it('uses raw bytes, encoded filenames, progress and the same device identity', async () => {
    const xhr = new FakeXHR();
    const client = new ConsoleClient({ baseUrl: 'https://console.example', getAccessToken: async () => 'token', xhrFactory: () => xhr as unknown as XMLHttpRequest });
    const progress = vi.fn();
    const blob = new Blob(['abc']);
    const task = client.upload(blob, { scope: 'chat', session: 'session-1', name: '中文.txt' }, progress);
    await Promise.resolve();
    await Promise.resolve();
    expect(xhr.method).toBe('POST');
    expect(new URL(xhr.url).searchParams.get('name')).toBe('中文.txt');
    expect(xhr.body).toBe(blob);
    expect(xhr.headers).toMatchObject({ Authorization: 'Bearer token', 'X-HS': '1', 'Content-Type': 'application/octet-stream' });
    expect(xhr.withCredentials).toBe(false);
    xhr.upload.onprogress?.({ lengthComputable: true, loaded: 2, total: 4 } as ProgressEvent);
    expect(progress).toHaveBeenCalledWith(0.5);
    xhr.onload?.();
    await expect(task.promise).resolves.toMatchObject({ id: 'upload-1' });
  });

  it('can cancel before secure token retrieval has finished without sending bytes', async () => {
    let finishToken!: (value: string) => void;
    const xhr = new FakeXHR();
    const factory = vi.fn(() => xhr as unknown as XMLHttpRequest);
    const client = new ConsoleClient({ baseUrl: 'https://console.example', getAccessToken: () => new Promise(resolve => { finishToken = resolve; }), xhrFactory: factory });
    const task = client.upload(new Blob(['abc']), { scope: 'chat', session: 's', name: 'a.txt' });
    task.abort();
    finishToken('token');
    await expect(task.promise).rejects.toMatchObject({ kind: 'aborted' });
    expect(factory).not.toHaveBeenCalled();
  });

  it('propagates upload conflicts and refuses a cross-origin final response', async () => {
    const xhr = new FakeXHR();
    const client = new ConsoleClient({ baseUrl: 'https://console.example', getAccessToken: async () => 'token', xhrFactory: () => xhr as unknown as XMLHttpRequest });
    const task = client.upload(new Blob(['abc']), { scope: 'chat', session: 's', name: 'a.txt' });
    await Promise.resolve();
    await Promise.resolve();
    xhr.status = 409;
    xhr.responseText = JSON.stringify({ error: 'wrong session', code: 'attachment_conflict' });
    xhr.onload?.();
    await expect(task.promise).rejects.toMatchObject({ kind: 'conflict', code: 'attachment_conflict' });

    const second = client.upload(new Blob(['abc']), { scope: 'chat', session: 's', name: 'a.txt' });
    await Promise.resolve();
    await Promise.resolve();
    xhr.responseURL = 'https://untrusted.example/file';
    xhr.onload?.();
    await expect(second.promise).rejects.toMatchObject({ kind: 'protocol' });
  });
});
