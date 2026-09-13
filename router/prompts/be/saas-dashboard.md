## SaaS Analytics & Billing Backend Domain Guidelines

Design and implement REST APIs for SaaS analytics dashboards, billing management, customer records, and transaction logs.

### Core Data Models
```typescript
export interface MetricSummary {
  totalRevenue: number;
  revenueTrend: number; // percentage, e.g. +12.5
  activeSubscriptions: number;
  subscriptionsTrend: number;
  churnRate: number; // percentage, e.g. 2.1
  churnTrend: number;
  pendingInvoicesCount: number;
  pendingInvoicesAmount: number;
}

export interface Invoice {
  id: string;
  invoiceNumber: string;
  customerName: string;
  customerEmail: string;
  amount: number;
  currency: string;
  status: 'paid' | 'pending' | 'failed' | 'refunded';
  dueDate: string;
  paidAt?: string;
  description: string;
  createdAt: string;
}

export interface Customer {
  id: string;
  name: string;
  email: string;
  company?: string;
  plan: 'starter' | 'pro' | 'enterprise';
  status: 'active' | 'past_due' | 'cancelled';
  spentTotal: number;
  createdAt: string;
}
```

### Standard Endpoints to Implement
1. **Metrics (`/api/metrics` or `/api/analytics`)**:
   - `GET /api/metrics/summary`: Returns current KPI metrics with trend indicators.
   - `GET /api/metrics/revenue-chart`: Monthly or weekly revenue breakdown for charts.
2. **Invoices / Transactions (`/api/invoices`)**:
   - `GET /api/invoices`: Paginated invoice list with query filtering by `status` (all/paid/pending/failed) and search query (`search` matching customerName or invoiceNumber).
   - `GET /api/invoices/:id`: Get single invoice details.
   - `POST /api/invoices`: Create new invoice (customerName, amount, status, dueDate, description).
   - `PATCH /api/invoices/:id`: Update invoice status or amount.
   - `DELETE /api/invoices/:id`: Delete or void an invoice.
3. **Customers (`/api/customers`)**:
   - `GET /api/customers`: Customer list with search and plan filters.
   - `GET /api/customers/:id`: Single customer with recent invoices.

### Calculations & Business Rules
- Recalculate metrics dynamically when invoices are created or updated.
- Seed 6-10 realistic transactions/invoices across different statuses (Paid, Pending, Failed) so the dashboard displays active data immediately.
