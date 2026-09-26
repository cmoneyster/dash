---
name: Isolated route tests lack request logging
description: Why a route can work with the server's logger middleware but fail in isolated Express tests.
---

Route tests that mount the catering routers on a bare Express app do not attach the production request logger. Newly exercised paths using the request's logger must either tolerate its absence or explicitly add logger middleware to the test app.

**Why:** A route that normally returns a delivery warning instead returned 500 in an isolated test when its new warning log dereferenced a missing request logger. This hid the intended behavior even though the production server normally supplies the logger.

**How to apply:** When adding a route branch with request-scoped logging, check whether isolated tests exercise that branch. Use optional logging on such branches or add a realistic logger to the test harness; do not mistake the logging-induced 500 for the underlying gateway error.