import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { withTraceID, generateTraceID, _log } from './index.js';

interface Logger {
  info(msg: string, ...args: unknown[]): void;
  info(obj: object, msg?: string): void;
  error(msg: string, ...args: unknown[]): void;
  error(obj: object, msg?: string): void;
}

/**
 * Express middleware that logs requests with trace_id propagation.
 * All LogNorth.log/error calls within the request automatically inherit the trace_id.
 */
export function middleware(logger?: Logger): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const start = Date.now();
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

      if (logger) {
        logger.info({ ...context, duration_ms, trace_id: traceID }, msg);
      } else {
        _log(msg, context, traceID, duration_ms);
      }
    });

    withTraceID(traceID, () => next());
  };
}
