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
- Use relative imports.
- Every import must resolve.
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
✓ No any.
✓ No unresolved imports.
✓ Interfaces defined.
✓ Types compile.
✓ No missing exports.
✓ Strict TypeScript compatible.

Output code only.