---
name: SMS gateway identity limits
description: Why cross-transport SMS identity cannot be inferred perfectly from gateway data.
---

The EjoinTech SMS webhook and its SIM inbox listing/detail page do not expose a shared message identifier. The poll page rounds time to minutes, and repeated identical messages may not expose a stable distinguishing ID. Therefore matching by sender, body, port, and time is necessarily heuristic; it must be bounded and one-to-one rather than a broad suppression window. A page changing membership can make same-minute repeat ordinals ambiguous.

**Why:** Production showed distinct `webhook:` and `listdata:` IDs for the same customer texts, sometimes over a minute apart, while legitimate repeated short replies must not be silently discarded.

**How to apply:** When changing SMS ingestion, preserve each source's replay idempotency and avoid treating every identical text within a time window as one SMS. Prefer any verifiable gateway-level ID if later firmware exposes one; document ambiguity otherwise. Existing production duplicates require separate authorization before cleanup.