# migration/

These files contain extracted copies of the legacy monolithic loop
and related helpers. They allow `index.ts` to continue using the old
`POST /v1/chat/completions` path while the new job system is built.

## Removal Milestone

Delete this directory when:
1. `POST /v1/chat/completions` routes through `JobService` internally, AND
2. All clients use `POST /v1/jobs`, AND
3. No file in `src/` imports from `migration/`

Target: after validation of production stability for ≥ 2 weeks.
