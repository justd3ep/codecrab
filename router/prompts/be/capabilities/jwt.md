## JWT Authentication

Rules:
- JWT signing and verification belong EXCLUSIVELY in the auth service
- NEVER call `jwt.sign` or `jwt.verify` in routes, controllers, or middleware (except auth middleware)
- Use environment variables: `process.env.JWT_SECRET`, `process.env.JWT_REFRESH_SECRET`
- Access token expiry: `process.env.JWT_EXPIRES_IN` (default `'15m'`)
- Refresh token expiry: `process.env.JWT_REFRESH_EXPIRES_IN` (default `'7d'`)

Auth middleware pattern:
```typescript
// src/middleware/auth.middleware.ts
export const authMiddleware = (req: Request, res: Response, next: NextFunction) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ message: 'Unauthorized' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET!) as JwtPayload;
    next();
  } catch { res.status(401).json({ message: 'Invalid token' }); }
};
```

Token generation (in AuthService only):
```typescript
generateTokens(userId: string) {
  const accessToken  = jwt.sign({ id: userId }, process.env.JWT_SECRET!,         { expiresIn: '15m' });
  const refreshToken = jwt.sign({ id: userId }, process.env.JWT_REFRESH_SECRET!, { expiresIn: '7d' });
  return { accessToken, refreshToken };
}
```
