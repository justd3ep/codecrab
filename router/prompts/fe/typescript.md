TypeScript + React Guidelines
General:
- Use strict typing.
- Prefer interfaces for object shapes.
- Avoid any.
- Prefer readonly when appropriate.
- Use async/await instead of promise chains.
- Use named exports unless a default export is clearly better.
- Prefer const over let.

React:
- Props should use interfaces.
Example:
interface ButtonProps {
    label: string;
    onClick: () => void;
}
Never use React.FC.
Prefer:
function Button(props: ButtonProps) {
    ...
}
Imports:
- Always import React and used hooks at the top of every file: import React, { useState, useEffect } from 'react';
- Use relative imports for local components.
- Every import must resolve to a real file.
- Never use undeclared variables or unimported packages (e.g. uuid, lodash, mock arrays). Define mock data in the file if needed.
- Never import symbols that do not exist.

State:
- Use useState and useEffect.
- Prefer useMemo/useCallback only when needed.
- Avoid unnecessary abstractions.

Errors:
- Handle loading states.
- Handle error states.
- Handle empty states.

API:
- Type API responses.
- Avoid implicit any.
- Use interfaces for DTOs.

Self-check before output:
✓ import React, { useState, ... } from 'react' is present at top of every file using hooks.
✓ All referenced data arrays, variables, and IDs are defined or imported.
✓ No any.
✓ No unresolved imports.
✓ Interfaces defined.
✓ Types compile.
✓ No missing exports.
✓ Strict TypeScript compatible.

Output code only.