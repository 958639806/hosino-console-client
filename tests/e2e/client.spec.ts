import { expect, test, type Page } from '@playwright/test';

async function login(page: Page) {
  await page.goto('/?mock=1');
  await page.getByRole('button', { name: '连接开发 Mock', exact: true }).click();
  await page.getByLabel('密码', { exact: true }).fill('mock-password');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '总览', exact: true })).toBeVisible();
  await expect(page.getByText('运行正常', { exact: true })).toBeVisible();
}

async function openChat(page: Page) {
  await page.locator('nav').getByRole('button', { name: /会话/ }).click();
  await page.getByRole('button', { name: /主会话.*agent:main:main/ }).click();
  await expect(page.getByLabel('消息内容')).toBeVisible();
}

test('手机布局完成登录、中文附件和发送；重复点击只提交一次', async ({ page }) => {
  let sends = 0;
  const uploads: string[] = [];
  page.on('request', request => {
    if (request.url().includes('/api/send') && request.method() === 'POST') sends++;
    if (request.url().includes('/api/uploads?') && request.method() === 'POST') uploads.push(request.url());
  });
  await login(page);
  await openChat(page);
  await page.getByLabel('选择图片或文件').setInputFiles({ name: '中文报告.txt', mimeType: 'text/plain', buffer: Buffer.from('Android 附件验证') });
  await expect(page.getByText('已上传 · 1 KB', { exact: true })).toBeVisible();
  const message = `测试附件 ${Date.now()}`;
  await page.getByLabel('消息内容').fill(message);
  await page.getByRole('button', { name: '发送', exact: true }).evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
  await expect(page.getByLabel('消息内容')).toHaveValue('');
  await expect(page.locator('.message-content').filter({ hasText: message })).toHaveCount(1);
  expect(sends).toBe(1);
  expect(decodeURIComponent(uploads[0])).toContain('中文报告.txt');
  const storage = await page.evaluate(() => JSON.stringify(localStorage));
  expect(storage).not.toContain('accessToken');
  expect(storage).not.toContain('refreshToken');
  await expect(page.getByText('开发 Mock ·', { exact: false })).toBeVisible();
  await page.screenshot({ path: 'test-results/android-chat.png', fullPage: true });
});

test('响应丢失后查询原请求，保留编号并清除已接收的原草稿', async ({ page }) => {
  await login(page);
  await openChat(page);
  const ids: string[] = [];
  await page.route('**/mock-api/api/send', async route => {
    ids.push(route.request().postDataJSON().requestId as string);
    await route.fetch(); // The server accepted it; only the reply is lost.
    await route.abort('failed');
  });
  await page.getByLabel('消息内容').fill(`丢失回执 ${Date.now()}`);
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByText('结果尚未确认', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '发送', exact: true }).click();
  expect(ids).toHaveLength(1);
  await page.getByRole('button', { name: '查询结果', exact: true }).click();
  await expect(page.getByLabel('消息内容')).toHaveValue('');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  expect(ids).toHaveLength(1);
});

test('离线保留登录，恢复网络后只补拉状态', async ({ page, context }) => {
  let sends = 0;
  page.on('request', request => { if (request.url().includes('/api/send')) sends++; });
  await login(page);
  await context.setOffline(true);
  await expect(page.locator('.status')).toHaveText('设备离线');
  await expect(page.getByLabel('密码', { exact: true })).toHaveCount(0);
  await context.setOffline(false);
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await expect(page.locator('.status')).toHaveText('已连接');
  expect(sends).toBe(0);
});

test('页面重建后查询持久化回执，不重新发送原草稿', async ({ page }) => {
  await login(page);
  await openChat(page);
  let sends = 0;
  await page.route('**/mock-api/api/send', async route => {
    sends++;
    await route.fetch();
    await route.abort('failed');
  });
  await page.getByLabel('消息内容').fill(`恢复追踪 ${Date.now()}`);
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByText('结果尚未确认', { exact: true })).toBeVisible();
  await page.reload();
  await page.locator('nav').getByRole('button', { name: /总览/ }).click();
  await page.getByLabel('密码', { exact: true }).fill('mock-password');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '总览', exact: true })).toBeVisible();
  await openChat(page);
  await page.getByRole('button', { name: '查询结果', exact: true }).click();
  await expect(page.getByLabel('消息内容')).toHaveValue('');
  expect(sends).toBe(1);
});

