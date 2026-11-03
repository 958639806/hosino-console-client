import { Capacitor } from '@capacitor/core';
import { ConsoleClient, type Capabilities, type ChatHistory, type ChatMessage, type Session, type SendRequest, type Upload, type UploadTask, type SseEvent } from '../api';
import { AuthSession, ConnectionProfiles, createCredentialStore, ForegroundPoller, PendingRequests, type ConnectionProfile, type ConnectionSnapshot, type PendingRequest } from '../core';
import { clearSharedFiles, installLifecycle, saveAndShare } from '../native/platform';
import { devMockFetch, devMockXhr, mockEnabled, MOCK_ORIGIN } from '../native/mock';
import { append, array, button, card, el, errorMessage, field, formatTime, input, obj, text } from './dom';

type Tab = 'overview' | 'sessions' | 'manage' | 'settings';
type ChatSubmission = { kind: 'chat'; body: SendRequest };
type CliSubmission = { kind: 'cli'; sessionId: string; prompt: string; requestId: string };
type Submission = ChatSubmission | CliSubmission;
interface AttachmentView { upload?: Upload; task?: UploadTask; row: HTMLElement; name: string; state: 'preparing' | 'uploading' | 'ready' | 'failed' | 'cancelled'; }

const tabNames: Record<Tab, string> = { overview: '总览', sessions: '会话', manage: '管理', settings: '设置' };
const tabIcons: Record<Tab, string> = { overview: '◉', sessions: '☷', manage: '◇', settings: '⚙' };
const authNames = { 'signed-out': '未登录', authenticated: '已连接', expired: '凭据过期', forbidden: '权限受限', unreachable: '服务器不可达', offline: '设备离线' };
const pendingNames = { prepared: '已保存待确认', sending: '正在提交', unknown: '结果尚未确认', accepted: '服务器已接收', failed: '请求失败' };

export class ClientApp {
  private readonly profiles = new ConnectionProfiles(localStorage);
  private readonly credentials = createCredentialStore();
  private readonly auth = new AuthSession(this.credentials);
  private readonly pending = new PendingRequests(localStorage);
  private readonly submissions = new Map<string, Submission>();
  private readonly submittedAttachments = new Map<string, () => void>();
  private readonly draftViews = new Map<string, HTMLTextAreaElement>();
  private readonly objectUrls = new Set<string>();
  private readonly uploadTasks = new Set<UploadTask>();
  private readonly aborts = new Set<AbortController>();
  private readonly shell = el('div', 'app-shell');
  private readonly headingDetail = el('div', 'header-detail');
  private readonly status = el('span', 'status', '未连接');
  private readonly notice = el('div', 'notice');
  private readonly content = el('main');
  private readonly nav = el('nav', 'bottom-nav');
  private readonly poller = new ForegroundPoller(() => this.refreshVisible(), { intervalMs: 8000, onError: error => this.handleError(error) });
  private client: ConsoleClient | null = null;
  private capabilities: Capabilities | null = null;
  private hasCredentials = false;
  private tab: Tab = 'overview';
  private selectedSession: Session | null = null;
  private cliSessionId: string | null = null;
  private sessionOffset = 0;
  private sessionQuery = '';
  private revision = 0;
  private negotiation = 0;
  private refreshCurrent: (() => Promise<void>) | null = null;
  private foreground = !document.hidden;
  private started = false;
  private stopNative: (() => void) | undefined;
  private chatSending = false;
  private cliRunning = false;

  constructor(private readonly root: HTMLElement) {}

  async start(): Promise<void> {
    this.notice.setAttribute('role', 'status');
    this.notice.setAttribute('aria-live', 'polite');
    this.nav.setAttribute('aria-label', '主导航');
    const brand = el('div', '', el('div', 'brand', 'HOSINO'), this.headingDetail);
    append(this.shell, el('header', 'app-header', brand, this.status), this.notice, this.content);
    this.root.replaceChildren(this.shell, this.nav);
    this.auth.subscribe(() => this.updateStatus());
    this.profiles.subscribe(() => { void this.connect(); });
    this.stopNative = await installLifecycle({
      onForeground: active => { this.foreground = active; this.poller.setForeground(active); },
      onOnline: online => { this.poller.setOnline(online); if (!online) this.auth.recordFailure({ kind: 'offline' }, false); this.updateStatus(); },
      onBack: () => this.back(),
    });
    this.poller.setForeground(this.foreground);
    this.poller.setOnline(navigator.onLine);
    const theme = localStorage.getItem('hosino.theme');
    if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
    this.started = true;
    await this.connect();
    this.poller.start();
  }

  dispose(): void {
    this.poller.stop();
    this.stopNative?.();
    this.cancelLocalTransfers();
  }

  private isMock(profile = this.profiles.active()): boolean {
    return mockEnabled && profile?.url === MOCK_ORIGIN;
  }

  private async connect(): Promise<void> {
    this.cancelLocalTransfers();
    this.revision += 1;
    const snapshot = this.profiles.snapshot();
    this.capabilities = null;
    this.hasCredentials = false;
    this.selectedSession = null;
    this.cliSessionId = null;
    this.chatSending = false;
    this.cliRunning = false;
    this.sessionOffset = 0;
    this.sessionQuery = '';
    this.submissions.clear(); this.submittedAttachments.clear(); this.draftViews.clear();
    this.client = null;
    this.refreshCurrent = null;
    this.clearNotice();
    this.updateStatus();
    const profile = snapshot.profile;
    if (!profile) { this.tab = 'settings'; this.render(); return; }
    this.content.replaceChildren(el('p', 'loading', '正在读取连接…'));
    try {
      await this.auth.useConnection(profile.id);
      if (!this.profiles.isCurrent(snapshot)) return;
      const restoredCredentials = await this.auth.credentials();
      if (!this.profiles.isCurrent(snapshot)) return;
      this.hasCredentials = !!restoredCredentials;
      const client: ConsoleClient = new ConsoleClient({
        baseUrl: profile.url,
        getAccessToken: async () => {
          if (!this.profiles.isCurrent(snapshot)) throw new Error('连接已切换');
          let credentials = await this.auth.credentials();
          if (!this.profiles.isCurrent(snapshot)) throw new Error('连接已切换');
          if (!credentials) return null;
          if (credentials.accessExpiresAt <= Date.now() + 30_000) credentials = await this.auth.refresh(token => client.refresh(token));
          if (!this.profiles.isCurrent(snapshot)) throw new Error('连接已切换');
          return credentials?.accessToken ?? null;
        },
        ...(import.meta.env.DEV && this.isMock(profile) ? { fetch: devMockFetch, xhrFactory: devMockXhr } : {}),
      });
      this.client = client;
      this.render();
      await this.negotiate(snapshot, client);
    } catch (error) {
      if (this.profiles.isCurrent(snapshot)) { this.handleError(error); this.render(); }
    }
  }

