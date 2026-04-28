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
- `/admin/social/hashtag-wall` — Instagram hashtag-wall moderation: approve/deny/blacklist candidate posts pulled by the IG poller, manage watched hashtags (max 5), wall display + auto-rules; sidebar shows pending badge

### Public (additional)
- `/gallery` — Public Instagram hashtag wall (uses approved candidates)

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

### Instagram Hashtag Wall
- `GET /api/instagram/wall` — Public: enabled flag, placement, handle, approved items (rate-limited via cached thumbnails)
- `GET /api/admin/instagram/badge` — Pending count since `instagramAdminLastVisitedAt` (sidebar badge)
- `POST /api/admin/instagram/visit` — Stamps `instagramAdminLastVisitedAt` (clears badge)
- `GET /api/admin/instagram/candidates?status=pending|approved|denied|all&limit=` — Moderation queue with counts
- `POST /api/admin/instagram/candidates/:id/decision` — Body `{ action: 'approve'|'deny'|'blacklist' }`
- `POST /api/admin/instagram/candidates/bulk-decision` — Body `{ ids:number[], action }`
- `POST /api/admin/instagram/poller/run-now` — Manually trigger one poll cycle (admin-only)
- `GET /api/admin/instagram/status` — Settings + poller stats (last polled, pulled-24h, pending count)
- `PUT /api/admin/instagram/settings` — Save instagramHandle, hashtags (max 5), wall display, auto-rules

Required env vars: `INSTAGRAM_ACCESS_TOKEN` + `INSTAGRAM_USER_ID` (Meta Graph API). Poller no-ops when missing; admin moderation page shows configuration banner. Background scheduler runs every 30 min (poll) + daily (cleanup unavailable posts).

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
- `event_orders` — On-site event orders linked to an event session. Staff (POS) orders go through a payment-confirmation gate: created with `payment_status='unpaid'` (held off the kitchen feed, no SMS) and promoted via `PATCH /event-taker/orders/:id/payment` (cash/card/venmo) or `/override`. Atomic conditional updates prevent multi-device double-processing. Optional `plate_groups` jsonb (set by staff in the POS payment modal via `PATCH /event-taker/orders/:id/plate-groups` while still unpaid) splits the cart into N plates with whole-number quantities; the kitchen ticket renders Fire totals plus per-plate cards (and an "Unassigned" group for unallocated units). Locked once the order leaves the unpaid queue. Per-plate / per-line packing progress lives in `kitchen_progress` jsonb (`{plates:[{items:[{itemId,quantity,packed}]}], unassigned:[…]}`) — populated lazily as the cook taps lines on the kitchen display via `PATCH /event-ordering/orders/:id/kitchen-progress` (single-line `{plateIdx,itemId,packed}` or whole-plate `{plateIdx,allPacked}`; `plateIdx:"unassigned"` for unallocated units). The endpoint runs inside a row-locked transaction (`SELECT … FOR UPDATE`), refuses updates with HTTP 409 once the order leaves the active queue (status not in `pending`/`preparing`), and auto-advances `preparing → ready` (stamping `ready_at` + firing the existing SMS) the same transaction once every line is fully packed. Backward status transitions (`preparing → pending` on the Preparing card's Undo, `ready → preparing` on a plated Ready card's new Undo) clear `kitchen_progress` so re-cooking starts from a clean slate. The kitchen display also auto-collapses Fire totals to a single header once everything is checked, with a tap-to-expand affordance.
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

## SMS Gateway (ejointech / GoIP)

Outbound SMS, owner alerts, and the customer chat poller all go through one ejointech / GoIP-class HTTP gateway. Required env: `EJOIN_GATEWAY_URL` (web UI base URL, **not** the SMS API), `EJOIN_USER`/`EJOIN_PASS` (sendsms HTTP basic creds), `EJOIN_ADMIN_USER`/`EJOIN_ADMIN_PASS` (web admin creds used for inbound polling + backfill).

The gateway session cookie is cached process-wide so every send and every poll cycle reuses the same login. Without caching, the inbound poller (3s cadence whenever a customer chat port is set) generates ~20 logins/min around the clock, which trips the GoIP firmware's login-form rate-limit (HTTP 503 "Server Busy" for several minutes at a time) and breaks every SMS feature in the app. With caching, the gateway only sees one login per session window. When the gateway invalidates the session (idle timeout, reboot, password rotation), the next request transparently re-authenticates once before surfacing the error.

Optional firmware-compatibility overrides — only set these if the defaults don't match your gateway's HTML pages:
- `EJOIN_LOGIN_PATH` — login form path. Tried in order: this override, `login_en.html`, `login.html`, `index_en.html`, `index.html`. The login GET is automatically retried once on transient 503 / network errors before being recorded as failed.
- `EJOIN_SMS_INBOX_PATH` — inbound SMS list path. Tried in order: this override, `goip_sms_inbox_en.html`, `goip_sms_recv_en.html`, `goip_sms_inbox.html`.
- `EJOIN_SESSION_TTL_SECONDS` — how long the cached session cookie is reused before forcing a re-login. Default `600` (10 min). Tighten if your firmware's idle timeout is shorter than that.

