import { Link } from "wouter";
import { AdminLayout } from "@/components/AdminLayout";
import { Briefcase, CalendarRange, BarChart3, Menu as MenuIcon, ShoppingCart, Zap } from "lucide-react";

// Placeholder landing page. The old stat cards read from the retired
// cart/orders table; this page will become the unified sales hub.
const LINKS = [
  { href: "/admin/catering", label: "Catering Inquiries", icon: Briefcase },
  { href: "/admin/catering/upcoming", label: "Upcoming Caterings", icon: CalendarRange },
  { href: "/admin/sales-reports", label: "Sales Reports", icon: BarChart3 },
  { href: "/admin/menu", label: "Menu Manager", icon: MenuIcon },
  { href: "/admin/event-settings", label: "Event Settings", icon: Zap },
];

export default function AdminDashboard() {
  return (
    <AdminLayout>
      <div className="mb-10">
        <h1 className="font-display font-bold text-2xl sm:text-4xl mb-2">Overview</h1>
        <p className="text-muted-foreground">Welcome back. Jump to what you need.</p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {LINKS.map(({ href, label, icon: Icon }) => (
          <Link
            key={href}
            href={href}
            className="flex items-center gap-4 bg-card p-5 rounded-2xl border border-border shadow-sm hover:border-primary/40 transition-colors"
          >
            <div className="w-11 h-11 rounded-xl bg-primary/10 flex items-center justify-center text-primary">
              <Icon className="w-5 h-5" />
            </div>
            <span className="font-semibold">{label}</span>
          </Link>
        ))}
        <a
          href="/event-taker"
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-4 bg-card p-5 rounded-2xl border border-border shadow-sm hover:border-primary/40 transition-colors"
        >
          <div className="w-11 h-11 rounded-xl bg-primary/10 flex items-center justify-center text-primary">
            <ShoppingCart className="w-5 h-5" />
          </div>
          <span className="font-semibold">Order Taker (POS)</span>
        </a>
      </div>
    </AdminLayout>
  );
}
