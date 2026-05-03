import { useState, useRef, useCallback } from "react";
import { getSessionId } from "@/lib/session";
import type { ChatHistoryMessage } from "@workspace/api-client-react";

export interface Message extends ChatHistoryMessage {
  id: string;
  isStreaming?: boolean;
}

export function useChatStream() {
  const [messages, setMessages] = useState<Message[]>([
    {
      id: "welcome",
      role: "assistant",
      content: "Hi! Want to browse our menu, or get a hand planning your event?",
    },
  ]);
  const [isTyping, setIsTyping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  const sendMessage = useCallback(async (content: string) => {
    if (!content.trim()) return;

    setError(null);
    const sessionId = getSessionId();
    const userMsg: Message = { id: crypto.randomUUID(), role: "user", content };
    
    // Prepare history for API (exclude initial welcome and ids)
    const historyForApi = messages
      .filter(m => m.id !== "welcome")
      .map(({ role, content }) => ({ role, content }));

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

      while (true) {
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
              if (data.done) break;
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
              console.error("Failed to parse SSE chunk:", e);
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
  }, [messages]);

  return { messages, sendMessage, isTyping, error };
}