If "Run backfill now" on the SMS Settings page errors out, the surfaced message lists every login path that was tried with the cookies + status received from the gateway — that points directly at which path/cookie name your firmware uses.

### Testing the inbound SMS pipeline

When inbound texts aren't appearing in the catering inquiry chat modal or in the Unmatched inbox, walk through this procedure end-to-end. Each step is calibrated to a different failure mode and the api-server log + the diagnostics endpoint together tell you which one you hit.

1. **Set the chat port.** Open Admin → SMS Settings → Customer Chat Port and pick the SIM port that customers text. Save. With no chat port set, the live poller silently no-ops every cycle and "Run backfill now" returns a 400 explaining which setting to fix. Both inbound paths are dormant until this is set.
2. **Hit the diagnostics endpoint.** `GET /api/admin/messages/inbound-diagnostics` (admin auth) returns a JSON snapshot: which inbox path the gateway answered on, the HTTP status, the body size, the first ~400 chars of the body, whether the gateway returned the login form (stale session), the parsed row count, the per-port row count, and the first 5 parsed rows each annotated with what the ingest pipeline would do with them. The annotation `kind` mirrors `ingestInbound`'s gating decisions exactly, so reading the diagnostics is equivalent to dry-running ingest on the gateway's current inbox. Possible kinds: `matched-inquiry` (would store + attach to inquiry id N), `unmatched` (would land in the Unmatched inbox), `stop-keyword` (would opt-out the sender), `admin-blocked` (sender is admin-blocked), `owner-reply-relay-eligible` (owner phone, valid `#<id>` tag, customer phone on file → would relay), `owner-reply-malformed` (owner phone, missing/bad tag or STOP), `owner-reply-disabled` (owner phone but Owner Reply is off), `owner-reply-no-inquiry` (tag points at a missing inquiry), `owner-reply-no-phone` (matched inquiry has no `clientPhone`), `skipped-empty` (empty body or unparseable from-number). If `parsedRowCount` is 0 but `bodyBytes` is non-zero, the parser is dropping every row and `bodyHead` will tell you why. If `loginPageDetected` is true after a retry, the gateway is rejecting the session. If `fetchError` is non-null and `httpStatus` is null, the gateway is unreachable or login itself failed (the endpoint never throws — login + network errors come back here as structured fields rather than HTTP 500). If `httpStatus` is set but `successPath` is null, every candidate path returned a hard HTTP error (e.g. 404 / 500) — `httpStatus` will be the last status seen, which usually points at the wrong `EJOIN_SMS_INBOX_PATH`.
3. **Run backfill.** Click "Run backfill now" on the SMS Settings page. The api-server log will emit one `[ejoin] inbound fetch` line per fetch and one `[sms-inbox] ingest` line per message ingested with `status` (stored / dedup / opted-out / blocked / owner-reply-relayed / owner-reply-rejected / skipped-empty), `inquiryId` (matched id or null), and `gid` (gateway message id). Copy the gid into the diagnostics endpoint's `sampleRows` to compare what backfill saw vs. what the gateway is currently serving.
4. **Send the four scripted test messages** from real handsets (or any known phones) and watch the log + the UI:
   - From a phone whose digits match an existing catering inquiry's `clientPhone` (after stripping a leading "1" for NANP), text any short message → expect the chat bubble to appear in that inquiry's messages modal within ~3s, and the log to show `status:"stored"` with the matched `inquiryId`.
   - From a phone that doesn't match any inquiry, text any short message → expect the row to land at `/admin/messages/unmatched`, and the log to show `status:"stored"` with `inquiryId:null`.
   - From the configured owner phone WITH the `#<id> body` tag (e.g. `#42 we'll bring extra trays`), text the relay → expect a customer-bound SMS to inquiry #42's client phone, and the log to show `status:"owner-reply-relayed"` with `inquiryId:42`. Requires Owner Reply enabled.
   - From the configured owner phone WITHOUT the `#<id>` tag, text any message → expect the owner phone to receive a corrective text ("Use this format: #<inquiryId> <message>") and the log to show `status:"owner-reply-rejected"` with `rejectReason:"owner-reply-malformed"`. The body is NOT stored and does NOT pollute Unmatched.
5. **Text STOP** from any phone you control. Expect the sender's digits to be added to the phone blocklist with reason `customer-opt-out`, the inbound to still be stored (so the chat thread shows the opt-out event), and the log to show `status:"opted-out"`. Subsequent outbound to that number is blocked at the send boundary.

If a step's expected log line never appears, the failure is at that stage. If the diagnostics endpoint shows the gateway has rows the log isn't seeing, the live poller is wedged and the page should be reloaded after a workflow restart. The diagnostics endpoint never writes anything, so it's safe to hit repeatedly while debugging.