  private async negotiate(snapshot: ConnectionSnapshot, client: ConsoleClient): Promise<void> {
    const generation = ++this.negotiation;
    try {
      const capabilities = await client.capabilities();
      if (!this.profiles.isCurrent(snapshot) || client !== this.client || generation !== this.negotiation) return;
      if (capabilities.apiVersion !== 1 || !capabilities.auth.includes('device-bearer')) {
        throw new Error('服务器尚未支持本客户端的设备认证协议，请先升级 hosino-console。');
      }
      this.capabilities = capabilities;
      this.auth.recordSuccess();
      // Public discovery can finish while the user types a password. Preserve
      // that form; authenticated negotiation is what opens the main workflow.
      if (this.hasCredentials) this.render();
    } catch (error) {
      if (!this.profiles.isCurrent(snapshot) || generation !== this.negotiation) return;
      if (obj(error).status === 404) this.showNotice('服务器缺少移动端接口，请先安装配套的 hosino-console 服务端改造。', 'error');
      else this.handleError(error);
    }
  }

  private updateStatus(): void {
    const profile = this.profiles.active();
    this.headingDetail.textContent = profile ? `${profile.name} · ${profile.url}` : 'Android 远程客户端';
    this.status.textContent = !navigator.onLine ? '设备离线' : profile ? authNames[this.auth.state.status] : '未配置连接';
    this.status.dataset.kind = this.auth.state.status === 'authenticated' && navigator.onLine ? 'good' : this.auth.state.status === 'signed-out' ? '' : 'bad';
  }

  private render(): void {
    if (!this.started) return;
    this.revision += 1;
    this.refreshCurrent = null;
    this.draftViews.clear();
    this.content.replaceChildren();
    this.nav.replaceChildren();
    for (const tab of Object.keys(tabNames) as Tab[]) {
      const item = button('', () => this.navigate(tab), 'nav-button');
      append(item, el('span', 'nav-icon', tabIcons[tab]), el('span', '', tabNames[tab]));
      if (this.tab === tab) item.setAttribute('aria-current', 'page');
      this.nav.append(item);
    }
    if (this.isMock()) this.content.append(el('div', 'banner', '开发 Mock · 此处为模拟数据，不连接真实 OpenClaw，不作为服务或真机验收结果。'));
    if (this.tab === 'settings') { this.renderSettings(); return; }
    if (!this.profiles.active()) { this.renderSettings(); return; }
    if (!this.hasCredentials) { this.renderLogin(); return; }
    if (this.auth.state.status === 'expired') this.content.append(el('div', 'banner error', '凭据已过期。可在设置中重新登录；网络故障不会清除已有凭据。'));
    if (this.tab === 'overview') this.renderOverview();
    else if (this.tab === 'sessions') this.selectedSession ? this.renderChat(this.selectedSession) : this.renderSessions();
    else if (this.cliSessionId) this.renderCli(this.cliSessionId);
    else this.renderManagement();
  }

  private navigate(tab: Tab): void {
    this.cancelObservation();
    this.tab = tab;
    if (tab !== 'sessions') this.selectedSession = null;
    if (tab !== 'manage') this.cliSessionId = null;
    this.clearNotice();
    this.render();
    window.scrollTo({ top: 0 });
  }

  private back(): boolean {
    if (this.selectedSession) { this.cancelObservation(); this.selectedSession = null; this.render(); return true; }
    if (this.cliSessionId) { this.cancelObservation(); this.cliSessionId = null; this.render(); return true; }
    if (this.tab !== 'overview') { this.navigate('overview'); return true; }
    return false;
  }

  private pageTitle(title: string, refresh?: () => Promise<void>): void {
    const row = el('div', 'page-heading', el('h1', '', title));
    if (refresh) row.append(button('刷新', () => this.runAction(refresh), 'button small'));
    this.content.append(row);
  }

  private showNotice(message: string, type = ''): void {
    this.notice.className = `notice banner ${type}`;
    this.notice.textContent = message;
  }

  private clearNotice(): void { this.notice.className = 'notice'; this.notice.textContent = ''; }

  private handleError(error: unknown): void {
    this.auth.recordFailure(obj(error), navigator.onLine);
    this.showNotice(errorMessage(error), 'error');
  }

  private async runAction(action: () => Promise<void>, clicked?: HTMLButtonElement): Promise<void> {
    const snapshot = this.profiles.snapshot();
    if (clicked) clicked.disabled = true;
    try { await action(); } catch (error) { if (this.profiles.isCurrent(snapshot)) this.handleError(error); }
    finally { if (clicked?.isConnected) clicked.disabled = false; }
  }

  private guarded<T>(snapshot: ConnectionSnapshot, revision: number, result: T): T | undefined {
    return this.profiles.isCurrent(snapshot) && this.revision === revision ? result : undefined;
  }

  private async refreshVisible(): Promise<void> {
    if (!this.hasCredentials || !this.client || !this.foreground || !navigator.onLine) return;
    const snapshot = this.profiles.snapshot();
    try { await this.refreshCurrent?.(); } catch (error) { if (this.profiles.isCurrent(snapshot)) throw error; return; }
    if (this.profiles.isCurrent(snapshot) && snapshot.profile) {
      const unresolved = this.pending.list(snapshot.profile.id).filter(item => ['prepared', 'sending', 'unknown'].includes(item.status)).slice(0, 3);
      for (const item of unresolved) {
        if (!this.profiles.isCurrent(snapshot)) return;
        try { await this.queryPending(item, true); } catch (error) {
          if (!this.profiles.isCurrent(snapshot)) return;
          if (obj(error).status !== 404) throw error;
        }
      }
      this.updateStatus();
    }
  }

  private renderLogin(): void {
    const profile = this.profiles.active();
    if (!profile || !this.client) return;
    this.pageTitle('连接到你的控制台');
    const password = input('password', '服务器登录密码');
    password.autocomplete = 'current-password';
    password.required = true;
    const device = input('text', '设备名称', Capacitor.isNativePlatform() ? 'Android 手机' : '浏览器调试设备');
    device.maxLength = 80;
    const form = el('form', '', field('密码', password), field('设备名称', device));
    const submit = el('button', 'button primary', '登录');
    submit.type = 'submit';
    append(form, submit, el('p', 'hint', Capacitor.isNativePlatform() ? '设备凭据存入由 Android Keystore 保护的本机存储。网关凭据保留在服务器。' : '浏览器调试模式：设备凭据仅在内存保留，刷新页面后需要重新登录。'));
    form.addEventListener('submit', event => {
      event.preventDefault();
      const snapshot = this.profiles.snapshot();
      const client = this.client!;
      void this.runAction(async () => {
        const credentials = await client.login(password.value, device.value.trim() || 'Android 手机');
        password.value = '';
        if (!this.profiles.isCurrent(snapshot)) return;
        await this.auth.signIn(credentials, snapshot.profile!.id);
        if (!this.profiles.isCurrent(snapshot)) return;
        this.hasCredentials = true;
        this.clearNotice();
        await this.negotiate(snapshot, client);
      }, submit);
    });
    this.content.append(card(profile.name, el('p', 'muted', profile.url), form), button('管理连接', () => this.navigate('settings'), 'button link'));
  }

