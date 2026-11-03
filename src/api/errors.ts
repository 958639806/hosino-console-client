export type ApiErrorKind =
  | 'unauthorized'
  | 'forbidden'
  | 'not-found'
  | 'conflict'
  | 'rate-limited'
  | 'server'
  | 'network'
  | 'offline'
  | 'timeout'
  | 'aborted'
  | 'protocol'
  | 'stream-disconnected'
  | 'request';

export class ApiError extends Error {
  readonly status: number;
  readonly kind: ApiErrorKind;
  readonly code?: string;
  readonly retryAfterMs?: number;
  /** The client must query requestId before deciding whether to retry execution. */
  readonly outcomeUnknown: boolean;

  constructor(message: string, options: {
    status?: number;
    kind: ApiErrorKind;
    code?: string;
    retryAfterMs?: number;
    outcomeUnknown?: boolean;
    cause?: unknown;
  }) {
    super(message, { cause: options.cause });
    this.name = 'ApiError';
    this.status = options.status ?? 0;
    this.kind = options.kind;
    this.code = options.code;
    this.retryAfterMs = options.retryAfterMs;
    this.outcomeUnknown = options.outcomeUnknown ?? false;
  }
}

export function statusKind(status: number): ApiErrorKind {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not-found';
  if (status === 409) return 'conflict';
  if (status === 429) return 'rate-limited';
  if (status >= 500) return 'server';
  return 'request';
}

export function retryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

export function executionError(error: unknown): unknown {
  if (!(error instanceof ApiError)) return error;
  const unknown = error.outcomeUnknown ||
    ['network', 'offline', 'timeout', 'aborted', 'protocol', 'stream-disconnected', 'server'].includes(error.kind) ||
    ['request_pending', 'request_unknown'].includes(error.code ?? '');
  if (!unknown || error.outcomeUnknown) return error;
  return new ApiError(error.message, {
    status: error.status, kind: error.kind, code: error.code,
    retryAfterMs: error.retryAfterMs, outcomeUnknown: true, cause: error,
  });
}
