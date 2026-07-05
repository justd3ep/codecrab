API Client Guidelines:
- Use axios with a typed instance in src/lib/api.ts or src/api/client.ts.
- Create one base instance with baseURL and headers.
- Type all request and response payloads with interfaces.
- Use TanStack Query (react-query) for GET requests: useQuery.
- Use useMutation for POST/PUT/DELETE.
- Never use raw fetch() unless axios is not installed.
- Never use any for API response types.
- Handle 401 with an axios interceptor. Do not handle per-call.

Example:
const api = axios.create({ baseURL: import.meta.env.VITE_API_URL });
export const loginUser = (data: LoginDto): Promise<AuthResponse> => api.post('/auth/login', data).then(r => r.data);

Never:
- Hardcode base URLs as strings in component files.
- Ignore error states from useQuery/useMutation.
- Import axios in component files directly.
