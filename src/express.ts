import type { Request, Response, NextFunction, RequestHandler } from 'express';
import log from './index.js';

export function middleware(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const start = Date.now();

    res.on('finish', () => {
      const status = res.statusCode;
      log(`${req.method} ${req.path} → ${status}`, {
        method: req.method,
        path: req.path,
        status,
        duration_ms: Date.now() - start,
      });
    });

    next();
  };
}
