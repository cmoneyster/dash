import { AdminLayout } from "@/components/AdminLayout";
import { 
  useAdminListOrders, 
  useUpdateOrderStatus,
  getAdminListOrdersQueryKey
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { formatCurrency } from "@/lib/utils";

export default function OrderManager() {
  const queryClient = useQueryClient();
  const { data: orders, isLoading } = useAdminListOrders();
  
  const updateStatus = useUpdateOrderStatus({
    mutation: {
      onSuccess: () => queryClient.invalidateQueries({ queryKey: getAdminListOrdersQueryKey() })
    }
  });

  const handleStatusChange = (id: number, status: any) => {
    updateStatus.mutate({ id, data: { status } });
  };

  const statuses = ["pending", "confirmed", "preparing", "delivered", "cancelled"];

  return (
    <AdminLayout>
      <div className="mb-8">
        <h1 className="font-display font-bold text-4xl mb-2">Orders</h1>
        <p className="text-muted-foreground">Manage incoming event orders and update their status.</p>
      </div>

      <div className="space-y-6">
        {orders?.map(order => (
          <div key={order.id} className="bg-card border border-border rounded-2xl shadow-sm p-6 flex flex-col md:flex-row gap-6">
            <div className="flex-1">
              <div className="flex justify-between items-start mb-4">
                <div>
                  <h3 className="font-bold text-xl">{order.customerName}</h3>
                  <p className="text-sm text-muted-foreground">{order.customerEmail} • {order.customerPhone}</p>
                </div>
                <div className="text-right">
                  <div className="font-display font-bold text-2xl text-primary">{formatCurrency(order.total)}</div>
                  <p className="text-xs text-muted-foreground">{new Date(order.createdAt).toLocaleString()}</p>
                </div>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-6 bg-secondary/50 p-4 rounded-xl text-sm">
                <div>
                  <span className="block text-muted-foreground text-xs uppercase mb-1">Event Date</span>
                  <span className="font-semibold">{order.eventDate || 'TBD'}</span>
                </div>
                <div>
                  <span className="block text-muted-foreground text-xs uppercase mb-1">Guests</span>
                  <span className="font-semibold">{order.guestCount || 'TBD'}</span>
                </div>
                <div>
                  <span className="block text-muted-foreground text-xs uppercase mb-1">Style</span>
                  <span className="font-semibold">{order.serviceStyle || 'N/A'}</span>
                </div>
                <div>
                  <span className="block text-muted-foreground text-xs uppercase mb-1">Items</span>
                  <span className="font-semibold">{order.items.length} items</span>
                </div>
              </div>

              {order.deliveryNotes && (
                <div className="mb-4 text-sm border-l-2 border-primary pl-3 py-1 text-muted-foreground">
                  <span className="font-semibold text-foreground">Notes:</span> {order.deliveryNotes}
                </div>
              )}

              <div className="space-y-2">
                {order.items.map(item => (
                  <div key={item.id} className="flex justify-between text-sm">
                    <span>{item.quantity}x {item.menuItemName}</span>
                    <span className="text-muted-foreground">{formatCurrency(item.price * item.quantity)}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="md:w-48 md:border-l md:border-border md:pl-6 flex flex-col justify-center gap-2">
              <label className="text-xs font-bold uppercase text-muted-foreground">Status</label>
              <select 
                value={order.status}
                onChange={(e) => handleStatusChange(order.id, e.target.value)}
                className={`w-full p-2.5 rounded-lg border font-semibold text-sm outline-none cursor-pointer
                  ${order.status === 'pending' ? 'bg-amber-50 border-amber-200 text-amber-700' :
                    order.status === 'confirmed' ? 'bg-blue-50 border-blue-200 text-blue-700' :
                    order.status === 'preparing' ? 'bg-purple-50 border-purple-200 text-purple-700' :
                    order.status === 'delivered' ? 'bg-emerald-50 border-emerald-200 text-emerald-700' :
                    'bg-slate-50 border-slate-200 text-slate-700'
                  }
                `}
              >
                {statuses.map(s => (
                  <option key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</option>
                ))}
              </select>
            </div>
          </div>
        ))}

        {!orders?.length && !isLoading && (
          <div className="text-center py-24 text-muted-foreground">
            No orders found.
          </div>
        )}
      </div>
    </AdminLayout>
  );
}
