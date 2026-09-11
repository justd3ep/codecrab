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
4. IMPORT INTEGRITY: If you render <Foo /> in src/App.tsx, you MUST include: import { Foo } from './components/Foo'; at the top of src/App.tsx.
5. REACT HOOKS: ALWAYS import hooks: import React, { useState, useEffect } from 'react';. NEVER call hooks after an early return statement. Never run setTimeout directly in component render bodies (use useEffect with cleanup).
6. STATEFUL INTERACTION: Use dynamic useState arrays for messages and lists so adding an item updates the UI. Never render hardcoded static array literals. Wire onSendMessage to append to the messages state.
7. ICONS: ONLY import icons from "lucide-react" using named imports (e.g. import { Send, Plus, X, Settings, LayoutDashboard, Bot, Building2, UserPlus } from 'lucide-react';). NEVER write IconSend or IconX without importing them.
8. NO FAKE UTILITIES: NEVER import from '@/utils/...' or '@/lib/...' (e.g. '@/utils/currency') unless you output that exact utility file in this response. Inline formatters (e.g. formatCurrency, formatDate) directly in the component file.
9. NO PHANTOM WRAPPERS: src/App.tsx must directly import and assemble the requested subcomponents (e.g. Sidebar, MetricCard, TransactionTable). NEVER write an App.tsx that only renders <MainView />!