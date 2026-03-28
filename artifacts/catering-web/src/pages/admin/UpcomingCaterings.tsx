import { useState, useEffect, useCallback } from "react";
import { AdminLayout } from "@/components/AdminLayout";
import { getAdminToken } from "@/components/AdminGuard";
import { DayPicker } from "react-day-picker";
import "react-day-picker/dist/style.css";
import { Loader2, CalendarRange, Users, MapPin, Phone, Mail, ShoppingCart } from "lucide-react";
import { cn } from "@/lib/utils";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

function authHeaders() {
  const token = getAdminToken();
  return { Authorization: `Bearer ${token}` };
}

type OrderItem = { name: string; quantity: number; price: number };

type Inquiry = {
  id: number;
  clientName: string;
  clientEmail: string | null;
  clientPhone: string | null;
  organization: string | null;
  eventDate: string | null;
  guestCount: number | null;
  venueAddress: string | null;
  menuNotes: string | null;
  status: string;
  source: string;
  orderItems: OrderItem[] | null;
  orderTotal: string | null;
  createdAt: string;
};

type BlackoutDate = {
  id: number;
  date: string;
  reason: string | null;
};

function parseDateLocal(dateStr: string): Date {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function formatDate(d: string | null | undefined) {
  if (!d) return null;
  try {
    const date = parseDateLocal(d);
    if (isNaN(date.getTime())) return d;
    return date.toLocaleDateString("en-US", { weekday: "short", month: "long", day: "numeric", year: "numeric" });
  } catch { return d; }
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    inquiry: "bg-blue-100 text-blue-700",
    quoted: "bg-violet-100 text-violet-700",
    confirmed: "bg-emerald-100 text-emerald-700",
    completed: "bg-secondary text-muted-foreground",
    cancelled: "bg-red-100 text-red-600",
  };
  return (
    <span className={cn("text-xs px-2 py-0.5 rounded-full font-semibold capitalize", map[status] ?? "bg-secondary text-muted-foreground")}>
      {status}
    </span>
  );
}

