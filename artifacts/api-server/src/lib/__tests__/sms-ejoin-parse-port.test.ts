import { describe, it, expect } from "vitest";
import {
  parseInboundSmsDetail,
  parseInboundSmsHtml,
  parseInboundSmsListData,
  parseInboundSmsListing,
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
// regex /^[1-8]$/ rejected. The current parser captures \d{1,2} and
// then range-checks against EJOIN_PORT_COUNT, so the upper bound moves
// with the constant rather than being hard-coded in the regex.

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

// parseInboundSmsListing returns BOTH the parsed rows and the per-port
// summary the listing surfaced. The summary is what the live poller
// uses to decide whether to drill into the per-port detail page on the
// next cycle (count grew → unread messages we'd otherwise lose).
describe("parseInboundSmsListing — per-port summary alongside rows", () => {
  it("tolerates raw modem control bytes in a JSON string field", () => {
    // The live gateway emits these bytes in the receiver field for some
    // rows. They are invalid when embedded literally in JSON and must not
    // cause every otherwise-valid SIM row to disappear.
    const html = listDataPage(
      `{"result":0,"count":16,"data":[[7,"7A",4,"13015550123","09-09 17:08","Can I pay with cash?","\\x01\\x06\\x07"]]}`,
    );
    const out = parseInboundSmsListing(html, { portFilter: 7 });
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0]).toMatchObject({
      port: 7,
      fromPhone: "3015550123",
      body: "Can I pay with cash?",
    });
    expect(out.ports[0].count).toBe(4);
  });

  it("ignores a commented sample payload before the live gateway payload", () => {
    const sample = JSON.stringify({
      result: 0,
      count: 16,
      data: [[7, "7A", 0, "", "", "", ""]],
    });
    const live = JSON.stringify({
      result: 0,
      count: 16,
      data: [[7, "7A", 4, "13015550123", "09-09 17:08", "Can I pay with cash?", "12405550199"]],
    });
    const html = `<script>
      /* loadListData("ID_TabCmdResp", '${sample}', smsTrContruct); */
      loadListData("ID_TabCmdResp", '${live}', smsTrContruct);
    </script>`;
    const out = parseInboundSmsListing(html);
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0].fromPhone).toBe("3015550123");
    expect(out.rows[0].body).toBe("Can I pay with cash?");
    expect(out.ports).toEqual([
      { port: 7, count: 4, latestId: out.rows[0].gatewayMessageId },
    ]);
  });

  it("reports count + latest id for every port row, including empty slots", () => {
    const payload = JSON.stringify({
      result: 0, count: 16,
      data: [
        [1, "1A", 0, "", "", "", ""],
        [3, "3A", 5, "12222222222", "04-28 09:00", "older sim", "x"],
        [7, "7A", 17, "12405158960", "04-28 01:50", "chat sim", "x"],
      ],
    });
    const out = parseInboundSmsListing(listDataPage(payload));
    expect(out.rows).toHaveLength(2); // empty slot row dropped from rows
    // ports array reports ALL valid port slots so diagnostics can show
    // "port 1: 0 messages" instead of hiding empty SIMs.
    expect(out.ports).toHaveLength(3);
    const port1 = out.ports.find(p => p.port === 1);
    const port3 = out.ports.find(p => p.port === 3);
    const port7 = out.ports.find(p => p.port === 7);
    expect(port1).toEqual({ port: 1, count: 0, latestId: null });
    expect(port3?.count).toBe(5);
    expect(port3?.latestId).toBeTruthy();
    expect(port7?.count).toBe(17);
    expect(port7?.latestId).toBeTruthy();
    // latestId in summary matches the gatewayMessageId of the
    // corresponding row — that's how the scheduler knows the latest
    // listing row already covers the same physical message.
    expect(out.rows.find(r => r.port === 7)?.gatewayMessageId).toBe(port7?.latestId);
  });

  it("portFilter narrows rows but keeps the full port summary", () => {
    const payload = JSON.stringify({
      result: 0, count: 16,
      data: [
        [3, "3A", 1, "12222222222", "04-28 09:00", "skip me", "x"],
        [7, "7A", 1, "12405158960", "04-28 01:50", "keep me", "x"],
      ],
    });
    const out = parseInboundSmsListing(listDataPage(payload), { portFilter: 7 });
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0].body).toBe("keep me");
    // Summary still reports BOTH ports so the scheduler can spot count
    // changes on non-chat ports too if it ever wants to.
    expect(out.ports.map(p => p.port).sort()).toEqual([3, 7]);
  });
});

