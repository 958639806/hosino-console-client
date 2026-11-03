// This adapter is tree-shaken out of production. It never redirects real-server requests.
export const MOCK_ORIGIN = 'https://mock.hosino.invalid';
export const mockEnabled = import.meta.env.DEV && new URLSearchParams(location.search).get('mock') === '1';

export const devMockFetch: typeof fetch = async (input, init) => {
  const original = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const url = new URL(original);
  if (!mockEnabled || url.origin !== MOCK_ORIGIN) throw new Error('Mock 仅限显式开启的本地开发模式');
  const response = await fetch(`/mock-api${url.pathname}${url.search}`, init);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers: response.headers });
};

export function devMockXhr(): XMLHttpRequest {
  const xhr = new XMLHttpRequest();
  const responseUrl = Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, 'responseURL')?.get;
  if (responseUrl) Object.defineProperty(xhr, 'responseURL', { get() {
    const value = String(responseUrl.call(xhr));
    if (!value) return '';
    const url = new URL(value);
    return url.origin === location.origin && url.pathname.startsWith('/mock-api/')
      ? `${MOCK_ORIGIN}${url.pathname.slice('/mock-api'.length)}${url.search}` : value;
  } });
  const originalOpen = xhr.open.bind(xhr);
  xhr.open = ((method: string, input: string | URL, async: boolean = true, username?: string | null, password?: string | null) => {
    const url = new URL(String(input));
    if (!mockEnabled || url.origin !== MOCK_ORIGIN) throw new Error('Mock 上传地址无效');
    originalOpen(method, `/mock-api${url.pathname}${url.search}`, async, username, password);
  }) as typeof xhr.open;
  return xhr;
}
