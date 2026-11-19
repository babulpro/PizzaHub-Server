# 🍕 PizzaHub Backend API

> Production-grade RESTful API for **PizzaHub** — A full-stack multi-vendor pizza ordering and subscription management platform built with Node.js, Express, native MongoDB driver, and Stripe.

---

## 🚀 Tech Stack

- **Runtime:** Node.js (ES Modules, `type: "module"`)
- **Framework:** Express.js (v4.21)
- **Database:** MongoDB Atlas via official Native Driver (`mongodb` v6.12) — *No ORM/Mongoose*
- **Authentication:** JSON Web Tokens (`jsonwebtoken` v9) with Role-Based Access Control (RBAC)
- **Payments:** Stripe Checkout & Webhooks (`stripe` v17)
- **Environment & Security:** `dotenv`, `cors`, raw body parsing for webhook verification

---

## 🗄️ Database Architecture (4 Collections)

### 1. `users`
Stores user identities across three roles: `customer`, `vendor`, and `admin`.
```json
{
  "_id": "ObjectId",
  "name": "Mario Rossi",
  "email": "mario@pizzahub.com",
  "role": "vendor",
  "businessName": "Napoli Artisan Kitchen",
  "subscriptionPlan": "premium",
  "subscriptionExpiresAt": "2026-12-19T18:00:00.000Z",
  "isBlocked": false,
  "createdAt": "2026-11-19T12:00:00.000Z"
}
```

### 2. `menuItems`
Stores pizza items created by vendors.
- **Status Lifecycle:** `pending` ➔ `approved` / `rejected` (by Admin) ➔ `inactive` (toggled by Vendor).
- **Business Rule:** Vendors on the Free plan can have a maximum of **3 active/pending items**. Premium vendors have unlimited items.
```json
{
  "_id": "ObjectId",
  "vendorId": "ObjectId",
  "itemName": "Truffle Mushroom Pizza",
  "category": "Gourmet Pizzas",
  "description": "Wild porcini, fontina cheese, white truffle oil.",
  "price": 24.5,
  "location": "Manhattan, NY",
  "images": ["https://images.unsplash.com/..."],
  "prepTime": "20-25 min",
  "isSpicy": false,
  "isVegetarian": true,
  "status": "approved",
  "createdAt": "2026-11-19T12:00:00.000Z"
}
```

### 3. `orders`
Stores customer orders with kitchen fulfillment status and timeline events.
- **Status Lifecycle:** `pending` ➔ `accepted` / `rejected` (by Vendor) OR `cancelled` (by Customer prior to acceptance).
- **Security Rule:** Customers cannot order items from their own vendor store; admins cannot place customer orders.
```json
{
  "_id": "ObjectId",
  "itemId": "ObjectId",
  "vendorId": "ObjectId",
  "customerId": "ObjectId",
  "deliveryDate": "2026-11-20",
  "deliveryAddress": "123 Broadway, New York, NY",
  "message": "Extra napkins please",
  "totalPrice": 24.5,
  "status": "pending",
  "timeline": [
    {
      "status": "pending",
      "label": "Order Placed",
      "timestamp": "2026-11-19T12:00:00.000Z",
      "note": "Order submitted to restaurant kitchen."
    }
  ],
  "createdAt": "2026-11-19T12:00:00.000Z"
}
```

### 4. `transactions`
Immutable financial ledger for subscription payments.
- **Rule:** Read-only via API (`GET` only). No `PUT`, `PATCH`, or `DELETE` endpoints exist. Written strictly by verified Stripe events.
```json
{
  "_id": "ObjectId",
  "vendorId": "ObjectId",
  "plan": "premium",
  "amount": 29.0,
  "currency": "USD",
  "stripeSessionId": "cs_test_...",
  "stripeSubscriptionId": "sub_...",
  "status": "completed",
  "createdAt": "2026-11-19T12:00:00.000Z"
}
```

---

## 📡 API Endpoints Reference

### 🔐 Authentication (`/api/auth`)
| Method | Endpoint | Access | Description |
| :--- | :--- | :--- | :--- |
| `POST` | `/api/auth/token` | Public | Generates a JWT token for testing/demo users. |
| `GET` | `/api/auth/me` | Protected | Verifies the Bearer token and returns the logged-in user profile. |
| `GET` | `/api/auth/admin-only` | Admin | Validates admin role enforcement. |

