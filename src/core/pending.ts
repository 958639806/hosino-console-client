import type { KeyValueStorage } from './connections';

export type RequestOperation = 'chat.send' | 'cli.run';
export type PendingStatus = 'prepared' | 'sending' | 'unknown' | 'accepted' | 'failed';

export interface PendingRequest {
  requestId: string;
  connectionId: string;
  operation: RequestOperation;
  /** Session key/id, not a credential or request body. */
  target: string;
  fingerprint: string;
  status: PendingStatus;
  createdAt: number;
  updatedAt: number;
  runId?: string;
  error?: string;
}

function storeKey(connectionId: string): string {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(connectionId)) throw new Error('连接标识无效');
  return `hosino.pending.v1.${connectionId}`;
}

function validRequestId(id: string): boolean { return /^[a-zA-Z0-9][a-zA-Z0-9_-]{7,127}$/.test(id); }

function copyRecord(value: PendingRequest): PendingRequest { return { ...value }; }

function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  throw new Error('请求内容不能计算摘要');
}

/** Hash the immutable execution body; the journal does not store message contents. */
export async function fingerprintRequest(value: unknown): Promise<string> {
  // Apply the same JSON rules as fetch first (omitted undefined properties,
  // sparse arrays, Date.toJSON), then make property ordering deterministic.
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error('请求内容不能计算摘要');
  const bytes = new TextEncoder().encode(canonical(JSON.parse(serialized)));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

/** Durable metadata for reconciliation only; there is deliberately no replay method. */
export class PendingRequests {
  constructor(private readonly storage: KeyValueStorage) {}

  list(connectionId: string): PendingRequest[] {
    const stored = this.storage.getItem(storeKey(connectionId));
    if (stored === null) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(stored);
    } catch { throw new Error('本地请求记录损坏，请先核对远程会话状态'); }
    if (!Array.isArray(parsed)) throw new Error('本地请求记录格式无效，请先核对远程会话状态');
    const seen = new Set<string>();
    return parsed.map(value => {
        if (!value || typeof value !== 'object') throw new Error('本地请求记录格式无效，请先核对远程会话状态');
        const item = value as Partial<PendingRequest>;
        if (item.connectionId !== connectionId || typeof item.requestId !== 'string' || !validRequestId(item.requestId)
          || !['chat.send', 'cli.run'].includes(item.operation ?? '') || typeof item.target !== 'string'
          || typeof item.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(item.fingerprint)
          || !['prepared', 'sending', 'unknown', 'accepted', 'failed'].includes(item.status ?? '')
          || typeof item.createdAt !== 'number' || !Number.isFinite(item.createdAt)
          || typeof item.updatedAt !== 'number' || !Number.isFinite(item.updatedAt)
          || seen.has(item.requestId)) throw new Error('本地请求记录格式无效，请先核对远程会话状态');
        seen.add(item.requestId);
        // Whitelist fields when decoding ordinary browser storage.
        const record: PendingRequest = {
          requestId: item.requestId, connectionId, operation: item.operation as RequestOperation,
          target: item.target, fingerprint: item.fingerprint, status: item.status as PendingStatus,
          createdAt: item.createdAt, updatedAt: item.updatedAt,
          ...(typeof item.runId === 'string' ? { runId: item.runId } : {}),
          ...(typeof item.error === 'string' ? { error: item.error.slice(0, 500) } : {}),
        };
        return record;
      });
  }

  get(connectionId: string, requestId: string): PendingRequest | null {
    return this.list(connectionId).find(record => record.requestId === requestId) ?? null;
  }

  create(connectionId: string, operation: RequestOperation, payload: { target: string; fingerprint: string }, requestId: string = crypto.randomUUID()): PendingRequest {
    if (!validRequestId(requestId) || !['chat.send', 'cli.run'].includes(operation)
      || !payload.target || !/^[a-f0-9]{64}$/.test(payload.fingerprint)) throw new Error('待确认请求元数据无效');
    const records = this.list(connectionId);
    const existing = records.find(record => record.requestId === requestId);
    if (existing) {
      if (existing.operation !== operation || existing.target !== payload.target || existing.fingerprint !== payload.fingerprint) {
        throw new Error('相同 requestId 对应了不同内容，请查询原请求状态');
      }
      return copyRecord(existing);
    }
    const now = Date.now();
    const record: PendingRequest = {
      requestId, connectionId, operation, target: payload.target, fingerprint: payload.fingerprint,
      status: 'prepared', createdAt: now, updatedAt: now,
    };
    // If this write fails, propagate it: callers must not dispatch an unjournaled action.
    this.storage.setItem(storeKey(connectionId), JSON.stringify([...records, record]));
    return copyRecord(record);
  }

  update(connectionId: string, requestId: string, patch: { status: PendingStatus; runId?: string; error?: string }): PendingRequest {
    if (!['prepared', 'sending', 'unknown', 'accepted', 'failed'].includes(patch.status)) throw new Error('请求状态无效');
    const records = this.list(connectionId);
    const index = records.findIndex(record => record.requestId === requestId);
    if (index < 0) throw new Error('待确认请求不存在');
    const record: PendingRequest = {
      ...records[index]!, status: patch.status, updatedAt: Date.now(),
      ...(patch.runId !== undefined ? { runId: patch.runId } : {}),
      ...(patch.error !== undefined ? { error: patch.error.slice(0, 500) } : {}),
    };
    records[index] = record;
    this.storage.setItem(storeKey(connectionId), JSON.stringify(records));
    return copyRecord(record);
  }

  remove(connectionId: string, requestId: string): void {
    this.storage.setItem(storeKey(connectionId), JSON.stringify(this.list(connectionId).filter(record => record.requestId !== requestId)));
  }

  clear(connectionId: string): void { this.storage.removeItem(storeKey(connectionId)); }
}
