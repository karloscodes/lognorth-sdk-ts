import { withTraceID, generateTraceID, _log, _error } from './index.js';

type Handler = (req: Request) => Promise<Response> | Response;

interface Logger {
  info(msg: string, ...args: unknown[]): void;
  info(obj: object, msg?: string): void;
  error(msg: string, ...args: unknown[]): void;
  error(obj: object, msg?: string): void;
}

interface WithLoggerOptions {
  /** Paths to ignore (no logging). Useful for health checks. */
  ignorePaths?: string[];
  /** Optional Pino-compatible logger */
  logger?: Logger;
}

function isIgnoredPath(path: string, ignorePaths?: string[]): boolean {
  if (!ignorePaths?.length) return false;
  return ignorePaths.some(p => path === p || path.startsWith(p + '/'));
}

/**
 * Next.js wrapper that logs requests with trace_id propagation.
 * All LogNorth.log/error calls within the handler automatically inherit the trace_id.
 *
 * @example
 * // Basic usage
 * export const GET = withLogger()(handler)
 *
 * // With ignored paths
 * export const GET = withLogger({ ignorePaths: ['/healthz'] })(handler)
 */
export function withLogger(options?: WithLoggerOptions | Logger) {
  // Support old signature: withLogger(logger)
  const opts: WithLoggerOptions = options && 'info' in options
    ? { logger: options as Logger }
    : (options as WithLoggerOptions) || {};

  return (handler: Handler): Handler => {
    return async (req: Request) => {
      const url = new URL(req.url);

      // Skip ignored paths
      if (isIgnoredPath(url.pathname, opts.ignorePaths)) {
        return handler(req);
      }

      const startTime = new Date();
      const start = startTime.getTime();
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

        if (opts.logger) {
          opts.logger.info({ ...context, duration_ms, trace_id: traceID }, msg);
        } else {
          _log(msg, context, traceID, duration_ms, startTime);
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

        if (opts.logger) {
          opts.logger.error({ ...context, duration_ms, trace_id: traceID, err }, msg);
        } else {
          _error(msg, err as Error, context, traceID, duration_ms, startTime);
        }
        throw err;
      }
    };
  };
}
