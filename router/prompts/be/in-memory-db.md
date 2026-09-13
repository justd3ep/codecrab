## In-Memory Database Pattern

When no external database (such as PostgreSQL, MySQL, MongoDB, or Prisma) is installed in `package.json`, implement self-contained, typed in-memory storage.

### Core Rules
1. **CRITICAL BOUNDARY**: Do NOT import `mongoose`, `prisma`, `typeorm`, `sequelize`, or database drivers unless they exist in `package.json`.
2. Store data in a module-level `Map<string, Entity>` or array inside the service or a shared database file.
3. Pre-seed the store with 3-5 realistic mock records so endpoints return rich data immediately on first run.
4. Generate unique IDs using `Date.now().toString(36) + Math.random().toString(36).substring(2, 7)`.
5. Keep methods async (`Promise<Entity>`) to simulate real async persistence and match standard service signatures.

### Standard Pattern
```typescript
import { Product, CreateProductInput, UpdateProductInput } from '../models/products';

// Pre-seeded in-memory store
const productsStore = new Map<string, Product>();

// Seed sample data on initialization
function seedInitialData(): void {
  if (productsStore.size > 0) return;
  const initial: Product[] = [
    {
      id: 'prod_1',
      name: 'Classic Linen Overshirt',
      description: 'Relaxed fit overshirt crafted from 100% breathable organic linen.',
      price: 89.0,
      rating: 4.8,
      reviewsCount: 42,
      category: 'Clothing',
      sizes: ['S', 'M', 'L', 'XL'],
      colors: ['Sage', 'Oatmeal', 'Navy'],
      images: ['/images/linen-shirt-1.jpg', '/images/linen-shirt-2.jpg'],
      inStock: true,
      stockQuantity: 25,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    {
      id: 'prod_2',
      name: 'Structured Cotton Chino',
      description: 'Tailored casual trousers made from durable stretch-twill cotton.',
      price: 110.0,
      rating: 4.6,
      reviewsCount: 19,
      category: 'Clothing',
      sizes: ['30', '32', '34'],
      colors: ['Khaki', 'Olive', 'Charcoal'],
      images: ['/images/chino-1.jpg'],
      inStock: true,
      stockQuantity: 14,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  ];
  for (const item of initial) {
    productsStore.set(item.id, item);
  }
}

seedInitialData();

export async function findAll(): Promise<Product[]> {
  return Array.from(productsStore.values());
}

export async function findById(id: string): Promise<Product | null> {
  return productsStore.get(id) || null;
}

export async function create(input: CreateProductInput): Promise<Product> {
  const id = 'prod_' + Date.now().toString(36) + Math.random().toString(36).substring(2, 6);
  const now = new Date().toISOString();
  const product: Product = {
    ...input,
    id,
    createdAt: now,
    updatedAt: now,
  };
  productsStore.set(id, product);
  return product;
}

export async function update(id: string, input: UpdateProductInput): Promise<Product | null> {
  const existing = productsStore.get(id);
  if (!existing) return null;
  const updated: Product = {
    ...existing,
    ...input,
    updatedAt: new Date().toISOString(),
  };
  productsStore.set(id, updated);
  return updated;
}

export async function remove(id: string): Promise<boolean> {
  return productsStore.delete(id);
}
```
