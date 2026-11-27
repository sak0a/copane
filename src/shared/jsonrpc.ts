// Minimal symmetric JSON-RPC 2.0 peer over a byte stream, framed as one JSON object per line.
// Used on both ends of the socket between the MCP server and the bridge.
import { StringDecoder } from 'node:string_decoder';
import { ErrorCodes, Methods } from './protocol';

export interface RpcStream {
  write(data: string): unknown;
  on(event: 'data', listener: (chunk: Buffer | string) => void): unknown;
  on(event: 'close', listener: () => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
  destroy(): unknown;
}

export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'RpcError';
  }
}

export interface RequestOptions {
  signal?: AbortSignal;
  /** Rejects with a timeout error after this many milliseconds. No timeout when omitted. */
  timeoutMs?: number;
}

export interface HandlerContext {
  /** Aborted when the other side cancels the request or the connection closes. */
  signal: AbortSignal;
}

type RequestHandler = (params: any, ctx: HandlerContext) => unknown;
type NotificationHandler = (params: any) => void;

interface Pending {
  resolve(value: unknown): void;
  reject(err: Error): void;
  cleanup(): void;
}

export class RpcPeer {
  private nextId = 1;
  /**
   * Decodes the stream's bytes: a socket delivers a long message in chunks (8 kB on macOS), and a
   * character of several bytes cut by a chunk boundary must wait for its other bytes.
   */
  private readonly decoder = new StringDecoder('utf8');
  /** The pieces received so far of the line whose newline has not arrived yet. */
  private partial: string[] = [];
  private closed = false;
  private readonly pending = new Map<number, Pending>();
  private readonly running = new Map<number | string, AbortController>();
  private readonly requestHandlers = new Map<string, RequestHandler>();
  private readonly notificationHandlers = new Map<string, NotificationHandler>();
  private readonly closeListeners: Array<() => void> = [];

  constructor(private readonly stream: RpcStream) {
    stream.on('data', chunk => this.onData(typeof chunk === 'string' ? chunk : this.decoder.write(chunk)));
    stream.on('close', () => this.handleClose());
    stream.on('error', () => this.handleClose());
    this.notificationHandlers.set(Methods.cancel, (p: { id?: number | string }) => {
      if (p && p.id !== undefined) this.running.get(p.id)?.abort();
    });
  }

  get isClosed(): boolean {
    return this.closed;
  }

  onRequest(method: string, handler: RequestHandler): void {
    this.requestHandlers.set(method, handler);
  }

  onNotification(method: string, handler: NotificationHandler): void {
    this.notificationHandlers.set(method, handler);
  }

  onClose(listener: () => void): void {
    if (this.closed) listener();
    else this.closeListeners.push(listener);
  }

  request<T = unknown>(method: string, params?: unknown, options: RequestOptions = {}): Promise<T> {
    if (this.closed) return Promise.reject(new RpcError(ErrorCodes.notReady, 'connection closed'));
    if (options.signal?.aborted) return Promise.reject(new RpcError(ErrorCodes.cancelled, 'cancelled'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      const onAbort = () => {
        this.notify(Methods.cancel, { id });
        settle(() => reject(new RpcError(ErrorCodes.cancelled, 'cancelled')));
      };
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
      };
      const settle = (fn: () => void) => {
        if (!this.pending.delete(id)) return;
        cleanup();
        fn();
      };
      this.pending.set(id, {
        resolve: v => settle(() => resolve(v as T)),
        reject: e => settle(() => reject(e)),
        cleanup,
      });
      options.signal?.addEventListener('abort', onAbort, { once: true });
      if (options.timeoutMs !== undefined) {
        timer = setTimeout(() => {
          this.notify(Methods.cancel, { id });
          settle(() => reject(new RpcError(ErrorCodes.internal, `request "${method}" timed out after ${options.timeoutMs} ms`)));
        }, options.timeoutMs);
      }
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    if (!this.closed) this.send({ jsonrpc: '2.0', method, params });
  }

  close(): void {
    this.stream.destroy();
    this.handleClose();
  }

  private send(message: unknown): void {
    try {
      this.stream.write(JSON.stringify(message) + '\n');
    } catch {
      this.handleClose();
    }
  }

  private onData(text: string): void {
    // Only the new text is searched and the pieces of a line are joined once, so a long message
    // (a screenshot) costs time in proportion to its size, however many chunks it arrives in.
    let start = 0;
    let newline: number;
    while ((newline = text.indexOf('\n', start)) >= 0) {
      const end = text.slice(start, newline);
      const line = (this.partial.length ? this.partial.join('') + end : end).trim();
      this.partial = [];
      start = newline + 1;
      if (!line) continue;
      let message: any;
      try {
        message = JSON.parse(line);
      } catch {
        continue; // Not ours to interpret; ignore malformed lines rather than tearing down the session.
      }
      this.dispatch(message);
    }
    if (start < text.length) this.partial.push(start ? text.slice(start) : text);
  }

  private dispatch(message: any): void {
    if (!message || typeof message !== 'object') return;
    if (typeof message.method === 'string') {
      if (message.id === undefined || message.id === null) {
        try {
          this.notificationHandlers.get(message.method)?.(message.params);
        } catch {
          // A failing notification handler has nobody to report to.
        }
        return;
      }
      void this.runRequest(message.id, message.method, message.params);
      return;
    }
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      if (message.error) {
        pending.reject(new RpcError(message.error.code ?? ErrorCodes.internal, message.error.message ?? 'error', message.error.data));
      } else {
        pending.resolve(message.result);
      }
    }
  }

  private async runRequest(id: number | string, method: string, params: unknown): Promise<void> {
    const handler = this.requestHandlers.get(method);
    if (!handler) {
      this.send({ jsonrpc: '2.0', id, error: { code: ErrorCodes.methodNotFound, message: `unknown method "${method}"` } });
      return;
    }
    const controller = new AbortController();
    this.running.set(id, controller);
    try {
      const result = await handler(params, { signal: controller.signal });
      this.send({ jsonrpc: '2.0', id, result: result ?? null });
    } catch (err) {
      const e = err instanceof RpcError ? err : new RpcError(ErrorCodes.internal, err instanceof Error ? err.message : String(err));
      this.send({ jsonrpc: '2.0', id, error: { code: e.code, message: e.message, data: e.data } });
    } finally {
      this.running.delete(id);
    }
  }

  private handleClose(): void {
    if (this.closed) return;
    this.closed = true;
    for (const controller of this.running.values()) controller.abort();
    this.running.clear();
    for (const pending of [...this.pending.values()]) pending.reject(new RpcError(ErrorCodes.notReady, 'connection closed'));
    this.pending.clear();
    for (const listener of this.closeListeners.splice(0)) {
      try {
        listener();
      } catch {
        // Listener errors must not stop the remaining listeners.
      }
    }
  }
}