  private renderSettings(): void {
    this.pageTitle('设置');
    const active = this.profiles.active();
    if (active) {
      const account = card('当前连接', el('strong', '', active.name), el('p', 'hint', active.url));
      if (this.hasCredentials) {
        const logout = button('退出并清除本机凭据', async () => {
          if (!window.confirm('退出当前连接？将尝试撤销服务器上的此设备授权，并清除本机凭据和草稿。')) return;
          const snapshot = this.profiles.snapshot();
          this.hasCredentials = false; this.cancelLocalTransfers(); this.revision += 1;
          logout.disabled = true;
          let revoked = false;
          try { await this.client?.logout(); revoked = true; } catch { /* Offline logout still clears local secrets. */ }
          await this.auth.signOut(active.id);
          const stillCurrent = this.profiles.isCurrent(snapshot);
          if (stillCurrent) this.hasCredentials = false;
          this.pending.clear(active.id);
          this.clearDrafts(active.id);
          await clearSharedFiles();
          if (!this.profiles.isCurrent(snapshot)) return;
          this.cancelLocalTransfers();
          this.capabilities = null;
          this.render();
          this.showNotice(revoked ? '已退出，服务器设备授权已撤销。' : '本机凭据已清除。服务器撤销未确认，请在可连接时从其他已登录设备撤销此设备。', revoked ? 'success' : 'error');
        }, 'button danger');
        account.append(logout);
      } else account.append(button('登录此连接', () => this.navigate('overview'), 'button primary'));
      if (this.auth.state.status === 'expired' && this.hasCredentials) account.append(button('重新登录', async () => { await this.auth.signOut(); this.hasCredentials = false; this.navigate('overview'); }, 'button'));
      this.content.append(account);
    }
    const connections = card('连接配置');
    for (const profile of this.profiles.list()) {
      const row = el('div', 'data-row', el('div', 'grow', el('span', 'row-title', profile.name), el('span', 'row-meta', profile.url)));
      if (profile.id === active?.id) row.append(el('span', 'pill', '当前'));
      else row.append(button('切换', () => { this.profiles.activate(profile.id); }, 'button small'));
      row.append(button('移除', async () => {
        if (!window.confirm(`移除连接“${profile.name}”并清除本机凭据、草稿和追踪记录？远程任务不会停止。`)) return;
        await this.auth.signOut(profile.id);
        this.pending.clear(profile.id);
        this.clearDrafts(profile.id);
        this.profiles.remove(profile.id);
        this.render();
      }, 'button small danger'));
      connections.append(row);
    }
    if (!this.profiles.list().length) connections.append(el('p', 'hint', '添加 HTTPS 控制台地址后，即可从手机访问远程服务器。'));
    const name = input('text', '例如：家里的控制台'); name.required = true; name.maxLength = 80;
    const url = input('url', 'https://console.example.com'); url.required = true; url.autocomplete = 'off';
    const form = el('form', '', field('连接名称', name), field('服务器地址', url));
    const add = el('button', 'button primary', '保存并连接'); add.type = 'submit';
    form.append(add);
    form.addEventListener('submit', event => {
      event.preventDefault();
      try { const profile = this.profiles.save({ name: name.value, url: url.value }); this.profiles.activate(profile.id); name.value = ''; url.value = ''; }
      catch (error) { this.handleError(error); }
    });
    connections.append(form);
    this.content.append(connections);
    const theme = el('select', 'input');
    for (const [value, label] of [['system', '跟随系统'], ['light', '浅色'], ['dark', '深色']]) {
      const option = el('option', '', label); option.value = value; theme.append(option);
    }
    theme.value = localStorage.getItem('hosino.theme') || 'system';
    theme.addEventListener('change', () => {
      if (theme.value === 'system') { localStorage.removeItem('hosino.theme'); delete document.documentElement.dataset.theme; }
      else { localStorage.setItem('hosino.theme', theme.value); document.documentElement.dataset.theme = theme.value; }
    });
    this.content.append(card('外观', field('主题', theme)));
    const about = card('Android 内测', el('p', 'hint', '界面资源随安装包提供；远程执行、网关连接及服务器文件操作由 hosino-console 承担。'), el('p', 'hint', Capacitor.isNativePlatform() ? '运行环境：Android 原生容器' : '运行环境：浏览器调试，凭据不会持久化'));
    if (this.capabilities) about.append(el('p', 'hint', `服务端协议 v${this.capabilities.apiVersion} · ${this.capabilities.build}`));
    if (mockEnabled) about.append(button('连接开发 Mock', () => {
      const existing = this.profiles.list().find(profile => profile.url === MOCK_ORIGIN);
      const profile = existing ?? this.profiles.save({ name: '开发 Mock（模拟数据）', url: MOCK_ORIGIN });
      this.profiles.activate(profile.id);
      this.tab = 'overview';
    }, 'button'));
    this.content.append(about);
  }

  private renderOverview(): void {
    const host = el('div', '', el('p', 'loading', '正在读取远程状态…'));
    const snapshot = this.profiles.snapshot(), revision = this.revision, client = this.client!;
    const refresh = async () => {
      const data = this.guarded(snapshot, revision, await client.overview());
      if (!data) return;
      this.auth.recordSuccess();
      const info = obj(data.info), machine = obj(data.host), memory = obj(machine.mem), health = obj(data.health);
      const metrics = el('div', 'metric-grid');
      const values: [string, string][] = [
        ['网关', health.ok === true || health.status === 'ok' ? '运行正常' : text(health.status, '已响应')],
        ['CPU', typeof machine.cpu === 'number' ? `${machine.cpu.toFixed(1)}%` : text(machine.cpu)],
        ['内存', typeof memory.percent === 'number' ? `${memory.percent.toFixed(1)}%` : text(memory.usedPercent)],
        ['运行时间', typeof machine.uptime === 'number' ? `${Math.floor(machine.uptime / 3600)} 小时` : text(machine.uptime)],
      ];
      for (const [label, value] of values) metrics.append(el('div', 'metric', el('span', 'metric-label', label), el('strong', 'metric-value', value)));
      const details = el('details', 'details', el('summary', '', '查看服务器返回的运行信息'), el('pre', '', JSON.stringify({ info, health, status: data.status, gw: data.gw }, null, 2)));
      host.replaceChildren(card('远程服务', metrics, el('p', 'hint', `最后更新 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`)), card('基础信息', el('p', '', text(info.hostname ?? info.host, '服务器已连接')), details));
    };
    this.pageTitle('总览', refresh);
    this.content.append(host);
    this.refreshCurrent = refresh;
    void this.runAction(refresh);
  }

