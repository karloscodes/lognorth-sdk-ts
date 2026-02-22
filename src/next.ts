import { withTraceID, generateTraceID, _log, _error } from './index.js';

type Handler = (req: Request) => Promise<Response> | Response;

interface Logger {
  info(msg: string, ...args: unknown[]): void;
  info(obj: object, msg?: string): void;
  error(msg: string, ...args: unknown[]): void;
  error(obj: object, msg?: string): void;
}

/**
 * Next.js wrapper that logs requests with trace_id propagation.
 * All LogNorth.log/error calls within the handler automatically inherit the trace_id.
 */
export function withLogger(logger?: Logger) {
  return (handler: Handler): Handler => {
    return async (req: Request) => {
      const start = Date.now();
      const url = new URL(req.url);
      const traceID = req.headers.get('x-trace-id') || generateTraceID();

      try {
        const res = await withTraceID(traceID, () => handler(req));
        const duration_ms = Date.now() - start;
        const context = {
          method: req.method,
          path: url.pathname,
          status: res.status,
        };
        const msg = `${req.method} ${url.pathname} → ${res.status}`;

        if (logger) {
          logger.info({ ...context, duration_ms, trace_id: traceID }, msg);
        } else {
          _log(msg, context, traceID, duration_ms);
        }

        const headers = new Headers(res.headers);
        headers.set('X-Trace-ID', traceID);
        return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
      } catch (err) {
        const duration_ms = Date.now() - start;
        const context = {
          method: req.method,
          path: url.pathname,
        };
        const msg = `${req.method} ${url.pathname} → error`;

        if (logger) {
          logger.error({ ...context, duration_ms, trace_id: traceID, err }, msg);
        } else {
          _error(msg, err as Error, context, traceID, duration_ms);
        }
        throw err;
      }
    };
  };
}
