import { Capacitor, registerPlugin } from '@capacitor/core';

export interface DeviceCredentials {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: number;
  refreshExpiresAt: number;
  device: { id: string; name: string };
  permissions?: { cli: boolean };
}

export interface SecureCredentialStore {
  /** False in the browser: credentials survive neither reload nor process death. */
  readonly persistent: boolean;
  get(connectionId: string): Promise<DeviceCredentials | null>;
  set(connectionId: string, credentials: DeviceCredentials): Promise<void>;
  remove(connectionId: string): Promise<void>;
}

export interface SecureCredentialsPlugin {
  get(options: { key: string }): Promise<{ value: string | null }>;
  set(options: { key: string; value: string }): Promise<void>;
  remove(options: { key: string }): Promise<void>;
}

const nativeCredentials = registerPlugin<SecureCredentialsPlugin>('SecureCredentials');

export function validCredentials(value: unknown): value is DeviceCredentials {
  if (!value || typeof value !== 'object') return false;
  const credentials = value as Partial<DeviceCredentials>;
  return typeof credentials.accessToken === 'string' && credentials.accessToken.length > 0
    && typeof credentials.refreshToken === 'string' && credentials.refreshToken.length > 0
    && typeof credentials.accessExpiresAt === 'number' && Number.isFinite(credentials.accessExpiresAt)
    && typeof credentials.refreshExpiresAt === 'number' && Number.isFinite(credentials.refreshExpiresAt)
    && !!credentials.device && typeof credentials.device.id === 'string' && credentials.device.id.length > 0
    && typeof credentials.device.name === 'string'
    && (credentials.permissions === undefined || (!!credentials.permissions && typeof credentials.permissions.cli === 'boolean'));
}

export function copyCredentials(value: DeviceCredentials): DeviceCredentials {
  return {
    accessToken: value.accessToken,
    refreshToken: value.refreshToken,
    accessExpiresAt: value.accessExpiresAt,
    refreshExpiresAt: value.refreshExpiresAt,
    device: { ...value.device },
    ...(value.permissions ? { permissions: { ...value.permissions } } : {}),
  };
}

function credentialKey(connectionId: string): string {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(connectionId)) throw new Error('连接标识无效');
  return `hosino.device.v1.${connectionId}`;
}

/** Browser development deliberately uses memory, never localStorage/Preferences. */
export class MemoryCredentialStore implements SecureCredentialStore {
  readonly persistent = false;
  private values = new Map<string, DeviceCredentials>();

  async get(connectionId: string): Promise<DeviceCredentials | null> {
    const value = this.values.get(credentialKey(connectionId));
    return value ? copyCredentials(value) : null;
  }

  async set(connectionId: string, credentials: DeviceCredentials): Promise<void> {
    if (!validCredentials(credentials)) throw new Error('服务器返回的设备凭据无效');
    this.values.set(credentialKey(connectionId), copyCredentials(credentials));
  }

  async remove(connectionId: string): Promise<void> { this.values.delete(credentialKey(connectionId)); }
}

export class NativeCredentialStore implements SecureCredentialStore {
  readonly persistent = true;

  constructor(private readonly plugin: SecureCredentialsPlugin = nativeCredentials) {}

  async get(connectionId: string): Promise<DeviceCredentials | null> {
    const { value } = await this.plugin.get({ key: credentialKey(connectionId) });
    if (value === null) return null;
    let parsed: unknown;
    try { parsed = JSON.parse(value); } catch { throw new Error('安全存储中的凭据损坏，请清除该连接凭据后重新登录'); }
    if (!validCredentials(parsed)) throw new Error('安全存储中的凭据无效，请清除该连接凭据后重新登录');
    return copyCredentials(parsed);
  }

  async set(connectionId: string, credentials: DeviceCredentials): Promise<void> {
    if (!validCredentials(credentials)) throw new Error('服务器返回的设备凭据无效');
    // Native failures are surfaced. Falling back to ordinary preferences would expose tokens.
    await this.plugin.set({ key: credentialKey(connectionId), value: JSON.stringify(copyCredentials(credentials)) });
  }

  async remove(connectionId: string): Promise<void> { await this.plugin.remove({ key: credentialKey(connectionId) }); }
}

export function createCredentialStore(): SecureCredentialStore {
  return Capacitor.isNativePlatform() ? new NativeCredentialStore() : new MemoryCredentialStore();
}
