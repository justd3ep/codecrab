## E-Commerce Backend Domain Guidelines

Design and implement complete REST APIs for e-commerce stores, product catalogs, shopping carts, and checkout flows.

### Core Data Models
Always define clear, strongly-typed TypeScript interfaces:

```typescript
export interface ProductVariant {
  id: string;
  size: string;
  color: string;
  sku: string;
  priceModifier?: number;
  stock: number;
}

export interface Product {
  id: string;
  name: string;
  description: string;
  price: number;
  originalPrice?: number;
  rating: number;
  reviewsCount: number;
  images: string[];
  category: string;
  sizes: string[];
  colors: string[];
  variants?: ProductVariant[];
  inStock: boolean;
  stockQuantity: number;
  tags?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface CartItem {
  id: string;
  productId: string;
  product?: Product;
  name: string;
  price: number;
  quantity: number;
  size?: string;
  color?: string;
  image?: string;
}

export interface Cart {
  id: string;
  items: CartItem[];
  itemCount: number;
  subtotal: number;
  tax: number;
  shipping: number;
  total: number;
}

export interface OrderItem {
  productId: string;
  quantity: number;
  unitPrice: number;
  size?: string;
  color?: string;
}

export interface Order {
  id: string;
  customerEmail: string;
  customerName: string;
  items: OrderItem[];
  subtotal: number;
  shippingFee: number;
  total: number;
  status: 'pending' | 'processing' | 'completed' | 'cancelled';
  shippingAddress?: {
    street: string;
    city: string;
    postalCode: string;
    country: string;
  };
  createdAt: string;
}
```

### Standard Endpoints to Implement
1. **Products (`/api/products`)**:
   - `GET /api/products`: List products with query filters (`category`, `search`, `minPrice`, `maxPrice`, `sort`).
   - `GET /api/products/:id`: Get single product by ID with full details.
   - `GET /api/products/related`: Get related/recommended products by category or tag.
2. **Cart (`/api/cart`)**:
   - `GET /api/cart`: Return the current active cart with calculated subtotal and totals.
   - `POST /api/cart/items`: Add item to cart with quantity, size, and color. Increment quantity if item already exists.
   - `PATCH /api/cart/items/:id`: Update item quantity (or remove if quantity <= 0).
   - `DELETE /api/cart/items/:id`: Remove specific item from cart.
   - `DELETE /api/cart`: Clear entire cart.
3. **Checkout & Orders (`/api/orders` or `/api/checkout`)**:
   - `POST /api/checkout`: Process order from cart, validate stock availability, generate order ID, clear cart, and return confirmation.

### Calculations & Business Rules
- Calculate subtotal dynamically: `items.reduce((sum, item) => sum + item.price * item.quantity, 0)`.
- Apply sensible tax (e.g. 8%) and shipping (e.g. free if subtotal > $100, else $10).
- Round monetary values to 2 decimal places: `Number(val.toFixed(2))`.
- Seed 4-6 high quality fashion/apparel items with realistic titles, prices, descriptions, and mock image URLs so the frontend displays polished data immediately.
