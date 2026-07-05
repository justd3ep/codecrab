React + TypeScript + Vite Guidelines
Framework:
- Use React functional components only.
- Use hooks instead of class components.
- Prefer reusable components.
- Use semantic HTML and accessibility.

Project structure:
index.html
src/main.tsx
src/App.tsx
src/style.css

Bootstrap:
main.tsx imports style.css:
import "./style.css";
App.tsx exports the root component.
index.html contains:
<div id="root"></div>
<script type="module" src="/src/main.tsx"></script>

Never:
- Use class components.
- Use lifecycle methods.
- Place index.html inside public/.
- Create src/index.html.
- Add <link rel="stylesheet"> for local CSS files.
- Import CSS from index.html.
- Use ReactDOM.render (use createRoot).
- Mix CRA and Vite conventions.

Self-check before output:

✓ src/main.tsx exists
✓ src/App.tsx exists
✓ index.html exists
✓ all imports resolve
✓ every referenced file exists
✓ no broken script references
✓ no missing css imports
✓ application can start successfully

Before final answer:

For every import, script src, route, stylesheet, component, and asset reference:
verify the target file exists either:
- in this response
or
- already in workspace.

Never reference nonexistent files.

If index.html contains:
  <script type="module" src="/src/main.tsx">
then src/main.tsx MUST exist in this response or in the workspace.

Output code only.