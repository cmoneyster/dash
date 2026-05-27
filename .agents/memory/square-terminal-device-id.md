---
name: Square Terminal device_id prefix
description: The device_id format needed for Terminal Checkout API differs from what /v2/devices returns
---

The `/v2/devices` endpoint returns device IDs with a `device:` prefix (e.g. `device:445CS149B8000664`). Storing this in the DB and passing it directly to `POST /v2/terminals/checkouts` causes a `BAD_REQUEST: Merchant not authorized for device_id` error — even when the token, merchant, location, and pairing are all correct.

**Why:** Square's Terminal Checkout API `device_options.device_id` expects the bare serial number without the prefix (e.g. `445CS149B8000664`). The `device_id` field in the `POST /v2/devices/codes` response also returns the bare serial, confirming this is the expected format for checkout.

**How to apply:** Strip the `device:` prefix at the point the device_id is sent to the Terminal Checkout API:
```typescript
device_id: opts.deviceId.replace(/^device:/, ""),
```
Keep the full `device:SERIAL` format in the DB and in `/v2/devices` lookups — only strip it for the Terminal Checkout call.
