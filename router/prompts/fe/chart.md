Chart Guidelines:
- Use Recharts as the default charting library for React projects.
- For Refine projects, check if @refinedev/recharts or similar is available.
- Always type chart data arrays with interfaces.
- Wrap charts in a ResponsiveContainer for fluid sizing.
- Handle loading and empty data states.

Pattern:
<ResponsiveContainer width="100%" height={300}>
  <BarChart data={data}>
    <CartesianGrid strokeDasharray="3 3" />
    <XAxis dataKey="name" />
    <YAxis />
    <Tooltip />
    <Bar dataKey="value" fill="#8884d8" />
  </BarChart>
</ResponsiveContainer>

Never:
- Use Chart.js in a React/Vite project (use Recharts).
- Render charts without a ResponsiveContainer.
