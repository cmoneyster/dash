import { useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
import { AdminLayout } from "@/components/AdminLayout";
import { useToast } from "@/hooks/use-toast";
import { Plus, Package as PackageIcon, Eye, EyeOff, Pencil, Trash2, Loader2, Users, AlertTriangle, GripVertical } from "lucide-react";
import { adminMenuPackagesApi, type AdminMenuPackageSummary } from "@/lib/menuPackages";
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

function formatRelative(iso?: string): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const diff = Date.now() - t;
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}

export default function MenuPackages() {
  const [items, setItems] = useState<AdminMenuPackageSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);
  const { toast } = useToast();
  const [, navigate] = useLocation();

  const refresh = async () => {
    setLoading(true);
    try {
      setItems(await adminMenuPackagesApi.list());
    } catch {
      toast({ title: "Failed to load packages", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { refresh(); }, []);

  const toggleHidden = async (p: AdminMenuPackageSummary) => {
    setBusyId(p.id);
    try {
      await adminMenuPackagesApi.update(p.id, { hidden: !p.hidden });
      await refresh();
    } catch (e) {
      toast({ title: e instanceof Error ? e.message : "Update failed", variant: "destructive" });
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (id: number) => {
    setBusyId(id);
    try {
      await adminMenuPackagesApi.remove(id);
      setConfirmDelete(null);
      await refresh();
      toast({ title: "Package deleted" });
    } catch {
      toast({ title: "Delete failed", variant: "destructive" });
    } finally {
      setBusyId(null);
    }
  };

  const create = async () => {
    setBusyId(-1);
    try {
      const data = await adminMenuPackagesApi.create({
        name: "New Package",
        servesGuests: 20,
        hidden: true,
        items: [],
      });
      navigate(`/admin/menu-packages/${data.id}`);
    } catch (e) {
      toast({ title: e instanceof Error ? e.message : "Create failed", variant: "destructive" });
    } finally {
      setBusyId(null);
    }
  };

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const handleDragEnd = async (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const oldIdx = items.findIndex((p) => p.id === active.id);
    const newIdx = items.findIndex((p) => p.id === over.id);
    if (oldIdx < 0 || newIdx < 0) return;
    const reordered = arrayMove(items, oldIdx, newIdx);
    setItems(reordered);
    try {
      await adminMenuPackagesApi.reorder(reordered.map((p) => p.id));
    } catch {
      toast({ title: "Reorder failed", variant: "destructive" });
      refresh();
    }
  };

  return (
    <AdminLayout>
      <div className="max-w-5xl mx-auto p-6 sm:p-8">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="font-display font-bold text-3xl flex items-center gap-2">
              <PackageIcon className="w-7 h-7 text-primary" /> Menu Packages
            </h1>
            <p className="text-muted-foreground text-sm mt-1">
              Pre-built bundles guests can load straight into their planner or cart. Drag to reorder.
            </p>
          </div>
          <button
            onClick={create}
            disabled={busyId === -1}
            className="px-4 py-2 rounded-xl bg-primary text-primary-foreground font-semibold hover:bg-primary/90 disabled:opacity-60 transition-colors flex items-center gap-2"
          >
            {busyId === -1 ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
            New package
          </button>
        </div>

        {loading ? (
          <div className="flex justify-center py-24"><Loader2 className="w-8 h-8 animate-spin text-primary" /></div>
        ) : items.length === 0 ? (
          <div className="text-center py-16 bg-card rounded-2xl border border-dashed border-border">
            <PackageIcon className="w-10 h-10 text-muted-foreground mx-auto mb-3 opacity-50" />
            <h3 className="font-bold text-lg mb-1">No packages yet</h3>
            <p className="text-sm text-muted-foreground">Click "New package" to create your first bundle.</p>
          </div>
        ) : (
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <SortableContext items={items.map(i => i.id)} strategy={verticalListSortingStrategy}>
              <div className="space-y-3">
                {items.map((p) => (
                  <SortableRow
                    key={p.id}
                    pkg={p}
                    busyId={busyId}
                    confirmDelete={confirmDelete}
                    onToggleHidden={() => toggleHidden(p)}
                    onAskDelete={() => setConfirmDelete(p.id)}
                    onCancelDelete={() => setConfirmDelete(null)}
                    onConfirmDelete={() => remove(p.id)}
                  />
                ))}
              </div>
            </SortableContext>
          </DndContext>
        )}
      </div>
    </AdminLayout>
  );
}

function SortableRow({
  pkg: p,
  busyId,
  confirmDelete,
  onToggleHidden,
  onAskDelete,
  onCancelDelete,
  onConfirmDelete,
}: {
  pkg: AdminMenuPackageSummary;
  busyId: number | null;
  confirmDelete: number | null;
  onToggleHidden: () => void;
  onAskDelete: () => void;
  onCancelDelete: () => void;
  onConfirmDelete: () => void;
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: p.id });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    zIndex: isDragging ? 10 : undefined,
  };
  return (
    <div ref={setNodeRef} style={style} className="bg-card rounded-2xl border border-border p-4 flex items-center gap-4">
      <button
        type="button"
        ref={setActivatorNodeRef}
        {...attributes}
        {...listeners}
        className="cursor-grab active:cursor-grabbing p-1 text-muted-foreground hover:text-foreground touch-none"
        aria-label="Drag to reorder"
        title="Drag to reorder"
      >
        <GripVertical className="w-5 h-5" />
      </button>
      {p.imageUrl ? (
        <img src={p.imageUrl} alt="" className="w-16 h-16 rounded-xl object-cover bg-secondary shrink-0" />
      ) : (
        <div className="w-16 h-16 rounded-xl bg-secondary flex items-center justify-center shrink-0">
          <PackageIcon className="w-6 h-6 text-muted-foreground" />
        </div>
      )}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <h3 className="font-bold text-lg truncate">{p.name}</h3>
          {p.hidden && <span className="text-xs font-bold px-2 py-0.5 bg-muted text-muted-foreground rounded-full">Hidden</span>}
          {p.partiallyAvailable && (
            <span className="text-xs font-bold px-2 py-0.5 bg-amber-100 dark:bg-amber-950/40 text-amber-700 dark:text-amber-400 rounded-full inline-flex items-center gap-1">
              <AlertTriangle className="w-3 h-3" /> Some items unavailable
            </span>
          )}
        </div>
        <div className="text-sm text-muted-foreground flex items-center gap-2 mt-0.5 flex-wrap">
          <span className="inline-flex items-center gap-1"><Users className="w-3.5 h-3.5" /> Serves {p.servesGuests}</span>
          <span>•</span>
          <span>{p.itemCount} item{p.itemCount !== 1 ? "s" : ""}</span>
          {p.updatedAt && (
            <>
              <span>•</span>
              <span title={new Date(p.updatedAt).toLocaleString()}>Updated {formatRelative(p.updatedAt)}</span>
            </>
          )}
        </div>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <button
          onClick={onToggleHidden}
          disabled={busyId === p.id}
          title={p.hidden ? "Show on menu" : "Hide from menu"}
          className="p-2 rounded-lg hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors"
        >
          {p.hidden ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
        </button>
        <Link
          href={`/admin/menu-packages/${p.id}`}
          className="p-2 rounded-lg hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors"
          title="Edit"
        >
          <Pencil className="w-4 h-4" />
        </Link>
        {confirmDelete === p.id ? (
          <div className="flex items-center gap-1 ml-1">
            <button
              onClick={onConfirmDelete}
              disabled={busyId === p.id}
              className="text-xs font-bold px-2 py-1 rounded-lg bg-destructive text-white hover:bg-destructive/90 disabled:opacity-60"
            >
              {busyId === p.id ? "..." : "Confirm"}
            </button>
            <button onClick={onCancelDelete} className="text-xs px-2 py-1 text-muted-foreground">Cancel</button>
          </div>
        ) : (
          <button
            onClick={onAskDelete}
            className="p-2 rounded-lg hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
            title="Delete"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        )}
      </div>
    </div>
  );
}
