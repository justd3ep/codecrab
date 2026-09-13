## REST API Guidelines

Build standard RESTful Express APIs with clean separation of concerns and predictable JSON contracts.

### URL & Method Conventions
- Collections: `GET /api/<resources>` (list), `POST /api/<resources>` (create)
- Individual Items: `GET /api/<resources>/:id` (read), `PUT /api/<resources>/:id` (full update), `PATCH /api/<resources>/:id` (partial update), `DELETE /api/<resources>/:id` (remove)
- Nested Sub-resources: `GET /api/<resources>/:id/<subresources>` (e.g. `GET /api/products/:id/reviews`)
- Actions: `POST /api/<resources>/:id/<action>` (e.g. `POST /api/cart/checkout`)

### Standard Response Envelope
Always return JSON responses with a consistent envelope:
- Success:
  ```typescript
  res.status(200).json({ success: true, data: result });
  res.status(201).json({ success: true, data: createdItem });
  ```
- Failure:
  ```typescript
  res.status(400).json({ success: false, error: 'Validation failed: name is required' });
  res.status(404).json({ success: false, error: 'Resource not found' });
  res.status(500).json({ success: false, error: 'Internal server error' });
  ```

### HTTP Status Codes
- `200 OK`: Successful query or update.
- `201 Created`: Successful creation of a new resource.
- `204 No Content`: Successful deletion with empty response body.
- `400 Bad Request`: Missing or invalid input parameters.
- `404 Not Found`: Resource ID does not exist.
- `409 Conflict`: Duplicate entry or conflicting state.
- `500 Internal Server Error`: Unhandled server exception.

### Layer Separation
1. **Routes (`src/routes/<entity>.routes.ts`)**: Mount endpoints and map HTTP verbs to controller handler functions.
2. **Controllers (`src/controllers/<entity>.controller.ts`)**: Extract `req.params`, `req.query`, and `req.body`, call service methods, and return status codes with the response envelope.
3. **Services (`src/services/<entity>.service.ts`)**: Contain domain logic, validation checks, and data store queries.
4. **Models / Data (`src/models/<entity>.ts`)**: TypeScript interfaces and types for inputs, outputs, and storage entities.
