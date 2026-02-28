import { withTraceID, generateTraceID, _log } from './index.js';

type Context = { req: { method: string; path: string; header(name: string): string | undefined }; res: { status: number }; header(name: string, value: string): void };
type Next = () => Promise<void>;

interface Logger {
  info(msg: string, ...args: unknown[]): void;
  info(obj: object, msg?: string): void;
}

interface MiddlewareOptions {
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
 * Hono middleware that logs requests with trace_id propagation.
 * All LogNorth.log/error calls within the request automatically inherit the trace_id.
 *
 * @example
 * // Basic usage
 * app.use(middleware())
 *
 * // With ignored paths
 * app.use(middleware({ ignorePaths: ['/healthz', '/_health'] }))
 */
export function middleware(options?: MiddlewareOptions | Logger) {
  // Support old signature: middleware(logger)
  const opts: MiddlewareOptions = options && 'info' in options
    ? { logger: options as Logger }
    : (options as MiddlewareOptions) || {};

  return async (c: Context, next: Next) => {
    // Skip ignored paths
    if (isIgnoredPath(c.req.path, opts.ignorePaths)) {
      return next();
    }

    const startTime = new Date();
    const start = startTime.getTime();
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

    if (opts.logger) {
      opts.logger.info({ ...context, duration_ms, trace_id: traceID }, msg);
    } else {
      _log(msg, context, traceID, duration_ms, startTime);
    }
  };
}
