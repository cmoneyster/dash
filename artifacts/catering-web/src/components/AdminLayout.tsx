import { useState, useEffect } from "react";
import { Link, useRoute, useLocation } from "wouter";
import { LayoutDashboard, Menu as MenuIcon, CalendarDays, ArrowLeft, LogOut, Images, Zap, History, Briefcase, ClipboardList, CalendarRange, X, AlignJustify, ShoppingCart, BarChart3, Tags, Instagram, MessageSquare, Inbox, Activity } from "lucide-react";
import { cn } from "@/lib/utils";
import { clearAdminToken, getAdminToken } from "@/components/AdminGuard";

const LOGO_URL = `${import.meta.env.BASE_URL}images/dash-logo.png`;

function AdminNavLink({ href, icon: Icon, children, onClick, badge }: { href: string; icon: any; children: React.ReactNode; onClick?: () => void; badge?: number }) {
  const [isActive] = useRoute(href);
  return (
    <Link
      href={href}
      onClick={onClick}
      className={cn(
        "flex items-center gap-3 px-4 py-3 rounded-xl font-medium transition-all duration-200",
        isActive
          ? "bg-primary text-primary-foreground shadow-md shadow-primary/20"
          : "text-foreground/70 hover:bg-secondary hover:text-foreground"
      )}
    >
      <Icon className="w-5 h-5" />
      <span className="flex-1">{children}</span>
      {badge != null && badge > 0 && (
        <span className={cn(
          "px-2 py-0.5 rounded-full text-[11px] font-bold",
          isActive ? "bg-white/20 text-white" : "bg-primary text-primary-foreground"
        )}>
          {badge > 99 ? "99+" : badge}
        </span>
      )}
    </Link>
  );
}

function useInstagramBadge(): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    let cancelled = false;
    async function load() {
      const token = getAdminToken();
      if (!token) return;
      try {
        const r = await fetch("/api/admin/instagram/badge", {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!r.ok) return;
        const data = (await r.json()) as { newSinceLastVisit?: number; totalPending?: number };
        if (!cancelled) setCount(data.newSinceLastVisit ?? 0);
      } catch {
        // silent — sidebar shouldn't break if poller endpoint hiccups
      }
    }
    load();
    const int = setInterval(load, 60_000);
    return () => { cancelled = true; clearInterval(int); };
  }, []);
  return count;
}

function useUnmatchedSmsBadge(): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    let cancelled = false;
    let es: EventSource | null = null;
    let pollInt: ReturnType<typeof setInterval> | null = null;

    async function load() {
      const token = getAdminToken();
      if (!token) return;
      try {
        const r = await fetch("/api/admin/messages/badges", {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!r.ok) return;
        const data = (await r.json()) as { unmatchedCount?: number };
        if (!cancelled) setCount(data.unmatchedCount ?? 0);
      } catch {
        // silent — sidebar shouldn't break if poller endpoint hiccups
      }
    }
    load();

    const token = getAdminToken();
    if (token) {
      try {
        es = new EventSource(`/api/admin/messages/stream?token=${encodeURIComponent(token)}`);
        es.addEventListener("inbound", () => load());
        es.addEventListener("unmatched-changed", () => load());
        es.onerror = () => {
          // Fall back to a slower poll until the stream comes back.
          if (!pollInt) pollInt = setInterval(load, 60_000);
        };
      } catch {
        pollInt = setInterval(load, 60_000);
      }
    } else {
      pollInt = setInterval(load, 60_000);
    }

    return () => {
      cancelled = true;
      es?.close();
      if (pollInt) clearInterval(pollInt);
    };
  }, []);
  return count;
}

function NavLinks({ onNavigate }: { onNavigate?: () => void }) {
  const instagramBadge = useInstagramBadge();
  const unmatchedBadge = useUnmatchedSmsBadge();
  return (
    <>
      <AdminNavLink href="/admin" icon={LayoutDashboard} onClick={onNavigate}>Dashboard</AdminNavLink>
      <AdminNavLink href="/admin/menu" icon={MenuIcon} onClick={onNavigate}>Menu Manager</AdminNavLink>
      <AdminNavLink href="/admin/categories" icon={Tags} onClick={onNavigate}>Categories</AdminNavLink>
      <AdminNavLink href="/admin/calendar" icon={CalendarDays} onClick={onNavigate}>Availability</AdminNavLink>
      <AdminNavLink href="/admin/images" icon={Images} onClick={onNavigate}>Image Library</AdminNavLink>
      <div className="pt-2 pb-1">
        <p className="text-[10px] uppercase tracking-widest text-muted-foreground/60 font-semibold px-4 pb-1">On-Site Events</p>
      </div>
      <AdminNavLink href="/admin/event-settings" icon={Zap} onClick={onNavigate}>Event Settings</AdminNavLink>
      <AdminNavLink href="/admin/event-history" icon={History} onClick={onNavigate}>Event Log</AdminNavLink>
      <AdminNavLink href="/admin/sales-reports" icon={BarChart3} onClick={onNavigate}>Sales Reports</AdminNavLink>
      <a
        href="/event-taker"
        target="_blank"
        rel="noopener noreferrer"
        onClick={onNavigate}
        className="flex items-center gap-3 px-4 py-3 rounded-xl font-medium text-foreground/70 hover:bg-secondary hover:text-foreground transition-all"
      >
        <ShoppingCart className="w-5 h-5" />
        Order Taker (POS)
      </a>
      <div className="pt-2 pb-1">
        <p className="text-[10px] uppercase tracking-widest text-muted-foreground/60 font-semibold px-4 pb-1">Communications</p>
      </div>
      <AdminNavLink href="/admin/sms" icon={MessageSquare} onClick={onNavigate}>SMS</AdminNavLink>
      <AdminNavLink href="/admin/messages/unmatched" icon={Inbox} onClick={onNavigate} badge={unmatchedBadge}>
        Unmatched Inbox
      </AdminNavLink>
      <div className="pt-2 pb-1">
        <p className="text-[10px] uppercase tracking-widest text-muted-foreground/60 font-semibold px-4 pb-1">Catering</p>
      </div>
      <AdminNavLink href="/admin/catering" icon={Briefcase} onClick={onNavigate}>Catering Inquiries</AdminNavLink>
      <AdminNavLink href="/admin/catering/upcoming" icon={CalendarRange} onClick={onNavigate}>Upcoming Caterings</AdminNavLink>
      <AdminNavLink href="/admin/catering/plans" icon={ClipboardList} onClick={onNavigate}>Event Plans</AdminNavLink>
      <div className="pt-2 pb-1">
        <p className="text-[10px] uppercase tracking-widest text-muted-foreground/60 font-semibold px-4 pb-1">Site &amp; Social</p>
      </div>
      <AdminNavLink
        href="/admin/social/hashtag-wall"
        icon={Instagram}
        onClick={onNavigate}
        badge={instagramBadge}
      >
        Hashtag Wall
      </AdminNavLink>
      <div className="pt-2 pb-1">
        <p className="text-[10px] uppercase tracking-widest text-muted-foreground/60 font-semibold px-4 pb-1">System</p>
      </div>
      <AdminNavLink href="/admin/idle-activity" icon={Activity} onClick={onNavigate}>Idle Activity</AdminNavLink>
    </>
  );
}

