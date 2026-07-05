## Input Validation

Use `zod` for schema validation. Validate ALL incoming request bodies.

Validation middleware (`src/middleware/validate.middleware.ts`):
```typescript
import { z, ZodSchema } from 'zod';
import { ValidationError } from '../utils/errors';

export const validate = (schema: ZodSchema) =>
  (req: Request, _res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const message = result.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join('; ');
      return next(new ValidationError(message));
    }
    req.body = result.data;
    next();
  };
```

Route usage:
```typescript
const createUserSchema = z.object({
  email:    z.string().email(),
  password: z.string().min(8),
  name:     z.string().min(2),
});
router.post('/', validate(createUserSchema), controller.create);
```

Rules:
- Every POST/PUT/PATCH route MUST use `validate()` middleware
- Validation schemas live in `src/validators/<entity>.validator.ts`
- Never manually check `req.body.field` — always use validated schema output
