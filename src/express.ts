import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { withTraceID, generateTraceID, _log } from './index.js';

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
    res.setHeader?.('X-Trace-ID', traceID);

    res.on('finish', () => {
      const duration_ms = Date.now() - start;
      const context = {
        method: req.method,
        path: req.path,
        status: res.statusCode,
      };
      const msg = `${req.method} ${req.path} → ${res.statusCode}`;

      if (opts.logger) {
        opts.logger.info({ ...context, duration_ms, trace_id: traceID }, msg);
      } else {
        _log(msg, context, traceID, duration_ms, startTime);
      }
    });

    withTraceID(traceID, () => next());
  };
}
