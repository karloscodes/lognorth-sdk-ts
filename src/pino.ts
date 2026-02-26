import { _log, _error, getTraceID } from './index.js';
import { Transform } from 'stream';

/**
 * Pino transport that sends logs to LogNorth.
 * Use alongside pino-pretty or other transports for local output.
 */
export function transport(): Transform {
  return new Transform({
    objectMode: true,
    transform(chunk, _encoding, callback) {
      try {
        const log = typeof chunk === 'string' ? JSON.parse(chunk) : chunk;
        const { level, msg, time, err, error, ...context } = log;
        const traceID = getTraceID() || '';
        const timestamp = time ? new Date(time) : undefined;

        // Pino levels: 10=trace, 20=debug, 30=info, 40=warn, 50=error, 60=fatal
        if (level >= 50) {
          const e = err || error || new Error(msg);
          _error(msg || 'Error', e instanceof Error ? e : new Error(String(e)), context, traceID, undefined, timestamp);
        } else {
          _log(msg || '', context, traceID, undefined, timestamp);
        }
      } catch {
        // Don't break the stream
      }
      callback(null, chunk);
    },
  });
}
