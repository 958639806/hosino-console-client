export type Child = Node | string | number | null | undefined | false;

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', ...children: Child[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  append(node, ...children);
  return node;
}

export function append(node: HTMLElement, ...children: Child[]): void {
  for (const child of children) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

export function button(text: string, action: () => void | Promise<void>, className = 'button'): HTMLButtonElement {
  const node = el('button', className, text);
  node.type = 'button';
  node.addEventListener('click', () => { void action(); });
  return node;
}

export function field(labelText: string, input: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement): HTMLLabelElement {
  return el('label', 'field', el('span', 'field-label', labelText), input);
}

export function input(type: string, placeholder = '', value = ''): HTMLInputElement {
  const node = el('input', 'input');
  node.type = type;
  node.placeholder = placeholder;
  node.value = value;
  return node;
}

export function card(title: string, ...children: Child[]): HTMLElement {
  return el('section', 'card', el('h2', 'card-title', title), ...children);
}

export function text(value: unknown, fallback = '—'): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : fallback;
}

export function obj(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function array(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }

export function formatTime(value: unknown): string {
  const parsed = typeof value === 'string' || typeof value === 'number' ? new Date(value) : null;
  return parsed && !Number.isNaN(parsed.getTime()) ? parsed.toLocaleString('zh-CN', { hour12: false }) : '时间未知';
}

export function errorMessage(error: unknown): string {
  const record = obj(error);
  const status = typeof record.status === 'number' ? record.status : 0;
  if (record.code === 'AUTH_REVOKED') return '此设备的授权已撤销，请重新登录。';
  if (record.code === 'AUTH_EXPIRED' || status === 401) return '登录凭据已过期，请重新登录。';
  if (status === 403) return '服务器拒绝了此操作，请检查设备权限。';
  if (status === 404) return '目标不存在，或服务器未提供此接口。';
  if (status === 409) return '请求与服务器当前状态冲突。请先查询原请求结果。';
  if (status === 429) return '请求过于频繁，请稍后再试。';
  if (record.kind === 'timeout') return '请求超时；操作是否已执行需要查询确认。';
  if (record.kind === 'aborted') return '已停止本次传输。';
  if (status >= 500) return '服务器暂时无法完成请求，请稍后刷新状态。';
  if (!navigator.onLine) return '当前设备离线。连接恢复后将补拉状态。';
  return error instanceof Error ? error.message : '请求失败，请稍后再试。';
}
