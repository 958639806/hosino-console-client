import { ApiError, executionError, retryAfter, statusKind } from './errors';
import { readEventStream } from './sse';
import type {
  Capabilities, ChatHistory, CliRunReceipt, CliRunRequest, CliSession, CliSessionDetail,
  DeviceCredentials, DeviceSummary, JsonObject, RequestStatus, SendRequest, SessionList,
  SseEvent, Upload, UploadOptions, UploadTask,
} from './types';

export interface ConsoleClientOptions {
  baseUrl: string;
  getAccessToken: () => Promise<string | null>;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Injectable for transport tests. Browser XHR provides upload progress. */
  createXHR?: () => XMLHttpRequest;
  xhrFactory?: () => XMLHttpRequest;
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  auth?: 'required' | 'optional' | 'none';
  signal?: AbortSignal;
  timeoutMs?: number;
  accept?: string;
}

interface OpenResponse {
  response: Response;
  signal: AbortSignal;
  close(): void;
  failure(error: unknown): ApiError;
}

const record = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const protocol = () => new ApiError('服务器返回了不兼容的数据', { kind: 'protocol' });

function credentials(value: unknown): DeviceCredentials {
  if (!record(value) || !record(value.device) ||
    typeof value.device.id !== 'string' || typeof value.device.name !== 'string' ||
    typeof value.accessToken !== 'string' || !value.accessToken ||
    typeof value.refreshToken !== 'string' || !value.refreshToken ||
    typeof value.accessExpiresAt !== 'number' || !Number.isFinite(value.accessExpiresAt) ||
    typeof value.refreshExpiresAt !== 'number' || !Number.isFinite(value.refreshExpiresAt)) throw protocol();
  return value as unknown as DeviceCredentials;
}

function capability(value: unknown): Capabilities {
  if (!record(value) || typeof value.apiVersion !== 'number' || typeof value.build !== 'string' ||
    !Array.isArray(value.auth) || !value.auth.every(item => typeof item === 'string') ||
    !record(value.modules) || !record(value.permissions) || typeof value.permissions.cli !== 'boolean' ||
    !['overview', 'sessions', 'chat', 'uploads', 'cli'].every(key => typeof value.modules === 'object' && value.modules !== null && typeof (value.modules as JsonObject)[key] === 'boolean')) throw protocol();
  return value as unknown as Capabilities;
}

function uploadValue(value: unknown): Upload {
  if (!record(value) || typeof value.id !== 'string' || typeof value.name !== 'string' || typeof value.size !== 'number') throw protocol();
  return value as unknown as Upload;
}

function messageFor(status: number): string {
  if (status === 401) return '登录凭据已失效，请重新认证';
  if (status === 403) return '当前设备没有执行此操作的权限';
  if (status === 404) return '服务器未找到此资源或接口';
  if (status === 409) return '请求与服务器当前状态冲突';
  if (status === 429) return '请求过于频繁，请稍后再试';
  if (status >= 500) return '服务器暂时无法完成请求';
  return `请求失败（${status}）`;
}

function httpError(status: number, body: unknown, retryHeader: string | null): ApiError {
  const payload = record(body) ? body : {};
  const code = typeof payload.code === 'string' ? payload.code : undefined;
  return new ApiError(typeof payload.error === 'string' ? payload.error : messageFor(status), {
    status, kind: statusKind(status), code, retryAfterMs: retryAfter(retryHeader),
    outcomeUnknown: code === 'request_pending' || code === 'request_unknown',
  });
}

/** Device-bearer SDK. Execution requests are never automatically replayed. */
export class ConsoleClient {
  readonly baseUrl: string;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;
  private readonly getAccessToken: () => Promise<string | null>;
  private readonly createXHR: () => XMLHttpRequest;

  constructor(options: ConsoleClientOptions) {
    const base = new URL(options.baseUrl);
    if (base.protocol !== 'https:' || base.username || base.password || options.baseUrl.includes('?') || options.baseUrl.includes('#') ||
      (base.pathname !== '/' && base.pathname !== '')) {
      throw new ApiError('连接地址必须是不含账号、参数和路径的 HTTPS 地址', { kind: 'request' });
    }
    this.baseUrl = base.origin;
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.getAccessToken = options.getAccessToken;
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.createXHR = options.xhrFactory ?? options.createXHR ?? (() => new XMLHttpRequest());
  }

  private url(path: string): string {
    if (!path.startsWith('/') || path.startsWith('//') || path.includes('#')) throw protocol();
    const url = new URL(path, this.baseUrl);
    if (url.origin !== this.baseUrl || url.username || url.password) throw protocol();
    return url.href;
  }

