import { AdminLayout } from "@/components/AdminLayout";
import { useGetAdminStats, useAdminListOrders } from "@workspace/api-client-react";
import { formatCurrency } from "@/lib/utils";
import { Package, Clock, DollarSign, Utensils } from "lucide-react";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';

function StatCard({ title, value, icon: Icon, trend }: any) {
  return (
    <div className="bg-card p-6 rounded-2xl border border-border shadow-sm">
      <div className="flex justify-between items-start mb-4">
        <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center text-primary">
          <Icon className="w-6 h-6" />
        </div>
        {trend && <span className="text-xs font-bold text-emerald-600 bg-emerald-50 px-2 py-1 rounded-md">{trend}</span>}
      </div>
      <h3 className="text-muted-foreground font-medium text-sm mb-1">{title}</h3>
      <p className="font-display font-bold text-3xl text-foreground">{value}</p>
    </div>
  );
}

export default function AdminDashboard() {
  const { data: stats } = useGetAdminStats();
  const { data: orders } = useAdminListOrders();

  // Mock data for chart
  const chartData = [
    { name: 'Mon', revenue: 4000 },
    { name: 'Tue', revenue: 3000 },
    { name: 'Wed', revenue: 2000 },
    { name: 'Thu', revenue: 2780 },
    { name: 'Fri', revenue: 1890 },
    { name: 'Sat', revenue: 2390 },
    { name: 'Sun', revenue: 3490 },
  ];

  return (
    <AdminLayout>
      <div className="mb-10">
        <h1 className="font-display font-bold text-4xl mb-2">Overview</h1>
        <p className="text-muted-foreground">Welcome back. Here's what's happening today.</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-10">
        <StatCard title="Total Revenue" value={formatCurrency(stats?.totalRevenue || 0)} icon={DollarSign} trend="+12%" />
        <StatCard title="Pending Orders" value={stats?.pendingOrders || 0} icon={Clock} trend="Action needed" />
        <StatCard title="Total Orders" value={stats?.totalOrders || 0} icon={Package} />
        <StatCard title="Active Menu Items" value={stats?.totalMenuItems || 0} icon={Utensils} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 bg-card p-6 rounded-2xl border border-border shadow-sm">
          <h3 className="font-bold text-lg mb-6">Revenue Overview</h3>
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e5e7eb" />
                <XAxis dataKey="name" axisLine={false} tickLine={false} tick={{fill: '#6b7280', fontSize: 12}} dy={10} />
                <YAxis axisLine={false} tickLine={false} tick={{fill: '#6b7280', fontSize: 12}} tickFormatter={(v) => `$${v}`} dx={-10} />
                <Tooltip cursor={{fill: '#f3f4f6'}} contentStyle={{borderRadius: '8px', border: 'none', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)'}} />
                <Bar dataKey="revenue" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} maxBarSize={40} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="bg-card p-6 rounded-2xl border border-border shadow-sm">
          <h3 className="font-bold text-lg mb-6">Recent Orders</h3>
          <div className="space-y-4">
            {orders?.slice(0, 5).map(order => (
              <div key={order.id} className="flex justify-between items-center pb-4 border-b border-border last:border-0">
                <div>
                  <p className="font-semibold text-sm">{order.customerName}</p>
                  <p className="text-xs text-muted-foreground">{new Date(order.createdAt).toLocaleDateString()}</p>
                </div>
                <div className="text-right">
                  <p className="font-bold text-sm">{formatCurrency(order.total)}</p>
                  <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full ${
                    order.status === 'pending' ? 'bg-amber-100 text-amber-700' :
                    order.status === 'confirmed' ? 'bg-blue-100 text-blue-700' :
                    order.status === 'delivered' ? 'bg-emerald-100 text-emerald-700' :
                    'bg-secondary text-secondary-foreground'
                  }`}>
                    {order.status}
                  </span>
                </div>
              </div>
            ))}
            {!orders?.length && <p className="text-sm text-muted-foreground">No recent orders.</p>}
          </div>
        </div>
      </div>
    </AdminLayout>
  );
}
