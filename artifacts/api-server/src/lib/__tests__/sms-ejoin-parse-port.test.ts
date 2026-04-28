import { describe, it, expect } from "vitest";
import {
  parseInboundSmsHtml,
  parseInboundSmsListData,
} from "../sms-ejoin.js";

// Locks in the contract that the inbound HTML row scanner accepts the
// gateway's "<integer><A|B>" SIM-slot port labels in addition to the
// bare integer. Both slot variants collapse to the integer port so the
// chat-port admin setting (which is integer-only) keeps working without
// requiring operators to know which SIM slot a message arrived on.
//
// Two parser paths are covered:
//   1. Legacy <tr>/<td> server-rendered tables — older firmware.
//   2. JavaScript-rendered loadListData("ID_TabCmdResp", '<json>', ...)
//      payload — newer firmware (the customer's actual gateway).
//
// Regression for the silent-drop bug where every inbound message was
// discarded because (a) the newer firmware doesn't emit <tr> rows so
// the legacy parser saw an empty table, and (b) when those rows were
// present they used "7A" / "7B" port labels that the legacy port-cell
// regex /^[1-8]$/ rejected.

function row(cells: string[]): string {
  return `<tr>${cells.map(c => `<td>${c}</td>`).join("")}</tr>`;
}

const FROM = "+15551234567";
const WHEN = "2026-04-27 10:15:30";
// Body longer than the timestamp cell so the existing longest-leftover
// body heuristic (unchanged by this task) picks the right cell.
const BODY = "this is a real-length inbound text message body";

describe("parseInboundSmsHtml — legacy <tr> port-cell suffix handling", () => {
  it("plain integer port still parses to that integer", () => {
    const html = `<table>${row(["123", "7", FROM, WHEN, BODY])}</table>`;
    const out = parseInboundSmsHtml(html);
    expect(out).toHaveLength(1);
    expect(out[0].port).toBe(7);
  });

  it("'7A' port label parses to integer port 7", () => {
    const html = `<table>${row(["124", "7A", FROM, WHEN, BODY])}</table>`;
    const out = parseInboundSmsHtml(html);
    expect(out).toHaveLength(1);
    expect(out[0].port).toBe(7);
  });

  it("'7B' port label parses to integer port 7", () => {
    const html = `<table>${row(["125", "7B", FROM, WHEN, BODY])}</table>`;
    const out = parseInboundSmsHtml(html);
    expect(out).toHaveLength(1);
    expect(out[0].port).toBe(7);
  });

  it("lowercase '7a' is accepted (case-insensitive)", () => {
    const html = `<table>${row(["126", "7a", FROM, WHEN, BODY])}</table>`;
    const out = parseInboundSmsHtml(html);
    expect(out).toHaveLength(1);
    expect(out[0].port).toBe(7);
  });

  it("portFilter matches integer-collapsed rows", () => {
    const html = `<table>
      ${row(["301", "7A", FROM, WHEN, BODY])}
      ${row(["302", "3", FROM, WHEN, BODY])}
    </table>`;
    const out = parseInboundSmsHtml(html, { portFilter: 7 });
    expect(out).toHaveLength(1);
    expect(out[0].gatewayMessageId).toBe("301");
  });

  it("invalid port labels are still rejected", () => {
    // "9" is out of range and "7AB" has a 2-letter suffix; both rows
    // should be dropped (no port → row skipped). The fallback JSON
    // parser also won't fire because the page has no loadListData call.
    const htmlOutOfRange = `<table>${row(["200", "9", FROM, WHEN, BODY])}</table>`;
    const htmlMultiLetter = `<table>${row(["201", "7AB", FROM, WHEN, BODY])}</table>`;
    expect(parseInboundSmsHtml(htmlOutOfRange)).toHaveLength(0);
    expect(parseInboundSmsHtml(htmlMultiLetter)).toHaveLength(0);
  });
});

// Slim repro of the customer's gateway page — only the relevant
// loadListData() call. Single-quoted JSON exactly as the firmware emits.
function listDataPage(jsonPayload: string): string {
  return `<html><body>
    <script language="javascript">
      loadListData("ID_TabCmdResp", '${jsonPayload}', smsTrContruct);
    </script>
  </body></html>`;
}