  private renderSessions(): void {
    const query = input('search', '搜索当前页会话', this.sessionQuery);
    const form = el('form', 'search-form', query);
    const search = el('button', 'button', '搜索'); search.type = 'submit'; form.append(search);
    const list = el('div', 'data-list');
    const footer = el('div', 'actions spread');
    const snapshot = this.profiles.snapshot(), revision = this.revision, client = this.client!;
    const refresh = async () => {
      const data = this.guarded(snapshot, revision, await client.sessions(this.sessionOffset, this.sessionQuery || undefined));
      if (!data) return;
      this.auth.recordSuccess();
      list.replaceChildren();
      for (const session of data.sessions) {
        const open = button('', () => { this.selectedSession = session; this.clearNotice(); this.render(); window.scrollTo({ top: 0 }); }, 'session-open');
        append(open, el('span', 'row-title', session.alias || session.displayName || session.label || session.key), el('span', 'row-meta', `${session.channel || '控制台'} · ${session.hasActiveRun ? '正在运行' : '会话'} · ${session.key}`));
        list.append(el('div', 'data-row', open));
      }
      if (!data.sessions.length) list.append(el('p', 'empty', this.sessionQuery ? '当前页没有匹配的会话。可翻页继续查找。' : '当前页暂无会话。'));
      footer.replaceChildren();
      const previous = button('上一页', () => { this.sessionOffset = Math.max(0, this.sessionOffset - 200); this.render(); }); previous.disabled = this.sessionOffset === 0;
      const next = button('下一页', () => { this.sessionOffset += 200; this.render(); });
      next.disabled = typeof data.totalCount === 'number' ? this.sessionOffset + 200 >= data.totalCount : data.sessions.length < 200 && !this.sessionQuery;
      append(footer, previous, el('span', 'hint', `${this.sessionOffset + 1} 起${typeof data.totalCount === 'number' ? ` · 共 ${data.totalCount} 个` : ''}`), next);
    };
    form.addEventListener('submit', event => { event.preventDefault(); this.sessionQuery = query.value.trim(); void this.runAction(refresh); });
    this.pageTitle('会话', refresh);
    append(this.content, form, el('p', 'hint', '搜索作用于服务器当前返回的最多 200 个会话；翻页可继续查找。'), card('远程会话', list, footer));
    this.refreshCurrent = refresh;
    void this.runAction(refresh);
  }

