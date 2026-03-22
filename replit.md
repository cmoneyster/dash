# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Full-stack catering business website with AI chat agent, menu management, cart/ordering, and admin dashboard.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)
- **Frontend**: React + Vite + Tailwind CSS + shadcn/ui
- **AI**: OpenAI via Replit AI Integrations (no user API key needed)

## Structure

```text
artifacts-monorepo/
├── artifacts/
│   ├── api-server/         # Express API server (all backend routes)
│   └── catering-web/       # React + Vite catering website (customer + admin)
├── lib/
│   ├── api-spec/           # OpenAPI spec + Orval codegen config
│   ├── api-client-react/   # Generated React Query hooks
│   ├── api-zod/            # Generated Zod schemas from OpenAPI
│   ├── db/                 # Drizzle ORM schema + DB connection
│   ├── integrations-openai-ai-server/  # OpenAI server-side integration
│   └── integrations-openai-ai-react/   # OpenAI React hooks
├── scripts/                # Utility scripts
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── tsconfig.json
└── package.json
```

## Application Pages

### Customer-facing (catering-web at /)
- `/` — Home page with AI chat widget + hero section
- `/menu` — Menu browsing with category filter, add to cart/plan
- `/cart` — Cart with checkout form
- `/plan` — Saved wishlist / event planning list
- `/confirmation` — Order confirmation page

### Admin (at /admin)
- `/admin` — Dashboard with stats and recent orders
- `/admin/menu` — Menu management (add/edit/delete items)
- `/admin/orders` — Order management (update status)
- `/admin/calendar` — Blackout date calendar

## API Routes (all at /api)

### Menu
- `GET /api/menu` — List available menu items
- `GET /api/menu/:id` — Get single item
- `GET /api/admin/menu` — List all (admin)
- `POST /api/admin/menu` — Create item
- `PUT /api/admin/menu/:id` — Update item
- `DELETE /api/admin/menu/:id` — Delete item

### Events/Availability
- `GET /api/events/availability?startDate=&endDate=` — Check date availability
- `GET /api/admin/blackout-dates` — List blackout dates
- `POST /api/admin/blackout-dates` — Add blackout date
- `DELETE /api/admin/blackout-dates/:id` — Remove blackout date

### Cart & Plan
- `GET /api/cart?sessionId=` — Get cart
- `POST /api/cart` — Add to cart
- `PUT /api/cart/:itemId` — Update quantity
- `DELETE /api/cart/:itemId` — Remove from cart
- `GET /api/plan?sessionId=` — Get plan
- `POST /api/plan` — Add to plan
- `DELETE /api/plan/:itemId` — Remove from plan

### Orders
- `POST /api/orders` — Place order (checkout)
- `GET /api/admin/orders` — List all orders
- `PUT /api/admin/orders/:id` — Update order status

### AI Chat
- `POST /api/chat/message` — SSE streaming AI chat response
- `POST /api/chat/suggest-items` — AI menu item suggestions

### Admin
- `GET /api/admin/stats` — Dashboard statistics

## Database Tables

- `menu_items` — Menu items with price, serving size, allergens, images
- `blackout_dates` — Unavailable dates for events
- `cart_items` — Session-based shopping cart
- `plan_items` — Session-based event planning wishlist
- `orders` — Customer orders with event details
- `order_items` — Individual items within an order
- `conversations` — OpenAI chat conversations
- `messages` — Chat message history

## Key Commands

- `pnpm --filter @workspace/api-server run dev` — Start API server
- `pnpm --filter @workspace/catering-web run dev` — Start frontend
- `pnpm --filter @workspace/api-spec run codegen` — Regenerate API client from spec
- `pnpm --filter @workspace/db run push` — Push DB schema changes

## AI Integration

Uses Replit AI Integrations for OpenAI (no user API key needed). Env vars auto-configured:
- `AI_INTEGRATIONS_OPENAI_BASE_URL`
- `AI_INTEGRATIONS_OPENAI_API_KEY`

The chat agent (`/api/chat/message`) is a streaming SSE endpoint that helps customers plan their event or navigate the menu.
