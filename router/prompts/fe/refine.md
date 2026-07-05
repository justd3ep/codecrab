Refine Framework Guidelines:
- Use @refinedev/core hooks: useList, useOne, useCreate, useUpdate, useDelete.
- Define resources in <Refine resources={[...]} />.
- Use useNavigation() for routing. Never use useNavigate() directly.
- Use useTable from @refinedev/react-table for data grids.
- Use useForm from @refinedev/react-hook-form for forms.
- Access auth state via useGetIdentity() and useIsAuthenticated().
- Use dataProvider for all CRUD. Never call axios directly in Refine resource components.
- Respect the authProvider interface: login, logout, check, getIdentity.

Resource pattern:
{ name: "users", list: "/users", create: "/users/create", edit: "/users/edit/:id", show: "/users/show/:id" }

Never:
- Import hooks from react-query directly in Refine resource components (use Refine wrappers).
- Bypass dataProvider with raw API calls inside resource pages.
- Use <Routes> outside of Refine's router integration.
