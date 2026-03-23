import { Link, useRoute, useLocation } from "wouter";
import { LayoutDashboard, Menu as MenuIcon, ShoppingCart, CalendarDays, ArrowLeft, LogOut, Images } from "lucide-react";
import { cn } from "@/lib/utils";
import { clearAdminToken } from "@/components/AdminGuard";

const LOGO_URL = `${import.meta.env.BASE_URL}images/dash-logo.png`;

function AdminNavLink({ href, icon: Icon, children }: { href: string; icon: any; children: React.ReactNode }) {
  const [isActive] = useRoute(href);
  return (
    <Link
      href={href}
      className={cn(
        "flex items-center gap-3 px-4 py-3 rounded-xl font-medium transition-all duration-200",
        isActive
          ? "bg-primary text-primary-foreground shadow-md shadow-primary/20"
          : "text-foreground/70 hover:bg-secondary hover:text-foreground"
      )}
    >
      <Icon className="w-5 h-5" />
      {children}
    </Link>
  );
}

export function AdminLayout({ children }: { children: React.ReactNode }) {
  const [, navigate] = useLocation();

  const handleLogout = () => {
    clearAdminToken();
    navigate("/admin/login");
  };

  return (
    <div className="min-h-screen bg-secondary/30 flex">
      {/* Sidebar */}
      <aside className="w-72 bg-card border-r border-border flex flex-col shadow-sm hidden md:flex">
        <div className="p-6 border-b border-border">
          <Link
            href="/"
            className="flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors mb-6 text-sm font-medium"
          >
            <ArrowLeft className="w-4 h-4" /> Back to Website
          </Link>
          <div className="flex items-center gap-3">
            <img
              src={LOGO_URL}
              alt="dash by Hollywood East Cafe"
              className="h-12 w-12 rounded-lg object-cover flex-shrink-0"
            />
            <div>
              <h2 className="font-bold text-base leading-tight">Admin Portal</h2>
              <p className="text-[10px] uppercase tracking-widest text-muted-foreground mt-0.5">
                dash by HEC
              </p>
            </div>
          </div>
        </div>
        <nav className="flex-1 p-4 space-y-2">
          <AdminNavLink href="/admin" icon={LayoutDashboard}>Dashboard</AdminNavLink>
          <AdminNavLink href="/admin/menu" icon={MenuIcon}>Menu Manager</AdminNavLink>
          <AdminNavLink href="/admin/orders" icon={ShoppingCart}>Orders</AdminNavLink>
          <AdminNavLink href="/admin/calendar" icon={CalendarDays}>Availability</AdminNavLink>
          <AdminNavLink href="/admin/images" icon={Images}>Image Library</AdminNavLink>
        </nav>
        <div className="p-4 border-t border-border">
          <button
            onClick={handleLogout}
            className="flex items-center gap-3 w-full px-4 py-3 rounded-xl font-medium text-foreground/70 hover:bg-red-50 hover:text-red-600 transition-all duration-200"
          >
            <LogOut className="w-5 h-5" />
            Sign Out
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 overflow-auto">
        <div className="p-8 max-w-6xl mx-auto">
          {children}
        </div>
      </main>
    </div>
  );
}
