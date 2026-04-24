// Shared serializer/parser for the menu CSV import/export.
//
// Two CSVs are produced/consumed:
//   - menu_items.csv       — every column on the menu_items table
//   - menu_categories.csv  — every column on the menu_categories table
//
// Field semantics:
//   - Blank `id` on a row → create a new record (freshly assigned id).
//   - Non-blank `id` that exists → update that record.
//   - Non-blank `id` that doesn't exist → error.
//   - Blank cell on an EXISTING row → leave field unchanged.
//   - Blank cell on a NEW row → use schema default (price 0, available true, etc).
//   - Literal cell value `__CLEAR__` → explicitly set field to null/empty.
//   - List fields (e.g. allergens) use a `|`-separated string.
//
// The same module powers both export (DB → CSV) and import (CSV → diff/apply)
// so they can never diverge — round-tripping an unchanged export must produce
// zero changes in the diff preview.

import type { MenuItem, MenuCategory } from "@workspace/db/schema";

export const CLEAR_SENTINEL = "__CLEAR__";
export const ITEMS_CSV_FILENAME = "menu_items.csv";
export const CATEGORIES_CSV_FILENAME = "menu_categories.csv";

const VALID_PLANNER_GROUPS = new Set(["savory", "sweet", "entree", "other"]);
const VALID_PRICING_TEMPLATES = new Set(["per_unit", "pan_sizes"]);

// ─── Field type definitions ────────────────────────────────────────────────
type FieldType =
  | "string"
  | "string_required"
  | "string_nullable"
  | "int"
  | "int_nullable"
  | "decimal"          // stored as string in DB, validated as number
  | "decimal_nullable"
  | "bool"
  | "list"             // string[] using `|` separator
  | "enum";

interface FieldSpec<TKey extends string> {
  key: TKey;
  column: string;       // CSV header name
  type: FieldType;
  default?: unknown;    // schema default for new rows when blank
  enumValues?: Set<string>;
}

// Field types that may legally be set to null in the DB. Any other type
// must reject the `__CLEAR__` sentinel during diff because writing NULL
// would violate a NOT NULL constraint.
const TYPE_IS_NULLABLE: ReadonlySet<FieldType> = new Set<FieldType>([
  "string_nullable",
  "int_nullable",
  "decimal_nullable",
]);

