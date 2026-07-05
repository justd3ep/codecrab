Routing Guidelines:
- Use react-router-dom v6+ with createBrowserRouter or <BrowserRouter>.
- Define routes in a dedicated router file (src/router.tsx or src/routes.tsx).
- Use <Outlet /> for nested layouts.
- Use useNavigate() for programmatic navigation. Never use window.location.
- Use useParams() for URL params. Type them explicitly.
- Use <Link /> instead of <a /> for internal navigation.
- Lazy-load heavy pages with React.lazy + Suspense.
- Guard private routes with a PrivateRoute wrapper.

Never:
- Use react-router v5 APIs (<Switch>, component=, etc.).
- Mix react-router v5 and v6 APIs.
