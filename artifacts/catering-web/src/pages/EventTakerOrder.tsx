import { useEffect, useMemo, useRef, useState } from "react";
import { getEventTakerMenu } from "@workspace/api-client-react";
import { TAX_DISCLOSURE, TAX_INCLUDED_NOTE } from "@/lib/tax";
import { Loader2, Plus, Minus, Trash2, ShoppingCart, Receipt, Check, AlertCircle, LogOut, ChefHat, Printer, PrinterCheck, DollarSign, CreditCard, Smartphone, ArrowLeft, Clock, X as XIcon, AlertTriangle, Layers, Pencil, GripVertical, RotateCcw } from "lucide-react";
import { getAdminToken } from "@/components/AdminGuard";
import { PrinterSettingsModal } from "@/components/PrinterSettingsModal";
import { ThemeToggle } from "@/components/ThemeToggle";
import { toast } from "sonner";
import {
  DndContext,
  closestCenter,
  type DragEndEvent,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
  useDraggable,
  useDroppable,
  DragOverlay,
} from "@dnd-kit/core";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
const PASSWORD_KEY = "event_taker_password";
// Auto-print policy now lives server-side in the admin printer rows
// (printers.auto_print_on_new_order + per-kind toggles). The Taker
// reads/writes those rows via /api/event-taker/printers, scoped to
// kinds the Taker surface is allowed to send (kitchen ticket + customer
// receipt). The previous per-device localStorage browser-print dropdown
// was retired; manual "Print" buttons on the confirmation screen remain
// as a browser-print backup.
// Per-device self-reported employee name shown in the header and required
// when voiding an order. Persisted in localStorage (not sessionStorage) so
// a register that's logged in stays attributed across page reloads.
const EMPLOYEE_KEY = "event_taker_employee_name";
const EMPLOYEE_MAX_LEN = 80;
function getStoredEmployee(): string | null {
  try {
    const v = localStorage.getItem(EMPLOYEE_KEY);
    return v && v.trim() ? v.trim() : null;
  } catch { return null; }
}
function setStoredEmployee(v: string | null) {
  try {
    if (v && v.trim()) localStorage.setItem(EMPLOYEE_KEY, v.trim());
    else localStorage.removeItem(EMPLOYEE_KEY);
  } catch {}
}

interface ComboSlotOption { menuItemId: number; name: string; }
interface ComboSlot { slotId: string; slotName: string; minQty: number; maxQty: number; options: ComboSlotOption[]; }
interface ComboSelection { slotId: string; slotName: string; menuItemId: number; name: string; quantity: number; }

interface MenuItem {
  id: number;
  name: string;
  description: string;
  category: string;
  price: number;
  eventTakerPrice: number | null;
  effectivePrice: number;
  unit: string;
  servingSize: number;
  imageUrl?: string | null;
  eventStock: number | null;
  internalNotes?: string | null;
  isCombo: boolean;
  comboSlots: ComboSlot[] | null;
}

interface CartLine {
  itemId: number;
  name: string;
  unitPrice: number;
  quantity: number;
  comboSelections?: ComboSelection[];
  comboName?: string;
  comboKey?: string;
}

interface TakerSettings {
  eventName: string;
  taxEnabled: boolean;
  taxRate: number | null;
  venmoHandle: string | null;
  venmoQrImageUrl: string | null;
  terminalEnabled?: boolean;
  orderingState?: "accepting" | "paused" | "closed";
  orderingPausedUntil?: string | null;
  orderingRemainingSec?: number | null;
  orderingPausedMessage?: string | null;
  staffNotesEnabled?: boolean;
}

function formatTakerBannerTime(pausedUntil: string | null | undefined, now: number): string {
  if (!pausedUntil) return "a moment";
  const ms = new Date(pausedUntil).getTime() - now;
  if (ms <= 0) return "a moment";
  const sec = Math.ceil(ms / 1000);
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m === 0) return `${s}s`;
  return `${m}m ${s.toString().padStart(2, "0")}s`;
}

type PaymentMethod = "cash" | "card" | "venmo";

interface PendingOrderItem {
  itemId: number;
  name: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
}

// One plate in a staff-defined plating layout. Quantities are whole units of
// items already in the parent order's `items` cart. The kitchen ticket renders
// these as plate cards; any unassigned units appear in an "Unassigned" group.
export interface PlateGroup {
  label: string;
  items: { itemId: number; quantity: number }[];
}

interface PendingOrder {
  id: number;
  guestName: string;
  phoneNumber: string | null;
  items: PendingOrderItem[];
  subtotal: number | null;
  taxRate: number | null;
  taxAmount: number | null;
  total: number | null;
  createdAt: string;
  // Kitchen-state, only populated for the "Sent orders" panel which surfaces
  // already-fired tickets that staff may need to void. The pending payments
  // queue does not depend on it (those rows are always pending/unpaid).
  status?: "pending" | "preparing" | "ready" | "done" | "picked_up" | string | null;
  paymentStatus?: "unpaid" | "paid" | "override" | string | null;
  paymentMethod?: PaymentMethod | null;
  cashReceived?: number | null;
  changeDue?: number | null;
  paymentOverrideReason?: string | null;
  plateGroups?: PlateGroup[] | null;
  // Void audit fields — only meaningful after a void; voided orders are
  // filtered out of every active queue, so these are mostly here for
  // type-completeness and the optimistic post-void receipt fallback.
  voidedAt?: string | null;
  voidReason?: string | null;
  voidedBy?: string | null;
  refundRequired?: boolean | null;
}

function getStoredPassword(): string | null {
  try { return sessionStorage.getItem(PASSWORD_KEY); } catch { return null; }
}
function setStoredPassword(v: string | null) {
  try { v ? sessionStorage.setItem(PASSWORD_KEY, v) : sessionStorage.removeItem(PASSWORD_KEY); } catch {}
}

// Pure helper: build the full fixed-slot render grid from the server layout +
// current menu. Stale IDs (items removed from menu) are converted to null.
// Items not yet in the layout are appended. The grid is padded to a full row
// plus one extra empty row so staff always have blank cells to drag into.
function buildArrangeGrid(menu: MenuItem[], layout: (number | null)[]): (number | null)[] {
  const COLS = 3;
  const menuIds = new Set(menu.map(m => m.id));
  // Drop stale IDs while preserving intentional nulls
  const clean: (number | null)[] = layout.map(id => (id === null || menuIds.has(id)) ? id : null);
  // Append items not yet placed anywhere in the layout
  const placed = new Set(clean.filter((id): id is number => id !== null));
  const unplaced = menu.filter(m => !placed.has(m.id)).map(m => m.id);
  const grid: (number | null)[] = [...clean, ...unplaced];
  // Pad to complete the last row, then add one full extra empty row
  const remainder = grid.length % COLS;
  const pad = (remainder === 0 ? 0 : COLS - remainder) + COLS;
  for (let i = 0; i < pad; i++) grid.push(null);
  return grid;
}

// Visual-only card rendered in the DragOverlay (no hooks — follows the pointer).
function ArrangeCardOverlay({ item }: { item: MenuItem }) {
  return (
    <div className="relative bg-card border-2 border-indigo-400 ring-2 ring-indigo-400/30 rounded-2xl overflow-hidden shadow-2xl opacity-95 select-none rotate-1 pointer-events-none">
      {item.imageUrl && (
        <div className="aspect-[4/3] bg-secondary">
          <img src={item.imageUrl} alt="" className="w-full h-full object-cover" />
        </div>
      )}
      <div className="p-3">
        <p className="font-semibold text-sm leading-tight">{item.name}</p>
        <span className="font-bold text-base text-indigo-600">${item.effectivePrice.toFixed(2)}</span>
      </div>
    </div>
  );
}

// A slot occupied by a menu item — draggable (via grip handle) and droppable.
function DraggableItemCard({
  item,
  slotIndex,
  isBeingDragged,
}: {
  item: MenuItem;
  slotIndex: number;
  isBeingDragged: boolean;
}) {
  const { setNodeRef: setDragRef, listeners, attributes } = useDraggable({ id: item.id });
  const { setNodeRef: setDropRef, isOver } = useDroppable({ id: slotIndex });
  const setRef = (node: HTMLElement | null) => { setDragRef(node); setDropRef(node); };

  return (
    <div
      ref={setRef}
      className={`relative bg-card border rounded-2xl overflow-hidden select-none transition-opacity ${
        isBeingDragged ? "opacity-25" : "opacity-100"
      } ${isOver && !isBeingDragged ? "border-indigo-400 ring-2 ring-indigo-400/20" : "border-border"}`}
    >
      <div
        {...attributes}
        {...listeners}
        className="absolute top-2 left-2 z-10 p-1 rounded bg-background/80 backdrop-blur-sm text-muted-foreground cursor-grab active:cursor-grabbing touch-none"
        aria-label="Drag to reorder"
      >
        <GripVertical className="w-4 h-4" />
      </div>
      <div className="absolute top-2 right-2 z-10">
        <span className="text-[10px] font-medium bg-secondary/90 text-muted-foreground px-1.5 py-0.5 rounded-full leading-none">
          {item.category}
        </span>
      </div>
      {item.imageUrl && (
        <div className="aspect-[4/3] bg-secondary">
          <img src={item.imageUrl} alt="" className="w-full h-full object-cover" />
        </div>
      )}
      <div className="p-3">
        <p className="font-semibold text-sm leading-tight">{item.name}</p>
        <span className="font-bold text-base text-indigo-600">${item.effectivePrice.toFixed(2)}</span>
      </div>
    </div>
  );
}

// An empty cell — droppable target only. Grows to match item card height via
// CSS grid row sizing (all cells in a row share the tallest cell's height).
function ArrangeEmptySlot({ slotIndex }: { slotIndex: number }) {
  const { setNodeRef, isOver } = useDroppable({ id: slotIndex });
  return (
    <div
      ref={setNodeRef}
      className={`rounded-2xl border-2 border-dashed transition-colors flex items-center justify-center min-h-[80px] ${
        isOver
          ? "border-indigo-400 bg-indigo-50/60 dark:bg-indigo-950/20"
          : "border-border/40 bg-secondary/10"
      }`}
    >
      {isOver && (
        <span className="text-xs font-medium text-indigo-500 pointer-events-none">Drop here</span>
      )}
    </div>
  );
}

