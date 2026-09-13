## Centralized Error Handling Guidelines

Implement consistent error handling across routes, controllers, and services.

### Application Error Class
Define a reusable `AppError` class. It can be declared in `src/models/error.ts` or directly in `src/middleware/errorHandler.ts` or inline:

```typescript
export class AppError extends Error {
  constructor(
    public message: string,
    public statusCode: number = 500,
    public code?: string,
  ) {
    super(message);
    this.name = 'AppError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Resource not found') {
    super(message, 404, 'NOT_FOUND');
  }
}

export class BadRequestError extends AppError {
  constructor(message = 'Bad request') {
    super(message, 400, 'BAD_REQUEST');
  }
}
```

### Express Global Error Middleware
Register as the last middleware in `src/app.ts`:

```typescript
import { Request, Response, NextFunction } from 'express';

export function errorHandler(
  err: any,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  const statusCode = err.statusCode || 500;
  const message = err.message || 'Internal server error';

  console.error('[Error]', err);

  res.status(statusCode).json({
    success: false,
    error: message,
    code: err.code || 'INTERNAL_ERROR',
  });
}
```

### Rules
1. Never import from non-existent `../utils/errors` files.
2. In controllers, catch errors with try/catch and pass to `next(err)`.
3. In services, throw `AppError`, `NotFoundError`, or standard `Error`.
