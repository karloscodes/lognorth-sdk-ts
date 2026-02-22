import { withTraceID, generateTraceID, _log } from './index.js';

type Context = { req: { method: string; path: string; header(name: string): string | undefined }; res: { status: number }; header(name: string, value: string): void };
type Next = () => Promise<void>;

interface Logger {
  info(msg: string, ...args: unknown[]): void;
  info(obj: object, msg?: string): void;
}

/**
 * Hono middleware that logs requests with trace_id propagation.
 * All LogNorth.log/error calls within the request automatically inherit the trace_id.
 */
export function middleware(logger?: Logger) {
  return async (c: Context, next: Next) => {
    const start = Date.now();
    const traceID = c.req.header('x-trace-id') || generateTraceID();
    c.header('X-Trace-ID', traceID);

    await withTraceID(traceID, () => next());

    const duration_ms = Date.now() - start;
    const context = {
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
    };
    const msg = `${c.req.method} ${c.req.path} → ${c.res.status}`;

    if (logger) {
      logger.info({ ...context, duration_ms, trace_id: traceID }, msg);
    } else {
      _log(msg, context, traceID, duration_ms);
    }
  };
}
