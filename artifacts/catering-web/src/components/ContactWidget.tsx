import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { MessageSquare, X, Mail, Phone } from "lucide-react";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

type Channel = "sms" | "email";
type FormState = "idle" | "submitting" | "success" | "error";

export function ContactWidget() {
  const [isOpen, setIsOpen] = useState(false);
  const [channel, setChannel] = useState<Channel>("sms");
  const [name, setName] = useState("");
  const [contact, setContact] = useState("");
  const [message, setMessage] = useState("");
  const [formState, setFormState] = useState<FormState>("idle");
  const [errorMsg, setErrorMsg] = useState("");
  const [successChannel, setSuccessChannel] = useState<Channel>("sms");

  function resetForm() {
    setChannel("sms");
    setName("");
    setContact("");
    setMessage("");
    setFormState("idle");
    setErrorMsg("");
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormState("submitting");
    setErrorMsg("");
    try {
      const res = await fetch(`${BASE}/api/contact/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel, name: name.trim(), contact: contact.trim(), message: message.trim() }),
      });
      if (res.ok) {
        setSuccessChannel(channel);
        setFormState("success");
      } else {
        const data = await res.json().catch(() => ({}));
        setErrorMsg(data?.error ?? "Something went wrong. Please try again.");
        setFormState("error");
      }
    } catch {
      setErrorMsg("Network error — please check your connection and try again.");
      setFormState("error");
    }
  }

  const disabled = formState === "submitting";

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
            aria-label="Contact us"
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
            className="fixed bottom-6 right-6 z-50 w-[380px] max-w-[calc(100vw-3rem)] bg-card border border-border rounded-2xl shadow-2xl overflow-hidden flex flex-col"
          >
            {/* Header */}
            <div className="bg-primary px-5 py-4 flex items-center justify-between text-primary-foreground shrink-0">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-white/20 flex items-center justify-center backdrop-blur-sm">
                  <MessageSquare className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="font-display font-semibold text-lg leading-tight">Questions? Say hi!</h3>
                  <p className="text-primary-foreground/80 text-xs">dash by Hollywood East Cafe</p>
                </div>
              </div>
              <button
                onClick={() => setIsOpen(false)}
                className="p-2 rounded-full hover:bg-white/20 transition-colors"
                aria-label="Close"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Body */}
            <div className="flex-1 overflow-y-auto bg-background">
              {formState === "success" ? (
                <div className="flex flex-col items-center justify-center gap-4 px-6 py-10 text-center">
                  <div className="w-14 h-14 rounded-full bg-primary/10 flex items-center justify-center">
                    <MessageSquare className="w-7 h-7 text-primary" />
                  </div>
                  <div>
                    <p className="font-semibold text-foreground text-base">Message sent!</p>
                    <p className="text-sm text-muted-foreground mt-1.5 leading-relaxed">
                      {successChannel === "sms"
                        ? "Thanks! We just sent you a text from our catering line — reply there to keep the conversation going."
                        : "Thanks! We'll get back to you by email soon."}
                    </p>
                  </div>
                  <button
                    onClick={resetForm}
                    className="text-sm text-primary underline hover:text-primary/80 transition-colors mt-1"
                  >
                    Send another message
                  </button>
                </div>
              ) : (
                <form onSubmit={handleSubmit} className="px-5 py-5 space-y-4">
                  {/* Name */}
                  <div>
                    <label className="block text-xs font-semibold text-muted-foreground mb-1.5 uppercase tracking-wider">
                      Your name
                    </label>
                    <input
                      type="text"
                      required
                      disabled={disabled}
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="Jane Smith"
                      className="w-full rounded-xl border border-border bg-card px-3.5 py-2.5 text-sm text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-2 focus:ring-primary/40 disabled:opacity-50"
                    />
                  </div>

                  {/* Channel toggle */}
                  <div>
                    <label className="block text-xs font-semibold text-muted-foreground mb-1.5 uppercase tracking-wider">
                      How to reach you
                    </label>
                    <div className="flex rounded-xl border border-border overflow-hidden text-sm font-medium">
                      <button
                        type="button"
                        disabled={disabled}
                        onClick={() => { setChannel("sms"); setContact(""); }}
                        className={`flex-1 flex items-center justify-center gap-2 py-2.5 transition-colors ${
                          channel === "sms"
                            ? "bg-primary text-primary-foreground"
                            : "bg-card text-muted-foreground hover:bg-secondary"
                        }`}
                      >
                        <Phone className="w-4 h-4" />
                        Text (SMS)
                      </button>
                      <button
                        type="button"
                        disabled={disabled}
                        onClick={() => { setChannel("email"); setContact(""); }}
                        className={`flex-1 flex items-center justify-center gap-2 py-2.5 transition-colors ${
                          channel === "email"
                            ? "bg-primary text-primary-foreground"
                            : "bg-card text-muted-foreground hover:bg-secondary"
                        }`}
                      >
                        <Mail className="w-4 h-4" />
                        Email
                      </button>
                    </div>
                  </div>

                  {/* Contact field — conditional */}
                  <div>
                    {channel === "sms" ? (
                      <>
                        <label className="block text-xs font-semibold text-muted-foreground mb-1.5 uppercase tracking-wider">
                          Phone number
                        </label>
                        <input
                          type="tel"
                          required
                          disabled={disabled}
                          value={contact}
                          onChange={(e) => setContact(e.target.value)}
                          placeholder="Your phone number"
                          className="w-full rounded-xl border border-border bg-card px-3.5 py-2.5 text-sm text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-2 focus:ring-primary/40 disabled:opacity-50"
                        />
                      </>
                    ) : (
                      <>
                        <label className="block text-xs font-semibold text-muted-foreground mb-1.5 uppercase tracking-wider">
                          Email address
                        </label>
                        <input
                          type="email"
                          required
                          disabled={disabled}
                          value={contact}
                          onChange={(e) => setContact(e.target.value)}
                          placeholder="Your email address"
                          className="w-full rounded-xl border border-border bg-card px-3.5 py-2.5 text-sm text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-2 focus:ring-primary/40 disabled:opacity-50"
                        />
                      </>
                    )}
                  </div>

                  {/* Message */}
                  <div>
                    <label className="block text-xs font-semibold text-muted-foreground mb-1.5 uppercase tracking-wider">
                      Message
                    </label>
                    <textarea
                      required
                      disabled={disabled}
                      rows={4}
                      value={message}
                      onChange={(e) => setMessage(e.target.value)}
                      placeholder="Your question or comment"
                      className="w-full rounded-xl border border-border bg-card px-3.5 py-2.5 text-sm text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-2 focus:ring-primary/40 resize-none disabled:opacity-50"
                    />
                  </div>

                  {/* Error */}
                  {formState === "error" && errorMsg && (
                    <p className="text-sm text-destructive">{errorMsg}</p>
                  )}

                  {/* Submit */}
                  <button
                    type="submit"
                    disabled={disabled}
                    className="w-full flex items-center justify-center gap-2 bg-primary text-primary-foreground rounded-xl py-3 text-sm font-semibold hover:bg-primary/90 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
                  >
                    {formState === "submitting" ? (
                      <>
                        <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                        </svg>
                        Sending…
                      </>
                    ) : (
                      "Send message"
                    )}
                  </button>
                </form>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
