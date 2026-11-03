import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

/** Development fixtures only. This server never connects to OpenClaw or QQ. */
export const MOCK_PASSWORD = 'mock-password';
export const MOCK_SESSION = 'agent:main:main';

type ObjectValue = Record<string, unknown>;
type Device = { id: string; name: string; createdAt: number; updatedAt: number; revokedAt: number | null; accessToken: string; refreshToken: string };
type StoredRequest = { requestId: string; digest: string; state: string; status: number; result: unknown };

class HttpFailure extends Error {
  constructor(readonly status: number, message: string, readonly code = 'MOCK_REQUEST_ERROR') { super(message); }
}

const object = (value: unknown): value is ObjectValue => typeof value === 'object' && value !== null && !Array.isArray(value);
const json = (res: ServerResponse, status: number, value: unknown) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
};

async function bytes(req: IncomingMessage, maximum: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maximum) throw new HttpFailure(413, '附件或请求体超过 Mock 上限', 'too_large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

async function body(req: IncomingMessage): Promise<ObjectValue> {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new HttpFailure(415, '需要 application/json');
  const raw = await bytes(req, 1024 * 1024);
  try {
    const value: unknown = JSON.parse(raw.toString('utf8'));
    if (!object(value)) throw new Error();
    return value;
  } catch { throw new HttpFailure(400, '无效 JSON 请求体'); }
}

function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new HttpFailure(400, `缺少 ${name}`);
  return value;
}

const fingerprint = (value: unknown): string => {
  const normalize = (input: unknown): unknown => Array.isArray(input) ? input.map(normalize) : object(input)
    ? Object.fromEntries(Object.keys(input).sort().map(key => [key, normalize(input[key])])) : input;
  return createHash('sha256').update(JSON.stringify(normalize(value))).digest('hex');
};

