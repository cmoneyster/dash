---
name: Web math tests without local Vitest
description: Testing pure frontend modules in the catering workspace without cross-artifact imports or extra dependencies
---

Keep pure frontend tests inside the web artifact rather than importing frontend source from API tests. The web package does not currently declare Vitest, but its tests can run by invoking the API artifact's existing Vitest executable with the web artifact as the root.

**Why:** Putting a test for frontend math in the API package appeared to run, but the API TypeScript check then followed cross-artifact imports outside its root and failed. Installing Vitest at the workspace root also hit pnpm's intentional workspace-root guard.

**How to apply:** For focused web-only unit tests, use the existing API Vitest binary with `--root ../catering-web` from the API directory. Keep web test modules excluded from the web production TypeScript check as the existing config specifies. Prefer a declared web test dependency if a broader frontend test suite is later adopted.