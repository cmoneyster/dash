import { useEffect, useState } from "react";
import { useParams } from "wouter";
import { CheckCircle2, Clock, ChefHat, PackageCheck, Loader2 } from "lucide-react";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
const POLL_INTERVAL = 10000;

type OrderItem = { itemId: number; name: string; quantity: number; price: number };

type PublicOrder = {
  id: number;
  guestName: string;
  status: string;
  items: OrderItem[];
  createdAt: string;
  eventName: string;
};

const STATUS_STEPS = ["pending", "preparing", "ready", "done"] as const;

const STATUS_INFO: Record<string, { label: string; description: string; icon: React.ReactNode; color: string }> = {
  pending:   { label: "Order Received",    description: "Your order is in the queue.",             icon: <Clock className="w-8 h-8" />,        color: "text-amber-500"  },
  preparing: { label: "Being Prepared",    description: "The kitchen is working on your order.",   icon: <ChefHat className="w-8 h-8" />,      color: "text-blue-500"   },
  ready:     { label: "Ready for Pickup!", description: "Your order is ready. Come pick it up!",   icon: <PackageCheck className="w-8 h-8" />, color: "text-emerald-500" },
  done:      { label: "Order Complete",    description: "Thank you! Enjoy your food.",             icon: <CheckCircle2 className="w-8 h-8" />, color: "text-emerald-600" },
  picked_up: { label: "Picked Up",         description: "Thank you! Enjoy your food.",             icon: <CheckCircle2 className="w-8 h-8" />, color: "text-emerald-600" },
};

export default function OrderStatus() {
  const params = useParams<{ id: string }>();
  const orderId = params.id;
  const [order, setOrder] = useState<PublicOrder | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [loading, setLoading] = useState(true);

  async function fetchOrder() {
    try {
      const res = await fetch(`${BASE}/api/event-ordering/orders/${orderId}/public`);
      if (res.status === 404) { setNotFound(true); return; }
      if (!res.ok) return;
      const data = await res.json();
      setOrder(data);
    } catch {
      // silently retry
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchOrder();
    const interval = setInterval(fetchOrder, POLL_INTERVAL);
    return () => clearInterval(interval);
  }, [orderId]);

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (notFound || !order) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-4">
        <div className="text-center max-w-sm">
          <p className="text-muted-foreground text-lg">Order not found.</p>
          <p className="text-sm text-muted-foreground mt-1">Check your order number and try again.</p>
        </div>
      </div>
    );
  }

  const info = STATUS_INFO[order.status] ?? STATUS_INFO.pending;
  const currentStep = STATUS_STEPS.indexOf(order.status as typeof STATUS_STEPS[number]);
  const isDone = order.status === "done" || order.status === "picked_up";
  const isReady = order.status === "ready";

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-30 bg-card/80 backdrop-blur-md border-b border-border">
        <div className="max-w-lg mx-auto px-4 py-4 flex items-center justify-between">
          <div>
            <p className="font-display font-bold text-lg">{order.eventName || "dash by Hollywood East Cafe"}</p>
            <p className="text-xs text-muted-foreground">Order #{order.id}</p>
          </div>
          <img src="/images/dash-logo.png" alt="dash" className="w-9 h-9 rounded-xl object-cover" />
        </div>
      </header>

      <div className="max-w-lg mx-auto px-4 py-8 space-y-6">
        <div className={`bg-card border border-border rounded-2xl p-8 text-center shadow-sm ${isReady ? "ring-2 ring-emerald-400" : ""}`}>
          <div className={`flex items-center justify-center mx-auto mb-4 ${info.color} ${isReady ? "animate-bounce" : ""}`}>
            {info.icon}
          </div>
          <h1 className="font-display font-bold text-2xl mb-1">{info.label}</h1>
          <p className="text-muted-foreground text-sm">{info.description}</p>
        </div>

        <div className="bg-card border border-border rounded-2xl p-5 shadow-sm">
          <div className="flex items-center gap-0">
            {STATUS_STEPS.filter(s => s !== "done").map((step, idx) => {
              const stepIndex = STATUS_STEPS.indexOf(step);
              const isComplete = stepIndex < currentStep;
              const isActive = stepIndex === currentStep;
              const isLast = idx === 2;
              return (
                <div key={step} className="flex items-center flex-1">
                  <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold shrink-0 transition-all ${
                    isComplete || isDone ? "bg-emerald-500 text-white" :
                    isActive ? "bg-foreground text-background" :
                    "bg-secondary text-muted-foreground"
                  }`}>
                    {isComplete || isDone ? "✓" : idx + 1}
                  </div>
                  {!isLast && (
                    <div className={`flex-1 h-0.5 mx-1 transition-all ${isComplete || isDone ? "bg-emerald-500" : "bg-border"}`} />
                  )}
                </div>
              );
            })}
          </div>
          <div className="flex justify-between mt-2 text-xs text-muted-foreground">
            <span>Received</span>
            <span className="text-center">Preparing</span>
            <span className="text-right">Ready</span>
          </div>
        </div>

        <div className="bg-card border border-border rounded-2xl p-5 shadow-sm space-y-3">
          <h2 className="font-display font-bold text-base">Order Summary</h2>
          <p className="text-sm text-muted-foreground">For {order.guestName}</p>
          <div className="space-y-1.5 pt-1">
            {order.items.map((item, i) => (
              <div key={i} className="text-sm">
                {item.quantity}× {item.name}
              </div>
            ))}
          </div>
        </div>

        <p className="text-center text-xs text-muted-foreground pb-4">
          This page updates automatically · dash by Hollywood East Cafe
        </p>
      </div>
    </div>
  );
}
