import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useParams, useLocation } from "wouter";
import { AdminLayout } from "@/components/AdminLayout";
import { useToast } from "@/hooks/use-toast";
import { useListMenuItems, type MenuItem } from "@workspace/api-client-react";
import { useCategories, buildPlannerGroupMap } from "@/lib/categories";
import { computePlannerCoverage, type PlannerMathItem, type PlannerGroup } from "@/lib/plannerMath";
import {
  adminMenuPackagesApi,
  type AdminMenuPackage,
  type PublicPackageItem,
  type PackageSizeMenuItem,
} from "@/lib/menuPackages";
import { sizeLabel as sizeLabelOf, firstAvailableSizeSlot, type SizeSlot } from "@/lib/sizeSlotHelpers";
import { getAdminToken } from "@/components/AdminGuard";
import { ArrowLeft, Loader2, Save, Plus, Trash2, GripVertical, Search, Users, ImageIcon, X as XIcon, Library, Check } from "lucide-react";

// MenuItem rows ship the size1..size5 columns at runtime even though
// the generated MenuItem type omits them. Treat the listing as the
// richer PackageSizeMenuItem to feed into the typed size helpers.
type RichMenuItem = MenuItem & Partial<PackageSizeMenuItem>;

type DraftItem = {
  draftId: string;
  menuItemId: number;
  menuItem: PackageSizeMenuItem;
  quantity: number;
  sizeKey: number | null;
};

let draftCounter = 0;
const newDraftId = () => `d_${++draftCounter}`;

function toRichMenuItem(mi: MenuItem | RichMenuItem): PackageSizeMenuItem {
  const r = mi as RichMenuItem;
  return {
    id: r.id,
    name: r.name,
    category: r.category,
    description: r.description ?? "",
    price: r.price,
    imageUrl: r.imageUrl ?? null,
    allergens: r.allergens ?? [],
    servingSize: r.servingSize ?? null,
    unit: r.unit ?? null,
    minimumOrderQty: r.minimumOrderQty ?? null,
    pricingTemplate: r.pricingTemplate ?? null,
    available: r.available ?? true,
    size1Label: r.size1Label ?? null, size1Price: r.size1Price ?? null, size1Servings: r.size1Servings ?? null,
    size2Label: r.size2Label ?? null, size2Price: r.size2Price ?? null, size2Servings: r.size2Servings ?? null,
    size3Label: r.size3Label ?? null, size3Price: r.size3Price ?? null, size3Servings: r.size3Servings ?? null,
    size4Label: r.size4Label ?? null, size4Price: r.size4Price ?? null, size4Servings: r.size4Servings ?? null,
    size5Label: r.size5Label ?? null, size5Price: r.size5Price ?? null, size5Servings: r.size5Servings ?? null,
  };
}

type ImageRecord = { id: number; filename: string; servingUrl: string };

