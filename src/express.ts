import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { withRequest, generateTraceID, _requestFields, _log } from './index.js';
import type { RequestState } from './index.js';

interface Logger {
  info(msg: string, ...args: unknown[]): void;
  info(obj: object, msg?: string): void;
  error(msg: string, ...args: unknown[]): void;
  error(obj: object, msg?: string): void;
}

interface MiddlewareOptions {
  /** Paths to ignore (no logging). Useful for health checks. */
  ignorePaths?: string[];
  /** Optional Pino-compatible logger */
  logger?: Logger;
}

// Inside a router, Express leaves req.path and req.route relative to it
// (/42 and /:id under /api/users) once the route answers, so put the
// router's base back in front.
function underRouter(baseUrl: string | undefined, path: string): string {
  if (!baseUrl) return path;
  return path === '/' ? baseUrl : baseUrl + path;
}

function isIgnoredPath(path: string, ignorePaths?: string[]): boolean {
  if (!ignorePaths?.length) return false;
  return ignorePaths.some(p => path === p || path.startsWith(p + '/'));
}

/**
 * Express middleware that logs requests with trace_id propagation.
 * All LogNorth.log/error calls within the request automatically inherit the trace_id.
 *
 * @example
 * // Basic usage
 * app.use(middleware())
 *
 * // With ignored paths
 * app.use(middleware({ ignorePaths: ['/healthz', '/_health'] }))
 *
 * // With Pino logger
 * app.use(middleware({ logger: pinoLogger }))
 */
export function middleware(options?: MiddlewareOptions | Logger): RequestHandler {
  // Support old signature: middleware(logger)
  const opts: MiddlewareOptions = options && 'info' in options
    ? { logger: options as Logger }
    : (options as MiddlewareOptions) || {};

  return (req: Request, res: Response, next: NextFunction) => {
    // Skip ignored paths
    if (isIgnoredPath(req.path, opts.ignorePaths)) {
      return next();
    }

    const startTime = new Date();
    const start = startTime.getTime();
    const traceID = (req.headers?.['x-trace-id'] as string) || generateTraceID();
    const state: RequestState = { traceID };
    res.setHeader?.('X-Trace-ID', traceID);

    res.on('finish', () => {
      // Don't track requests that didn't match any route (scanner noise)
      if (res.statusCode === 404 && !req.route) {
        return;
      }

      const duration_ms = Date.now() - start;
      // req.route is set by express once the matched route layer runs.
      // handler.name falls back to '' for anonymous handlers, so we skip it
      // rather than sending an empty string.
      const routePath = (req.route as { path?: unknown } | undefined)?.path;
      const handlerName = (req.route as { stack?: Array<{ handle?: { name?: string } }> } | undefined)
        ?.stack?.[0]?.handle?.name || undefined;
      const path = underRouter(req.baseUrl, req.path);
      const context: Record<string, unknown> = {
        method: req.method,
        path,
        status: res.statusCode,
      };
      if (typeof routePath === 'string') context.route = underRouter(req.baseUrl, routePath);
      if (handlerName) context.handler = handlerName;
      Object.assign(context, _requestFields(state, res.statusCode, req.headers?.['user-agent']));
      const msg = `${req.method} ${path} → ${res.statusCode}`;

      if (opts.logger) {
        opts.logger.info({ ...context, duration_ms, trace_id: traceID }, msg);
      } else {
        _log(msg, context, traceID, duration_ms, startTime);
      }
    });

    withRequest(state, () => next());
  };
}
