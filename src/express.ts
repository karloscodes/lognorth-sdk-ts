import type { Request, Response, NextFunction, RequestHandler } from 'express';
import type { LogFunction } from './index.js';

export function middleware(log: LogFunction): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const start = Date.now();

    try {
      res.on('finish', () => {
        try {
          const duration = Date.now() - start;
          const status = res.statusCode;

          log(`${req.method} ${req.path} → ${status}`, {
            method: req.method,
            path: req.path,
            status,
            duration_ms: duration,
            ...(status >= 500 && { error: `HTTP ${status}` }),
          });
        } catch {
          // Never break the app
        }
      });
    } catch {
      // Never break the app
    }

    next();
  };
}