// ─── Items schema ──────────────────────────────────────────────────────────
type ItemKey = keyof MenuItem;
const ITEM_FIELDS: FieldSpec<ItemKey>[] = [
  { key: "id",                column: "id",                type: "int_nullable" },
  { key: "name",              column: "name",              type: "string_required" },
  { key: "description",       column: "description",       type: "string_required" },
  { key: "category",          column: "category",          type: "string_required" },
  { key: "price",             column: "price",             type: "decimal", default: "0" },
  { key: "servingSize",       column: "serving_size",      type: "int", default: 1 },
  { key: "unit",              column: "unit",              type: "string", default: "tray" },
  { key: "imageUrl",          column: "image_url",         type: "string_nullable", default: null },
  { key: "allergens",         column: "allergens",         type: "list", default: [] },
  { key: "available",         column: "available",         type: "bool", default: true },
  { key: "prepTime",          column: "prep_time",         type: "string_nullable", default: null },
  { key: "minimumOrderQty",   column: "minimum_order_qty", type: "int", default: 1 },
  { key: "tier2Qty",          column: "tier2_qty",         type: "int_nullable", default: null },
  { key: "tier2Price",        column: "tier2_price",       type: "decimal_nullable", default: null },
  { key: "tier3Qty",          column: "tier3_qty",         type: "int_nullable", default: null },
  { key: "tier3Price",        column: "tier3_price",       type: "decimal_nullable", default: null },
  { key: "eventActive",       column: "event_active",      type: "bool", default: false },
  { key: "eventStock",        column: "event_stock",       type: "int_nullable", default: null },
  { key: "eventTakerVisible", column: "event_taker_visible", type: "bool", default: false },
  { key: "eventTakerPrice",   column: "event_taker_price", type: "decimal_nullable", default: null },
  { key: "pricingTemplate",   column: "pricing_template",  type: "enum",
    enumValues: VALID_PRICING_TEMPLATES, default: "per_unit" },
  { key: "size1Label",        column: "size1_label",       type: "string_nullable", default: "Small Pan" },
  { key: "size1Servings",     column: "size1_servings",    type: "int_nullable", default: 15 },
  { key: "size1Price",        column: "size1_price",       type: "decimal_nullable", default: null },
  { key: "size2Label",        column: "size2_label",       type: "string_nullable", default: "Medium Pan" },
  { key: "size2Servings",     column: "size2_servings",    type: "int_nullable", default: 30 },
  { key: "size2Price",        column: "size2_price",       type: "decimal_nullable", default: null },
  { key: "size3Label",        column: "size3_label",       type: "string_nullable", default: "Large Pan" },
  { key: "size3Servings",     column: "size3_servings",    type: "int_nullable", default: 45 },
  { key: "size3Price",        column: "size3_price",       type: "decimal_nullable", default: null },
  { key: "size4Label",        column: "size4_label",       type: "string_nullable", default: null },
  { key: "size4Servings",     column: "size4_servings",    type: "int_nullable", default: null },
  { key: "size4Price",        column: "size4_price",       type: "decimal_nullable", default: null },
  { key: "size5Label",        column: "size5_label",       type: "string_nullable", default: null },
  { key: "size5Servings",     column: "size5_servings",    type: "int_nullable", default: null },
  { key: "size5Price",        column: "size5_price",       type: "decimal_nullable", default: null },
  { key: "internalNotes",     column: "internal_notes",    type: "string_nullable", default: null },
  // Note: `lowStockAlertSent` and `createdAt` are intentionally excluded —
  // they are runtime/system state (alert deduplication and insertion time),
  // not admin-configurable. See lib/db/src/schema/menu-items.ts.
];

// ─── Categories schema ─────────────────────────────────────────────────────
type CategoryKey = keyof MenuCategory;
const CATEGORY_FIELDS: FieldSpec<CategoryKey>[] = [
  { key: "id",           column: "id",            type: "int_nullable" },
  { key: "name",         column: "name",          type: "string_required" },
  { key: "sortOrder",    column: "sort_order",    type: "int", default: 0 },
  { key: "visible",      column: "visible",       type: "bool", default: true },
  { key: "plannerGroup", column: "planner_group", type: "enum",
    enumValues: VALID_PLANNER_GROUPS, default: "other" },
];

export const ITEM_COLUMNS = ITEM_FIELDS.map((f) => f.column);
export const CATEGORY_COLUMNS = CATEGORY_FIELDS.map((f) => f.column);

// ─── Serialization helpers ─────────────────────────────────────────────────
function decimalToCsv(v: string | number | null | undefined): string {
  if (v === null || v === undefined || v === "") return "";
  const n = typeof v === "string" ? parseFloat(v) : v;
  if (!isFinite(n)) return "";
  return n.toFixed(2);
}

function fieldToCsv(field: FieldSpec<string>, raw: unknown): string {
  if (raw === null || raw === undefined) {
    if (field.type === "list") return "";
    return "";
  }
  switch (field.type) {
    case "int":
    case "int_nullable":
      return raw === "" ? "" : String(raw);
    case "decimal":
    case "decimal_nullable":
      return decimalToCsv(raw as string | number | null | undefined);
    case "bool":
      return raw ? "true" : "false";
    case "list":
      return Array.isArray(raw) ? raw.join("|") : String(raw);
    case "enum":
    case "string":
    case "string_required":
    case "string_nullable":
      return String(raw);
  }
}

export function itemToCsvRow(item: MenuItem): Record<string, string> {
  const row: Record<string, string> = {};
  for (const f of ITEM_FIELDS) {
    row[f.column] = fieldToCsv(f, (item as Record<string, unknown>)[f.key]);
  }
  return row;
}