describe("parseInboundSmsListData — newer firmware loadListData payload", () => {
  it("extracts a real-shape entry on port 7A as integer port 7", () => {
    const payload = JSON.stringify({
      result: 0,
      count: 16,
      data: [
        [7, "7A", 17, "12405158960", "04-28 01:50", "test", "12402866192"],
      ],
    });
    const out = parseInboundSmsListData(listDataPage(payload));
    expect(out).toHaveLength(1);
    expect(out[0].port).toBe(7);
    expect(out[0].fromPhone).toBe("2405158960");
    expect(out[0].body).toBe("test");
  });

  it("skips empty slot rows (no sender / no content)", () => {
    const payload = JSON.stringify({
      result: 0,
      count: 16,
      data: [
        [1, "1A", 0, "", "", "", ""],
        [2, "2A", 0, "", "", "", ""],
        [7, "7A", 17, "12405158960", "04-28 01:50", "test", "12402866192"],
      ],
    });
    const out = parseInboundSmsListData(listDataPage(payload));
    expect(out).toHaveLength(1);
    expect(out[0].port).toBe(7);
  });

  it("drops entries on ports above the supported range", () => {
    // 16-port firmware reports 9A-16A; until EJOIN_PORT_COUNT is bumped
    // those are out of range and dropped here rather than crashing
    // downstream code that assumes 1..8.
    const payload = JSON.stringify({
      result: 0,
      count: 16,
      data: [
        [11, "11A", 1, "12345678900", "04-28 01:50", "high port", "x"],
        [7, "7A", 1, "12405158960", "04-28 01:50", "in range", "x"],
      ],
    });
    const out = parseInboundSmsListData(listDataPage(payload));
    expect(out).toHaveLength(1);
    expect(out[0].port).toBe(7);
    expect(out[0].body).toBe("in range");
  });

  it("portFilter restricts results to the integer port", () => {
    const payload = JSON.stringify({
      result: 0,
      count: 16,
      data: [
        [3, "3A", 1, "12405158960", "04-28 01:50", "ignore me", "x"],
        [7, "7A", 1, "12405158961", "04-28 01:51", "match me", "x"],
      ],
    });
    const out = parseInboundSmsListData(listDataPage(payload), { portFilter: 7 });
    expect(out).toHaveLength(1);
    expect(out[0].body).toBe("match me");
  });

  it("synthesizes a stable id so re-polls of the same message dedupe", () => {
    const payload = JSON.stringify({
      result: 0,
      count: 16,
      data: [
        [7, "7A", 17, "12405158960", "04-28 01:50", "hello world", "x"],
      ],
    });
    const a = parseInboundSmsListData(listDataPage(payload));
    const b = parseInboundSmsListData(listDataPage(payload));
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0].gatewayMessageId).toBe(b[0].gatewayMessageId);
  });

  it("returns empty when the page has no loadListData call", () => {
    expect(parseInboundSmsListData("<html><body>nothing here</body></html>")).toEqual([]);
  });

  it("returns empty when the JSON payload is malformed", () => {
    expect(parseInboundSmsListData(listDataPage("not json"))).toEqual([]);
  });

  // The gateway wraps the JSON in a JS single-quoted string literal, which
  // means every backslash inside the JSON is doubled and any escaped
  // single-quote inside body text is `\'`. Past firmware emissions have
  // also been seen using `\xNN` and `\uNNNN` escapes when the JSON
  // serializer chose hex/unicode encoding for non-ASCII bytes — the
  // parser must walk every shape correctly or whole rows silently vanish.
  it("decodes apostrophes inside body text without truncating the payload", () => {
    // Build the JSON, then hand-craft the JS literal: replace `\\` with
    // `\\\\` (double the backslashes) and escape the single quotes.
    const jsonText = JSON.stringify({
      result: 0,
      count: 16,
      data: [
        [6, "6A", 24, "18888271194", "04-27 16:00", "April's best sellers", "x"],
        [7, "7A", 1, "12405158960", "04-28 01:50", "test", "x"],
      ],
    });
    const jsLiteral = jsonText.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    const html = `<html><body><script>loadListData("ID_TabCmdResp", '${jsLiteral}', smsTrContruct);</script></body></html>`;
    const out = parseInboundSmsListData(html);
    expect(out).toHaveLength(2);
    expect(out[0].body).toBe("April's best sellers");
    expect(out[1].body).toBe("test");
  });

  it("decodes \\r\\n line breaks inside body text", () => {
    const jsonText = JSON.stringify({
      result: 0,
      count: 16,
      data: [
        [5, "5A", 1, "888222", "04-25 15:08", "line one\r\nline two", "x"],
      ],
    });
    const jsLiteral = jsonText.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    const html = `<html><body><script>loadListData("ID_TabCmdResp", '${jsLiteral}', smsTrContruct);</script></body></html>`;
    const out = parseInboundSmsListData(html);
    expect(out).toHaveLength(1);
    expect(out[0].body).toBe("line one\r\nline two");
  });

  it("decodes \\xNN hex escapes embedded in the JS literal", () => {
    // Some firmware re-encodes non-ASCII bytes using \xNN when serializing
    // into the JS string literal. \xE9 is é. The captured literal contains
    // a real backslash followed by xE9 — we must turn that into the byte
    // before JSON.parse can succeed.
    const html = `<html><body><script>loadListData("ID_TabCmdResp", '{"result":0,"count":16,"data":[[7,"7A",1,"12405158960","04-28 01:50","caf\\xE9","x"]]}', smsTrContruct);</script></body></html>`;
    const out = parseInboundSmsListData(html);
    expect(out).toHaveLength(1);
    expect(out[0].body).toBe("café");
  });

  it("decodes \\uNNNN unicode escapes in the JS literal without losing the row", () => {
    // \u00e9 is é. If the unescape strips the backslash but doesn't decode,
    // JSON.parse sees `"cafu00e9"` and the row still parses — but as the
    // wrong string. Verify we get the actual character back.
    const html = `<html><body><script>loadListData("ID_TabCmdResp", '{"result":0,"count":16,"data":[[7,"7A",1,"12405158960","04-28 01:50","caf\\u00e9","x"]]}', smsTrContruct);</script></body></html>`;
    const out = parseInboundSmsListData(html);
    expect(out).toHaveLength(1);
    expect(out[0].body).toBe("café");
  });

  it("decodes \\u{...} code-point escapes including astral plane chars", () => {
    // \u{1F600} is 😀 (U+1F600). Verify code-point escapes work end-to-end.
    const html = `<html><body><script>loadListData("ID_TabCmdResp", '{"result":0,"count":16,"data":[[7,"7A",1,"12405158960","04-28 01:50","hi \\u{1F600}","x"]]}', smsTrContruct);</script></body></html>`;
    const out = parseInboundSmsListData(html);
    expect(out).toHaveLength(1);
    expect(out[0].body).toBe("hi 😀");
  });
});