function ImagePickerModal({ onSelect, onClose }: { onSelect: (url: string) => void; onClose: () => void }) {
  const [images, setImages] = useState<ImageRecord[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [picked, setPicked] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/images", {
        headers: { Authorization: `Bearer ${getAdminToken() ?? ""}` },
      });
      if (res.ok) setImages(await res.json());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleSelect = (img: ImageRecord) => {
    setPicked(img.id);
    onSelect(`${window.location.origin}${img.servingUrl}`);
    setTimeout(onClose, 300);
  };

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center p-4 bg-foreground/30 backdrop-blur-sm">
      <div className="bg-card w-full max-w-4xl rounded-3xl shadow-2xl overflow-hidden max-h-[85vh] flex flex-col">
        <div className="px-6 py-4 border-b border-border flex justify-between items-center bg-secondary/30 shrink-0">
          <div>
            <h2 className="font-display font-bold text-2xl">Image Library</h2>
            <p className="text-sm text-muted-foreground">Click an image to use it for this package</p>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-secondary rounded-full"><XIcon className="w-5 h-5" /></button>
        </div>
        <div className="p-6 overflow-y-auto">
          {loading && <div className="flex items-center justify-center py-16"><Loader2 className="w-8 h-8 animate-spin text-primary" /></div>}
          {!loading && images?.length === 0 && (
            <div className="text-center py-16 text-muted-foreground">
              <ImageIcon className="w-12 h-12 mx-auto mb-3 opacity-30" />
              <p className="font-semibold">No images in library yet</p>
              <p className="text-sm mt-1">Upload photos in the Image Library page first.</p>
            </div>
          )}
          {!loading && images && images.length > 0 && (
            <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-3">
              {images.map((img) => (
                <button
                  key={img.id}
                  onClick={() => handleSelect(img)}
                  className={`relative group rounded-xl overflow-hidden border-2 transition-all duration-200 focus:outline-none ${
                    picked === img.id ? "border-primary scale-95" : "border-transparent hover:border-primary/50 hover:scale-[1.02]"
                  }`}
                >
                  <div className="aspect-[4/3] bg-secondary">
                    <img src={img.servingUrl} alt={img.filename} className="w-full h-full object-cover" loading="lazy" />
                  </div>
                  {picked === img.id && (
                    <div className="absolute inset-0 bg-primary/20 flex items-center justify-center">
                      <div className="w-8 h-8 rounded-full bg-primary flex items-center justify-center">
                        <Check className="w-5 h-5 text-primary-foreground" />
                      </div>
                    </div>
                  )}
                  <p className="text-[10px] px-2 py-1 truncate text-left text-muted-foreground">{img.filename}</p>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function MenuPackageEdit() {
  const params = useParams<{ id: string }>();
  const id = parseInt(params.id, 10);
  const { toast } = useToast();
  const [, navigate] = useLocation();

  const [pkg, setPkg] = useState<AdminMenuPackage | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [imageUrl, setImageUrl] = useState("");
  const [servesGuests, setServesGuests] = useState(20);
  const [hidden, setHidden] = useState(false);
  const [draftItems, setDraftItems] = useState<DraftItem[]>([]);
  const [showImagePicker, setShowImagePicker] = useState(false);

  // Embedded planner state — guest count is the package's servesGuests
  const [savoryPPG, setSavoryPPG] = useState(3);
  const [sweetPPG, setSweetPPG] = useState(2);
  const [servingsPPG, setServingsPPG] = useState(4);

  const { data: allMenuItems = [] } = useListMenuItems({});
  const { data: categoryRows } = useCategories({ includeHidden: true });
  const groupMap = useMemo(() => buildPlannerGroupMap(categoryRows), [categoryRows]);
  const groupOf = (cat: string): PlannerGroup => groupMap.get(cat) ?? "other";

  useEffect(() => {
    if (!Number.isFinite(id)) return;
    adminMenuPackagesApi.get(id)
      .then((p) => {
        setPkg(p);
        setName(p.name);
        setDescription(p.description);
        setImageUrl(p.imageUrl ?? "");
        setServesGuests(p.servesGuests);
        setHidden(p.hidden);
        setDraftItems(p.items.map((it: PublicPackageItem) => ({
          draftId: newDraftId(),
          menuItemId: it.menuItemId,
          menuItem: it.menuItem,
          quantity: it.quantity,
          sizeKey: it.sizeKey,
        })));
      })
      .catch((e) => toast({
        title: e instanceof Error ? e.message : "Failed to load",
        variant: "destructive",
      }))
      .finally(() => setLoading(false));
  }, [id, toast]);

  const handleSave = async () => {
    if (!name.trim()) { toast({ title: "Name is required", variant: "destructive" }); return; }
    if (servesGuests <= 0) { toast({ title: "Serves guests must be > 0", variant: "destructive" }); return; }
    if (!hidden && draftItems.length === 0) {
      toast({ title: "A visible package needs at least one item", description: "Add items, or mark the package as hidden to save it as a draft.", variant: "destructive" });
      return;
    }
    // Pan-size items must have a sizeKey
    for (const d of draftItems) {
      if (d.menuItem.pricingTemplate === "pan_sizes" && d.sizeKey == null) {
        toast({ title: `Pick a size for "${d.menuItem.name}"`, variant: "destructive" });
        return;
      }
    }
    setSaving(true);
    try {
      const updated = await adminMenuPackagesApi.update(id, {
        name: name.trim(),
        description,
        imageUrl: imageUrl.trim() || null,
        servesGuests,
        hidden,
        items: draftItems.map((d) => ({
          menuItemId: d.menuItemId,
          quantity: d.quantity,
          sizeKey: d.sizeKey,
        })),
      });
      setPkg(updated);
      toast({ title: "Saved" });
    } catch (e) {
      toast({ title: e instanceof Error ? e.message : "Save failed", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const addItem = (raw: MenuItem) => {
    const mi = toRichMenuItem(raw);
    const isPan = mi.pricingTemplate === "pan_sizes";
    const firstSlot = isPan ? firstAvailableSizeSlot(mi) : null;
    setDraftItems((prev) => [...prev, {
      draftId: newDraftId(),
      menuItemId: mi.id,
      menuItem: mi,
      quantity: mi.minimumOrderQty ?? 1,
      sizeKey: firstSlot,
    }]);
  };

  const updateItem = (draftId: string, patch: Partial<DraftItem>) => {
    setDraftItems((prev) => prev.map((d) => d.draftId === draftId ? { ...d, ...patch } : d));
  };

  const removeItem = (draftId: string) => {
    setDraftItems((prev) => prev.filter((d) => d.draftId !== draftId));
  };

  const moveItem = (draftId: string, dir: -1 | 1) => {
    setDraftItems((prev) => {
      const idx = prev.findIndex((d) => d.draftId === draftId);
      if (idx < 0) return prev;
      const target = idx + dir;
      if (target < 0 || target >= prev.length) return prev;
      const copy = [...prev];
      [copy[idx], copy[target]] = [copy[target]!, copy[idx]!];
      return copy;
    });
  };

  // Build planner state for math
  const piecesMap: Record<number, number> = {};
  const servingsMap: Record<number, number> = {};
  const panQtys: Record<number, Record<number, number>> = {};
  const mathItems: PlannerMathItem[] = draftItems.map((d, idx) => {
    const fakeId = idx + 1;
    const isPan = d.menuItem.pricingTemplate === "pan_sizes";
    if (isPan && d.sizeKey != null) {
      panQtys[fakeId] = { [d.sizeKey]: d.quantity };
    } else {
      const grp = groupOf(d.menuItem.category);
      if (grp === "entree") servingsMap[fakeId] = d.quantity;
      else if (grp === "savory" || grp === "sweet") piecesMap[fakeId] = d.quantity;
    }
    return {
      id: fakeId,
      menuItem: {
        category: d.menuItem.category,
        servingSize: d.menuItem.servingSize,
        pricingTemplate: d.menuItem.pricingTemplate,
        size1Servings: d.menuItem.size1Servings,
        size2Servings: d.menuItem.size2Servings,
        size3Servings: d.menuItem.size3Servings,
        size4Servings: d.menuItem.size4Servings,
        size5Servings: d.menuItem.size5Servings,
      },
    };
  });

  const coverage = computePlannerCoverage({
    guests: servesGuests,
    savoryPPG, sweetPPG, servingsPPG,
    items: mathItems, piecesMap, servingsMap, panQtys, groupOf,
  });

  // Search panel
  const [search, setSearch] = useState("");
  const filteredCandidates = (allMenuItems ?? [])
    .filter((mi) => mi.available)
    .filter((mi) => !search || mi.name.toLowerCase().includes(search.toLowerCase()))
    .slice(0, 30);

  if (!Number.isFinite(id)) return <AdminLayout><div className="p-8">Invalid id.</div></AdminLayout>;

  return (
    <AdminLayout>
      <div className="max-w-6xl mx-auto p-6 sm:p-8">
        <Link href="/admin/menu-packages" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground mb-4">
          <ArrowLeft className="w-4 h-4" /> All packages
        </Link>

        {loading ? (
          <div className="flex justify-center py-24"><Loader2 className="w-8 h-8 animate-spin text-primary" /></div>
        ) : !pkg ? (
          <div className="p-8 text-center text-muted-foreground">Package not found.</div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Left column — meta + items */}
            <div className="lg:col-span-2 space-y-6">
              <div className="bg-card rounded-2xl border border-border p-5 space-y-4">
                <div>
                  <label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Name</label>
                  <input value={name} onChange={(e) => setName(e.target.value)} className="w-full mt-1 px-3 py-2 rounded-xl border border-border bg-background" />
                </div>
                <div>
                  <label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Description</label>
                  <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} className="w-full mt-1 px-3 py-2 rounded-xl border border-border bg-background" />
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Image</label>
                    <div className="mt-1 flex items-center gap-2">
                      {imageUrl ? (
                        <img src={imageUrl} alt="" className="w-14 h-14 rounded-lg object-cover bg-secondary border border-border" />
                      ) : (
                        <div className="w-14 h-14 rounded-lg bg-secondary border border-border flex items-center justify-center">
                          <ImageIcon className="w-5 h-5 text-muted-foreground" />
                        </div>
                      )}
                      <button
                        type="button"
                        onClick={() => setShowImagePicker(true)}
                        className="px-3 py-2 rounded-xl border border-border text-sm font-semibold hover:bg-secondary inline-flex items-center gap-2"
                      >
                        <Library className="w-4 h-4" /> {imageUrl ? "Change" : "Choose from library"}
                      </button>
                      {imageUrl && (
                        <button
                          type="button"
                          onClick={() => setImageUrl("")}
                          className="text-xs text-muted-foreground hover:text-destructive"
                        >
                          Remove
                        </button>
                      )}
                    </div>
                  </div>
                  <div>
                    <label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Serves (guests)</label>
                    <input type="number" min={1} value={servesGuests} onChange={(e) => setServesGuests(parseInt(e.target.value || "0", 10) || 0)} className="w-full mt-1 px-3 py-2 rounded-xl border border-border bg-background" />
                  </div>
                </div>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={hidden} onChange={(e) => setHidden(e.target.checked)} />
                  Hidden — don't show this package on the public menu
                </label>
              </div>

              <div className="bg-card rounded-2xl border border-border p-5">
                <h3 className="font-bold mb-3">Items in this package</h3>
                {draftItems.length === 0 ? (
                  <p className="text-sm text-muted-foreground italic">No items yet — pick from the right.</p>
                ) : (
                  <div className="space-y-2">
                    {draftItems.map((d, idx) => {
                      const isPan = d.menuItem.pricingTemplate === "pan_sizes";
                      const sizeOpts: { val: SizeSlot; label: string }[] = [];
                      if (isPan) {
                        for (const slot of [1, 2, 3, 4, 5] as const) {
                          const lbl = sizeLabelOf(d.menuItem, slot);
                          if (lbl) sizeOpts.push({ val: slot, label: lbl });
                        }
                      }
                      return (
                        <div key={d.draftId} className="flex items-center gap-2 p-2 rounded-xl border border-border bg-background">
                          <div className="flex flex-col">
                            <button onClick={() => moveItem(d.draftId, -1)} disabled={idx === 0} className="text-xs disabled:opacity-30" aria-label="Move up">▲</button>
                            <button onClick={() => moveItem(d.draftId, 1)} disabled={idx === draftItems.length - 1} className="text-xs disabled:opacity-30" aria-label="Move down">▼</button>
                          </div>
                          <GripVertical className="w-4 h-4 text-muted-foreground shrink-0" />
                          <div className="flex-1 min-w-0">
                            <div className="font-semibold truncate">{d.menuItem.name}</div>
                            <div className="text-xs text-muted-foreground">{d.menuItem.category}</div>
                          </div>
                          {isPan && (
                            <select
                              value={d.sizeKey ?? ""}
                              onChange={(e) => updateItem(d.draftId, { sizeKey: parseInt(e.target.value, 10) })}
                              className="px-2 py-1 rounded-lg border border-border bg-background text-sm"
                            >
                              {sizeOpts.map((o) => <option key={o.val} value={o.val}>{o.label}</option>)}
                            </select>
                          )}
                          <input
                            type="number"
                            min={1}
                            value={d.quantity}
                            onChange={(e) => updateItem(d.draftId, { quantity: Math.max(1, parseInt(e.target.value || "1", 10) || 1) })}
                            className="w-20 px-2 py-1 rounded-lg border border-border bg-background text-sm text-center"
                          />
                          <button onClick={() => removeItem(d.draftId)} className="p-2 text-muted-foreground hover:text-destructive" aria-label="Remove">
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Embedded planner — coverage check */}
              <div className="bg-card rounded-2xl border border-border p-5">
                <h3 className="font-bold mb-1 flex items-center gap-2">
                  <Users className="w-4 h-4" /> Coverage check at {servesGuests} guests
                </h3>
                <p className="text-xs text-muted-foreground mb-3">
                  Uses the same per-guest math customers see in the planner.
                </p>
                <div className="grid grid-cols-3 gap-3 mb-4">
                  <PPGInput label="Savory / guest" value={savoryPPG} onChange={setSavoryPPG} />
                  <PPGInput label="Sweet / guest" value={sweetPPG} onChange={setSweetPPG} />
                  <PPGInput label="Entrée srv / guest" value={servingsPPG} onChange={setServingsPPG} />
                </div>
                <div className="space-y-3">
                  <CoverageRow label="Savory bites" need={coverage.needSavory} have={coverage.haveSavory} unit="pcs" />
                  <CoverageRow label="Sweet bites" need={coverage.needSweet} have={coverage.haveSweet} unit="pcs" />
                  <CoverageRow label="Entrée servings" need={coverage.needEntrees} have={coverage.haveEntrees} unit="srv" />
                </div>
              </div>

              <div className="flex gap-2">
                <button
                  onClick={handleSave}
                  disabled={saving}
                  className="px-5 py-3 rounded-xl bg-primary text-primary-foreground font-semibold hover:bg-primary/90 disabled:opacity-60 transition-colors flex items-center gap-2"
                >
                  {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                  Save package
                </button>
                <button onClick={() => navigate("/admin/menu-packages")} className="px-5 py-3 rounded-xl border border-border hover:bg-secondary text-foreground font-semibold">
                  Cancel
                </button>
              </div>
            </div>

            {/* Right — picker */}
            <div className="lg:col-span-1">
              <div className="bg-card rounded-2xl border border-border p-4 sticky top-4">
                <h3 className="font-bold mb-2">Add menu items</h3>
                <div className="relative mb-2">
                  <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                  <input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search…"
                    className="w-full pl-9 pr-3 py-2 rounded-xl border border-border bg-background text-sm"
                  />
                </div>
                <div className="max-h-[60vh] overflow-y-auto space-y-1">
                  {filteredCandidates.map((mi) => (
                    <button
                      key={mi.id}
                      onClick={() => addItem(mi)}
                      className="w-full text-left px-3 py-2 rounded-lg hover:bg-secondary flex items-center justify-between text-sm gap-2"
                    >
                      <div className="flex-1 min-w-0">
                        <div className="font-semibold truncate">{mi.name}</div>
                        <div className="text-xs text-muted-foreground truncate">{mi.category}</div>
                      </div>
                      <Plus className="w-4 h-4 text-muted-foreground shrink-0" />
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}

        {showImagePicker && (
          <ImagePickerModal
            onSelect={(url) => setImageUrl(url)}
            onClose={() => setShowImagePicker(false)}
          />
        )}
      </div>
    </AdminLayout>
  );
}

function PPGInput({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <div>
      <label className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">{label}</label>
      <input
        type="number"
        min={0}
        value={value}
        onChange={(e) => onChange(Math.max(0, parseFloat(e.target.value || "0") || 0))}
        className="w-full mt-1 px-2 py-1.5 rounded-lg border border-border bg-background text-sm text-center"
      />
    </div>
  );
}

function CoverageRow({ label, need, have, unit }: { label: string; need: number; have: number; unit: string }) {
  const pct = need === 0 ? 100 : Math.max(0, Math.min(100, (have / need) * 100));
  const met = have >= need;
  const barColor = met ? "bg-emerald-500" : pct >= 75 ? "bg-amber-400" : "bg-red-400";
  const txtColor = met ? "text-emerald-600" : pct >= 75 ? "text-amber-600" : "text-red-500";
  return (
    <div>
      <div className="flex justify-between items-baseline text-sm mb-1">
        <span className="font-semibold">{label}</span>
        <span className={`tabular-nums font-bold ${txtColor}`}>{have} / {need} {unit}</span>
      </div>
      <div className="h-2 bg-secondary rounded-full overflow-hidden">
        <div className={`h-full ${barColor} transition-all`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
