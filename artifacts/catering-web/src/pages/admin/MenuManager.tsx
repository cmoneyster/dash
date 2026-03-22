import { useState } from "react";
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
import { Plus, Edit2, Trash2, X } from "lucide-react";
import { useForm } from "react-hook-form";

export default function MenuManager() {
  const queryClient = useQueryClient();
  const { data: items, isLoading } = useAdminListMenuItems();
  
  const [editingItem, setEditingItem] = useState<any>(null);
  const [isDialogOpen, setIsDialogOpen] = useState(false);

  const createMut = useCreateMenuItem({ onSuccess: () => {
    queryClient.invalidateQueries({ queryKey: getAdminListMenuItemsQueryKey() });
    setIsDialogOpen(false);
  }});
  
  const updateMut = useUpdateMenuItem({ onSuccess: () => {
    queryClient.invalidateQueries({ queryKey: getAdminListMenuItemsQueryKey() });
    setIsDialogOpen(false);
  }});

  const deleteMut = useDeleteMenuItem({ onSuccess: () => {
    queryClient.invalidateQueries({ queryKey: getAdminListMenuItemsQueryKey() });
  }});

  const { register, handleSubmit, reset } = useForm();

  const openNew = () => {
    setEditingItem(null);
    reset({ available: true, servingSize: 1, unit: "tray", price: 0 });
    setIsDialogOpen(true);
  };

  const openEdit = (item: any) => {
    setEditingItem(item);
    reset({
      ...item,
      allergens: item.allergens.join(", ")
    });
    setIsDialogOpen(true);
  };

  const onSubmit = (data: any) => {
    const payload = {
      ...data,
      price: parseFloat(data.price),
      servingSize: parseInt(data.servingSize, 10),
      allergens: data.allergens ? data.allergens.split(",").map((s: string) => s.trim()).filter(Boolean) : []
    };

    if (editingItem) {
      updateMut.mutate({ id: editingItem.id, data: payload });
    } else {
      createMut.mutate({ data: payload });
    }
  };

  return (
    <AdminLayout>
      <div className="flex justify-between items-end mb-8">
        <div>
          <h1 className="font-display font-bold text-4xl mb-2">Menu Manager</h1>
          <p className="text-muted-foreground">Add, edit, or remove items from your catering menu.</p>
        </div>
        <button onClick={openNew} className="px-5 py-2.5 bg-primary text-primary-foreground font-semibold rounded-xl hover:bg-primary/90 transition-colors flex items-center gap-2">
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
              {items?.map((item) => (
                <tr key={item.id} className="hover:bg-secondary/20 transition-colors">
                  <td className="px-6 py-4">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-lg bg-secondary overflow-hidden shrink-0">
                        {item.imageUrl && <img src={item.imageUrl} alt="" className="w-full h-full object-cover" />}
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
                    <span className={`text-xs font-bold uppercase px-2 py-1 rounded-full ${item.available ? 'bg-emerald-100 text-emerald-700' : 'bg-destructive/10 text-destructive'}`}>
                      {item.available ? 'Active' : 'Hidden'}
                    </span>
                  </td>
                  <td className="px-6 py-4 text-right">
                    <button onClick={() => openEdit(item)} className="p-2 text-muted-foreground hover:text-primary transition-colors inline-block">
                      <Edit2 className="w-4 h-4" />
                    </button>
                    <button 
                      onClick={() => { if(confirm('Delete item?')) deleteMut.mutate({id: item.id}) }}
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
              <h2 className="font-display font-bold text-2xl">{editingItem ? 'Edit Menu Item' : 'New Menu Item'}</h2>
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
                    <input {...register("category")} required placeholder="Appetizers" className="w-full px-4 py-2 border rounded-xl" />
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
                  <label className="block text-sm font-semibold mb-1">Image URL</label>
                  <input {...register("imageUrl")} placeholder="https://..." className="w-full px-4 py-2 border rounded-xl" />
                </div>

                <div>
                  <label className="block text-sm font-semibold mb-1">Allergens (comma separated)</label>
                  <input {...register("allergens")} placeholder="Nuts, Dairy" className="w-full px-4 py-2 border rounded-xl" />
                </div>

                <div className="flex items-center gap-2">
                  <input {...register("available")} type="checkbox" id="available" className="w-4 h-4 accent-primary" />
                  <label htmlFor="available" className="text-sm font-semibold">Available for order</label>
                </div>
              </form>
            </div>
            
            <div className="px-6 py-4 border-t border-border bg-secondary/30 flex justify-end gap-3">
              <button onClick={() => setIsDialogOpen(false)} className="px-5 py-2 font-semibold text-muted-foreground hover:text-foreground">Cancel</button>
              <button form="menu-form" type="submit" disabled={createMut.isPending || updateMut.isPending} className="px-6 py-2 bg-primary text-primary-foreground font-semibold rounded-xl">
                {editingItem ? 'Save Changes' : 'Create Item'}
              </button>
            </div>
          </div>
        </div>
      )}
    </AdminLayout>
  );
}
