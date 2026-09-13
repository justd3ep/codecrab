## Input Validation Guidelines

Validate all incoming request bodies and query parameters safely and deterministically.

### Dependency-Free Validation (Default)
When third-party validation libraries (such as `zod` or `joi`) are NOT in `package.json`, implement clean, in-file validation functions:

```typescript
export interface ValidationError {
  field: string;
  message: string;
}

export function validateProductInput(body: any): { valid: boolean; errors: ValidationError[] } {
  const errors: ValidationError[] = [];

  if (!body || typeof body !== 'object') {
    return { valid: false, errors: [{ field: 'body', message: 'Request body must be an object' }] };
  }
  if (!body.name || typeof body.name !== 'string' || body.name.trim().length === 0) {
    errors.push({ field: 'name', message: 'Product name is required' });
  }
  if (body.price === undefined || typeof body.price !== 'number' || body.price < 0) {
    errors.push({ field: 'price', message: 'Price must be a non-negative number' });
  }

  return { valid: errors.length === 0, errors };
}
```

### Controller Usage Pattern
Call the validator in the controller and return `400 Bad Request` if invalid:

```typescript
export async function createProductHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { valid, errors } = validateProductInput(req.body);
    if (!valid) {
      res.status(400).json({ success: false, error: 'Validation failed', details: errors });
      return;
    }
    const product = await productService.create(req.body);
    res.status(201).json({ success: true, data: product });
  } catch (error) {
    next(error);
  }
}
```

### Rules
1. Never import from non-existent files like `../utils/validators` or `../utils/errors`.
2. Do not import `zod` unless `zod` is explicitly listed in `package.json`.
3. Keep validation functions in the controller or service file alongside the types.
