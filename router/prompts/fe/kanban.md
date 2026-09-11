Kanban / Trello Board Guidelines:
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
- Use data tables for Kanban workflow boards.