export function AdminLayout({ children }: { children: React.ReactNode }) {
  const [, navigate] = useLocation();
  const [drawerOpen, setDrawerOpen] = useState(false);

  useEffect(() => {
    if (drawerOpen) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => { document.body.style.overflow = ""; };
  }, [drawerOpen]);

  const handleLogout = () => {
    clearAdminToken();
    navigate("/admin/login");
  };

  return (
    <div className="min-h-screen bg-secondary/30 flex">
      {/* Desktop Sidebar */}
      <aside className="w-72 bg-card border-r border-border flex-col shadow-sm hidden md:flex shrink-0">
        <div className="p-6 border-b border-border">
          <Link
            href="/"
            className="flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors mb-6 text-sm font-medium"
          >
            <ArrowLeft className="w-4 h-4" /> Back to Website
          </Link>
          <div className="flex items-center gap-3">
            <img src={LOGO_URL} alt="dash by Hollywood East Cafe" className="h-12 w-12 rounded-lg object-cover flex-shrink-0" />
            <div>
              <h2 className="font-bold text-base leading-tight">Admin Portal</h2>
              <p className="text-[10px] uppercase tracking-widest text-muted-foreground mt-0.5">dash by HEC</p>
            </div>
          </div>
        </div>
        <nav className="flex-1 p-4 space-y-2">
          <NavLinks />
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

      {/* Mobile Drawer Overlay */}
      {drawerOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm md:hidden"
          onClick={() => setDrawerOpen(false)}
        />
      )}

      {/* Mobile Drawer */}
      <div
        className={cn(
          "fixed inset-y-0 left-0 z-50 w-72 bg-card shadow-2xl flex flex-col transition-transform duration-300 md:hidden",
          drawerOpen ? "translate-x-0" : "-translate-x-full"
        )}
      >
        <div className="p-6 border-b border-border flex items-center justify-between">
          <div className="flex items-center gap-3">
            <img src={LOGO_URL} alt="dash by Hollywood East Cafe" className="h-10 w-10 rounded-lg object-cover flex-shrink-0" />
            <div>
              <h2 className="font-bold text-base leading-tight">Admin Portal</h2>
              <p className="text-[10px] uppercase tracking-widest text-muted-foreground mt-0.5">dash by HEC</p>
            </div>
          </div>
          <button
            onClick={() => setDrawerOpen(false)}
            className="p-2 rounded-xl text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        <nav className="flex-1 p-4 space-y-2 overflow-y-auto">
          <NavLinks onNavigate={() => setDrawerOpen(false)} />
        </nav>
        <div className="p-4 border-t border-border space-y-2">
          <Link
            href="/"
            onClick={() => setDrawerOpen(false)}
            className="flex items-center gap-3 w-full px-4 py-3 rounded-xl font-medium text-muted-foreground hover:bg-secondary hover:text-foreground transition-all duration-200"
          >
            <ArrowLeft className="w-5 h-5" />
            Back to Website
          </Link>
          <button
            onClick={handleLogout}
            className="flex items-center gap-3 w-full px-4 py-3 rounded-xl font-medium text-foreground/70 hover:bg-red-50 hover:text-red-600 transition-all duration-200"
          >
            <LogOut className="w-5 h-5" />
            Sign Out
          </button>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Mobile Top Bar */}
        <header className="md:hidden sticky top-0 z-30 bg-card border-b border-border flex items-center gap-3 px-4 py-3 shadow-sm">
          <button
            onClick={() => setDrawerOpen(true)}
            className="p-2 rounded-xl text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors"
            aria-label="Open menu"
          >
            <AlignJustify className="w-5 h-5" />
          </button>
          <img src={LOGO_URL} alt="" className="h-8 w-8 rounded-lg object-cover" />
          <span className="font-bold text-sm">Admin Portal</span>
        </header>

        <main className="flex-1 overflow-auto">
          <div className="p-4 md:p-8 max-w-6xl mx-auto">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
