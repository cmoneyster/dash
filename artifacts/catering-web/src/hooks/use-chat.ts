import { useState, useRef, useCallback, useEffect } from "react";
import { getSessionId } from "@/lib/session";
import type { ChatHistoryMessage } from "@workspace/api-client-react";

export interface Message extends ChatHistoryMessage {
  id: string;
  isStreaming?: boolean;
}

const CHAT_STORAGE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CHAT_MAX_MESSAGES = 200;

interface PersistedState {
  messages: Message[];
  savedAt: number;
  inquiryId: number | null;
  inquiryToken?: string | null;
}

function storageKey(sid: string) {
  return `chat_messages_${sid}`;
}

function loadPersisted(sid: string): PersistedState | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(storageKey(sid));
    if (!raw) return null;
    const p: PersistedState = JSON.parse(raw);
    if (!p.savedAt || Date.now() - p.savedAt > CHAT_STORAGE_TTL_MS) {
      localStorage.removeItem(storageKey(sid));
      return null;
    }
    const messages = (p.messages ?? [])
      .filter((m: any) => m.id && m.role && typeof m.content === "string")
      .slice(-CHAT_MAX_MESSAGES) as Message[];
    return { messages, savedAt: p.savedAt, inquiryId: p.inquiryId ?? null };
  } catch {
    return null;
  }
}

function savePersisted(sid: string, messages: Message[], inquiryId: number | null, inquiryToken: string | null) {
  if (typeof window === "undefined") return;
  try {
    const realMessages = messages.filter(m => !m.id.startsWith("_welcome"));
    const state: PersistedState = {
      messages: realMessages.slice(-CHAT_MAX_MESSAGES),
      savedAt: Date.now(),
      inquiryId,
      inquiryToken,
    };
    localStorage.setItem(storageKey(sid), JSON.stringify(state));
  } catch {}
}

const DEFAULT_WELCOME: Message = {
  id: "_welcome",
  role: "assistant",
  content: "Hi, I'm dashy! Want to browse our menu, or get a hand planning your event?",
};

const WELCOME_BACK: Message = {
  id: "_welcome_back",
  role: "assistant",
  content: "Welcome back! You can pick up where we left off — just keep chatting.",
};

export function useChatStream() {
  // useState lazy initializer runs only once on mount — safe to call getSessionId here.
  const [sessionId] = useState<string>(() => getSessionId());

  const [messages, setMessages] = useState<Message[]>(() => {
    const stored = loadPersisted(getSessionId());
    if (stored && stored.messages.length > 0) {
      return [...stored.messages, WELCOME_BACK];
    }
    return [DEFAULT_WELCOME];
  });

  const [inquiryId, setInquiryId] = useState<number | null>(() => {
    const stored = loadPersisted(getSessionId());
    return stored?.inquiryId ?? null;
  });

  const [inquiryToken, setInquiryToken] = useState<string | null>(() => {
    const stored = loadPersisted(getSessionId());
    return stored?.inquiryToken ?? null;
  });

  const [isTyping, setIsTyping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    savePersisted(sessionId, messages, inquiryId, inquiryToken);
  }, [messages, inquiryId, inquiryToken, sessionId]);

  const sendMessage = useCallback(async (content: string) => {
    if (!content.trim()) return;

    setError(null);
    const userMsg: Message = { id: crypto.randomUUID(), role: "user", content };

    const historyForApi = messages
      .filter(m => !m.id.startsWith("_welcome"))
      .map(({ role, content: c }) => ({ role, content: c }));

    setMessages((prev) => [...prev, userMsg]);
    setIsTyping(true);

    const assistantMsgId = crypto.randomUUID();
    setMessages((prev) => [
      ...prev,
      { id: assistantMsgId, role: "assistant", content: "", isStreaming: true },
    ]);

    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    abortControllerRef.current = new AbortController();

    try {
      const res = await fetch("/api/chat/message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId,
          message: content,
          history: historyForApi,
        }),
        signal: abortControllerRef.current.signal,
      });

      if (!res.ok) throw new Error("Failed to send message");
      if (!res.body) throw new Error("No response body");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let assistantContent = "";

      outer: while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split("\n");

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            const dataStr = line.slice(6).trim();
            if (!dataStr || dataStr === "[DONE]") continue;

            try {
              const data = JSON.parse(dataStr);
              if (data.done) {
                if (data.inquiryId) setInquiryId(data.inquiryId);
                if (data.inquiryToken) setInquiryToken(data.inquiryToken);
                break outer;
              }
              if (data.content) {
                assistantContent += data.content;
                setMessages((prev) =>
                  prev.map((msg) =>
                    msg.id === assistantMsgId
                      ? { ...msg, content: assistantContent }
                      : msg
                  )
                );
              }
            } catch (e) {
              // ignore malformed SSE chunk
            }
          }
        }
      }

      setMessages((prev) =>
        prev.map((msg) =>
          msg.id === assistantMsgId ? { ...msg, isStreaming: false } : msg
        )
      );
    } catch (err: any) {
      if (err.name === "AbortError") return;
      setError("Connection lost. Please try again.");
      setMessages((prev) => prev.filter((m) => m.id !== assistantMsgId));
    } finally {
      setIsTyping(false);
    }
  }, [messages, sessionId]);

  return { messages, sendMessage, isTyping, error, inquiryId, inquiryToken };
}
