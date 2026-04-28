"""Run `pnpm --filter @workspace/db push-force` non-interactively, even
when drizzle-kit hits its rename-vs-create-column ambiguity prompt.

Why this exists
---------------
Drizzle-kit has two kinds of interactive prompts during `push`:
  1. Destructive-data confirmations (drop column, drop table, etc.).
     These are suppressed by the `--force` flag.
  2. Rename ambiguity. When a brand-new column shares a name pattern
     with an existing column on the same table (e.g. adding
     `sms_chat_port` to a table that already has `social_*` columns),
     drizzle-kit can't decide whether the column is genuinely new or
     a rename of an existing one. It prompts the operator to pick.
     `--force` does NOT suppress these prompts.

The post-merge automation runs without a TTY. When the second kind of
prompt fires under post-merge, drizzle's prompt library (clack) detects
no TTY, the push silently aborts, and the wrapper still reports success.
The result is a database that's out of sync with the code, and any
admin route that reads the not-yet-applied columns 500s on the next
request. We've already been bitten by this once (see the SMS chat
merge); this script is the fix.

Approach
--------
Spawn `pnpm --filter @workspace/db push-force` inside a real PTY,
watch its output for the prompt strings, and write a carriage return
to the master fd to confirm the highlighted default ("create column"
or "create table") for each prompt. The default is always the correct
choice in this codebase because we don't perform column renames via
drizzle. If a future task genuinely needs to rename a column via
drizzle-kit, do NOT rely on this script — run `pnpm --filter
@workspace/db push` interactively from a real shell so you can answer
the rename prompt yourself, then commit the resulting schema state
before merging.

Failure modes covered:
  * No prompt at all (clean push) — process exits naturally; the read
    loop terminates on EOF and we propagate drizzle's exit code.
  * Many prompts in a row — the prompt-tracking watermark advances past
    each handled prompt so we send Enter exactly once per prompt, never
    re-firing on stale buffer content.
  * Genuine drizzle error after a prompt (e.g. NOT NULL violation on
    existing data) — drizzle exits non-zero, we propagate that exit
    code, and post-merge.sh's `set -e` halts the wrapper loudly.
  * Hung process (no output for HARD_TIMEOUT_S seconds, e.g. an
    unrecognized future prompt class clack adds) — we kill the child
    and return 124. We do NOT kill on short stretches of quiet output;
    legitimate DDL operations can be silent for tens of seconds.
"""

import os
import pty
import select
import sys
import time

CMD = ["pnpm", "--filter", "@workspace/db", "push-force"]

# Strings that appear when drizzle-kit shows a rename-ambiguity prompt.
# Matching either is sufficient — we just need to know "a prompt is on
# the screen and the user is expected to press Enter to accept the
# default highlighted (create) option".
PROMPT_NEEDLES = (b"create column", b"create table")

# Pause this long after first seeing a prompt before pressing Enter,
# so the renderer has time to settle (clack repaints the menu a few
# times during initial render).
PROMPT_DEBOUNCE_S = 0.4

# Absolute upper bound on the whole run AND inactivity ceiling: if the
# child produces no output at all for this many seconds, we assume
# something is wedged (e.g. clack waiting on a prompt class our
# needles don't recognize) and force-exit. Sized generously so a slow
# DDL operation can't trip it; failure here always returns 124.
HARD_TIMEOUT_S = 180.0


def main() -> int:
    pid, fd = pty.fork()
    if pid == 0:
        # Child branch: replace ourselves with the drizzle-kit invocation.
        os.execvp(CMD[0], CMD)
        return 0  # unreachable

    started = time.time()
    last_output = started
    pending_prompt_since: float | None = None
    # Length of `buf` we've already inspected for prompts. Anything beyond
    # this index is "new" and may contain a fresh prompt; everything at
    # or below has already been considered. This is what makes prompt
    # detection idempotent — once we send Enter for a prompt at offset N,
    # we never re-trigger on the same bytes.
    consumed_up_to = 0
    buf = b""
    timeout_exit_code: int | None = None

    try:
        while True:
            now = time.time()
            if now - last_output > HARD_TIMEOUT_S:
                print(
                    f"\n[db-push-noninteractive] HARD TIMEOUT after {HARD_TIMEOUT_S}s of no output — killing drizzle-kit",
                    file=sys.stderr,
                )
                try:
                    os.kill(pid, 9)
                except ProcessLookupError:
                    pass
                timeout_exit_code = 124
                break

            r, _, _ = select.select([fd], [], [], 0.5)
            if r:
                try:
                    data = os.read(fd, 4096)
                except OSError:
                    # PTY closed — child exited. Loop exits naturally.
                    break
                if not data:
                    break
                # Mirror drizzle output to our stdout so post-merge logs
                # capture exactly what happened, including the prompts
                # we auto-answered.
                sys.stdout.buffer.write(data)
                sys.stdout.buffer.flush()
                buf += data
                last_output = now

                # Only inspect bytes we haven't checked yet. This makes
                # detection idempotent across the rolling buffer — each
                # prompt is matched exactly once, then the watermark
                # advances past it so we never re-fire on stale content.
                fresh = buf[consumed_up_to:]
                hit_idx = -1
                for needle in PROMPT_NEEDLES:
                    i = fresh.find(needle)
                    if i != -1 and (hit_idx == -1 or i < hit_idx):
                        hit_idx = i + len(needle)
                if hit_idx != -1 and pending_prompt_since is None:
                    pending_prompt_since = now
                    consumed_up_to += hit_idx
            else:
                # Nothing arrived this slice. If a prompt is sitting on
                # screen and the renderer has had time to settle, press
                # Enter exactly once. The watermark we advanced above
                # guarantees the next prompt (if any) needs fresh bytes
                # to be detected.
                if (
                    pending_prompt_since is not None
                    and now - pending_prompt_since >= PROMPT_DEBOUNCE_S
                ):
                    try:
                        os.write(fd, b"\r")
                    except OSError:
                        break
                    pending_prompt_since = None
    finally:
        # Always reap the child so we don't leave zombies. Prefer the
        # explicit timeout code over drizzle's exit status when we
        # forcibly killed it; otherwise propagate drizzle's actual code
        # so genuine errors (e.g. NOT NULL violations after a prompt)
        # surface to post-merge.sh's `set -e`.
        try:
            _, status = os.waitpid(pid, 0)
            drizzle_code = os.WEXITSTATUS(status) if os.WIFEXITED(status) else 1
        except ChildProcessError:
            drizzle_code = 0
        exit_code = timeout_exit_code if timeout_exit_code is not None else drizzle_code

    return exit_code


if __name__ == "__main__":
    sys.exit(main())