function ComboPickerModal({
  item,
  stockByItemId,
  onConfirm,
  onClose,
}: {
  item: MenuItem;
  stockByItemId: Map<number, number | null>;
  onConfirm: (selections: ComboSelection[]) => void;
  onClose: () => void;
}) {
  const [qtys, setQtys] = useState<Record<string, Record<number, number>>>({});
  const slots = item.comboSlots ?? [];

  const getQty = (slotId: string, menuItemId: number) => qtys[slotId]?.[menuItemId] ?? 0;

  const changeSlotQty = (slotId: string, menuItemId: number, delta: number, slotMaxQty: number) => {
    setQtys(prev => {
      const slotQtys = { ...(prev[slotId] ?? {}) };
      const slotTotal = Object.values(slotQtys).reduce((s, v) => s + v, 0);
      const curQty = slotQtys[menuItemId] ?? 0;
      const newQty = curQty + delta;
      if (newQty < 0) return prev;
      if (delta > 0 && slotTotal >= slotMaxQty) return prev;
      const stock = stockByItemId.get(menuItemId) ?? null;
      if (delta > 0 && stock !== null && newQty > stock) return prev;
      return { ...prev, [slotId]: { ...slotQtys, [menuItemId]: newQty } };
    });
  };

  const isValid = slots.every(slot => {
    const total = Object.values(qtys[slot.slotId] ?? {}).reduce((s, v) => s + v, 0);
    return total >= slot.minQty && total <= slot.maxQty;
  });

  const handleConfirm = () => {
    const selections: ComboSelection[] = [];
    for (const slot of slots) {
      for (const opt of slot.options) {
        const qty = getQty(slot.slotId, opt.menuItemId);
        if (qty > 0) {
          selections.push({ slotId: slot.slotId, slotName: slot.slotName, menuItemId: opt.menuItemId, name: opt.name, quantity: qty });
        }
      }
    }
    onConfirm(selections);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-foreground/20 backdrop-blur-sm">
      <div className="bg-card w-full max-w-md rounded-3xl shadow-2xl overflow-hidden max-h-[90vh] flex flex-col">
        <div className="px-6 py-4 border-b border-border flex justify-between items-center bg-secondary/30 shrink-0">
          <div>
            <h2 className="font-bold text-xl leading-tight">{item.name}</h2>
            <p className="text-sm text-muted-foreground">${item.effectivePrice.toFixed(2)} — make your selections</p>
          </div>
          <button type="button" onClick={onClose} className="p-2 hover:bg-secondary rounded-full">
            <XIcon className="w-5 h-5" />
          </button>
        </div>
        <div className="overflow-y-auto p-5 space-y-4 flex-1">
          {slots.map(slot => {
            const slotTotal = Object.values(qtys[slot.slotId] ?? {}).reduce((s, v) => s + v, 0);
            const atMax = slotTotal >= slot.maxQty;
            const isSlotValid = slotTotal >= slot.minQty && slotTotal <= slot.maxQty;
            return (
              <div
                key={slot.slotId}
                className={`p-4 rounded-2xl border transition-colors ${
                  isSlotValid
                    ? "border-emerald-300 dark:border-emerald-700 bg-emerald-50/50 dark:bg-emerald-950/20"
                    : "border-border bg-secondary/20"
                }`}
              >
                <div className="flex items-center justify-between mb-3">
                  <p className="font-semibold text-sm">{slot.slotName}</p>
                  <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                    isSlotValid
                      ? "bg-emerald-100 dark:bg-emerald-900/50 text-emerald-700 dark:text-emerald-400"
                      : "bg-secondary text-muted-foreground"
                  }`}>
                    {slotTotal}/{slot.maxQty}{slot.minQty !== slot.maxQty ? ` (min ${slot.minQty})` : ""}
                  </span>
                </div>
                <div className="space-y-2">
                  {slot.options.map(opt => {
                    const qty = getQty(slot.slotId, opt.menuItemId);
                    const stock = stockByItemId.get(opt.menuItemId) ?? null;
                    const soldOut = stock !== null && stock <= 0;
                    const lowStock = stock !== null && stock > 0 && stock <= 5;
                    const atItemMax = stock !== null && qty >= stock;
                    const plusDisabled = atMax || soldOut || atItemMax;
                    return (
                      <div key={opt.menuItemId} className={`flex items-center justify-between gap-3 ${soldOut ? "opacity-50" : ""}`}>
                        <div className="flex-1 min-w-0">
                          <span className={`text-sm ${soldOut ? "line-through text-muted-foreground" : ""}`}>{opt.name}</span>
                          {soldOut && (
                            <span className="ml-2 text-xs font-semibold text-red-600 dark:text-red-400">Sold out</span>
                          )}
                          {!soldOut && stock !== null && (
                            <span className={`ml-2 text-[11px] font-semibold px-1.5 py-0.5 rounded-full ${
                              lowStock
                                ? "bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-400"
                                : "bg-secondary text-muted-foreground"
                            }`}>
                              {stock} left
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <button
                            type="button"
                            onClick={() => changeSlotQty(slot.slotId, opt.menuItemId, -1, slot.maxQty)}
                            disabled={qty <= 0}
                            className="w-8 h-8 rounded-lg bg-secondary hover:bg-secondary/70 flex items-center justify-center disabled:opacity-30 transition-opacity"
                          >
                            <Minus className="w-3.5 h-3.5" />
                          </button>
                          <span className="w-6 text-center font-semibold text-sm tabular-nums">{qty}</span>
                          <button
                            type="button"
                            onClick={() => changeSlotQty(slot.slotId, opt.menuItemId, 1, slot.maxQty)}
                            disabled={plusDisabled}
                            className="w-8 h-8 rounded-lg bg-secondary hover:bg-secondary/70 flex items-center justify-center disabled:opacity-30 transition-opacity"
                          >
                            <Plus className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
        <div className="px-5 pb-5 pt-3 border-t border-border shrink-0">
          <button
            type="button"
            disabled={!isValid}
            onClick={handleConfirm}
            className="w-full py-3.5 bg-indigo-600 text-white font-bold rounded-2xl hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors text-base"
          >
            Add to Order — ${item.effectivePrice.toFixed(2)}
          </button>
          {!isValid && (
            <p className="text-xs text-muted-foreground text-center mt-2">
              {slots.filter(s => {
                const t = Object.values(qtys[s.slotId] ?? {}).reduce((a, v) => a + v, 0);
                return t < s.minQty;
              }).map(s => s.slotName).join(", ")} {slots.filter(s => {
                const t = Object.values(qtys[s.slotId] ?? {}).reduce((a, v) => a + v, 0);
                return t < s.minQty;
              }).length === 1 ? "needs" : "need"} a selection
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

export default function EventTakerOrder() {
  const [password, setPassword] = useState<string | null>(getStoredPassword());
  const [pwInput, setPwInput] = useState("");
  const [pwError, setPwError] = useState("");
  const [pwSubmitting, setPwSubmitting] = useState(false);
  // Self-reported employee name. After password verify, if this is null we
  // show the "Who's on the register?" gate before letting the cashier ring
  // anything up. The header surfaces it with a Switch button so a different
  // staffer taking over can change it without re-typing the password.
  const [employee, setEmployee] = useState<string | null>(getStoredEmployee());
  const [showEmployeeSwitch, setShowEmployeeSwitch] = useState(false);

  const [settings, setSettings] = useState<TakerSettings | null>(null);
  const [menu, setMenu] = useState<MenuItem[] | null>(null);
  const [menuError, setMenuError] = useState("");
  const [cart, setCart] = useState<CartLine[]>([]);
  const [guestName, setGuestName] = useState("");
  const [orderNotes, setOrderNotes] = useState("");
  const [phone, setPhone] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [confirmation, setConfirmation] = useState<null | { id: string; total: number; phoneSent: boolean; wasOverride: boolean }>(null);
  const [submitError, setSubmitError] = useState("");
  const [lastReceipt, setLastReceipt] = useState<null | {
    id: string; guestName: string; phone: string; items: CartLine[];
    subtotal: number; taxRate: number; taxAmount: number; total: number; placedAt: string;
    paymentStatus: string | null;
    paymentMethod: PaymentMethod | null;
    cashReceived: number | null;
    changeDue: number | null;
    paymentOverrideReason: string | null;
  }>(null);

  // ── Payment-gating state ──────────────────────────────────────────
  // `paymentOrder` is the unpaid order currently being charged in the modal.
  // While this is non-null, the cart is hidden and the payment modal is shown.
  const [paymentOrder, setPaymentOrder] = useState<PendingOrder | null>(null);
  const [pendingOrders, setPendingOrders] = useState<PendingOrder[]>([]);
  const [showPendingPanel, setShowPendingPanel] = useState(false);
  // "Sent orders" panel — staff orders already fired to the kitchen
  // (paid + override) that may need to be voided.
  const [sentOrders, setSentOrders] = useState<PendingOrder[]>([]);
  // Recent voids in the active session, with each row's voidedBy/reason
  // for attribution display in the Sent Orders panel.
  const [recentVoids, setRecentVoids] = useState<PendingOrder[]>([]);
  const [showSentPanel, setShowSentPanel] = useState(false);
  // The order currently being voided, if any. Drives the VoidModal.
  const [voidTarget, setVoidTarget] = useState<PendingOrder | null>(null);
  // Transient warning shown when staff tries to add more than the remaining
  // event stock (or tap a sold-out item). Auto-clears after a few seconds.
  const [stockWarning, setStockWarning] = useState<string>("");
  const stockWarnTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  function flashStockWarning(msg: string) {
    setStockWarning(msg);
    if (stockWarnTimer.current) clearTimeout(stockWarnTimer.current);
    stockWarnTimer.current = setTimeout(() => setStockWarning(""), 3500);
  }
  // Belt-and-suspenders: clear any pending warning timer if the component
  // unmounts (e.g. cashier signs out) so we don't update state on a dead tree.
  useEffect(() => () => {
    if (stockWarnTimer.current) clearTimeout(stockWarnTimer.current);
  }, []);

  // Server-backed printer settings modal (scoped to the Taker surface).
  const [printerModalOpen, setPrinterModalOpen] = useState(false);
  // null = not yet fetched, true/false = whether any printer has opensCashDrawer enabled.
  const [hasCashDrawer, setHasCashDrawer] = useState<boolean | null>(null);
  const [comboPicker, setComboPicker] = useState<{ item: MenuItem } | null>(null);

  // Arrange-mode state. slotLayout mirrors the server's takerMenuOrder:
  // null entries are intentional empty cells. buildArrangeGrid() pads it
  // at render time so there are always blank cells to drag into.
  const [arrangeMode, setArrangeMode] = useState(false);
  const [slotLayout, setSlotLayout] = useState<(number | null)[]>([]);
  const [activeItemId, setActiveItemId] = useState<number | null>(null);
  const [savingOrder, setSavingOrder] = useState(false);

  // Per-ticket print status so staff can see whether each auto-print actually
  // reached the printer. `idle` = not attempted yet, `printing` = dialog open,
  // `printed` = afterprint fired after a real print, `canceled` = dialog closed
  // immediately (user dismissed), `blocked` = no print dialog ever opened
  // (popup/print blocker, no printer configured, etc.).
  type PrintStatus = "idle" | "printing" | "printed" | "canceled" | "blocked";
  const [kitchenStatus, setKitchenStatus] = useState<PrintStatus>("idle");
  const [receiptStatus, setReceiptStatus] = useState<PrintStatus>("idle");

  // Run a single print and resolve with whether it actually printed,
  // was canceled, or never opened a dialog. We bracket `window.print()` with
  // beforeprint/afterprint listeners: if beforeprint never fires the dialog
  // was blocked entirely; if afterprint follows beforeprint within a few
  // hundred ms we treat it as a cancel (no real print job sent).
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 150, tolerance: 8 } }),
  );

  // The full fixed-slot render grid, recomputed whenever the layout or menu changes.
  const arrangeGrid = useMemo(
    () => (menu ? buildArrangeGrid(menu, slotLayout) : []),
    [menu, slotLayout],
  );

  async function handleDragEnd(event: DragEndEvent) {
    setActiveItemId(null);
    const { active, over } = event;
    if (!over) return;
    const draggedItemId = active.id as number;
    const targetSlotIndex = over.id as number;
    const sourceSlotIndex = arrangeGrid.indexOf(draggedItemId);
    if (sourceSlotIndex === -1 || sourceSlotIndex === targetSlotIndex) return;

    // Swap: dragged item goes to the target slot; the target's occupant
    // (null for an empty slot, or another item ID) moves to the source slot.
    const newGrid = [...arrangeGrid];
    newGrid[sourceSlotIndex] = arrangeGrid[targetSlotIndex];
    newGrid[targetSlotIndex] = draggedItemId;

    // Trim trailing nulls for compact server storage — buildArrangeGrid
    // re-adds padding at render time so the grid always has expansion room.
    let lastNonNull = newGrid.length - 1;
    while (lastNonNull >= 0 && newGrid[lastNonNull] === null) lastNonNull--;
    const toSave = newGrid.slice(0, lastNonNull + 1);

    const snapshot = slotLayout;
    setSlotLayout(toSave);
    setSavingOrder(true);
    try {
      const res = await fetch(`${BASE}/api/event-taker/menu-order`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${password}` },
        body: JSON.stringify({ order: toSave }),
      });
      if (!res.ok) throw new Error("Save failed");
    } catch {
      setSlotLayout(snapshot);
      toast.error("Failed to save order — please try again");
    } finally {
      setSavingOrder(false);
    }
  }

  async function handleResetOrder() {
    if (!password) return;
    setSavingOrder(true);
    try {
      const clearRes = await fetch(`${BASE}/api/event-taker/menu-order`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${password}` },
        body: JSON.stringify({ order: [] }),
      });
      if (!clearRes.ok) throw new Error("Reset failed");
      const data = await getEventTakerMenu({
        headers: { Authorization: `Bearer ${password}` },
      });
      setMenu(data.items as MenuItem[]);
      setSlotLayout(data.layout as (number | null)[]);
    } catch {
      toast.error("Failed to reset order — please try again");
    } finally {
      setSavingOrder(false);
    }
  }

  // Send a manual reprint request to the server fanout for the given kind.
  // Updates the per-ticket status badge accordingly.
  async function handlePrint(mode: "receipt" | "kitchen") {
    if (!lastReceipt || !password) return;
    const kind = mode === "receipt" ? "customer_receipt" : "kitchen_ticket";
    const setStatus = mode === "kitchen" ? setKitchenStatus : setReceiptStatus;
    setStatus("printing");
    try {
      const res = await fetch(
        `${BASE}/api/event-taker/orders/${encodeURIComponent(lastReceipt.id)}/reprint`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${password}` },
          body: JSON.stringify({ kind }),
        },
      );
      if (!res.ok) {
        setStatus("blocked");
        return;
      }
      const data = await res.json() as { enqueued: number };
      setStatus(data.enqueued > 0 ? "printed" : "blocked");
    } catch {
      setStatus("blocked");
    }
  }

  // Print kitchen ticket first, then receipt — used by auto-print.
  async function printBoth() {
    await handlePrint("kitchen");
    await handlePrint("receipt");
  }

  // Reset per-ticket print status whenever a new confirmation comes up so
  // last order's badges don't bleed into the new one.
  useEffect(() => {
    setKitchenStatus("idle");
    setReceiptStatus("idle");
  }, [lastReceipt?.id]);

  // Auto-print on order placement is now handled server-side via the
  // print fan-out (printFanout.ts), gated by per-printer
  // auto_print_on_new_order toggles plus the per-surface allowed-kinds
  // matrix. The Taker no longer triggers a browser print on confirmation.

  // Fetch printer list to detect whether any printer has the cash drawer enabled.
  // Re-runs whenever the password changes (login/logout). We only need opensCashDrawer
  // so a single fetch on login is enough; the modal handles per-session changes.
  useEffect(() => {
    if (!password) { setHasCashDrawer(null); return; }
    fetch(`${BASE}/api/event-taker/printers`, {
      headers: { Authorization: `Bearer ${password}` },
    })
      .then(r => r.ok ? r.json() : Promise.reject())
      .then((rows: { opensCashDrawer?: boolean }[]) => {
        setHasCashDrawer(rows.some(p => p.opensCashDrawer === true));
      })
      .catch(() => { setHasCashDrawer(false); });
  }, [password]);

  // Public settings — re-polled so the kitchen pause/stop state stays current.
  useEffect(() => {
    function load() {
      fetch(`${BASE}/api/event-taker/settings`)
        .then(r => r.json())
        .then(setSettings)
        .catch(() => {});
    }
    load();
    const id = setInterval(load, 30000);
    return () => clearInterval(id);
  }, []);

  // Tick once a second so the paused-countdown banner animates between polls.
  const [tickNow, setTickNow] = useState(Date.now());
  useEffect(() => {
    if (settings?.orderingState !== "paused") return;
    const id = setInterval(() => setTickNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [settings?.orderingState]);

  // When the local countdown hits zero, optimistically flip to accepting so the
  // Charge button isn't false-disabled until the next 30s settings poll.
  useEffect(() => {
    if (settings?.orderingState === "paused" && settings.orderingPausedUntil
        && new Date(settings.orderingPausedUntil).getTime() <= tickNow) {
      setSettings(s => s ? { ...s, orderingState: "accepting", orderingPausedUntil: null, orderingRemainingSec: null } : s);
    }
  }, [tickNow, settings?.orderingState, settings?.orderingPausedUntil]);

  async function loadMenu(token: string) {
    setMenuError("");
    try {
      const data = await getEventTakerMenu({
        headers: { Authorization: `Bearer ${token}` },
      });
      setMenu(data.items as MenuItem[]);
      setSlotLayout(data.layout as (number | null)[]);
    } catch (err) {
      if (err && typeof err === "object" && "status" in err && err.status === 401) {
        handleLogout();
        return;
      }
      setMenuError("Failed to load menu");
    }
  }

  // Lightweight stock-only refresh used by the cross-device sync poll. Re-fetches
  // the taker menu but merges only `eventStock` into existing items so cashiers
  // on other devices see sold-out / dwindling counts within a few seconds — without
  // re-rendering the entire menu (which would scroll-jump, re-layout images, etc.).
  // Falls back to a full replace only when the item set itself has changed
  // server-side (added/removed item) so new items still appear.
  async function refreshStock(token: string) {
    try {
      const data = await getEventTakerMenu({
        headers: { Authorization: `Bearer ${token}` },
      });
      const fresh = data.items as MenuItem[];
      const stockById = new Map(fresh.map(m => [m.id, m.eventStock] as const));
      setMenu(prev => {
        if (!prev) return fresh;
        const sameSet = prev.length === fresh.length && prev.every(p => stockById.has(p.id));
        if (!sameSet) return fresh;
        let changed = false;
        const next = prev.map(p => {
          const newStock = stockById.get(p.id) ?? null;
          if (newStock === p.eventStock) return p;
          changed = true;
          return { ...p, eventStock: newStock };
        });
        return changed ? next : prev;
      });
    } catch {}
  }

  useEffect(() => {
    if (password) loadMenu(password);
  }, [password]);

  // Cross-device stock sync: poll the menu every few seconds and merge in only
  // the latest stock counts. Without this, two cashiers ringing in parallel can
  // each see "5 left" and only discover the conflict when the server rejects
  // the charge. We pause polling while the tab is hidden to avoid background
  // chatter, and immediately refresh when the tab comes back into focus.
  useEffect(() => {
    if (!password) return;
    const id = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      refreshStock(password);
    }, 5000);
    const onVis = () => {
      if (document.visibilityState === "visible") refreshStock(password);
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [password]);

  async function handleVerify(e: React.FormEvent) {
    e.preventDefault();
    setPwSubmitting(true);
    setPwError("");
    try {
      const res = await fetch(`${BASE}/api/event-taker/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: pwInput }),
      });
      if (!res.ok) {
        setPwError("Incorrect password");
      } else {
        setStoredPassword(pwInput);
        setPassword(pwInput);
        setPwInput("");
      }
    } catch {
      setPwError("Could not verify password");
    } finally {
      setPwSubmitting(false);
    }
  }

  function handleLogout() {
    setStoredPassword(null);
    setPassword(null);
    setMenu(null);
    setCart([]);
  }

  function addToCart(item: MenuItem) {
    // Sold-out and "would exceed remaining stock" cases are surfaced in the
    // UI as a transient warning rather than silently no-op'ing, so staff get
    // an immediate explanation when a tap doesn't take.
    if (item.eventStock !== null && item.eventStock <= 0) {
      flashStockWarning(`${item.name} is sold out.`);
      return;
    }
    // Combo items open the slot-selection modal instead of adding directly.
    if (item.isCombo && item.comboSlots && item.comboSlots.length > 0) {
      setComboPicker({ item });
      return;
    }
    const currentQty = cart.filter(l => l.itemId === item.id && !l.comboKey).reduce((s, l) => s + l.quantity, 0);
    if (item.eventStock !== null && currentQty + 1 > item.eventStock) {
      flashStockWarning(`Only ${item.eventStock} of ${item.name} left — already in cart.`);
      return;
    }
    setCart(prev => {
      const existing = prev.find(l => l.itemId === item.id && !l.comboKey);
      if (existing) {
        return prev.map(l => (l.itemId === item.id && !l.comboKey) ? { ...l, quantity: l.quantity + 1 } : l);
      }
      return [...prev, { itemId: item.id, name: item.name, unitPrice: item.effectivePrice, quantity: 1 }];
    });
  }

  function addComboToCart(item: MenuItem, comboSelections: ComboSelection[]) {
    setComboPicker(null);
    const comboKey = `${item.id}-${Date.now()}`;
    setCart(prev => [...prev, {
      itemId: item.id,
      name: item.name,
      unitPrice: item.effectivePrice,
      quantity: 1,
      comboSelections,
      comboName: item.name,
      comboKey,
    }]);
  }

  function changeQty(itemId: number, delta: number, comboKey?: string) {
    if (delta > 0 && menu) {
      // Block increments past the remaining event stock so staff don't
      // overshoot a limited item; -1 / removal stays unrestricted.
      const item = menu.find(m => m.id === itemId);
      const currentQty = comboKey
        ? (cart.find(l => l.comboKey === comboKey)?.quantity ?? 0)
        : cart.filter(l => l.itemId === itemId && !l.comboKey).reduce((s, l) => s + l.quantity, 0);
      if (item?.eventStock !== null && item?.eventStock !== undefined && currentQty + delta > item.eventStock) {
        flashStockWarning(`Only ${item.eventStock} of ${item.name} left.`);
        return;
      }
    }
    setCart(prev => prev
      .map(l => {
        const matches = comboKey ? l.comboKey === comboKey : (l.itemId === itemId && !l.comboKey);
        return matches ? { ...l, quantity: l.quantity + delta } : l;
      })
      .filter(l => l.quantity > 0));
  }

  function removeLine(itemId: number, comboKey?: string) {
    setCart(prev => comboKey
      ? prev.filter(l => l.comboKey !== comboKey)
      : prev.filter(l => !(l.itemId === itemId && !l.comboKey)));
  }

  const subtotal = useMemo(
    () => cart.reduce((s, l) => s + l.unitPrice * l.quantity, 0),
    [cart],
  );
  const taxRate = settings?.taxEnabled && settings.taxRate ? settings.taxRate : 0;
  const taxAmount = useMemo(() => Math.round(subtotal * (taxRate / 100) * 100) / 100, [subtotal, taxRate]);
  const total = Math.round((subtotal + taxAmount) * 100) / 100;

  const categories = useMemo(() => {
    if (!menu) return [];
    const cats = new Set<string>();
    for (const m of menu) cats.add(m.category);
    return Array.from(cats).sort();
  }, [menu]);

  async function loadPending(token: string) {
    try {
      const res = await fetch(`${BASE}/api/event-taker/orders/pending`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return;
      const data = await res.json();
      setPendingOrders(Array.isArray(data) ? data : []);
    } catch {}
  }

  // "Sent orders" feed — paid/override staff orders sitting on the kitchen
  // display. Used by the void panel.
  async function loadSent(token: string) {
    try {
      const res = await fetch(`${BASE}/api/event-taker/orders/active`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return;
      const data = await res.json();
      setSentOrders(Array.isArray(data) ? data : []);
    } catch {}
  }

  // Recent voids in the active session — surfaced inside the Sent Orders
  // panel so cashiers can see who voided what right next to their void
  // controls. Capped at 20 most-recent on the server.
  async function loadRecentVoids(token: string) {
    try {
      const res = await fetch(`${BASE}/api/event-taker/orders/recent-voids`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return;
      const data = await res.json();
      setRecentVoids(Array.isArray(data) ? data : []);
    } catch {}
  }

  // Poll the pending queue periodically so multiple devices stay in sync.
  useEffect(() => {
    if (!password) return;
    loadPending(password);
    loadSent(password);
    loadRecentVoids(password);
    const t = setInterval(() => {
      loadPending(password);
      loadSent(password);
      loadRecentVoids(password);
    }, 8000);
    return () => clearInterval(t);
  }, [password]);

  // Build the receipt-screen payload from a server order row, used after
  // a successful payment / override so we can show + auto-print the receipt.
  function receiptFromOrder(o: PendingOrder, paidAt = new Date()): typeof lastReceipt {
    const sub = o.subtotal ?? o.items.reduce((s, i) => s + i.lineTotal, 0);
    const tx = o.taxAmount ?? 0;
    const tot = o.total ?? (sub + tx);
    return {
      id: String(o.id),
      guestName: o.guestName,
      phone: o.phoneNumber ?? "",
      items: o.items.map(i => ({ itemId: i.itemId, name: i.name, unitPrice: i.unitPrice, quantity: i.quantity })),
      subtotal: sub,
      taxRate: o.taxRate ?? 0,
      taxAmount: tx,
      total: tot,
      placedAt: paidAt.toLocaleString(),
      paymentStatus: o.paymentStatus ?? null,
      paymentMethod: (o.paymentMethod ?? null) as PaymentMethod | null,
      cashReceived: o.cashReceived ?? null,
      changeDue: o.changeDue ?? null,
      paymentOverrideReason: o.paymentOverrideReason ?? null,
    };
  }

  // Step 1 of the gated flow: create the order as 'unpaid' and open the
  // payment modal. The cart is cleared so the cashier can immediately start
  // the next order if they hit "Hold for later".
  async function submitOrder(e: React.FormEvent) {
    e.preventDefault();
    if (!guestName.trim() || cart.length === 0 || !password) return;
    setSubmitting(true);
    setSubmitError("");
    try {
      const res = await fetch(`${BASE}/api/event-taker/orders`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${password}`,
        },
        body: JSON.stringify({
          guestName: guestName.trim(),
          phoneNumber: phone.trim() || null,
          notes: orderNotes.trim() || null,
          items: cart.map(l => ({
            itemId: l.itemId,
            quantity: l.quantity,
            ...(l.comboSelections ? { comboSelections: l.comboSelections } : {}),
          })),
          statusUrlBase: window.location.origin + BASE,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        if (res.status === 423) {
          // Refresh public settings so the banner picks up the new state immediately.
          fetch(`${BASE}/api/event-taker/settings`).then(r => r.json()).then(setSettings).catch(() => {});
        }
        setSubmitError(err.error ?? "Failed to place order");
        return;
      }
      const data = await res.json();
      // Open payment modal with a synthesized PendingOrder shape so the modal
      // and the eventual receipt screen can share one data type.
      const order: PendingOrder = {
        id: data.id,
        guestName: guestName.trim(),
        phoneNumber: phone.trim() || null,
        items: cart.map(l => ({
          itemId: l.itemId, name: l.name, quantity: l.quantity,
          unitPrice: l.unitPrice, lineTotal: Math.round(l.unitPrice * l.quantity * 100) / 100,
        })),
        subtotal: data.subtotal ?? subtotal,
        taxRate: data.taxRate ?? (taxRate || null),
        taxAmount: data.taxAmount ?? taxAmount,
        total: data.total ?? total,
        createdAt: data.createdAt ?? new Date().toISOString(),
        plateGroups: data.plateGroups ?? null,
      };
      setPaymentOrder(order);
      // Clear the cart now so the cashier can start a new order while the
      // current one waits for payment ("Hold for later").
      setCart([]);
      setGuestName("");
      setPhone("");
      setOrderNotes("");
      // Refresh menu (stock changed) and the pending queue.
      loadMenu(password);
      loadPending(password);
    } catch {
      setSubmitError("Could not reach the server");
    } finally {
      setSubmitting(false);
    }
  }

  // Step 2: payment confirmed. Promotes the order to "paid" or "override",
  // then shows the receipt screen which triggers auto-print as before.
  async function handlePaymentComplete(updated: PendingOrder & { wasOverride?: boolean }) {
    setPaymentOrder(null);
    setLastReceipt(receiptFromOrder(updated));
    setConfirmation({
      id: String(updated.id),
      total: updated.total ?? 0,
      phoneSent: !!updated.phoneNumber,
      // Server tells us if this was an override→paid transition. When true,
      // the kitchen already received its ticket at override time so we must
      // not auto-print it again from this device.
      wasOverride: !!updated.wasOverride,
    });
    if (password) loadPending(password);
  }

  // Soft-void a staff order that has already been sent to the kitchen.
  // Called from VoidModal once the cashier confirms with a reason. On
  // success, both queues refresh — the row drops from pending payments
  // (override case) or sent orders (paid/override case) on the next poll,
  // but we also remove it locally so the UI feels instant.
  async function handleVoidConfirmed(order: PendingOrder, reason: string, voidedBy: string): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!password) return { ok: false, error: "Not signed in" };
    const trimmedBy = voidedBy.trim();
    if (!trimmedBy) return { ok: false, error: "Employee name is required" };
    try {
      const res = await fetch(`${BASE}/api/event-taker/orders/${order.id}/void`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${password}` },
        body: JSON.stringify({ reason, voidedBy: trimmedBy }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        return { ok: false, error: err.error ?? "Failed to void order" };
      }
      // Drop the row locally; refresh all three feeds in the background
      // so the new void appears in the Sent Orders panel's "Recent voids"
      // subsection without waiting for the next 8s poll.
      setPendingOrders(prev => prev.filter(o => o.id !== order.id));
      setSentOrders(prev => prev.filter(o => o.id !== order.id));
      loadPending(password);
      loadSent(password);
      loadRecentVoids(password);
      return { ok: true };
    } catch {
      return { ok: false, error: "Could not reach the server" };
    }
  }

  // Override directly from the pending panel — same effect as the modal's
  // override button: sends to kitchen unpaid, fires SMS, shows + prints receipt.
  async function handleOverrideFromPanel(order: PendingOrder, reason: string) {
    if (!password) return;
    try {
      const res = await fetch(`${BASE}/api/event-taker/orders/${order.id}/override`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${password}` },
        body: JSON.stringify({
          reason: reason.trim() || null,
          statusUrlBase: window.location.origin + BASE,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        alert(err.error ?? "Failed to override");
        return;
      }
      const data = await res.json();
      // Close the panel and reuse the standard completion flow so the
      // receipt screen + auto-print fire just like a modal payment.
      setShowPendingPanel(false);
      handlePaymentComplete({ ...order, ...data });
    } catch {
      alert("Could not reach the server");
    }
  }

  async function handleCancelOrder(orderId: number) {
    if (!password) return;
    if (!confirm("Cancel this order? Stock will be restored.")) return;
    try {
      const res = await fetch(`${BASE}/api/event-taker/orders/${orderId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${password}` },
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        alert(err.error ?? "Failed to cancel order");
        return;
      }
      if (paymentOrder?.id === orderId) setPaymentOrder(null);
      loadPending(password);
      loadMenu(password);
    } catch {
      alert("Could not reach the server");
    }
  }

  // Edit Order: cancel the in‑progress (unpaid) order on the backend so its
  // stock is restored, rehydrate the cart with the order's items / guest
  // details, and close the payment modal so the cashier lands back on the
  // ordering screen ready to adjust. Only valid while the kitchen has not
  // yet seen the order (paymentStatus === 'unpaid'); the modal disables the
  // button once the order is in override state.
  async function handleEditOrder(order: PendingOrder) {
    if (!password) return;
    if (order.paymentStatus && order.paymentStatus !== "unpaid") return;
    try {
      const res = await fetch(`${BASE}/api/event-taker/orders/${order.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${password}` },
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        alert(err.error ?? "Failed to open order for editing");
        return;
      }
      // Pre-load the cart with the canceled order's items so the cashier can
      // adjust quantities/items in place. unitPrice survives unchanged so a
      // priced item edited back into the cart keeps the price the customer
      // was originally quoted.
      setCart(order.items.map(i => ({
        itemId: i.itemId,
        name: i.name,
        unitPrice: i.unitPrice,
        quantity: i.quantity,
      })));
      setGuestName(order.guestName ?? "");
      setPhone(order.phoneNumber ?? "");
      setPaymentOrder(null);
      setSubmitError("");
      loadPending(password);
      loadMenu(password);
    } catch {
      alert("Could not reach the server");
    }
  }

  // ── Password gate ────────────────────────────────────────────────
  if (!password) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-indigo-50 via-background to-amber-50 flex items-center justify-center p-4">
        <div className="bg-card border border-border rounded-3xl shadow-xl p-8 w-full max-w-md">
          <div className="text-center mb-6">
            <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-indigo-100 text-indigo-600 mb-4">
              <ShoppingCart className="w-7 h-7" />
            </div>
            <h1 className="font-display font-bold text-2xl">Staff Order Taker</h1>
            <p className="text-sm text-muted-foreground mt-1">Enter the staff password to continue</p>
            {settings?.eventName && (
              <p className="text-xs text-muted-foreground mt-2">{settings.eventName}</p>
            )}
          </div>
          <form onSubmit={handleVerify} className="space-y-3">
            <input
              type="password"
              autoFocus
              value={pwInput}
              onChange={e => setPwInput(e.target.value)}
              placeholder="Password"
              className="w-full px-4 py-3 border border-border rounded-xl bg-background focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 outline-none"
            />
            {pwError && (
              <p className="text-sm text-destructive flex items-center gap-1.5">
                <AlertCircle className="w-4 h-4" />{pwError}
              </p>
            )}
            <button
              type="submit"
              disabled={pwSubmitting || !pwInput}
              className="w-full px-5 py-3 bg-indigo-600 text-white font-semibold rounded-xl hover:bg-indigo-700 transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {pwSubmitting ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
              Sign in
            </button>
          </form>
        </div>
      </div>
    );
  }

  // ── Employee gate ────────────────────────────────────────────────
  // Fires once after password verify (and again if the cashier hits
  // "Switch"). The name is per-device, not per-session — so it persists
  // across browser refreshes but stays sane if a different cashier takes
  // over the same iPad.
  if (!employee || showEmployeeSwitch) {
    return (
      <EmployeeGate
        initial={employee ?? ""}
        switching={!!employee && showEmployeeSwitch}
        onCancel={employee ? () => setShowEmployeeSwitch(false) : undefined}
        onSubmit={(name) => {
          const trimmed = name.trim();
          if (!trimmed) return;
          setStoredEmployee(trimmed);
          setEmployee(trimmed);
          setShowEmployeeSwitch(false);
        }}
      />
    );
  }

  // ── Confirmation / printable receipt screen ─────────────────────
  if (confirmation && lastReceipt) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-emerald-50 via-background to-emerald-100 dark:from-emerald-950/20 dark:to-emerald-900/10 flex items-center justify-center p-4 print:bg-white print:p-0">
        <div className="bg-card border border-border rounded-3xl shadow-xl p-6 max-w-md w-full print:shadow-none print:border-0 print:rounded-none">
          <div className="text-center mb-4 print:hidden">
            <div className="inline-flex items-center justify-center w-14 h-14 rounded-full bg-emerald-100 dark:bg-emerald-900/40 text-emerald-600 dark:text-emerald-400 mb-2">
              <Check className="w-7 h-7" />
            </div>
            <h2 className="font-display font-bold text-2xl">Order placed!</h2>
            {confirmation.phoneSent && (
              <p className="text-xs text-muted-foreground mt-1">SMS confirmation sent.</p>
            )}
          </div>

          {/* Print page sizing — narrow for thermal/ESC-POS, A4 fallback otherwise */}
          <style>{`
            @media print {
              @page { size: 80mm auto; margin: 4mm; }
              body { background: #fff !important; }
            }
          `}</style>

          {/* Customer receipt — visible on screen as preview, printed only in receipt mode */}
          <div
            id="receipt"
            className="font-mono text-sm bg-white dark:bg-card border border-dashed border-border rounded-xl p-4 print:border-0 print:p-0"
          >
            <div className="text-center mb-3">
              <p className="font-bold text-base">{settings?.eventName || "dash by Hollywood East Cafe"}</p>
              <p className="text-xs">{lastReceipt.placedAt}</p>
              <p className="text-xs">Order #{lastReceipt.id.slice(0, 8)}</p>
            </div>
            <div className="border-t border-b border-dashed py-2 mb-2 space-y-1">
              <p>Customer: {lastReceipt.guestName}</p>
              {lastReceipt.phone && <p>Phone: {lastReceipt.phone}</p>}
            </div>
            <table className="w-full text-xs mb-2">
              <tbody>
                {lastReceipt.items.map(l => (
                  <tr key={l.itemId}>
                    <td className="py-0.5">{l.quantity}× {l.name}</td>
                    <td className="py-0.5 text-right">${(l.unitPrice * l.quantity).toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="border-t border-dashed pt-2 space-y-0.5 text-xs">
              <div className="flex justify-between"><span>Subtotal</span><span>${lastReceipt.subtotal.toFixed(2)}</span></div>
              {lastReceipt.taxRate > 0 && (
                <div className="flex justify-between"><span>Tax ({lastReceipt.taxRate.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')}%)</span><span>${lastReceipt.taxAmount.toFixed(2)}</span></div>
              )}
              <div className="flex justify-between font-bold text-sm pt-1 border-t border-dashed mt-1"><span>TOTAL</span><span>${lastReceipt.total.toFixed(2)}</span></div>
            </div>
            {/* Payment summary — what was tendered, plus change for cash. */}
            {(lastReceipt.paymentStatus === "paid" || lastReceipt.paymentStatus === "override") && (
              <div className="border-t border-dashed pt-2 mt-2 space-y-0.5 text-xs">
                {lastReceipt.paymentStatus === "override" ? (
                  <>
                    <div className="flex justify-between"><span>Paid</span><span>Override</span></div>
                    {lastReceipt.paymentOverrideReason && (
                      <div className="text-[11px] italic">Reason: {lastReceipt.paymentOverrideReason}</div>
                    )}
                  </>
                ) : lastReceipt.paymentMethod === "cash" ? (
                  <>
                    <div className="flex justify-between">
                      <span>Paid: Cash</span>
                      <span>{lastReceipt.cashReceived != null ? `$${lastReceipt.cashReceived.toFixed(2)}` : "—"}</span>
                    </div>
                    <div className="flex justify-between">
                      <span>Change</span>
                      <span>{lastReceipt.changeDue != null ? `$${lastReceipt.changeDue.toFixed(2)}` : "—"}</span>
                    </div>
                  </>
                ) : lastReceipt.paymentMethod === "card" ? (
                  <div className="flex justify-between"><span>Paid</span><span>Card</span></div>
                ) : lastReceipt.paymentMethod === "venmo" ? (
                  <div className="flex justify-between"><span>Paid</span><span>Venmo</span></div>
                ) : null}
              </div>
            )}
            <p className="text-center text-xs mt-3">Thank you!</p>
          </div>

          {/* Kitchen ticket — hidden on screen, only printed when in kitchen mode */}
          <div
            id="kitchen-ticket"
            className="hidden font-mono text-base bg-white text-black print:border-0 print:p-0"
          >
            <div className="text-center mb-3">
              <p className="font-bold text-lg uppercase tracking-wider">Kitchen Ticket</p>
              <p className="text-xs">{settings?.eventName || "dash by Hollywood East Cafe"}</p>
              <p className="text-xs">{lastReceipt.placedAt}</p>
              <p className="text-base font-bold mt-1">Order #{lastReceipt.id.slice(0, 8)}</p>
            </div>
            <div className="border-t border-b border-dashed border-black py-2 mb-2">
              <p className="font-bold text-lg">{lastReceipt.guestName}</p>
            </div>
            <table className="w-full mb-2">
              <tbody>
                {lastReceipt.items.map(l => (
                  <tr key={l.itemId}>
                    <td className="py-1 align-top w-10 font-bold text-xl">{l.quantity}×</td>
                    <td className="py-1 align-top font-semibold">{l.name}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="text-center text-xs border-t border-dashed border-black pt-2 mt-2">
              {lastReceipt.items.reduce((s, l) => s + l.quantity, 0)} item(s) total
            </p>
          </div>

          {/* Per-ticket auto-print status. Shown only after we attempted to
              print that ticket (status !== "idle"), so manual-print users
              don't see noise. Failed/canceled rows are tappable to retry. */}
          {(kitchenStatus !== "idle" || receiptStatus !== "idle") && (
            <div className="mt-4 space-y-1.5 print:hidden" data-testid="print-status-panel">
              {kitchenStatus !== "idle" && (
                <PrintStatusRow
                  label="Kitchen ticket"
                  icon={<ChefHat className="w-4 h-4" />}
                  status={kitchenStatus}
                  onRetry={() => void handlePrint("kitchen")}
                />
              )}
              {receiptStatus !== "idle" && (
                <PrintStatusRow
                  label="Customer receipt"
                  icon={<Receipt className="w-4 h-4" />}
                  status={receiptStatus}
                  onRetry={() => void handlePrint("receipt")}
                />
              )}
            </div>
          )}

          <div className="grid grid-cols-3 gap-2 mt-4 print:hidden">
            <button
              onClick={() => handlePrint("receipt")}
              className="px-3 py-3 bg-secondary text-foreground font-semibold rounded-xl hover:bg-secondary/70 flex items-center justify-center gap-1.5 text-sm"
            >
              <Receipt className="w-4 h-4" /> Print Receipt
            </button>
            <button
              onClick={() => handlePrint("kitchen")}
              className="px-3 py-3 bg-amber-500 text-white font-semibold rounded-xl hover:bg-amber-600 flex items-center justify-center gap-1.5 text-sm"
            >
              <ChefHat className="w-4 h-4" /> Print Kitchen
            </button>
            <button
              onClick={() => { setConfirmation(null); setLastReceipt(null); }}
              className="px-3 py-3 bg-indigo-600 text-white font-semibold rounded-xl hover:bg-indigo-700 text-sm"
            >
              Next order
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── Main POS layout ──────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-secondary/30">
      <PrinterSettingsModal
        open={printerModalOpen}
        onClose={() => setPrinterModalOpen(false)}
        surface="taker"
        authToken={password}
      />
      {comboPicker && (
        <ComboPickerModal
          item={comboPicker.item}
          stockByItemId={new Map((menu ?? []).map(m => [m.id, m.eventStock] as const))}
          onConfirm={sels => addComboToCart(comboPicker.item, sels)}
          onClose={() => setComboPicker(null)}
        />
      )}
      <header className="bg-card border-b border-border sticky top-0 z-20">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-indigo-600 text-white flex items-center justify-center">
              <ShoppingCart className="w-5 h-5" />
            </div>
            <div>
              <h1 className="font-display font-bold text-lg leading-tight">Staff Order Taker</h1>
              <p className="text-xs text-muted-foreground leading-tight">{settings?.eventName || "dash by Hollywood East Cafe"}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setShowPendingPanel(true)}
              className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-semibold border transition-colors ${
                pendingOrders.length > 0
                  ? "bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-400 border-amber-200 dark:border-amber-800/50 hover:bg-amber-100 dark:hover:bg-amber-900/40"
                  : "bg-secondary text-muted-foreground border-transparent hover:text-foreground"
              }`}
              title="Orders awaiting payment"
            >
              <Clock className="w-4 h-4" />
              <span className="hidden sm:inline">Pending payments:</span>
              <span className="font-bold">{pendingOrders.length}</span>
            </button>
            {/* Sent orders panel — for voiding tickets already on the kitchen
                line. Stays muted unless there's actually something to void
                so the header doesn't add visual noise during slow shifts. */}
            <button
              type="button"
              onClick={() => setShowSentPanel(true)}
              className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-semibold border transition-colors ${
                sentOrders.length > 0
                  ? "bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-400 border-rose-200 dark:border-rose-800/50 hover:bg-rose-100 dark:hover:bg-rose-900/40"
                  : "bg-secondary text-muted-foreground border-transparent hover:text-foreground"
              }`}
              title="Orders already sent to the kitchen — void if needed"
              data-testid="button-sent-orders"
            >
              <ChefHat className="w-4 h-4" />
              <span className="hidden sm:inline">Sent orders:</span>
              <span className="font-bold">{sentOrders.length}</span>
            </button>
            {/* Employee chip — who's currently on this register. Click to
                switch without re-typing the staff password. The name is
                attached to every void this device records. */}
            {employee && (
              <div
                className="hidden sm:flex items-center gap-1.5 pl-2.5 pr-1 py-1 rounded-lg bg-secondary text-xs font-semibold border border-border"
                data-testid="chip-employee"
              >
                <span className="text-muted-foreground">On register:</span>
                <span className="text-foreground" data-testid="text-employee-name">{employee}</span>
                <button
                  type="button"
                  onClick={() => setShowEmployeeSwitch(true)}
                  className="ml-1 p-1 rounded text-muted-foreground hover:text-foreground hover:bg-background transition-colors"
                  title="Switch employee"
                  data-testid="button-switch-employee"
                >
                  <Pencil className="w-3.5 h-3.5" />
                </button>
              </div>
            )}
            <ThemeToggle />
            {password && (
              <button
                type="button"
                disabled={savingOrder}
                onClick={() => {
                  if (!arrangeMode) {
                    setArrangeMode(true);
                  } else {
                    // Sync menu to slot order so normal view reflects the layout.
                    const itemById = new Map((menu ?? []).map(m => [m.id, m]));
                    const ordered = arrangeGrid
                      .filter((id): id is number => id !== null)
                      .map(id => itemById.get(id))
                      .filter((m): m is MenuItem => m !== undefined);
                    setMenu(ordered);
                    setArrangeMode(false);
                  }
                }}
                className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-semibold border transition-colors disabled:opacity-50 disabled:cursor-wait ${
                  arrangeMode
                    ? "bg-indigo-600 text-white border-indigo-600 hover:bg-indigo-700"
                    : "bg-secondary text-muted-foreground border-transparent hover:text-foreground"
                }`}
                title={arrangeMode ? "Exit arrange mode" : "Arrange menu order"}
              >
                <Layers className="w-4 h-4" />
                <span className="hidden sm:inline">{arrangeMode ? "Done" : "Arrange"}</span>
              </button>
            )}
            <button
              type="button"
              onClick={async () => {
                if (!password) return;
                try {
                  const res = await fetch(`${BASE}/api/event-taker/open-cash-drawer`, {
                    method: "POST",
                    headers: { Authorization: `Bearer ${password}` },
                  });
                  const data = await res.json() as { ok?: boolean; jobsEnqueued?: number; error?: string };
                  if (!res.ok) throw new Error(data.error ?? "Failed");
                  if ((data.jobsEnqueued ?? 0) > 0) {
                    toast.success("Cash drawer opened");
                  }
                } catch {
                  toast.error("Failed to open cash drawer");
                }
              }}
              className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-semibold bg-secondary border-transparent transition-colors ${
                hasCashDrawer === false
                  ? "text-muted-foreground/40 cursor-default"
                  : "text-muted-foreground hover:text-foreground"
              }`}
              title={hasCashDrawer === false ? "No cash drawer configured" : "Open cash drawer"}
            >
              <DollarSign className="w-4 h-4" />
              <span className="hidden sm:inline">Open Drawer</span>
            </button>
            <button
              type="button"
              onClick={() => setPrinterModalOpen(true)}
              className="p-2 text-muted-foreground hover:text-foreground rounded-lg hover:bg-secondary transition-colors"
              title="Printer settings (synced with admin)"
              data-testid="button-printer-settings"
            >
              <Printer className="w-5 h-5" />
            </button>
            <button
              onClick={handleLogout}
              className="p-2 text-muted-foreground hover:text-foreground rounded-lg hover:bg-secondary transition-colors"
              title="Sign out"
            >
              <LogOut className="w-5 h-5" />
            </button>
          </div>
        </div>
      </header>

      <div className="max-w-7xl mx-auto p-4 grid grid-cols-1 lg:grid-cols-[1fr_380px] gap-4">
        {/* Menu */}
        <section>
          {menuError && (
            <div className="bg-destructive/10 text-destructive border border-destructive/20 rounded-xl p-4 mb-4 text-sm">{menuError}</div>
          )}
          {!menu && (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
            </div>
          )}
          {menu && menu.length === 0 && (
            <div className="bg-card border border-border rounded-2xl p-12 text-center text-muted-foreground">
              <p className="font-semibold">No items available on the staff order taker.</p>
              <p className="text-sm mt-2">Toggle items on in Menu Manager → "Taker" column.</p>
            </div>
          )}
          {/* Arrange mode — fixed-slot grid with empty cells */}
          {menu && menu.length > 0 && arrangeMode && (
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragStart={({ active }) => setActiveItemId(active.id as number)}
              onDragEnd={handleDragEnd}
              onDragCancel={() => setActiveItemId(null)}
            >
              <div className="mb-4 flex items-center justify-between px-1 gap-3">
                <p className="text-sm text-muted-foreground">
                  Drag cards into any position. Empty cells are placeholders — drag items there to leave gaps.
                  {savingOrder && <span className="ml-2 text-indigo-500">Saving…</span>}
                </p>
                <button
                  type="button"
                  onClick={handleResetOrder}
                  disabled={savingOrder}
                  className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  Reset order
                </button>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                {arrangeGrid.map((slotId, i) => {
                  if (slotId === null) {
                    return <ArrangeEmptySlot key={`e-${i}`} slotIndex={i} />;
                  }
                  const item = menu.find(m => m.id === slotId);
                  if (!item) return <ArrangeEmptySlot key={`e-${i}`} slotIndex={i} />;
                  return (
                    <DraggableItemCard
                      key={slotId}
                      item={item}
                      slotIndex={i}
                      isBeingDragged={activeItemId === slotId}
                    />
                  );
                })}
              </div>
              <DragOverlay dropAnimation={null}>
                {activeItemId !== null && (() => {
                  const item = menu.find(m => m.id === activeItemId);
                  return item ? <ArrangeCardOverlay item={item} /> : null;
                })()}
              </DragOverlay>
            </DndContext>
          )}

          {/* Normal mode: flat slot-ordered grid when a custom layout exists,
              otherwise the regular alphabetical categorised view. */}
          {menu && menu.length > 0 && !arrangeMode && (
            slotLayout.length > 0 ? [""] : categories
          ).map(cat => (
            <div key={cat} className={cat ? "mb-6" : undefined}>
              {cat && <h2 className="font-display font-bold text-lg mb-2 px-1">{cat}</h2>}
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                {(cat
                  ? menu.filter(m => m.category === cat)
                  : arrangeGrid.map(id => id === null ? null : (menu.find(m => m.id === id) ?? null))
                ).map((item, idx) => {
                  if (item === null) return <div key={`gap-${idx}`} />;
                  const stock = item.eventStock;
                  const outOfStock = stock !== null && stock <= 0;
                  // Mirror the Guest Event page's "low stock" treatment so
                  // staff get the same amber-warning at-a-glance signal when
                  // an item is close to running out.
                  const lowStock = stock !== null && stock > 0 && stock <= 5;
                  const inCart = cart.some(l => l.itemId === item.id);
                  const cartQty = cart.filter(l => l.itemId === item.id).reduce((s, l) => s + l.quantity, 0);
                  // True once the cart already holds every remaining unit —
                  // taps and the +/- "+" should stop adding (server would 409
                  // otherwise, but blocking client-side gives instant feedback).
                  const atMax = stock !== null && cartQty >= stock;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      disabled={outOfStock}
                      onClick={() => addToCart(item)}
                      data-testid={`taker-item-${item.id}`}
                      className={`relative bg-card border rounded-2xl overflow-hidden text-left transition-all ${
                        outOfStock
                          ? "opacity-50 cursor-not-allowed border-border"
                          : inCart
                            ? "border-indigo-500 ring-2 ring-indigo-500/20 hover:shadow-md"
                            : "border-border hover:border-indigo-400 hover:shadow-md active:scale-[0.98]"
                      }`}
                    >
                      {item.imageUrl && (
                        <div className="aspect-[4/3] bg-secondary">
                          <img src={item.imageUrl} alt="" className="w-full h-full object-cover" />
                        </div>
                      )}
                      <div className="p-3">
                        <p className="font-semibold text-sm leading-tight">{item.name}</p>
                        {item.isCombo && (
                          <span className="inline-block text-[9px] font-bold uppercase tracking-wider bg-violet-100 dark:bg-violet-900/40 text-violet-600 dark:text-violet-400 px-1.5 py-0.5 rounded-full mt-0.5">Combo</span>
                        )}
                        <div className="flex items-end justify-between mt-1.5 gap-2">
                          <span className="font-bold text-base text-indigo-600">${item.effectivePrice.toFixed(2)}</span>
                          {stock !== null && (
                            outOfStock ? (
                              <span className="text-[10px] font-bold uppercase tracking-wider text-destructive">
                                Out
                              </span>
                            ) : lowStock ? (
                              <span
                                className="text-[10px] font-bold bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-400 px-1.5 py-0.5 rounded-full uppercase tracking-wider"
                                data-testid={`stock-badge-${item.id}`}
                              >
                                {stock} left
                              </span>
                            ) : (
                              <span
                                className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground"
                                data-testid={`stock-badge-${item.id}`}
                              >
                                {stock} left
                              </span>
                            )
                          )}
                        </div>
                      </div>
                      {outOfStock && (
                        <div className="absolute inset-0 bg-foreground/5 flex items-center justify-center">
                          <span className="bg-destructive text-destructive-foreground text-xs font-bold uppercase tracking-wider px-3 py-1 rounded-full">Sold out</span>
                        </div>
                      )}
                      {/* Pill +/- overlay for non-combo items only */}
                      {inCart && !outOfStock && !item.isCombo && (
                        <div
                          className="absolute top-2 right-2 flex items-center gap-1 bg-indigo-600 text-white rounded-full pl-1 pr-1 py-0.5 shadow-md"
                          onClick={e => e.stopPropagation()}
                        >
                          <span
                            role="button"
                            tabIndex={0}
                            onClick={e => { e.stopPropagation(); changeQty(item.id, -1); }}
                            className="w-6 h-6 rounded-full hover:bg-indigo-700 flex items-center justify-center cursor-pointer"
                          >
                            <Minus className="w-3 h-3" />
                          </span>
                          <span className="text-xs font-bold min-w-[16px] text-center">{cartQty}</span>
                          <span
                            role="button"
                            tabIndex={0}
                            aria-disabled={atMax}
                            onClick={e => {
                              e.stopPropagation();
                              if (atMax) {
                                flashStockWarning(`Only ${stock} of ${item.name} left.`);
                                return;
                              }
                              changeQty(item.id, 1);
                            }}
                            className={`w-6 h-6 rounded-full flex items-center justify-center ${
                              atMax ? "opacity-40 cursor-not-allowed" : "hover:bg-indigo-700 cursor-pointer"
                            }`}
                          >
                            <Plus className="w-3 h-3" />
                          </span>
                        </div>
                      )}
                      {/* For combo items in cart: show count badge only */}
                      {inCart && !outOfStock && item.isCombo && (
                        <div className="absolute top-2 right-2 bg-indigo-600 text-white rounded-full px-2 py-0.5 text-xs font-bold shadow-md pointer-events-none">
                          ×{cartQty}
                        </div>
                      )}
                      {inCart && !item.isCombo && (
                        <div className="px-3 pb-2 -mt-1 text-[11px] text-indigo-700 font-semibold">
                          Line: ${(item.effectivePrice * cartQty).toFixed(2)}
                        </div>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </section>

        {/* Cart */}
        <aside className="lg:sticky lg:top-[68px] lg:self-start lg:max-h-[calc(100vh-84px)] flex flex-col bg-card border border-border rounded-2xl shadow-sm">
          <div className="px-5 py-4 border-b border-border flex items-center gap-2">
            <Receipt className="w-5 h-5 text-indigo-600" />
            <h2 className="font-display font-bold text-lg">Current Order</h2>
            <span className="ml-auto text-xs text-muted-foreground">{cart.reduce((s, l) => s + l.quantity, 0)} item(s)</span>
          </div>

          {stockWarning && (
            <div
              className="mx-5 mt-3 px-3 py-2 rounded-xl border border-amber-200 dark:border-amber-800/50 bg-amber-50 dark:bg-amber-950/40 text-amber-800 dark:text-amber-300 text-xs flex items-start gap-1.5"
              data-testid="taker-stock-warning"
              role="status"
            >
              <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <span>{stockWarning}</span>
            </div>
          )}

          <div className="flex-1 overflow-y-auto px-5 py-3 space-y-2">
            {cart.length === 0 && (
              <p className="text-sm text-muted-foreground text-center py-10">Tap items on the left to start an order.</p>
            )}
            {cart.map(line => {
              const stock = menu?.find(m => m.id === line.itemId)?.eventStock ?? null;
              const atMax = stock !== null && line.quantity >= stock;
              return (
                <div key={line.comboKey ?? String(line.itemId)} className="flex items-center gap-2 py-2 border-b border-border/40 last:border-0">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold truncate">{line.name}{line.comboKey && <span className="ml-1 text-[10px] font-normal bg-indigo-100 dark:bg-indigo-900/40 text-indigo-600 dark:text-indigo-400 px-1.5 py-0.5 rounded-full">combo</span>}</p>
                    {line.comboSelections && line.comboSelections.length > 0 && (
                      <div className="mt-0.5 space-y-0.5">
                        {line.comboSelections.map((sel, i) => (
                          <p key={i} className="text-[11px] text-muted-foreground pl-1.5 border-l-2 border-indigo-200 dark:border-indigo-800">{sel.name} ×{sel.quantity}</p>
                        ))}
                      </div>
                    )}
                    <p className="text-xs text-muted-foreground mt-0.5">${line.unitPrice.toFixed(2)} × {line.quantity} = ${(line.unitPrice * line.quantity).toFixed(2)}</p>
                    {atMax && (
                      <p className="text-[11px] text-amber-700 dark:text-amber-400 font-semibold mt-0.5">All {stock} remaining in cart</p>
                    )}
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button onClick={() => changeQty(line.itemId, -1, line.comboKey)} className="w-7 h-7 rounded-md bg-secondary hover:bg-secondary/70 flex items-center justify-center"><Minus className="w-3.5 h-3.5" /></button>
                    <span className="w-6 text-center font-semibold text-sm">{line.quantity}</span>
                    <button
                      onClick={() => changeQty(line.itemId, 1, line.comboKey)}
                      disabled={atMax}
                      title={atMax ? `Only ${stock} left in stock` : undefined}
                      className="w-7 h-7 rounded-md bg-secondary hover:bg-secondary/70 flex items-center justify-center disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-secondary"
                    >
                      <Plus className="w-3.5 h-3.5" />
                    </button>
                    <button onClick={() => removeLine(line.itemId, line.comboKey)} className="w-7 h-7 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 flex items-center justify-center ml-1"><Trash2 className="w-3.5 h-3.5" /></button>
                  </div>
                </div>
              );
            })}
          </div>

          {cart.length > 0 && (
            <form onSubmit={submitOrder} className="px-5 py-4 border-t border-border space-y-3 bg-secondary/20 rounded-b-2xl">
              <div className="space-y-1.5 text-sm">
                <div className="flex justify-between"><span className="text-muted-foreground">Subtotal</span><span className="font-semibold">${subtotal.toFixed(2)}</span></div>
                {settings?.taxEnabled && taxRate > 0 && (
                  <div className="flex justify-between"><span className="text-muted-foreground">Tax ({taxRate.toFixed(2)}%)</span><span className="font-semibold">${taxAmount.toFixed(2)}</span></div>
                )}
                <div className="flex justify-between text-base pt-1 border-t border-border/60 mt-1.5"><span className="font-bold">Total</span><span className="font-bold text-indigo-600">${total.toFixed(2)}</span></div>
                <p className="text-xs text-muted-foreground">{taxRate > 0 ? TAX_INCLUDED_NOTE : TAX_DISCLOSURE}</p>
              </div>
              <input
                value={guestName}
                onChange={e => setGuestName(e.target.value)}
                required
                placeholder="Customer name"
                className="w-full px-3 py-2 border border-border rounded-lg bg-background text-sm"
              />
              <input
                value={phone}
                onChange={e => setPhone(e.target.value)}
                type="tel"
                placeholder="Phone (optional — for SMS)"
                className="w-full px-3 py-2 border border-border rounded-lg bg-background text-sm"
              />
              {settings?.staffNotesEnabled && (
                <textarea
                  value={orderNotes}
                  onChange={e => setOrderNotes(e.target.value)}
                  placeholder="Order notes (optional)"
                  rows={2}
                  maxLength={500}
                  className="w-full px-3 py-2 border border-border rounded-lg bg-background text-sm resize-none"
                />
              )}
              {settings?.orderingState && settings.orderingState !== "accepting" && (
                <div className={`rounded-xl border p-3 text-sm ${settings.orderingState === "paused" ? "bg-amber-50 dark:bg-amber-950/40 border-amber-200 dark:border-amber-800/50 text-amber-900 dark:text-amber-200" : "bg-rose-50 dark:bg-rose-950/40 border-rose-200 dark:border-rose-800/50 text-rose-900 dark:text-rose-200"}`}>
                  <p className="font-bold">
                    {settings.orderingState === "paused"
                      ? `Kitchen paused order taking — back in ${formatTakerBannerTime(settings.orderingPausedUntil ?? null, tickNow)}`
                      : "Kitchen has stopped order taking."}
                  </p>
                  <p className="text-xs mt-0.5 opacity-80">
                    {settings.orderingState === "paused" && settings.orderingPausedMessage
                      ? settings.orderingPausedMessage
                      : "New orders cannot be charged until this clears."}
                  </p>
                </div>
              )}
              {submitError && (
                <p className="text-sm text-destructive flex items-start gap-1.5"><AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />{submitError}</p>
              )}
              <button
                type="submit"
                disabled={submitting || !guestName.trim() || (settings?.orderingState != null && settings.orderingState !== "accepting")}
                className="w-full px-5 py-3 bg-indigo-600 text-white font-bold rounded-xl hover:bg-indigo-700 transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <DollarSign className="w-4 h-4" />}
                {settings?.orderingState === "paused"
                  ? "Order taking paused"
                  : settings?.orderingState === "closed"
                    ? "Order taking stopped"
                    : `Charge $${total.toFixed(2)}`}
              </button>
            </form>
          )}
        </aside>
      </div>

      {paymentOrder && password && (
        <PaymentModal
          order={paymentOrder}
          password={password}
          venmoHandle={settings?.venmoHandle ?? null}
          venmoQrImageUrl={settings?.venmoQrImageUrl ?? null}
          terminalEnabled={!!(settings?.terminalEnabled)}
          onHold={() => { setPaymentOrder(null); if (password) loadPending(password); }}
          onCancel={() => handleCancelOrder(paymentOrder.id)}
          onEdit={() => handleEditOrder(paymentOrder)}
          onComplete={handlePaymentComplete}
          onPlatingChanged={(plateGroups) => {
            // Keep the in-memory payment order + pending queue in sync so the
            // badge shows the right state if the cashier holds and reopens
            // before the next pending poll lands.
            setPaymentOrder(prev => (prev ? { ...prev, plateGroups } : prev));
            setPendingOrders(prev => prev.map(o => (
              o.id === paymentOrder.id ? { ...o, plateGroups } : o
            )));
          }}
        />
      )}

      {showPendingPanel && (
        <PendingPanel
          orders={pendingOrders}
          onClose={() => setShowPendingPanel(false)}
          onResume={(o) => { setShowPendingPanel(false); setPaymentOrder(o); }}
          onCancel={(id) => handleCancelOrder(id)}
          onOverride={(o, reason) => handleOverrideFromPanel(o, reason)}
          onVoid={(o) => setVoidTarget(o)}
        />
      )}

      {showSentPanel && (
        <SentOrdersPanel
          orders={sentOrders}
          recentVoids={recentVoids}
          employee={employee}
          onClose={() => setShowSentPanel(false)}
          onVoid={(o) => setVoidTarget(o)}
        />
      )}

      {voidTarget && (
        <VoidModal
          order={voidTarget}
          defaultVoidedBy={employee ?? ""}
          onClose={() => setVoidTarget(null)}
          onConfirm={async (reason, voidedBy) => {
            const result = await handleVoidConfirmed(voidTarget, reason, voidedBy);
            if (result.ok) {
              // The cashier can self-correct an empty/wrong header chip
              // right inside the void modal — persist whatever they used so
              // subsequent voids on this device are pre-filled.
              const trimmed = voidedBy.trim();
              if (trimmed && trimmed !== employee) {
                setStoredEmployee(trimmed);
                setEmployee(trimmed);
              }
              setVoidTarget(null);
            }
            return result;
          }}
        />
      )}
    </div>
  );
}

// ── Print status row ───────────────────────────────────────────────────
// One row per ticket on the confirmation screen showing whether the
// auto-print actually fired. Tappable when the print didn't go through so
// staff can retry without leaving the order.
function PrintStatusRow({
  label, icon, status, onRetry,
}: {
  label: string;
  icon: React.ReactNode;
  status: "idle" | "printing" | "printed" | "canceled" | "blocked";
  onRetry: () => void;
}) {
  const failed = status === "canceled" || status === "blocked";
  const tone =
    status === "printed" ? "bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-400 border-emerald-200 dark:border-emerald-800/50"
    : status === "printing" ? "bg-sky-50 dark:bg-sky-950/40 text-sky-700 dark:text-sky-400 border-sky-200 dark:border-sky-800/50"
    : "bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-400 border-rose-200 dark:border-rose-800/50"; // canceled / blocked
  const message =
    status === "printed" ? "Sent to printer"
    : status === "printing" ? "Sending to printer…"
    : status === "canceled" ? "Print canceled — tap to retry"
    : "Print failed — tap to retry"; // blocked

  const content = (
    <div className={`flex items-center justify-between gap-2 px-3 py-2 rounded-xl border text-xs font-medium ${tone}`}>
      <span className="flex items-center gap-1.5">
        {icon}
        <span>{label}</span>
      </span>
      <span className="flex items-center gap-1.5">
        {status === "printed" && <PrinterCheck className="w-4 h-4" />}
        {status === "printing" && <Loader2 className="w-4 h-4 animate-spin" />}
        {failed && <AlertTriangle className="w-4 h-4" />}
        <span>{message}</span>
      </span>
    </div>
  );

  if (failed) {
    return (
      <button
        type="button"
        onClick={onRetry}
        className="w-full text-left hover:opacity-90 active:opacity-80"
        data-testid={`retry-print-${label.toLowerCase().replace(/\s+/g, "-")}`}
      >
        {content}
      </button>
    );
  }
  return content;
}

// ── Payment confirmation modal ─────────────────────────────────────────
// Renders the method picker (cash/card/venmo) and the per-method screen.
// Each per-method screen has Back to method picker, plus the method's
// confirm action. "Hold for later" leaves the order in the pending queue.
function PaymentModal({
  order, password, venmoHandle, venmoQrImageUrl, terminalEnabled,
  onHold, onCancel, onEdit, onComplete, onPlatingChanged,
}: {
  order: PendingOrder;
  password: string;
  venmoHandle: string | null;
  venmoQrImageUrl: string | null;
  terminalEnabled?: boolean;
  onHold: () => void;
  onCancel: () => void;
  onEdit: () => void;
  onComplete: (updated: PendingOrder) => void;
  onPlatingChanged?: (plateGroups: PlateGroup[] | null) => void;
}) {
  // Once the order is in override the kitchen has already seen + started
  // it, so editing it would mean re-ringing items that may already be on
  // the line. We disable Edit Order in that case (and the in-modal override
  // option, since you can't override what's already overridden).
  const isOverride = order.paymentStatus === "override";
  const [step, setStep] = useState<"method" | "cash" | "card" | "terminal" | "venmo">("method");
  const [cashStr, setCashStr] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [overrideOpen, setOverrideOpen] = useState(false);
  const [overrideReason, setOverrideReason] = useState("");
  // Terminal checkout state — only used when step === "terminal"
  const [terminalCheckoutId, setTerminalCheckoutId] = useState<string | null>(null);
  const [terminalPhase, setTerminalPhase] = useState<"creating" | "waiting" | "canceling" | "done">("creating");
  const [terminalError, setTerminalError] = useState<string | null>(null);
  // Plating layout — locally tracks the latest server-confirmed plates and
  // controls the opt-in plating modal. Defaults to whatever the order row
  // carries (re-opening a held order keeps the prior layout).
  const [plates, setPlates] = useState<PlateGroup[] | null>(order.plateGroups ?? null);
  const [showPlating, setShowPlating] = useState(false);
  // Shortcut: jump back to the method picker and immediately reveal the
  // override form. Exposed on every method step to match the spec.
  function gotoOverride() { setStep("method"); setOverrideOpen(true); setError(""); }

  const total = order.total ?? 0;
  const cashNum = Number(cashStr);
  const change = Number.isFinite(cashNum) ? Math.round((cashNum - total) * 100) / 100 : 0;
  const cashOk = Number.isFinite(cashNum) && cashNum >= total;

  async function confirm(method: PaymentMethod, overrideCashReceived?: number) {
    setSubmitting(true);
    setError("");
    try {
      const body: Record<string, unknown> = { method, statusUrlBase: window.location.origin + BASE };
      if (method === "cash") body.cashReceived = overrideCashReceived ?? cashNum;
      const res = await fetch(`${BASE}/api/event-taker/orders/${order.id}/payment`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${password}` },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setError(err.error ?? "Failed to record payment");
        return;
      }
      const data = await res.json();
      onComplete({ ...order, ...data });
    } catch {
      setError("Could not reach the server");
    } finally {
      setSubmitting(false);
    }
  }

  async function sendOverride() {
    setSubmitting(true);
    setError("");
    try {
      const res = await fetch(`${BASE}/api/event-taker/orders/${order.id}/override`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${password}` },
        body: JSON.stringify({
          reason: overrideReason.trim() || null,
          statusUrlBase: window.location.origin + BASE,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setError(err.error ?? "Failed to override");
        return;
      }
      const data = await res.json();
      onComplete({ ...order, ...data });
    } catch {
      setError("Could not reach the server");
    } finally {
      setSubmitting(false);
    }
  }

  // Auto-create a Square Terminal checkout and poll for completion.
  // Only active while step === "terminal".
  useEffect(() => {
    if (step !== "terminal") return;
    let cancelled = false;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    const headers = { "Content-Type": "application/json", Authorization: `Bearer ${password}` };

    async function createCheckout() {
      setTerminalPhase("creating");
      setTerminalError(null);
      try {
        const res = await fetch(`${BASE}/api/event-taker/terminal-checkout`, {
          method: "POST",
          headers,
          body: JSON.stringify({ orderId: order.id }),
        });
        const data = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok) {
          setTerminalError(data.error ?? "Failed to start Terminal checkout");
          return;
        }
        const checkoutId = data.checkoutId as string;
        setTerminalCheckoutId(checkoutId);
        setTerminalPhase("waiting");
        schedulePoll(checkoutId);
      } catch {
        if (!cancelled) setTerminalError("Could not reach the server");
      }
    }

    async function pollStatus(checkoutId: string) {
      try {
        const res = await fetch(`${BASE}/api/event-taker/terminal-checkout/${encodeURIComponent(checkoutId)}`, { headers });
        const data = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok) { setTerminalError(data.error ?? "Error checking terminal status"); return; }
        const status: string = data.status;
        if (status === "COMPLETED") {
          await confirm("card");
        } else if (status === "CANCELED" || status === "CANCEL_REQUESTED") {
          setTerminalError("Payment was canceled on the device.");
        } else {
          schedulePoll(checkoutId);
        }
      } catch {
        if (!cancelled) schedulePoll(checkoutId);
      }
    }

    function schedulePoll(checkoutId: string) {
      pollTimer = setTimeout(() => { if (!cancelled) pollStatus(checkoutId); }, 1500);
    }

    createCheckout();
    return () => {
      cancelled = true;
      if (pollTimer) clearTimeout(pollTimer);
    };
  }, [step]); // eslint-disable-line react-hooks/exhaustive-deps

  // Quick-cash buttons rounded up from the total
  const quickCash = useMemo(() => {
    const t = Math.max(0, total);
    const exact = Math.round(t * 100) / 100;
    const next5 = Math.ceil(t / 5) * 5;
    const next10 = Math.ceil(t / 10) * 10;
    const next20 = Math.ceil(t / 20) * 20;
    return Array.from(new Set([exact, next5, next10, next20])).slice(0, 4);
  }, [total]);

  return (
    <>
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4 bg-foreground/40 backdrop-blur-sm print:hidden">
      <div className="bg-card border border-border rounded-3xl shadow-2xl w-full max-w-md overflow-hidden">
        <div className="px-6 py-4 border-b border-border bg-secondary/30 flex items-start justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-wider text-muted-foreground font-semibold">Order #{order.id}</p>
            <h2 className="font-display font-bold text-xl mt-0.5">{order.guestName}</h2>
            <p className="text-xs text-muted-foreground mt-0.5">{order.items.reduce((s, i) => s + i.quantity, 0)} item(s) · ${total.toFixed(2)}</p>
          </div>
          {isOverride ? (
            // Once fired to the kitchen, editing the cart would mean
            // re-ringing items already on the line. Show the disabled
            // affordance with a clear explanation.
            <button
              type="button"
              disabled
              className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-semibold rounded-lg border border-border bg-secondary text-muted-foreground cursor-not-allowed"
              title="The kitchen has already seen this order — edit it by canceling and re-ringing instead."
              data-testid="button-edit-order"
            >
              <Pencil className="w-3.5 h-3.5" />
              Edit order not available
            </button>
          ) : (
            <button
              type="button"
              onClick={onEdit}
              className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-semibold rounded-lg border border-border hover:bg-secondary"
              title="Back out and reload the cart so you can adjust items before sending"
              data-testid="button-edit-order"
            >
              <Pencil className="w-3.5 h-3.5" />
              Edit Order
            </button>
          )}
        </div>

        {step === "method" && (
          <div className="p-6 space-y-3">
            <p className="text-center text-3xl font-display font-bold">${total.toFixed(2)}</p>
            <p className="text-center text-sm text-muted-foreground">Choose payment method</p>
            {/* Opt-in plating: lets staff split this cart into N plates so the
                kitchen sees plate cards instead of one flat list. Locks once
                the order is sent. */}
            <button
              type="button"
              onClick={() => setShowPlating(true)}
              className={`w-full flex items-center justify-between gap-2 px-3 py-2 rounded-xl border text-sm font-semibold transition-colors ${
                plates && plates.length > 0
                  ? "border-violet-300 bg-violet-50 text-violet-800 hover:bg-violet-100"
                  : "border-border text-foreground/80 hover:bg-secondary"
              }`}
              data-testid="button-open-plating"
            >
              <span className="flex items-center gap-2">
                <Layers className="w-4 h-4" />
                Plating
              </span>
              <span className="text-xs font-medium">
                {plates && plates.length > 0
                  ? `${plates.length} plate${plates.length === 1 ? "" : "s"}`
                  : "1 plate (default)"}
              </span>
            </button>
            <div className="grid gap-2.5 mt-4">
              <button
                onClick={() => {
                  if (total === 0) {
                    confirm("cash", 0);
                  } else {
                    setStep("cash"); setCashStr(total.toFixed(2)); setError("");
                  }
                }}
                disabled={submitting}
                className="flex items-center gap-3 px-4 py-4 border border-border rounded-2xl hover:border-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-950/20 transition-colors disabled:opacity-50"
              >
                {submitting ? <Loader2 className="w-6 h-6 text-emerald-600 animate-spin" /> : <DollarSign className="w-6 h-6 text-emerald-600" />}
                <span className="font-bold text-lg">Cash</span>
                <span className="ml-auto text-xs text-muted-foreground">{total === 0 ? "Complete now" : "Calculate change"}</span>
              </button>
              <button
                onClick={() => {
                  if (terminalEnabled) {
                    setTerminalCheckoutId(null);
                    setTerminalPhase("creating");
                    setTerminalError(null);
                    setStep("terminal");
                  } else {
                    setStep("card");
                  }
                  setError("");
                }}
                className="flex items-center gap-3 px-4 py-4 border border-border rounded-2xl hover:border-indigo-400 hover:bg-indigo-50 dark:hover:bg-indigo-950/20 transition-colors"
              >
                <CreditCard className="w-6 h-6 text-indigo-600" />
                <span className="font-bold text-lg">Credit Card</span>
                <span className="ml-auto text-xs text-muted-foreground">
                  {terminalEnabled ? "Auto-charge terminal" : "Process on terminal"}
                </span>
              </button>
              {(() => {
                const venmoConfigured = !!(venmoHandle || venmoQrImageUrl);
                return (
                  <button
                    onClick={() => venmoConfigured && (setStep("venmo"), setError(""))}
                    disabled={!venmoConfigured}
                    title={venmoConfigured ? undefined : "Set the Venmo handle / QR in Admin → Event Settings"}
                    className={`flex items-center gap-3 px-4 py-4 border border-border rounded-2xl transition-colors ${
                      venmoConfigured
                        ? "hover:border-sky-400 hover:bg-sky-50 dark:hover:bg-sky-950/20"
                        : "opacity-50 cursor-not-allowed"
                    }`}
                  >
                    <Smartphone className="w-6 h-6 text-sky-600" />
                    <span className="font-bold text-lg">Venmo</span>
                    <span className="ml-auto text-xs text-muted-foreground">
                      {venmoConfigured ? "Show QR / handle" : "Not configured"}
                    </span>
                  </button>
                );
              })()}
            </div>

            <div className="pt-4 mt-2 border-t border-border space-y-2.5">
              <button
                onClick={onHold}
                className="w-full px-4 py-2.5 text-sm font-semibold border border-border rounded-xl hover:bg-secondary"
              >
                Hold for later
              </button>
              {isOverride ? (
                // Already overridden — fold into a status note instead of
                // re-offering the override action.
                <div className="bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800/50 rounded-xl p-3 text-xs text-amber-800 dark:text-amber-300 flex items-start gap-2">
                  <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                  <p>
                    Already sent to kitchen unpaid. Recording payment will close the tab without re-firing the order or re-texting the customer.
                  </p>
                </div>
              ) : !overrideOpen ? (
                <button
                  onClick={() => setOverrideOpen(true)}
                  className="w-full text-xs text-muted-foreground hover:text-amber-700 underline"
                >
                  Override — send to kitchen unpaid
                </button>
              ) : (
                <div className="bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900/40 rounded-xl p-3 space-y-2">
                  <div className="flex items-start gap-2 text-amber-800 dark:text-amber-300">
                    <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                    <p className="text-xs">This will send the order to the kitchen <strong>without</strong> recording payment. Use only when you've verified payment by other means.</p>
                  </div>
                  <input
                    value={overrideReason}
                    onChange={e => setOverrideReason(e.target.value)}
                    placeholder="Reason (optional)"
                    className="w-full px-3 py-2 text-sm border border-amber-300 dark:border-amber-800 rounded-lg bg-white dark:bg-amber-950/50 text-foreground placeholder:text-muted-foreground"
                  />
                  <div className="flex gap-2">
                    <button
                      onClick={() => { setOverrideOpen(false); setOverrideReason(""); }}
                      className="flex-1 px-3 py-2 text-sm font-semibold border border-border rounded-lg hover:bg-white dark:hover:bg-white/10"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={sendOverride}
                      disabled={submitting}
                      className="flex-1 px-3 py-2 text-sm font-bold bg-amber-600 text-white rounded-lg hover:bg-amber-700 disabled:opacity-50 flex items-center justify-center gap-1.5"
                    >
                      {submitting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
                      Send unpaid
                    </button>
                  </div>
                </div>
              )}
              {!isOverride && (
                // Override orders have already left the kitchen — server
                // refuses DELETE on them, so hide the option entirely to
                // avoid a confusing error toast.
                <button
                  onClick={onCancel}
                  className="w-full text-xs text-destructive hover:underline"
                >
                  Cancel order (restore stock)
                </button>
              )}
            </div>

            {error && <p className="text-sm text-destructive flex items-center gap-1.5"><AlertCircle className="w-4 h-4" />{error}</p>}
          </div>
        )}

        {step === "cash" && (
          <div className="p-6 space-y-4">
            <button onClick={() => { setStep("method"); setError(""); }} className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
              <ArrowLeft className="w-4 h-4" /> Back
            </button>
            <div className="text-center">
              <p className="text-xs uppercase tracking-wider text-muted-foreground">Total Due</p>
              <p className="text-3xl font-display font-bold text-emerald-600 dark:text-emerald-400">${total.toFixed(2)}</p>
              <p className="text-xs text-muted-foreground mt-1">{(order.taxRate ?? 0) > 0 ? TAX_INCLUDED_NOTE : TAX_DISCLOSURE}</p>
            </div>
            <div>
              <label className="block text-sm font-semibold mb-1.5">Cash received</label>
              {/* Amount display */}
              <div className="flex items-center gap-1 px-4 py-3 border border-border rounded-xl bg-background mb-3 min-h-[3.5rem]">
                <span className="text-2xl font-bold text-muted-foreground">$</span>
                <span className="text-2xl font-bold flex-1 tabular-nums">{cashStr || "0"}</span>
              </div>
              {/* Quick-cash presets */}
              <div className="flex flex-wrap gap-2 mb-3">
                {quickCash.map(v => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => setCashStr(v.toFixed(2))}
                    className="px-3 py-1.5 text-sm font-semibold border border-border rounded-lg hover:bg-secondary"
                  >
                    ${v.toFixed(2)}
                  </button>
                ))}
              </div>
              {/* Custom numpad */}
              <div className="grid grid-cols-3 gap-2">
                {(["1","2","3","4","5","6","7","8","9",".","0","⌫"] as const).map(key => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => {
                      if (key === "⌫") {
                        setCashStr(s => s.slice(0, -1));
                      } else if (key === ".") {
                        setCashStr(s => (s.includes(".") ? s : s + "."));
                      } else {
                        setCashStr(s => {
                          const dotIdx = s.indexOf(".");
                          if (dotIdx !== -1 && s.length - dotIdx > 2) return s;
                          if (s === "0") return key;
                          return s + key;
                        });
                      }
                    }}
                    className="py-4 text-xl font-bold border border-border rounded-xl hover:bg-secondary active:scale-95 transition-all select-none"
                  >
                    {key}
                  </button>
                ))}
              </div>
            </div>
            <div className="bg-secondary/40 rounded-xl p-3 text-sm">
              <div className="flex justify-between"><span>Change due</span>
                <span className={`font-bold text-lg ${cashOk ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground"}`}>
                  ${cashOk ? change.toFixed(2) : "—"}
                </span>
              </div>
              {!cashOk && cashStr !== "" && (
                <p className="text-xs text-amber-700 dark:text-amber-400 mt-1">Need at least ${total.toFixed(2)}</p>
              )}
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <button
              onClick={() => confirm("cash")}
              disabled={!cashOk || submitting}
              className="w-full px-5 py-3 bg-emerald-600 text-white font-bold rounded-xl hover:bg-emerald-700 disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
              Confirm cash payment
            </button>
            {!isOverride && (
              <button onClick={gotoOverride} className="w-full text-xs text-muted-foreground hover:text-amber-700 underline">
                Override — send to kitchen unpaid
              </button>
            )}
          </div>
        )}

        {step === "card" && (
          <div className="p-6 space-y-4">
            <button onClick={() => { setStep("method"); setError(""); }} className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
              <ArrowLeft className="w-4 h-4" /> Back
            </button>
            <div className="text-center">
              <p className="text-xs uppercase tracking-wider text-muted-foreground">Charge on terminal</p>
              <p className="text-3xl font-display font-bold text-indigo-600">${total.toFixed(2)}</p>
            </div>
            <div className="bg-indigo-50 dark:bg-indigo-950/40 border border-indigo-200 dark:border-indigo-800/50 rounded-xl p-4 text-sm text-indigo-900 dark:text-indigo-200 space-y-1">
              <p className="font-semibold">Process this amount on your card terminal.</p>
              <p>When the terminal confirms approval, tap <strong>Approved</strong> below to send the order to the kitchen. If the card is declined, tap <strong>Declined</strong> to return.</p>
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => { setStep("method"); setError(""); }}
                disabled={submitting}
                className="px-4 py-3 font-bold border border-border rounded-xl hover:bg-secondary"
              >
                Declined
              </button>
              <button
                onClick={() => confirm("card")}
                disabled={submitting}
                className="px-4 py-3 font-bold bg-indigo-600 text-white rounded-xl hover:bg-indigo-700 disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                Approved
              </button>
            </div>
            {!isOverride && (
              <button onClick={gotoOverride} className="w-full text-xs text-muted-foreground hover:text-amber-700 underline">
                Override — send to kitchen unpaid
              </button>
            )}
          </div>
        )}

        {step === "terminal" && (
          <div className="p-6 space-y-4">
            <div className="text-center">
              <p className="text-xs uppercase tracking-wider text-muted-foreground">Square Terminal</p>
              <p className="text-3xl font-display font-bold text-indigo-600">${total.toFixed(2)}</p>
            </div>
            {terminalError ? (
              <div className="bg-destructive/10 border border-destructive/30 rounded-xl p-4 text-sm text-destructive space-y-3">
                <div className="flex items-start gap-2">
                  <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                  <p>{terminalError}</p>
                </div>
                <button
                  onClick={() => { setStep("method"); setError(""); }}
                  className="flex items-center gap-1.5 text-sm font-semibold hover:underline"
                >
                  <ArrowLeft className="w-4 h-4" /> Back to payment methods
                </button>
              </div>
            ) : (
              <div className="bg-indigo-50 dark:bg-indigo-950/40 border border-indigo-200 dark:border-indigo-800/50 rounded-xl p-4 text-sm text-indigo-900 dark:text-indigo-200 space-y-2">
                <div className="flex items-center gap-2">
                  <Loader2 className="w-4 h-4 animate-spin shrink-0" />
                  <p className="font-semibold">
                    {terminalPhase === "creating" ? "Sending to terminal…" :
                     terminalPhase === "canceling" ? "Canceling…" :
                     "Waiting for card…"}
                  </p>
                </div>
                {terminalPhase === "waiting" && (
                  <p className="text-xs opacity-80">Have the customer tap or insert their card on the Square Terminal.</p>
                )}
              </div>
            )}
            {terminalCheckoutId && !terminalError && terminalPhase !== "canceling" && (
              <button
                type="button"
                disabled={submitting}
                onClick={async () => {
                  setTerminalPhase("canceling");
                  try {
                    await fetch(`${BASE}/api/event-taker/terminal-checkout/${encodeURIComponent(terminalCheckoutId)}/cancel`, {
                      method: "POST",
                      headers: { "Content-Type": "application/json", Authorization: `Bearer ${password}` },
                    });
                  } finally {
                    setStep("method");
                    setError("");
                  }
                }}
                className="w-full px-4 py-2.5 text-sm font-semibold border border-border rounded-xl hover:bg-secondary disabled:opacity-50"
              >
                Cancel transaction
              </button>
            )}
            {submitting && (
              <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="w-4 h-4 animate-spin" /> Recording payment…
              </div>
            )}
            {!isOverride && !terminalError && (
              <button onClick={gotoOverride} className="w-full text-xs text-muted-foreground hover:text-amber-700 underline">
                Override — send to kitchen unpaid
              </button>
            )}
          </div>
        )}

        {step === "venmo" && (
          <div className="p-6 space-y-4">
            <button onClick={() => { setStep("method"); setError(""); }} className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
              <ArrowLeft className="w-4 h-4" /> Back
            </button>
            <div className="text-center">
              <p className="text-xs uppercase tracking-wider text-muted-foreground">Pay via Venmo</p>
              <p className="text-3xl font-display font-bold text-sky-600">${total.toFixed(2)}</p>
            </div>
            {venmoQrImageUrl && (
              <div className="flex justify-center">
                <div className="w-56 h-56 rounded-2xl border border-border overflow-hidden bg-secondary">
                  <img src={venmoQrImageUrl} alt="Venmo QR" className="w-full h-full object-contain bg-white" />
                </div>
              </div>
            )}
            {venmoHandle && (
              <div className="text-center bg-sky-50 border border-sky-200 rounded-xl p-3">
                <p className="text-xs uppercase tracking-wider text-sky-700 font-semibold">Venmo handle</p>
                <p className="font-mono text-xl font-bold text-sky-900 mt-0.5">@{venmoHandle}</p>
              </div>
            )}
            <p className="text-xs text-muted-foreground text-center">Wait for the customer to send the payment, then tap below.</p>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <button
              onClick={() => confirm("venmo")}
              disabled={submitting}
              className="w-full px-5 py-3 bg-sky-600 text-white font-bold rounded-xl hover:bg-sky-700 disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
              Mark Venmo received
            </button>
            {!isOverride && (
              <button onClick={gotoOverride} className="w-full text-xs text-muted-foreground hover:text-amber-700 underline">
                Override — send to kitchen unpaid
              </button>
            )}
          </div>
        )}
      </div>
    </div>
    {showPlating && (
      <PlatingModal
        order={order}
        password={password}
        initial={plates}
        onClose={() => setShowPlating(false)}
        onSaved={(next) => {
          setPlates(next);
          setShowPlating(false);
          // Bubble the new layout up so the parent's pending-orders cache
          // stays current — otherwise a hold-then-resume could show a stale
          // badge until the next pending poll lands.
          onPlatingChanged?.(next);
        }}
      />
    )}
    </>
  );
}

// ── Plating layout modal ───────────────────────────────────────────────
// Opt-in editor: split the order's cart into N plates with whole-number
// quantities. Persists via PATCH /event-taker/orders/:id/plate-groups.
// Layered above the PaymentModal (z-[80] vs z-[70]) so cancel returns the
// cashier to the payment screen.
function PlatingModal({
  order, password, initial, onClose, onSaved,
}: {
  order: PendingOrder;
  password: string;
  initial: PlateGroup[] | null;
  onClose: () => void;
  onSaved: (next: PlateGroup[] | null) => void;
}) {
  // Local working copy so cancel discards in-flight edits without a server roundtrip.
  const [plates, setPlates] = useState<PlateGroup[]>(() => {
    if (initial && initial.length > 0) {
      // Defensive deep-clone — we mutate plate items via setState below.
      return initial.map(p => ({ label: p.label, items: p.items.map(i => ({ ...i })) }));
    }
    // Default: one plate pre-filled with the entire cart. Spec calls for the
    // cashier to start from "everything on plate 1" and split outward, not
    // from an empty plate they have to load up by hand.
    return [{
      label: "Plate 1",
      items: order.items
        .filter(i => i.quantity > 0)
        .map(i => ({ itemId: i.itemId, quantity: i.quantity })),
    }];
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  // Per-item totals: how much of this cart line has been allocated across
  // all plates? Drives the +/- enable state and the unassigned counter.
  function assignedFor(itemId: number): number {
    let sum = 0;
    for (const p of plates) {
      for (const ln of p.items) if (ln.itemId === itemId) sum += ln.quantity;
    }
    return sum;
  }

  function setPlateLabel(idx: number, label: string) {
    setPlates(prev => prev.map((p, i) => (i === idx ? { ...p, label } : p)));
  }

  function bumpItem(plateIdx: number, itemId: number, delta: number) {
    setPlates(prev => prev.map((p, i) => {
      if (i !== plateIdx) return p;
      const existingIdx = p.items.findIndex(ln => ln.itemId === itemId);
      const current = existingIdx >= 0 ? p.items[existingIdx].quantity : 0;
      const next = current + delta;
      if (next <= 0) {
        // Drop the line when it hits zero — cleaner state, no zero noise.
        return { ...p, items: p.items.filter(ln => ln.itemId !== itemId) };
      }
      if (existingIdx >= 0) {
        const items = p.items.slice();
        items[existingIdx] = { itemId, quantity: next };
        return { ...p, items };
      }
      return { ...p, items: [...p.items, { itemId, quantity: next }] };
    }));
  }

  function addPlate() {
    setPlates(prev => [...prev, { label: `Plate ${prev.length + 1}`, items: [] }]);
  }

  function removePlate(idx: number) {
    setPlates(prev => prev.filter((_, i) => i !== idx));
  }

  // "Done" sends only non-empty plates so the server stores a clean layout.
  // Empty payload (no plates with any items) clears plating entirely (null).
  async function save() {
    setSubmitting(true);
    setError("");
    try {
      const cleaned = plates
        .map((p, idx) => ({
          // Mirror server numbering ("Plate 1", "Plate 2", …) so a blank
          // label round-trips to a stable, predictable name.
          label: (p.label || "").trim() || `Plate ${idx + 1}`,
          items: p.items.filter(ln => ln.quantity > 0),
        }))
        .filter(p => p.items.length > 0);
      const payload: PlateGroup[] | null = cleaned.length > 0 ? cleaned : null;
      const res = await fetch(`${BASE}/api/event-taker/orders/${order.id}/plate-groups`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${password}` },
        body: JSON.stringify({ plateGroups: payload }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setError(err.error ?? "Failed to save plating");
        return;
      }
      const data = await res.json();
      onSaved(data.plateGroups ?? null);
    } catch {
      setError("Could not reach the server");
    } finally {
      setSubmitting(false);
    }
  }

  // Cart lines drive the per-plate stepper grid. Order matches the cart so
  // the layout reads top-to-bottom the same way the cashier built the order.
  const cartLines = order.items;

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-4 bg-foreground/50 backdrop-blur-sm print:hidden">
      <div className="bg-card border border-border rounded-3xl shadow-2xl w-full max-w-2xl max-h-[92vh] flex flex-col overflow-hidden">
        <div className="px-6 py-4 border-b border-border bg-secondary/30 flex items-start justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-wider text-muted-foreground font-semibold">Order #{order.id}</p>
            <h2 className="font-display font-bold text-xl mt-0.5 flex items-center gap-2">
              <Layers className="w-5 h-5 text-violet-600" />
              Plating
            </h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              Whole units only. Anything left over prints as “Unassigned” for the kitchen.
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 hover:bg-secondary rounded-lg shrink-0"
            aria-label="Close plating"
            data-testid="button-close-plating"
          >
            <XIcon className="w-5 h-5" />
          </button>
        </div>

        {/* Per-item allocation summary — sticky so the cashier always sees what's left. */}
        <div className="px-6 py-3 border-b border-border bg-background/60">
          <div className="flex flex-wrap gap-2">
            {cartLines.map(ln => {
              const assigned = assignedFor(ln.itemId);
              const remaining = ln.quantity - assigned;
              const tone =
                remaining === 0 ? "bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-400 border-emerald-200 dark:border-emerald-800/50"
                : "bg-amber-50 dark:bg-amber-950/40 text-amber-800 dark:text-amber-300 border-amber-200 dark:border-amber-800/50";
              return (
                <span
                  key={ln.itemId}
                  className={`text-xs px-2 py-1 rounded-lg border font-medium ${tone}`}
                  data-testid={`plating-summary-${ln.itemId}`}
                >
                  {ln.name}: {assigned}/{ln.quantity}
                  {remaining > 0 && ` · ${remaining} unassigned`}
                </span>
              );
            })}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {plates.length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-8">
              No plates yet — tap “Add plate” below to start.
            </p>
          )}
          {plates.map((plate, plateIdx) => (
            <div
              key={plateIdx}
              className="border border-border rounded-2xl p-4 bg-secondary/15"
              data-testid={`plate-card-${plateIdx}`}
            >
              <div className="flex items-center gap-2 mb-3">
                <input
                  value={plate.label}
                  onChange={e => setPlateLabel(plateIdx, e.target.value)}
                  placeholder={`Plate ${plateIdx + 1}`}
                  className="flex-1 px-3 py-1.5 text-sm font-bold border border-border rounded-lg bg-background"
                  data-testid={`input-plate-label-${plateIdx}`}
                />
                <button
                  type="button"
                  onClick={() => removePlate(plateIdx)}
                  className="p-1.5 text-destructive hover:bg-destructive/10 rounded-lg"
                  title="Remove this plate"
                  data-testid={`button-remove-plate-${plateIdx}`}
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
              <div className="grid gap-1.5">
                {cartLines.map(ln => {
                  const here = plate.items.find(i => i.itemId === ln.itemId)?.quantity ?? 0;
                  const remaining = ln.quantity - assignedFor(ln.itemId);
                  const canAdd = remaining > 0;
                  return (
                    <div key={ln.itemId} className="flex items-center gap-2 text-sm">
                      <span className="flex-1 truncate">{ln.name}</span>
                      <span
                        className={`text-[11px] tabular-nums whitespace-nowrap font-medium ${
                          remaining > 0 ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground"
                        }`}
                        data-testid={`text-plate-${plateIdx}-item-${ln.itemId}-remaining`}
                      >
                        Remaining: {remaining}
                      </span>
                      <button
                        type="button"
                        onClick={() => bumpItem(plateIdx, ln.itemId, -1)}
                        disabled={here === 0}
                        className="w-7 h-7 flex items-center justify-center border border-border rounded-lg disabled:opacity-30 hover:bg-secondary"
                        data-testid={`button-plate-${plateIdx}-item-${ln.itemId}-minus`}
                      >
                        <Minus className="w-3.5 h-3.5" />
                      </button>
                      <span
                        className="w-7 text-center font-bold tabular-nums"
                        data-testid={`text-plate-${plateIdx}-item-${ln.itemId}-qty`}
                      >
                        {here}
                      </span>
                      <button
                        type="button"
                        onClick={() => bumpItem(plateIdx, ln.itemId, +1)}
                        disabled={!canAdd}
                        className="w-7 h-7 flex items-center justify-center border border-border rounded-lg disabled:opacity-30 hover:bg-secondary"
                        data-testid={`button-plate-${plateIdx}-item-${ln.itemId}-plus`}
                      >
                        <Plus className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
          <button
            type="button"
            onClick={addPlate}
            className="w-full px-4 py-2.5 text-sm font-semibold border border-dashed border-border rounded-2xl hover:bg-secondary flex items-center justify-center gap-1.5"
            data-testid="button-add-plate"
          >
            <Plus className="w-4 h-4" />
            Add plate
          </button>
        </div>

        <div className="px-6 py-4 border-t border-border bg-secondary/20 space-y-2">
          {error && (
            <p className="text-sm text-destructive flex items-center gap-1.5">
              <AlertCircle className="w-4 h-4" />{error}
            </p>
          )}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 px-4 py-2.5 text-sm font-semibold border border-border rounded-xl hover:bg-secondary"
              data-testid="button-cancel-plating"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={save}
              disabled={submitting}
              className="flex-1 px-4 py-2.5 text-sm font-bold bg-violet-600 text-white rounded-xl hover:bg-violet-700 disabled:opacity-50 flex items-center justify-center gap-1.5"
              data-testid="button-save-plating"
            >
              {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
              Done
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Pending payments side panel ────────────────────────────────────────
function PendingPanel({
  orders, onClose, onResume, onCancel, onOverride, onVoid,
}: {
  orders: PendingOrder[];
  onClose: () => void;
  onResume: (o: PendingOrder) => void;
  onCancel: (id: number) => void;
  onOverride: (o: PendingOrder, reason: string) => void;
  onVoid: (o: PendingOrder) => void;
}) {
  // Per-row reason capture for the inline Override-and-send action.
  const [overrideForId, setOverrideForId] = useState<number | null>(null);
  const [overrideReason, setOverrideReason] = useState("");
  return (
    <div className="fixed inset-0 z-[65] flex justify-end bg-foreground/30 backdrop-blur-sm print:hidden" onClick={onClose}>
      <div
        className="bg-card w-full max-w-md h-full shadow-2xl flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-border flex items-center gap-2">
          <Clock className="w-5 h-5 text-amber-600" />
          <h2 className="font-display font-bold text-lg">Pending payments</h2>
          <span className="ml-auto text-sm text-muted-foreground">{orders.length}</span>
          <button onClick={onClose} className="p-1.5 hover:bg-secondary rounded-lg ml-2">
            <XIcon className="w-5 h-5" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {orders.length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-12">No orders waiting for payment.</p>
          )}
          {orders.map(o => {
            const total = o.total ?? 0;
            const ageMin = Math.max(0, Math.round((Date.now() - new Date(o.createdAt).getTime()) / 60000));
            // Override rows are visually distinct: they've already been
            // fired to the kitchen ("Sent · owed") and cannot be canceled
            // or re-overridden — only Resume to take payment.
            const isOverride = o.paymentStatus === "override";
            return (
              <div
                key={o.id}
                className={`border rounded-2xl p-3 ${
                  isOverride
                    ? "border-amber-300 dark:border-amber-700 bg-amber-50/60 dark:bg-amber-950/30"
                    : "border-border bg-secondary/20"
                }`}
                data-testid={`pending-row-${o.id}`}
              >
                <div className="flex items-start justify-between gap-2 mb-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <p className="font-bold text-sm truncate">{o.guestName}</p>
                      {isOverride && (
                        <span
                          className="text-[10px] font-bold uppercase tracking-wider bg-amber-200 dark:bg-amber-800 text-amber-900 dark:text-amber-100 px-1.5 py-0.5 rounded-full whitespace-nowrap inline-flex items-center gap-0.5"
                          data-testid={`badge-override-${o.id}`}
                          title="Order has been fired to the kitchen but is still awaiting payment"
                        >
                          <ChefHat className="w-3 h-3" />
                          Sent · owed
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      #{o.id} · {ageMin}m ago{o.phoneNumber ? ` · ${o.phoneNumber}` : ""}
                    </p>
                    {isOverride && o.paymentOverrideReason && (
                      <p className="text-[11px] italic text-amber-800 dark:text-amber-300 mt-0.5 truncate" title={o.paymentOverrideReason}>
                        Reason: {o.paymentOverrideReason}
                      </p>
                    )}
                  </div>
                  <p className="font-bold text-base text-amber-700 dark:text-amber-400 shrink-0">${total.toFixed(2)}</p>
                </div>
                <ul className="text-xs text-muted-foreground space-y-0.5 mb-3">
                  {o.items.slice(0, 4).map(i => (
                    <li key={i.itemId}>{i.quantity}× {i.name}</li>
                  ))}
                  {o.items.length > 4 && <li>+ {o.items.length - 4} more…</li>}
                </ul>
                <div className="flex gap-2">
                  <button
                    onClick={() => onResume(o)}
                    className={`flex-1 px-3 py-2 text-sm font-bold text-white rounded-lg ${
                      isOverride
                        ? "bg-amber-600 hover:bg-amber-700"
                        : "bg-indigo-600 hover:bg-indigo-700"
                    }`}
                    data-testid={`button-resume-${o.id}`}
                  >
                    {isOverride ? "Take payment" : "Resume"}
                  </button>
                  {!isOverride && (
                    // Override + cancel only apply to parked unpaid tabs.
                    // Override rows are already in the kitchen, so the
                    // server refuses both — hiding here matches reality.
                    <>
                      <button
                        onClick={() => {
                          setOverrideForId(overrideForId === o.id ? null : o.id);
                          setOverrideReason("");
                        }}
                        className={`px-3 py-2 text-sm font-semibold rounded-lg border ${
                          overrideForId === o.id
                            ? "bg-amber-100 dark:bg-amber-900/40 border-amber-300 dark:border-amber-700 text-amber-800 dark:text-amber-300"
                            : "border-amber-300 dark:border-amber-700 text-amber-700 dark:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-950/40"
                        }`}
                        title="Send to kitchen unpaid"
                      >
                        <AlertTriangle className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => onCancel(o.id)}
                        className="px-3 py-2 text-sm font-semibold text-destructive border border-destructive/30 rounded-lg hover:bg-destructive/10"
                        title="Cancel & restore stock"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </>
                  )}
                  {isOverride && (
                    // Override rows have already been fired to the kitchen.
                    // Cancel is gone (use Void instead) so the cashier has
                    // a clear path to back the order out without payment.
                    <button
                      onClick={() => onVoid(o)}
                      className="px-3 py-2 text-sm font-semibold text-rose-700 dark:text-rose-400 border border-rose-300 dark:border-rose-700 rounded-lg hover:bg-rose-50 dark:hover:bg-rose-950/40"
                      title="Void — pull this order back from the kitchen"
                      data-testid={`button-void-${o.id}`}
                    >
                      <XIcon className="w-4 h-4" />
                    </button>
                  )}
                </div>
                {overrideForId === o.id && !isOverride && (
                  <div className="mt-2 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900/40 rounded-lg p-2.5 space-y-2">
                    <div className="flex items-start gap-1.5 text-amber-800 dark:text-amber-300 text-xs">
                      <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                      <p>Send to kitchen <strong>without</strong> recording payment.</p>
                    </div>
                    <input
                      value={overrideReason}
                      onChange={e => setOverrideReason(e.target.value)}
                      placeholder="Reason (optional)"
                      className="w-full px-2.5 py-1.5 text-xs border border-amber-300 dark:border-amber-800 rounded bg-white dark:bg-amber-950/50 text-foreground placeholder:text-muted-foreground"
                    />
                    <div className="flex gap-2">
                      <button
                        onClick={() => { setOverrideForId(null); setOverrideReason(""); }}
                        className="flex-1 px-2.5 py-1.5 text-xs font-semibold border border-border rounded hover:bg-white dark:hover:bg-white/10"
                      >
                        Back
                      </button>
                      <button
                        onClick={() => {
                          const reason = overrideReason;
                          setOverrideForId(null);
                          setOverrideReason("");
                          onOverride(o, reason);
                        }}
                        className="flex-1 px-2.5 py-1.5 text-xs font-bold bg-amber-600 text-white rounded hover:bg-amber-700"
                      >
                        Send unpaid
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ── Sent orders side panel ─────────────────────────────────────────────
// Lists staff orders already on the kitchen line (paid / override) so the
// cashier can void one if it shouldn't have been sent. Mirrors PendingPanel
// styling so it feels like a sibling drawer.
function SentOrdersPanel({
  orders, recentVoids, employee, onClose, onVoid,
}: {
  orders: PendingOrder[];
  recentVoids: PendingOrder[];
  employee: string | null;
  onClose: () => void;
  onVoid: (o: PendingOrder) => void;
}) {
  // Friendlier label per kitchen status. The server only returns active
  // statuses (pending / preparing / ready) so the fallback is a safety net.
  function statusLabel(s?: string | null): string {
    if (s === "preparing") return "Preparing";
    if (s === "ready") return "Ready";
    if (s === "pending") return "Queued";
    return s ?? "—";
  }
  function statusTone(s?: string | null): string {
    if (s === "preparing") return "bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-300 border-amber-200 dark:border-amber-800/50";
    if (s === "ready") return "bg-emerald-100 dark:bg-emerald-900/40 text-emerald-800 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800/50";
    return "bg-secondary text-muted-foreground border-border"; // queued / unknown
  }
  return (
    <div className="fixed inset-0 z-[65] flex justify-end bg-foreground/30 backdrop-blur-sm print:hidden" onClick={onClose}>
      <div
        className="bg-card w-full max-w-md h-full shadow-2xl flex flex-col"
        onClick={e => e.stopPropagation()}
        data-testid="sent-orders-panel"
      >
        <div className="px-5 py-4 border-b border-border flex items-center gap-2">
          <ChefHat className="w-5 h-5 text-rose-600" />
          <h2 className="font-display font-bold text-lg">Sent orders</h2>
          <span className="ml-auto text-sm text-muted-foreground">{orders.length}</span>
          <button onClick={onClose} className="p-1.5 hover:bg-secondary rounded-lg ml-2">
            <XIcon className="w-5 h-5" />
          </button>
        </div>
        <div className="px-5 py-3 border-b border-border bg-secondary/20">
          <p className="text-xs text-muted-foreground leading-snug">
            Orders already on the kitchen line. Voiding pulls the ticket back —
            stock is <strong>not</strong> restored. Paid orders flag a manual
            refund for you.
          </p>
          {/* Surface the device's current employee here so it's obvious whose
              name will be attached to any void initiated from this panel. */}
          <p className="text-[11px] text-muted-foreground mt-1.5" data-testid="text-sent-panel-employee">
            Voids will be attributed to:{" "}
            {employee
              ? <span className="font-semibold text-foreground">{employee}</span>
              : <span className="italic">no employee set — you'll be prompted</span>}
          </p>
        </div>
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {orders.length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-12">No active orders to void.</p>
          )}
          {/* Recent voids subsection — collapsible audit trail of who
              processed each void in the active session. Source of truth
              is the Sales Report; this is just a register-side glance so
              cashiers don't have to leave the POS to check. */}
          {recentVoids.length > 0 && orders.length === 0 && (
            <div className="border-t border-border -mx-4 px-4 pt-3" />
          )}
          {recentVoids.length > 0 && (
            <div data-testid="recent-voids-section" className="mt-2">
              <div className="flex items-center gap-2 mb-2 text-xs uppercase tracking-wider text-muted-foreground font-bold">
                <XIcon className="w-3.5 h-3.5 text-rose-600" />
                Recent voids
                <span className="ml-auto text-[11px] normal-case font-normal text-muted-foreground">
                  who processed each
                </span>
              </div>
              <div className="space-y-2">
                {recentVoids.map(v => {
                  const total = v.total ?? 0;
                  const voidedDate = v.voidedAt ? new Date(v.voidedAt) : null;
                  const ageMin = voidedDate ? Math.max(0, Math.round((Date.now() - voidedDate.getTime()) / 60000)) : null;
                  return (
                    <div
                      key={v.id}
                      className="border border-rose-200 dark:border-rose-800/50 bg-rose-50/40 dark:bg-rose-950/20 rounded-xl p-2.5 text-xs"
                      data-testid={`recent-void-row-${v.id}`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <p className="font-semibold text-foreground text-sm truncate">
                            #{v.id} · {v.guestName}
                          </p>
                          <p className="text-muted-foreground mt-0.5">
                            <span className="font-semibold text-rose-800 dark:text-rose-300" data-testid={`recent-void-by-${v.id}`}>
                              {v.voidedBy ?? "Unknown"}
                            </span>
                            {ageMin != null ? <> · {ageMin}m ago</> : null}
                          </p>
                          {v.voidReason && (
                            <p className="italic text-muted-foreground mt-0.5 break-words">
                              "{v.voidReason}"
                            </p>
                          )}
                        </div>
                        <div className="text-right shrink-0">
                          <p className="font-bold text-foreground line-through">${total.toFixed(2)}</p>
                          {v.refundRequired && (
                            <span className="inline-block mt-0.5 text-[9px] font-bold uppercase tracking-wider px-1 py-0.5 rounded bg-rose-100 dark:bg-rose-900/40 text-rose-700 dark:text-rose-400 border border-rose-200 dark:border-rose-800/50">
                              Refund owed
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
          {orders.map(o => {
            const total = o.total ?? 0;
            const ageMin = Math.max(0, Math.round((Date.now() - new Date(o.createdAt).getTime()) / 60000));
            const isPaid = o.paymentStatus === "paid";
            return (
              <div
                key={o.id}
                className="border border-border rounded-2xl p-3 bg-secondary/10"
                data-testid={`sent-row-${o.id}`}
              >
                <div className="flex items-start justify-between gap-2 mb-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <p className="font-bold text-sm truncate">{o.guestName}</p>
                      <span
                        className={`text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-full border ${statusTone(o.status)}`}
                      >
                        {statusLabel(o.status)}
                      </span>
                      {isPaid ? (
                        <span className="text-[10px] font-bold uppercase tracking-wider bg-emerald-100 dark:bg-emerald-900/40 text-emerald-800 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800/50 px-1.5 py-0.5 rounded-full">
                          Paid · {o.paymentMethod ?? "?"}
                        </span>
                      ) : (
                        <span className="text-[10px] font-bold uppercase tracking-wider bg-amber-200 dark:bg-amber-800 text-amber-900 dark:text-amber-100 px-1.5 py-0.5 rounded-full">
                          Override · owed
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      #{o.id} · {ageMin}m ago{o.phoneNumber ? ` · ${o.phoneNumber}` : ""}
                    </p>
                    {!isPaid && o.paymentOverrideReason && (
                      <p
                        className="text-[11px] italic text-amber-900 dark:text-amber-300 mt-0.5 break-words"
                        data-testid={`sent-override-reason-${o.id}`}
                      >
                        Override reason: {o.paymentOverrideReason}
                      </p>
                    )}
                  </div>
                  <p className="font-bold text-base shrink-0">${total.toFixed(2)}</p>
                </div>
                <ul className="text-xs text-muted-foreground space-y-0.5 mb-3">
                  {o.items.slice(0, 4).map(i => (
                    <li key={i.itemId}>{i.quantity}× {i.name}</li>
                  ))}
                  {o.items.length > 4 && <li>+ {o.items.length - 4} more…</li>}
                </ul>
                <button
                  onClick={() => onVoid(o)}
                  className="w-full px-3 py-2 text-sm font-bold text-white bg-rose-600 hover:bg-rose-700 rounded-lg flex items-center justify-center gap-1.5"
                  data-testid={`button-void-${o.id}`}
                >
                  <XIcon className="w-4 h-4" />
                  Void order
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ── Void confirmation modal ────────────────────────────────────────────
// Self-reported "who's on the register?" gate. Renders full-screen on
// first sign-in for the device, and again when the cashier explicitly
// chooses to switch via the header chip. Persisted via localStorage on
// success. Single shared password — this is bookkeeping, not auth.
function EmployeeGate({
  initial, switching, onCancel, onSubmit,
}: {
  initial: string;
  switching: boolean;
  onCancel?: () => void;
  onSubmit: (name: string) => void;
}) {
  const [name, setName] = useState(initial);
  const trimmed = name.trim();
  const valid = trimmed.length > 0 && trimmed.length <= EMPLOYEE_MAX_LEN;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (valid) onSubmit(trimmed);
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-indigo-50 via-background to-amber-50 flex items-center justify-center p-4">
      <div className="bg-card border border-border rounded-3xl shadow-xl p-8 w-full max-w-md" data-testid="employee-gate">
        <div className="text-center mb-6">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-indigo-100 text-indigo-600 mb-4">
            <Pencil className="w-7 h-7" />
          </div>
          <h1 className="font-display font-bold text-2xl">
            {switching ? "Switch employee" : "Who's on the register?"}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Your name will be recorded on every void you process from this device.
          </p>
        </div>
        <form onSubmit={handleSubmit} className="space-y-3">
          <input
            type="text"
            autoFocus
            value={name}
            onChange={e => setName(e.target.value.slice(0, EMPLOYEE_MAX_LEN))}
            placeholder="First name or full name"
            maxLength={EMPLOYEE_MAX_LEN}
            className="w-full px-4 py-3 border border-border rounded-xl bg-background focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 outline-none"
            data-testid="input-employee-name"
          />
          <div className="flex gap-2">
            {onCancel && (
              <button
                type="button"
                onClick={onCancel}
                className="flex-1 px-5 py-3 border border-border text-foreground font-semibold rounded-xl hover:bg-secondary"
                data-testid="button-cancel-employee"
              >
                Cancel
              </button>
            )}
            <button
              type="submit"
              disabled={!valid}
              className="flex-1 px-5 py-3 bg-indigo-600 text-white font-semibold rounded-xl hover:bg-indigo-700 disabled:opacity-50"
              data-testid="button-save-employee"
            >
              {switching ? "Switch" : "Continue"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function VoidModal({
  order, defaultVoidedBy, onClose, onConfirm,
}: {
  order: PendingOrder;
  defaultVoidedBy: string;
  onClose: () => void;
  onConfirm: (reason: string, voidedBy: string) => Promise<{ ok: true } | { ok: false; error: string }>;
}) {
  const [reason, setReason] = useState("");
  // Pre-filled with the device's currently-signed-in employee (from the
  // header chip). Editable so a peer staffer covering for someone else can
  // record the actual person who voided.
  const [voidedBy, setVoidedBy] = useState(defaultVoidedBy);
  const [ack, setAck] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const isPaid = order.paymentStatus === "paid";
  const total = order.total ?? 0;
  // Both "preparing" and "ready" mean the cook has touched the ticket; the
  // warning escalates so the cashier double-checks before pulling it back.
  const cookingStarted = order.status === "preparing" || order.status === "ready";
  const trimmed = reason.trim();
  const trimmedBy = voidedBy.trim();
  const canSubmit = trimmed.length > 0 && trimmedBy.length > 0 && trimmedBy.length <= EMPLOYEE_MAX_LEN && (!isPaid || ack) && !submitting;

  async function submit() {
    if (!canSubmit) return;
    setSubmitting(true);
    setError("");
    const result = await onConfirm(trimmed, trimmedBy);
    if (!result.ok) {
      setError(result.error);
      setSubmitting(false);
    }
    // On success the parent unmounts this modal — no need to reset state.
  }

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-4 bg-foreground/40 backdrop-blur-sm print:hidden">
      <div className="bg-card border border-border rounded-3xl shadow-2xl w-full max-w-md overflow-hidden" data-testid="void-modal">
        <div className="px-6 py-4 border-b border-border bg-rose-50 dark:bg-rose-950/30 flex items-start justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-wider text-rose-700 dark:text-rose-400 font-semibold">Void order #{order.id}</p>
            <h2 className="font-display font-bold text-xl mt-0.5 text-foreground">{order.guestName}</h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              {order.items.reduce((s, i) => s + i.quantity, 0)} item(s) · ${total.toFixed(2)}
            </p>
          </div>
          <button onClick={onClose} className="p-1.5 hover:bg-rose-100 dark:hover:bg-rose-900/30 rounded-lg" disabled={submitting}>
            <XIcon className="w-5 h-5" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          {cookingStarted && (
            <div className="flex items-start gap-2 p-3 bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800/50 rounded-xl text-sm text-amber-800 dark:text-amber-300">
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
              <p>
                The kitchen is already <strong>{order.status === "ready" ? "plating this order" : "cooking this order"}</strong>.
                Confirm with them before voiding — food may have to be discarded.
              </p>
            </div>
          )}

          <div className="text-sm text-muted-foreground">
            <p>Stock is <strong>not</strong> restored — the kitchen has effectively consumed these items.</p>
          </div>

          <label className="block">
            <span className="text-sm font-semibold text-foreground">Reason (required)</span>
            <textarea
              value={reason}
              onChange={e => setReason(e.target.value)}
              rows={3}
              autoFocus
              placeholder="e.g. customer canceled, wrong order, allergy"
              className="mt-1 w-full px-3 py-2 text-sm border border-border rounded-lg bg-background focus:outline-none focus:ring-2 focus:ring-rose-400"
              data-testid="input-void-reason"
              disabled={submitting}
            />
          </label>

          <label className="block">
            <span className="text-sm font-semibold text-foreground">Your name (required)</span>
            <input
              type="text"
              value={voidedBy}
              onChange={e => setVoidedBy(e.target.value.slice(0, EMPLOYEE_MAX_LEN))}
              placeholder="Who is voiding this order?"
              className="mt-1 w-full px-3 py-2 text-sm border border-border rounded-lg bg-background focus:outline-none focus:ring-2 focus:ring-rose-400"
              data-testid="input-voided-by"
              disabled={submitting}
              maxLength={EMPLOYEE_MAX_LEN}
            />
            <span className="block text-[11px] text-muted-foreground mt-1">
              Recorded on the void and shown in the Sales Report.
            </span>
          </label>

          {isPaid && (
            <div className="p-3 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-800/50 rounded-xl space-y-2">
              <div className="flex items-start gap-2 text-sm text-rose-800 dark:text-rose-300">
                <DollarSign className="w-4 h-4 mt-0.5 shrink-0" />
                <p>
                  <strong>${total.toFixed(2)}</strong> was charged to {order.paymentMethod ?? "the customer"}.
                  Voiding does <strong>not</strong> automatically refund — you must process the refund out of band.
                </p>
              </div>
              <label className="flex items-start gap-2 text-sm text-rose-900 dark:text-rose-300 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={ack}
                  onChange={e => setAck(e.target.checked)}
                  className="mt-0.5"
                  data-testid="checkbox-refund-ack"
                  disabled={submitting}
                />
                <span>I will refund the customer manually.</span>
              </label>
            </div>
          )}

          {error && (
            <div className="flex items-start gap-2 p-3 bg-destructive/10 border border-destructive/30 rounded-lg text-sm text-destructive">
              <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
              <p>{error}</p>
            </div>
          )}
        </div>

        <div className="px-5 py-4 border-t border-border bg-secondary/20 flex gap-2">
          <button
            onClick={onClose}
            disabled={submitting}
            className="flex-1 px-3 py-2.5 text-sm font-semibold border border-border rounded-lg hover:bg-card disabled:opacity-50"
          >
            Keep order
          </button>
          <button
            onClick={submit}
            disabled={!canSubmit}
            className="flex-1 px-3 py-2.5 text-sm font-bold text-white bg-rose-600 hover:bg-rose-700 rounded-lg disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-1.5"
            data-testid="button-confirm-void"
          >
            {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <XIcon className="w-4 h-4" />}
            {submitting ? "Voiding…" : "Void order"}
          </button>
        </div>
      </div>
    </div>
  );
}
