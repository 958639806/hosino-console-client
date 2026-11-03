import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AuthSession, ConnectionProfiles, ForegroundPoller, MemoryCredentialStore, NativeCredentialStore,
  PendingRequests, StaleConnectionError, fingerprintRequest, normalizeServerUrl,
  type DeviceCredentials, type KeyValueStorage,
} from '../src/core';

class Storage implements KeyValueStorage {
  data = new Map<string, string>();
  getItem(key: string): string | null { return this.data.get(key) ?? null; }
  setItem(key: string, value: string): void { this.data.set(key, value); }
  removeItem(key: string): void { this.data.delete(key); }
}

function credentials(token = 'access', expires = Date.now() + 60_000): DeviceCredentials {
  return {
    accessToken: token, refreshToken: `refresh-${token}`, accessExpiresAt: expires,
    refreshExpiresAt: Date.now() + 3600_000, device: { id: 'device-1', name: 'Android' },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function flush() { for (let index = 0; index < 8; index += 1) await Promise.resolve(); }

afterEach(() => { vi.useRealTimers(); });

describe('connection isolation', () => {
  it('accepts only credential-free HTTPS origins', () => {
    expect(normalizeServerUrl(' https://CONSOLE.example.com:443/ ')).toBe('https://console.example.com');
    for (const value of ['http://localhost:9000', 'javascript:alert(1)', 'https://user:pass@example.com', 'https://example.com/api', 'https://example.com?token=x', 'https://example.com#x', 'https://example.com?', 'https://example.com#']) {
      expect(() => normalizeServerUrl(value)).toThrow();
    }
  });

  it('invalidates snapshots after a connection switch and persists no credentials', () => {
    const storage = new Storage();
    const profiles = new ConnectionProfiles(storage);
    profiles.save({ id: 'a', name: 'A', url: 'https://a.example' });
    profiles.save({ id: 'b', name: 'B', url: 'https://b.example' });
    const previous = profiles.activate('a');
    expect(profiles.isCurrent(previous)).toBe(true);
    profiles.activate('b');
    expect(profiles.isCurrent(previous)).toBe(false);
    expect(new ConnectionProfiles(storage).active()?.id).toBe('b');
    expect(() => profiles.save({ id: 'a', name: 'Changed server', url: 'https://attacker.example' })).toThrow();
    expect([...storage.data.values()].join('')).not.toContain('accessToken');
  });

  it('drops unsafe persisted profile origins before they can be activated', () => {
    const storage = new Storage();
    storage.setItem('hosino.connections.v1', JSON.stringify([{ id: 'bad', name: 'Bad', url: 'http://unsafe.example' }]));
    storage.setItem('hosino.active-connection.v1', 'bad');
    const profiles = new ConnectionProfiles(storage);
    expect(profiles.list()).toEqual([]);
    expect(profiles.active()).toBeNull();
  });
});

describe('credential storage', () => {
  it('browser credentials are isolated copies and do not survive another store instance', async () => {
    const store = new MemoryCredentialStore();
    const value = credentials();
    await store.set('a', value);
    value.accessToken = 'mutated';
    expect((await store.get('a'))?.accessToken).toBe('access');
    expect(await store.get('b')).toBeNull();
    expect(await new MemoryCredentialStore().get('a')).toBeNull();
    expect(store.persistent).toBe(false);
  });

  it('uses the native secure plugin and surfaces native failure without fallback', async () => {
    const plugin = {
      get: vi.fn(async () => ({ value: null as string | null })),
      set: vi.fn(async () => { throw new Error('Keystore unavailable'); }),
      remove: vi.fn(async () => undefined),
    };
    const store = new NativeCredentialStore(plugin);
    const value = credentials();
    await expect(store.set('a', value)).rejects.toThrow('Keystore unavailable');
    expect(plugin.set).toHaveBeenCalledWith({ key: 'hosino.device.v1.a', value: JSON.stringify(value) });
    expect(store.persistent).toBe(true);
    plugin.get.mockResolvedValue({ value: '{bad json' });
    await expect(store.get('a')).rejects.toThrow('凭据损坏');
  });
});

describe('authentication state machine', () => {
  it('keeps credentials across network, offline and permission errors', async () => {
    const store = new MemoryCredentialStore();
    const auth = new AuthSession(store);
    await auth.useConnection('a');
    await auth.signIn(credentials(), 'a');
    auth.recordFailure({ status: 0 });
    expect(auth.state.status).toBe('unreachable');
    auth.recordFailure({ status: 403 });
    expect(auth.state.status).toBe('forbidden');
    auth.recordFailure({ kind: 'offline' });
    expect(auth.state.status).toBe('offline');
    expect((await store.get('a'))?.accessToken).toBe('access');
    auth.recordSuccess();
    expect(auth.state.status).toBe('authenticated');
    auth.recordFailure({ status: 401 });
    expect(auth.state.status).toBe('expired');
    expect((await auth.credentials())?.refreshToken).toBe('refresh-access');
  });

  it('rejects a late login captured for another connection', async () => {
    const store = new MemoryCredentialStore();
    const auth = new AuthSession(store);
    await auth.useConnection('a');
    await auth.useConnection('b');
    await expect(auth.signIn(credentials(), 'a')).rejects.toBeInstanceOf(StaleConnectionError);
    expect(await store.get('b')).toBeNull();
  });

  it('deduplicates concurrent refresh requests', async () => {
    const store = new MemoryCredentialStore();
    const auth = new AuthSession(store);
    await auth.useConnection('a');
    await auth.signIn(credentials('old', 0), 'a');
    const result = deferred<DeviceCredentials>();
    const refresh = vi.fn(() => result.promise);
    const first = auth.refresh(refresh);
    const second = auth.refresh(refresh);
    result.resolve(credentials('new'));
    expect((await first)?.accessToken).toBe('new');
    expect((await second)?.accessToken).toBe('new');
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('permits another refresh after a synchronous adapter failure', async () => {
    const auth = new AuthSession(new MemoryCredentialStore());
    await auth.useConnection('a');
    await auth.signIn(credentials(), 'a');
    await expect(auth.refresh(() => { throw new Error('adapter failed'); })).rejects.toThrow('adapter failed');
    expect((await auth.refresh(async () => credentials('recovered')))?.accessToken).toBe('recovered');
  });

  it('lets a new login refresh independently from a stale in-flight refresh', async () => {
    const auth = new AuthSession(new MemoryCredentialStore());
    await auth.useConnection('a');
    await auth.signIn(credentials('old'), 'a');
    const old = deferred<DeviceCredentials>();
    const oldRefresh = auth.refresh(() => old.promise);
    const rejected = expect(oldRefresh).rejects.toBeInstanceOf(StaleConnectionError);
    await auth.signIn(credentials('new-login'), 'a');
    expect((await auth.refresh(async () => credentials('new-login-refreshed')))?.accessToken).toBe('new-login-refreshed');
    old.resolve(credentials('stale'));
    await rejected;
    expect((await auth.credentials())?.accessToken).toBe('new-login-refreshed');
  });

  it('does not resurrect logged-out credentials when an old refresh completes', async () => {
    const store = new MemoryCredentialStore();
    const auth = new AuthSession(store);
    await auth.useConnection('a');
    await auth.signIn(credentials(), 'a');
    const result = deferred<DeviceCredentials>();
    const refreshing = auth.refresh(() => result.promise);
    const rejected = expect(refreshing).rejects.toBeInstanceOf(StaleConnectionError);
    await auth.signOut();
    result.resolve(credentials('new'));
    await rejected;
    expect(await store.get('a')).toBeNull();
    expect(auth.state.status).toBe('signed-out');
  });

  it('keeps a rotated token scoped to its original profile if the user switches during refresh', async () => {
    const store = new MemoryCredentialStore();
    const auth = new AuthSession(store);
    await auth.useConnection('a');
    await auth.signIn(credentials('a-old'), 'a');
    const result = deferred<DeviceCredentials>();
    const refreshing = auth.refresh(() => result.promise);
    const rejected = expect(refreshing).rejects.toBeInstanceOf(StaleConnectionError);
    await auth.useConnection('b');
    await auth.signIn(credentials('b'), 'b');
    result.resolve(credentials('a-new'));
    await rejected;
    expect((await store.get('a'))?.accessToken).toBe('a-new');
    expect((await auth.credentials())?.accessToken).toBe('b');
    expect(auth.state.connectionId).toBe('b');
  });

  it('can forget an inactive connection without logging out the active one or reviving its old refresh', async () => {
    const store = new MemoryCredentialStore();
    const auth = new AuthSession(store);
    await auth.useConnection('a');
    await auth.signIn(credentials('a'), 'a');
    const old = deferred<DeviceCredentials>();
    const refreshing = auth.refresh(() => old.promise);
    const rejected = expect(refreshing).rejects.toBeInstanceOf(StaleConnectionError);
    await auth.useConnection('b');
    await auth.signIn(credentials('b'), 'b');
    await auth.signOut('a');
    old.resolve(credentials('a-refreshed'));
    await rejected;
    expect(await store.get('a')).toBeNull();
    expect((await auth.credentials())?.accessToken).toBe('b');
    expect(auth.state.status).toBe('authenticated');
  });

  it('ignores late restore reads from a previous connection', async () => {
    const result = deferred<DeviceCredentials | null>();
    const auth = new AuthSession({
      persistent: true,
      get: id => id === 'a' ? result.promise : Promise.resolve(credentials('b')),
      set: async () => undefined,
      remove: async () => undefined,
    });
    const first = auth.useConnection('a');
    await auth.useConnection('b');
    result.resolve(credentials('a'));
    await first;
    expect((await auth.credentials())?.accessToken).toBe('b');
    expect(auth.state.connectionId).toBe('b');
  });

  it('does not let a late restore overwrite a newer login for the same connection', async () => {
    const restored = deferred<DeviceCredentials | null>();
    const auth = new AuthSession({
      persistent: true, get: () => restored.promise,
      set: async () => undefined, remove: async () => undefined,
    });
    const restoring = auth.useConnection('a');
    await auth.signIn(credentials('new-login'), 'a');
    restored.resolve(null);
    await restoring;
    expect((await auth.credentials())?.accessToken).toBe('new-login');
  });

  it('restores a rotated token when returning to its connection before refresh completes', async () => {
    const store = new MemoryCredentialStore();
    const auth = new AuthSession(store);
    await auth.useConnection('a');
    await auth.signIn(credentials('old'), 'a');
    const result = deferred<DeviceCredentials>();
    const refreshing = auth.refresh(() => result.promise);
    await auth.useConnection('b');
    await auth.useConnection('a');
    result.resolve(credentials('new'));
    expect((await refreshing)?.accessToken).toBe('new');
    expect((await auth.credentials())?.accessToken).toBe('new');
  });
});

describe('foreground polling', () => {
  it('pauses offline/background work and performs one refresh on resume', async () => {
    vi.useFakeTimers();
    const task = vi.fn(async () => undefined);
    const poller = new ForegroundPoller(task, { intervalMs: 1000 });
    poller.start();
    await flush();
    expect(task).toHaveBeenCalledTimes(1);
    poller.setForeground(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(task).toHaveBeenCalledTimes(1);
    poller.setOnline(false);
    poller.setForeground(true);
    await flush();
    expect(task).toHaveBeenCalledTimes(1);
    poller.setOnline(true);
    await flush();
    expect(task).toHaveBeenCalledTimes(2);
    poller.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(task).toHaveBeenCalledTimes(2);
  });

  it('never overlaps reads when a refresh is requested during an in-flight poll', async () => {
    vi.useFakeTimers();
    const first = deferred<void>();
    let active = 0;
    let peak = 0;
    const task = vi.fn(async () => {
      active += 1;
      peak = Math.max(active, peak);
      if (task.mock.calls.length === 1) await first.promise;
      active -= 1;
    });
    const poller = new ForegroundPoller(task, { intervalMs: 1000 });
    poller.start();
    poller.refresh();
    poller.refresh();
    expect(task).toHaveBeenCalledTimes(1);
    first.resolve();
    await flush();
    expect(task).toHaveBeenCalledTimes(2);
    expect(peak).toBe(1);
    poller.stop();
  });
});

describe('pending request journal', () => {
  it('persists stable IDs and a body digest without message contents', async () => {
    const storage = new Storage();
    const journal = new PendingRequests(storage);
    const fingerprint = await fingerprintRequest({ message: 'private message', deliver: false });
    const saved = journal.create('a', 'chat.send', { target: 'session-a', fingerprint }, 'request-0001');
    journal.update('a', saved.requestId, { status: 'unknown' });
    const recovered = new PendingRequests(storage).get('a', 'request-0001');
    expect(recovered?.status).toBe('unknown');
    expect(recovered?.fingerprint).toBe(fingerprint);
    expect(journal.list('b')).toEqual([]);
    expect([...storage.data.values()].join('')).not.toContain('private message');
    expect(journal.create('a', 'chat.send', { target: 'session-a', fingerprint }, 'request-0001').status).toBe('unknown');
    expect(() => journal.create('a', 'chat.send', { target: 'session-b', fingerprint }, 'request-0001')).toThrow('不同内容');
  });

  it('canonicalizes payload keys but keeps execution-relevant changes distinct', async () => {
    expect(await fingerprintRequest({ message: 'hello', deliver: false })).toBe(await fingerprintRequest({ deliver: false, message: 'hello' }));
    expect(await fingerprintRequest({ message: 'hello', deliver: false })).not.toBe(await fingerprintRequest({ message: 'hello', deliver: true }));
    expect(await fingerprintRequest({ message: 'hello', attachments: undefined })).toBe(await fingerprintRequest({ message: 'hello' }));
  });

  it('propagates journal write failures so callers cannot dispatch unrecorded requests', async () => {
    const storage = new Storage();
    storage.setItem = () => { throw new Error('Quota exceeded'); };
    const journal = new PendingRequests(storage);
    const fingerprint = await fingerprintRequest({ message: 'hello' });
    expect(() => journal.create('a', 'chat.send', { target: 's', fingerprint })).toThrow('Quota exceeded');
  });

  it('fails closed on damaged journal data instead of silently forgetting an unknown execution', () => {
    const storage = new Storage();
    storage.setItem('hosino.pending.v1.a', '{damaged');
    expect(() => new PendingRequests(storage).list('a')).toThrow('先核对远程会话状态');
  });
});
