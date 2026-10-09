# lognorth

Official SDK for [LogNorth](https://lognorth.com) - self-hosted error tracking.

## Install

```bash
npm install lognorth
```

## Use

```typescript
import LogNorth from 'lognorth'

LogNorth.config('https://logs.yoursite.com', 'your-api-key')

LogNorth.log('User signed up', { user_id: 123 })
LogNorth.error('Checkout failed', err, { order_id: 42 })
```

## Middleware

```typescript
// Express
import { middleware } from 'lognorth/express'
app.use(middleware())

// Hono
import { middleware } from 'lognorth/hono'
app.use(middleware())

// Next.js
import { withLogger } from 'lognorth/next'
export const GET = withLogger()(handler)
```

### Who hit the error, and in which release

Name the signed-in user inside a request. Use an ID, not an email:

```typescript
LogNorth.setUser(user.id)
```

The request event carries it, and so does every log and error in that request. LogNorth then shows how many users an issue hit.

Errors also carry the release. The SDK reads `LOGNORTH_RELEASE`, `GIT_SHA`, `KAMAL_VERSION`, or the commit variable of Render, Heroku, Railway, Vercel, or Coolify. Or set it:

```typescript
LogNorth.config(url, key, { release: process.env.APP_VERSION })
```

When the release is set, the SDK logs `Release <version> started` once at startup. LogNorth marks each release's first start on its charts.

A failed request (5xx) also carries its user agent, so you can tell a bot from a browser.

### Skipping noisy endpoints

Health checks and uptime probes swamp the log feed if you let them
through. Pass `ignorePaths` to skip them:

```typescript
app.use(middleware({ ignorePaths: ['/healthz', '/ping', '/up'] }))
```

No default list — opt in to the ones that match your deployment.
Matches exact path or `path/…` prefix.

## With Pino

Keep your existing Pino setup, add LogNorth as a transport:

```typescript
import pino from 'pino'
import { transport } from 'lognorth/pino'

LogNorth.config('https://logs.yoursite.com', 'your-api-key')

const logger = pino({ level: 'info' }, transport())

logger.info({ user_id: 123 }, 'User signed up')  // → LogNorth
logger.error({ err }, 'Checkout failed')          // → LogNorth (immediate)
```

Middleware with your logger:

```typescript
import { middleware } from 'lognorth/express'
app.use(middleware(logger))  // Uses your pino instance
```

## How It Works

Logging calls return at once. They never throw into your app.

- `LogNorth.log()` queues the event. The SDK sends when 10 events wait, or 5 seconds after the first one.
- `LogNorth.error()` queues the event and sends at once.
- The SDK sends one request at a time. A batch holds at most 500 events and 1 MB.
- A failed send keeps its events. The SDK retries them first, so events arrive in order.
- On 429 or 503, the SDK waits for `Retry-After`. On other server or network errors, it waits 1 second, then 2, 4, up to 60.
- On 401, 403, or 404, the SDK writes one line to stderr and keeps the events. It retries after 60 seconds, then up to every 5 minutes.
- If the server rejects a batch as too large or invalid, the SDK splits it. It drops a single event the server still rejects.
- Each request times out after 10 seconds.
- Each event is trimmed to 64 KB. The SDK marks it with `context.truncated = true`.
- The queue holds up to 10,000 events or 10 MB. When it is full, the SDK drops the oldest non-error event. Errors go last.
- After drops, the next successful send adds a `LogNorth client dropped N events` event with the counts.
- `LogNorth.flush()` tries each queued batch once, within 5 seconds. Events that fail stay queued.
- On exit, SIGINT, and SIGTERM, the SDK flushes. It drops what is still queued and writes the count to stderr.

## License

MIT