describe("parseInboundSmsHtml — fallback to loadListData when <tr> path is empty", () => {
  it("uses the JSON parser when no <tr> rows are present", () => {
    const payload = JSON.stringify({
      result: 0,
      count: 16,
      data: [
        [7, "7A", 17, "12405158960", "04-28 01:50", "fallback works", "x"],
      ],
    });
    const out = parseInboundSmsHtml(listDataPage(payload));
    expect(out).toHaveLength(1);
    expect(out[0].port).toBe(7);
    expect(out[0].body).toBe("fallback works");
  });

  it("does not double-count when both paths could match", () => {
    // Hybrid page: a <tr> row AND a loadListData payload. The fallback
    // must only kick in when the <tr> path returns zero, otherwise the
    // same logical message would be counted twice.
    const trRow = row(["999", "7", FROM, WHEN, BODY]);
    const payload = JSON.stringify({
      result: 0,
      count: 16,
      data: [
        [7, "7A", 17, "12405158960", "04-28 01:50", "fallback content", "x"],
      ],
    });
    const html = `<html><body><table>${trRow}</table>
      <script>loadListData("ID_TabCmdResp", '${payload}', smsTrContruct);</script>
    </body></html>`;
    const out = parseInboundSmsHtml(html);
    expect(out).toHaveLength(1);
    expect(out[0].body).toBe(BODY);
  });
});