// parseInboundSmsDetail handles the per-port "drill in" page. Critical
// invariants: (a) it surfaces older messages a listing-only fetch
// would have hidden behind the latest, (b) the synthesized id matches
// the listing parser's id for the same physical message so dedupe
// across the two fetch paths collapses to one DB row, (c) it falls
// back to the legacy <tr> scanner when no loadListData is present.
describe("parseInboundSmsDetail — per-port drill-in page", () => {
  it("parses the current firmware detail row layout", () => {
    const payload = JSON.stringify({
      result: 0,
      total: 2,
      curPage: 1,
      itemsPerPage: 100,
      count: 2,
      data: [
        [1, "7A", "13015550123", "09-09 17:08", "Is there any way I could pay cash?", "12405550199", "260909140807A8"],
        [2, "7A", "13015550123", "09-09 16:52", "Tuesday would be great", "12405550199", "260909135215A8"],
      ],
    });
    const out = parseInboundSmsDetail(listDataPage(payload), 7);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      port: 7,
      fromPhone: "3015550123",
      body: "Is there any way I could pay cash?",
    });
    expect(out[1].body).toBe("Tuesday would be great");
  });

  it("rejects a wrong-port detail page instead of relabeling its rows", () => {
    const payload = JSON.stringify({
      result: 0,
      total: 1,
      count: 1,
      data: [[1, "1A", "13015550123", "09-09 17:08", "wrong SIM", "12405550199", "x"]],
    });
    expect(parseInboundSmsDetail(listDataPage(payload), 7)).toEqual([]);
  });

  it("recovers multiple messages on the same port (the bug being fixed)", () => {
    // Three messages on port 7 from the same customer — listing would
    // only have surfaced the latest one. Detail walk recovers all three.
    const payload = JSON.stringify({
      result: 0, count: 3,
      data: [
        [1, "12405158960", "04-28 01:50", "third (newest)", "x"],
        [2, "12405158960", "04-28 01:45", "second", "x"],
        [3, "12405158960", "04-28 01:40", "first (oldest)", "x"],
      ],
    });
    const out = parseInboundSmsDetail(listDataPage(payload), 7);
    expect(out).toHaveLength(3);
    expect(out.every(r => r.port === 7)).toBe(true);
    expect(out.map(r => r.body)).toEqual([
      "third (newest)", "second", "first (oldest)",
    ]);
    expect(out.every(r => r.fromPhone === "2405158960")).toBe(true);
  });

  it("collapses to the same id as the listing parser for the same physical message", () => {
    // Same message: port 7, sender 12405158960, time 04-28 01:50, content "test".
    // Whichever fetch path surfaces it first, the gatewayMessageId must
    // match so the DB unique constraint dedupes them.
    const listingPayload = JSON.stringify({
      result: 0, count: 16,
      data: [[7, "7A", 17, "12405158960", "04-28 01:50", "test", "x"]],
    });
    const detailPayload = JSON.stringify({
      result: 0, count: 1,
      data: [[1, "12405158960", "04-28 01:50", "test", "x"]],
    });
    const fromListing = parseInboundSmsListData(listDataPage(listingPayload));
    const fromDetail = parseInboundSmsDetail(listDataPage(detailPayload), 7);
    expect(fromListing).toHaveLength(1);
    expect(fromDetail).toHaveLength(1);
    expect(fromListing[0].gatewayMessageId).toBe(fromDetail[0].gatewayMessageId);
  });

  it("normalizes the listing's MM-DD HH:MM time and the detail's MM-DD HH:MM:SS to the same id", () => {
    // Listing always shows MM-DD HH:MM; some firmware on the detail
    // page adds :SS. The id formula strips the seconds so the two
    // paths still collide on the same id.
    const listingPayload = JSON.stringify({
      result: 0, count: 16,
      data: [[7, "7A", 1, "12405158960", "04-28 01:50", "hello", "x"]],
    });
    const detailPayload = JSON.stringify({
      result: 0, count: 1,
      data: [[1, "12405158960", "04-28 01:50:30", "hello", "x"]],
    });
    const a = parseInboundSmsListData(listDataPage(listingPayload));
    const b = parseInboundSmsDetail(listDataPage(detailPayload), 7);
    expect(a[0].gatewayMessageId).toBe(b[0].gatewayMessageId);
  });

  it("accepts the listing-shape row layout when firmware re-uses it on the detail page", () => {
    // Some firmware emits the same [seq, portSlot, count, sender, time,
    // content, ...] shape on the detail page too. We detect "looks like
    // a portSlot label" and pivot the column indices accordingly.
    const payload = JSON.stringify({
      result: 0, count: 1,
      data: [[1, "7A", 17, "12405158960", "04-28 01:50", "listing shape", "x"]],
    });
    const out = parseInboundSmsDetail(listDataPage(payload), 7);
    expect(out).toHaveLength(1);
    expect(out[0].body).toBe("listing shape");
    expect(out[0].port).toBe(7);
  });

  it("falls back to the legacy <tr> scanner when no loadListData is present", () => {
    // Old firmware just renders the detail page server-side. The
    // legacy scanner already supports portFilter, so we re-use it.
    const html = `<table>${row(["888", "7", FROM, WHEN, BODY])}</table>`;
    const out = parseInboundSmsDetail(html, 7);
    expect(out).toHaveLength(1);
    expect(out[0].port).toBe(7);
    expect(out[0].body).toBe(BODY);
  });

  it("returns empty when port is out of range — no crash, no garbage rows", () => {
    const payload = JSON.stringify({
      result: 0, count: 1,
      data: [[1, "12405158960", "04-28 01:50", "test", "x"]],
    });
    expect(parseInboundSmsDetail(listDataPage(payload), 0)).toHaveLength(0);
    expect(parseInboundSmsDetail(listDataPage(payload), 99)).toHaveLength(0);
  });
});

