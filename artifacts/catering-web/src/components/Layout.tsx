import { Link, useRoute } from "wouter";
import { ShoppingBag, MapPin, Instagram } from "lucide-react";
import { ContactWidget } from "./ContactWidget";
import { ThemeToggle } from "./ThemeToggle";
import { useGetPlan, getGetPlanQueryKey } from "@workspace/api-client-react";
import { getSessionId } from "@/lib/session";
import { cn } from "@/lib/utils";
import { useInstagramHandle } from "@/lib/instagram";

const LOGO_URL = `${import.meta.env.BASE_URL}images/dash-logo.png`;

function NavLink({ href, children }: { href: string; children: React.ReactNode }) {
  const [isActive] = useRoute(href);
  return (
    <Link
      href={href}
      className={cn(
        "font-medium text-sm transition-colors hover:text-primary relative py-2",
        isActive ? "text-primary" : "text-foreground/80"
      )}
    >
      {children}
      {isActive && (
        <span className="absolute bottom-0 left-0 w-full h-0.5 bg-primary rounded-full" />
      )}
    </Link>
  );
}

export function Layout({ children }: { children: React.ReactNode }) {
  const sessionId = getSessionId();
  const { data: plan } = useGetPlan(
    { sessionId },
    { query: { queryKey: getGetPlanQueryKey({ sessionId }), staleTime: 1000 } },
  );

  const planItemsCount = plan?.items?.length ?? 0;
  const igHandle = useInstagramHandle();

  return (
    <div className="min-h-screen flex flex-col relative">
      <header className="sticky top-0 z-40 bg-card border-b border-border/50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-20 flex items-center justify-between">
          <Link href="/" className="flex items-center group">
            <img
              src={LOGO_URL}
              alt="dash by Hollywood East Cafe"
              className="h-14 w-14 rounded-lg object-cover"
            />
          </Link>

          <nav className="hidden md:flex items-center gap-8">
            <NavLink href="/">Home</NavLink>
            <NavLink href="/menu">Our Menu</NavLink>
            <NavLink href="/gallery">Gallery</NavLink>
            <NavLink href="/plan">Event Plan</NavLink>
            <Link
              href="/event"
              className="font-medium text-sm transition-colors text-primary hover:text-primary/80 relative py-2 inline-flex items-center gap-1.5"
            >
              <MapPin className="w-4 h-4" />
              I'm at an event
            </Link>
          </nav>

          <div className="flex items-center gap-4">
            {igHandle && (
              <a
                href={`https://instagram.com/${igHandle}`}
                target="_blank"
                rel="noopener noreferrer"
                className="hidden md:flex items-center text-foreground/60 hover:text-primary transition-colors"
                aria-label={`Follow us on Instagram @${igHandle}`}
              >
                <Instagram className="w-5 h-5" />
              </a>
            )}
            <ThemeToggle />
            <Link
              href="/plan"
              className="flex items-center gap-2 px-4 py-2 bg-secondary rounded-full hover:bg-secondary/80 transition-colors"
            >
              <ShoppingBag className="w-5 h-5 text-foreground" />
              <span className="font-bold text-sm">{planItemsCount}</span>
            </Link>
            <Link
              href="/admin"
              className="ml-4 text-xs font-semibold uppercase tracking-wider text-muted-foreground hover:text-primary transition-colors"
            >
              Admin
            </Link>
          </div>
        </div>
      </header>

      <main className="flex-1 w-full relative z-0">
        {children}
      </main>

      <footer className="bg-foreground text-background py-16 mt-20">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 grid grid-cols-1 md:grid-cols-4 gap-12">
          <div className="col-span-1 md:col-span-2">
            <div className="mb-6">
              <img
                src={LOGO_URL}
                alt="dash by Hollywood East Cafe"
                className="h-20 w-20 rounded-lg object-cover"
              />
            </div>
            <p className="text-background/70 max-w-md leading-relaxed italic text-sm">
              "bringing the flavors you love, on the dash"
            </p>
            <p className="text-background/50 max-w-md leading-relaxed mt-3 text-sm">
              Asian-inspired catering for every occasion. Fresh ingredients, bold flavors, memorable events.
            </p>
          </div>
          <div>
            <h4 className="font-semibold text-lg mb-6">Explore</h4>
            <ul className="space-y-4 text-background/60 text-sm">
              <li><Link href="/menu" className="hover:text-background transition-colors">Full Menu</Link></li>
              <li><Link href="/plan" className="hover:text-background transition-colors">Start Planning</Link></li>
            </ul>
          </div>
          <div>
            <h4 className="font-semibold text-lg mb-6">Contact</h4>
            <ul className="space-y-4 text-background/60 text-sm">
              <li>dash@HollywoodEastCafe.com</li>
              <li>Olney, Maryland</li>
              {igHandle && (
                <li>
                  <a
                    href={`https://instagram.com/${igHandle}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-2 hover:text-background transition-colors"
                  >
                    <Instagram className="w-4 h-4" />
                    @{igHandle}
                  </a>
                </li>
              )}
            </ul>
          </div>
        </div>
      </footer>

      <ContactWidget />
    </div>
  );
}
