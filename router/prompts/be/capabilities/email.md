## Email Sending

Use `nodemailer` with SMTP. All email sending belongs in the service layer.

Setup (`src/config/mailer.ts`):
```typescript
import nodemailer from 'nodemailer';

export const transporter = nodemailer.createTransport({
  host:   process.env.SMTP_HOST,
  port:   parseInt(process.env.SMTP_PORT ?? '587'),
  secure: process.env.SMTP_SECURE === 'true',
  auth:   { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
});
```

Email service (`src/services/email.service.ts`):
```typescript
export class EmailService {
  async sendWelcome(to: string, name: string): Promise<void> {
    await transporter.sendMail({
      from:    `"${process.env.APP_NAME}" <${process.env.SMTP_FROM}>`,
      to,
      subject: 'Welcome!',
      html:    `<h1>Welcome, ${name}!</h1>`,
    });
  }
}
```

Rules:
- NEVER call `transporter.sendMail` in routes or controllers
- Always wrap in try/catch — email failures must not crash the request
- Use environment variables for all SMTP credentials
