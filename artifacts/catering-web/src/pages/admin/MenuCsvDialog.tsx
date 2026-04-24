import { useState, useMemo, useRef, useCallback, useEffect } from "react";
import { X, Upload, FileText, Download, Loader2, AlertCircle, ChevronDown, ChevronRight, HelpCircle, CheckCircle2, AlertTriangle } from "lucide-react";
import { getAdminToken } from "@/components/AdminGuard";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

type RowStatus = "new" | "updated" | "unchanged" | "missing" | "error";

interface FieldChange {
  column: string;
  before: string;
  after: string;
}

interface DiffRow {
  rowIndex: number;
  status: RowStatus;
  id: number | null;
  displayName: string;
  changes: FieldChange[];
  errors: string[];
}

interface MissingRow {
  id: number;
  displayName: string;
}

interface DiffSection {
  rows: DiffRow[];
  missing: MissingRow[];
  unknownColumns: string[];
  parseError?: string;
}

interface MenuDiff {
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

interface DiffResponse {
  diff: MenuDiff;
  warnings: string[];
  hadItemsCsv: boolean;
  hadCategoriesCsv: boolean;
  sources: { itemsCsv: string | null; categoriesCsv: string | null };
}

interface ApplyResult {
  categoriesCreated: number;
  categoriesUpdated: number;
  categoriesDeleted: number;
  itemsCreated: number;
  itemsUpdated: number;
  itemsDeleted: number;
}

const STATUS_BADGE: Record<RowStatus, { label: string; className: string }> = {
  new:       { label: "New",       className: "bg-emerald-100 text-emerald-800 border-emerald-200" },
  updated:   { label: "Changed",   className: "bg-amber-100 text-amber-800 border-amber-200" },
  unchanged: { label: "Unchanged", className: "bg-secondary text-muted-foreground border-border" },
  missing:   { label: "Missing",   className: "bg-rose-100 text-rose-800 border-rose-200" },
  error:     { label: "Error",     className: "bg-red-100 text-red-900 border-red-300" },
};

export function MenuCsvDialog({
  onClose,
  onApplied,
}: {
  onClose: () => void;
  onApplied: (result: ApplyResult) => void;
}) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [diffResp, setDiffResp] = useState<DiffResponse | null>(null);

