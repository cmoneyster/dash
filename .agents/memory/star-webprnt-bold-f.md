---
name: Star WebPRNT bold-off prints F
description: TSP143IV firmware bug — <Bold on="false"/> generates ESC F which prints 'F' in ESC/POS mode; fix and avoidance strategy.
---

## The bug

On Star TSP143IV printers in `lan_browser` / WebPRNT mode, `<Bold on="false"/>` in the WebPRNT XML causes a stray `F` character to print.

**Why:** The Star firmware converts `<Bold on="false"/>` to `ESC F` (Star Line Mode cancel-bold, `0x1B 0x46`), but the print head operates in ESC/POS mode. In ESC/POS, `ESC F` is not a defined command — the printer treats `0x46` as a printable character and outputs `F`.

## Fix applied (printRenderer.ts, WebPRNT path only)

1. **State tracking in `WebPrntBuilder.bold()`** — tracks `_bold` and only emits `<Bold on="X"/>` when the state actually changes. This eliminates redundant calls (sections previously emitted `<Bold on="false"/>` both before AND after content even when already non-bold).

2. **Reorder `DEFAULT_ORDERS` for item/combo/plate labels** — non-bold sections (`guestName`, `timestamp`) placed FIRST; bold sections (`header`, `orderNumber`, `items`) placed LAST. With this ordering there are no bold→non-bold transitions within a label, so `<Bold on="false"/>` is never emitted.

3. **Removed trailing `.bold(false)`** from `webItemLabelSection`, `webComboLabelSection`, `webPlateLabelSection`. The next section's leading `bold(style.bold)` sets the correct state.

4. **Plate label line-item loop** — removed per-item `bold(true)/bold(false)` toggle; items and modifiers remain in the current bold state (set by the plate header). No bold-off needed.

5. **`b.initialize()` at label start** — each WebPRNT label renderer calls `b.initialize()` first for a clean state. `initialize()` now uses `push` (not `unshift`) and resets `_bold = false`.

**Why:** `<Initialize/>` in Star WebPRNT resets print settings without clearing the buffer — safe to use at label start.

## How to apply

- Any future WebPRNT label changes: avoid `<Bold on="false"/>`. Use the bold-last section ordering to keep transitions one-way (false→true only).
- If a mid-label bold→non-bold transition is truly required (e.g. a custom section), use `b.initialize()` (resets settings, doesn't clear buffer) then re-apply alignment/size — do NOT use `bold(false)`.
- The ESC/POS path (`itemLabelSection`, `comboLabelSection`, `plateLabelSection`) is unaffected; it uses `BOLD_OFF = [ESC, 0x45, 0x00]` which is the correct ESC/POS command.
