import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { createMockServer, MOCK_PASSWORD, MOCK_SESSION } from '../mock/server';
import { readEventStream } from '../src/api';

let server: Server;
let base: string;
let accessToken: string;
let refreshToken: string;

const writeHeaders = { 'Content-Type': 'application/json', 'X-HS': '1' };
const headers = () => ({ ...writeHeaders, Authorization: `Bearer ${accessToken}` });

beforeEach(async () => {
  server = createMockServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test address');
  base = `http://127.0.0.1:${address.port}`;
  const login = await fetch(`${base}/api/mobile/login`, { method: 'POST', headers: writeHeaders, body: JSON.stringify({ password: MOCK_PASSWORD, deviceName: 'Test Android' }) });
  const pair = await login.json();
  accessToken = pair.accessToken;
  refreshToken = pair.refreshToken;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

describe('strict mock HTTP fixture', () => {
  it('rejects unknown routes and wrong methods instead of returning a success placeholder', async () => {
    for (const [method, path] of [['GET', '/api/not-real'], ['POST', '/api/overview'], ['DELETE', '/api/send']]) {
      const res = await fetch(`${base}${path}`, { method });
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({ code: 'MOCK_ROUTE_NOT_FOUND' });
    }
  });

  it('distinguishes public capability discovery, authenticated permission and bad auth', async () => {
    const publicCapabilities = await (await fetch(`${base}/api/mobile/capabilities`)).json();
    expect(publicCapabilities.permissions.cli).toBe(false);
    const privateCapabilities = await (await fetch(`${base}/api/mobile/capabilities`, { headers: headers() })).json();
    expect(privateCapabilities.permissions.cli).toBe(true);
    expect((await fetch(`${base}/api/overview`)).status).toBe(401);
    expect((await fetch(`${base}/api/mobile/login`, { method: 'POST', headers: writeHeaders, body: JSON.stringify({ password: 'incorrect', deviceName: 'phone' }) })).status).toBe(401);
  });

  it('requires write protection and valid JSON objects', async () => {
    expect((await fetch(`${base}/api/send`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` }, body: '{}' })).status).toBe(403);
    expect((await fetch(`${base}/api/send`, { method: 'POST', headers: headers(), body: 'not-json' })).status).toBe(400);
    expect((await fetch(`${base}/api/send`, { method: 'POST', headers: headers(), body: '[]' })).status).toBe(400);
  });

  it('rotates both tokens, rejects old credentials and revokes on logout', async () => {
    const refreshed = await (await fetch(`${base}/api/mobile/refresh`, { method: 'POST', headers: writeHeaders, body: JSON.stringify({ refreshToken }) })).json();
    expect(refreshed.accessToken).not.toBe(accessToken);
    expect(refreshed.refreshToken).not.toBe(refreshToken);
    expect((await fetch(`${base}/api/overview`, { headers: headers() })).status).toBe(401);
    expect((await fetch(`${base}/api/mobile/refresh`, { method: 'POST', headers: writeHeaders, body: JSON.stringify({ refreshToken }) })).status).toBe(401);
    accessToken = refreshed.accessToken;
    expect((await fetch(`${base}/api/mobile/logout`, { method: 'POST', headers: headers(), body: '{}' })).status).toBe(200);
    const revoked = await fetch(`${base}/api/overview`, { headers: headers() });
    expect(revoked.status).toBe(401);
    expect(await revoked.json()).toMatchObject({ code: 'AUTH_REVOKED' });
    expect((await fetch(`${base}/api/mobile/refresh`, { method: 'POST', headers: writeHeaders, body: JSON.stringify({ refreshToken: refreshed.refreshToken }) })).status).toBe(401);
  });

  it.each([401, 403, 429, 500])('provides explicit test-only HTTP %s scenarios', async status => {
    const res = await fetch(`${base}/api/overview`, { headers: { ...headers(), 'X-Mock-Scenario': String(status) } });
    expect(res.status).toBe(status);
    if (status === 429) expect(res.headers.get('Retry-After')).toBe('2');
  });

  it('can delay a known request for timeout testing', async () => {
    const start = Date.now();
    const res = await fetch(`${base}/api/overview`, { headers: { ...headers(), 'X-Mock-Scenario': 'delay', 'X-Mock-Delay': '30' } });
    expect(res.status).toBe(200);
    expect(Date.now() - start).toBeGreaterThanOrEqual(25);
  });

  it('replays the same send result once and rejects a changed payload with the same ID', async () => {
    const payload = { key: MOCK_SESSION, message: '测试消息', deliver: false, requestId: 'stable-request-1' };
    const send = () => fetch(`${base}/api/send`, { method: 'POST', headers: headers(), body: JSON.stringify(payload) });
    const first = await (await send()).json();
    const second = await (await send()).json();
    expect(first.runId).toBe(second.runId);
    const conflict = await fetch(`${base}/api/send`, { method: 'POST', headers: headers(), body: JSON.stringify({ ...payload, message: 'changed' }) });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ code: 'request_conflict' });
    const history = await (await fetch(`${base}/api/history?key=${MOCK_SESSION}`, { headers: headers() })).json();
    expect(history.messages).toHaveLength(4);
    const result = await (await fetch(`${base}/api/mobile/requests/${payload.requestId}`, { headers: headers() })).json();
    expect(result).toMatchObject({ state: 'completed', result: first });
    expect(result).not.toHaveProperty('digest');
  });

  it('can lose a submission response while preserving its queryable receipt', async () => {
    const payload = { key: MOCK_SESSION, message: 'lost response', deliver: false, requestId: 'stable-request-2' };
    await expect(fetch(`${base}/api/send`, { method: 'POST', headers: { ...headers(), 'X-Mock-Scenario': 'drop-after-accept' }, body: JSON.stringify(payload) })).rejects.toThrow();
    const record = await (await fetch(`${base}/api/mobile/requests/${payload.requestId}`, { headers: headers() })).json();
    expect(record.state).toBe('completed');
    expect(record.result.runId).toBeTypeOf('string');
  });

  it('shares owner-scoped request receipts across replacement device logins', async () => {
    const payload = { key: MOCK_SESSION, message: 'owner scoped', deliver: false, requestId: 'stable-owner-request' };
    const original = await (await fetch(`${base}/api/send`, { method: 'POST', headers: headers(), body: JSON.stringify(payload) })).json();
    const replacement = await (await fetch(`${base}/api/mobile/login`, { method: 'POST', headers: writeHeaders, body: JSON.stringify({ password: MOCK_PASSWORD, deviceName: 'Replacement phone' }) })).json();
    accessToken = replacement.accessToken;
    const receipt = await (await fetch(`${base}/api/mobile/requests/${payload.requestId}`, { headers: headers() })).json();
    expect(receipt).toMatchObject({ state: 'completed', result: original });
    const replay = await (await fetch(`${base}/api/send`, { method: 'POST', headers: headers(), body: JSON.stringify(payload) })).json();
    expect(replay.runId).toBe(original.runId);
    const history = await (await fetch(`${base}/api/history?key=${MOCK_SESSION}`, { headers: headers() })).json();
    expect(history.messages).toHaveLength(4);
  });

  it('does not reinterpret an unknown request ID as safe to execute', async () => {
    const missing = await fetch(`${base}/api/mobile/requests/unknown-request`, { headers: headers() });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ code: 'request_not_found' });
  });

  it('accepts raw bytes and Chinese filenames, authorizes download and deletes uploads', async () => {
    const query = new URLSearchParams({ scope: 'chat', session: MOCK_SESSION, name: '中文文件.txt' });
    const uploaded = await fetch(`${base}/api/uploads?${query}`, { method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'X-HS': '1', 'Content-Type': 'application/octet-stream' }, body: new Uint8Array([1, 2, 3]) });
    expect(uploaded.status).toBe(200);
    const file = await uploaded.json();
    expect(file).toMatchObject({ name: '中文文件.txt', size: 3, session: MOCK_SESSION });
    expect((await fetch(`${base}${file.url}`)).status).toBe(401);
    const downloaded = await fetch(`${base}${file.url}?download=1`, { headers: headers() });
    expect([...new Uint8Array(await downloaded.arrayBuffer())]).toEqual([1, 2, 3]);
    expect((await fetch(`${base}${file.url}`, { method: 'DELETE', headers: headers() })).status).toBe(200);
    expect((await fetch(`${base}${file.url}`, { headers: headers() })).status).toBe(404);
    expect((await fetch(`${base}/api/uploads?${query}`, { method: 'POST', headers: headers(), body: '{}' })).status).toBe(415);
  });

  it('enforces returned fixture upload limits and does not fetch supplied media URLs', async () => {
    const limits = await (await fetch(`${base}/api/uploads/limits`, { headers: headers() })).json();
    const query = new URLSearchParams({ scope: 'chat', session: MOCK_SESSION, name: 'oversize.bin' });
    const tooLarge = await fetch(`${base}/api/uploads?${query}`, { method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'X-HS': '1', 'Content-Type': 'application/octet-stream' }, body: new Uint8Array(limits.maxBytes + 1) });
    expect(tooLarge.status).toBe(413);
    const media = await fetch(`${base}/api/media?url=https://example.invalid/should-never-be-fetched`, { headers: headers() });
    expect(media.status).toBe(200);
    expect(media.headers.get('Content-Type')).toBe('image/png');
  });

  it('models incremental CLI output, terminal query state and a cached submission receipt', async () => {
    expect(await (await fetch(`${base}/api/cli/sessions`, { headers: headers() })).json()).toEqual([]);
    const session = await (await fetch(`${base}/api/cli/sessions`, { method: 'POST', headers: headers(), body: JSON.stringify({ tool: 'mock-cli' }) })).json();
    const request = { prompt: '测试', requestId: 'stable-cli-request' };
    const run = await fetch(`${base}/api/cli/sessions/${session.id}/run`, { method: 'POST', headers: headers(), body: JSON.stringify(request) });
    const events = [];
    for await (const event of readEventStream(run.body!)) events.push(event);
    expect(events.map(event => event.event)).toEqual(['start', 'delta', 'done']);
    const restored = await (await fetch(`${base}/api/cli/sessions/${session.id}`, { headers: headers() })).json();
    expect(restored.session).toMatchObject({ running: false, lastRun: { state: 'completed', exitCode: 0 } });
    const repeated = await (await fetch(`${base}/api/cli/sessions/${session.id}/run`, { method: 'POST', headers: headers(), body: JSON.stringify(request) })).json();
    expect(repeated).toMatchObject({ sessionId: session.id, runId: restored.session.lastRun.runId });
    const afterReplay = await (await fetch(`${base}/api/cli/sessions/${session.id}`, { headers: headers() })).json();
    expect(afterReplay.messages).toHaveLength(2);
  });
});