  const [showHelp, setShowHelp] = useState(false);
  const [helpDoc, setHelpDoc] = useState<{
    itemsColumns: { column: string; type: string }[];
    categoriesColumns: { column: string; type: string }[];
  } | null>(null);
  useEffect(() => {
    if (!showHelp || helpDoc) return;
    fetch(`${BASE}/api/admin/menu/csv/help`, {
      headers: { Authorization: `Bearer ${getAdminToken()}` },
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d && setHelpDoc({ itemsColumns: d.itemsColumns ?? [], categoriesColumns: d.categoriesColumns ?? [] }))
      .catch(() => {});
  }, [showHelp, helpDoc]);
  const [showUnchanged, setShowUnchanged] = useState(false);
  const [deleteMissingItems, setDeleteMissingItems] = useState(false);
  const [deleteMissingCategories, setDeleteMissingCategories] = useState(false);
  const [selectedItemIdx, setSelectedItemIdx] = useState<Set<number>>(new Set());
  const [selectedCatIdx, setSelectedCatIdx] = useState<Set<number>>(new Set());
  const [selectedDeleteItems, setSelectedDeleteItems] = useState<Set<number>>(new Set());
  const [selectedDeleteCats, setSelectedDeleteCats] = useState<Set<number>>(new Set());
  const [applying, setApplying] = useState(false);

  const handleFiles = (list: FileList | null) => {
    if (!list) return;
    setFiles(Array.from(list));
    setDiffResp(null);
    setError(null);
  };

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    handleFiles(e.dataTransfer.files);
  }, []);

  const computeDiff = async () => {
    if (files.length === 0) {
      setError("Pick a zip file or one/two CSV files first.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const fd = new FormData();
      for (const f of files) fd.append("file", f);
      const res = await fetch(`${BASE}/api/admin/menu/csv/diff`, {
        method: "POST",
        headers: { Authorization: `Bearer ${getAdminToken()}` },
        body: fd,
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? `Upload failed (${res.status})`);
      }
      const data: DiffResponse = await res.json();
      setDiffResp(data);
      // Default-select all applyable rows (new + updated, no errors).
      const presel = (rows: DiffRow[]) =>
        new Set(rows.filter((r) => (r.status === "new" || r.status === "updated") && r.errors.length === 0).map((r) => r.rowIndex));
      setSelectedCatIdx(presel(data.diff.categories.rows));
      setSelectedItemIdx(presel(data.diff.items.rows));
      // Missing-row deletion checkboxes always start empty.
      setSelectedDeleteItems(new Set());
      setSelectedDeleteCats(new Set());
      setDeleteMissingItems(false);
      setDeleteMissingCategories(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  const apply = async () => {
    if (!diffResp) return;
    setApplying(true);
    setError(null);
    try {
      const res = await fetch(`${BASE}/api/admin/menu/csv/apply`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${getAdminToken()}`,
        },
        body: JSON.stringify({
          itemsCsv: diffResp.sources.itemsCsv,
          categoriesCsv: diffResp.sources.categoriesCsv,
          selectedCategoryRowIndexes: [...selectedCatIdx],
          selectedItemRowIndexes: [...selectedItemIdx],
          deleteMissingCategoryIds: deleteMissingCategories ? [...selectedDeleteCats] : [],
          deleteMissingItemIds: deleteMissingItems ? [...selectedDeleteItems] : [],
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        const detail = Array.isArray(j.details) ? "\n\n" + j.details.join("\n") : "";
        throw new Error((j.error ?? `Apply failed (${res.status})`) + detail);
      }
      const result: ApplyResult = await res.json();
      onApplied(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setApplying(false);
    }
  };

  const itemRows = diffResp?.diff.items.rows ?? [];
  const catRows = diffResp?.diff.categories.rows ?? [];
  const sum = diffResp?.diff.summary;

  const applyableItems = useMemo(
    () => itemRows.filter((r) => (r.status === "new" || r.status === "updated") && r.errors.length === 0),
    [itemRows],
  );
  const applyableCats = useMemo(
    () => catRows.filter((r) => (r.status === "new" || r.status === "updated") && r.errors.length === 0),
    [catRows],
  );

  return (
    <div className="fixed inset-0 z-[55] flex items-center justify-center p-4 bg-foreground/30 backdrop-blur-sm">
      <div className="bg-card w-full max-w-6xl rounded-3xl shadow-2xl overflow-hidden max-h-[92vh] flex flex-col">
        <div className="px-6 py-4 border-b border-border flex justify-between items-center bg-secondary/30 shrink-0">
          <div>
            <h2 className="font-display font-bold text-2xl">Import menu from CSV</h2>
            <p className="text-sm text-muted-foreground">Drop a zip (or one/two CSV files), preview the diff, then apply only the changes you choose.</p>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-secondary rounded-full">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="overflow-y-auto p-6 flex-1">
          {/* Upload zone */}
          {!diffResp && (
            <>
              <div
                onDragOver={(e) => e.preventDefault()}
                onDrop={onDrop}
                className="border-2 border-dashed border-border rounded-2xl p-8 text-center bg-secondary/20"
              >
                <Upload className="w-10 h-10 mx-auto mb-3 text-muted-foreground" />
                <p className="font-semibold mb-1">Drop the zip or CSV file(s) here</p>
                <p className="text-sm text-muted-foreground mb-4">
                  Accepted: <code>menu-export.zip</code>, <code>menu_items.csv</code>, <code>menu_categories.csv</code>
                </p>
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  accept=".zip,.csv,application/zip,text/csv"
                  className="hidden"
                  onChange={(e) => handleFiles(e.target.files)}
                />
                <button
                  onClick={() => fileInputRef.current?.click()}
                  className="px-4 py-2 bg-secondary hover:bg-secondary/70 rounded-xl text-sm font-semibold"
                >
                  Browse files
                </button>
                {files.length > 0 && (
                  <ul className="mt-4 text-sm text-muted-foreground inline-block text-left">
                    {files.map((f) => (
                      <li key={f.name} className="flex items-center gap-2 justify-center">
                        <FileText className="w-4 h-4" /> {f.name} <span className="text-xs">({Math.round(f.size / 1024)} KB)</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div className="mt-4 flex items-center justify-between">
                <button
                  onClick={() => setShowHelp((s) => !s)}
                  className="text-sm text-muted-foreground hover:text-foreground flex items-center gap-1"
                >
                  <HelpCircle className="w-4 h-4" /> {showHelp ? "Hide" : "Show"} column help
                </button>
                <button
                  type="button"
                  className="text-sm text-primary hover:underline flex items-center gap-1"
                  onClick={async () => {
                    const r = await fetch(`${BASE}/api/admin/menu/csv/template.zip`, {
                      headers: { Authorization: `Bearer ${getAdminToken()}` },
                    });
                    if (!r.ok) return;
                    const blob = await r.blob();
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement("a");
                    a.href = url; a.download = "menu-template.zip"; a.click();
                    URL.revokeObjectURL(url);
                  }}
                >
                  <Download className="w-4 h-4" /> Download blank template
                </button>
              </div>

              {showHelp && (
                <div className="mt-4 p-4 bg-secondary/30 rounded-xl text-sm space-y-2">
                  <p><b>How rows are matched:</b> the <code>id</code> column. Blank id → create a new record. Existing id → update. Unknown id → error.</p>
                  <p><b>Blank cells</b> on existing rows mean "leave this field unchanged" (so you can edit one column without touching others). On new rows they fall back to schema defaults.</p>
                  <p><b><code>__CLEAR__</code></b> in any cell resets that field — to empty for nullable columns and lists, or to the schema default for everything else. The only exceptions are <code>name</code>, <code>description</code> and <code>category</code>, which are always required.</p>
                  <p><b>List fields</b> (e.g. <code>allergens</code>) use <code>|</code> as the separator — e.g. <code>Nuts|Dairy</code>.</p>
                  <p><b>Booleans</b> accept <code>true</code> / <code>false</code>.</p>
                  <p><b>Categories run first.</b> Item rows can reference any category being created in the same import.</p>
                  {helpDoc && (
                    <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div>
                        <div className="font-semibold mb-1">menu_items.csv columns</div>
                        <ul className="space-y-0.5 text-xs font-mono">
                          {helpDoc.itemsColumns.map((c) => (
                            <li key={c.column} className="flex justify-between gap-2">
                              <span>{c.column}</span>
                              <span className="text-muted-foreground">{c.type}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                      <div>
                        <div className="font-semibold mb-1">menu_categories.csv columns</div>
                        <ul className="space-y-0.5 text-xs font-mono">
                          {helpDoc.categoriesColumns.map((c) => (
                            <li key={c.column} className="flex justify-between gap-2">
                              <span>{c.column}</span>
                              <span className="text-muted-foreground">{c.type}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {error && (
                <div className="mt-4 p-3 rounded-xl bg-red-50 border border-red-200 text-red-900 text-sm flex items-start gap-2">
                  <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" /> {error}
                </div>
              )}

              <div className="mt-6 flex justify-end gap-3">
                <button onClick={onClose} className="px-5 py-2 font-semibold text-muted-foreground hover:text-foreground">Cancel</button>
                <button
                  onClick={computeDiff}
                  disabled={loading || files.length === 0}
                  className="px-6 py-2 bg-primary text-primary-foreground font-semibold rounded-xl disabled:opacity-50 flex items-center gap-2"
                >
                  {loading && <Loader2 className="w-4 h-4 animate-spin" />} Preview diff
                </button>
              </div>
            </>
          )}

          {/* Diff preview */}
          {diffResp && sum && (
            <div className="space-y-6">
              {/* Summary */}
              <div className="flex flex-wrap items-center gap-3 p-4 bg-secondary/30 rounded-xl">
                <div className="text-sm font-semibold mr-auto">
                  {sum.itemsNew + sum.categoriesNew} new ·{" "}
                  {sum.itemsChanged + sum.categoriesChanged} changed ·{" "}
                  {(deleteMissingItems ? selectedDeleteItems.size : 0) + (deleteMissingCategories ? selectedDeleteCats.size : 0)} deletions pending ·{" "}
                  {sum.itemsUnchanged + sum.categoriesUnchanged} unchanged
                  {(sum.itemsErrors + sum.categoriesErrors) > 0 && (
                    <span className="ml-2 text-red-700">· {sum.itemsErrors + sum.categoriesErrors} errors</span>
                  )}
                </div>
                <button
                  onClick={() => { setDiffResp(null); setFiles([]); }}
                  className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-white border border-border hover:bg-secondary"
                >
                  Re-upload
                </button>
              </div>

              {diffResp.warnings.length > 0 && (
                <div className="p-3 rounded-xl bg-amber-50 border border-amber-200 text-amber-900 text-sm">
                  <div className="font-semibold flex items-center gap-1 mb-1"><AlertTriangle className="w-4 h-4" /> Notes</div>
                  <ul className="list-disc pl-5 space-y-0.5">
                    {diffResp.warnings.map((w, i) => <li key={i}>{w}</li>)}
                  </ul>
                </div>
              )}

              {/* Categories section */}
              {diffResp.hadCategoriesCsv && (
                <SectionView
                  label="Categories"
                  rows={catRows}
                  missing={diffResp.diff.categories.missing}
                  parseError={diffResp.diff.categories.parseError}
                  unknownColumns={diffResp.diff.categories.unknownColumns}
                  selected={selectedCatIdx}
                  setSelected={setSelectedCatIdx}
                  applyableCount={applyableCats.length}
                  applyableRows={applyableCats}
                  showUnchanged={showUnchanged}
                  setShowUnchanged={setShowUnchanged}
                  deleteMissing={deleteMissingCategories}
                  setDeleteMissing={setDeleteMissingCategories}
                  selectedDeleteIds={selectedDeleteCats}
                  setSelectedDeleteIds={setSelectedDeleteCats}
                />
              )}

              {/* Items section */}
              {diffResp.hadItemsCsv && (
                <SectionView
                  label="Menu items"
                  rows={itemRows}
                  missing={diffResp.diff.items.missing}
                  parseError={diffResp.diff.items.parseError}
                  unknownColumns={diffResp.diff.items.unknownColumns}
                  selected={selectedItemIdx}
                  setSelected={setSelectedItemIdx}
                  applyableCount={applyableItems.length}
                  applyableRows={applyableItems}
                  showUnchanged={showUnchanged}
                  setShowUnchanged={setShowUnchanged}
                  deleteMissing={deleteMissingItems}
                  setDeleteMissing={setDeleteMissingItems}
                  selectedDeleteIds={selectedDeleteItems}
                  setSelectedDeleteIds={setSelectedDeleteItems}
                />
              )}

              {error && (
                <div className="p-3 rounded-xl bg-red-50 border border-red-200 text-red-900 text-sm whitespace-pre-wrap">
                  {error}
                </div>
              )}
            </div>
          )}
        </div>

        {diffResp && (
          <div className="px-6 py-4 border-t border-border bg-secondary/30 flex justify-between items-center shrink-0">
            <div className="text-sm text-muted-foreground">
              Will apply: <b>{selectedCatIdx.size}</b> category {selectedCatIdx.size === 1 ? "row" : "rows"} ·{" "}
              <b>{selectedItemIdx.size}</b> item {selectedItemIdx.size === 1 ? "row" : "rows"}
              {deleteMissingCategories && selectedDeleteCats.size > 0 && <> · delete <b>{selectedDeleteCats.size}</b> categories</>}
              {deleteMissingItems && selectedDeleteItems.size > 0 && <> · delete <b>{selectedDeleteItems.size}</b> items</>}
            </div>
            <div className="flex gap-3">
              <button onClick={onClose} className="px-5 py-2 font-semibold text-muted-foreground hover:text-foreground">Cancel</button>
              <button
                onClick={apply}
                disabled={applying || (selectedCatIdx.size + selectedItemIdx.size + (deleteMissingCategories ? selectedDeleteCats.size : 0) + (deleteMissingItems ? selectedDeleteItems.size : 0)) === 0}
                className="px-6 py-2 bg-primary text-primary-foreground font-semibold rounded-xl disabled:opacity-50 flex items-center gap-2"
              >
                {applying && <Loader2 className="w-4 h-4 animate-spin" />} Apply selected
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function SectionView({
  label, rows, missing, parseError, unknownColumns,
  selected, setSelected, applyableRows, applyableCount,
  showUnchanged, setShowUnchanged,
  deleteMissing, setDeleteMissing,
  selectedDeleteIds, setSelectedDeleteIds,
}: {
  label: string;
  rows: DiffRow[];
  missing: MissingRow[];
  parseError?: string;
  unknownColumns: string[];
  selected: Set<number>;
  setSelected: (s: Set<number>) => void;
  applyableRows: DiffRow[];
  applyableCount: number;
  showUnchanged: boolean;
  setShowUnchanged: (b: boolean) => void;
  deleteMissing: boolean;
  setDeleteMissing: (b: boolean) => void;
  selectedDeleteIds: Set<number>;
  setSelectedDeleteIds: (s: Set<number>) => void;
}) {
  const counts = useMemo(() => {
    const c = { new: 0, updated: 0, unchanged: 0, error: 0 };
    for (const r of rows) c[r.status as keyof typeof c]++;
    return c;
  }, [rows]);

  const allSelected = applyableCount > 0 && applyableRows.every((r) => selected.has(r.rowIndex));
  const selectAll = () => setSelected(new Set(applyableRows.map((r) => r.rowIndex)));
  const selectNone = () => setSelected(new Set());

  const toggle = (key: number) => {
    const next = new Set(selected);
    if (next.has(key)) next.delete(key); else next.add(key);
    setSelected(next);
  };

  const toggleDelete = (id: number) => {
    const next = new Set(selectedDeleteIds);
    if (next.has(id)) next.delete(id); else next.add(id);
    setSelectedDeleteIds(next);
  };

  const visible = rows.filter((r) => (showUnchanged ? true : r.status !== "unchanged"));

  return (
    <div className="border border-border rounded-2xl overflow-hidden">
      <div className="px-4 py-3 bg-secondary/40 flex flex-wrap items-center gap-3">
        <h3 className="font-bold">{label}</h3>
        <span className="text-xs text-muted-foreground">
          {counts.new} new · {counts.updated} changed · {counts.unchanged} unchanged · {missing.length} missing
          {counts.error > 0 && <span className="text-red-700"> · {counts.error} errors</span>}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <button onClick={selectAll} disabled={allSelected} className="text-xs px-2 py-1 rounded-md border border-border bg-white hover:bg-secondary disabled:opacity-50">Select all</button>
          <button onClick={selectNone} className="text-xs px-2 py-1 rounded-md border border-border bg-white hover:bg-secondary">Select none</button>
        </div>
      </div>

      {parseError && (
        <div className="p-3 bg-red-50 border-t border-red-200 text-red-900 text-sm">
          <b>Could not parse:</b> {parseError}
        </div>
      )}
      {unknownColumns.length > 0 && (
        <div className="p-3 bg-amber-50 border-t border-amber-200 text-amber-900 text-xs">
          Unrecognized columns will be ignored: <code>{unknownColumns.join(", ")}</code>
        </div>
      )}

      <ul className="divide-y divide-border">
        {visible.map((r) => (
          <RowItem key={r.rowIndex} row={r} checked={selected.has(r.rowIndex)} onToggle={() => toggle(r.rowIndex)} />
        ))}
        {visible.length === 0 && rows.length > 0 && (
          <li className="px-4 py-3 text-sm text-muted-foreground italic">All rows unchanged — nothing to preview.</li>
        )}
      </ul>

      {!showUnchanged && rows.some((r) => r.status === "unchanged") && (
        <button
          onClick={() => setShowUnchanged(true)}
          className="w-full px-4 py-2 text-xs text-muted-foreground hover:text-foreground hover:bg-secondary/30 border-t border-border flex items-center justify-center gap-1"
        >
          <ChevronDown className="w-3 h-3" /> Show {counts.unchanged} unchanged
        </button>
      )}
      {showUnchanged && (
        <button
          onClick={() => setShowUnchanged(false)}
          className="w-full px-4 py-2 text-xs text-muted-foreground hover:text-foreground hover:bg-secondary/30 border-t border-border flex items-center justify-center gap-1"
        >
          <ChevronRight className="w-3 h-3" /> Hide unchanged
        </button>
      )}

      {missing.length > 0 && (
        <div className="p-4 border-t border-border bg-rose-50/30">
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={deleteMissing}
              onChange={(e) => setDeleteMissing(e.target.checked)}
              className="w-4 h-4 mt-0.5 accent-primary"
            />
            <span>
              <b>Delete missing rows</b>
              <span className="text-muted-foreground"> — {missing.length} row{missing.length === 1 ? "" : "s"} are in the database but not in this file.</span>
            </span>
          </label>
          {deleteMissing && (
            <ul className="mt-2 ml-6 space-y-1">
              {missing.map((m) => (
                <li key={m.id}>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={selectedDeleteIds.has(m.id)}
                      onChange={() => toggleDelete(m.id)}
                      className="w-4 h-4 accent-rose-600"
                    />
                    <span className="text-rose-900">#{m.id} — {m.displayName}</span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function RowItem({ row, checked, onToggle }: { row: DiffRow; checked: boolean; onToggle: () => void }) {
  const badge = STATUS_BADGE[row.status];
  const canApply = (row.status === "new" || row.status === "updated") && row.errors.length === 0;
  return (
    <li className={`px-4 py-3 ${row.status === "error" ? "bg-red-50/30" : ""}`}>
      <div className="flex items-start gap-3">
        <input
          type="checkbox"
          checked={checked}
          disabled={!canApply}
          onChange={onToggle}
          className="w-4 h-4 mt-1 accent-primary disabled:opacity-30"
        />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-semibold border ${badge.className}`}>
              {badge.label}
            </span>
            <span className="text-xs text-muted-foreground">row {row.rowIndex}</span>
            {row.id != null && <span className="text-xs text-muted-foreground">· id {row.id}</span>}
            <span className="font-semibold text-sm truncate">{row.displayName}</span>
          </div>
          {row.errors.length > 0 && (
            <ul className="mt-1.5 text-xs text-red-800 space-y-0.5">
              {row.errors.map((e, i) => (
                <li key={i} className="flex items-start gap-1">
                  <AlertCircle className="w-3 h-3 mt-0.5 shrink-0" /> {e}
                </li>
              ))}
            </ul>
          )}
          {row.changes.length > 0 && (
            <ul className="mt-1.5 text-xs space-y-0.5">
              {row.changes.map((c) => (
                <li key={c.column} className="font-mono">
                  <span className="text-muted-foreground">{c.column}:</span>{" "}
                  <span className="line-through text-red-700/80">{c.before || <i className="not-italic opacity-50">(blank)</i>}</span>{" "}
                  <span className="text-emerald-700">→ {c.after || <i className="not-italic opacity-50">(blank)</i>}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </li>
  );
}

export function ExportMenuButton() {
  const [busy, setBusy] = useState(false);
  return (
    <button
      onClick={async () => {
        setBusy(true);
        try {
          const r = await fetch(`${BASE}/api/admin/menu/csv/export.zip`, {
            headers: { Authorization: `Bearer ${getAdminToken()}` },
          });
          if (!r.ok) throw new Error(`Export failed (${r.status})`);
          const blob = await r.blob();
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          const stamp = new Date().toISOString().slice(0, 10);
          a.href = url; a.download = `menu-export_${stamp}.zip`; a.click();
          URL.revokeObjectURL(url);
        } catch (e) {
          alert(e instanceof Error ? e.message : String(e));
        } finally {
          setBusy(false);
        }
      }}
      disabled={busy}
      className="px-4 py-2.5 bg-secondary text-foreground font-semibold rounded-xl hover:bg-secondary/70 transition-colors flex items-center gap-2 disabled:opacity-50"
    >
      {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />} Export menu
    </button>
  );
}

export function AppliedToast({ result, onDone }: { result: ApplyResult; onDone: () => void }) {
  const total =
    result.categoriesCreated + result.categoriesUpdated + result.categoriesDeleted +
    result.itemsCreated + result.itemsUpdated + result.itemsDeleted;
  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[60] flex items-center gap-3 bg-emerald-600 text-white px-6 py-3.5 rounded-2xl shadow-2xl shadow-black/30">
      <CheckCircle2 className="w-5 h-5 shrink-0" />
      <div>
        <div className="font-semibold">Applied {total} change{total === 1 ? "" : "s"}</div>
        <div className="text-xs opacity-90">
          Categories: {result.categoriesCreated} new, {result.categoriesUpdated} updated, {result.categoriesDeleted} deleted ·
          Items: {result.itemsCreated} new, {result.itemsUpdated} updated, {result.itemsDeleted} deleted
        </div>
      </div>
      <button onClick={onDone} className="ml-3 text-white/80 hover:text-white">
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}