  private renderChat(session: Session): void {
    const client = this.client!, snapshot = this.profiles.snapshot(), revision = this.revision, profile = snapshot.profile!;
    const header = el('div', 'page-heading', button('‹ 会话', () => { this.selectedSession = null; this.render(); }, 'button small'), el('h1', 'chat-title', session.alias || session.displayName || session.key));
    this.content.append(header);
    const pendingHost = el('div');
    const more = button('加载较早消息', async () => {
      if (!history?.nextBefore) return;
      await this.runAction(async () => {
        const older = this.guarded(snapshot, revision, await client.history(session.key, 60, history!.nextBefore!));
        if (!older) return;
        const seen = new Set(messages.map(message => String(message.id ?? message.index)));
        messages = [...older.messages.filter(message => !seen.has(String(message.id ?? message.index))), ...messages];
        history = older;
        paintHistory();
      }, more);
    });
    const windowHint = el('p', 'hint');
    const historyHost = el('div', 'history'); historyHost.setAttribute('aria-live', 'off');
    let history: ChatHistory | null = null;
    let messages: ChatMessage[] = [];
    const attachments: AttachmentView[] = [];
    const textarea = el('textarea', 'input'); textarea.placeholder = '继续这段远程会话…'; textarea.maxLength = 200_000; textarea.value = this.getDraft(profile.id, session.key);
    textarea.setAttribute('aria-label', '消息内容');
    this.draftViews.set(this.draftKey(profile.id, session.key), textarea);
    textarea.addEventListener('input', () => this.setDraft(profile.id, session.key, textarea.value));
    const deliver = input('checkbox');
    const mode = el('p', 'delivery-note', '仅在控制台继续对话，不向 QQ 投递。');
    deliver.addEventListener('change', () => { mode.textContent = deliver.checked ? '将通过服务器向该会话对应的 QQ 目标投递，请确认目标。' : '仅在控制台继续对话，不向 QQ 投递。'; mode.classList.toggle('warning', deliver.checked); });
    const tray = el('div');
    const file = input('file'); file.className = 'file-input'; file.multiple = true; file.setAttribute('aria-label', '选择图片或文件');
    const uploadHint = el('p', 'hint', '附件限制以服务器返回值为准。');
    const composer = el('form', 'composer', textarea, el('label', 'toggle-row', deliver, '投递到 QQ'), mode, tray);
    const send = el('button', 'button primary', '发送'); send.type = 'submit';
    const stop = button('停止远程回复', async () => {
      if (!window.confirm(`停止会话“${session.displayName || session.key}”当前的远程运行？断开网络不会自动停止它。`)) return;
      await this.runAction(async () => { await client.abort(session.key); if (this.profiles.isCurrent(snapshot)) this.showNotice('停止请求已提交，请刷新确认远程运行状态。'); }, stop);
    }, 'button danger');
    const actions = el('div', 'actions spread', send, stop);
    append(composer, this.capabilities?.modules.uploads === false ? el('p', 'hint', '服务器未提供附件上传能力。') : file, uploadHint, actions);
    const paintPending = () => this.renderPending(pendingHost, session.key);
    let paintedHistory = '';
    const paintHistory = () => {
      more.disabled = !history?.nextBefore;
      more.hidden = !history?.hasMore;
      windowHint.textContent = history?.gatewayHasMore && !history.nextBefore ? '已到达服务器可提供的历史窗口边界，更早内容暂不可加载。' : history?.windowCount ? `当前服务器历史窗口 ${history.windowCount} 条` : '';
      const signature = JSON.stringify(messages);
      if (signature === paintedHistory) return;
      paintedHistory = signature;
      for (const url of this.objectUrls) URL.revokeObjectURL(url); this.objectUrls.clear();
      historyHost.replaceChildren();
      for (const message of messages) historyHost.append(this.messageView(message, client, snapshot));
      if (!messages.length) historyHost.append(el('p', 'empty', '尚无可显示的历史消息。'));
    };
    const refresh = async () => {
      const latest = this.guarded(snapshot, revision, await client.history(session.key, 60));
      if (!latest) return;
      this.auth.recordSuccess();
      if (!history || messages.length <= 60) { history = latest; messages = latest.messages; }
      else {
        const byId = new Map(messages.map(message => [String(message.id ?? message.index), message]));
        for (const message of latest.messages) byId.set(String(message.id ?? message.index), message);
        messages = [...byId.values()];
      }
      paintHistory();
      paintPending();
    };
    const uploadBlocked = () => attachments.some(item => item.state !== 'ready');
    const updateSend = () => { send.disabled = this.chatSending || uploadBlocked(); };
    file.addEventListener('change', () => {
      const files = [...(file.files || [])]; file.value = '';
      for (const selected of files) {
        const row = el('div', 'attachment'), progress = el('progress'); progress.max = 1; progress.value = 0;
        const state = el('span', 'row-meta', '准备上传');
        const entry: AttachmentView = { row, name: selected.name, state: 'preparing' };
        const detail = el('div', 'grow', el('strong', '', selected.name), state, progress);
        const retry = button('重试', () => { void attempt(); }, 'button small'); retry.hidden = true;
        const remove = () => {
          const index = attachments.indexOf(entry); if (index >= 0) attachments.splice(index, 1);
          row.remove(); updateSend();
          if (entry.upload) void client.deleteUpload(entry.upload.id).catch(error => { if (this.profiles.isCurrent(snapshot)) this.handleError(error); });
        };
        const cancel = button('取消', () => {
          if (entry.state === 'uploading') entry.task?.abort();
          else if (entry.state === 'preparing') { entry.state = 'cancelled'; state.textContent = '已取消'; progress.remove(); cancel.textContent = '移除'; retry.hidden = false; updateSend(); }
          else remove();
        }, 'button small');
        append(row, detail, retry, cancel); tray.append(row); attachments.push(entry); updateSend();
        const attempt = async () => {
          if (entry.state === 'uploading') return;
          entry.state = 'preparing'; entry.upload = undefined; retry.hidden = true;
          state.textContent = '正在读取上传限制…'; progress.value = 0; if (!progress.isConnected) detail.append(progress); cancel.textContent = '取消'; updateSend();
          let task: UploadTask | undefined;
          try {
            const limits = obj(await client.uploadLimits());
            if (!this.profiles.isCurrent(snapshot) || this.revision !== revision || entry.state !== 'preparing') return;
            const scoped = obj(limits.chat);
            const maxBytes = Number(scoped.maxFileBytes ?? scoped.maxBytes ?? scoped.fileMaxBytes ?? limits.maxFileBytes ?? limits.maxBytes ?? limits.fileMaxBytes ?? 0);
            if (maxBytes > 0 && selected.size > maxBytes) throw new Error(`文件超过服务器上限（${Math.floor(maxBytes / 1024 / 1024)} MB）`);
            entry.state = 'uploading';
            task = client.upload(selected, { scope: 'chat', session: session.key, name: selected.name }, fraction => { if (this.profiles.isCurrent(snapshot)) { progress.value = fraction; state.textContent = `上传 ${Math.round(fraction * 100)}%`; } });
            entry.task = task; this.uploadTasks.add(task);
            const upload = await task.promise;
            if (!this.profiles.isCurrent(snapshot) || this.revision !== revision) return;
            entry.upload = upload; entry.state = 'ready';
            progress.remove(); state.textContent = `已上传 · ${Math.ceil(upload.size / 1024)} KB`;
            cancel.textContent = '移除';
          } catch (error) {
            entry.state = obj(error).kind === 'aborted' ? 'cancelled' : 'failed';
            state.textContent = errorMessage(error); progress.remove(); cancel.textContent = '移除'; retry.hidden = false;
            if (this.profiles.isCurrent(snapshot) && entry.state !== 'cancelled') this.handleError(error);
          } finally {
            entry.task = undefined;
            if (task) this.uploadTasks.delete(task);
            if (this.profiles.isCurrent(snapshot)) updateSend();
          }
        };
        void attempt();
      }
    });
    composer.addEventListener('submit', event => {
      event.preventDefault();
      if (this.chatSending || uploadBlocked()) return;
      if (this.pending.list(profile.id).some(item => item.operation === 'chat.send' && item.target === session.key && ['prepared', 'sending', 'unknown'].includes(item.status))) {
        this.showNotice('此会话有尚未确认的发送请求。请先查询原请求结果，避免重复发送。', 'error'); return;
      }
      const message = textarea.value;
      const ids = attachments.flatMap(item => item.upload ? [item.upload.id] : []);
      if (!message.trim() && !ids.length) return;
      if (attachments.some(item => item.upload?.expiresAt != null && item.upload.expiresAt <= Date.now())) { this.showNotice('附件已过期，请移除后重新上传。', 'error'); return; }
      const shouldDeliver = deliver.checked;
      if (shouldDeliver && !window.confirm(`将消息和附件投递到 QQ 会话“${session.displayName || session.key}”？请确认目标及内容。`)) return;
      this.chatSending = true; send.disabled = true; file.disabled = true; deliver.disabled = true;
      for (const control of tray.querySelectorAll('button')) control.disabled = true;
      void this.runAction(async () => {
        const fingerprint = await this.fingerprint({ key: session.key, message, deliver: shouldDeliver, attachments: ids });
        const draftFingerprint = await this.fingerprint(message);
        if (!this.profiles.isCurrent(snapshot)) return;
        const pending = this.pending.create(profile.id, 'chat.send', { target: session.key, fingerprint });
        const body: SendRequest = { key: session.key, message, deliver: shouldDeliver, attachments: ids, requestId: pending.requestId };
        localStorage.setItem(this.submissionKey(profile.id, session.key), JSON.stringify({ requestId: pending.requestId, draftFingerprint }));
        this.submissions.set(pending.requestId, { kind: 'chat', body });
        this.submittedAttachments.set(pending.requestId, () => {
          for (let index = attachments.length - 1; index >= 0; index -= 1) {
            const item = attachments[index]!;
            if (item.upload && ids.includes(item.upload.id)) { item.row.remove(); attachments.splice(index, 1); }
          }
        });
        this.pending.update(profile.id, pending.requestId, { status: 'sending' }); paintPending();
        let serverAccepted = false;
        try {
          const result = await client.send(body);
          serverAccepted = true;
          if (!this.pending.get(profile.id, pending.requestId)) return;
          await this.clearConfirmedDraft(profile.id, session.key, pending.requestId);
          this.pending.update(profile.id, pending.requestId, { status: 'accepted', ...(typeof result.runId === 'string' ? { runId: result.runId } : {}) });
          if (!this.profiles.isCurrent(snapshot) || !this.hasCredentials) return;
          this.auth.recordSuccess();
          this.submittedAttachments.get(pending.requestId)?.(); this.submittedAttachments.delete(pending.requestId);
          this.showNotice('服务器已接收。远程回复及 QQ 投递结果请查看后续会话状态。', 'success');
          await refresh();
        } catch (error) {
          if (this.pending.get(profile.id, pending.requestId)) this.pending.update(profile.id, pending.requestId, { status: serverAccepted || this.isUncertain(error) ? 'unknown' : 'failed', error: errorMessage(error) });
          if (this.profiles.isCurrent(snapshot)) this.handleError(error);
        } finally { if (this.profiles.isCurrent(snapshot)) paintPending(); }
      }).finally(() => { if (this.profiles.isCurrent(snapshot)) { this.chatSending = false; send.disabled = uploadBlocked(); file.disabled = false; deliver.disabled = false; for (const control of tray.querySelectorAll('button')) control.disabled = false; } });
    });
    append(this.content, pendingHost, more, windowHint, historyHost, composer);
    paintPending();
    this.refreshCurrent = refresh;
    void this.runAction(refresh);
    if (this.capabilities?.modules.uploads !== false) void client.uploadLimits().then(limits => { if (this.guarded(snapshot, revision, limits)) uploadHint.textContent = `服务器上传限制：${this.describeLimits(limits)}`; }).catch(() => undefined);
  }

