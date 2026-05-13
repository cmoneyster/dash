# Catering Website with AI Chat

This application is a full-stack catering business website that offers online ordering, menu management, an AI chat agent for customer interaction, and an admin dashboard.

## Run & Operate

- **Start API server:** `pnpm --filter @workspace/api-server run dev`
- **Start frontend:** `pnpm --filter @workspace/catering-web run dev`
- **Regenerate API client:** `pnpm --filter @workspace/api-spec run codegen`
- **Push DB schema changes:** `pnpm --filter @workspace/db run push`

**Required Environment Variables:**
- `AI_INTEGRATIONS_OPENAI_BASE_URL` (for Replit AI)
- `AI_INTEGRATIONS_OPENAI_API_KEY` (for Replit AI)
- `INSTAGRAM_ACCESS_TOKEN`
- `INSTAGRAM_USER_ID`
- `EJOIN_GATEWAY_URL`
- `EJOIN_USER`, `EJOIN_PASS`
- `EJOIN_ADMIN_USER`, `EJOIN_ADMIN_PASS`
- `SMS_OUTBOUND_MODE`: `live` (default) | `shadow`
- `SMS_WEBHOOK_SECRET` (for EJOIN inbound push mode)
- Optional: `EJOIN_LOGIN_PATH`, `EJOIN_SMS_INBOX_PATH`, `EJOIN_SESSION_TTL_SECONDS`, `EJOIN_GATEWAY_TZ`, `EJOIN_INBOUND_MODE`

## Stack

- **Monorepo:** pnpm workspaces
- **Node.js:** 24
- **TypeScript:** 5.9
- **API:** Express 5
- **Database:** PostgreSQL + Drizzle ORM
- **Validation:** Zod (`zod/v4`), `drizzle-zod`
- **API Codegen:** Orval (from OpenAPI spec)
- **Build:** esbuild
- **Frontend:** React + Vite + Tailwind CSS + shadcn/ui
- **AI:** OpenAI via Replit AI Integrations

## Where things live

- `/artifacts/api-server`: Express API server (all backend routes)
- `/artifacts/catering-web`: React + Vite frontend (customer and admin interfaces)
- `/lib/api-spec`: OpenAPI specification and Orval codegen configuration
- `/lib/db`: Drizzle ORM schema and database connection
- `/lib/integrations-openai-ai-server`: Server-side OpenAI integration
- `/lib/integrations-openai-ai-react`: React hooks for OpenAI integration
- `drizzle.config.ts`: Drizzle ORM configuration and schema source-of-truth.
- `lib/api-spec/openapi.yaml`: OpenAPI specification for API contracts.

## Architecture decisions

- **Monorepo Structure:** Uses pnpm workspaces to manage multiple packages (frontend, backend, shared libraries) within a single repository, streamlining dependency management and code sharing.
- **AI Integration via Replit:** Leverages Replit AI Integrations for OpenAI, abstracting API key management and simplifying AI feature development.
- **SMS Gateway for Reliability:** Implements a sophisticated SMS gateway integration with session caching and dual-environment safety (`SMS_OUTBOUND_MODE`) to handle physical SIM interactions reliably across development and production, mitigating issues like rate-limiting and duplicate sends.
- **CloudPRNT for Printing:** Utilizes Star CloudPRNT for network printing, enabling printers to poll the server over HTTPS, eliminating the need for complex network configurations.
- **Per-Surface Printer Policy:** Admin (`/admin/printers`) is the canonical source of truth for all printer settings. Each surface reads/writes a scoped subset of toggles via its own endpoint, and the server-side `ALLOWED_KINDS_BY_SOURCE` matrix in `printFanout.ts` enforces which job kinds each surface may enqueue — Staff Order Taker (kitchen ticket + customer receipt), Kitchen Display / Guest Ordering (kitchen ticket + item/plate labels). Browser auto-print has been retired; the `PrinterSettingsModal` component (shared by Kitchen Display and Staff Order Taker) provides an embedded, surface-scoped settings UI backed by `/api/event-ordering/printers` and `/api/event-taker/printers` respectively.
- **Square Invoice Tax:** Catering sales tax is configured in Event Settings (`cateringTaxEnabled` / `cateringTaxRate` on `event_settings`). When enabled, the rate is explicitly passed to the Square Orders API as an additive order-level tax (`scope:"ORDER"`, `type:"ADDITIVE"`) — Square's dashboard auto-tax feature is not relied upon. Both primary and supplemental invoices carry the same tax line. Smart due dates are computed server-side: deposit due = max(today, eventDate−14d); balance due = eventDate−3d (with +14d fallback when no event date).
- **Unified Sales Report:** `/api/admin/sales-reports` accepts a `scope` param (`events` | `catering` | `all`). When scope includes catering, paid catering inquiries (`squareAmountPaid > 0`) are fetched and merged into the JSON response under `report.catering` (totals, orders, items). The CSV endpoints likewise merge catering rows: items CSV aggregates by name across both types; orders CSV appends catering rows with `C-{id}` prefix. The SalesReports page exposes a Scope filter, shows unified KPI cards, a By Type breakdown (when scope=all), and a chronologically-sorted combined orders table that renders catering rows with teal "catering" badges and event rows with their existing source/payment badges.
- **Theming Strategy:** Employs a class-based dark mode using Tailwind CSS v4's custom variants and HSL tokens for broad automatic adaptation, minimizing component-specific `dark:` overrides.

## Product

- **Customer-facing Website:** Home page with AI chat, menu browsing with cart and event planning features, and order confirmation.
- **Admin Dashboard:** Comprehensive management for menu items, orders, blackout dates, images, event settings, catering inquiries, and Instagram hashtag wall moderation.
- **AI Chat Agent:** Provides real-time assistance for event planning and menu suggestions.
- **Shared Plans:** Allows customers to create and share event plans via unique links and SMS.
- **Instagram Hashtag Wall:** Displays approved Instagram posts on a public gallery, with admin moderation tools.
- **Network Printing:** Integrates with Star CloudPRNT printers for kitchen tickets, customer receipts, and item labels.

## User preferences

_Populate as you build_

## Gotchas

- **SMS Gateway Competition:** When running multiple instances (e.g., dev and prod), ensure `SMS_OUTBOUND_MODE=shadow` is set for non-production environments to prevent competition for the physical SIM gateway.
- **EJOIN Gateway Configuration:** Incorrect `EJOIN_GATEWAY_URL`, authentication credentials, or firmware-compatibility overrides can break SMS functionality. Use the `/api/admin/messages/inbound-diagnostics` endpoint for troubleshooting.
- **Printer Configuration:** CloudPRNT printers require their unique URL copied into their web UI for proper polling.
- **Theme Overrides:** Components with hard-coded `bg-white` or `text-black` will not automatically adapt to dark mode and require explicit `dark:` overrides.

## Pointers

- **Drizzle ORM Documentation:** [https://orm.drizzle.team/docs/overview](https://orm.drizzle.team/docs/overview)
- **OpenAPI Specification:** [https://swagger.io/specification/](https://swagger.io/specification/)
- **Orval Documentation:** [https://orval.dev/docs/introduction](https://orval.dev/docs/introduction)
- **Tailwind CSS Documentation:** [https://tailwindcss.com/docs](https://tailwindcss.com/docs)
- **shadcn/ui Documentation:** [https://ui.shadcn.com/docs](https://ui.shadcn.com/docs)
- **Star CloudPRNT Documentation:** Refer to Star Micronics developer resources for CloudPRNT API specifics.
- **Twilio SMS API Documentation:** [https://www.twilio.com/docs/sms](https://www.twilio.com/docs/sms)