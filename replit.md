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
- `/admin/menu` — Menu management (add/edit/delete items, event stock, pricing tiers)
- `/admin/orders` — Catering order management (update status)
- `/admin/calendar` — Blackout date calendar
- `/admin/images` — Image library
- `/admin/event-settings` — Event passwords, Twilio SMS, shareable links, low-stock SMS alerts (recipient phone list + threshold)
- `/admin/event-history` — Event session log: create sessions, set active, view per-event order breakdowns, archive/delete
- `/admin/catering` — Advance catering inquiry management (client info, status pipeline, admin notes)

## API Routes (all at /api)

### Menu
- `GET /api/menu` — List available menu items
- `GET /api/menu/:id` — Get single item
- `GET /api/admin/menu` — List all (admin)
- `POST /api/admin/menu` — Create item
- `PUT /api/admin/menu/:id` — Update item
- `DELETE /api/admin/menu/:id` — Delete item

### Categories
- `GET /api/categories` — Public list of visible categories (ordered)
- `GET /api/admin/categories` — All categories with item counts
- `POST /api/admin/categories` — Create `{name, plannerGroup?, visible?}`
- `PATCH /api/admin/categories/:id` — Partial update; renames cascade to `menu_items.category` transactionally
- `DELETE /api/admin/categories/:id` — 409 if any items still use the category
- `POST /api/admin/categories/reorder` — Bulk `{items:[{id,sortOrder}]}`

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

### Shared Plans
- `POST /api/plan/share` — Create or update a shareable plan token (body: `{ sessionId, planName? }`)
- `GET /api/plan/share/:token` — Fetch a shared plan (touches expiry)
- `POST /api/plan/share/:token/items` — Add item to shared plan
- `DELETE /api/plan/share/:token/items/:itemId` — Remove item from shared plan
- `POST /api/plan/share/send-sms` — Send the share link via Twilio SMS

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

- `menu_items` — Menu items with price tiers, serving size, allergens, images, event stock
- `menu_categories` — First-class menu categories (id, name unique, sort_order, visible, planner_group: savory|sweet|entree|other). Joined to `menu_items` by name. Renames cascade transactionally. Backfilled from existing `menu_items.category` on startup.
- `blackout_dates` — Unavailable dates for events
- `cart_items` — Session-based shopping cart
- `plan_items` — Session-based event planning wishlist
- `shared_plans` — Shareable plan tokens (UUID, maps to session_id, expires 60 days from last use)
- `orders` — Customer catering orders with event details
- `order_items` — Individual items within an order
- `conversations` — OpenAI chat conversations
- `messages` — Chat message history
- `event_settings` — Singleton: event name, guest/kitchen passwords, Twilio from number, active event session ID, low-stock SMS alert recipient list (`low_stock_alert_phones text[]`) + threshold
- `event_sessions` — Named event sessions for order tracking (name, date, status: active/archived)
- `event_orders` — On-site event orders linked to an event session. Staff (POS) orders go through a payment-confirmation gate: created with `payment_status='unpaid'` (held off the kitchen feed, no SMS) and promoted via `PATCH /event-taker/orders/:id/payment` (cash/card/venmo) or `/override`. Atomic conditional updates prevent multi-device double-processing.
- `menu_items.low_stock_alert_sent` — Per-item flag tracking whether the kitchen has already been SMS-notified for the current low-stock crossing. Flipped to `true` atomically inside the order-placement transaction when `event_stock` first crosses to `<= event_settings.low_stock_alert_threshold`; reset to `false` when stock is restocked above the threshold (or set to null/unlimited / 0). One alert per crossing prevents SMS spam. SMS routed via the existing ejointech gateway in `artifacts/api-server/src/lib/sms.ts` and fanned out sequentially to every entry in `event_settings.low_stock_alert_phones` (per-recipient try/catch so a bad number can't block the rest).
- `catering_inquiries` — Advance catering bookings (client info, event date, status pipeline, notes)
- `images` — Uploaded image library

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