export function categoryToCsvRow(cat: MenuCategory): Record<string, string> {
  const row: Record<string, string> = {};
  for (const f of CATEGORY_FIELDS) {
    row[f.column] = fieldToCsv(f, (cat as Record<string, unknown>)[f.key]);
  }
  return row;
}

// ─── CSV parser/serializer (RFC 4180-ish) ──────────────────────────────────
function csvEscape(v: string): string {
  if (/[",\r\n]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
}

export function rowsToCsv(columns: string[], rows: Record<string, string>[]): string {
  const lines: string[] = [];
  lines.push(columns.map(csvEscape).join(","));
  for (const r of rows) {
    lines.push(columns.map((c) => csvEscape(r[c] ?? "")).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}

/**
 * Parse a CSV string into an array of objects keyed by header.
 * - Strips a leading UTF-8 BOM
 * - Supports quoted fields with embedded commas, quotes, and newlines
 * - Skips fully blank lines
 */
export function parseCsv(csv: string): { headers: string[]; rows: Record<string, string>[] } {
  // Strip BOM
  if (csv.charCodeAt(0) === 0xfeff) csv = csv.slice(1);

  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  let i = 0;
  const n = csv.length;
  while (i < n) {
    const ch = csv[i];
    if (inQuotes) {
      if (ch === '"') {
        if (csv[i + 1] === '"') { cell += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      cell += ch; i++; continue;
    }
    if (ch === '"') { inQuotes = true; i++; continue; }
    if (ch === ",") { row.push(cell); cell = ""; i++; continue; }
    if (ch === "\r") {
      // Treat CRLF or CR as a row terminator
      if (csv[i + 1] === "\n") i += 2; else i++;
      row.push(cell); cell = "";
      rows.push(row); row = [];
      continue;
    }
    if (ch === "\n") {
      row.push(cell); cell = "";
      rows.push(row); row = [];
      i++; continue;
    }
    cell += ch; i++;
  }
  // Flush the trailing field/row
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }

  // Skip fully blank rows (all cells empty)
  const cleanedRows = rows.filter((r) => r.some((c) => c !== ""));
  if (cleanedRows.length === 0) return { headers: [], rows: [] };

  const headers = cleanedRows[0].map((h) => h.trim());
  const out: Record<string, string>[] = [];
  for (let j = 1; j < cleanedRows.length; j++) {
    const r = cleanedRows[j];
    const obj: Record<string, string> = {};
    for (let k = 0; k < headers.length; k++) {
      obj[headers[k]] = r[k] ?? "";
    }
    out.push(obj);
  }
  return { headers, rows: out };
}

// ─── Per-cell parser ───────────────────────────────────────────────────────
export type ParsedCell =
  | { kind: "blank" }
  | { kind: "clear" }
  | { kind: "value"; value: string | number | boolean | string[] | null }
  | { kind: "error"; message: string };

function parseCell(field: FieldSpec<string>, raw: string): ParsedCell {
  const trimmed = raw.trim();
  if (trimmed === "") return { kind: "blank" };
  if (trimmed === CLEAR_SENTINEL) return { kind: "clear" };

  switch (field.type) {
    case "string":
    case "string_required":
    case "string_nullable":
      return { kind: "value", value: raw }; // preserve internal whitespace
    case "int":
    case "int_nullable": {
      if (!/^-?\d+$/.test(trimmed)) return { kind: "error", message: `${field.column} must be a whole number` };
      return { kind: "value", value: parseInt(trimmed, 10) };
    }
    case "decimal":
    case "decimal_nullable": {
      if (!/^-?\d+(\.\d+)?$/.test(trimmed)) return { kind: "error", message: `${field.column} must be a number` };
      const n = parseFloat(trimmed);
      if (!isFinite(n)) return { kind: "error", message: `${field.column} must be a number` };
      return { kind: "value", value: n };
    }
    case "bool": {
      const t = trimmed.toLowerCase();
      if (["true", "1", "yes", "y"].includes(t)) return { kind: "value", value: true };
      if (["false", "0", "no", "n"].includes(t)) return { kind: "value", value: false };
      return { kind: "error", message: `${field.column} must be true or false` };
    }
    case "list": {
      // "|"-separated list. Empty string already handled (blank).
      return { kind: "value", value: trimmed.split("|").map((s) => s.trim()).filter(Boolean) };
    }
    case "enum": {
      if (!field.enumValues?.has(trimmed)) {
        return {
          kind: "error",
          message: `${field.column} must be one of: ${[...(field.enumValues ?? [])].join(", ")}`,
        };
      }
      return { kind: "value", value: trimmed };
    }
  }
}

// ─── Diff types ────────────────────────────────────────────────────────────
export type RowStatus = "new" | "updated" | "unchanged" | "missing" | "error";

export interface FieldChange {
  column: string;
  before: string;     // CSV-formatted current value
  after: string;      // CSV-formatted intended value
}

export interface DiffRow {
  rowIndex: number;            // 1-based index in the CSV (excluding header)
  status: RowStatus;
  id: number | null;           // resolved id (existing or null for new)
  displayName: string;         // user-friendly identifier (name, fallback to id)
  changes: FieldChange[];      // empty for new/unchanged/missing
  newValues?: Record<string, unknown>; // for new rows: the resolved insert payload
  updates?: Record<string, unknown>;   // for changed rows: the resolved update payload
  errors: string[];
}

export interface MissingRow {
  id: number;
  displayName: string;
}

export interface DiffSection {
  rows: DiffRow[];
  missing: MissingRow[];        // rows in DB but not in CSV
  unknownColumns: string[];     // headers in CSV not recognized
  parseError?: string;          // top-level parse error (file unreadable etc.)
}

export interface MenuDiff {
  categories: DiffSection;
  items: DiffSection;
  summary: {
    categoriesNew: number;
    categoriesChanged: number;
    categoriesUnchanged: number;
    categoriesMissing: number;
    categoriesErrors: number;
    itemsNew: number;
    itemsChanged: number;
    itemsUnchanged: number;
    itemsMissing: number;
    itemsErrors: number;
  };
}

// ─── Diff computation ──────────────────────────────────────────────────────
function valuesEqual(a: unknown, b: unknown, type: FieldType): boolean {
  if (a === null || a === undefined) a = null;
  if (b === null || b === undefined) b = null;
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  switch (type) {
    case "decimal":
    case "decimal_nullable": {
      const an = typeof a === "string" ? parseFloat(a) : (a as number);
      const bn = typeof b === "string" ? parseFloat(b) : (b as number);
      return Math.abs(an - bn) < 1e-9;
    }
    case "int":
    case "int_nullable":
      return Number(a) === Number(b);
    case "bool":
      return Boolean(a) === Boolean(b);
    case "list": {
      const aa = Array.isArray(a) ? a : [];
      const bb = Array.isArray(b) ? b : [];
      if (aa.length !== bb.length) return false;
      for (let i = 0; i < aa.length; i++) if (aa[i] !== bb[i]) return false;
      return true;
    }
    default:
      return String(a) === String(b);
  }
}

function dbValueForField(row: Record<string, unknown>, field: FieldSpec<string>): unknown {
  const v = row[field.key];
  if (v === undefined) return null;
  return v;
}

function applyValueForUpdate(field: FieldSpec<string>, value: unknown): unknown {
  // Convert parsed CSV value into the shape drizzle expects on insert/update.
  if (value === null) return null;
  switch (field.type) {
    case "decimal":
    case "decimal_nullable":
      return String(value);
    default:
      return value;
  }
}

function effectiveDefault(field: FieldSpec<string>): unknown {
  return field.default !== undefined ? field.default : null;
}

// Resolve what `__CLEAR__` means for a given field type.
//   - nullable scalars  → null (the column truly becomes empty)
//   - list              → []   (an empty multi-select)
//   - bool / int / decimal / enum / string with a schema default
//                        → reset to that default
//   - required string with no default (name, description, category)
//                        → cannot be cleared; caller must surface a row error
//
// Returns `{ ok: true, value }` if the clear is legal, else `{ ok: false }`.
function clearedValueFor(field: FieldSpec<string>):
  | { ok: true; value: unknown }
  | { ok: false } {
  if (TYPE_IS_NULLABLE.has(field.type)) return { ok: true, value: null };
  if (field.type === "list") return { ok: true, value: [] };
  if (field.default !== undefined) return { ok: true, value: field.default };
  return { ok: false };
}

function diffSection<T extends { id: number }>(
  fields: FieldSpec<string>[],
  csvRows: Record<string, string>[],
  csvHeaders: string[],
  dbRows: T[],
  identifyId: (r: T) => number,
  displayName: (r: T) => string,
  rowDisplay: (parsed: Record<string, unknown>) => string,
  validateRow?: (parsed: Record<string, unknown>, errors: string[]) => void,
): DiffSection {
  const section: DiffSection = { rows: [], missing: [], unknownColumns: [] };
  const known = new Set(fields.map((f) => f.column));
  for (const h of csvHeaders) {
    if (h && !known.has(h)) section.unknownColumns.push(h);
  }

  const dbById = new Map<number, T>();
  for (const r of dbRows) dbById.set(identifyId(r), r);
  const seenIds = new Set<number>();
  const seenDuplicateIds = new Set<number>();

  for (let i = 0; i < csvRows.length; i++) {
    const csvRow = csvRows[i];
    const errors: string[] = [];
    const intent: Record<string, unknown> = {};
    const cellResults: Record<string, ParsedCell> = {};

    // Parse every known column
    for (const f of fields) {
      const cell = parseCell(f, csvRow[f.column] ?? "");
      cellResults[f.column] = cell;
      if (cell.kind === "error") errors.push(cell.message);
      // __CLEAR__ semantics — see clearedValueFor(). Only the few required
      // string fields without a schema default (name/description/category)
      // are unclearable.
      if (cell.kind === "clear" && !clearedValueFor(f).ok) {
        errors.push(`${f.column} cannot be cleared (it is required and has no default)`);
      }
    }

    // Resolve id
    const idCell = cellResults["id"];
    let id: number | null = null;
    if (idCell.kind === "value") id = idCell.value as number;

    if (id !== null) {
      if (seenIds.has(id)) {
        seenDuplicateIds.add(id);
        errors.push(`Duplicate id ${id} appears more than once in this file`);
      }
      seenIds.add(id);
    }

    const dbRow = id !== null ? dbById.get(id) ?? null : null;
    const isNew = id === null;
    const isUpdate = id !== null && dbRow !== null;
    const isOrphan = id !== null && dbRow === null;

    if (isOrphan) {
      errors.push(`Row references id ${id} which does not exist in the database`);
    }

    // Build the "intent" payload (only fields that should be applied).
    const changes: FieldChange[] = [];

    if (isNew) {
      // For new rows: blank → use schema default; __CLEAR__ → cleared value
      // (null / [] / schema default per type); else parsed value.
      for (const f of fields) {
        if (f.key === "id") continue;
        const c = cellResults[f.column];
        if (c.kind === "error") continue;
        let v: unknown;
        if (c.kind === "blank") {
          v = effectiveDefault(f);
        } else if (c.kind === "clear") {
          const cleared = clearedValueFor(f);
          if (!cleared.ok) continue; // already pushed to errors above
          v = cleared.value;
        } else {
          v = c.value;
        }
        intent[f.key] = applyValueForUpdate(f, v);
      }
    } else if (isUpdate) {
      // For existing rows: only fields that change.
      for (const f of fields) {
        if (f.key === "id") continue;
        const c = cellResults[f.column];
        if (c.kind === "error" || c.kind === "blank") continue;
        let newRaw: unknown;
        if (c.kind === "clear") {
          const cleared = clearedValueFor(f);
          if (!cleared.ok) continue; // already pushed to errors above
          newRaw = cleared.value;
        } else {
          newRaw = c.value;
        }
        const currentRaw = dbValueForField(dbRow as unknown as Record<string, unknown>, f);
        if (!valuesEqual(currentRaw, newRaw, f.type)) {
          intent[f.key] = applyValueForUpdate(f, newRaw);
          changes.push({
            column: f.column,
            before: fieldToCsv(f, currentRaw),
            after: fieldToCsv(f, newRaw),
          });
        }
      }
    }

    // Required field validation for new rows
    if (isNew && errors.length === 0) {
      for (const f of fields) {
        if (f.type === "string_required") {
          const v = intent[f.key];
          if (v === null || v === undefined || String(v).trim() === "") {
            errors.push(`${f.column} is required for new rows`);
          }
        }
      }
    }

    // Caller-supplied cross-field validation (e.g. category exists)
    if (validateRow && (isNew || isUpdate)) {
      const merged: Record<string, unknown> = {};
      // Start from DB row for updates, then layer intent on top.
      if (isUpdate && dbRow) {
        for (const f of fields) merged[f.key] = (dbRow as unknown as Record<string, unknown>)[f.key];
      }
      Object.assign(merged, intent);
      validateRow(merged, errors);
    }

    let status: RowStatus;
    if (errors.length > 0) status = "error";
    else if (isNew) status = "new";
    else if (isUpdate && changes.length > 0) status = "updated";
    else status = "unchanged";

    const row: DiffRow = {
      rowIndex: i + 1,
      status,
      id: dbRow ? identifyId(dbRow) : id,
      displayName: dbRow ? displayName(dbRow) : rowDisplay(intent),
      changes,
      errors,
    };
    if (isNew && status === "new") row.newValues = intent;
    if (status === "updated") row.updates = intent;
    section.rows.push(row);
  }

  // Find missing rows (in DB but not in CSV by id)
  for (const r of dbRows) {
    const id = identifyId(r);
    if (!seenIds.has(id)) {
      section.missing.push({ id, displayName: displayName(r) });
    }
  }

  return section;
}

export function computeMenuDiff(input: {
  itemsCsv: string | null;
  categoriesCsv: string | null;
  dbItems: MenuItem[];
  dbCategories: MenuCategory[];
}): MenuDiff {
  const { itemsCsv, categoriesCsv, dbItems, dbCategories } = input;

  // ── Categories first so item rows can reference newly-created names ──
  const pendingCategoryNames = new Set<string>();
  let categoriesSection: DiffSection = { rows: [], missing: [], unknownColumns: [] };
  if (categoriesCsv !== null) {
    let parsed: { headers: string[]; rows: Record<string, string>[] };
    try {
      parsed = parseCsv(categoriesCsv);
    } catch (e) {
      categoriesSection = {
        rows: [], missing: [], unknownColumns: [],
        parseError: e instanceof Error ? e.message : String(e),
      };
      parsed = { headers: [], rows: [] };
    }
    if (!categoriesSection.parseError) {
      categoriesSection = diffSection(
        CATEGORY_FIELDS as FieldSpec<string>[],
        parsed.rows,
        parsed.headers,
        dbCategories,
        (c) => c.id,
        (c) => c.name,
        (parsedRow) => String(parsedRow.name ?? "(unnamed)"),
      );
      // Detect duplicate names within the CSV and against the DB.
      const nameCounts = new Map<string, number>();
      for (const r of categoriesSection.rows) {
        const intent = r.newValues ?? r.updates ?? {};
        const nm = String((intent as Record<string, unknown>).name ?? "").trim();
        if (nm) nameCounts.set(nm, (nameCounts.get(nm) ?? 0) + 1);
      }
      for (const r of categoriesSection.rows) {
        const intent = r.newValues ?? r.updates;
        if (!intent || (intent as Record<string, unknown>).name === undefined) continue;
        const nm = String((intent as Record<string, unknown>).name).trim();
        if (!nm) continue;
        if ((nameCounts.get(nm) ?? 0) > 1) {
          r.errors.push(`Duplicate category name "${nm}" appears in this file`);
          if (r.status !== "error") r.status = "error";
        }
        const dbConflict = dbCategories.find((c) => c.name === nm && c.id !== r.id);
        if (dbConflict) {
          r.errors.push(`Category name "${nm}" is already used by id ${dbConflict.id}`);
          if (r.status !== "error") r.status = "error";
        }
        if (r.status === "new" || r.status === "updated") pendingCategoryNames.add(nm);
      }
    }
  }

  // Known categories = existing DB names plus any being created in this same import.
  const knownCategoryNames = new Set<string>(dbCategories.map((c) => c.name));
  for (const nm of pendingCategoryNames) knownCategoryNames.add(nm);

  let itemsSection: DiffSection = { rows: [], missing: [], unknownColumns: [] };
  if (itemsCsv !== null) {
    let parsed: { headers: string[]; rows: Record<string, string>[] };
    try {
      parsed = parseCsv(itemsCsv);
    } catch (e) {
      itemsSection = {
        rows: [], missing: [], unknownColumns: [],
        parseError: e instanceof Error ? e.message : String(e),
      };
      parsed = { headers: [], rows: [] };
    }
    if (!itemsSection.parseError) {
      itemsSection = diffSection(
        ITEM_FIELDS as FieldSpec<string>[],
        parsed.rows,
        parsed.headers,
        dbItems,
        (i) => i.id,
        (i) => i.name,
        (parsedRow) => String(parsedRow.name ?? "(unnamed)"),
        (parsedRow, errors) => {
          const cat = parsedRow.category;
          if (cat !== undefined && cat !== null) {
            const cname = String(cat).trim();
            if (cname && !knownCategoryNames.has(cname)) {
              errors.push(`Unknown category "${cname}" — add it to menu_categories.csv first`);
            }
          }
        },
      );
    }
  }

  const sum = {
    categoriesNew: 0, categoriesChanged: 0, categoriesUnchanged: 0,
    categoriesMissing: categoriesSection.missing.length, categoriesErrors: 0,
    itemsNew: 0, itemsChanged: 0, itemsUnchanged: 0,
    itemsMissing: itemsSection.missing.length, itemsErrors: 0,
  };
  for (const r of categoriesSection.rows) {
    if (r.status === "new") sum.categoriesNew++;
    else if (r.status === "updated") sum.categoriesChanged++;
    else if (r.status === "unchanged") sum.categoriesUnchanged++;
    else if (r.status === "error") sum.categoriesErrors++;
  }
  for (const r of itemsSection.rows) {
    if (r.status === "new") sum.itemsNew++;
    else if (r.status === "updated") sum.itemsChanged++;
    else if (r.status === "unchanged") sum.itemsUnchanged++;
    else if (r.status === "error") sum.itemsErrors++;
  }

  return {
    categories: categoriesSection,
    items: itemsSection,
    summary: sum,
  };
}

// ─── Template generation ───────────────────────────────────────────────────
export function blankItemsCsv(): string {
  return rowsToCsv(ITEM_COLUMNS, []);
}

export function blankCategoriesCsv(): string {
  return rowsToCsv(CATEGORY_COLUMNS, []);
}

// ─── Field metadata for the help panel ─────────────────────────────────────
export const ITEM_FIELD_DOCS = ITEM_FIELDS.map((f) => ({ column: f.column, type: f.type }));
export const CATEGORY_FIELD_DOCS = CATEGORY_FIELDS.map((f) => ({ column: f.column, type: f.type }));
