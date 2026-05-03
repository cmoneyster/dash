import { useEffect, useMemo, useState } from "react";
import { AdminLayout } from "@/components/AdminLayout";
import { useQueryClient } from "@tanstack/react-query";
import {
  Loader2,
  GripVertical,
  Trash2,
  Plus,
  RefreshCcw,
  Search,
  X,
  AlertTriangle,
  Sparkles,
} from "lucide-react";
import { getAdminToken } from "@/components/AdminGuard";
import {
  RECOMMENDATIONS_QUERY_KEY,
  useAdminRecommendations,
  adminAddRecommendation,
  adminRemoveRecommendation,
  adminReorderRecommendations,
  adminFetchTopSellers,
  adminSyncRecommendations,
  type RecommendedItem,
  type TopSeller,
} from "@/lib/recommendations";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
  sortableKeyboardCoordinates,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

interface MinimalMenuItem {
  id: number;
  name: string;
  category: string;
  available: boolean;
}

function SortableRow({
  id,
  busy,
  children,
}: {
  id: number;
  busy: boolean;
  children: React.ReactNode;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
    disabled: busy,
  });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    background: isDragging ? "var(--card)" : undefined,
    position: isDragging ? "relative" : undefined,
    zIndex: isDragging ? 10 : undefined,
  };
  return (
    <tr ref={setNodeRef} style={style} data-testid={`row-rec-${id}`}>
      <td className="px-3 py-3 w-10">
        <button
          type="button"
          {...attributes}
          {...(busy ? {} : listeners)}
          disabled={busy}
          aria-label="Drag to reorder"
          title={busy ? "Saving…" : "Drag to reorder"}
          className={`p-1 rounded transition-colors ${
            busy
              ? "text-muted-foreground/30 cursor-not-allowed"
              : "text-muted-foreground hover:text-foreground hover:bg-secondary cursor-grab active:cursor-grabbing"
          }`}
          data-testid={`drag-handle-rec-${id}`}
        >
          <GripVertical className="w-4 h-4" />
        </button>
      </td>
      {children}
    </tr>
  );
}

