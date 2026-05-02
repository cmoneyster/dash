import { useEffect, useRef, useState } from "react";
import { Link, useRoute } from "wouter";
import { CheckCircle2, Clock, Sparkles, ArrowLeft } from "lucide-react";
import { useDemoTour } from "@/lib/demoTour";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

type DemoOrder = {
  id: number;
  guestName: string;
  items: { itemId: number; name: string; quantity: number; price: number }[];
  createdAt: string;
};

// Sample tracking page reached by tapping the link in the demo SMS. The
// real guest tracking page polls a kitchen-driven status — this one is
// fully fake and just illustrates what that experience would look like.
export default function DemoOrderTracking() {
  const [, params] = useRoute<{ id: string }>("/demo/order/:id");
  const [order, setOrder] = useState<DemoOrder | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const confirmRef = useRef<HTMLDivElement | null>(null);
  const { run } = useDemoTour({ confirmRef });

  useEffect(() => {
    if (!params?.id) return;
    fetch(`${BASE}/api/demo/orders/${params.id}`)
      .then(async (r) => {
        if (!r.ok) throw new Error("not found");
        return r.json() as Promise<DemoOrder>;
      })
      .then(setOrder)
      .catch(() => setErr("This demo order link is no longer available."));
  }, [params?.id]);

  useEffect(() => {
    if (!order) return;
    const t = setTimeout(() => run({ phase: "confirmation", auto: true }), 300);
    return () => clearTimeout(t);
  }, [order, run]);

  return (
    <div className="min-h-screen bg-background">
      <div className="sticky top-0 z-30 bg-amber-500 text-amber-950 border-b-2 border-amber-700">
        <div className="max-w-2xl mx-auto px-4 py-2.5 flex items-center gap-2 text-sm font-semibold">
          <Sparkles className="w-4 h-4" />
          DEMO MODE — sample tracking page. No real order is being prepared.
        </div>
      </div>
      <div className="max-w-2xl mx-auto px-4 py-10">
        <Link href="/" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground mb-6">
          <ArrowLeft className="w-4 h-4" /> Back to home
        </Link>

        {err && (
          <div className="bg-card border border-border rounded-2xl p-8 text-center text-muted-foreground">
            {err}
          </div>
        )}

        {!err && !order && <p className="text-center text-muted-foreground">Loading…</p>}

        {order && (
          <div ref={confirmRef} className="bg-card border border-border rounded-3xl p-8">
            <p className="text-xs uppercase tracking-widest font-semibold text-muted-foreground">
              Order #{order.id}
            </p>
            <h1 className="font-display font-bold text-3xl mt-1 mb-4">
              Hi {order.guestName.split(" ")[0]}!
            </h1>

            <div className="flex items-center gap-3 px-4 py-3 rounded-2xl bg-emerald-50 text-emerald-800 mb-6">
              <CheckCircle2 className="w-5 h-5" />
              <p className="text-sm font-semibold">Order received — sample status</p>
            </div>

            <div className="space-y-3 mb-6">
              <div className="flex items-start gap-3">
                <CheckCircle2 className="w-5 h-5 text-emerald-600 mt-0.5" />
                <div>
                  <p className="font-semibold text-sm">Order placed</p>
                  <p className="text-xs text-muted-foreground">A real guest's order would now be on the kitchen display.</p>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <Clock className="w-5 h-5 text-muted-foreground mt-0.5" />
                <div>
                  <p className="font-semibold text-sm">Preparing</p>
                  <p className="text-xs text-muted-foreground">You'd see a live ETA here while the kitchen cooks.</p>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <Clock className="w-5 h-5 text-muted-foreground mt-0.5" />
                <div>
                  <p className="font-semibold text-sm">Ready for pickup</p>
                  <p className="text-xs text-muted-foreground">Guests get a second text the moment their order is ready.</p>
                </div>
              </div>
            </div>

            <div className="border-t border-border pt-4">
              <p className="text-xs uppercase tracking-widest font-semibold text-muted-foreground mb-2">Sample order</p>
              {order.items.map((i) => (
                <div key={i.itemId} className="text-sm py-0.5">
                  {i.quantity}× {i.name}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
