export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface ConnectionProfile {
  id: string;
  name: string;
  /** HTTPS server origin. A profile's origin is immutable. */
  url: string;
}

export interface ConnectionSnapshot {
  profile: ConnectionProfile | null;
  epoch: number;
}

const PROFILE_KEY = 'hosino.connections.v1';
const ACTIVE_KEY = 'hosino.active-connection.v1';
const ID_PATTERN = /^[a-zA-Z0-9_-]{1,100}$/;

export function normalizeServerUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new Error('请输入有效的 HTTPS 服务器地址');
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || value.includes('?') || value.includes('#')) {
    throw new Error('服务器地址必须使用 HTTPS，且不能包含凭据、查询参数或片段');
  }
  if (parsed.pathname !== '/') {
    throw new Error('请输入服务器根地址，例如 https://console.example.com');
  }
  return parsed.origin;
}

function readProfiles(storage: KeyValueStorage): ConnectionProfile[] {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(PROFILE_KEY) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    const ids = new Set<string>();
    const result: ConnectionProfile[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue;
      const { id, name, url } = item as Partial<ConnectionProfile>;
      if (typeof id !== 'string' || !ID_PATTERN.test(id) || ids.has(id) || typeof name !== 'string' || !name.trim() || typeof url !== 'string') continue;
      try {
        result.push({ id, name: name.trim().slice(0, 80), url: normalizeServerUrl(url) });
        ids.add(id);
      } catch { /* Discard invalid persisted profiles; never use an unsafe origin. */ }
    }
    return result;
  } catch {
    return [];
  }
}

/** Stores connection metadata only. Credentials never enter this store. */
export class ConnectionProfiles {
  private profiles: ConnectionProfile[];
  private activeId: string | null;
  private listeners = new Set<(snapshot: ConnectionSnapshot) => void>();
  private version = 0;

  constructor(private readonly storage: KeyValueStorage) {
    this.profiles = readProfiles(storage);
    const saved = storage.getItem(ACTIVE_KEY);
    this.activeId = this.profiles.some(profile => profile.id === saved) ? saved : null;
  }

  get epoch(): number { return this.version; }

  list(): ConnectionProfile[] { return this.profiles.map(profile => ({ ...profile })); }

  active(): ConnectionProfile | null {
    const profile = this.profiles.find(item => item.id === this.activeId);
    return profile ? { ...profile } : null;
  }

  snapshot(): ConnectionSnapshot { return { profile: this.active(), epoch: this.version }; }

  isCurrent(snapshot: ConnectionSnapshot): boolean {
    return snapshot.epoch === this.version && (snapshot.profile?.id ?? null) === this.activeId;
  }

  save(input: { id?: string; name: string; url: string }): ConnectionProfile {
    const url = normalizeServerUrl(input.url);
    const name = input.name.trim();
    if (!name || name.length > 80) throw new Error('连接名称应为 1–80 个字符');
    const id = input.id ?? crypto.randomUUID();
    if (!ID_PATTERN.test(id)) throw new Error('连接标识无效');
    const existing = this.profiles.find(profile => profile.id === id);
    if (existing && existing.url !== url) {
      throw new Error('服务器地址改变时请新建连接，避免混用已有凭据');
    }
    const profile = { id, name, url };
    const next = existing
      ? this.profiles.map(item => item.id === id ? profile : item)
      : [...this.profiles, profile];
    // Commit persistence before exposing the update; a storage failure must stay visible.
    this.storage.setItem(PROFILE_KEY, JSON.stringify(next));
    this.profiles = next;
    return { ...profile };
  }

  activate(id: string): ConnectionSnapshot {
    if (!this.profiles.some(profile => profile.id === id)) throw new Error('连接不存在');
    if (id !== this.activeId) {
      this.storage.setItem(ACTIVE_KEY, id);
      this.activeId = id;
      this.changed();
    }
    return this.snapshot();
  }

  remove(id: string): void {
    const next = this.profiles.filter(profile => profile.id !== id);
    if (next.length === this.profiles.length) return;
    this.storage.setItem(PROFILE_KEY, JSON.stringify(next));
    this.profiles = next;
    if (this.activeId === id) {
      this.storage.removeItem(ACTIVE_KEY);
      this.activeId = null;
      this.changed();
    }
  }

  subscribe(listener: (snapshot: ConnectionSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private changed(): void {
    this.version += 1;
    for (const listener of this.listeners) listener(this.snapshot());
  }
}