  private messageView(message: ChatMessage, client: ConsoleClient, snapshot: ConnectionSnapshot): HTMLElement {
    const role = text(message.role, '消息');
    const node = el('article', `message ${role === 'user' ? 'user' : ''}`);
    node.append(el('div', 'message-role', role === 'assistant' ? '助手' : role === 'user' ? '用户' : role));
    const content = message.content;
    let plain = '';
    if (typeof content === 'string') plain = content;
    else if (Array.isArray(content)) {
      for (const part of content) {
        const block = obj(part);
        if (typeof part === 'string') plain += `${part}\n`;
        else if (typeof block.text === 'string') plain += `${block.text}\n`;
        else if (Object.keys(block).length) node.append(el('details', 'tool-details', el('summary', '', text(block.type, '工具 / 内容块')), el('pre', '', JSON.stringify(block, null, 2))));
      }
    } else if (content != null) plain = JSON.stringify(content, null, 2);
    if (plain) node.append(el('div', 'message-content', plain));
    for (const tool of array(message.tools)) node.append(el('details', 'tool-details', el('summary', '', `工具调用 · ${text(obj(tool).name ?? obj(tool).tool, '详情')}`), el('pre', '', JSON.stringify(tool, null, 2))));
    if (message.delivery || message.deliveryStatus || message.deliver != null) node.append(el('div', 'message-meta', `投递：${text(message.deliveryStatus ?? obj(message.delivery).status ?? message.deliver, '未知')}`));
    if (message.timestamp || message.ts || message.createdAt) node.append(el('div', 'message-meta', formatTime(message.timestamp ?? message.ts ?? message.createdAt)));
    const media = this.mediaReferences(plain);
    for (const reference of media) {
      const mediaHost = el('div');
      const name = reference.split('/').pop()?.split('?')[0] || '附件';
      const actions = el('div', 'media-actions');
      const preview = button('加载附件预览', async () => {
        await this.runAction(async () => {
          const blob = await client.media(reference.startsWith('https:') ? { url: reference } : { path: reference });
          if (!this.profiles.isCurrent(snapshot) || !node.isConnected) return;
          const url = URL.createObjectURL(blob); this.objectUrls.add(url);
          if (blob.type.startsWith('image/')) { const image = el('img', 'attachment-preview'); image.src = url; image.alt = name; mediaHost.replaceChildren(image); }
          else if (blob.type.startsWith('audio/')) { const audio = el('audio', 'attachment-preview'); audio.controls = true; audio.src = url; mediaHost.replaceChildren(audio); }
          else mediaHost.replaceChildren(el('p', 'hint', `已读取 ${Math.ceil(blob.size / 1024)} KB，可保存或分享。`));
        }, preview);
      }, 'button small');
      const save = button('保存 / 分享', async () => {
        await this.runAction(async () => {
          const blob = await client.media(reference.startsWith('https:') ? { url: reference } : { path: reference });
          if (!this.profiles.isCurrent(snapshot)) return;
          await saveAndShare(blob, name, () => this.profiles.isCurrent(snapshot) && this.hasCredentials && node.isConnected);
        }, save);
      }, 'button small');
      append(actions, preview, save); node.append(el('p', 'hint', name), actions, mediaHost);
    }
    for (const attachment of array(message.attachments)) {
      const item = obj(attachment);
      if (typeof item.id !== 'string') continue;
      const save = button(`保存附件 · ${text(item.name, item.id)}`, async () => {
        await this.runAction(async () => { const blob = await client.downloadUpload(item.id as string); if (this.profiles.isCurrent(snapshot)) await saveAndShare(blob, text(item.name, '附件'), () => this.profiles.isCurrent(snapshot) && this.hasCredentials && node.isConnected); }, save);
      }, 'button small');
      node.append(el('div', 'media-actions', save));
    }
    return node;
  }

