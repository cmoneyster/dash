# SEO Strategy

## In scope
- Public marketing pages: `/`, `/menu`, `/gallery`
- Public planning flow pages: `/plan`, `/plan/preview`, `/plan/share/:token`
- Public quote and inquiry pages: `/quote/:token`, `/inquiry/:token`
- Public event/order status pages that can be opened without admin auth

## Out of scope
- Authenticated admin routes under `/admin/**`
- Staff/internal operational routes such as `/event-taker`, `/kitchen`, and demo-only routes
- Backend API endpoints except where they control crawlability artifacts such as `robots.txt` or `sitemap.xml`

## Target audience
- Prospective catering customers evaluating the business for events
- Likely local/regional customers around Olney, Maryland and nearby areas, inferred from source

## Primary keywords
- Catering
- Event catering
- Asian-inspired catering
- Food trailer catering
- Catering quote / catering menu

## Dismissed categories
- None yet

## Notes
- The frontend is a React + Vite SPA using Wouter, so public routes currently share one static HTML shell unless explicitly prerendered or server-rendered.
- Social bots and AI crawlers will only see the static HTML in `artifacts/catering-web/index.html`.