test('获授权的 CLI 页面启动一次并显示可查询终态', async ({ page }) => {
  let release!: () => void;
  const delay = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/mock-api/api/mobile/capabilities', async route => {
    const response = await route.fetch();
    if (!route.request().headers().authorization) await delay;
    await route.fulfill({ response });
  });
  await login(page);
  const staleResponse = page.waitForResponse(response => response.url().includes('/api/mobile/capabilities') && !response.request().headers().authorization);
  release();
  await staleResponse;
  await page.locator('nav').getByRole('button', { name: /管理/ }).click();
  await expect(page.getByRole('combobox', { name: '工具', exact: true })).toBeVisible();
  await page.getByLabel('新会话名称', { exact: true }).fill('浏览器 CLI 验证');
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: '新建 CLI 会话', exact: true }).click();
  await page.getByLabel('CLI 指令', { exact: true }).fill('mock only');
  let runs = 0;
  page.on('request', request => { if (/\/api\/cli\/sessions\/[^/]+\/run$/.test(request.url())) runs++; });
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: '启动远程运行', exact: true }).click();
  await expect(page.getByLabel('CLI 输出')).toContainText('Mock CLI 增量输出：中文。');
  await expect(page.getByText(/状态：completed · runId/)).toBeVisible();
  expect(runs).toBe(1);
});

test('切换连接时忽略上一连接迟到的响应', async ({ page }) => {
  await login(page);
  let release!: () => void;
  const delay = new Promise<void>(resolve => { release = resolve; });
  let requested!: () => void;
  const seen = new Promise<void>(resolve => { requested = resolve; });
  await page.route('**/mock-api/api/overview', async route => {
    requested();
    await delay;
    await route.fulfill({ json: { info: { hostname: 'OLD-CONNECTION-SECRET' }, health: { ok: true }, host: {} } });
  });
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await seen;
  await page.locator('nav').getByRole('button', { name: /设置/ }).click();
  await page.route('https://second.example.test/**', route => route.fulfill({ json: { apiVersion: 1, build: 'test-second', auth: ['device-bearer'], modules: { overview: true, sessions: true, chat: true, uploads: true, cli: false }, permissions: { cli: false } } }));
  await page.getByLabel('连接名称', { exact: true }).fill('第二连接');
  await page.getByLabel('服务器地址', { exact: true }).fill('https://second.example.test');
  await page.getByRole('button', { name: '保存并连接', exact: true }).click();
  await expect(page.locator('.header-detail')).toContainText('第二连接');
  release();
  await page.locator('nav').getByRole('button', { name: /总览/ }).click();
  await expect(page.getByLabel('密码', { exact: true })).toBeVisible();
  await expect(page.getByText('OLD-CONNECTION-SECRET', { exact: false })).toHaveCount(0);
});

test('退出清除本机状态，浏览器刷新也不会持久化令牌', async ({ page }) => {
  await login(page);
  await page.reload();
  await page.locator('nav').getByRole('button', { name: /总览/ }).click();
  await expect(page.getByLabel('密码', { exact: true })).toBeVisible();
  await page.getByLabel('密码', { exact: true }).fill('mock-password');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '总览', exact: true })).toBeVisible();
  await page.locator('nav').getByRole('button', { name: /设置/ }).click();
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: '退出并清除本机凭据', exact: true }).click();
  await expect(page.getByText('已退出，服务器设备授权已撤销。', { exact: true })).toBeVisible();
  await page.locator('nav').getByRole('button', { name: /总览/ }).click();
  await expect(page.getByLabel('密码', { exact: true })).toBeVisible();
});
