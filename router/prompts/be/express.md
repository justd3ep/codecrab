## Express.js Application Architecture Guidelines

Build modular, reliable Express applications with clean separation between app configuration and server startup.

### Application Entrypoints Architecture
1. **`src/app.ts` (Application Factory / Setup)**:
   - Initializes the Express instance: `const app = express();`
   - Configures core middleware: `app.use(cors()); app.use(express.json());`
   - Mounts feature routers: `app.use('/api/<resource>', resourceRouter);`
   - Mounts 404 handler and global error middleware.
   - **CRITICAL**: `src/app.ts` MUST export `app` (or `export default app;`).
   - **CRITICAL**: `src/app.ts` MUST NEVER call `app.listen()`.
2. **`src/server.ts` (Process Entrypoint)**:
   - Imports `app` from `./app`: `import app from './app';` (or `import { app } from './app';`)
   - Reads `PORT` from `process.env.PORT || 3000`.
   - Starts HTTP listener:
     ```typescript
     import app from './app';
     const PORT = process.env.PORT || 3000;
     app.listen(PORT, () => {
       console.log(`Server listening on port ${PORT}`);
     });
     ```

### Clean Middleware & Handler Conventions
- Parse JSON bodies with `express.json()`.
- Enable CORS with `cors()`.
- Always wrap async controller handlers with try/catch and delegate errors to `next(error)`.
- Use express status codes properly: `res.status(200).json(...)`, `res.status(201).json(...)`, `res.status(404).json(...)`.

### Self-Containment Rule
- Never import from hypothetical utility files like `../utils/logger` or `../utils/validators` unless they exist on disk.
- Use standard `console.log` / `console.error` and inline validation logic.