### 🍕 Menu Items (`/api/menu`)
| Method | Endpoint | Access | Description |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/menu` | Public | Browse approved items with `?search=`, `?category=`, `?location=`, and `?sortBy=price_asc\|price_desc`. Prioritizes Premium vendors. |
| `GET` | `/api/menu/:id` | Public | Single item detail with vendor information. |
| `POST` | `/api/menu` | Vendor | Add new pizza (enforces free plan max 3 active items limit). |
| `GET` | `/api/menu/vendor/my-items`| Vendor | View own created menu items. |
| `PATCH`| `/api/menu/:id` | Vendor | Update own item details (price, description, images, etc.). |
| `PATCH`| `/api/menu/:id/toggle` | Vendor | Toggle availability (`approved` ↔ `inactive`). |
| `DELETE`| `/api/menu/:id` | Vendor | Permanently delete own menu item. |
| `GET` | `/api/menu/admin/all` | Admin | View all menu items across all vendors with filter. |
| `PATCH`| `/api/menu/admin/:id/status`| Admin | Approve (`approved`) or reject (`rejected`) an item. |
| `DELETE`| `/api/menu/admin/:id` | Admin | Remove inappropriate or non-compliant item. |

### 📦 Orders (`/api/orders`)
| Method | Endpoint | Access | Description |
| :--- | :--- | :--- | :--- |
| `POST` | `/api/orders` | Customer | Place an order. Prevents duplicate active orders for same date. |
| `GET` | `/api/orders/my-orders` | Customer | View customer order history with item and vendor details. |
| `PATCH`| `/api/orders/:id/cancel` | Customer | Cancel a pending order before vendor acceptance. |
| `GET` | `/api/orders/vendor/my-orders`| Vendor | View incoming orders for the vendor's restaurant. |
| `PATCH`| `/api/orders/:id/status` | Vendor | Accept (`accepted`) or reject (`rejected`) an order (once). |
| `GET` | `/api/orders/:id` | Customer / Vendor / Admin | View order details and full timeline history. |
| `GET` | `/api/orders/admin/all` | Admin | View all platform orders with customer and vendor lookups. |

### 💳 Stripe & Subscriptions (`/api/stripe`)
| Method | Endpoint | Access | Description |
| :--- | :--- | :--- | :--- |
| `POST` | `/api/stripe/create-checkout-session` | Vendor | Creates a Stripe Checkout Session for $29.00/mo Premium plan. |
| `POST` | `/api/stripe/webhook` | Stripe | Webhook listener verifying cryptographic Stripe signatures (`stripe-signature`). |
| `GET` | `/api/stripe/verify-session/:sessionId` | Protected | Direct checkout verification on redirect; upgrades user to Premium immediately. |
| `POST` | `/api/stripe/simulate-webhook` | Vendor / Admin | Development simulation endpoint for local testing. |

### 👤 Users & Administration (`/api/users`)
| Method | Endpoint | Access | Description |
| :--- | :--- | :--- | :--- |
| `PATCH`| `/api/users/profile` | Customer / Vendor | Update profile name, image, phone, address, businessName. |
| `GET` | `/api/users` | Admin | View all users with `?search=` and `?role=` filters. |
| `GET` | `/api/users/:id` | Admin | View single user details. |
| `PATCH`| `/api/users/:id/block` | Admin | Block / unblock a user (blocked users receive 403 on protected routes). |

### 📊 Transactions (`/api/transactions`)
| Method | Endpoint | Access | Description |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/transactions` | Admin | View complete platform financial ledger with total revenue calculation. |
| `GET` | `/api/transactions/my-transactions` | Vendor | View own past payment receipts and subscription invoices. |

---

## ⚙️ Environment Variables

Create a `.env` file in the root directory:

```env
PORT=5000
NODE_ENV=development
CLIENT_URL=http://localhost:3000

# MongoDB Atlas
MONGODB_URI=mongodb+srv://<username>:<password>@cluster.mongodb.net/?retryWrites=true&w=majority
DB_NAME=PizzaHub

# JWT Configuration
JWT_SECRET=your_jwt_secret_key_here
JWT_EXPIRES_IN=7d

# Stripe
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
```

---

## 🛠️ Installation & Setup

1. **Clone repository:**
   ```bash
   git clone https://github.com/babulpro/PizzaHub-Server.git
   cd PizzaHub-Server
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Configure environment:**
   ```bash
   cp .env.example .env
   # Update MONGODB_URI, JWT_SECRET, and STRIPE_SECRET_KEY in .env
   ```

4. **Start the development server:**
   ```bash
   npm run dev
   ```
   Server will run at `http://localhost:5000`.

5. **Test server health:**
   ```bash
   curl http://localhost:5000/api/health
   ```

---

## 🔒 Security Highlights

- **Native MongoDB Driver:** Uses parameterized object queries (`new ObjectId(id)`) to prevent NoSQL injection.
- **JWT Protection:** `verifyToken` middleware decrypts tokens, validates expiration, checks `isBlocked` flag in the database, and strips password hashes (`{ projection: { password: 0 } }`).
- **Role Guard:** `verifyRole('admin')` or `verifyRole('vendor', 'admin')` strictly restricts endpoint access.
- **Idempotency:** Stripe webhook and session verification verify `stripeSessionId` uniqueness to prevent duplicate transaction entries.
- **Raw Body Buffer:** Captures raw byte buffer `req.rawBody` for cryptographic signature validation using `stripe.webhooks.constructEvent()`.

---

## 📄 License
ISC © PizzaHub
