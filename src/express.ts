import type { Request, Response, NextFunction, RequestHandler } from 'express';
import LogNorth from './index.js';

export function middleware(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const start = Date.now();

    res.on('finish', () => {
      LogNorth.log(`${req.method} ${req.path} → ${res.statusCode}`, {
        method: req.method,
        path: req.path,
        status: res.statusCode,
        duration_ms: Date.now() - start,
      });
    });

    next();
  };
}
