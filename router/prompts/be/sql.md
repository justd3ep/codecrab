SQL GUIDELINES
1. Never concatenate user input directly into SQL queries. Always use parameterized queries or an ORM/Query Builder to prevent SQL injection.
2. Ensure queries are efficient and index-aware where possible.
3. Handle database connection errors and query failures gracefully.
