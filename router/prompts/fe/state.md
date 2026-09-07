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

Kanban / Trello Board Pattern:
- Domain types (from src/types/kanban or declared locally):
  type ColumnId = 'todo' | 'inProgress' | 'done';
  interface Task { id: string; title: string; columnId: ColumnId; description?: string; }
- Seed tasks with distinct columnId values so all columns start populated:
  const initialTasks: Task[] = [
    { id: '1', title: 'Research competitors', columnId: 'todo', description: 'Analyze market features' },
    { id: '2', title: 'Design board UI', columnId: 'inProgress', description: 'Tailwind components' },
    { id: '3', title: 'Setup Vite project', columnId: 'done', description: 'Initial scaffold' },
  ];
- Layout: Always render 3 distinct side-by-side columns in a horizontal grid:
  <div className="grid grid-cols-1 md:grid-cols-3 gap-6 p-6 max-w-7xl mx-auto">
- Complete native HTML5 Drag and Drop handlers:
  const handleDragStart = (e: React.DragEvent, taskId: string) => {
    e.dataTransfer.setData('text/plain', taskId);
  };
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
  };
  const handleDrop = (e: React.DragEvent, targetColumnId: ColumnId) => {
    e.preventDefault();
    const taskId = e.dataTransfer.getData('text/plain');
    if (taskId) {
      setTasks(prev => prev.map(t => t.id === taskId ? { ...t, columnId: targetColumnId } : t));
    }
  };
- On Card: draggable onDragStart={(e) => handleDragStart(e, task.id)}
- On Column container: onDragOver={handleDragOver} onDrop={(e) => handleDrop(e, column.id)}
- Component Rule: If you create a subcomponent file (e.g. KanbanColumn.tsx), import and use it. Do NOT re-declare function KanbanColumn inline in KanbanBoard.tsx.
- NEVER use @tanstack/react-table or table components for Kanban boards.

Never:
- Use Redux unless already in the project.
- Fetch data inside Zustand actions.
- Mix server state and client state in the same store.
- Use data tables for Kanban workflow boards.
