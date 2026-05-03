import { useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
import { AdminLayout } from "@/components/AdminLayout";
import { useToast } from "@/hooks/use-toast";
import { Plus, Package as PackageIcon, Eye, EyeOff, Pencil, Trash2, Loader2, Users, AlertTriangle } from "lucide-react";
import type { AdminMenuPackageSummary } from "@/lib/menuPackages";

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
      const res = await fetch("/api/admin/menu-packages");
      if (!res.ok) throw new Error();
      setItems(await res.json());
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
      const res = await fetch(`/api/admin/menu-packages/${p.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hidden: !p.hidden }),
      });
      if (!res.ok) throw new Error();
      await refresh();
    } catch {
      toast({ title: "Update failed", variant: "destructive" });
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (id: number) => {
    setBusyId(id);
    try {
      const res = await fetch(`/api/admin/menu-packages/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error();
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
      const res = await fetch("/api/admin/menu-packages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "New Package", servesGuests: 20, hidden: true, items: [] }),
      });
      if (!res.ok) throw new Error();
      const data = await res.json();
      navigate(`/admin/menu-packages/${data.id}`);
    } catch {
      toast({ title: "Create failed", variant: "destructive" });
    } finally {
      setBusyId(null);
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
              Pre-built bundles guests can load straight into their planner or cart.
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
          <div className="space-y-3">
            {items.map(p => (
              <div key={p.id} className="bg-card rounded-2xl border border-border p-4 flex items-center gap-4">
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
                      <span className="text-xs font-bold px-2 py-0.5 bg-amber-100 text-amber-700 rounded-full inline-flex items-center gap-1">
                        <AlertTriangle className="w-3 h-3" /> Some items unavailable
                      </span>
                    )}
                  </div>
                  <div className="text-sm text-muted-foreground flex items-center gap-2 mt-0.5">
                    <Users className="w-3.5 h-3.5" /> Serves {p.servesGuests}
                    <span>•</span>
                    {p.itemCount} item{p.itemCount !== 1 ? "s" : ""}
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    onClick={() => toggleHidden(p)}
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
                        onClick={() => remove(p.id)}
                        disabled={busyId === p.id}
                        className="text-xs font-bold px-2 py-1 rounded-lg bg-destructive text-white hover:bg-destructive/90 disabled:opacity-60"
                      >
                        {busyId === p.id ? "..." : "Confirm"}
                      </button>
                      <button onClick={() => setConfirmDelete(null)} className="text-xs px-2 py-1 text-muted-foreground">Cancel</button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setConfirmDelete(p.id)}
                      className="p-2 rounded-lg hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
                      title="Delete"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </AdminLayout>
  );
}