  private async token(required: boolean): Promise<string | null> {
    const token = await this.getAccessToken();
    if (!token && required) throw new ApiError('请先连接并登录服务器', { status: 401, kind: 'unauthorized', code: 'AUTH_REQUIRED' });
    if (token && /[\r\n]/.test(token)) throw new ApiError('凭据格式无效，请重新认证', { kind: 'unauthorized' });
    return token;
  }

  private async open(path: string, options: RequestOptions = {}): Promise<OpenResponse> {
    const auth = options.auth ?? 'required';
    const token = auth === 'none' ? null : await this.token(auth === 'required');
    const controller = new AbortController();
    let timedOut = false;
    const externalAbort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener('abort', externalAbort, { once: true });
    if (options.signal?.aborted) externalAbort();
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, options.timeoutMs ?? this.timeoutMs);
    const close = () => {
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', externalAbort);
    };
    const failure = (error: unknown): ApiError => {
      if (error instanceof ApiError) return error;
      if (timedOut) return new ApiError('请求超时，请查询状态后再决定是否重试', { kind: 'timeout', cause: error });
      if (controller.signal.aborted) return new ApiError('已中断本机请求', { kind: 'aborted', code: 'aborted', cause: error });
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        return new ApiError('设备当前离线', { kind: 'offline', cause: error });
      }
      return new ApiError('无法连接服务器，请检查网络和服务器地址', { kind: 'network', cause: error });
    };
    try {
      const response = await this.fetcher(this.url(path), {
        method: options.method ?? 'GET', credentials: 'omit', cache: 'no-store',
        redirect: 'error', signal: controller.signal,
        headers: {
          'X-HS': '1', Accept: options.accept ?? 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      });
      // Also defend against custom/native fetch adapters which ignore redirect:error.
      if (response.redirected || (response.url && new URL(response.url).origin !== this.baseUrl)) {
        void response.body?.cancel();
        throw new ApiError('服务器重定向被拒绝，请核对连接地址', { kind: 'protocol' });
      }
      return { response, signal: controller.signal, close, failure };
    } catch (error) {
      close();
      throw failure(error);
    }
  }

  private async json<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const opened = await this.open(path, options);
    try {
      if (opened.response.status === 204) return undefined as T;
      const text = await opened.response.text();
      let data: unknown;
      try { data = text ? JSON.parse(text) : undefined; } catch {
        if (!opened.response.ok) throw httpError(opened.response.status, null, opened.response.headers.get('Retry-After'));
        throw protocol();
      }
      if (!opened.response.ok) throw httpError(opened.response.status, data, opened.response.headers.get('Retry-After'));
      if (data === undefined) throw protocol();
      return data as T;
    } catch (error) {
      throw opened.failure(error);
    } finally { opened.close(); }
  }

  capabilities(signal?: AbortSignal): Promise<Capabilities> {
    return this.json<unknown>('/api/mobile/capabilities', { auth: 'optional', signal }).then(capability);
  }

  login(password: string, deviceName: string, signal?: AbortSignal): Promise<DeviceCredentials> {
    return this.json<unknown>('/api/mobile/login', { method: 'POST', auth: 'none', body: { password, deviceName }, signal }).then(credentials);
  }

  refresh(refreshToken: string, signal?: AbortSignal): Promise<DeviceCredentials> {
    return this.json<unknown>('/api/mobile/refresh', { method: 'POST', auth: 'none', body: { refreshToken }, signal }).then(credentials);
  }

  logout(signal?: AbortSignal): Promise<{ ok: boolean }> {
    return this.json('/api/mobile/logout', { method: 'POST', body: {}, signal });
  }

  devices(signal?: AbortSignal): Promise<{ devices: DeviceSummary[] }> {
    return this.json('/api/mobile/devices', { signal });
  }

  revokeDevice(id: string, signal?: AbortSignal): Promise<{ ok: boolean }> {
    return this.json(`/api/mobile/devices/${encodeURIComponent(id)}`, { method: 'DELETE', signal });
  }

  me(signal?: AbortSignal): Promise<JsonObject> { return this.json('/api/me', { signal }); }
  overview(signal?: AbortSignal): Promise<JsonObject> { return this.json('/api/overview', { signal }); }

  sessions(offset = 0, q?: string, signal?: AbortSignal): Promise<SessionList> {
    const query = new URLSearchParams({ offset: String(Math.max(0, Math.floor(offset))) });
    if (q) query.set('q', q);
    return this.json(`/api/sessions?${query}`, { signal });
  }

  history(key: string, limit = 60, before?: string, signal?: AbortSignal): Promise<ChatHistory> {
    const query = new URLSearchParams({ key, limit: String(Math.max(1, Math.min(200, Math.floor(limit)))) });
    if (before !== undefined && before !== '') query.set('before', before);
    return this.json(`/api/history?${query}`, { signal });
  }

  async send(body: SendRequest, signal?: AbortSignal): Promise<JsonObject> {
    this.requireRequestId(body.requestId);
    try {
      const result = await this.json<unknown>('/api/send', { method: 'POST', body, signal, timeoutMs: body.attachments?.length ? 130_000 : 40_000 });
      if (!record(result)) throw protocol();
      return result;
    } catch (error) { throw executionError(error); }
  }

  async requestStatus(requestId: string, signal?: AbortSignal): Promise<RequestStatus> {
    this.requireRequestId(requestId);
    const result = await this.json<unknown>(`/api/mobile/requests/${encodeURIComponent(requestId)}`, { signal });
    if (!record(result) || result.requestId !== requestId || !['pending', 'unknown', 'completed', 'failed'].includes(String(result.state))) throw protocol();
    return result as unknown as RequestStatus;
  }

  abort(key: string, signal?: AbortSignal): Promise<JsonObject> {
    return this.json('/api/abort', { method: 'POST', body: { key }, signal });
  }

  models(signal?: AbortSignal): Promise<JsonObject> { return this.json('/api/models', { signal }); }

  logs(limit = 200, level?: string, signal?: AbortSignal): Promise<JsonObject> {
    const query = new URLSearchParams({ limit: String(Math.max(1, Math.min(2000, Math.floor(limit)))) });
    if (level) query.set('level', level);
    return this.json(`/api/logs?${query}`, { signal });
  }

  uploadLimits(signal?: AbortSignal): Promise<JsonObject> { return this.json('/api/uploads/limits', { signal }); }

  deleteUpload(id: string, signal?: AbortSignal): Promise<JsonObject> {
    return this.json(`/api/uploads/${encodeURIComponent(id)}`, { method: 'DELETE', signal });
  }

  upload(blob: Blob, options: UploadOptions, onProgress?: (fraction: number) => void): UploadTask {
    let xhr: XMLHttpRequest | undefined;
    let aborted = false;
    let rejectTask: ((reason: unknown) => void) | undefined;
    const promise = new Promise<Upload>((resolve, reject) => {
      rejectTask = reject;
      void (async () => {
        const token = await this.token(true);
        if (aborted) return;
        xhr = this.createXHR();
        const query = new URLSearchParams({ scope: options.scope, session: options.session, name: options.name });
        xhr.open('POST', this.url(`/api/uploads?${query}`));
        xhr.withCredentials = false;
        xhr.timeout = 120_000;
        xhr.setRequestHeader('Authorization', `Bearer ${token}`);
        xhr.setRequestHeader('X-HS', '1');
        xhr.setRequestHeader('Content-Type', 'application/octet-stream');
        xhr.setRequestHeader('Accept', 'application/json');
        xhr.upload.onprogress = event => {
          if (event.lengthComputable && event.total > 0) onProgress?.(Math.max(0, Math.min(1, event.loaded / event.total)));
        };
        xhr.onload = () => {
          try {
            // Browser XHR strips Authorization on cross-origin redirects; reject the final URL too.
            if (xhr!.responseURL && new URL(xhr!.responseURL).origin !== this.baseUrl) {
              throw new ApiError('上传地址发生跨服务器重定向', { kind: 'protocol' });
            }
            let data: unknown;
            try { data = JSON.parse(xhr!.responseText); } catch {
              if (xhr!.status >= 200 && xhr!.status < 300) throw protocol();
            }
            if (xhr!.status < 200 || xhr!.status >= 300) {
              throw httpError(xhr!.status, data, xhr!.getResponseHeader('Retry-After'));
            }
            resolve(uploadValue(data));
          } catch (error) { reject(error); }
        };
        xhr.onerror = () => reject(new ApiError('附件上传连接失败', {
          kind: typeof navigator !== 'undefined' && navigator.onLine === false ? 'offline' : 'network',
        }));
        xhr.ontimeout = () => reject(new ApiError('附件上传超时', { kind: 'timeout' }));
        xhr.onabort = () => reject(new ApiError('已取消附件上传', { kind: 'aborted', code: 'aborted' }));
        xhr.send(blob);
      })().catch(reject);
    });
    return {
      promise,
      abort: () => {
        aborted = true;
        xhr?.abort();
        rejectTask?.(new ApiError('已取消附件上传', { kind: 'aborted', code: 'aborted' }));
      },
    };
  }

  private async binary(path: string, signal?: AbortSignal): Promise<Blob> {
    const opened = await this.open(path, { signal, accept: '*/*', timeoutMs: 120_000 });
    try {
      if (!opened.response.ok) {
        let error: unknown;
        try { error = await opened.response.json(); } catch { /* Generic HTTP fallback. */ }
        throw httpError(opened.response.status, error, opened.response.headers.get('Retry-After'));
      }
      return await opened.response.blob();
    } catch (error) { throw opened.failure(error); }
    finally { opened.close(); }
  }

  media(source: { path?: string; url?: string }, signal?: AbortSignal): Promise<Blob> {
    if ((!source.path && !source.url) || (source.path && source.url)) throw new ApiError('请选择一种媒体来源', { kind: 'request' });
    const query = new URLSearchParams(source.path ? { path: source.path } : { url: source.url! });
    return this.binary(`/api/media?${query}`, signal);
  }

  downloadUpload(id: string, signal?: AbortSignal): Promise<Blob> {
    return this.binary(`/api/uploads/${encodeURIComponent(id)}?download=1`, signal);
  }

  cliTools(signal?: AbortSignal): Promise<JsonObject[]> { return this.json('/api/cli/tools', { signal }); }
  cliSessions(signal?: AbortSignal): Promise<CliSession[]> { return this.json('/api/cli/sessions', { signal }); }
  cliCreate(tool: string, title?: string, model?: string, signal?: AbortSignal): Promise<CliSession> {
    return this.json('/api/cli/sessions', { method: 'POST', body: { tool, ...(title ? { title } : {}), ...(model ? { model } : {}) }, signal });
  }
  cliGet(id: string, signal?: AbortSignal): Promise<CliSessionDetail> {
    return this.json(`/api/cli/sessions/${encodeURIComponent(id)}`, { signal });
  }
  cliCancel(id: string, signal?: AbortSignal): Promise<JsonObject> {
    return this.json(`/api/cli/sessions/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: {}, signal });
  }

  async cliRun(id: string, body: CliRunRequest, onEvent: (event: SseEvent) => void, signal?: AbortSignal): Promise<void | CliRunReceipt> {
    this.requireRequestId(body.requestId);
    let opened: OpenResponse | undefined;
    try {
      opened = await this.open(`/api/cli/sessions/${encodeURIComponent(id)}/run`, {
        method: 'POST', body, signal, accept: 'text/event-stream', timeoutMs: 30 * 60_000,
      });
      if (!opened.response.ok) {
        let data: unknown;
        try { data = await opened.response.json(); } catch { /* HTTP fallback. */ }
        throw httpError(opened.response.status, data, opened.response.headers.get('Retry-After'));
      }
      const contentType = opened.response.headers.get('Content-Type')?.toLowerCase() ?? '';
      if (contentType.includes('application/json')) {
        const receipt: unknown = await opened.response.json();
        if (!record(receipt) || typeof receipt.sessionId !== 'string' || typeof receipt.runId !== 'string' || typeof receipt.state !== 'string') throw protocol();
        // A replay returns the original submission receipt. Query session state for its terminal result.
        onEvent({ event: 'receipt', data: receipt });
        return receipt as unknown as CliRunReceipt;
      }
      if (!contentType.includes('text/event-stream') || !opened.response.body) throw protocol();
      let terminal = false;
      for await (const event of readEventStream(opened.response.body, opened.signal)) {
        if (event.event === 'done' && (!record(event.data) ||
          !(event.data.exitCode === null || typeof event.data.exitCode === 'number' && Number.isFinite(event.data.exitCode)) ||
          typeof event.data.durationMs !== 'number' || !Number.isFinite(event.data.durationMs) || event.data.durationMs < 0)) throw protocol();
        onEvent(event);
        if (event.event === 'done') { terminal = true; break; }
      }
      if (!terminal) throw new ApiError('输出连接已断开，远程任务可能仍在运行，请查询会话状态', {
        kind: 'stream-disconnected', outcomeUnknown: true,
      });
    } catch (error) {
      throw executionError(opened ? opened.failure(error) : error);
    } finally { opened?.close(); }
  }

  private requireRequestId(id: string): void {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/.test(id)) {
      throw new ApiError('执行请求缺少有效的稳定 requestId', { kind: 'request' });
    }
  }
}