export function createMockServer() {
  const devices = new Map<string, Device>();
  const requests = new Map<string, StoredRequest>();
  const uploads = new Map<string, { metadata: ObjectValue; bytes: Buffer }>();
  const messages: ObjectValue[] = [
    { id: 'fixture-user-1', index: 0, role: 'user', content: [{ type: 'text', text: '查看远程服务的状态。' }], timestamp: Date.now() - 10000 },
    { id: 'fixture-assistant-1', index: 1, role: 'assistant', content: [{ type: 'text', text: '这是本地 Mock 会话。可以安全测试发送、附件和恢复流程，不会投递到 QQ。' }], timestamp: Date.now() - 9000 },
  ];
  const cliSessions = new Map<string, ObjectValue>();
  const cliMessages = new Map<string, ObjectValue[]>();
  const limits = { maxBytes: 2 * 1024 * 1024, maxPerMessage: 4, ttlDays: 1, chat: { maxBytes: 2 * 1024 * 1024, maxImageBytes: 2 * 1024 * 1024, maxPayload: 4 * 1024 * 1024, fromGateway: true }, cli: { maxBytes: 2 * 1024 * 1024, claudeInlineImageMax: 2 * 1024 * 1024 } };

  const getDevice = (req: IncomingMessage, optional = false): Device | undefined => {
    const authorization = req.headers.authorization;
    if (!authorization && optional) return undefined;
    if (!authorization?.startsWith('Bearer ')) throw new HttpFailure(401, '请先登录 Mock 设备', 'AUTH_REQUIRED');
    const device = [...devices.values()].find(item => item.accessToken === authorization.slice(7));
    if (!device) throw new HttpFailure(401, '设备凭据已过期', 'AUTH_EXPIRED');
    if (device.revokedAt) throw new HttpFailure(401, '设备已撤销', 'AUTH_REVOKED');
    return device;
  };

  const pair = (device: Device) => ({
    device: { id: device.id, name: device.name }, accessToken: device.accessToken, refreshToken: device.refreshToken,
    accessExpiresAt: Date.now() + 15 * 60000, refreshExpiresAt: Date.now() + 30 * 86400000,
  });

  const execute = (device: Device, kind: string, payload: ObjectValue, result: () => unknown): { record: StoredRequest; replay: boolean } => {
    const requestId = text(payload.requestId, 'requestId');
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/.test(requestId)) throw new HttpFailure(400, 'requestId 格式无效');
    // All devices map to the existing single owner, matching MobileRuntime.
    const key = `owner:${requestId}`;
    const digest = fingerprint({ kind, payload });
    const prior = requests.get(key);
    if (prior) {
      if (prior.digest !== digest) throw new HttpFailure(409, '相同 requestId 的内容不同', 'request_conflict');
      return { record: prior, replay: true };
    }
    const record: StoredRequest = { requestId, digest, state: 'pending', status: 202, result: null };
    requests.set(key, record);
    record.result = result();
    record.state = 'completed';
    record.status = 200;
    return { record, replay: false };
  };

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const route = `${req.method} ${url.pathname}`;
      // Unknown routes/methods never succeed, even before authentication.
      const known = new Set([
        'GET /api/mobile/capabilities', 'POST /api/mobile/login', 'POST /api/mobile/refresh', 'POST /api/mobile/logout',
        'GET /api/mobile/devices', 'GET /api/me', 'GET /api/overview', 'GET /api/sessions', 'GET /api/history',
        'POST /api/send', 'POST /api/abort', 'GET /api/models', 'GET /api/logs', 'GET /api/uploads/limits', 'POST /api/uploads',
        'GET /api/media', 'GET /api/cli/tools', 'GET /api/cli/sessions', 'POST /api/cli/sessions',
      ]);
      const dynamic = /^(GET \/api\/mobile\/requests\/[A-Za-z0-9_-]+|DELETE \/api\/mobile\/devices\/[A-Za-z0-9_-]+|(?:GET|DELETE) \/api\/uploads\/[A-Za-z0-9_-]+|GET \/api\/cli\/sessions\/[A-Za-z0-9_-]+|POST \/api\/cli\/sessions\/[A-Za-z0-9_-]+\/(?:run|cancel))$/.test(route);
      if (!known.has(route) && !dynamic) throw new HttpFailure(404, '未知 Mock 方法或接口', 'MOCK_ROUTE_NOT_FOUND');
      const scenario = String(req.headers['x-mock-scenario'] ?? '');
      const forced = ({ '401': 401, '403': 403, '429': 429, '500': 500 } as Record<string, number>)[scenario];
      if (forced) {
        if (forced === 429) res.setHeader('Retry-After', '2');
        throw new HttpFailure(forced, `Mock ${forced}`, forced === 401 ? 'AUTH_EXPIRED' : forced === 403 ? 'FORBIDDEN' : `MOCK_${forced}`);
      }
      if (scenario === 'delay') await new Promise(resolve => setTimeout(resolve, Math.min(10_000, Math.max(1, Number(req.headers['x-mock-delay'] ?? 200)))));
      if (['POST', 'DELETE'].includes(req.method ?? '') && req.headers['x-hs'] !== '1') throw new HttpFailure(403, '缺少 X-HS 请求头', 'FORBIDDEN');

      if (route === 'GET /api/mobile/capabilities') {
        const device = getDevice(req, true);
        return json(res, 200, { apiVersion: 1, build: 'strict-mock-v1', auth: ['device-bearer'], modules: { overview: true, sessions: true, chat: true, uploads: true, cli: true, management: false }, permissions: { cli: Boolean(device) }, limits: { uploadMaxBytes: limits.maxBytes, maxPerMessage: limits.maxPerMessage } });
      }
      if (route === 'POST /api/mobile/login') {
        const payload = await body(req);
        if (payload.password !== MOCK_PASSWORD) throw new HttpFailure(401, 'Mock 密码错误', 'AUTH_INVALID');
        const now = Date.now();
        const device: Device = { id: randomUUID(), name: text(payload.deviceName, 'deviceName'), createdAt: now, updatedAt: now, revokedAt: null, accessToken: randomUUID(), refreshToken: randomUUID() };
        devices.set(device.id, device);
        return json(res, 200, pair(device));
      }
      if (route === 'POST /api/mobile/refresh') {
        const payload = await body(req);
        const device = [...devices.values()].find(item => item.refreshToken === payload.refreshToken);
        if (!device) throw new HttpFailure(401, '刷新凭据已过期', 'AUTH_EXPIRED');
        if (device.revokedAt) throw new HttpFailure(401, '设备已撤销', 'AUTH_REVOKED');
        device.accessToken = randomUUID(); device.refreshToken = randomUUID(); device.updatedAt = Date.now();
        return json(res, 200, pair(device));
      }

      const device = getDevice(req)!;
      if (route === 'POST /api/mobile/logout') { device.revokedAt = Date.now(); return json(res, 200, { ok: true }); }
      if (route === 'GET /api/mobile/devices') return json(res, 200, { devices: [...devices.values()].map(({ accessToken: _a, refreshToken: _r, ...summary }) => summary) });
      if (route.startsWith('DELETE /api/mobile/devices/')) {
        const target = devices.get(url.pathname.split('/').at(-1)!);
        if (!target) throw new HttpFailure(404, '设备不存在');
        target.revokedAt = Date.now(); return json(res, 200, { ok: true });
      }
      if (route === 'GET /api/me') return json(res, 200, { authed: true, isOwner: true });
      if (route === 'GET /api/overview') return json(res, 200, { info: { version: 'mock', platform: 'linux', uptime: 3600 }, health: { ok: true }, status: { running: true }, host: { cpu: 8, load: [0.2, 0.1, 0.1], mem: { total: 8 * 1024 ** 3, used: 2 * 1024 ** 3 }, uptime: 3600 }, gw: { active: true }, server: { version: 'mock' } });
      if (route === 'GET /api/sessions') {
        const sessions = [{ key: MOCK_SESSION, displayName: '主会话', channel: 'console', hasActiveRun: false, updatedAt: Date.now(), model: 'mock-model' }];
        const q = (url.searchParams.get('q') ?? '').toLowerCase();
        const offset = Math.max(0, Number(url.searchParams.get('offset') ?? 0));
        return json(res, 200, { sessions: sessions.slice(offset, offset + 200).filter(item => `${item.key} ${item.displayName}`.toLowerCase().includes(q)), totalCount: sessions.length });
      }
      if (route === 'GET /api/history') {
        if (url.searchParams.get('key') !== MOCK_SESSION) throw new HttpFailure(404, '会话不存在');
        const before = url.searchParams.get('before');
        const end = before ? messages.findIndex(item => item.id === before) : messages.length;
        if (end < 0) throw new HttpFailure(400, 'before 无效');
        const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit') ?? 60)));
        const start = Math.max(0, end - limit);
        return json(res, 200, { messages: messages.slice(start, end), hasMore: start > 0, nextBefore: start > 0 ? messages[start]?.id : null, gatewayHasMore: false, windowCount: messages.length });
      }
      if (route === 'POST /api/send') {
        const payload = await body(req);
        if (payload.key !== MOCK_SESSION) throw new HttpFailure(404, '会话不存在');
        const attachments = Array.isArray(payload.attachments) ? payload.attachments : [];
        if ((!payload.message || typeof payload.message !== 'string' || !payload.message.trim()) && !attachments.length) throw new HttpFailure(400, '缺少发送内容');
        if (attachments.some(id => typeof id !== 'string' || uploads.get(id)?.metadata.session !== MOCK_SESSION)) throw new HttpFailure(403, '附件不属于当前会话');
        const { record } = execute(device, 'chat.send', payload, () => {
          const runId = randomUUID();
          messages.push({ id: randomUUID(), index: messages.length, role: 'user', content: [{ type: 'text', text: payload.message ?? '' }], timestamp: Date.now(), attachments: attachments.map(id => uploads.get(String(id))?.metadata) });
          messages.push({ id: randomUUID(), index: messages.length, role: 'assistant', content: [{ type: 'text', text: 'Mock 已收到消息。此回复只用于本地验收，不触发真实执行。' }], timestamp: Date.now(), runId });
          return { runId, status: 'accepted' };
        });
        if (scenario === 'drop-after-accept') { req.socket.destroy(); return; }
        return json(res, record.status, record.result);
      }
      if (route.startsWith('GET /api/mobile/requests/')) {
        const record = requests.get(`owner:${url.pathname.split('/').at(-1)}`);
        if (!record) throw new HttpFailure(404, '未找到请求记录；不能据此推断历史执行情况', 'request_not_found');
        const { digest: _digest, ...publicRecord } = record;
        return json(res, 200, publicRecord);
      }
      if (route === 'POST /api/abort') { const payload = await body(req); text(payload.key, 'key'); return json(res, 200, { ok: true, aborted: false }); }
      if (route === 'GET /api/models') return json(res, 200, { models: [{ id: 'mock-model', name: 'Mock 模型', provider: 'fixture', available: true, availability: 'available' }] });
      if (route === 'GET /api/logs') return json(res, 200, { lines: [{ ts: new Date().toISOString(), level: 'INFO', message: '严格 Mock 已启动；无真实服务器连接。' }] });
      if (route === 'GET /api/uploads/limits') return json(res, 200, limits);
      if (route === 'POST /api/uploads') {
        if (req.headers['content-type'] !== 'application/octet-stream') throw new HttpFailure(415, '上传必须是原始二进制');
        const scope = url.searchParams.get('scope');
        const session = text(url.searchParams.get('session'), 'session');
        const name = text(url.searchParams.get('name'), 'name');
        if (!['chat', 'cli'].includes(scope ?? '')) throw new HttpFailure(400, '上传 scope 无效');
        if ((scope === 'chat' && session !== MOCK_SESSION) || (scope === 'cli' && !cliSessions.has(session))) throw new HttpFailure(404, '附件目标会话不存在');
        const data = await bytes(req, limits.maxBytes);
        const id = randomUUID();
        const mime = /\.png$/i.test(name) ? 'image/png' : /\.jpe?g$/i.test(name) ? 'image/jpeg' : /\.mp3$/i.test(name) ? 'audio/mpeg' : 'application/octet-stream';
        const metadata = { id, scope, session, name, mime, kind: mime.startsWith('image/') ? 'image' : mime.startsWith('audio/') ? 'audio' : 'file', size: data.length, url: `/api/uploads/${id}`, createdAt: Date.now(), attachedAt: null, expiresAt: Date.now() + 86400000 };
        uploads.set(id, { metadata, bytes: data });
        return json(res, 200, metadata);
      }
      if (/^(GET|DELETE) \/api\/uploads\//.test(route)) {
        const id = url.pathname.split('/').at(-1)!;
        const upload = uploads.get(id);
        if (!upload) throw new HttpFailure(404, '附件不存在或已过期');
        if (req.method === 'DELETE') { uploads.delete(id); return json(res, 200, { ok: true }); }
        res.writeHead(200, { 'Content-Type': String(upload.metadata.mime), 'Content-Length': upload.bytes.length, 'Cache-Control': 'no-store' });
        return res.end(upload.bytes);
      }
      if (route === 'GET /api/media') {
        if (!url.searchParams.get('path') && !url.searchParams.get('url')) throw new HttpFailure(400, '缺少媒体来源');
        // A fixed one-pixel fixture; never fetch a supplied path or remote URL.
        const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aY9sAAAAASUVORK5CYII=', 'base64');
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' }); return res.end(image);
      }
      if (route === 'GET /api/cli/tools') return json(res, 200, [{ id: 'mock-cli', name: 'Mock CLI', version: '1', available: true, authed: true, models: [] }]);
      if (route === 'GET /api/cli/sessions') return json(res, 200, [...cliSessions.values()]);
      if (route === 'POST /api/cli/sessions') {
        const payload = await body(req);
        if (payload.tool !== 'mock-cli') throw new HttpFailure(400, '未知 Mock CLI 工具');
        const id = randomBytes(8).toString('hex'); const now = Date.now();
        const session = { id, tool: 'mock-cli', title: typeof payload.title === 'string' ? payload.title : 'Mock CLI 会话', running: false, activeRun: null, lastRun: null, createdAt: now, updatedAt: now };
        cliSessions.set(id, session); cliMessages.set(id, []); return json(res, 200, session);
      }
      const cliMatch = /^\/api\/cli\/sessions\/([^/]+)(?:\/(run|cancel))?$/.exec(url.pathname);
      if (cliMatch) {
        const id = cliMatch[1]!; const session = cliSessions.get(id);
        if (!session) throw new HttpFailure(404, 'CLI 会话不存在');
        if (!cliMatch[2]) return json(res, 200, { session, messages: cliMessages.get(id) });
        if (cliMatch[2] === 'cancel') {
          await body(req);
          if (session.activeRun) session.lastRun = { ...(session.activeRun as ObjectValue), state: 'cancelled', exitCode: null, reason: 'cancelled', finishedAt: Date.now() };
          session.running = false; session.activeRun = null;
          return json(res, 200, { ok: true });
        }
        const payload = await body(req);
        const prompt = text(payload.prompt, 'prompt');
        const { record, replay } = execute(device, `cli.run:${id}`, payload, () => {
          const runId = randomUUID();
          session.running = true; session.activeRun = { runId, state: 'running', startedAt: Date.now() };
          cliMessages.get(id)!.push({ role: 'user', text: prompt, ts: Date.now(), runId });
          return { sessionId: id, runId, state: 'running' };
        });
        if (replay) return json(res, 200, record.result);
        const result = record.result as { runId: string };
        if (scenario === 'drop-after-accept') { req.socket.destroy(); return; }
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
        res.flushHeaders();
        const event = (name: string, data: unknown) => { if (!res.destroyed) res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`); };
        event('start', { sessionId: id, runId: result.runId, tool: 'mock-cli', ts: Date.now() });
        await new Promise(resolve => setTimeout(resolve, 20));
        event('delta', { text: 'Mock CLI 增量输出：中文。' });
        await new Promise(resolve => setTimeout(resolve, 20));
        const cancelled = (session.lastRun as ObjectValue | null)?.runId === result.runId && (session.lastRun as ObjectValue).state === 'cancelled';
        session.running = false;
        if (!cancelled) session.lastRun = { ...(session.activeRun as ObjectValue), state: 'completed', exitCode: 0, finishedAt: Date.now() };
        session.activeRun = null;
        cliMessages.get(id)!.push({ role: 'assistant', text: 'Mock CLI 增量输出：中文。', ts: Date.now(), runId: result.runId });
        event('done', { exitCode: cancelled ? null : 0, durationMs: 40, ...(cancelled ? { reason: 'cancelled' } : {}) }); return res.end();
      }
      throw new HttpFailure(404, '未实现的严格 Mock 路由', 'MOCK_ROUTE_NOT_FOUND');
    })().catch(error => {
      if (res.destroyed || res.writableEnded) return;
      if (res.headersSent) { res.destroy(); return; }
      if (error instanceof HttpFailure) return json(res, error.status, { error: error.message, code: error.code });
      json(res, 500, { error: 'Mock 内部错误', code: 'MOCK_INTERNAL' });
    });
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.MOCK_PORT ?? 4174);
  createMockServer().listen(port, '127.0.0.1', () => {
    process.stdout.write(`Strict local mock: http://127.0.0.1:${port} (password: mock-password; no real execution)\n`);
  });
}
