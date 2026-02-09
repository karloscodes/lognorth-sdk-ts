# lognorth

Official JavaScript/TypeScript SDK for [LogNorth](https://lognorth.com) - self-hosted error tracking and logging.

## Install

```bash
npm install @karloscodes/lognorth-sdk
```

## Quick Start

```typescript
import { createLogger } from '@karloscodes/lognorth-sdk'

const log = createLogger({
  apiKey: process.env.LOGNORTH_API_KEY,
  endpoint: process.env.LOGNORTH_URL,
})

// Log events
log('User signed up', { user_id: 123 })

// Log errors with stack traces
try {
  await checkout(order)
} catch (err) {
  log.error('Checkout failed', { error: err, order_id: order.id })
}
```

## Framework Middleware

### Express

```typescript
import { createLogger } from '@karloscodes/lognorth-sdk'
import { middleware } from '@karloscodes/lognorth-sdk/express'

const log = createLogger({ apiKey: '...', endpoint: '...' })

app.use(middleware(log))
```

### Hono

```typescript
import { createLogger } from '@karloscodes/lognorth-sdk'
import { middleware } from '@karloscodes/lognorth-sdk/hono'

const log = createLogger({ apiKey: '...', endpoint: '...' })

app.use(middleware(log))
```

### Next.js

```typescript
import { createLogger } from '@karloscodes/lognorth-sdk'
import { withLogger } from '@karloscodes/lognorth-sdk/next'

const log = createLogger({ apiKey: '...', endpoint: '...' })

export const GET = withLogger(log)(async (req) => {
  return Response.json({ ok: true })
})
```

## How It Works

- **Regular logs** are batched (10 events or 5 seconds) and sent with 1 retry
- **Errors** are sent immediately with 3 retries and exponential backoff
- **Buffer limit** of 1000 events - drops oldest regular logs first, never drops errors
- **429/503 handling** - automatically backs off when server is busy

## Configuration

```typescript
const log = createLogger({
  apiKey: string,           // Required
  endpoint: string,         // LogNorth server URL
  batchSize: 10,            // Events before auto-flush
  flushInterval: 5000,      // Ms before auto-flush
  maxBufferSize: 1000,      // Max buffered events
})
```

## Flushing

Call `flush()` before shutdown:

```typescript
await log.flush()
```

## License

MIT
