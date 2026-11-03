import { ApiError } from './errors';
import type { SseEvent } from './types';

/** Incremental SSE parser. CRLF and UTF-8 boundaries may span network chunks. */
export class SseParser {
  private buffer = '';
  private eventName = 'message';
  private data: string[] = [];
  private id: string | undefined;
  private eventSize = 0;

  constructor(private readonly maxEventChars = 1024 * 1024) {}

  feed(chunk: string): SseEvent[] {
    this.buffer += chunk;
    const events: SseEvent[] = [];
    for (;;) {
      const index = this.buffer.search(/[\r\n]/);
      if (index < 0) break;
      // A trailing CR may be the first half of CRLF in the next chunk.
      if (this.buffer[index] === '\r' && index === this.buffer.length - 1) break;
      const line = this.buffer.slice(0, index);
      const size = this.buffer[index] === '\r' && this.buffer[index + 1] === '\n' ? 2 : 1;
      this.buffer = this.buffer.slice(index + size);
      const event = this.line(line);
      if (event) events.push(event);
    }
    if (this.buffer.length + this.eventSize > this.maxEventChars) {
      throw new ApiError('服务端事件超过客户端处理上限', { kind: 'protocol' });
    }
    return events;
  }

  finish(): SseEvent[] {
    // At EOF a final CR is a valid line terminator, not a partial CRLF.
    return this.buffer.endsWith('\r') ? this.feed('\n') : [];
  }

  private line(line: string): SseEvent | undefined {
    if (!line) {
      let event: SseEvent | undefined;
      if (this.data.length) {
        const text = this.data.join('\n');
        let data: unknown = text;
        try { data = JSON.parse(text); } catch { /* Plain SSE data is allowed. */ }
        event = { event: this.eventName, data, ...(this.id !== undefined ? { id: this.id } : {}) };
      }
      this.eventName = 'message';
      this.data = [];
      this.eventSize = 0;
      return event;
    }
    if (line.startsWith(':')) return undefined;
    this.eventSize += line.length;
    if (this.eventSize > this.maxEventChars) {
      throw new ApiError('服务端事件超过客户端处理上限', { kind: 'protocol' });
    }
    const colon = line.indexOf(':');
    const name = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (name === 'event') this.eventName = value;
    else if (name === 'data') this.data.push(value);
    else if (name === 'id' && !value.includes('\0')) this.id = value;
    return undefined;
  }
}

export async function* readEventStream(
  stream: ReadableStream<Uint8Array>, signal?: AbortSignal,
): AsyncGenerator<SseEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const parser = new SseParser();
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    for (;;) {
      if (signal?.aborted) throw signal.reason;
      const { done, value } = await reader.read();
      if (signal?.aborted) throw signal.reason;
      if (done) break;
      for (const event of parser.feed(decoder.decode(value, { stream: true }))) yield event;
    }
    for (const event of parser.feed(decoder.decode())) yield event;
    for (const event of parser.finish()) yield event;
    // An event without its final blank line is incomplete and is discarded.
  } finally {
    signal?.removeEventListener('abort', abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
