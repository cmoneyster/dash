import React, { useState, useCallback, useMemo } from "react";
import { AdminLayout } from "@/components/AdminLayout";
import {
  useAdminListMenuItems,
  useCreateMenuItem,
  useUpdateMenuItem,
  useDeleteMenuItem,
  useGenerateMenuItemDescription,
  getAdminListMenuItemsQueryKey
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { formatCurrency } from "@/lib/utils";
import { Plus, Edit2, Trash2, X, ImageIcon, Loader2, Check, Library, Infinity as InfinityIcon, Upload, GripVertical, Search, Sparkles, ChevronUp, ChevronDown } from "lucide-react";
import { useForm } from "react-hook-form";
import { getAdminToken } from "@/components/AdminGuard";
import { useAdminCategories, ADMIN_CATEGORIES_QUERY_KEY } from "@/lib/categories";
import { adminReorderMenuItems } from "@/lib/admin-menu";
import { MenuCsvDialog, ExportMenuButton, AppliedToast } from "./MenuCsvDialog";
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

interface ImageRecord {
  id: number;
  filename: string;
  servingUrl: string;
  uploadedAt: string;
}

function ImagePickerModal({
  onSelect,
  onClose,
}: {
  onSelect: (url: string) => void;
  onClose: () => void;
}) {
  const [images, setImages] = useState<ImageRecord[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [picked, setPicked] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/images", {
        headers: { Authorization: `Bearer ${getAdminToken()}` },
      });
      if (res.ok) setImages(await res.json());
    } finally {
      setLoading(false);
    }
  }, []);

  if (images === null && !loading) load();

  const handleSelect = (img: ImageRecord) => {
    setPicked(img.id);
    const url = `${window.location.origin}${img.servingUrl}`;
    onSelect(url);
    setTimeout(onClose, 400);
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-foreground/30 backdrop-blur-sm">
      <div className="bg-card w-full max-w-4xl rounded-3xl shadow-2xl overflow-hidden max-h-[85vh] flex flex-col">
        <div className="px-6 py-4 border-b border-border flex justify-between items-center bg-secondary/30 shrink-0">
          <div>
            <h2 className="font-display font-bold text-2xl">Image Library</h2>
            <p className="text-sm text-muted-foreground">Click an image to use it for this menu item</p>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-secondary rounded-full">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-6 overflow-y-auto">
          {loading && (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="w-8 h-8 animate-spin text-primary" />
            </div>
          )}
          {!loading && images?.length === 0 && (
            <div className="text-center py-16 text-muted-foreground">
              <ImageIcon className="w-12 h-12 mx-auto mb-3 opacity-30" />
              <p className="font-semibold">No images in library yet</p>
              <p className="text-sm mt-1">Go to Image Library in the sidebar to upload photos</p>
            </div>
          )}
          {!loading && images && images.length > 0 && (
            <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-3">
              {images.map((img) => (
                <button
                  key={img.id}
                  onClick={() => handleSelect(img)}
                  className={`relative group rounded-xl overflow-hidden border-2 transition-all duration-200 focus:outline-none ${
                    picked === img.id
                      ? "border-primary scale-95"
                      : "border-transparent hover:border-primary/50 hover:scale-[1.02]"
                  }`}
                >
                  <div className="aspect-[4/3] bg-secondary">
                    <img
                      src={img.servingUrl}
                      alt={img.filename}
                      className="w-full h-full object-cover"
                      loading="lazy"
                    />
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

function SortableMenuRow({
  itemId,
  isDirty,
  dragDisabled,
  children,
}: {
  itemId: number;
  isDirty: boolean;
  dragDisabled: boolean;
  children: React.ReactNode;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: itemId,
    disabled: dragDisabled,
  });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    position: isDragging ? "relative" : undefined,
    zIndex: isDragging ? 10 : undefined,
    background: isDragging ? "var(--card)" : undefined,
  };
  return (
    <tr
      ref={setNodeRef}
      style={style}
      className={`border-b border-border/50 transition-colors ${isDirty ? "bg-amber-50 dark:bg-amber-950/40 border-l-2 border-l-amber-400" : "hover:bg-secondary/20"}`}
      data-testid={`row-menu-item-${itemId}`}
    >
      <td className="px-2 py-2 w-8 align-middle">
        <button
          type="button"
          {...attributes}
          {...(dragDisabled ? {} : listeners)}
          disabled={dragDisabled}
          title={dragDisabled ? "Clear search to reorder" : "Drag to reorder within category"}
          aria-label={dragDisabled ? "Reordering disabled while searching" : "Drag to reorder"}
          className={`p-1 rounded transition-colors ${dragDisabled ? "text-muted-foreground/30 cursor-not-allowed" : "text-muted-foreground hover:text-foreground hover:bg-secondary cursor-grab active:cursor-grabbing"}`}
          data-testid={`drag-handle-menu-item-${itemId}`}
        >
          <GripVertical className="w-4 h-4" />
        </button>
      </td>
      {children}
    </tr>
  );
}

function computeLabelCount(policy: string, boxSizeRaw: string | number | null | undefined, qty: number): number {
  if (qty <= 0) return 0;
  if (policy === "combined") return 1;
  if (policy === "per_box") {
    const box = Math.max(1, Math.floor(Number(boxSizeRaw) || 1));
    if (box <= 1) return qty;
    return Math.ceil(qty / box);
  }
  return qty;
}

function LabelCountPreview({ policy, boxSize }: { policy: string; boxSize: string | number | null | undefined }) {
  const [previewQty, setPreviewQty] = useState(3);
  const count = computeLabelCount(policy, boxSize, previewQty);
  return (
    <div className="flex items-center gap-3 pt-1">
      <span className="text-xs text-muted-foreground shrink-0">Preview: if qty</span>
      <input
        type="number"
        min="1"
        step="1"
        value={previewQty}
        onChange={(e) => setPreviewQty(Math.max(1, parseInt(e.target.value, 10) || 1))}
        className="w-16 px-2 py-1 border rounded-lg text-xs text-center"
      />
      <span className="text-xs text-muted-foreground shrink-0">is ordered →</span>
      <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-primary/10 text-primary text-xs font-semibold">
        {count} {count === 1 ? "label" : "labels"}
      </span>
    </div>
  );
}

export default function MenuManager() {
  const queryClient = useQueryClient();
  const { data: items, isLoading } = useAdminListMenuItems();

  type ComboSlotOption = { menuItemId: number; name: string };
  type ComboSlot = { slotId: string; slotName: string; minQty: number; maxQty: number; options: ComboSlotOption[] };

  const [editingItem, setEditingItem] = useState<any>(null);
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [comboSlots, setComboSlots] = useState<ComboSlot[]>([]);
  const [isPickerOpen, setIsPickerOpen] = useState(false);
  const [isCsvDialogOpen, setIsCsvDialogOpen] = useState(false);
  const [applyResult, setApplyResult] = useState<{
    categoriesCreated: number; categoriesUpdated: number; categoriesDeleted: number;
    itemsCreated: number; itemsUpdated: number; itemsDeleted: number;
  } | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string>("");
  const [isNewCategory, setIsNewCategory] = useState(false);

  type InlineEdit = { name: string; description: string; price: string; available: boolean; eventActive: boolean; eventTakerVisible: boolean; eventStock: string };
  const [localEdits, setLocalEdits] = useState<Record<number, InlineEdit>>({});
  const [savingIds, setSavingIds] = useState<Set<number>>(new Set());
  const [searchQuery, setSearchQuery] = useState("");
  const [generatingDialogDesc, setGeneratingDialogDesc] = useState(false);
  const [generatingInlineFor, setGeneratingInlineFor] = useState<number | null>(null);
  const { mutateAsync: generateDescMutation } = useGenerateMenuItemDescription();

  const dirtyIds = Object.keys(localEdits).map(Number);
  const hasDirty = dirtyIds.length > 0;
  const isSearching = searchQuery.trim().length > 0;

  const filteredItems = useMemo(() => {
    if (!items) return [];
    const q = searchQuery.trim().toLowerCase();
    if (!q) return items;
    return items.filter((it: any) =>
      String(it.name ?? "").toLowerCase().includes(q) ||
      String(it.description ?? "").toLowerCase().includes(q) ||
      String(it.category ?? "").toLowerCase().includes(q)
    );
  }, [items, searchQuery]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const handleDragEnd = useCallback(async (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id || !items) return;
    const activeId = Number(active.id);
    const overId = Number(over.id);
    const activeItem = items.find((it: any) => it.id === activeId);
    const overItem = items.find((it: any) => it.id === overId);
    if (!activeItem || !overItem) return;
    // Cross-category drags are not persisted — Menu Manager moves items
    // within their own category only. To change category use the edit dialog.
    if (activeItem.category !== overItem.category) return;
    const catItems = items
      .filter((it: any) => it.category === activeItem.category)
      .slice()
      .sort((a: any, b: any) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.id - b.id);
    const oldIndex = catItems.findIndex((it: any) => it.id === activeId);
    const newIndex = catItems.findIndex((it: any) => it.id === overId);
    if (oldIndex === -1 || newIndex === -1 || oldIndex === newIndex) return;
    const reordered = arrayMove(catItems, oldIndex, newIndex);
    const updates = reordered.map((it: any, idx: number) => ({ id: it.id, sortOrder: (idx + 1) * 10 }));
    const updateMap = new Map(updates.map(u => [u.id, u.sortOrder]));
    const previous = queryClient.getQueryData(getAdminListMenuItemsQueryKey());
    queryClient.setQueryData(getAdminListMenuItemsQueryKey(), (old: any) => {
      if (!Array.isArray(old)) return old;
      return old
        .map((it: any) => updateMap.has(it.id) ? { ...it, sortOrder: updateMap.get(it.id)! } : it)
        .slice()
        .sort((a: any, b: any) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.id - b.id);
    });
    try {
      await adminReorderMenuItems(updates);
      queryClient.invalidateQueries({ queryKey: getAdminListMenuItemsQueryKey() });
    } catch (err) {
      queryClient.setQueryData(getAdminListMenuItemsQueryKey(), previous);
      alert("Failed to save new order. Please try again.");
    }
  }, [items, queryClient]);

  function patchEdit(id: number, item: any, patch: Partial<InlineEdit>) {
    setLocalEdits(prev => {
      const base: InlineEdit = prev[id] ?? {
        name: item.name,
        description: item.description,
        price: String(item.price),
        available: item.available,
        eventActive: item.eventActive ?? false,
        eventTakerVisible: item.eventTakerVisible ?? false,
        eventStock: item.eventStock == null ? "" : String(item.eventStock),
      };
      return { ...prev, [id]: { ...base, ...patch } };
    });
  }

  const { data: adminCategories } = useAdminCategories();
  const itemCategorySet = new Set((items ?? []).map((it: any) => it.category as string));
  const orderedFromApi = (adminCategories ?? []).map((c) => c.name);
  const extraFromItems = Array.from(itemCategorySet).filter((c) => !orderedFromApi.includes(c)).sort();
  const existingCategories = [...orderedFromApi, ...extraFromItems];

  const createMut = useCreateMenuItem({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getAdminListMenuItemsQueryKey() });
        setIsDialogOpen(false);
      },
    },
  });

  const updateMut = useUpdateMenuItem({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getAdminListMenuItemsQueryKey() });
        setIsDialogOpen(false);
      },
    },
  });

  const inlineUpdateMut = useUpdateMenuItem();

  async function saveAllEdits() {
    const ids = [...dirtyIds];
    setSavingIds(new Set(ids));
    try {
      for (const id of ids) {
        const edit = localEdits[id];
        const original = items?.find((it: any) => it.id === id);
        if (!original || !edit) continue;
        await inlineUpdateMut.mutateAsync({
          id,
          data: {
            ...original,
            name: edit.name,
            description: edit.description,
            price: parseFloat(edit.price),
            available: edit.available,
            eventActive: edit.eventActive,
            eventTakerVisible: edit.eventTakerVisible,
            eventStock: edit.eventStock.trim() === "" ? null : parseInt(edit.eventStock),
            allergens: original.allergens ?? [],
            servingSize: original.servingSize,
            unit: original.unit,
            category: original.category,
          },
        });
      }
      await queryClient.refetchQueries({ queryKey: getAdminListMenuItemsQueryKey() });
    } finally {
      setLocalEdits({});
      setSavingIds(new Set());
    }
  }

  const deleteMut = useDeleteMenuItem({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getAdminListMenuItemsQueryKey() });
      },
    },
  });

  const { register, handleSubmit, reset, setValue, watch } = useForm();
  const imageUrlValue   = watch("imageUrl", "");
  const pricingTemplate = watch("pricingTemplate", "per_unit");
  const watchedCategory = watch("category", "");
  const watchedName     = watch("name", "");

  // Auto-set pricing template when category changes. Drive the default from
  // the picked category's structured plannerGroup ("entree" → pan sizes,
  // anything else → per unit) rather than from the category name itself, so
  // any future entrée-group parent (e.g. "Mains - Beef") gets the correct
  // default with no source edits.
  React.useEffect(() => {
    if (!watchedCategory) return;
    const picked = adminCategories?.find(c => c.name === String(watchedCategory));
    const isEntreeCat = picked?.plannerGroup === "entree";
    setValue("pricingTemplate", isEntreeCat ? "pan_sizes" : "per_unit");
  }, [watchedCategory, adminCategories, setValue]);

  const generateDescription = async (name: string, target: "dialog" | number) => {
    if (!name.trim()) return;
    if (target === "dialog") setGeneratingDialogDesc(true);
    else setGeneratingInlineFor(target);
    try {
      const result = await generateDescMutation({ data: { name: name.trim() } });
      if (typeof result.description === "string") {
        if (target === "dialog") {
          setValue("description", result.description);
        } else {
          const item = items?.find((it: any) => it.id === target);
          if (item) patchEdit(target, item, { description: result.description });
        }
      }
    } catch {
      // silently ignore — the field stays as-is if generation fails
    } finally {
      if (target === "dialog") setGeneratingDialogDesc(false);
      else setGeneratingInlineFor(null);
    }
  };

  const openNew = () => {
    setEditingItem(null);
    reset({
      available: true, servingSize: 1, unit: "tray", price: 0, imageUrl: "", minimumOrderQty: 1,
      otdEligible: false,
      labelPolicy: "per_unit",
      labelBoxSize: "",
      pricingTemplate: "per_unit",
      size1Label: "Small Pan",  size1Servings: 15, size1Price: "",
      size2Label: "Medium Pan", size2Servings: 30, size2Price: "",
      size3Label: "Large Pan",  size3Servings: 45, size3Price: "",
      size4Label: "",       size4Servings: "",  size4Price: "",
      size5Label: "",       size5Servings: "",  size5Price: "",
      internalNotes: "",
      isCombo: false,
      comboComponentLabels: false,
    });
    setComboSlots([]);
    setPreviewUrl("");
    setIsNewCategory(false);
    setIsDialogOpen(true);
  };

  const openEdit = (item: any) => {
    setEditingItem(item);
    reset({
      ...item,
      allergens: item.allergens.join(", "),
      size1Label: item.size1Label ?? "Small Pan",  size1Servings: item.size1Servings ?? 15, size1Price: item.size1Price ?? "",
      size2Label: item.size2Label ?? "Medium Pan", size2Servings: item.size2Servings ?? 30, size2Price: item.size2Price ?? "",
      size3Label: item.size3Label ?? "Large Pan",  size3Servings: item.size3Servings ?? 45, size3Price: item.size3Price ?? "",
      size4Label: item.size4Label ?? "",       size4Servings: item.size4Servings ?? "",  size4Price: item.size4Price ?? "",
      size5Label: item.size5Label ?? "",       size5Servings: item.size5Servings ?? "",  size5Price: item.size5Price ?? "",
      pricingTemplate: item.pricingTemplate ?? "per_unit",
      labelPolicy: item.labelPolicy ?? "per_unit",
      labelBoxSize: item.labelBoxSize ?? "",
      isCombo: item.isCombo ?? false,
      comboComponentLabels: item.comboComponentLabels ?? false,
    });
    setComboSlots(Array.isArray(item.comboSlots) ? item.comboSlots : []);
    setPreviewUrl(item.imageUrl ?? "");
    setIsNewCategory(false);
    setIsDialogOpen(true);
  };

  const parseSizePrice = (v: any) => (v === "" || v == null) ? null : parseFloat(String(v));
  const parseSizeServings = (v: any) => (v === "" || v == null) ? null : parseInt(String(v), 10);
  const parseSizeLabel = (v: any) => (v === "" || v == null) ? null : String(v).trim() || null;

  const onSubmit = (data: any) => {
    const payload = {
      ...data,
      price: parseFloat(data.price) || 0,
      servingSize: parseInt(data.servingSize, 10) || 1,
      allergens: data.allergens
        ? data.allergens.split(",").map((s: string) => s.trim()).filter(Boolean)
        : [],
      minimumOrderQty: data.minimumOrderQty ? parseInt(data.minimumOrderQty, 10) : 1,
      tier2Qty: data.tier2Qty ? parseInt(data.tier2Qty, 10) : null,
      tier2Price: data.tier2Price ? parseFloat(data.tier2Price) : null,
      tier3Qty: data.tier3Qty ? parseInt(data.tier3Qty, 10) : null,
      tier3Price: data.tier3Price ? parseFloat(data.tier3Price) : null,
      pricingTemplate: data.pricingTemplate ?? "per_unit",
      size1Label: parseSizeLabel(data.size1Label) ?? "Small Pan",
      size1Servings: parseSizeServings(data.size1Servings) ?? 15,
      size1Price: parseSizePrice(data.size1Price),
      size2Label: parseSizeLabel(data.size2Label) ?? "Medium Pan",
      size2Servings: parseSizeServings(data.size2Servings) ?? 30,
      size2Price: parseSizePrice(data.size2Price),
      size3Label: parseSizeLabel(data.size3Label) ?? "Large Pan",
      size3Servings: parseSizeServings(data.size3Servings) ?? 45,
      size3Price: parseSizePrice(data.size3Price),
      size4Label: parseSizeLabel(data.size4Label),
      size4Servings: parseSizeServings(data.size4Servings),
      size4Price: parseSizePrice(data.size4Price),
      size5Label: parseSizeLabel(data.size5Label),
      size5Servings: parseSizeServings(data.size5Servings),
      size5Price: parseSizePrice(data.size5Price),
      isCombo: !!data.isCombo,
      comboSlots: data.isCombo && comboSlots.length > 0 ? comboSlots : null,
      comboComponentLabels: !!data.comboComponentLabels,
    };
    if (editingItem) {
      updateMut.mutate({ id: editingItem.id, data: payload });
    } else {
      createMut.mutate({ data: payload });
    }
  };

  const handlePickImage = (url: string) => {
    setValue("imageUrl", url);
    setPreviewUrl(url);
  };

  return (
    <AdminLayout>
      <div className="flex justify-between items-end mb-8">
        <div>
          <h1 className="font-display font-bold text-2xl sm:text-4xl mb-2">Menu Manager</h1>
          <p className="text-muted-foreground">Add, edit, or remove items from your catering menu.</p>
        </div>
        <div className="flex gap-2">
          <ExportMenuButton />
          <button
            onClick={() => setIsCsvDialogOpen(true)}
            className="px-4 py-2.5 bg-secondary text-foreground font-semibold rounded-xl hover:bg-secondary/70 transition-colors flex items-center gap-2"
          >
            <Upload className="w-4 h-4" /> Import CSV
          </button>
          <button
            onClick={openNew}
            className="px-5 py-2.5 bg-primary text-primary-foreground font-semibold rounded-xl hover:bg-primary/90 transition-colors flex items-center gap-2"
          >
            <Plus className="w-5 h-5" /> Add Item
          </button>
        </div>
      </div>

      {isCsvDialogOpen && (
        <MenuCsvDialog
          onClose={() => setIsCsvDialogOpen(false)}
          onApplied={(result) => {
            setIsCsvDialogOpen(false);
            setApplyResult(result);
            queryClient.invalidateQueries({ queryKey: getAdminListMenuItemsQueryKey() });
            queryClient.invalidateQueries({ queryKey: ADMIN_CATEGORIES_QUERY_KEY });
          }}
        />
      )}
      {applyResult && <AppliedToast result={applyResult} onDone={() => setApplyResult(null)} />}

      <div className="mb-4 relative max-w-md">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
        <input
          type="search"
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          placeholder="Search items by name, description, or category…"
          className="w-full pl-10 pr-9 py-2.5 bg-card border border-border rounded-xl text-sm focus:border-primary focus:ring-1 focus:ring-primary/20 outline-none transition-all"
          data-testid="input-menu-search"
        />
        {isSearching && (
          <button
            type="button"
            onClick={() => setSearchQuery("")}
            title="Clear search"
            className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded text-muted-foreground hover:text-foreground hover:bg-secondary"
            data-testid="button-clear-search"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      <div className="bg-card border border-border rounded-2xl shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-secondary/50 text-xs uppercase tracking-wider text-muted-foreground">
                <th className="px-2 py-3 font-semibold w-8"></th>
                <th className="px-3 py-3 font-semibold w-12"></th>
                <th className="px-3 py-3 font-semibold">Name &amp; Description</th>
                <th className="px-3 py-3 font-semibold w-20">Price</th>
                <th className="px-3 py-3 font-semibold w-16 text-center" title="Visible on catering menu">Catering</th>
                <th className="px-3 py-3 font-semibold w-16 text-center" title="Show on guest /event ordering page">Guest Event</th>
                <th className="px-3 py-3 font-semibold w-16 text-center" title="Show on staff /event-taker ordering page">Taker</th>
                <th className="px-3 py-3 font-semibold w-20 text-center" title="Stock limit — leave blank for unlimited">Stock</th>
                <th className="px-3 py-3 font-semibold text-right w-16"></th>
              </tr>
            </thead>
            <tbody>
              {isLoading && (
                <tr><td colSpan={9} className="px-6 py-12 text-center text-muted-foreground">
                  <Loader2 className="w-6 h-6 animate-spin mx-auto" />
                </td></tr>
              )}
              {!isLoading && items && isSearching && filteredItems.length === 0 && (
                <tr><td colSpan={9} className="px-6 py-12 text-center text-muted-foreground">
                  <Search className="w-6 h-6 mx-auto mb-2 opacity-40" />
                  <p className="text-sm">No items match "{searchQuery}".</p>
                  <button
                    type="button"
                    onClick={() => setSearchQuery("")}
                    className="text-xs text-primary hover:underline mt-2"
                  >
                    Clear search
                  </button>
                </td></tr>
              )}
              {items && existingCategories.map(cat => {
                const catItems = filteredItems.filter((item: any) => item.category === cat);
                if (!catItems.length) return null;
                return (
                  <React.Fragment key={cat}>
                    <tr className="bg-secondary/40 border-y border-border">
                      <td colSpan={9} className="px-6 py-2">
                        <span className="text-xs font-bold uppercase tracking-widest text-muted-foreground">{cat}</span>
                        <span className="ml-2 text-xs text-muted-foreground/50">{catItems.length} item{catItems.length !== 1 ? "s" : ""}</span>
                      </td>
                    </tr>
                    <SortableContext items={catItems.map((it: any) => it.id)} strategy={verticalListSortingStrategy}>
                    {catItems.map((item: any) => {
                      const edit = localEdits[item.id];
                      const isDirty = !!edit;
                      const isSaving = savingIds.has(item.id);
                      const cur = edit ?? { name: item.name, description: item.description, price: String(item.price), available: item.available, eventActive: item.eventActive ?? false, eventTakerVisible: item.eventTakerVisible ?? false, eventStock: item.eventStock == null ? "" : String(item.eventStock) };

                      return (
                        <SortableMenuRow key={item.id} itemId={item.id} isDirty={isDirty} dragDisabled={isSearching}>
                          <td className="px-3 py-2">
                            <div className="w-8 h-8 rounded-lg bg-secondary overflow-hidden shrink-0">
                              {item.imageUrl
                                ? <img src={item.imageUrl} alt="" className="w-full h-full object-cover" />
                                : <ImageIcon className="w-4 h-4 m-auto text-muted-foreground mt-2" />}
                            </div>
                          </td>
                          <td className="px-3 py-2">
                            <input
                              value={cur.name}
                              onChange={e => patchEdit(item.id, item, { name: e.target.value })}
                              disabled={isSaving}
                              className="w-full font-bold text-sm px-2 py-0.5 rounded-md border border-transparent hover:border-border focus:border-primary focus:ring-1 focus:ring-primary/20 outline-none bg-transparent transition-all mb-1"
                            />
                            <div className="relative">
                              <textarea
                                value={cur.description}
                                onChange={e => patchEdit(item.id, item, { description: e.target.value })}
                                disabled={isSaving}
                                rows={2}
                                className="w-full text-xs text-muted-foreground px-2 py-0.5 rounded-md border border-transparent hover:border-border focus:border-primary focus:ring-1 focus:ring-primary/20 outline-none bg-transparent transition-all resize-none leading-snug"
                              />
                              <button
                                type="button"
                                onClick={() => generateDescription(cur.name, item.id)}
                                disabled={generatingInlineFor === item.id || isSaving || !cur.name.trim()}
                                title="Generate description with AI"
                                className="absolute top-0 right-0 flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded text-primary/70 hover:text-primary hover:bg-primary/5 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                              >
                                {generatingInlineFor === item.id ? <Loader2 className="w-2.5 h-2.5 animate-spin" /> : <Sparkles className="w-2.5 h-2.5" />}
                                {generatingInlineFor === item.id ? "…" : "AI"}
                              </button>
                            </div>
                          </td>
                          <td className="px-2 py-2">
                            {(item as any).pricingTemplate === "pan_sizes" ? (
                              <div className="text-xs text-muted-foreground space-y-0.5 min-w-[100px]">
                                {[1,2,3,4,5].map(n => {
                                  const lbl = (item as any)[`size${n}Label`];
                                  const prc = (item as any)[`size${n}Price`];
                                  if (!lbl || prc == null) return null;
                                  return (
                                    <div key={n} className="flex gap-1">
                                      <span className="font-medium">{lbl}:</span>
                                      <span>${parseFloat(String(prc)).toFixed(0)}</span>
                                    </div>
                                  );
                                })}
                              </div>
                            ) : (
                              <div className="relative">
                                <span className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground text-xs pointer-events-none">$</span>
                                <input
                                  type="number"
                                  step="0.01"
                                  min="0"
                                  value={cur.price}
                                  onChange={e => patchEdit(item.id, item, { price: e.target.value })}
                                  disabled={isSaving}
                                  className="w-full pl-4 pr-1 py-1 text-sm font-semibold rounded-md border border-transparent hover:border-border focus:border-primary focus:ring-1 focus:ring-primary/20 outline-none bg-transparent transition-all"
                                />
                              </div>
                            )}
                          </td>
                          <td className="px-2 py-2 text-center">
                            <button
                              type="button"
                              disabled={isSaving}
                              title={cur.available ? "Active — click to hide" : "Hidden — click to activate"}
                              onClick={() => patchEdit(item.id, item, { available: !cur.available })}
                              className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus:outline-none ${cur.available ? "bg-emerald-500" : "bg-muted"}`}
                            >
                              <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform ${cur.available ? "translate-x-[18px]" : "translate-x-0.5"}`} />
                            </button>
                          </td>
                          <td className="px-2 py-2 text-center">
                            <button
                              type="button"
                              disabled={isSaving}
                              title={cur.eventActive ? "On guest event menu — click to remove" : "Off guest event menu — click to add"}
                              onClick={() => patchEdit(item.id, item, { eventActive: !cur.eventActive })}
                              className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus:outline-none ${cur.eventActive ? "bg-primary" : "bg-muted"}`}
                            >
                              <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform ${cur.eventActive ? "translate-x-[18px]" : "translate-x-0.5"}`} />
                            </button>
                          </td>
                          <td className="px-2 py-2 text-center">
                            <button
                              type="button"
                              disabled={isSaving}
                              title={cur.eventTakerVisible ? "On staff order taker — click to remove" : "Off staff order taker — click to add"}
                              onClick={() => patchEdit(item.id, item, { eventTakerVisible: !cur.eventTakerVisible })}
                              className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus:outline-none ${cur.eventTakerVisible ? "bg-indigo-500" : "bg-muted"}`}
                            >
                              <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform ${cur.eventTakerVisible ? "translate-x-[18px]" : "translate-x-0.5"}`} />
                            </button>
                          </td>
                          <td className="px-2 py-2">
                            <div className="flex items-center gap-1">
                              <input
                                type="text"
                                inputMode="numeric"
                                pattern="[0-9]*"
                                value={cur.eventStock}
                                onChange={e => {
                                  const v = e.target.value.replace(/[^0-9]/g, "");
                                  patchEdit(item.id, item, { eventStock: v });
                                }}
                                disabled={isSaving}
                                placeholder="∞"
                                title="Stock limit — clear or click ∞ for unlimited"
                                className="w-12 px-1 py-1 text-sm font-semibold rounded-md border border-transparent hover:border-border focus:border-primary focus:ring-1 focus:ring-primary/20 outline-none bg-transparent transition-all text-center placeholder:text-muted-foreground/40"
                              />
                              <button
                                type="button"
                                disabled={isSaving}
                                title={cur.eventStock === "" ? "Already unlimited" : "Set to unlimited"}
                                onClick={() => patchEdit(item.id, item, { eventStock: "" })}
                                className={`p-1 rounded-md transition-colors ${cur.eventStock === "" ? "text-emerald-600" : "text-muted-foreground hover:text-primary hover:bg-secondary"}`}
                              >
                                <InfinityIcon className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </td>
                          <td className="px-2 py-2 text-right">
                            {isSaving ? (
                              <Loader2 className="w-4 h-4 animate-spin ml-auto text-muted-foreground" />
                            ) : (
                              <>
                                <button onClick={() => openEdit(item)} title="Full edit" className="p-1.5 text-muted-foreground hover:text-primary transition-colors inline-block">
                                  <Edit2 className="w-3.5 h-3.5" />
                                </button>
                                <button
                                  onClick={() => { if (confirm("Delete item?")) deleteMut.mutate({ id: item.id }); }}
                                  title="Delete item"
                                  className="p-1.5 text-muted-foreground hover:text-destructive transition-colors inline-block"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              </>
                            )}
                          </td>
                        </SortableMenuRow>
                      );
                    })}
                    </SortableContext>
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
          </DndContext>
        </div>
      </div>

      {hasDirty && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40 flex items-center gap-3 bg-foreground text-background px-6 py-3.5 rounded-2xl shadow-2xl shadow-black/30 animate-in slide-in-from-bottom-4 duration-200">
          <span className="font-semibold text-sm">
            {dirtyIds.length} unsaved {dirtyIds.length === 1 ? "change" : "changes"}
          </span>
          <button
            onClick={() => setLocalEdits({})}
            className="text-sm text-background/60 hover:text-background transition-colors"
          >
            Discard
          </button>
          <button
            onClick={saveAllEdits}
            className="px-4 py-2 bg-primary text-primary-foreground font-bold text-sm rounded-xl hover:bg-primary/90 transition-colors flex items-center gap-2"
          >
            {savingIds.size > 0 ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
            Save {dirtyIds.length === 1 ? "change" : "all"}
          </button>
        </div>
      )}

      {isDialogOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-foreground/20 backdrop-blur-sm">
          <div className="bg-card w-full max-w-2xl rounded-3xl shadow-2xl overflow-hidden max-h-[90vh] flex flex-col">
            <div className="px-6 py-4 border-b border-border flex justify-between items-center bg-secondary/30">
              <h2 className="font-display font-bold text-2xl">
                {editingItem ? "Edit Menu Item" : "New Menu Item"}
              </h2>
              <button onClick={() => setIsDialogOpen(false)} className="p-2 hover:bg-secondary rounded-full">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-6 overflow-y-auto">
              <form id="menu-form" onSubmit={handleSubmit(onSubmit)} className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div className="col-span-2 sm:col-span-1">
                    <label className="block text-sm font-semibold mb-1">Name</label>
                    <input {...register("name")} required className="w-full px-4 py-2 border rounded-xl" />
                  </div>
                  <div className="col-span-2 sm:col-span-1">
                    <label className="block text-sm font-semibold mb-1">Category</label>
                    {isNewCategory ? (
                      <div className="flex gap-2">
                        <input
                          {...register("category")}
                          required
                          autoFocus
                          placeholder="New category name"
                          className="w-full px-4 py-2 border rounded-xl"
                        />
                        <button
                          type="button"
                          onClick={() => {
                            setIsNewCategory(false);
                            setValue("category", editingItem?.category ?? existingCategories[0] ?? "");
                          }}
                          className="px-3 py-2 text-muted-foreground hover:text-foreground border rounded-xl text-sm shrink-0"
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <select
                        {...register("category", {
                          onChange: (e) => {
                            if (e.target.value === "__new__") {
                              setIsNewCategory(true);
                              setValue("category", "");
                            }
                          },
                        })}
                        required
                        className="w-full px-4 py-2 border rounded-xl bg-background"
                      >
                        {existingCategories.map((cat) => (
                          <option key={cat} value={cat}>{cat}</option>
                        ))}
                        <option value="__new__">+ Add new category…</option>
                      </select>
                    )}
                  </div>
                </div>

                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="block text-sm font-semibold">Description</label>
                    <button
                      type="button"
                      onClick={() => generateDescription(watchedName, "dialog")}
                      disabled={generatingDialogDesc || !watchedName.trim()}
                      className="flex items-center gap-1 text-xs px-2 py-1 rounded-lg border border-primary/30 text-primary hover:bg-primary/5 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                    >
                      {generatingDialogDesc ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />}
                      {generatingDialogDesc ? "Generating…" : "Generate with AI"}
                    </button>
                  </div>
                  <textarea {...register("description")} required rows={2} className="w-full px-4 py-2 border rounded-xl resize-none" />
                </div>

                {/* Pricing Template toggle */}
                <div>
                  <label className="block text-sm font-semibold mb-2">Pricing Type</label>
                  <div className="flex gap-2 flex-wrap">
                    <label className="flex items-center gap-2 px-4 py-2.5 border rounded-xl cursor-pointer transition-colors hover:bg-secondary/50">
                      <input {...register("pricingTemplate")} type="radio" value="per_unit" className="accent-primary" />
                      <span className="text-sm font-medium">Per Unit <span className="text-muted-foreground font-normal text-xs">(pieces, packs…)</span></span>
                    </label>
                    <label className="flex items-center gap-2 px-4 py-2.5 border rounded-xl cursor-pointer transition-colors hover:bg-secondary/50">
                      <input {...register("pricingTemplate")} type="radio" value="pan_sizes" className="accent-primary" />
                      <span className="text-sm font-medium">Pan Sizes <span className="text-muted-foreground font-normal text-xs">(entrées — 5 size slots)</span></span>
                    </label>
                  </div>
                </div>

                {pricingTemplate === "pan_sizes" ? (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <label className="block text-sm font-semibold">Pan Sizes &amp; Pricing</label>
                      <span className="text-xs text-muted-foreground">Slots 4–5 hidden if left blank</span>
                    </div>
                    {([1, 2, 3, 4, 5] as const).map(n => (
                      <div key={n} className={`grid grid-cols-3 gap-2 p-3 rounded-xl ${n <= 3 ? "bg-secondary/50 border border-border/60" : "bg-secondary/20 border border-dashed border-border/40"}`}>
                        <div>
                          <label className="block text-xs font-medium text-muted-foreground mb-1">{n <= 3 ? `Size ${n} — Label` : `Size ${n} (optional)`}</label>
                          <input
                            {...register(`size${n}Label`)}
                            className="w-full px-3 py-1.5 border rounded-lg text-sm bg-background"
                            placeholder={n === 1 ? "Small Pan" : n === 2 ? "Medium Pan" : n === 3 ? "Large Pan" : `Size ${n}`}
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-medium text-muted-foreground mb-1">Servings</label>
                          <input
                            {...register(`size${n}Servings`)}
                            type="number" min="1"
                            className="w-full px-3 py-1.5 border rounded-lg text-sm bg-background"
                            placeholder={n === 1 ? "15" : n === 2 ? "30" : n === 3 ? "45" : ""}
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-medium text-muted-foreground mb-1">Price</label>
                          <input
                            {...register(`size${n}Price`)}
                            type="number" step="0.01" min="0"
                            className="w-full px-3 py-1.5 border rounded-lg text-sm bg-background"
                            placeholder="0.00"
                          />
                        </div>
                      </div>
                    ))}
                    {/* Hidden base price (required by schema) */}
                    <input {...register("price")} type="hidden" value="0" />
                    <p className="text-xs text-muted-foreground">Min. order qty applies per pan of the chosen size.</p>
                  </div>
                ) : (
                  <div className="grid grid-cols-3 gap-4">
                    <div>
                      <label className="block text-sm font-semibold mb-1">Price</label>
                      <input {...register("price")} type="number" step="0.01" required className="w-full px-4 py-2 border rounded-xl" />
                    </div>
                    <div>
                      <label className="block text-sm font-semibold mb-1">Serves</label>
                      <input {...register("servingSize")} type="number" required className="w-full px-4 py-2 border rounded-xl" />
                    </div>
                    <div>
                      <label className="block text-sm font-semibold mb-1">Unit</label>
                      <input {...register("unit")} required placeholder="tray" className="w-full px-4 py-2 border rounded-xl" />
                    </div>
                  </div>
                )}

                <div>
                  <label className="block text-sm font-semibold mb-2">Photo</label>
                  <div className="flex gap-3">
                    {previewUrl && (
                      <div className="w-20 h-15 rounded-xl overflow-hidden border border-border shrink-0" style={{ aspectRatio: "4/3", width: "80px" }}>
                        <img src={previewUrl} alt="" className="w-full h-full object-cover" />
                      </div>
                    )}
                    <div className="flex-1 space-y-2">
                      <input
                        {...register("imageUrl")}
                        placeholder="https://… or pick from library"
                        className="w-full px-4 py-2 border rounded-xl text-sm"
                        onChange={(e) => setPreviewUrl(e.target.value)}
                      />
                      <button
                        type="button"
                        onClick={() => setIsPickerOpen(true)}
                        className="flex items-center gap-2 px-4 py-2 bg-secondary hover:bg-secondary/70 text-sm font-semibold rounded-xl transition-colors w-full justify-center"
                      >
                        <Library className="w-4 h-4" />
                        Pick from Image Library
                      </button>
                    </div>
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-semibold mb-1">Allergens (comma separated)</label>
                  <input {...register("allergens")} placeholder="Nuts, Dairy" className="w-full px-4 py-2 border rounded-xl" />
                </div>

                <div>
                  <label className="block text-sm font-semibold mb-1">Minimum Order Quantity</label>
                  <input {...register("minimumOrderQty")} type="number" min="1" className="w-full px-4 py-2 border rounded-xl" />
                </div>

                {pricingTemplate !== "pan_sizes" && (
                <div className="space-y-2">
                  <label className="block text-sm font-semibold">Volume Pricing Tiers <span className="font-normal text-muted-foreground text-xs">(optional)</span></label>
                  <div className="grid grid-cols-2 gap-3 p-4 bg-secondary/50 rounded-xl">
                    <div>
                      <label className="block text-xs font-medium text-muted-foreground mb-1">Tier 2 — Min. Qty</label>
                      <input {...register("tier2Qty")} type="number" min="1" placeholder="e.g. 5" className="w-full px-3 py-2 border rounded-lg text-sm bg-white dark:bg-input text-foreground" />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-muted-foreground mb-1">Tier 2 — Price / ea</label>
                      <input {...register("tier2Price")} type="number" step="0.01" min="0" placeholder="e.g. 9.50" className="w-full px-3 py-2 border rounded-lg text-sm bg-white dark:bg-input text-foreground" />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-muted-foreground mb-1">Tier 3 — Min. Qty</label>
                      <input {...register("tier3Qty")} type="number" min="1" placeholder="e.g. 10" className="w-full px-3 py-2 border rounded-lg text-sm bg-white dark:bg-input text-foreground" />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-muted-foreground mb-1">Tier 3 — Price / ea</label>
                      <input {...register("tier3Price")} type="number" step="0.01" min="0" placeholder="e.g. 8.50" className="w-full px-3 py-2 border rounded-lg text-sm bg-white dark:bg-input text-foreground" />
                    </div>
                  </div>
                </div>
                )}

                <div>
                  <label className="block text-sm font-semibold mb-1">
                    Internal Notes <span className="font-normal text-muted-foreground text-xs">(kitchen-only — not shown to customers)</span>
                  </label>
                  <textarea
                    {...register("internalNotes")}
                    rows={2}
                    placeholder="e.g. Contains peanut oil — alert staff if allergy; keep hot"
                    className="w-full px-4 py-2 border rounded-xl resize-none text-sm"
                  />
                </div>

                <div className="space-y-3 p-4 bg-secondary/40 rounded-xl border border-border/50">
                  <label className="block text-sm font-semibold">Visibility</label>
                  <div className="space-y-2">
                    <label className="flex items-start gap-2 cursor-pointer">
                      <input {...register("available")} type="checkbox" className="w-4 h-4 mt-0.5 accent-primary" />
                      <span className="text-sm">
                        <span className="font-medium">Catering Menu</span>
                        <span className="text-muted-foreground"> — show on the public catering ordering page</span>
                      </span>
                    </label>
                    <label className="flex items-start gap-2 cursor-pointer">
                      <input {...register("eventActive")} type="checkbox" className="w-4 h-4 mt-0.5 accent-primary" />
                      <span className="text-sm">
                        <span className="font-medium">Guest Event Page</span>
                        <span className="text-muted-foreground"> — show on the guest <code>/event</code> ordering page</span>
                      </span>
                    </label>
                    <label className="flex items-start gap-2 cursor-pointer">
                      <input {...register("eventTakerVisible")} type="checkbox" className="w-4 h-4 mt-0.5 accent-primary" />
                      <span className="text-sm">
                        <span className="font-medium">Staff Order Taker</span>
                        <span className="text-muted-foreground"> — show on the staff <code>/event-taker</code> POS page</span>
                      </span>
                    </label>
                  </div>
                </div>

                <div className="space-y-3 p-4 bg-slate-50 dark:bg-slate-900/40 rounded-xl border border-slate-200 dark:border-slate-700/60">
                  <label className="block text-sm font-semibold text-slate-900 dark:text-slate-100">Item Label Printing</label>
                  <p className="text-xs text-slate-700/80 dark:text-slate-300/80 -mt-2">
                    Controls how many physical labels print per quantity ordered. Plates from the staff order-taker always
                    get one plate-label regardless of this setting.
                  </p>

                  <div className="space-y-2">
                    <label className="block text-xs font-medium">Label policy</label>
                    {([
                      {
                        value: "per_unit",
                        label: "Per unit",
                        desc: "1 label for every unit ordered. Use this for individually packaged products — e.g. a \"3 Wing Box\" is one unit, so qty 4 prints 4 labels.",
                      },
                      {
                        value: "combined",
                        label: "Combined",
                        desc: "1 label showing the total quantity, no matter how many are ordered. Use this for bulk items delivered together in one container.",
                      },
                      {
                        value: "per_box",
                        label: "Per box",
                        desc: "1 label per pack of N units. Use this for loose items grouped into packs — e.g. 50 loose wings split into 6-packs prints ⌈50 ÷ 6⌉ = 9 labels.",
                      },
                    ] as const).map(({ value, label, desc }) => (
                      <label
                        key={value}
                        className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                          watch("labelPolicy") === value
                            ? "border-primary bg-primary/5 dark:bg-primary/10"
                            : "border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800/50"
                        }`}
                      >
                        <input
                          type="radio"
                          value={value}
                          {...register("labelPolicy")}
                          className="mt-0.5 accent-primary shrink-0"
                        />
                        <div>
                          <span className="text-sm font-medium">{label}</span>
                          <span className="text-xs text-muted-foreground block mt-0.5">{desc}</span>
                        </div>
                      </label>
                    ))}
                  </div>

                  {watch("labelPolicy") === "per_box" && (
                    <div className="space-y-1.5">
                      <div className="w-full sm:w-52">
                        <label className="block text-xs font-medium mb-1">Box size (units per pack)</label>
                        <input
                          {...register("labelBoxSize")}
                          type="number"
                          min="2"
                          step="1"
                          placeholder="e.g. 6"
                          className="w-full px-3 py-2 border rounded-xl text-sm"
                        />
                      </div>
                      <p className="text-xs text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800/50 rounded-lg px-3 py-2">
                        <strong>Tip:</strong> Use <em>Per box</em> only for loose items packed into containers. For pre-packaged single-unit products like a "3 Wing Box", choose <strong>Per unit</strong> instead — that item is already one package.
                      </p>
                    </div>
                  )}

                  <LabelCountPreview
                    policy={watch("labelPolicy")}
                    boxSize={watch("labelBoxSize")}
                  />
                </div>

                <div className="space-y-3 p-4 bg-violet-50 dark:bg-violet-950/30 rounded-xl border border-violet-200 dark:border-violet-800/50">
                  <label className="block text-sm font-semibold text-violet-900 dark:text-violet-200">Combo Item</label>
                  <label className="flex items-start gap-2 cursor-pointer">
                    <input {...register("isCombo")} type="checkbox" className="w-4 h-4 mt-0.5 accent-violet-600" />
                    <span className="text-sm">
                      <span className="font-medium text-violet-900 dark:text-violet-200">This item is a combo</span>
                      <span className="text-violet-800/80 dark:text-violet-300/80 block text-xs mt-0.5">
                        Staff Order Taker will open a slot-selection modal before adding this item to an order.
                      </span>
                    </span>
                  </label>
                  {watch("isCombo") && (
                    <div className="space-y-3">
                      {comboSlots.map((slot, si) => (
                        <div key={slot.slotId} className="p-3 bg-white dark:bg-violet-950/50 rounded-xl border border-violet-200 dark:border-violet-700/60 space-y-3">
                          <div className="flex items-center gap-2">
                            <input
                              value={slot.slotName}
                              onChange={e => setComboSlots(prev => prev.map((s, i) => i === si ? { ...s, slotName: e.target.value } : s))}
                              placeholder="Slot name (e.g. Sides, Protein)"
                              className="flex-1 px-3 py-1.5 border rounded-lg text-sm"
                            />
                            <button
                              type="button"
                              disabled={si === 0}
                              onClick={() => setComboSlots(prev => {
                                const next = [...prev];
                                [next[si - 1], next[si]] = [next[si], next[si - 1]];
                                return next;
                              })}
                              className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-secondary rounded-lg transition-colors disabled:opacity-30"
                              title="Move slot up"
                            >
                              <ChevronUp className="w-4 h-4" />
                            </button>
                            <button
                              type="button"
                              disabled={si === comboSlots.length - 1}
                              onClick={() => setComboSlots(prev => {
                                const next = [...prev];
                                [next[si], next[si + 1]] = [next[si + 1], next[si]];
                                return next;
                              })}
                              className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-secondary rounded-lg transition-colors disabled:opacity-30"
                              title="Move slot down"
                            >
                              <ChevronDown className="w-4 h-4" />
                            </button>
                            <button
                              type="button"
                              onClick={() => setComboSlots(prev => prev.filter((_, i) => i !== si))}
                              className="p-1.5 text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded-lg transition-colors"
                              title="Remove slot"
                            >
                              <X className="w-4 h-4" />
                            </button>
                          </div>
                          <div className="flex items-center gap-4 text-sm">
                            <label className="flex items-center gap-1.5">
                              <span className="text-xs text-muted-foreground">Min qty</span>
                              <input
                                type="number" min="0" value={slot.minQty}
                                onChange={e => setComboSlots(prev => prev.map((s, i) => i === si ? { ...s, minQty: Math.max(0, parseInt(e.target.value, 10) || 0) } : s))}
                                className="w-16 px-2 py-1 border rounded-lg text-xs text-center"
                              />
                            </label>
                            <label className="flex items-center gap-1.5">
                              <span className="text-xs text-muted-foreground">Max qty</span>
                              <input
                                type="number" min="1" value={slot.maxQty}
                                onChange={e => setComboSlots(prev => prev.map((s, i) => i === si ? { ...s, maxQty: Math.max(1, parseInt(e.target.value, 10) || 1) } : s))}
                                className="w-16 px-2 py-1 border rounded-lg text-xs text-center"
                              />
                            </label>
                          </div>
                          <div className="space-y-2">
                            <p className="text-xs font-medium text-muted-foreground">Options (pick from menu items)</p>
                            {slot.options.map((opt, oi) => (
                              <div key={oi} className="flex items-center gap-2">
                                <select
                                  value={opt.menuItemId || ""}
                                  onChange={e => {
                                    const id = parseInt(e.target.value, 10);
                                    const name = (items as any[])?.find((it: any) => it.id === id)?.name ?? "";
                                    setComboSlots(prev => prev.map((s, i) => i === si ? {
                                      ...s, options: s.options.map((o, j) => j === oi ? { menuItemId: id, name } : o)
                                    } : s));
                                  }}
                                  className="flex-1 px-2 py-1.5 border rounded-lg text-sm bg-background"
                                >
                                  <option value="">Select item…</option>
                                  {(items as any[])?.map((it: any) => (
                                    <option key={it.id} value={it.id}>{it.name}</option>
                                  ))}
                                </select>
                                <button
                                  type="button"
                                  onClick={() => setComboSlots(prev => prev.map((s, i) => i === si ? { ...s, options: s.options.filter((_, j) => j !== oi) } : s))}
                                  className="p-1 text-muted-foreground hover:text-destructive rounded"
                                >
                                  <X className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            ))}
                            <button
                              type="button"
                              onClick={() => setComboSlots(prev => prev.map((s, i) => i === si ? { ...s, options: [...s.options, { menuItemId: 0, name: "" }] } : s))}
                              className="text-xs text-violet-600 dark:text-violet-400 hover:text-violet-700 font-medium flex items-center gap-1"
                            >
                              <Plus className="w-3 h-3" /> Add option
                            </button>
                          </div>
                        </div>
                      ))}
                      <button
                        type="button"
                        onClick={() => setComboSlots(prev => [...prev, { slotId: crypto.randomUUID(), slotName: "", minQty: 1, maxQty: 1, options: [] }])}
                        className="w-full py-2 border-2 border-dashed border-violet-300 dark:border-violet-700 text-violet-600 dark:text-violet-400 text-sm font-medium rounded-xl hover:bg-violet-50 dark:hover:bg-violet-950/20 transition-colors flex items-center justify-center gap-1"
                      >
                        <Plus className="w-4 h-4" /> Add Slot
                      </button>
                      <label className="flex items-start gap-2 cursor-pointer">
                        <input {...register("comboComponentLabels")} type="checkbox" className="w-4 h-4 mt-0.5 accent-violet-600" />
                        <span className="text-sm">
                          <span className="font-medium text-violet-900 dark:text-violet-200">Print individual component labels</span>
                          <span className="text-violet-800/80 dark:text-violet-300/80 block text-xs mt-0.5">
                            Also print a separate item label for each selected component in addition to the combo label.
                          </span>
                        </span>
                      </label>
                    </div>
                  )}
                </div>

                <div className="space-y-3 p-4 bg-orange-50 dark:bg-orange-950/30 rounded-xl border border-orange-200 dark:border-orange-800/50">
                  <label className="block text-sm font-semibold text-orange-900 dark:text-orange-200">On the Dash Experience</label>
                  <label className="flex items-start gap-2 cursor-pointer">
                    <input {...register("otdEligible")} type="checkbox" className="w-4 h-4 mt-0.5 accent-orange-600" />
                    <span className="text-sm">
                      <span className="font-medium text-orange-900 dark:text-orange-200">Cookable on-site from the food trailer</span>
                      <span className="text-orange-800/80 dark:text-orange-300/80 block text-xs mt-0.5">
                        When checked, this item shows the orange "On the Dash" badge on the menu and customers can order it as part of an On the Dash Experience.
                      </span>
                    </span>
                  </label>
                </div>

                <div>
                  <label className="block text-sm font-semibold mb-1">
                    Event Order Taker Price <span className="font-normal text-muted-foreground text-xs">(required for staff POS — items without this are hidden from the order taker)</span>
                  </label>
                  <div className="relative">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm pointer-events-none">$</span>
                    <input
                      {...register("eventTakerPrice")}
                      type="number"
                      step="0.01"
                      min="0"
                      placeholder="Leave blank to hide from POS"
                      className="w-full pl-7 pr-4 py-2 border rounded-xl"
                    />
                  </div>
                  {watch("eventTakerVisible") && !String(watch("eventTakerPrice") ?? "").trim() && (
                    <div className="mt-2 flex items-start gap-2 px-3 py-2 bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800/50 rounded-lg text-xs text-amber-800 dark:text-amber-300">
                      <span className="font-bold leading-none mt-0.5">⚠</span>
                      <span>
                        <strong>Staff Order Taker is enabled but no price is set.</strong> This item will not appear on the POS until you set an Event Order Taker Price above.
                      </span>
                    </div>
                  )}
                </div>
              </form>
            </div>

            <div className="px-6 py-4 border-t border-border bg-secondary/30 flex justify-end gap-3">
              <button onClick={() => setIsDialogOpen(false)} className="px-5 py-2 font-semibold text-muted-foreground hover:text-foreground">
                Cancel
              </button>
              <button
                form="menu-form"
                type="submit"
                disabled={createMut.isPending || updateMut.isPending}
                className="px-6 py-2 bg-primary text-primary-foreground font-semibold rounded-xl disabled:opacity-50"
              >
                {editingItem ? "Save Changes" : "Create Item"}
              </button>
            </div>
          </div>
        </div>
      )}

      {isPickerOpen && (
        <ImagePickerModal
          onSelect={handlePickImage}
          onClose={() => setIsPickerOpen(false)}
        />
      )}
    </AdminLayout>
  );
}
