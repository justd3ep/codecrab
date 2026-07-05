## Service Layer Pattern

Services contain ALL business logic. They are the only layer that coordinates between repositories and external integrations.

Rules:
- Every module MUST have a dedicated Service class
- Service class name: `<Entity>Service` (e.g. `UserService`)
- Service file: `src/services/<entity>.service.ts`
- Services import from: repositories, config, external libs (jwt, bcrypt, nodemailer)
- Services MUST NOT import from: controllers, routes, or Express (req/res)
- Services are framework-agnostic — they receive plain data, not Express objects
- Services return plain objects or throw typed errors — not HTTP responses

Pattern:
```typescript
export class UserService {
  constructor(private readonly userRepo: UserRepository) {}

  async createUser(dto: CreateUserDto): Promise<User> {
    // business logic here — hashing, validation, email, etc.
  }
}
```
