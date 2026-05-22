import { useState, useRef, useEffect, type ReactNode } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { MessageSquare, X, Send, Sparkles, ChefHat, ArrowRight } from "lucide-react";
import { useChatStream, type Message } from "@/hooks/use-chat";
import { cn } from "@/lib/utils";
import { useLocation } from "wouter";

// Render `[label](url)` markdown links as real <a> tags. The model is
// untrusted, so we resolve every candidate URL against the current
// origin and only accept links that resolve to that same origin —
// rejecting protocol-relative (`//evil`), absolute external, and any
// non-`http(s)` schemes. Non-matching text is rendered verbatim.
function isSafeSameOriginPath(raw: string): string | null {
  if (typeof window === "undefined") return null;
  if (!raw.startsWith("/") || raw.startsWith("//")) return null;
  try {
    const url = new URL(raw, window.location.origin);
    if (url.origin !== window.location.origin) return null;
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.pathname + url.search + url.hash;
  } catch {
    return null;
  }
}

// Render plain text and `[label](url)` links inside a single non-bold
// segment. navigate is passed so clicks use client-side routing.
function renderInline(
  text: string,
  keyPrefix: string,
  navigate: (to: string) => void,
): ReactNode[] {
  const parts: ReactNode[] = [];
  const re = /\[([^\]]+)\]\(([^)\s]+)\)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = re.exec(text)) !== null) {
    const safeHref = isSafeSameOriginPath(match[2]);
    if (safeHref === null) continue;
    if (match.index > last) parts.push(text.slice(last, match.index));
    parts.push(
      <a
        key={`${keyPrefix}l${key++}`}
        href={safeHref}
        onClick={(e) => {
          e.preventDefault();
          navigate(safeHref);
        }}
        className="underline font-semibold text-primary hover:text-primary/80"
      >
        {match[1]}
      </a>,
    );
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

function renderMessageContent(
  text: string,
  navigate: (to: string) => void,
): ReactNode[] {
  text = text.replace(/^\s*#{1,6}\s+/gm, "");
  const parts: ReactNode[] = [];
  const re = /\*\*([^*\n]+)\*\*/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = re.exec(text)) !== null) {
    if (match.index > last) {
      parts.push(...renderInline(text.slice(last, match.index), `s${key}`, navigate));
    }
    parts.push(
      <strong key={`b${key++}`} className="font-semibold">
        {renderInline(match[1], `b${key}`, navigate)}
      </strong>,
    );
    last = match.index + match[0].length;
  }
  if (last < text.length) {
    parts.push(...renderInline(text.slice(last), `s${key}`, navigate));
  }
  return parts;
}

// ── Conversation context extraction ─────────────────────────────────────────
// Scans message history for key signals dashy collects during planning.
// Results drive the evolving CTA button below the input.

interface ConversationContext {
  eventDate: string | null;    // YYYY-MM-DD
  guestCount: number | null;
  serviceStyle: "drop_off" | "on_the_dash" | null;
  inquiryId: number | null;
}

function extractContext(messages: Message[], inquiryId: number | null): ConversationContext {
  const allText = messages.map((m) => m.content).join("\n");
  const assistantText = messages
    .filter((m) => m.role === "assistant")
    .map((m) => m.content)
    .join("\n");

  // Date: Dashy always echoes dates as MM/DD/YYYY per the system prompt.
  const dateMatch = assistantText.match(/\b(\d{2})\/(\d{2})\/(\d{4})\b/);
  const eventDate = dateMatch
    ? `${dateMatch[3]}-${dateMatch[1]}-${dateMatch[2]}`
    : null;

  // Guest count: user or assistant messages mentioning "N guests/people/attendees".
  const countMatch = allText.match(/\b(\d+)\s*(?:guests?|people|attendees?|persons?)\b/i);
  const guestCount = countMatch ? parseInt(countMatch[1], 10) : null;

  // Service style: look for the canonical names in any message.
  const hasOTD =
    /on\s+the\s+dash/i.test(allText) ||
    /food\s+trailer/i.test(allText) ||
    /on[_\s]the[_\s]dash/i.test(allText);
  const hasDropOff =
    /standard\s+drop.?off/i.test(allText) ||
    /drop.?off/i.test(allText);
  const serviceStyle: ConversationContext["serviceStyle"] = hasOTD
    ? "on_the_dash"
    : hasDropOff
      ? "drop_off"
      : null;

  return { eventDate, guestCount, serviceStyle, inquiryId };
}

// inquiryToken and planItemsAdded are passed separately since they come
// from the hook, not from message text.
function buildCtaHref(
  ctx: ConversationContext,
  inquiryToken: string | null,
  planItemsAdded: number | null,
): { label: string; href: string } {
  if (inquiryToken) {
    return {
      label: "View your inquiry",
      href: `/inquiry/${inquiryToken}`,
    };
  }
  if (planItemsAdded && planItemsAdded > 0) {
    return { label: "Open your plan", href: "/plan" };
  }
  if (ctx.guestCount && ctx.serviceStyle) {
    const params = new URLSearchParams();
    params.set("count", String(ctx.guestCount));
    params.set("style", ctx.serviceStyle);
    if (ctx.eventDate) params.set("date", ctx.eventDate);
    return { label: "Build your plan", href: `/plan?${params.toString()}` };
  }
  if (ctx.eventDate) {
    const params = new URLSearchParams();
    params.set("date", ctx.eventDate);
    return { label: "Check availability", href: `/plan?${params.toString()}` };
  }
  return { label: "Browse the menu", href: "/menu" };
}

