import { Loader2 } from "lucide-react";

export type MergeReplaceChoice = "merge" | "replace" | "cancel";

export function MergeReplaceDialog({
  open,
  title,
  message,
  busy,
  existingCount,
  incomingCount,
  onChoose,
}: {
  open: boolean;
  title: string;
  message: string;
  busy?: boolean;
  existingCount?: number;
  incomingCount?: number;
  onChoose: (c: MergeReplaceChoice) => void;
}) {
  if (!open) return null;
  const fmt = (n: number) => `${n} item${n === 1 ? "" : "s"}`;
  return (
    <div className="fixed inset-0 z-[120] bg-black/50 flex items-center justify-center px-4">
      <div className="bg-card rounded-3xl border border-border shadow-2xl max-w-md w-full p-6 sm:p-8">
        <h3 className="font-display font-bold text-2xl mb-2">{title}</h3>
        <p className="text-muted-foreground text-sm mb-6">{message}</p>
        <div className="flex flex-col gap-2">
          <button
            disabled={busy}
            onClick={() => onChoose("merge")}
            className="w-full px-4 py-3 rounded-xl bg-primary text-primary-foreground font-semibold hover:bg-primary/90 disabled:opacity-60 transition-colors flex items-center justify-center gap-2"
          >
            {busy && <Loader2 className="w-4 h-4 animate-spin" />}
            {existingCount != null && incomingCount != null
              ? `Add ${fmt(incomingCount)} to my existing ${fmt(existingCount)}`
              : "Add to my existing items"}
          </button>
          <button
            disabled={busy}
            onClick={() => onChoose("replace")}
            className="w-full px-4 py-3 rounded-xl bg-secondary text-foreground font-semibold hover:bg-secondary/80 disabled:opacity-60 transition-colors"
          >
            {existingCount != null
              ? `Replace my ${fmt(existingCount)} with this package`
              : "Replace with this package"}
          </button>
          <button
            disabled={busy}
            onClick={() => onChoose("cancel")}
            className="w-full px-4 py-3 rounded-xl text-muted-foreground font-semibold hover:text-foreground disabled:opacity-60 transition-colors"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
