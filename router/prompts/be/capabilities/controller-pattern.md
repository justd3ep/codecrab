## Controller Pattern

Controllers are thin adapters between HTTP and the service layer.

Rules:
- Controller class name: `<Entity>Controller` (e.g. `UserController`)
- Controller file: `src/controllers/<entity>.controller.ts`
- Controllers import ONLY from: services
- Controllers MUST NOT import from: repositories, models, Prisma, Mongoose, bcrypt, jwt
- Controllers receive `(req, res, next)` — they call the service and send the HTTP response
- Controllers do NOT contain business logic — they delegate entirely to services
- Controllers catch service errors and convert them to HTTP responses

Pattern:
```typescript
export class UserController {
  constructor(private readonly userService: UserService) {}

  async create(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const user = await this.userService.createUser(req.body);
      res.status(201).json(user);
    } catch (err) { next(err); }
  }
}
```
