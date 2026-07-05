## Repository Pattern

Implement repositories as classes that abstract all database access.

Rules:
- Every entity MUST have a dedicated Repository class
- Repository class name: `<Entity>Repository` (e.g. `UserRepository`)
- Repository file: `src/repositories/<entity>.repository.ts`
- Repository exports a class with methods: `findById`, `findAll`, `create`, `update`, `delete`
- Repositories import ONLY from: models, config/database
- Repositories MUST NOT import from services, controllers, or routes
- All database queries (Prisma, Mongoose, SQL) belong EXCLUSIVELY in repositories
- Services call repositories — they NEVER call Prisma/Mongoose directly

Interface pattern (TypeScript):
```typescript
export interface IUserRepository {
  findById(id: string): Promise<User | null>;
  findAll(page?: number, limit?: number): Promise<User[]>;
  create(data: CreateUserDto): Promise<User>;
  update(id: string, data: UpdateUserDto): Promise<User | null>;
  delete(id: string): Promise<boolean>;
}

export class UserRepository implements IUserRepository { ... }
```
