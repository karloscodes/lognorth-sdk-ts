// Local HTTP server for tests. It plays the LogNorth batch endpoint.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

type Reply = { status: number; headers?: Record<string, string>; delayMs?: number };

export type ReceivedEvent = { message: string; trace_id?: string; duration_ms?: number; context?: Record<string, unknown> };

export type Request = { at: number; bytes: number; headers: Record<string, string | string[] | undefined>; events: ReceivedEvent[]; status: number };

export class TestServer {
  url = '';
  port = 0;
  /** Every request, in arrival order, with the status the server answered. */
  requests: Request[] = [];
  /** Requests received, including ones the client gave up on. */
  attempts = 0;
  /** Scripted answers, used in order. When empty, the server answers 201. */
  replies: Reply[] = [];
  /** Optional per-request answer. Wins over `replies`. */
  answer?: (events: ReceivedEvent[]) => Reply | undefined;
  private server: Server | null = null;

  /** Events the server stored (2xx answers only), in arrival order. */
  get stored(): ReceivedEvent[] {
    return this.requests.filter(r => r.status < 300).flatMap(r => r.events);
  }

  async start(port = 0): Promise<void> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        this.attempts++;
        const body = Buffer.concat(chunks);
        const events = JSON.parse(body.toString()).events as ReceivedEvent[];
        const reply = this.answer?.(events) ?? this.replies.shift() ?? { status: 201 };
        const respond = () => {
          if (res.destroyed) return; // the client gave up (timeout)
          this.requests.push({ at: Date.now(), bytes: body.length, headers: req.headers, events, status: reply.status });
          res.writeHead(reply.status, { 'Content-Type': 'application/json', ...reply.headers });
          res.end(JSON.stringify(reply.status < 300 ? { created: events.length, errors: [] } : { error: 'test' }));
        };
        if (reply.delayMs) setTimeout(respond, reply.delayMs);
        else respond();
      });
    });
    await new Promise<void>(resolve => this.server!.listen(port, '127.0.0.1', resolve));
    this.port = (this.server.address() as AddressInfo).port;
    this.url = `http://127.0.0.1:${this.port}`;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }

  /** Resolves when `check` is true, or rejects after `timeoutMs`. */
  async waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!check()) {
      if (Date.now() > deadline) throw new Error('waitFor timed out');
      await new Promise(r => setTimeout(r, 5));
    }
  }
}
