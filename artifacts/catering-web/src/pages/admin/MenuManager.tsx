import { useState, useCallback } from "react";
import { AdminLayout } from "@/components/AdminLayout";
import {
  useAdminListMenuItems,
  useCreateMenuItem,
  useUpdateMenuItem,
  useDeleteMenuItem,
  getAdminListMenuItemsQueryKey
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { formatCurrency } from "@/lib/utils";
import { Plus, Edit2, Trash2, X, ImageIcon, Loader2, Check, Library } from "lucide-react";
import { useForm } from "react-hook-form";
import { getAdminToken } from "@/components/AdminGuard";

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

export default function MenuManager() {
  const queryClient = useQueryClient();
  const { data: items, isLoading } = useAdminListMenuItems();

  const [editingItem, setEditingItem] = useState<any>(null);
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [isPickerOpen, setIsPickerOpen] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string>("");
  const [isNewCategory, setIsNewCategory] = useState(false);

  const existingCategories = Array.from(
    new Set((items ?? []).map((item: any) => item.category as string))
  ).sort();

  const createMut = useCreateMenuItem({
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: getAdminListMenuItemsQueryKey() });
      setIsDialogOpen(false);
    },
  });

  const updateMut = useUpdateMenuItem({
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: getAdminListMenuItemsQueryKey() });
      setIsDialogOpen(false);
    },
  });

  const deleteMut = useDeleteMenuItem({
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: getAdminListMenuItemsQueryKey() });
    },
  });

  const { register, handleSubmit, reset, setValue, watch } = useForm();
  const imageUrlValue = watch("imageUrl", "");

  const openNew = () => {
    setEditingItem(null);
    reset({ available: true, servingSize: 1, unit: "tray", price: 0, imageUrl: "" });
    setPreviewUrl("");
    setIsNewCategory(false);
    setIsDialogOpen(true);
  };

  const openEdit = (item: any) => {
    setEditingItem(item);
    reset({ ...item, allergens: item.allergens.join(", ") });
    setPreviewUrl(item.imageUrl ?? "");
    setIsNewCategory(false);
    setIsDialogOpen(true);
  };

  const onSubmit = (data: any) => {
    const payload = {
      ...data,
      price: parseFloat(data.price),
      servingSize: parseInt(data.servingSize, 10),
      allergens: data.allergens
        ? data.allergens.split(",").map((s: string) => s.trim()).filter(Boolean)
        : [],
      minimumOrderQty: data.minimumOrderQty ? parseInt(data.minimumOrderQty, 10) : 1,
      tier2Qty: data.tier2Qty ? parseInt(data.tier2Qty, 10) : null,
      tier2Price: data.tier2Price ? parseFloat(data.tier2Price) : null,
      tier3Qty: data.tier3Qty ? parseInt(data.tier3Qty, 10) : null,
      tier3Price: data.tier3Price ? parseFloat(data.tier3Price) : null,
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
          <h1 className="font-display font-bold text-4xl mb-2">Menu Manager</h1>
          <p className="text-muted-foreground">Add, edit, or remove items from your catering menu.</p>
        </div>
        <button
          onClick={openNew}
          className="px-5 py-2.5 bg-primary text-primary-foreground font-semibold rounded-xl hover:bg-primary/90 transition-colors flex items-center gap-2"
        >
          <Plus className="w-5 h-5" /> Add Item
        </button>
      </div>

      <div className="bg-card border border-border rounded-2xl shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-secondary/50 text-sm uppercase tracking-wider text-muted-foreground">
                <th className="px-6 py-4 font-semibold">Item</th>
                <th className="px-6 py-4 font-semibold">Category</th>
                <th className="px-6 py-4 font-semibold">Price</th>
                <th className="px-6 py-4 font-semibold">Status</th>
                <th className="px-6 py-4 font-semibold text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {isLoading && (
                <tr><td colSpan={5} className="px-6 py-12 text-center text-muted-foreground">
                  <Loader2 className="w-6 h-6 animate-spin mx-auto" />
                </td></tr>
              )}
              {items?.map((item) => (
                <tr key={item.id} className="hover:bg-secondary/20 transition-colors">
                  <td className="px-6 py-4">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-lg bg-secondary overflow-hidden shrink-0">
                        {item.imageUrl
                          ? <img src={item.imageUrl} alt="" className="w-full h-full object-cover" />
                          : <ImageIcon className="w-5 h-5 m-auto text-muted-foreground mt-2.5" />}
                      </div>
                      <div>
                        <p className="font-bold">{item.name}</p>
                        <p className="text-xs text-muted-foreground truncate w-48">{item.description}</p>
                      </div>
                    </div>
                  </td>
                  <td className="px-6 py-4 text-sm">{item.category}</td>
                  <td className="px-6 py-4 font-semibold">{formatCurrency(item.price)}</td>
                  <td className="px-6 py-4">
                    <span className={`text-xs font-bold uppercase px-2 py-1 rounded-full ${item.available ? "bg-emerald-100 text-emerald-700" : "bg-destructive/10 text-destructive"}`}>
                      {item.available ? "Active" : "Hidden"}
                    </span>
                  </td>
                  <td className="px-6 py-4 text-right">
                    <button onClick={() => openEdit(item)} className="p-2 text-muted-foreground hover:text-primary transition-colors inline-block">
                      <Edit2 className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => { if (confirm("Delete item?")) deleteMut.mutate({ id: item.id }); }}
                      className="p-2 text-muted-foreground hover:text-destructive transition-colors inline-block"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

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
                  <label className="block text-sm font-semibold mb-1">Description</label>
                  <textarea {...register("description")} required rows={2} className="w-full px-4 py-2 border rounded-xl resize-none" />
                </div>

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
                  <input {...register("minimumOrderQty")} type="number" min="1" defaultValue={1} className="w-full px-4 py-2 border rounded-xl" />
                </div>

                <div className="space-y-2">
                  <label className="block text-sm font-semibold">Volume Pricing Tiers <span className="font-normal text-muted-foreground text-xs">(optional)</span></label>
                  <div className="grid grid-cols-2 gap-3 p-4 bg-secondary/50 rounded-xl">
                    <div>
                      <label className="block text-xs font-medium text-muted-foreground mb-1">Tier 2 — Min. Qty</label>
                      <input {...register("tier2Qty")} type="number" min="1" placeholder="e.g. 5" className="w-full px-3 py-2 border rounded-lg text-sm bg-white" />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-muted-foreground mb-1">Tier 2 — Price / ea</label>
                      <input {...register("tier2Price")} type="number" step="0.01" min="0" placeholder="e.g. 9.50" className="w-full px-3 py-2 border rounded-lg text-sm bg-white" />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-muted-foreground mb-1">Tier 3 — Min. Qty</label>
                      <input {...register("tier3Qty")} type="number" min="1" placeholder="e.g. 10" className="w-full px-3 py-2 border rounded-lg text-sm bg-white" />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-muted-foreground mb-1">Tier 3 — Price / ea</label>
                      <input {...register("tier3Price")} type="number" step="0.01" min="0" placeholder="e.g. 8.50" className="w-full px-3 py-2 border rounded-lg text-sm bg-white" />
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <input {...register("available")} type="checkbox" id="available" className="w-4 h-4 accent-primary" />
                  <label htmlFor="available" className="text-sm font-semibold">Available for order</label>
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
