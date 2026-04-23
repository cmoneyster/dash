import { useState, useMemo } from "react";
import { AdminLayout } from "@/components/AdminLayout";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, Plus, ArrowUp, ArrowDown, Eye, EyeOff, Edit2, Trash2, X, Check } from "lucide-react";
import {
  useAdminCategories,
  adminCreateCategory,
  adminUpdateCategory,
  adminDeleteCategory,
  adminReorderCategories,
  ADMIN_CATEGORIES_QUERY_KEY,
  CATEGORIES_QUERY_KEY,
  type AdminCategory,
  type PlannerGroup,
} from "@/lib/categories";

const PLANNER_GROUPS: PlannerGroup[] = ["savory", "sweet", "entree", "other"];
const PLANNER_GROUP_LABEL: Record<PlannerGroup, string> = {
  savory: "Savory (small bites)",
  sweet: "Sweet (small bites)",
  entree: "Entrée",
  other: "Other (no target)",
};

export default function CategoryManager() {
  const queryClient = useQueryClient();
  const { data: categories, isLoading } = useAdminCategories();

  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState("");
  const [editGroup, setEditGroup] = useState<PlannerGroup>("other");
  const [editVisible, setEditVisible] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [newName, setNewName] = useState("");
  const [newGroup, setNewGroup] = useState<PlannerGroup>("other");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<AdminCategory | null>(null);

  const sorted = useMemo(
    () => [...(categories ?? [])].sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id),
    [categories],
  );

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ADMIN_CATEGORIES_QUERY_KEY });
    queryClient.invalidateQueries({ queryKey: CATEGORIES_QUERY_KEY });
  };

  async function startEdit(c: AdminCategory) {
    setEditingId(c.id);
    setEditName(c.name);
    setEditGroup(c.plannerGroup);
    setEditVisible(c.visible);
    setError(null);
  }

  async function saveEdit() {
    if (editingId == null) return;
    setBusy(true);
    setError(null);
    try {
      await adminUpdateCategory(editingId, { name: editName.trim(), plannerGroup: editGroup, visible: editVisible });
      setEditingId(null);
      invalidate();
    } catch (e: any) {
      setError(e.message ?? "Update failed");
    } finally {
      setBusy(false);
    }
  }

  async function toggleVisible(c: AdminCategory) {
    setBusy(true);
    try {
      await adminUpdateCategory(c.id, { visible: !c.visible });
      invalidate();
    } finally {
      setBusy(false);
    }
  }

  async function move(c: AdminCategory, direction: -1 | 1) {
    const idx = sorted.findIndex((x) => x.id === c.id);
    const swapIdx = idx + direction;
    if (swapIdx < 0 || swapIdx >= sorted.length) return;
    const other = sorted[swapIdx];
    setBusy(true);
    try {
      await adminReorderCategories([
        { id: c.id, sortOrder: other.sortOrder },
        { id: other.id, sortOrder: c.sortOrder },
      ]);
      invalidate();
    } finally {
      setBusy(false);
    }
  }

  async function addCategory(e: React.FormEvent) {
    e.preventDefault();
    if (!newName.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await adminCreateCategory({ name: newName.trim(), plannerGroup: newGroup });
      setNewName("");
      setNewGroup("other");
      setShowAdd(false);
      invalidate();
    } catch (e: any) {
      setError(e.message ?? "Create failed");
    } finally {
      setBusy(false);
    }
  }

  async function doDelete() {
    if (!confirmDelete) return;
    setBusy(true);
    setError(null);
    try {
      await adminDeleteCategory(confirmDelete.id);
      setConfirmDelete(null);
      invalidate();
    } catch (e: any) {
      setError(e.message ?? "Delete failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <AdminLayout>
      <div className="max-w-4xl mx-auto p-4 sm:p-6 lg:p-8">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="font-display font-bold text-3xl">Menu Categories</h1>
            <p className="text-muted-foreground text-sm mt-1">
              Reorder, rename, hide, or delete categories. Renames cascade to all menu items.
            </p>
          </div>
          <button
            onClick={() => setShowAdd((v) => !v)}
            className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-xl font-medium hover:bg-primary/90"
            data-testid="button-add-category"
          >
            <Plus className="w-4 h-4" /> Add Category
          </button>
        </div>

        {error && (
          <div className="mb-4 p-3 rounded-lg bg-destructive/10 border border-destructive/30 text-destructive text-sm">
            {error}
          </div>
        )}

        {showAdd && (
          <form onSubmit={addCategory} className="mb-6 p-4 bg-card border border-border rounded-xl flex flex-col sm:flex-row gap-3 items-end">
            <div className="flex-1 w-full">
              <label className="block text-xs uppercase tracking-wider font-semibold text-muted-foreground mb-1">Name</label>
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                className="w-full px-3 py-2 bg-background border border-border rounded-lg"
                placeholder="e.g. Entrées - Vegetables"
                data-testid="input-new-category-name"
                autoFocus
              />
            </div>
            <div className="w-full sm:w-56">
              <label className="block text-xs uppercase tracking-wider font-semibold text-muted-foreground mb-1">Planner Group</label>
              <select
                value={newGroup}
                onChange={(e) => setNewGroup(e.target.value as PlannerGroup)}
                className="w-full px-3 py-2 bg-background border border-border rounded-lg"
                data-testid="select-new-category-group"
              >
                {PLANNER_GROUPS.map((g) => (
                  <option key={g} value={g}>{PLANNER_GROUP_LABEL[g]}</option>
                ))}
              </select>
            </div>
            <button
              type="submit"
              disabled={busy || !newName.trim()}
              className="px-4 py-2 bg-foreground text-background rounded-lg font-medium disabled:opacity-50"
              data-testid="button-save-new-category"
            >
              Create
            </button>
          </form>
        )}

        {isLoading ? (
          <div className="flex items-center justify-center py-12 text-muted-foreground">
            <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading…
          </div>
        ) : sorted.length === 0 ? (
          <div className="text-center text-muted-foreground py-12">No categories yet.</div>
        ) : (
          <div className="bg-card border border-border rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-secondary/50 text-xs uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="px-3 py-3 text-left w-20">Order</th>
                  <th className="px-3 py-3 text-left">Name</th>
                  <th className="px-3 py-3 text-left">Planner Group</th>
                  <th className="px-3 py-3 text-center">Items</th>
                  <th className="px-3 py-3 text-center">Visible</th>
                  <th className="px-3 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {sorted.map((c, idx) => {
                  const isEditing = editingId === c.id;
                  return (
                    <tr key={c.id} data-testid={`row-category-${c.id}`}>
                      <td className="px-3 py-3">
                        <div className="flex gap-1">
                          <button
                            onClick={() => move(c, -1)}
                            disabled={busy || idx === 0}
                            className="p-1 rounded hover:bg-secondary disabled:opacity-30"
                            data-testid={`button-up-${c.id}`}
                          >
                            <ArrowUp className="w-4 h-4" />
                          </button>
                          <button
                            onClick={() => move(c, 1)}
                            disabled={busy || idx === sorted.length - 1}
                            className="p-1 rounded hover:bg-secondary disabled:opacity-30"
                            data-testid={`button-down-${c.id}`}
                          >
                            <ArrowDown className="w-4 h-4" />
                          </button>
                        </div>
                      </td>
                      <td className="px-3 py-3 font-medium">
                        {isEditing ? (
                          <input
                            value={editName}
                            onChange={(e) => setEditName(e.target.value)}
                            className="w-full px-2 py-1 bg-background border border-border rounded"
                            data-testid={`input-edit-name-${c.id}`}
                          />
                        ) : (
                          c.name
                        )}
                      </td>
                      <td className="px-3 py-3">
                        {isEditing ? (
                          <select
                            value={editGroup}
                            onChange={(e) => setEditGroup(e.target.value as PlannerGroup)}
                            className="px-2 py-1 bg-background border border-border rounded"
                            data-testid={`select-edit-group-${c.id}`}
                          >
                            {PLANNER_GROUPS.map((g) => (
                              <option key={g} value={g}>{PLANNER_GROUP_LABEL[g]}</option>
                            ))}
                          </select>
                        ) : (
                          <span className="text-muted-foreground">{PLANNER_GROUP_LABEL[c.plannerGroup]}</span>
                        )}
                      </td>
                      <td className="px-3 py-3 text-center text-muted-foreground">{c.itemCount}</td>
                      <td className="px-3 py-3 text-center">
                        {isEditing ? (
                          <input
                            type="checkbox"
                            checked={editVisible}
                            onChange={(e) => setEditVisible(e.target.checked)}
                            data-testid={`checkbox-edit-visible-${c.id}`}
                          />
                        ) : (
                          <button
                            onClick={() => toggleVisible(c)}
                            disabled={busy}
                            className="p-1 rounded hover:bg-secondary"
                            data-testid={`button-toggle-visible-${c.id}`}
                          >
                            {c.visible ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4 text-muted-foreground" />}
                          </button>
                        )}
                      </td>
                      <td className="px-3 py-3">
                        <div className="flex justify-end gap-1">
                          {isEditing ? (
                            <>
                              <button
                                onClick={saveEdit}
                                disabled={busy || !editName.trim()}
                                className="p-1.5 rounded bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                                data-testid={`button-save-edit-${c.id}`}
                              >
                                <Check className="w-4 h-4" />
                              </button>
                              <button
                                onClick={() => setEditingId(null)}
                                className="p-1.5 rounded hover:bg-secondary"
                                data-testid={`button-cancel-edit-${c.id}`}
                              >
                                <X className="w-4 h-4" />
                              </button>
                            </>
                          ) : (
                            <>
                              <button
                                onClick={() => startEdit(c)}
                                className="p-1.5 rounded hover:bg-secondary"
                                data-testid={`button-edit-${c.id}`}
                              >
                                <Edit2 className="w-4 h-4" />
                              </button>
                              <button
                                onClick={() => setConfirmDelete(c)}
                                disabled={c.itemCount > 0}
                                className="p-1.5 rounded hover:bg-destructive/10 text-destructive disabled:opacity-30 disabled:cursor-not-allowed"
                                title={c.itemCount > 0 ? "Move or delete its items first" : "Delete category"}
                                data-testid={`button-delete-${c.id}`}
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {confirmDelete && (
          <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={() => setConfirmDelete(null)}>
            <div className="bg-card rounded-xl p-6 max-w-md w-full" onClick={(e) => e.stopPropagation()}>
              <h3 className="font-display font-bold text-xl mb-2">Delete category?</h3>
              <p className="text-muted-foreground text-sm mb-6">
                "{confirmDelete.name}" will be removed permanently. This cannot be undone.
              </p>
              <div className="flex justify-end gap-2">
                <button
                  onClick={() => setConfirmDelete(null)}
                  className="px-4 py-2 rounded-lg hover:bg-secondary"
                  data-testid="button-cancel-delete"
                >
                  Cancel
                </button>
                <button
                  onClick={doDelete}
                  disabled={busy}
                  className="px-4 py-2 rounded-lg bg-destructive text-destructive-foreground hover:bg-destructive/90 disabled:opacity-50"
                  data-testid="button-confirm-delete"
                >
                  Delete
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </AdminLayout>
  );
}
