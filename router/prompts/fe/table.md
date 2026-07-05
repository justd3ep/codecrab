Table Guidelines:
- Use TanStack Table (react-table v8) for complex data grids.
- For Refine projects, use the built-in useTable hook.
- Type column definitions with ColumnDef<TData>.
- Implement server-side pagination, sorting, and filtering where data is large.
- Handle loading and empty states explicitly.
- Use memo for cell renderers to avoid unnecessary re-renders.

Pattern:
const columns: ColumnDef<User>[] = [
  { accessorKey: 'name', header: 'Name' },
  { accessorKey: 'email', header: 'Email' },
];
const table = useReactTable({ data, columns, getCoreRowModel: getCoreRowModel() });

Never:
- Render raw HTML tables without TanStack Table for complex grids.
- Fetch all pages at once for large datasets.
