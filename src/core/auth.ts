import { copyCredentials, validCredentials, type DeviceCredentials, type SecureCredentialStore } from './credentials';

export type AuthStatus = 'signed-out' | 'authenticated' | 'expired' | 'forbidden' | 'unreachable' | 'offline';

export interface AuthState {
  status: AuthStatus;
  connectionId: string | null;
  message?: string;
}

export interface AuthFailure {
  status?: number;
  code?: string;
  kind?: string;
}

export class StaleConnectionError extends Error {
  constructor() { super('连接已切换，忽略旧连接的响应'); this.name = 'StaleConnectionError'; }
}

/** Keeps network/permission failures separate from credential invalidity. */
export class AuthSession {
  private current: AuthState = { status: 'signed-out', connectionId: null };
  private currentCredentials: DeviceCredentials | null = null;
  private generation = 0;
  private changes = new Map<string, number>();
  private writes = new Map<string, Promise<void>>();
  private refreshes = new Map<string, Promise<DeviceCredentials | null>>();
  private listeners = new Set<(state: AuthState) => void>();

  constructor(private readonly store: SecureCredentialStore) {}

  get state(): AuthState { return { ...this.current }; }

  async useConnection(connectionId: string | null): Promise<void> {
    const generation = ++this.generation;
    this.currentCredentials = null;
    this.setState({ status: 'signed-out', connectionId });
    if (connectionId === null) return;
    // Wait for an earlier refresh/remove to finish before reading this profile.
    await this.writes.get(connectionId)?.catch(() => undefined);
    const credentials = await this.store.get(connectionId);
    if (generation !== this.generation) return;
    this.currentCredentials = credentials;
    this.setState({ status: credentials ? this.credentialStatus(credentials) : 'signed-out', connectionId });
  }

  async credentials(): Promise<DeviceCredentials | null> {
    return this.currentCredentials ? copyCredentials(this.currentCredentials) : null;
  }

  /** Pass the login's captured profile id so a late login cannot cross connections. */
  async signIn(credentials: DeviceCredentials, expectedConnectionId = this.current.connectionId): Promise<void> {
    if (!validCredentials(credentials)) throw new Error('服务器返回的设备凭据无效');
    const connectionId = this.current.connectionId;
    if (!connectionId || connectionId !== expectedConnectionId) throw new StaleConnectionError();
    const generation = ++this.generation;
    const safeCredentials = copyCredentials(credentials);
    this.bump(connectionId);
    this.refreshes.delete(connectionId);
    await this.write(connectionId, () => this.store.set(connectionId, safeCredentials));
    if (generation !== this.generation || this.current.connectionId !== connectionId) return;
    this.currentCredentials = safeCredentials;
    this.setState({ status: this.credentialStatus(safeCredentials), connectionId });
  }

  async refresh(callback: (refreshToken: string) => Promise<DeviceCredentials>): Promise<DeviceCredentials | null> {
    const connectionId = this.current.connectionId;
    const credentials = this.currentCredentials;
    if (!connectionId || !credentials) return null;
    const existing = this.refreshes.get(connectionId);
    if (existing) return existing;
    if (credentials.refreshExpiresAt <= Date.now()) {
      this.setState({ status: 'expired', connectionId, message: '设备凭据已过期，请重新登录' });
      return null;
    }
    const generation = this.generation;
    const change = this.changes.get(connectionId) ?? 0;
    let operation!: Promise<DeviceCredentials | null>;
    operation = (async () => {
      try {
        // Defer invocation so synchronous callback failures cannot leave a rejected
        // promise stuck in the single-flight map before it has been assigned.
        const refreshed = await Promise.resolve().then(() => callback(credentials.refreshToken));
        if (!validCredentials(refreshed)) throw new Error('服务器返回的设备凭据无效');
        // Logout or another login wins over this older refresh.
        if ((this.changes.get(connectionId) ?? 0) !== change) throw new StaleConnectionError();
        await this.write(connectionId, () => this.store.set(connectionId, refreshed));
        if (this.current.connectionId === connectionId && (this.changes.get(connectionId) ?? 0) === change) {
          this.currentCredentials = copyCredentials(refreshed);
          this.setState({ status: this.credentialStatus(refreshed), connectionId });
          return copyCredentials(refreshed);
        }
        // Save rotated credentials for their original profile but never expose them to another one.
        throw new StaleConnectionError();
      } catch (error) {
        if (generation === this.generation && !(error instanceof StaleConnectionError)) {
          this.recordFailure(error as AuthFailure);
        }
        throw error;
      } finally {
        if (this.refreshes.get(connectionId) === operation) this.refreshes.delete(connectionId);
      }
    })();
    this.refreshes.set(connectionId, operation);
    return operation;
  }

  recordFailure(error: AuthFailure, online = true): void {
    if (error.status === -1 || error.kind === 'aborted') return;
    let status: AuthStatus | undefined;
    let message: string | undefined;
    if (!online || error.kind === 'offline') { status = 'offline'; message = '设备离线，连接恢复后将查询远程状态'; }
    else if (error.status === 401) { status = 'expired'; message = '设备认证已失效，请刷新凭据或重新登录'; }
    else if (error.status === 403) { status = 'forbidden'; message = '当前设备没有此操作的权限'; }
    else if (error.status === 0 || error.kind === 'network' || error.kind === 'timeout') { status = 'unreachable'; message = '暂时无法连接服务器，已保留设备凭据'; }
    if (status) this.setState({ status, connectionId: this.current.connectionId, message });
  }

  recordSuccess(): void {
    if (this.currentCredentials) {
      this.setState({ status: this.credentialStatus(this.currentCredentials), connectionId: this.current.connectionId });
    }
  }

  async signOut(connectionId: string | null = this.current.connectionId): Promise<void> {
    if (connectionId === this.current.connectionId) {
      ++this.generation;
      this.currentCredentials = null;
      this.setState({ status: 'signed-out', connectionId });
    }
    if (connectionId) {
      this.bump(connectionId);
      this.refreshes.delete(connectionId);
    }
    if (connectionId) await this.write(connectionId, () => this.store.remove(connectionId));
  }

  subscribe(listener: (state: AuthState) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private credentialStatus(credentials: DeviceCredentials): AuthStatus {
    return credentials.accessExpiresAt > Date.now() && credentials.refreshExpiresAt > Date.now() ? 'authenticated' : 'expired';
  }

  private bump(connectionId: string): void { this.changes.set(connectionId, (this.changes.get(connectionId) ?? 0) + 1); }

  private async write(connectionId: string, action: () => Promise<void>): Promise<void> {
    const operation = (this.writes.get(connectionId) ?? Promise.resolve()).catch(() => undefined).then(action);
    this.writes.set(connectionId, operation);
    try { await operation; } finally { if (this.writes.get(connectionId) === operation) this.writes.delete(connectionId); }
  }

  private setState(state: AuthState): void {
    this.current = state;
    for (const listener of this.listeners) listener(this.state);
  }
}
