---
name: Star Line Mode vs ESC/POS command differences
description: Critical differences between Star Line Mode (native default) and ESC/POS mode for raw TCP/9100 byte printing
---

# Star Line Mode vs ESC/POS — Command Differences

**Why:** Star thermal printers default to Star Line Mode (native StarPRNT), NOT ESC/POS mode. Sending ESC/POS-only commands to TCP port 9100 on a Star printer in Line Mode produces garbage output (e.g. `**` for unknown size command, extra line feeds for alignment command).

## Command mapping (ESC/POS → Star Line Mode)

| Purpose | ESC/POS (broken in Line Mode) | Star Line Mode (correct) |
|---|---|---|
| Character size | `GS ! n` = `[0x1d, 0x21, n]` | `ESC i n1 n2` = `[0x1b, 0x69, h, w]` (h/w: 0=single,1=double) |
| Text alignment | `ESC a n` = `[0x1b, 0x61, n]` (feeds paper in Line Mode!) | `ESC GS a n` = `[0x1b, 0x1d, 0x61, n]` |
| Bold off | `ESC E 0` = `[0x1b, 0x45, 0x00]` (ENABLES bold in Line Mode!) | `ESC F` = `[0x1b, 0x46]` |
| Bold on | `ESC E 1` = `[0x1b, 0x45, 0x01]` | Works in both modes (0x01 param ignored, ESC E enables bold) |
| Init | `ESC @` = `[0x1b, 0x40]` | Same in both modes |
| Cut | `ESC d 3 ESC m` | Same in both modes |

## ESC i parameters
- `[0x1b, 0x69, 0, 0]` = normal size
- `[0x1b, 0x69, 1, 1]` = double high + double wide
- Star Line Mode only supports single/double (no 3x/4x etc.)

## ESC GS a alignment values
- n=0: left, n=1: center, n=2: right

**How to apply:** Any code that sends raw bytes to TCP port 9100 on a Star printer must use Star Line Mode commands. The ESC/POS emulation mode is a separate firmware setting users must explicitly enable.
