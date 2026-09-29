---
name: Square invoice and plan revision serialization
description: Why invoice publication and customer-plan review must coordinate throughout the external Square call
---

Primary Square invoice publication and inquiry-linked plan revision review must serialize on the same inquiry for the entire Square publish window, not merely check state before or after the network call.

**Why:** A review can otherwise apply while Square is publishing the previously read quote; the invoice bills one plan while the inquiry records another. Holding a database row lock through the external call prioritizes correctness over shorter transactions. A future two-phase reservation/reconciliation design could replace the long lock only if it gives review an explicit in-flight state to block on and safely handles publish-then-commit failures.

**How to apply:** When changing primary invoice issuance, quote review, or customer-plan application, preserve the cross-operation exclusion through publication and the mirrored invoice write. Test the race with a delayed Square publication rather than only sequential requests.