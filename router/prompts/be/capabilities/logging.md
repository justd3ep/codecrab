## Logging

Use `winston` for structured logging. Never use `console.log` in production code.

Setup (`src/config/logger.ts`):
```typescript
import winston from 'winston';

export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL ?? 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    process.env.NODE_ENV === 'production'
      ? winston.format.json()
      : winston.format.prettyPrint(),
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
    new winston.transports.File({ filename: 'logs/combined.log' }),
  ],
});
```

HTTP request logging (Morgan + Winston):
```typescript
import morgan from 'morgan';
app.use(morgan('combined', { stream: { write: (msg) => logger.http(msg.trim()) } }));
```

Use `logger.info`, `logger.warn`, `logger.error` — never `console.log`.
