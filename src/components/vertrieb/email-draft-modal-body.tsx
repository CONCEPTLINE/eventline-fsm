"use client";

import { Sparkles, Copy, Check, Mail, Loader2 } from "lucide-react";

type CopyTarget = "betreff" | "text" | "all" | null;

interface Props {
  recipientEmail?: string | null;
  generating: boolean;
  betreff: string;
  setBetreff: (v: string) => void;
  text: string;
  setText: (v: string) => void;
  copied: CopyTarget;
  onCopy: (what: "betreff" | "text" | "all") => void;
  onRegenerate: () => void | Promise<void>;
  onClose: () => void;
}

export function EmailDraftModalBody({
  recipientEmail,
  generating,
  betreff,
  setBetreff,
  text,
  setText,
  copied,
  onCopy,
  onRegenerate,
  onClose,
}: Props) {
  return (
    <>
      {recipientEmail && (
        <p className="text-xs text-muted-foreground flex items-center gap-1.5">
          <Mail className="h-3.5 w-3.5" />Empfänger: <strong className="text-foreground">{recipientEmail}</strong>
        </p>
      )}

      {generating ? (
        <div className="flex flex-col items-center justify-center gap-3 py-12 text-muted-foreground">
          <Loader2 className="h-6 w-6 animate-spin text-red-600" />
          <p className="text-sm">KI schreibt die E-Mail…</p>
        </div>
      ) : (
        <>
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-sm font-medium">Betreff</label>
              <button type="button" onClick={() => onCopy("betreff")} className="text-xs flex items-center gap-1 text-muted-foreground hover:text-red-600">
                {copied === "betreff" ? <><Check className="h-3 w-3" />Kopiert</> : <><Copy className="h-3 w-3" />Kopieren</>}
              </button>
            </div>
            <input
              value={betreff}
              onChange={(e) => setBetreff(e.target.value)}
              className="w-full h-9 px-3 text-sm rounded-lg border border-gray-200 bg-gray-50 dark:bg-gray-800 focus:outline-none focus:ring-2 focus:ring-red-500/20"
            />
          </div>

          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-sm font-medium">Text</label>
              <button type="button" onClick={() => onCopy("text")} className="text-xs flex items-center gap-1 text-muted-foreground hover:text-red-600">
                {copied === "text" ? <><Check className="h-3 w-3" />Kopiert</> : <><Copy className="h-3 w-3" />Kopieren</>}
              </button>
            </div>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={12}
              className="w-full px-3 py-2 text-sm rounded-lg border border-gray-200 bg-gray-50 dark:bg-gray-800 resize-y leading-relaxed focus:outline-none focus:ring-2 focus:ring-red-500/20"
            />
          </div>
        </>
      )}

      <div className="flex gap-3">
        <button type="button" onClick={onRegenerate} disabled={generating} className="kasten kasten-muted disabled:opacity-50">
          <Sparkles className="h-3.5 w-3.5" />Neu generieren
        </button>
        <button
          type="button"
          onClick={() => onCopy("all")}
          disabled={generating || !text}
          className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-medium rounded-lg bg-red-600 text-white hover:bg-red-700 disabled:opacity-50"
        >
          {copied === "all" ? <><Check className="h-4 w-4" />Kopiert</> : <><Copy className="h-4 w-4" />Alles kopieren</>}
        </button>
      </div>
    </>
  );
}
