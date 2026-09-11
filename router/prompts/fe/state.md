State Management Guidelines:
- Use Zustand for global client state (auth user, UI state, theme).
- Use TanStack Query for server state (fetched data, cache, mutations).
- Do NOT use both Zustand and React Context for the same state.
- Keep stores small and focused. One store per domain.
- Type all store slices with interfaces.

Zustand pattern:
interface AuthStore { user: User | null; setUser: (u: User | null) => void; }
const useAuthStore = create<AuthStore>((set) => ({ user: null, setUser: (user) => set({ user }) }));

TanStack Query pattern:
const { data, isLoading, error } = useQuery({ queryKey: ['users'], queryFn: fetchUsers });

Never:
- Use Redux unless already in the project.
- Fetch data inside Zustand actions.
- Mix server state and client state in the same store.