export default function UpcomingCaterings() {
  const [inquiries, setInquiries] = useState<Inquiry[]>([]);
  const [blackouts, setBlackouts] = useState<BlackoutDate[]>([]);
  const [loading, setLoading] = useState(true);
  const [focusedId, setFocusedId] = useState<number | null>(null);
  const [month, setMonth] = useState<Date>(new Date());

  const load = useCallback(() => {
    Promise.all([
      fetch(`${BASE}/api/admin/catering`, { headers: authHeaders() }).then(r => r.json()),
      fetch(`${BASE}/api/blackout-dates`).then(r => r.json()),
    ]).then(([inqs, bos]) => {
      setInquiries(inqs);
      setBlackouts(bos);
    }).finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  // Confirmed caterings with a date
  const confirmed = inquiries.filter(i => i.eventDate && i.status !== "cancelled" && i.status !== "completed");

  const confirmedDates = confirmed
    .filter(i => i.eventDate)
    .map(i => parseDateLocal(i.eventDate!));

  const blackoutDates = blackouts.map(b => parseDateLocal(b.date));

  function handleDayClick(day: Date) {
    const yyyy = day.getFullYear();
    const mm = String(day.getMonth() + 1).padStart(2, "0");
    const dd = String(day.getDate()).padStart(2, "0");
    const dateStr = `${yyyy}-${mm}-${dd}`;
    const match = confirmed.find(i => i.eventDate === dateStr);
    if (match) {
      setFocusedId(match.id);
      // Scroll into view
      setTimeout(() => {
        document.getElementById(`catering-row-${match.id}`)?.scrollIntoView({ behavior: "smooth", block: "nearest" });
      }, 50);
    }
  }

  // Sort by eventDate ascending
  const sorted = [...confirmed].sort((a, b) => {
    if (!a.eventDate) return 1;
    if (!b.eventDate) return -1;
    return a.eventDate.localeCompare(b.eventDate);
  });

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const upcoming = sorted.filter(i => {
    if (!i.eventDate) return false;
    return parseDateLocal(i.eventDate) >= today;
  });
  const past = sorted.filter(i => {
    if (!i.eventDate) return false;
    return parseDateLocal(i.eventDate) < today;
  });

  return (
    <AdminLayout>
      <div className="mb-8">
        <h1 className="font-display font-bold text-4xl mb-2">Upcoming Caterings</h1>
        <p className="text-muted-foreground">View all scheduled and confirmed catering bookings at a glance.</p>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-24">
          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <div className="grid grid-cols-1 xl:grid-cols-[auto_1fr] gap-8 items-start">
          {/* Calendar */}
          <div className="bg-card p-6 rounded-3xl border border-border shadow-sm flex flex-col items-center gap-4 xl:sticky xl:top-6">
            <DayPicker
              month={month}
              onMonthChange={setMonth}
              onDayClick={handleDayClick}
              modifiers={{
                booked: confirmedDates,
                blacked: blackoutDates,
              }}
              modifiersStyles={{
                booked: {
                  backgroundColor: "hsl(142.1 76.2% 36.3%)",
                  color: "#fff",
                  borderRadius: "50%",
                  fontWeight: "700",
                },
                blacked: {
                  color: "hsl(var(--destructive))",
                  fontWeight: "700",
                  textDecoration: "line-through",
                },
              }}
              className="scale-110 origin-center"
            />
            {/* Legend */}
            <div className="flex items-center gap-4 text-xs text-muted-foreground pt-2 border-t border-border w-full justify-center">
              <span className="flex items-center gap-1.5">
                <span className="w-3 h-3 rounded-full bg-emerald-600 inline-block" /> Catering
              </span>
              <span className="flex items-center gap-1.5">
                <span className="w-3 h-3 rounded-full bg-destructive inline-block" /> Blocked
              </span>
            </div>
          </div>

          {/* List */}
          <div className="space-y-6">
            {upcoming.length === 0 && past.length === 0 ? (
              <div className="bg-card border border-border rounded-3xl p-16 text-center text-muted-foreground">
                <CalendarRange className="w-14 h-14 mx-auto mb-4 opacity-20" />
                <p className="font-medium text-lg mb-1">No caterings scheduled</p>
                <p className="text-sm">Inquiries with a set event date will appear here.</p>
              </div>
            ) : (
              <>
                {upcoming.length > 0 && (
                  <div>
                    <h2 className="font-bold text-lg mb-3 text-foreground/80 flex items-center gap-2">
                      <CalendarRange className="w-5 h-5" /> Upcoming ({upcoming.length})
                    </h2>
                    <div className="space-y-3">
                      {upcoming.map(i => (
                        <CateringCard
                          key={i.id}
                          inquiry={i}
                          focused={focusedId === i.id}
                          onClick={() => setFocusedId(focusedId === i.id ? null : i.id)}
                        />
                      ))}
                    </div>
                  </div>
                )}

                {past.length > 0 && (
                  <div>
                    <h2 className="font-bold text-lg mb-3 text-foreground/50 flex items-center gap-2">
                      Past ({past.length})
                    </h2>
                    <div className="space-y-3 opacity-60">
                      {past.map(i => (
                        <CateringCard
                          key={i.id}
                          inquiry={i}
                          focused={focusedId === i.id}
                          onClick={() => setFocusedId(focusedId === i.id ? null : i.id)}
                        />
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </AdminLayout>
  );
}

function CateringCard({ inquiry, focused, onClick }: { inquiry: Inquiry; focused: boolean; onClick: () => void }) {
  const isCart = inquiry.source === "cart";

  return (
    <div
      id={`catering-row-${inquiry.id}`}
      onClick={onClick}
      className={cn(
        "bg-card border rounded-2xl p-5 cursor-pointer transition-all shadow-sm hover:shadow-md",
        focused ? "border-primary ring-2 ring-primary/20" : "border-border hover:border-primary/30"
      )}
    >
      <div className="flex items-start gap-4">
        {/* Date block */}
        <div className="shrink-0 bg-emerald-50 border border-emerald-200 rounded-xl p-3 text-center min-w-[60px]">
          {inquiry.eventDate ? (
            <>
              <p className="text-emerald-700 font-bold text-lg leading-none">
                {parseDateLocal(inquiry.eventDate).getDate()}
              </p>
              <p className="text-emerald-600 text-xs font-semibold uppercase mt-0.5">
                {parseDateLocal(inquiry.eventDate).toLocaleDateString("en-US", { month: "short" })}
              </p>
              <p className="text-emerald-500 text-xs">
                {parseDateLocal(inquiry.eventDate).getFullYear()}
              </p>
            </>
          ) : (
            <p className="text-muted-foreground text-xs">TBD</p>
          )}
        </div>

        {/* Info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap mb-1">
            <span className="font-bold text-base truncate">{inquiry.clientName}</span>
            <StatusBadge status={inquiry.status} />
            {isCart && (
              <span className="flex items-center gap-0.5 text-xs px-1.5 py-0.5 bg-primary/10 text-primary rounded-full font-semibold">
                <ShoppingCart className="w-2.5 h-2.5" /> Cart
              </span>
            )}
          </div>
          {inquiry.organization && <p className="text-sm text-muted-foreground mb-2">{inquiry.organization}</p>}

          <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
            {inquiry.guestCount && (
              <span className="flex items-center gap-1">
                <Users className="w-3.5 h-3.5" /> {inquiry.guestCount} guests
              </span>
            )}
            {inquiry.venueAddress && (
              <span className="flex items-center gap-1 truncate max-w-[200px]">
                <MapPin className="w-3.5 h-3.5 shrink-0" /> {inquiry.venueAddress}
              </span>
            )}
            {inquiry.clientPhone && (
              <span className="flex items-center gap-1">
                <Phone className="w-3.5 h-3.5" /> {inquiry.clientPhone}
              </span>
            )}
            {inquiry.clientEmail && (
              <span className="flex items-center gap-1 truncate max-w-[200px]">
                <Mail className="w-3.5 h-3.5 shrink-0" /> {inquiry.clientEmail}
              </span>
            )}
          </div>

          {/* Expanded details */}
          {focused && (
            <div className="mt-4 pt-4 border-t border-border space-y-3">
              {inquiry.menuNotes && (
                <div>
                  <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-1">Menu Notes</p>
                  <p className="text-sm">{inquiry.menuNotes}</p>
                </div>
              )}
              {isCart && Array.isArray(inquiry.orderItems) && inquiry.orderItems.length > 0 && (
                <div>
                  <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-1.5">Order Items</p>
                  <table className="w-full text-sm border border-border rounded-xl overflow-hidden">
                    <thead className="bg-secondary/30">
                      <tr className="text-left text-xs text-muted-foreground">
                        <th className="px-3 py-1.5 font-semibold">Item</th>
                        <th className="px-3 py-1.5 font-semibold text-center">Qty</th>
                        <th className="px-3 py-1.5 font-semibold text-right">Subtotal</th>
                      </tr>
                    </thead>
                    <tbody>
                      {inquiry.orderItems.map((item, idx) => (
                        <tr key={idx} className="border-t border-border/50">
                          <td className="px-3 py-1.5">{item.name}</td>
                          <td className="px-3 py-1.5 text-center">{item.quantity}</td>
                          <td className="px-3 py-1.5 text-right">${(item.price * item.quantity).toFixed(2)}</td>
                        </tr>
                      ))}
                    </tbody>
                    {inquiry.orderTotal && (
                      <tfoot>
                        <tr className="border-t-2 border-border bg-secondary/20">
                          <td colSpan={2} className="px-3 py-1.5 font-bold text-right text-xs">Total</td>
                          <td className="px-3 py-1.5 font-bold text-right text-primary">{inquiry.orderTotal}</td>
                        </tr>
                      </tfoot>
                    )}
                  </table>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
