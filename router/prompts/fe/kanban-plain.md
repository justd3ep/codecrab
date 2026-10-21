Kanban Board Guidelines (PLAIN HTML / CSS / JS — no framework):

DOM SHAPE
- A board container with 3 column sections (Todo, Doing, Done), each with a heading,
  a count, and a list of cards.
- A card is a focusable element (`tabindex="0"`) with a title and a delete control.

NATIVE HTML5 DRAG AND DROP (no library)
- Card: `draggable="true"`, `dragstart` sets `e.dataTransfer.setData('text/plain', cardId)`.
- Column list: `dragover` MUST call `e.preventDefault()` or the drop never fires.
- Column list: `drop` reads the id with `e.dataTransfer.getData('text/plain')` and moves the card.
- Compute the insertion index from `e.clientY` against the card midpoints so the card can be
  reordered INSIDE a column, not only moved between columns.
- Always call `e.dataTransfer.effectAllowed = 'move'` on dragstart.

PERSISTENCE
- Store `{ columns: { todo: [...], doing: [...], done: [...] } }` as JSON in `localStorage`.
- Write on every mutation (add / move / edit / delete).
- On load, read it inside `try { ... } catch {}` — a corrupted value must not break the app.
- Generate ids with `Date.now().toString() + Math.random().toString(36).slice(2)` so ids stay unique.

ACCESSIBILITY (the request will usually ask for it — implement it properly)
- Cards are reachable with Tab (`tabindex="0"`).
- Keyboard move between columns: listen for `keydown` and check `e.altKey` with Arrow keys.
- Announce moves through a live region: `<div id="live" role="status" aria-live="polite"></div>`
  and set its `textContent` to a human sentence ("Card X moved to Doing, position 2 of 3").
- Give the delete button an `aria-label`, and give every icon-only control one.

THEME
- Use CSS custom properties on `:root` and a `[data-theme="dark"]` override.
- On first load, read `window.matchMedia('(prefers-color-scheme: dark)').matches` — but ONLY
  when the user has not stored a preference. Store the manual choice in `localStorage`.
- Toggle by setting `document.documentElement.dataset.theme`.

RESPONSIVE
- Use CSS Grid with `grid-template-columns: repeat(3, minmax(0, 1fr))`.
- Under 700px switch to `grid-template-columns: 1fr` (columns stack) via a media query.

ANIMATION WITHOUT LAYOUT JITTER
- Animate with `transform` and `opacity` only — never `height`/`top`/`width`.
- For insertion/removal use a CSS class with a short transition, and remove the node from the
  DOM in the transition's `animationend`/`transitionend` callback (or a timeout) so the element
  does not disappear mid-animation.
- If reordering must look smooth, capture `getBoundingClientRect()` before the DOM change and
  animate the delta with the Web Animations API (`element.animate`).

STATE SHAPE
- Keep a single source of truth, e.g. `const state = { columns: { todo: [], doing: [], done: [] } }`.
- Every add / edit / delete / move goes through one function that mutates state, re-renders and
  persists — never mutate the DOM directly for data.
