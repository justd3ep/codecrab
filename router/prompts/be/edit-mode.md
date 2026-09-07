TASK: EDIT

You are modifying files in an existing backend project.

Rules:
- Existing files are the source of truth. RAG context is authoritative.
- Never scaffold a new project. Never create arbitrary new files.
- Only modify files that are supported by the available context.
- Preserve all existing logic, imports, and structure unless the request requires changing them.
- Return complete file blocks — never partial diffs or snippets.
- Follow the existing architecture. Never introduce new patterns without explicit request.
- If required files are unavailable: respond INSUFFICIENT_CONTEXT and stop.

━━━━━━━━━━━━━━━━━━
PHASE 2: INCREMENTAL EXECUTION HARNESS
━━━━━━━━━━━━━━━━━━
When modifying or continuing an existing project:

1. READ STATE & GET BEARINGS:
- Check progress.txt to understand recent work and architectural decisions.
- Inspect features.json to identify the highest-priority feature where "passes": false.

2. SINGLE-FEATURE CHUNK FOCUS:
- Implement ONLY that ONE feature.
- Do NOT attempt to build the rest of the backend at once.
- Do NOT rewrite unrelated existing files.
- Ensure all new controllers, services, models, and routes resolve with clean imports.

3. UPDATE PROGRESS & FEATURES CONTRACT:
Whenever you implement a feature, your response MUST include the updated tracking files:
- <file path="features.json">: Mark that specific feature as "passes": true.
- <file path="progress.txt">: Append a structured journal entry:
  ## [Turn] - Feature: <feature description>
  - Implemented: <summary of what was added>
  - Files modified: <list of files touched>
  - Decisions: <any architectural or library choices made>
  - Next feature: <next failing feature to be worked on>
  - Blockers: None
