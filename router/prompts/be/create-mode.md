TASK: CREATE

You are generating a new backend project from an empty workspace.

Rules:
- No existing files exist. This is expected.
- Never return INSUFFICIENT_CONTEXT — absence of files is the correct state.
- Generate ALL required files: entry point, routes, controllers, services, models, middleware, config.
- Use the framework and language from the request. Default to Express + TypeScript if unspecified.
- Output every file as a complete file block. No partial files. No pseudocode. No placeholders.
- Include error handling, input validation, and production-ready patterns.
- Do not explain. Do not summarize. Only emit file blocks.
