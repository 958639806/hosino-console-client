import { Capacitor } from '@capacitor/core';
import { App } from '@capacitor/app';
import { Network } from '@capacitor/network';
import { Directory, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';

type LifecycleHandlers = {
  onForeground(active: boolean): void;
  onOnline(online: boolean): void;
  onBack(): boolean | void;
};

export async function installLifecycle(handlers: LifecycleHandlers): Promise<() => void> {
  const native = Capacitor.isNativePlatform();
  let nativeActive = !native;
  let nativeOnline = navigator.onLine;
  const visible = () => handlers.onForeground(document.visibilityState === 'visible' && nativeActive);
  const online = () => handlers.onOnline(native ? nativeOnline : navigator.onLine);
  document.addEventListener('visibilitychange', visible);
  window.addEventListener('online', online);
  window.addEventListener('offline', online);
  visible();
  online();
  const cleanup: Array<() => void> = [
    () => document.removeEventListener('visibilitychange', visible),
    () => window.removeEventListener('online', online),
    () => window.removeEventListener('offline', online),
  ];
  if (native) {
    const state = await App.addListener('appStateChange', ({ isActive }) => { nativeActive = isActive; visible(); });
    const network = await Network.addListener('networkStatusChange', ({ connected }) => { nativeOnline = connected; online(); });
    const back = await App.addListener('backButton', () => {
      if (handlers.onBack() === false) void App.minimizeApp();
    });
    const restored = await App.addListener('appRestoredResult', visible);
    cleanup.push(() => void state.remove(), () => void network.remove(), () => void back.remove(), () => void restored.remove());
    nativeActive = (await App.getState()).isActive;
    nativeOnline = (await Network.getStatus()).connected;
    visible();
    online();
  }
  return () => cleanup.forEach(fn => fn());
}

const safeName = (name: string) => {
  let value = name.replace(/[\\/\x00-\x1f\x7f]/g, '_');
  while (new TextEncoder().encode(value).length > 180) value = value.slice(1);
  return !value || value === '.' || value === '..' ? 'attachment' : value;
};
const temporaryUrls = new Set<string>();

export async function saveAndShare(blob: Blob, name: string, isCurrent: () => boolean = () => true): Promise<void> {
  if (!isCurrent()) return;
  if (!Capacitor.isNativePlatform()) {
    const url = URL.createObjectURL(blob);
    temporaryUrls.add(url);
    const link = document.createElement('a');
    link.href = url;
    link.download = safeName(name);
    link.click();
    setTimeout(() => { URL.revokeObjectURL(url); temporaryUrls.delete(url); }, 30_000);
    return;
  }
  const data = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = () => reject(new Error('文件读取失败'));
    reader.readAsDataURL(blob);
  });
  if (!isCurrent()) return;
  const path = `shares/${crypto.randomUUID()}/${safeName(name)}`;
  const file = await Filesystem.writeFile({ path, directory: Directory.Cache, data, recursive: true });
  if (!isCurrent()) { await Filesystem.deleteFile({ path, directory: Directory.Cache }).catch(() => {}); return; }
  await Share.share({ title: safeName(name), files: [file.uri] });
}

export async function clearSharedFiles(): Promise<void> {
  temporaryUrls.forEach(url => URL.revokeObjectURL(url));
  temporaryUrls.clear();
  if (Capacitor.isNativePlatform()) {
    await Filesystem.rmdir({ path: 'shares', directory: Directory.Cache, recursive: true }).catch(() => {});
  }
}