export default function AiRecommendations() {
  const queryClient = useQueryClient();
  const { data: recs, isLoading } = useAdminRecommendations();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [showSyncModal, setShowSyncModal] = useState(false);
  const [showAddModal, setShowAddModal] = useState(false);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const sorted = useMemo(
    () => [...(recs ?? [])].sort((a, b) => a.sortOrder - b.sortOrder || a.menuItemId - b.menuItemId),
    [recs],
  );

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: RECOMMENDATIONS_QUERY_KEY });
  };

  function flashSuccess(msg: string) {
    setSuccess(msg);
    setError(null);
    setTimeout(() => setSuccess((s) => (s === msg ? null : s)), 4000);
  }

  async function handleRemove(menuItemId: number) {
    setBusy(true);
    setError(null);
    try {
      await adminRemoveRecommendation(menuItemId);
      invalidate();
      flashSuccess("Item removed from the recommended list.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const ids = sorted.map((r) => r.menuItemId);
    const oldIndex = ids.indexOf(Number(active.id));
    const newIndex = ids.indexOf(Number(over.id));
    if (oldIndex === -1 || newIndex === -1) return;
    const next = arrayMove(ids, oldIndex, newIndex);
    setBusy(true);
    setError(null);
    try {
      await adminReorderRecommendations(next);
      invalidate();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <AdminLayout>
      <div className="p-4 sm:p-8 max-w-5xl mx-auto">
        <div className="mb-6 flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h1 className="font-display font-bold text-2xl sm:text-3xl flex items-center gap-2">
              <Sparkles className="w-6 h-6 text-primary" />
              Chat Bot Recommendations
            </h1>
            <p className="text-muted-foreground text-sm mt-1 max-w-2xl">
              These items are what the chat bot recommends when guests ask
              "what's popular?" or "what do you suggest?". You can sync the list
              from real order history or hand-pick items below.
            </p>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => {
                setShowSyncModal(true);
                setError(null);
              }}
              disabled={busy}
              className="px-4 py-2 rounded-lg bg-secondary hover:bg-secondary/80 font-medium flex items-center gap-2 disabled:opacity-50"
              data-testid="button-open-sync"
            >
              <RefreshCcw className="w-4 h-4" />
              Sync from order data
            </button>
            <button
              onClick={() => {
                setShowAddModal(true);
                setError(null);
              }}
              disabled={busy}
              className="px-4 py-2 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 font-medium flex items-center gap-2 disabled:opacity-50"
              data-testid="button-open-add"
            >
              <Plus className="w-4 h-4" />
              Add item
            </button>
          </div>
        </div>

        {error && (
          <div
            className="mb-4 px-4 py-3 rounded-lg bg-destructive/10 text-destructive flex items-start gap-2"
            data-testid="rec-error"
          >
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
            <span className="text-sm">{error}</span>
          </div>
        )}
        {success && (
          <div
            className="mb-4 px-4 py-3 rounded-lg bg-green-50 text-green-700 text-sm"
            data-testid="rec-success"
          >
            {success}
          </div>
        )}

        {isLoading ? (
          <div className="flex items-center justify-center py-16 text-muted-foreground">
            <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading…
          </div>
        ) : sorted.length === 0 ? (
          <div className="border border-border rounded-xl p-10 bg-card text-center">
            <Sparkles className="w-10 h-10 text-primary mx-auto mb-3" />
            <h3 className="font-bold text-lg mb-1">No recommendations yet</h3>
            <p className="text-muted-foreground text-sm mb-5 max-w-md mx-auto">
              The chat bot will fall back to general menu search until you set up
              a curated list. The fastest start is to pull in your real top
              sellers.
            </p>
            <button
              onClick={() => setShowSyncModal(true)}
              className="px-5 py-2 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 font-medium inline-flex items-center gap-2"
              data-testid="button-empty-sync"
            >
              <RefreshCcw className="w-4 h-4" /> Sync from order data
            </button>
          </div>
        ) : (
          <div className="border border-border rounded-xl bg-card overflow-hidden">
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={handleDragEnd}
            >
              <table className="w-full text-sm">
                <thead className="bg-secondary/40 text-left">
                  <tr>
                    <th className="px-3 py-2 w-10"></th>
                    <th className="px-3 py-2 font-medium">Item</th>
                    <th className="px-3 py-2 font-medium hidden sm:table-cell">Category</th>
                    <th className="px-3 py-2 font-medium">Source</th>
                    <th className="px-3 py-2 w-12"></th>
                  </tr>
                </thead>
                <tbody>
                  <SortableContext
                    items={sorted.map((r) => r.menuItemId)}
                    strategy={verticalListSortingStrategy}
                  >
                    {sorted.map((r) => (
                      <SortableRow key={r.menuItemId} id={r.menuItemId} busy={busy}>
                        <td className="px-3 py-3">
                          <div className="font-medium">{r.name}</div>
                          {!r.available && (
                            <div className="text-xs text-amber-600 mt-0.5">
                              Currently unavailable — bot will skip it
                            </div>
                          )}
                        </td>
                        <td className="px-3 py-3 text-muted-foreground hidden sm:table-cell">
                          {r.category}
                        </td>
                        <td className="px-3 py-3">
                          <SourceBadge source={r.source} />
                        </td>
                        <td className="px-3 py-3 text-right">
                          <button
                            onClick={() => handleRemove(r.menuItemId)}
                            disabled={busy}
                            className="p-1.5 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 disabled:opacity-30"
                            title="Remove from list"
                            data-testid={`button-remove-${r.menuItemId}`}
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </td>
                      </SortableRow>
                    ))}
                  </SortableContext>
                </tbody>
              </table>
            </DndContext>
          </div>
        )}

        {showSyncModal && (
          <SyncModal
            onClose={() => setShowSyncModal(false)}
            onApplied={(msg) => {
              invalidate();
              flashSuccess(msg);
              setShowSyncModal(false);
            }}
            onError={(msg) => setError(msg)}
          />
        )}

        {showAddModal && (
          <AddItemModal
            existingIds={new Set(sorted.map((r) => r.menuItemId))}
            onClose={() => setShowAddModal(false)}
            onAdded={(name) => {
              invalidate();
              flashSuccess(`Added "${name}" to the recommended list.`);
              setShowAddModal(false);
            }}
            onError={(msg) => setError(msg)}
          />
        )}
      </div>
    </AdminLayout>
  );
}

function SourceBadge({ source }: { source: string }) {
  if (source === "sync") {
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-700">
        Synced
      </span>
    );
  }
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-700">
      Manual
    </span>
  );
}

