Chart Guidelines:
- Default to clean, responsive SVG or Tailwind CSS progress bars, stat bars, and mini-charts for self-contained components.
- ONLY import Recharts if "recharts" is explicitly confirmed in package.json dependencies.
- Always type chart data arrays with interfaces.
- For Tailwind/SVG charts: use relative/absolute containers with fluid flex or grid sizing.
- Handle loading and empty data states cleanly.

Pattern (Self-contained Tailwind/SVG Bar):
interface MetricData {
  label: string;
  value: number;
  percentage: number;
}
<div className="w-full flex items-end gap-2 h-40 pt-4">
  {data.map((item, idx) => (
    <div key={idx} className="flex-1 flex flex-col items-center gap-1 h-full justify-end">
      <div className="w-full bg-indigo-500 rounded-t transition-all" style={{ height: `${item.percentage}%` }} />
      <span className="text-xs text-gray-500">{item.label}</span>
    </div>
  ))}
</div>

Never:
- Import recharts or Chart.js unless "recharts" is present in package.json.
- Render charts without responsive parent sizing.