  private mediaReferences(content: string): string[] {
    const local = content.match(/\/home\/ubuntu\/\.openclaw\/media\/[^\s"'\\)\]]+/g) ?? [];
    const remote = content.match(/https:\/\/qqbot\.ugcimg\.cn\/[^\s"'\\)\]]+/g) ?? [];
    return [...new Set([...local, ...remote])].slice(0, 12);
  }

  private renderPending(host: HTMLElement, target?: string): void {
    const profile = this.profiles.active(); if (!profile) return;
    const pending = this.pending.list(profile.id).filter(item => item.status !== 'accepted' && (!target || item.target === target));
    host.replaceChildren();
    if (!pending.length) return;
    const section = card('请求状态', el('p', 'hint', '网络恢复和重新进入页面只查询已有请求，不会自动重发消息或启动任务。'));
    for (const item of pending) {
      const row = el('div', 'pending-row', el('strong', '', pendingNames[item.status]), el('div', 'pending-id', item.requestId), item.error ? el('p', 'hint', item.error) : null);
      const actions = el('div', 'actions');
      const query = button('查询结果', async () => { await this.runAction(async () => { await this.queryPending(item); if (this.profiles.active()?.id === profile.id) this.renderPending(host, target); }, query); }, 'button small');
      actions.append(query);
      if (this.submissions.has(item.requestId)) actions.append(button('以原请求编号重试', async () => {
        if (!window.confirm('先查询服务器记录，再使用原请求编号和原内容获取结果；不会创建新的请求编号。继续？')) return;
        await this.runAction(async () => {
          const status = await this.queryPending(item);
          if (status === 'pending' || status === 'unknown') { this.showNotice('服务器仍未确认原请求结果，已保留追踪；请稍后再次查询。'); return; }
          const submission = this.submissions.get(item.requestId);
          if (!submission || submission.kind !== 'chat' || status === 'completed') return;
          const client = this.client!;
          this.pending.update(profile.id, item.requestId, { status: 'sending' });
          try { const result = await client.send(submission.body); this.pending.update(profile.id, item.requestId, { status: 'accepted', ...(typeof result.runId === 'string' ? { runId: result.runId } : {}) }); }
          catch (error) { this.pending.update(profile.id, item.requestId, { status: this.isUncertain(error) ? 'unknown' : 'failed', error: errorMessage(error) }); throw error; }
          finally { if (this.profiles.active()?.id === profile.id) this.renderPending(host, target); }
        });
      }, 'button small'));
      if (item.status === 'failed') actions.append(button('移除本机追踪', () => { if (window.confirm('仅移除本机追踪记录，远程运行不会停止。确定？')) { this.pending.remove(profile.id, item.requestId); this.submissions.delete(item.requestId); this.renderPending(host, target); } }, 'button small link'));
      row.append(actions); section.append(row);
    }
    host.append(section);
  }

  private async queryPending(item: PendingRequest, silent = false): Promise<string> {
    const profile = this.profiles.active(), client = this.client;
    if (!profile || !client || item.connectionId !== profile.id) throw new Error('请先连接原请求所属服务器');
    const snapshot = this.profiles.snapshot();
    const result = await client.requestStatus(item.requestId);
    if (!this.profiles.isCurrent(snapshot) || !this.hasCredentials || !this.pending.get(profile.id, item.requestId)) return result.state;
    if (result.state === 'completed' && item.operation === 'chat.send') {
      await this.clearConfirmedDraft(profile.id, item.target, item.requestId);
      this.submittedAttachments.get(item.requestId)?.(); this.submittedAttachments.delete(item.requestId);
      if (!this.profiles.isCurrent(snapshot)) return result.state;
    }
    const state = result.state === 'completed' ? 'accepted' : result.state === 'failed' ? 'failed' : 'unknown';
    this.pending.update(profile.id, item.requestId, { status: state, ...(typeof obj(result.result).runId === 'string' ? { runId: obj(result.result).runId as string } : {}), ...(result.error ? { error: result.error } : {}) });
    if (!silent) this.showNotice(result.state === 'completed' ? '服务器已保存原提交结果。远程运行是否结束请查看会话状态。' : result.state === 'failed' ? `原请求失败：${result.error || '请查看服务器记录'}` : '原请求结果尚未确认，请继续查询；不会自动重新执行。', result.state === 'failed' ? 'error' : '');
    return result.state;
  }

  private renderManagement(): void {
    this.pageTitle('管理');
    const client = this.client!, snapshot = this.profiles.snapshot(), revision = this.revision;
    const modules = this.capabilities?.modules;
    const pending = el('div'); this.renderPending(pending); this.content.append(pending);
    const modelsHost = el('div', 'data-list');
    const loadModels = async () => {
      const data = this.guarded(snapshot, revision, await client.models()); if (!data) return;
      modelsHost.replaceChildren();
      for (const model of array(data.models)) {
        const m = obj(model);
        modelsHost.append(el('div', 'data-row', el('div', 'grow', el('span', 'row-title', text(m.name ?? m.id)), el('span', 'row-meta', `${text(m.provider)} · ${m.availability === 'unknown' ? '可用性未知' : m.available === false ? '暂不可用' : '可选择'}`))));
      }
      if (!modelsHost.childElementCount) modelsHost.append(el('p', 'hint', '服务器未返回模型列表。'));
    };
    this.content.append(card('模型', button('读取模型', () => this.runAction(loadModels), 'button small'), modelsHost));
    const logsHost = el('pre', 'cli-output'); logsHost.textContent = '点击读取服务器已有日志。';
    const level = el('select', 'input'); for (const value of ['INFO', 'WARN', 'ERROR', 'DEBUG']) { const option = el('option', '', value); option.value = value; level.append(option); }
    const readLogs = button('读取最近日志', async () => {
      await this.runAction(async () => {
        const data = this.guarded(snapshot, revision, await client.logs(100, level.value)); if (!data) return;
        logsHost.textContent = array(data.lines ?? data.logs).map(line => typeof line === 'string' ? line : JSON.stringify(line)).join('\n') || JSON.stringify(data, null, 2);
      }, readLogs);
    }, 'button small');
    this.content.append(card('基础日志', field('最低日志级别', level), readLogs, logsHost));
    if (!modules?.cli || !this.capabilities?.permissions.cli) {
      this.content.append(card('远程 CLI', el('p', 'hint', !modules?.cli ? '服务器未提供 CLI 能力。' : '当前设备未获 CLI 授权。入口仅在服务端明确授权后开放。')));
    } else {
      const sessionsHost = el('div');
      const load = async () => {
        const data = this.guarded(snapshot, revision, await client.cliSessions()); if (!data) return;
        sessionsHost.replaceChildren();
        for (const value of data) {
          const session = obj(value); if (typeof session.id !== 'string') continue;
          const open = button('', () => { this.cliSessionId = session.id as string; this.render(); }, 'session-open');
          append(open, el('span', 'row-title', text(session.title, session.id)), el('span', 'row-meta', `${text(session.tool)} · ${session.running ? '运行中' : '空闲'}`));
          sessionsHost.append(el('div', 'data-row', open));
        }
        if (!sessionsHost.childElementCount) sessionsHost.append(el('p', 'hint', '尚无 CLI 会话。'));
      };
      const tool = el('select', 'input'); tool.disabled = true;
      const loadingTool = el('option', '', '正在查询可用工具…'); tool.append(loadingTool);
      const title = input('text', '会话名称'); title.maxLength = 80;
      const create = button('新建 CLI 会话', async () => {
        if (!window.confirm('CLI 可在服务器执行高权限操作。确认创建新的远程 CLI 会话？')) return;
        await this.runAction(async () => { const result = await client.cliCreate(tool.value, title.value || undefined); if (!this.profiles.isCurrent(snapshot)) return; const session = obj(result.session ?? result); if (typeof session.id === 'string') { this.cliSessionId = session.id; this.render(); } else await load(); }, create);
      }, 'button small');
      create.disabled = true;
      void client.cliTools().then(tools => {
        if (!this.guarded(snapshot, revision, tools)) return;
        tool.replaceChildren();
        for (const value of tools) {
          const available = value.available === true && value.authed === true;
          const option = el('option', '', `${text(value.name, text(value.id))}${available ? '' : '（不可用）'}`);
          option.value = text(value.id, ''); option.disabled = !available; tool.append(option);
        }
        const usable = [...tool.options].find(option => !option.disabled && option.value);
        if (usable) { tool.value = usable.value; tool.disabled = false; create.disabled = false; }
        else { const option = el('option', '', '服务器暂无可用 CLI 工具'); tool.prepend(option); tool.value = option.value; }
      }).catch(error => { if (this.guarded(snapshot, revision, error)) this.handleError(error); });
      this.content.append(card('远程 CLI', button('刷新会话', () => this.runAction(load), 'button small'), sessionsHost, field('工具', tool), field('新会话名称', title), create));
      void this.runAction(load);
    }
    this.content.append(card('后续管理模块', el('p', 'hint', '审批、定时任务、记忆和文件编辑将在独立工作包中交付。当前页面不会将已有网页入口视为服务端能力已开放。')));
  }

  private renderCli(id: string): void {
    const client = this.client!, snapshot = this.profiles.snapshot(), revision = this.revision, profile = snapshot.profile!;
    const title = el('h1', 'chat-title', '远程 CLI');
    this.content.append(el('div', 'page-heading', button('‹ 管理', () => { this.cancelObservation(); this.cliSessionId = null; this.render(); }, 'button small'), title));
    const status = el('p', 'hint', '正在查询运行状态…');
    const output = el('pre', 'cli-output'); output.setAttribute('aria-label', 'CLI 输出');
    const prompt = el('textarea', 'input'); prompt.placeholder = '输入要在远程服务器执行的指令…'; prompt.setAttribute('aria-label', 'CLI 指令'); prompt.value = this.getDraft(profile.id, `cli:${id}`);
    prompt.addEventListener('input', () => this.setDraft(profile.id, `cli:${id}`, prompt.value));
    const pending = el('div');
    const run = button('启动远程运行', async () => {
      if (this.cliRunning || !prompt.value.trim()) return;
      if (this.pending.list(profile.id).some(item => item.operation === 'cli.run' && item.target === id && ['prepared', 'sending', 'unknown'].includes(item.status))) {
        this.showNotice('此 CLI 会话有尚未确认的启动请求。请先查询原请求结果。', 'error'); return;
      }
      if (!window.confirm('将在远程服务器启动 CLI 执行。请确认目标服务器、会话和指令内容。')) return;
      this.cliRunning = true; run.disabled = true;
      const controller = new AbortController(); this.aborts.add(controller);
      await this.runAction(async () => {
        const originalPrompt = prompt.value;
        const fingerprint = await this.fingerprint({ sessionId: id, prompt: originalPrompt });
        if (!this.profiles.isCurrent(snapshot)) return;
        const record = this.pending.create(profile.id, 'cli.run', { target: id, fingerprint });
        this.submissions.set(record.requestId, { kind: 'cli', sessionId: id, prompt: originalPrompt, requestId: record.requestId });
        this.pending.update(profile.id, record.requestId, { status: 'sending' }); this.renderPending(pending, id);
        let terminal = false;
        try {
          await client.cliRun(id, { prompt: originalPrompt, requestId: record.requestId }, (event: SseEvent) => {
            if (!this.profiles.isCurrent(snapshot)) return;
            const data = obj(event.data);
            if (event.event === 'start' || event.event === 'receipt') {
              if (event.event === 'receipt') terminal = true;
              this.pending.update(profile.id, record.requestId, { status: 'accepted', ...(typeof data.runId === 'string' ? { runId: data.runId } : {}) });
              status.textContent = `远程运行中 · ${text(data.runId)}`;
              if (prompt.value === originalPrompt) { prompt.value = ''; this.setDraft(profile.id, `cli:${id}`, ''); }
            } else if (event.event === 'delta') output.textContent += typeof event.data === 'string' ? event.data : text(data.text ?? data.delta, '');
            else if (event.event === 'done') { terminal = true; status.textContent = `运行结束 · exit ${text(data.exitCode)} · ${text(data.reason, '')}`; }
            else if (event.event === 'error') output.textContent += `\n[错误] ${typeof event.data === 'string' ? event.data : JSON.stringify(event.data)}\n`;
            else if (event.event === 'tool') output.textContent += `\n[工具] ${JSON.stringify(event.data)}\n`;
            this.renderPending(pending, id);
          }, controller.signal);
          if (!terminal) { this.pending.update(profile.id, record.requestId, { status: 'unknown', error: '输出连接结束，尚未确认远程终态' }); if (this.profiles.isCurrent(snapshot)) this.showNotice('输出连接已结束，请查询远程运行状态。任务不会因断流而自动取消。'); }
        } catch (error) {
          this.pending.update(profile.id, record.requestId, { status: this.isUncertain(error) || controller.signal.aborted ? 'unknown' : 'failed', error: errorMessage(error) });
          if (this.profiles.isCurrent(snapshot)) this.handleError(error);
        } finally { if (this.profiles.isCurrent(snapshot)) this.renderPending(pending, id); }
      });
      this.aborts.delete(controller);
      if (this.profiles.isCurrent(snapshot)) { this.cliRunning = false; run.disabled = false; await this.runAction(refresh); }
    }, 'button primary');
    const cancel = button('取消远程任务', async () => {
      if (!window.confirm('确认向服务器发送取消任务请求？仅关闭输出连接不会取消任务。')) return;
      await this.runAction(async () => { await client.cliCancel(id); if (this.profiles.isCurrent(snapshot)) { this.showNotice('取消请求已提交，请查询终态。'); await refresh(); } }, cancel);
    }, 'button danger');
    const disconnect = button('断开输出观察', () => { this.cancelObservation(); this.showNotice('已断开本机输出观察，远程任务可能仍在运行，请查询状态。'); });
    const refresh = async () => {
      const data = this.guarded(snapshot, revision, await client.cliGet(id)); if (!data) return;
      title.textContent = data.session.title || '远程 CLI';
      const current = data.session.activeRun ?? data.session.lastRun;
      status.textContent = current ? `状态：${current.state} · runId ${current.runId}${current.exitCode != null ? ` · exit ${current.exitCode}` : ''}` : `状态：${data.session.running ? '运行中' : '当前无运行任务'}`;
      if (!this.cliRunning) output.textContent = data.messages.map(message => typeof message.content === 'string' ? message.content : text(message.text, JSON.stringify(message))).join('\n\n');
      run.disabled = this.cliRunning || data.session.running;
      this.renderPending(pending, id);
    };
    append(this.content, status, pending, output, card('执行指令', prompt, el('div', 'actions', run, cancel, disconnect)), button('查询远程状态', () => this.runAction(refresh), 'button'));
    this.refreshCurrent = refresh;
    void this.runAction(refresh);
  }

  private isUncertain(error: unknown): boolean {
    const value = obj(error);
    return value.outcomeUnknown === true || value.status === 0 || value.kind === 'network' || value.kind === 'timeout' || value.kind === 'aborted' || Number(value.status) >= 500;
  }

  private describeLimits(value: unknown): string {
    const limits = obj(value), chat = obj(limits.chat);
    const parts: string[] = [];
    for (const [label, raw] of [['单文件', chat.maxFileBytes ?? chat.maxBytes ?? limits.maxFileBytes ?? limits.maxBytes], ['总量', chat.maxTotalBytes ?? limits.maxTotalBytes]] as [string, unknown][]) {
      if (typeof raw === 'number') parts.push(`${label} ${Math.round(raw / 1024 / 1024)} MB`);
    }
    if (typeof chat.maxFiles === 'number') parts.push(`最多 ${chat.maxFiles} 个`);
    return parts.join(' · ') || '已读取；服务器将校验大小、数量和有效期';
  }

  private async fingerprint(value: unknown): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
    return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  }

  private submissionKey(connectionId: string, sessionKey: string): string { return `hosino.submitted-draft.${connectionId}.${encodeURIComponent(sessionKey)}`; }

  private async clearConfirmedDraft(connectionId: string, target: string, requestId: string): Promise<void> {
    const markerKey = this.submissionKey(connectionId, target);
    const raw = localStorage.getItem(markerKey);
    if (!raw) {
      // A body absent from memory after a process rebuild cannot safely become a new send.
      if (!this.submissions.has(requestId) && this.getDraft(connectionId, target)) throw new Error('原请求已接收，但本机缺少草稿关联记录。请先清空草稿后再次查询，避免重复发送。');
      return;
    }
    if (!this.getDraft(connectionId, target)) { localStorage.removeItem(markerKey); return; }
    let marker: Record<string, unknown>;
    try { marker = obj(JSON.parse(raw)); } catch { throw new Error('原请求的草稿关联记录损坏，请清空草稿后再次查询。'); }
    if (marker.requestId !== requestId || typeof marker.draftFingerprint !== 'string') throw new Error('原请求与当前草稿关联不一致，请先查询并确认原请求。');
    const original = this.getDraft(connectionId, target);
    const fingerprint = await this.fingerprint(original);
    if (fingerprint === marker.draftFingerprint && this.getDraft(connectionId, target) === original) {
      this.setDraft(connectionId, target, '');
      const view = this.draftViews.get(this.draftKey(connectionId, target));
      if (view?.isConnected && view.value === original) view.value = '';
    }
    localStorage.removeItem(markerKey);
  }

  private draftKey(connectionId: string, sessionKey: string): string { return `hosino.draft.${connectionId}.${encodeURIComponent(sessionKey)}`; }
  private getDraft(connectionId: string, sessionKey: string): string { return localStorage.getItem(this.draftKey(connectionId, sessionKey)) || ''; }
  private setDraft(connectionId: string, sessionKey: string, value: string): void {
    const key = this.draftKey(connectionId, sessionKey);
    try { value ? localStorage.setItem(key, value) : localStorage.removeItem(key); } catch { this.showNotice('本机存储空间不足，草稿无法保存。', 'error'); }
  }
  private clearDrafts(connectionId: string): void {
    const prefix = `hosino.draft.${connectionId}.`, submissionPrefix = `hosino.submitted-draft.${connectionId}.`;
    for (const key of Object.keys(localStorage)) if (key.startsWith(prefix) || key.startsWith(submissionPrefix)) localStorage.removeItem(key);
  }

  private cancelObservation(): void { for (const controller of this.aborts) controller.abort(); this.aborts.clear(); }
  private cancelLocalTransfers(): void {
    this.cancelObservation();
    for (const task of this.uploadTasks) task.abort(); this.uploadTasks.clear();
    for (const url of this.objectUrls) URL.revokeObjectURL(url); this.objectUrls.clear();
  }
}

export async function startApp(root: HTMLElement): Promise<ClientApp> {
  const app = new ClientApp(root);
  await app.start();
  return app;
}