function SyncModal({
  onClose,
  onApplied,
  onError,
}: {
  onClose: () => void;
  onApplied: (msg: string) => void;
  onError: (msg: string) => void;
}) {
  const [limit, setLimit] = useState(12);
  const [mode, setMode] = useState<"merge" | "replace">("merge");
  const [topSellers, setTopSellers] = useState<TopSeller[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [applying, setApplying] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    adminFetchTopSellers(limit)
      .then((data) => {
        if (!cancelled) setTopSellers(data);
      })
      .catch((e: unknown) => {
        if (!cancelled) onError((e as Error).message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [limit, onError]);

  async function handleApply() {
    setApplying(true);
    try {
      const result = await adminSyncRecommendations(mode, limit);
      const msg =
        mode === "replace"
          ? `Replaced the list with ${result.applied} top-selling items.`
          : `Merged top sellers — list now has ${result.list.length} items.`;
      onApplied(msg);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setApplying(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-card rounded-xl p-6 max-w-2xl w-full max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between mb-4">
          <div>
            <h3 className="font-display font-bold text-xl">Sync from order data</h3>
            <p className="text-sm text-muted-foreground mt-1">
              Pulls top-selling items from your real catering and event orders.
              Demo orders are excluded.
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-secondary"
            data-testid="sync-close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex flex-wrap gap-4 mb-4 items-end">
          <label className="flex flex-col text-sm">
            <span className="font-medium mb-1">How many to pull</span>
            <input
              type="number"
              min={1}
              max={50}
              value={limit}
              onChange={(e) => setLimit(Math.max(1, Math.min(50, Number(e.target.value) || 1)))}
              className="border rounded px-3 py-1.5 w-24"
              data-testid="sync-limit"
            />
          </label>
          <div className="flex flex-col text-sm">
            <span className="font-medium mb-1">Mode</span>
            <div className="flex gap-3">
              <label className="flex items-center gap-1.5">
                <input
                  type="radio"
                  checked={mode === "merge"}
                  onChange={() => setMode("merge")}
                  data-testid="sync-mode-merge"
                />
                <span>Merge (keep existing)</span>
              </label>
              <label className="flex items-center gap-1.5">
                <input
                  type="radio"
                  checked={mode === "replace"}
                  onChange={() => setMode("replace")}
                  data-testid="sync-mode-replace"
                />
                <span>Replace</span>
              </label>
            </div>
          </div>
        </div>

        <div className="flex-1 overflow-auto border rounded-lg">
          {loading ? (
            <div className="flex items-center justify-center py-12 text-muted-foreground">
              <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading top sellers…
            </div>
          ) : !topSellers || topSellers.length === 0 ? (
            <div className="text-center py-10 px-4 text-muted-foreground text-sm">
              No real order history yet. Once you have completed orders, this is
              where your top sellers will show up.
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-secondary/40 text-left sticky top-0">
                <tr>
                  <th className="px-3 py-2 font-medium">Item</th>
                  <th className="px-3 py-2 font-medium">Category</th>
                  <th className="px-3 py-2 font-medium text-right">Sold</th>
                  <th className="px-3 py-2 font-medium">Already in list</th>
                </tr>
              </thead>
              <tbody>
                {topSellers.map((t) => (
                  <tr key={t.menuItemId} className="border-t">
                    <td className="px-3 py-2">{t.name}</td>
                    <td className="px-3 py-2 text-muted-foreground">{t.category}</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {t.totalQuantity}
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {t.isCurrentlyRecommended ? "Yes" : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="flex justify-end gap-2 mt-5">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg hover:bg-secondary"
            data-testid="sync-cancel"
          >
            Cancel
          </button>
          <button
            onClick={handleApply}
            disabled={applying || loading || !topSellers || topSellers.length === 0}
            className="px-4 py-2 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 font-medium disabled:opacity-50 inline-flex items-center gap-2"
            data-testid="sync-apply"
          >
            {applying && <Loader2 className="w-4 h-4 animate-spin" />}
            {mode === "replace" ? "Replace list" : "Merge into list"}
          </button>
        </div>
      </div>
    </div>
  );
}

function AddItemModal({
  existingIds,
  onClose,
  onAdded,
  onError,
}: {
  existingIds: Set<number>;
  onClose: () => void;
  onAdded: (name: string) => void;
  onError: (msg: string) => void;
}) {
  const [items, setItems] = useState<MinimalMenuItem[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState<number | null>(null);
  const [search, setSearch] = useState("");

  useEffect(() => {
    let cancelled = false;
    fetch(`${BASE}/api/admin/menu`, {
      headers: { Authorization: `Bearer ${getAdminToken()}` },
    })
      .then((r) => (r.ok ? r.json() : []))
      .then((data: MinimalMenuItem[]) => {
        if (!cancelled) setItems(data);
      })
      .catch((e: unknown) => {
        if (!cancelled) onError((e as Error).message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [onError]);

  const filtered = useMemo(() => {
    const all = (items ?? []).filter((i) => !existingIds.has(i.id));
    const q = search.trim().toLowerCase();
    if (!q) return all.slice(0, 200);
    return all
      .filter(
        (i) =>
          i.name.toLowerCase().includes(q) ||
          (i.category ?? "").toLowerCase().includes(q),
      )
      .slice(0, 200);
  }, [items, existingIds, search]);

  async function handleAdd(item: MinimalMenuItem) {
    setAdding(item.id);
    try {
      await adminAddRecommendation(item.id);
      onAdded(item.name);
    } catch (e) {
      onError((e as Error).message);
      setAdding(null);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-card rounded-xl p-6 max-w-xl w-full max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between mb-4">
          <h3 className="font-display font-bold text-xl">Add a recommended item</h3>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-secondary"
            data-testid="add-close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="relative mb-3">
          <Search className="w-4 h-4 absolute left-3 top-2.5 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search menu items…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-9 pr-3 py-2 border rounded-lg text-sm"
            data-testid="add-search"
            autoFocus
          />
        </div>

        <div className="flex-1 overflow-auto border rounded-lg">
          {loading ? (
            <div className="flex items-center justify-center py-12 text-muted-foreground">
              <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading menu…
            </div>
          ) : filtered.length === 0 ? (
            <div className="text-center py-10 px-4 text-muted-foreground text-sm">
              {search.trim()
                ? "No matches."
                : "Every available item is already in the list."}
            </div>
          ) : (
            <ul className="divide-y">
              {filtered.map((it) => (
                <li
                  key={it.id}
                  className="px-3 py-2 flex items-center justify-between gap-3"
                  data-testid={`add-row-${it.id}`}
                >
                  <div className="min-w-0">
                    <div className="font-medium truncate">{it.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {it.category}
                      {!it.available && " · unavailable"}
                    </div>
                  </div>
                  <button
                    onClick={() => handleAdd(it)}
                    disabled={adding != null}
                    className="px-3 py-1.5 rounded bg-primary text-primary-foreground hover:bg-primary/90 text-sm font-medium disabled:opacity-50 inline-flex items-center gap-1.5"
                    data-testid={`add-button-${it.id}`}
                  >
                    {adding === it.id && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                    Add
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
