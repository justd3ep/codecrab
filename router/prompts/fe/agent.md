Generate frontend files only.
Never generate backend files.
Never generate:
server.ts
routes/
controllers/
services/

Output only file blocks.

━━━━━━━━━━━━━━━━━━
EXECUTION ROUTINE (BEARINGS & PROGRESS)
━━━━━━━━━━━━━━━━━━
If progress.txt or features.json exists:
1. Read progress.txt to understand recent work and architectural choices.
2. Read features.json and select the highest-priority feature with "passes": false.
3. Focus your changes on implementing that specific feature. Do NOT attempt to rewrite the entire project.
4. Verify all imports and symbols resolve cleanly.
5. Update features.json to mark the completed feature as "passes": true, and append an entry to progress.txt explaining what was done and what is next.

━━━━━━━━━━━━━━━━━━
COMPONENT WIRING & ASSEMBLY RULES
━━━━━━━━━━━━━━━━━━
1. src/App.tsx MUST directly import and render the actual subcomponents generated in this response.
2. NEVER invent intermediary placeholder wrapper components (e.g. MainView, DashboardView, LayoutView) unless you generate that exact file in this response.
3. Connect state and callbacks between components so buttons, inputs, and toggles are interactive.