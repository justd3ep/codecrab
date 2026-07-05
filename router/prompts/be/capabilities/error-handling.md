## Error Handling

Implement a centralized error handler. Never send raw errors to the client.

Error classes (`src/utils/errors.ts`):
```typescript
export class AppError extends Error {
  constructor(
    public message: string,
    public statusCode: number = 500,
    public code?: string,
  ) { super(message); this.name = 'AppError'; }
}
export class NotFoundError       extends AppError { constructor(m = 'Not found')    { super(m, 404, 'NOT_FOUND'); } }
export class UnauthorizedError   extends AppError { constructor(m = 'Unauthorized') { super(m, 401, 'UNAUTHORIZED'); } }
export class ValidationError     extends AppError { constructor(m: string)          { super(m, 400, 'VALIDATION_ERROR'); } }
export class ForbiddenError      extends AppError { constructor(m = 'Forbidden')    { super(m, 403, 'FORBIDDEN'); } }
export class ConflictError       extends AppError { constructor(m: string)          { super(m, 409, 'CONFLICT'); } }
```

Global error handler (last middleware in app.ts):
```typescript
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({ success: false, message: err.message, code: err.code });
  }
  console.error(err);
  res.status(500).json({ success: false, message: 'Internal server error' });
});
```

Rules:
- ALL async route handlers must call `next(err)` on error
- Services throw AppError subclasses — never raw strings
- Controllers never send raw error messages to the client
