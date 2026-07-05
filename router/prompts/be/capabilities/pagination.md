## Pagination

Implement cursor-based or offset-based pagination consistently.

Offset pagination pattern:
```typescript
interface PaginationQuery { page?: number; limit?: number; }
interface PaginatedResult<T> { data: T[]; total: number; page: number; limit: number; totalPages: number; }

// In repository:
async findAll({ page = 1, limit = 10 }: PaginationQuery): Promise<PaginatedResult<Entity>> {
  const skip  = (page - 1) * limit;
  const [data, total] = await Promise.all([
    this.model.findMany({ skip, take: limit }),
    this.model.count(),
  ]);
  return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
}
```

Route query params: `GET /api/items?page=1&limit=10`
Parse with: `const page = parseInt(req.query.page as string) || 1;`