export function ChatWidget() {
  const [isOpen, setIsOpen] = useState(false);
  const [input, setInput] = useState("");
  const { messages, sendMessage, isTyping, inquiryId, inquiryToken, planItemsAdded } = useChatStream();
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const [, navigate] = useLocation();

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    if (isOpen) {
      setTimeout(scrollToBottom, 100);
    }
  }, [messages, isOpen, isTyping]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isTyping) return;
    sendMessage(input);
    setInput("");
  };

  const ctx = extractContext(messages, inquiryId);
  const cta = buildCtaHref(ctx, inquiryToken, planItemsAdded);

  return (
    <>
      <AnimatePresence>
        {!isOpen && (
          <motion.button
            initial={{ scale: 0, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0, opacity: 0 }}
            onClick={() => setIsOpen(true)}
            className="fixed bottom-6 right-6 z-50 p-4 rounded-full bg-primary text-primary-foreground shadow-2xl shadow-primary/30 hover:scale-105 active:scale-95 transition-transform"
          >
            <MessageSquare className="w-7 h-7" />
          </motion.button>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0, y: 20, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 20, scale: 0.95 }}
            transition={{ type: "spring", stiffness: 300, damping: 30 }}
            className="fixed bottom-6 right-6 z-50 w-[380px] max-w-[calc(100vw-3rem)] h-[600px] max-h-[calc(100vh-6rem)] bg-card border border-border rounded-2xl shadow-2xl overflow-hidden flex flex-col"
          >
            {/* Header */}
            <div className="bg-primary px-5 py-4 flex items-center justify-between text-primary-foreground">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-white/20 flex items-center justify-center backdrop-blur-sm">
                  <ChefHat className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="font-display font-semibold text-lg leading-tight lowercase">dashy</h3>
                  <p className="text-primary-foreground/80 text-xs">AI Assistant</p>
                </div>
              </div>
              <button
                onClick={() => setIsOpen(false)}
                className="p-2 rounded-full hover:bg-white/20 transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Messages */}
            <div className="flex-1 overflow-y-auto p-5 space-y-4 bg-background scrollbar-thin">
              {messages.map((msg) => (
                <motion.div
                  key={msg.id}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  className={cn(
                    "flex gap-3 max-w-[85%]",
                    msg.role === "user" ? "ml-auto flex-row-reverse" : "mr-auto"
                  )}
                >
                  {msg.role === "assistant" && (
                    <div className="w-8 h-8 shrink-0 rounded-full bg-secondary flex items-center justify-center">
                      <Sparkles className="w-4 h-4 text-primary" />
                    </div>
                  )}
                  <div
                    className={cn(
                      "p-3 rounded-2xl text-sm leading-relaxed",
                      msg.role === "user"
                        ? "bg-primary text-primary-foreground rounded-tr-sm"
                        : "bg-card border border-border shadow-sm rounded-tl-sm text-foreground"
                    )}
                  >
                    {msg.role === "assistant"
                      ? renderMessageContent(msg.content, navigate)
                      : msg.content}
                    {msg.isStreaming && (
                      <span className="inline-block w-1.5 h-4 ml-1 align-middle bg-primary/50 animate-pulse" />
                    )}
                  </div>
                </motion.div>
              ))}
              {isTyping && messages[messages.length - 1]?.role === "user" && (
                <div className="flex gap-3 max-w-[85%] mr-auto">
                  <div className="w-8 h-8 rounded-full bg-secondary flex items-center justify-center">
                    <Sparkles className="w-4 h-4 text-primary" />
                  </div>
                  <div className="p-4 bg-card border border-border shadow-sm rounded-2xl rounded-tl-sm flex gap-1">
                    <span className="w-2 h-2 rounded-full bg-muted-foreground/40 animate-bounce" />
                    <span className="w-2 h-2 rounded-full bg-muted-foreground/40 animate-bounce delay-75" />
                    <span className="w-2 h-2 rounded-full bg-muted-foreground/40 animate-bounce delay-150" />
                  </div>
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>

            {/* Input + CTA */}
            <div className="p-4 bg-card border-t border-border space-y-2">
              <form onSubmit={handleSubmit} className="flex gap-2">
                <input
                  type="text"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  placeholder="Tell me about your event..."
                  className="flex-1 px-4 py-2.5 bg-background border border-border rounded-xl focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all text-sm"
                />
                <button
                  type="submit"
                  disabled={!input.trim() || isTyping}
                  className="p-3 bg-primary text-primary-foreground rounded-xl hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  <Send className="w-5 h-5" />
                </button>
              </form>

              {/* Evolving contextual CTA */}
              <button
                onClick={() => {
                  navigate(cta.href);
                  setIsOpen(false);
                }}
                className="w-full flex items-center justify-between px-3 py-2 rounded-lg bg-secondary hover:bg-secondary/70 transition-colors text-sm font-medium text-foreground/80 hover:text-foreground"
              >
                <span>{cta.label}</span>
                <ArrowRight className="w-4 h-4 shrink-0" />
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
