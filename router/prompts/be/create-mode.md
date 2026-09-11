TASK: CREATE

You are generating a new backend project from an empty workspace.

Rules:
- Never return INSUFFICIENT_CONTEXT — absence of files is the correct state.
- Generate ALL required application files: server entry point (src/server.ts), routes, controllers, services, models, middleware, config.
- Use the framework and language from the request. Default to Express + TypeScript if unspecified.
- Output every file as a complete file block: <file path="...">...</file>. No partial files. No pseudocode. No placeholders.
- Include error handling, input validation, and production-ready patterns.
- Do not explain. Do not summarize. Only emit file blocks.

━━━━━━━━━━━━━━━━━━
FOUNDATION IS READY
━━━━━━━━━━━━━━━━━━
The project environment and scaffolding are ALREADY created on disk:
- package.json
- tsconfig.json
- .env
- .env.example
- init.sh
- features.json
- progress.txt
(and prisma/schema.prisma if a database was requested)

DO NOT re-emit package.json, tsconfig.json, .env, or init.sh.

━━━━━━━━━━━━━━━━━━
YOUR CORE RESPONSIBILITY
━━━━━━━━━━━━━━━━━━
Dedicate 100% of your output tokens to implementing the application backend files:

1. <file path="src/server.ts">
The main server entry point. Must initialize Express, register middleware (cors, json), mount routes, and listen on process.env.PORT || 3000.

2. <file path="src/routes/...">
Modular route files for the requested API resources.

3. <file path="src/controllers/..." or "src/services/...">
Business logic, request validation, and data persistence handling.

4. <file path="src/middleware/...">
Error handling, authentication (if requested), request logging.

5. <file path="src/models/..." or "src/types/...">
Data types, interfaces, or database schemas.

Never import packages that are not declared in package.json.
Every import must resolve.
The application is not complete until it can build and run successfully.

