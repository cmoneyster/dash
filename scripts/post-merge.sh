#!/bin/bash
set -e
pnpm install --frozen-lockfile
# Apply schema changes via the non-interactive driver. Two kinds of
# prompts can fire during a drizzle-kit push:
#   1. Destructive-data confirmations — `--force` (used inside the
#      `push-force` script) suppresses these.
#   2. Rename-vs-create-column ambiguity — fires when a brand-new
#      column shares a name pattern with existing columns on the same
#      table. `--force` does NOT suppress these, and post-merge runs
#      without a TTY, so the prompt silently aborts the push and the
#      schema falls out of sync with the code. The DB ends up missing
#      columns that the running code reads, and the next admin request
#      against the affected table 500s.
#
# The Python driver below runs `push-force` inside a real PTY and
# auto-presses Enter to accept the default highlighted choice ("create
# column" / "create table") for every ambiguity prompt — the correct
# interpretation in this codebase, since we don't rename columns via
# drizzle. If drizzle reports a real error after a prompt is answered
# (e.g. a NOT NULL violation against existing data), the driver
# surfaces the error and exits non-zero so this wrapper fails loudly
# instead of silently succeeding.
python3 scripts/db-push-noninteractive.py
