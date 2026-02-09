# lognorth

Official SDK for [LogNorth](https://lognorth.com) - self-hosted error tracking.

## Install

```bash
npm install @karloscodes/lognorth-sdk
```

## Use

```typescript
import LogNorth from '@karloscodes/lognorth-sdk'

LogNorth.config('https://logs.yoursite.com', 'your-api-key')

LogNorth.log('User signed up', { user_id: 123 })

LogNorth.error('Checkout failed', err, { order_id: 42 })
```

## Middleware

```typescript
// Express
import { middleware } from '@karloscodes/lognorth-sdk/express'
app.use(middleware())

// Hono
import { middleware } from '@karloscodes/lognorth-sdk/hono'
app.use(middleware())

// Next.js
import { withLogger } from '@karloscodes/lognorth-sdk/next'
export const GET = withLogger(handler)
```

## How It Works

- `LogNorth.log()` batches events (10 or 5s)
- `LogNorth.error()` sends immediately
- Auto-flushes on shutdown

## License

MIT
