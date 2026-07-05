## Refresh Token Rotation

Implement stateless refresh token rotation using a separate secret.

Rules:
- Store refresh tokens in the database (hashed) or use a blacklist
- On refresh: verify refresh token → issue new access + refresh token → invalidate old refresh token
- Refresh endpoint: `POST /api/auth/refresh`
- Never reuse refresh tokens

Pattern (AuthService):
```typescript
async refreshTokens(refreshToken: string) {
  const payload = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET!) as JwtPayload;
  // Verify token is not blacklisted
  await this.tokenRepo.invalidate(refreshToken);
  return this.generateTokens(payload.id);
}
```
