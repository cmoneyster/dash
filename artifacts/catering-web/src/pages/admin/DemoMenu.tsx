import { useEffect, useMemo, useState } from "react";
import { AdminLayout } from "@/components/AdminLayout";
import { getAdminToken } from "@/components/AdminGuard";
import { Search, CheckCircle2, Circle, Save, Loader2 } from "lucide-react";
import { formatCurrency } from "@/lib/utils";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

type AdminMenuItem = {
  id: number;
  name: string;
  description: string;
  category: string;
  price: number;
  imageUrl: string | null;
};

export default function DemoMenu() {
  const [items, setItems] = useState<AdminMenuItem[] | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [savedSelected, setSavedSelected] = useState<Set<number>>(new Set());
  const [search, setSearch] = useState("");
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const token = getAdminToken();
        const [menuRes, demoRes] = await Promise.all([
          fetch(`${BASE}/api/admin/menu`, { headers: { Authorization: `Bearer ${token}` } }),
          fetch(`${BASE}/api/admin/demo-menu`, { headers: { Authorization: `Bearer ${token}` } }),
        ]);
        if (!menuRes.ok) throw new Error("Failed to load menu");
        if (!demoRes.ok) throw new Error("Failed to load demo menu");
        const menu = (await menuRes.json()) as Array<AdminMenuItem & { price: string | number }>;
        const demo = (await demoRes.json()) as { menuItemIds: number[] };
        if (cancelled) return;
        setItems(
          menu.map((m) => ({
            id: m.id,
            name: m.name,
            description: m.description,
            category: m.category,
            price: typeof m.price === "string" ? parseFloat(m.price) : m.price,
            imageUrl: m.imageUrl ?? null,
          })),
        );
        const ids = new Set<number>(demo.menuItemIds);
        setSelected(ids);
        setSavedSelected(new Set(ids));
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : "Failed to load");
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  const grouped = useMemo(() => {
    if (!items) return [];
    const q = search.trim().toLowerCase();
    const filtered = q
      ? items.filter(
          (i) =>
            i.name.toLowerCase().includes(q) ||
            i.description.toLowerCase().includes(q) ||
            i.category.toLowerCase().includes(q),
        )
      : items;
    const map = new Map<string, AdminMenuItem[]>();
    for (const i of filtered) {
      const arr = map.get(i.category) ?? [];
      arr.push(i);
      map.set(i.category, arr);
    }
    return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [items, search]);

  const dirty = useMemo(() => {
    if (selected.size !== savedSelected.size) return true;
    for (const id of selected) if (!savedSelected.has(id)) return true;
    return false;
  }, [selected, savedSelected]);

  function toggle(id: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function save() {
    setSaving(true);
    setErr(null);
    try {
      const token = getAdminToken();
      const res = await fetch(`${BASE}/api/admin/demo-menu`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ menuItemIds: Array.from(selected) }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? "Failed to save demo menu");
      }
      const data = (await res.json()) as { menuItemIds: number[] };
      setSavedSelected(new Set(data.menuItemIds));
      setSelected(new Set(data.menuItemIds));
      setSavedAt(Date.now());
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  return (
    <AdminLayout>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="font-display font-bold text-3xl">Demo Menu</h1>
          <p className="text-muted-foreground text-sm mt-1">
            Pick which real menu items show up on the public guest-ordering demo. Demo orders go to a separate
            table — they never appear on the kitchen display, in sales reports, or in any operational queue.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {savedAt && !dirty && !saving && (
            <span className="text-sm text-emerald-700 dark:text-emerald-400 flex items-center gap-1.5">
              <CheckCircle2 className="w-4 h-4" /> Saved
            </span>
          )}
          <button
            onClick={save}
            disabled={!dirty || saving}
            className="px-5 py-2.5 bg-foreground text-background font-bold rounded-xl hover:bg-primary hover:text-primary-foreground transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-2"
          >
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
            Save Selection
          </button>
        </div>
      </div>

      <div className="bg-card rounded-2xl border border-border p-4 mb-6 flex items-center gap-3">
        <Search className="w-5 h-5 text-muted-foreground" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by name, category, or description"
          className="flex-1 bg-transparent outline-none text-sm"
        />
        <span className="text-xs text-muted-foreground">
          {selected.size} selected
        </span>
      </div>

      {err && (
        <div className="mb-6 px-4 py-3 rounded-xl bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-400 text-sm">{err}</div>
      )}

      {!items && !err && (
        <div className="py-20 flex justify-center">
          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        </div>
      )}

      <div className="space-y-8">
        {grouped.map(([category, list]) => (
          <section key={category}>
            <h2 className="font-display font-bold text-xl mb-3">{category}</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {list.map((item) => {
                const checked = selected.has(item.id);
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => toggle(item.id)}
                    className={`text-left flex gap-3 p-3 rounded-2xl border transition-all ${
                      checked
                        ? "border-primary bg-primary/5"
                        : "border-border bg-card hover:border-primary/40"
                    }`}
                  >
                    <div className="w-16 h-16 rounded-xl overflow-hidden bg-secondary flex-shrink-0">
                      {item.imageUrl ? (
                        <img src={item.imageUrl} alt="" className="w-full h-full object-cover" />
                      ) : null}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-start justify-between gap-2">
                        <p className="font-bold text-sm truncate">{item.name}</p>
                        {checked ? (
                          <CheckCircle2 className="w-5 h-5 text-primary flex-shrink-0" />
                        ) : (
                          <Circle className="w-5 h-5 text-muted-foreground/40 flex-shrink-0" />
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground line-clamp-2 mt-0.5">{item.description}</p>
                      <p className="text-xs font-semibold text-foreground mt-1">{formatCurrency(item.price)}</p>
                    </div>
                  </button>
                );
              })}
            </div>
          </section>
        ))}
        {items && grouped.length === 0 && (
          <p className="text-muted-foreground text-sm py-12 text-center">No items match your search.</p>
        )}
      </div>
    </AdminLayout>
  );
}
