# @c5h-soft/discord-logger

Lightweight Discord webhook logger with [pino](https://github.com/pinojs/pino) integration, colored console output, and timezone support.

Perfect for monitoring your applications in real-time through Discord webhooks.

## Features

- 🚀 **Simple API** - Initialize once, use everywhere
- 🎨 **Colored console output** - Beautiful logs in development
- 🌍 **Timezone support** - Configure timestamps for your region
- 📊 **Pino integration** - Professional logging with structured data
- 🔔 **Discord webhooks** - Real-time notifications to your Discord channel
- 📦 **TypeScript** - Full type support out of the box
- 📡 **Multiple channels** - Route embeds to one webhook per channel, edit messages, dedupe alerts
- 🪶 **Lightweight** - Minimal dependencies

## Installation

```bash
npm install @c5h-soft/discord-logger
# or
yarn add @c5h-soft/discord-logger
# or
pnpm add @c5h-soft/discord-logger
```

## Quick Start

### 1. Initialize the logger (once at app startup)

```typescript
// For Next.js: src/instrumentation.ts
import { initDiscordLogger } from "@c5h-soft/discord-logger";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    initDiscordLogger({
      webhookUrl: process.env.DISCORD_WEBHOOK_URL,
      timezone: "America/Argentina/Buenos_Aires",
      locale: "es-AR",
      appName: "my-app",
      debug: process.env.NODE_ENV === "development",
    });
  }
}
```

```typescript
// For Express/Node.js: src/index.ts
import { initDiscordLogger } from "@c5h-soft/discord-logger";

initDiscordLogger({
  webhookUrl: process.env.DISCORD_WEBHOOK_URL,
  appName: "api-server",
});
```

### 2. Use the logger anywhere

```typescript
import { log } from "@c5h-soft/discord-logger";

// Simple messages
log.info("Server started on port 3000");
log.warn("Deprecated function called");
log.error("Database connection failed", new Error("Connection refused"));
log.debug("Request payload", { userId: 123, action: "login" });

// Structured event logging
log.info({
  event: "user.registered",
  timestamp: new Date(),
  userId: "123",
  email: "user@example.com",
  provider: "google",
});
```

## Configuration Options

| Option           | Type                | Default       | Description                                                              |
| ---------------- | ------------------- | ------------- | ------------------------------------------------------------------------ |
| `webhookUrl`     | `string`            | `undefined`   | Discord webhook URL. Required for Discord logging.                       |
| `timezone`       | `string`            | `'UTC'`       | Timezone for timestamps (e.g., `'America/New_York'`, `'Europe/London'`). |
| `locale`         | `string`            | `'en-US'`     | Locale for date formatting (e.g., `'es-AR'`, `'de-DE'`).                 |
| `appName`        | `string`            | `'app'`       | Application name shown in logs.                                          |
| `debug`          | `boolean`           | `false`       | Enable debug level logging.                                              |
| `colors`         | `boolean`           | `true` in dev | Enable colored console output.                                           |
| `disableDiscord` | `boolean`           | `false`       | Disable Discord logging (useful for testing).                            |
| `disableConsole` | `boolean`           | `false`       | Disable console logging entirely.                                        |
| `pinoOptions`    | `PinoLoggerOptions` | `{}`          | Custom pino configuration options.                                       |
| `webhooks`       | `Record<string, string>` | `{}`     | Named webhooks, one per channel. Channels without a URL fall back to `webhookUrl`. |
| `levelChannels`  | `{ info?, warn?, error?, debug? }` | `{}` | Route plain log levels to a named webhook (e.g. `{ error: 'alerts' }`). |
| `embedFooter`    | `string`            | `undefined`   | Footer added to embeds sent with `notify()` (e.g. environment name).     |

## Multiple channels (since 1.1.0)

Send rich embeds to a different Discord channel per kind of event. Everything is
backwards compatible: `webhookUrl` keeps working and acts as the fallback.

```typescript
import { initDiscordLogger, log, field } from "@c5h-soft/discord-logger";

initDiscordLogger({
  webhookUrl: process.env.DISCORD_WEBHOOK_URL, // fallback
  webhooks: {
    sales: process.env.DISCORD_WEBHOOK_SALES,
    alerts: process.env.DISCORD_WEBHOOK_ALERTS,
  },
  levelChannels: { error: "alerts", warn: "alerts" },
});

// Embeds never ping unless `mention: true` (sends @here).
const sent = await log.notify(
  { channel: "sales", title: "💰 New sale", color: 0x16a34a, fields: [field("Plan", "Pro"), field("Coupon", undefined)] },
  { wait: true },
);

// Update the same message later instead of posting a new one.
if (sent.messageId) await log.edit(sent.messageId, { channel: "sales", title: "💰 New sale · delivered" });
```

For full control (custom routing, lazy env reads, failure hooks) use the client directly:

```typescript
import { createDiscordWebhookClient, createAlertDeduper, alertFingerprint } from "@c5h-soft/discord-logger";

const discord = createDiscordWebhookClient({
  resolveWebhookUrl: (channel) => process.env[`DISCORD_WEBHOOK_${channel.toUpperCase()}`],
  fallbackWebhookUrl: () => process.env.DISCORD_WEBHOOK_URL,
  footer: () => (process.env.NODE_ENV === "production" ? undefined : process.env.NODE_ENV),
  onFailure: (failure) => console.warn("discord delivery failed", failure),
});

const deduper = createAlertDeduper({ windowMs: 10 * 60_000 });
const { send, suppressed } = deduper.check(alertFingerprint("error", "timeout for job 123"));
if (send) await discord.send({ channel: "alerts", title: "Timeout", description: suppressed ? `×${suppressed + 1}` : undefined });
```

The client:

- enforces Discord embed limits (title 256, field 1024, 25 fields, 6000 total) by truncating instead of failing;
- disables mentions by default (`allowed_mentions: { parse: [] }`) and neutralizes `@everyone`/`@here`/`<@id>` in user text;
- serializes requests per webhook and retries once after a `429`, honoring `retry_after`;
- times out after 5s and never throws: it returns `{ ok, status?, messageId?, errorName? }`.

## API Reference

### `initDiscordLogger(config)`

Initialize the logger with your configuration. Call this once at application startup.

```typescript
import { initDiscordLogger } from "@c5h-soft/discord-logger";

initDiscordLogger({
  webhookUrl: process.env.DISCORD_WEBHOOK_URL,
  timezone: "America/Argentina/Buenos_Aires",
  locale: "es-AR",
  appName: "my-app",
  debug: true,
  colors: true,
});
```

### `log.info(message, data?)`

Log an informational message.

```typescript
log.info("User logged in");
log.info("Processing request", { userId: 123, path: "/api/users" });
log.info({ event: "payment.completed", amount: 100, userId: "456" });
```

### `log.error(message, error?)`

Log an error message with optional error object.

```typescript
log.error("Something went wrong");
log.error("Database query failed", new Error("Connection timeout"));
log.error("API call failed", { status: 500, body: "Internal error" });
```

### `log.warn(message, data?)`

Log a warning message.

```typescript
log.warn("Rate limit approaching");
log.warn("Deprecated API called", { endpoint: "/v1/users", by: "client-123" });
```

### `log.debug(message, data?)`

Log a debug message (only when `debug: true` is configured).

```typescript
log.debug("Cache hit", { key: "user:123" });
log.debug({ query: "SELECT * FROM users", duration: 45 });
```

### `log.child(bindings)`

Create a child logger with additional context.

```typescript
const requestLog = log.child({ requestId: "abc-123", userId: 456 });
requestLog.info("Processing request");
requestLog.error("Request failed", new Error("Not found"));
```

### `log.getPino()`

Get the underlying pino logger instance for advanced usage.

```typescript
const pinoLogger = log.getPino();
pinoLogger.info({ custom: "data" }, "Using pino directly");
```

## Event Formatting

The logger automatically formats event objects with special handling for common event types:

```typescript
log.info({
  event: "user.registered",
  timestamp: new Date(),
  userId: "123",
  email: "john@example.com",
  name: "John Doe",
  provider: "google",
});
```

Discord output:

```
ℹ️ [my-app] **USER.REGISTERED** - 12/12/2025, 10:30:00
User: 123 • Email: john@example.com • Name: John Doe • Provider: google
```

Supported event patterns:

- `user.*` - User events (login, register, etc.)
- `payment.*` - Payment events (amount, credits)
- `job.*` - Job events (title, company)
- `application.*` - Application events
- `api_key.*` - API key events
- `webhook.*` - Webhook events

## Development vs Production

In development (`NODE_ENV=development`):

- Colored console output using pino-pretty
- Human-readable timestamps
- Debug messages shown (if enabled)

In production:

- JSON structured logging via pino
- Optimized for log aggregation services
- Discord notifications for monitoring

## Environment Variables

```bash
# Required for Discord logging
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...

# Optional
NODE_ENV=development  # Enables colored output
```

## Common Timezone Values

| Timezone                         | Region                     |
| -------------------------------- | -------------------------- |
| `UTC`                            | Coordinated Universal Time |
| `America/New_York`               | Eastern US                 |
| `America/Chicago`                | Central US                 |
| `America/Denver`                 | Mountain US                |
| `America/Los_Angeles`            | Pacific US                 |
| `America/Argentina/Buenos_Aires` | Argentina                  |
| `America/Sao_Paulo`              | Brazil                     |
| `America/Mexico_City`            | Mexico                     |
| `Europe/London`                  | UK                         |
| `Europe/Paris`                   | Central Europe             |
| `Europe/Berlin`                  | Germany                    |
| `Europe/Madrid`                  | Spain                      |
| `Asia/Tokyo`                     | Japan                      |
| `Asia/Shanghai`                  | China                      |
| `Asia/Singapore`                 | Singapore                  |
| `Asia/Dubai`                     | UAE                        |
| `Asia/Kolkata`                   | India                      |
| `Australia/Sydney`               | Australia (East)           |

📋 **Full list:** [IANA Time Zone Database](https://en.wikipedia.org/wiki/List_of_tz_database_time_zones)

## Common Locale Values

| Locale  | Language / Region        |
| ------- | ------------------------ |
| `en-US` | English (United States)  |
| `en-GB` | English (United Kingdom) |
| `es-ES` | Spanish (Spain)          |
| `es-AR` | Spanish (Argentina)      |
| `es-MX` | Spanish (Mexico)         |
| `pt-BR` | Portuguese (Brazil)      |
| `pt-PT` | Portuguese (Portugal)    |
| `fr-FR` | French (France)          |
| `de-DE` | German (Germany)         |
| `it-IT` | Italian (Italy)          |
| `ja-JP` | Japanese (Japan)         |
| `zh-CN` | Chinese (Simplified)     |
| `zh-TW` | Chinese (Traditional)    |
| `ko-KR` | Korean (South Korea)     |
| `ru-RU` | Russian (Russia)         |
| `ar-SA` | Arabic (Saudi Arabia)    |
| `hi-IN` | Hindi (India)            |

📋 **Full list:** [BCP 47 Language Tags](https://www.techonthenet.com/js/language_tags.php) | [MDN Intl.Locale](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/Locale)

## Examples

### Next.js App Router

```typescript
// src/instrumentation.ts
import { initDiscordLogger, log } from "@c5h-soft/discord-logger";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    initDiscordLogger({
      webhookUrl: process.env.DISCORD_WEBHOOK_URL,
      appName: "nextjs-app",
      timezone: "UTC",
    });
    log.info("Application started");
  }
}
```

### Express Server

```typescript
import express from "express";
import { initDiscordLogger, log } from "@c5h-soft/discord-logger";

initDiscordLogger({
  webhookUrl: process.env.DISCORD_WEBHOOK_URL,
  appName: "api-server",
});

const app = express();

app.use((req, res, next) => {
  log.debug("Request received", { method: req.method, path: req.path });
  next();
});

app.listen(3000, () => {
  log.info("Server started on port 3000");
});
```

### Error Handling

```typescript
import { log } from "@c5h-soft/discord-logger";

async function processPayment(userId: string, amount: number) {
  try {
    const result = await paymentService.charge(userId, amount);
    log.info({
      event: "payment.completed",
      timestamp: new Date(),
      userId,
      amount,
      transactionId: result.id,
    });
    return result;
  } catch (error) {
    log.error("Payment processing failed", error);
    throw error;
  }
}
```

## License

MIT © [c5h.dev](https://c5h.dev)

---

Made with ❤️ by [c5h.dev](https://c5h.dev) - Custom software development