// Inbound timestamp parsing must interpret the gateway's wall-clock
// strings in the install-site timezone (default America/New_York). The
// previous implementation hand-stitched the string with a "Z" suffix,
// causing every inbound chat bubble to render 4 h early in EDT and 5 h
// early in EST. These tests pin the corrected behavior across summer,
// winter, and both DST edges so we don't regress at the November
// transition.
describe("inbound timestamp parsing is timezone-aware (default America/New_York)", () => {
  // Helper: assert that the row.occurredAt parsed from a listing-shape
  // payload with the given "MM-DD HH:MM" string matches the expected
  // UTC ISO instant. Pins the bug fix for inbound chat times shown 4 h
  // early during EDT.
  function listingTsRow(time: string, nowIso: string): Date {
    const payload = JSON.stringify({
      result: 0,
      count: 1,
      data: [[7, "7A", 1, "12405158960", time, "tz test", "x"]],
    });
    // parseInboundSmsListing uses `new Date()` internally for the year
    // inference; we can't override that without changing the API, so we
    // stub Date.now via Date constructor for the duration of the call.
    const realNow = Date.now;
    Date.now = () => new Date(nowIso).getTime();
    const RealDate = Date;
    // @ts-expect-error: temporary monkey-patch for the constructor's
    // zero-arg form used inside the parser.
    globalThis.Date = class extends RealDate {
      constructor(...args: ConstructorParameters<typeof Date>) {
        // @ts-expect-error rest spread into Date constructor
        super(...(args.length === 0 ? [Date.now()] : args));
      }
    };
    try {
      const out = parseInboundSmsListData(listDataPage(payload));
      expect(out).toHaveLength(1);
      return out[0].occurredAt;
    } finally {
      globalThis.Date = RealDate;
      Date.now = realNow;
    }
  }

  it("listing 'MM-DD HH:MM' in July (EDT) parses to UTC + 4 h", () => {
    // 2026-07-15 13:50 America/New_York is 17:50 UTC (UTC-4 EDT).
    const occurredAt = listingTsRow("07-15 13:50", "2026-07-16T00:00:00Z");
    expect(occurredAt.toISOString()).toBe("2026-07-15T17:50:00.000Z");
  });

  it("listing 'MM-DD HH:MM' in January (EST) parses to UTC + 5 h", () => {
    // 2026-01-15 13:50 America/New_York is 18:50 UTC (UTC-5 EST).
    const occurredAt = listingTsRow("01-15 13:50", "2026-01-16T00:00:00Z");
    expect(occurredAt.toISOString()).toBe("2026-01-15T18:50:00.000Z");
  });

  it("legacy <tr> 'YYYY-MM-DD HH:MM:SS' in July (EDT) parses to UTC + 4 h", () => {
    // The same 2026-07-15 13:50:00 wall clock through the legacy <tr>
    // scanner path that parseInboundSmsHtml uses for older firmware.
    const html = `<table>${row(["555", "7", FROM, "2026-07-15 13:50:00", BODY])}</table>`;
    const out = parseInboundSmsHtml(html);
    expect(out).toHaveLength(1);
    expect(out[0].occurredAt.toISOString()).toBe("2026-07-15T17:50:00.000Z");
  });

  it("legacy <tr> 'YYYY-MM-DD HH:MM:SS' in January (EST) parses to UTC + 5 h", () => {
    const html = `<table>${row(["556", "7", FROM, "2026-01-15 13:50:00", BODY])}</table>`;
    const out = parseInboundSmsHtml(html);
    expect(out).toHaveLength(1);
    expect(out[0].occurredAt.toISOString()).toBe("2026-01-15T18:50:00.000Z");
  });

  it("spring-forward gap '2026-03-08 02:30' returns a finite Date and does not throw", () => {
    // 02:30 on the second Sunday of March in America/New_York never
    // exists (clocks jump 02:00 EST → 03:00 EDT). The parser must not
    // crash; the exact instant is unspecified.
    const html = `<table>${row(["557", "7", FROM, "2026-03-08 02:30:00", BODY])}</table>`;
    const out = parseInboundSmsHtml(html);
    expect(out).toHaveLength(1);
    expect(Number.isFinite(out[0].occurredAt.getTime())).toBe(true);
  });

  it("fall-back ambiguous '2026-11-01 01:30' picks the earlier (EDT) instant", () => {
    // 01:30 on the first Sunday of November in America/New_York occurs
    // twice — once in EDT (UTC-4 → 05:30 UTC) and again an hour later
    // in EST (UTC-5 → 06:30 UTC). The parser is documented to pick the
    // earlier (still-DST) instant so the choice is deterministic and
    // monotonically aligned with normal pre-transition messages.
    const html = `<table>${row(["558", "7", FROM, "2026-11-01 01:30:00", BODY])}</table>`;
    const out = parseInboundSmsHtml(html);
    expect(out).toHaveLength(1);
    expect(out[0].occurredAt.toISOString()).toBe("2026-11-01T05:30:00.000Z");
  });

  it("EJOIN_GATEWAY_TZ env override switches the parse zone (UTC → no offset)", () => {
    // When an operator relocates the gateway, they can flip the env
    // var without a redeploy. Parsing the same wall clock in UTC means
    // no offset is applied at all.
    const prev = process.env.EJOIN_GATEWAY_TZ;
    process.env.EJOIN_GATEWAY_TZ = "UTC";
    try {
      const html = `<table>${row(["559", "7", FROM, "2026-07-15 13:50:00", BODY])}</table>`;
      const out = parseInboundSmsHtml(html);
      expect(out).toHaveLength(1);
      expect(out[0].occurredAt.toISOString()).toBe("2026-07-15T13:50:00.000Z");
    } finally {
      if (prev === undefined) delete process.env.EJOIN_GATEWAY_TZ;
      else process.env.EJOIN_GATEWAY_TZ = prev;
    }
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
