export type JsonObject = Record<string, unknown>;

export interface DeviceCredentials {
  device: { id: string; name: string };
  accessToken: string;
  refreshToken: string;
  /** Unix epoch milliseconds. */
  accessExpiresAt: number;
  refreshExpiresAt: number;
}

export interface Capabilities {
  apiVersion: number;
  build: string;
  auth: string[];
  modules: {
    overview: boolean;
    sessions: boolean;
    chat: boolean;
    uploads: boolean;
    cli: boolean;
    management?: boolean;
  };
  permissions: { cli: boolean };
  limits?: JsonObject;
}

export interface Session extends JsonObject {
  key: string;
  displayName?: string;
  alias?: string;
  label?: string;
  channel?: string;
  hasActiveRun?: boolean;
}

export interface SessionList extends JsonObject {
  sessions: Session[];
  totalCount?: number;
}

export interface ChatMessage extends JsonObject {
  id?: string;
  role?: string;
  content?: unknown;
  index?: number;
}

export interface ChatHistory extends JsonObject {
  messages: ChatMessage[];
  hasMore: boolean;
  nextBefore: string | null;
  gatewayHasMore?: boolean;
  windowCount?: number;
}

export interface SendRequest {
  key: string;
  message: string;
  deliver: boolean;
  attachments?: string[];
  requestId: string;
}

/** A completed submission is not the same as a completed remote execution. */
export interface RequestStatus {
  requestId: string;
  state: 'pending' | 'unknown' | 'completed' | 'failed';
  status?: number;
  result?: unknown;
  error?: string;
}

export interface Upload extends JsonObject {
  id: string;
  name: string;
  mime: string;
  kind: string;
  size: number;
  url: string;
  createdAt: number;
  attachedAt: number | null;
  expiresAt: number | null;
}

export interface UploadOptions {
  scope: 'chat' | 'cli';
  session: string;
  name: string;
}

export interface UploadTask {
  promise: Promise<Upload>;
  abort(): void;
}

export interface SseEvent {
  event: string;
  data: unknown;
  id?: string;
}

export interface CliRun extends JsonObject {
  runId: string;
  state: 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
  exitCode?: number | null;
  reason?: string;
  startedAt: number;
  finishedAt?: number;
}

export interface CliSession extends JsonObject {
  id: string;
  tool: string;
  title: string;
  running: boolean;
  activeRun?: CliRun | null;
  lastRun?: CliRun | null;
}

export interface CliSessionDetail extends JsonObject {
  session: CliSession;
  messages: JsonObject[];
}

export interface CliRunRequest {
  prompt: string;
  attachments?: string[];
  requestId: string;
}

/** Cached submission receipt returned on a duplicate CLI request, never a new run. */
export interface CliRunReceipt {
  sessionId: string;
  runId: string;
  state: string;
}

export interface DeviceSummary {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  revokedAt: number | null;
}
