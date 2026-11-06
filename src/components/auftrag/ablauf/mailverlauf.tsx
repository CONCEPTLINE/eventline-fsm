"use client";

/**
 * Mailverlauf des Auftrags: eingehende/ausgehende Mails (alle über
 * auftrag@ zugeordnet) plus Ereignisse des Ablaufs. Ereignisse, die einen
 * Schritt abgehakt haben, lassen sich zurücknehmen.
 */

import { useState } from "react";
import { ArrowDownLeft, ArrowUpRight, ChevronDown, Loader2, Paperclip, Sparkles, Undo2 } from "lucide-react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { zeitstempel } from "./format";

export type MailEintrag = {
  id: string;
  art: "ein" | "aus";
  zeit: string;
  von: string;
  an: string;
  /** auftrag@ stand in CC. */
  ccAuftrag: boolean;
  betreff: string;
  auszug: string;
  anhaenge: string[];
};

export type SystemEintrag = {
  id: string;
  art: "system";
  zeit: string;
  text: string;
  /** Hat eine Wirkung, die sich noch zurücknehmen lässt. */
  ruecknehmbar: boolean;
  /** «aus Mail erkannt» · «von Hand» · «System» */
  quelle: string;
  rueckgaengig: boolean;
};

export type VerlaufEintrag = MailEintrag | SystemEintrag;

function RueckgaengigKnopf({ onClick, laedt, disabled }: { onClick: () => void; laedt: boolean; disabled: boolean }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className="inline-flex items-center gap-1 text-[11px] font-medium rounded px-1.5 py-0.5 transition-colors disabled:opacity-60"
      style={{
        color: hover ? "var(--foreground)" : "var(--muted-foreground)",
        background: hover ? "color-mix(in oklab, var(--foreground) 8%, transparent)" : "transparent",
      }}
      data-tooltip="Schritt wieder öffnen"
    >
      {laedt ? <Loader2 className="h-3 w-3 animate-spin" /> : <Undo2 className="h-3 w-3" />}
      {laedt ? "Wird zurückgenommen…" : "Rückgängig"}
    </button>
  );
}

export function Mailverlauf({
  eintraege,
  onRueckgaengig,
  nurLesen,
}: {
  /** Chronologisch aufsteigend. */
  eintraege: VerlaufEintrag[];
  onRueckgaengig: (id: string) => Promise<void>;
  nurLesen: boolean;
}) {
  const [alle, setAlle] = useState(false);
  const [hoverAlle, setHoverAlle] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const umgekehrt = [...eintraege].reverse();
  // Nur die neusten 3 zeigen, ältere einklappen.
  const liste = alle ? umgekehrt : umgekehrt.slice(0, 3);
  const versteckt = umgekehrt.length - liste.length;

  async function zuruecknehmen(id: string) {
    setBusy(id);
    try {
      await onRueckgaengig(id);
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card className="bg-card">
      <CardHeader className="pb-0">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Mailverlauf
          <span className="normal-case tracking-normal font-normal"> · {eintraege.filter((e) => e.art !== "system").length} Mails</span>
        </p>
      </CardHeader>
      <CardContent>
        {liste.length === 0 && <p className="text-xs text-muted-foreground">Noch keine Mails zu diesem Auftrag.</p>}
        <ol className="relative">
          {liste.map((e, i) => {
            const letzter = i === liste.length - 1;
            if (e.art === "system") {
              return (
                <li key={e.id} className="relative flex gap-3 pb-3">
                  {!letzter && <span aria-hidden className="absolute left-[11px] top-6 bottom-0 w-px bg-border" />}
                  <span
                    className="h-6 w-6 shrink-0 rounded-full flex items-center justify-center"
                    style={{ background: "color-mix(in oklab, var(--accent) 14%, transparent)", color: "var(--accent)" }}
                  >
                    <Sparkles className="h-3 w-3" />
                  </span>
                  <div className="min-w-0 flex-1 pt-0.5">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                      <span className={`text-xs ${e.rueckgaengig ? "line-through text-muted-foreground" : "font-medium"}`}>{e.text}</span>
                      {e.ruecknehmbar && !e.rueckgaengig && !nurLesen && (
                        <RueckgaengigKnopf onClick={() => zuruecknehmen(e.id)} laedt={busy === e.id} disabled={busy !== null} />
                      )}
                      {e.rueckgaengig && <span className="text-[11px] text-muted-foreground">zurückgenommen</span>}
                    </div>
                    <span className="text-[11px] text-muted-foreground tabular-nums">
                      {zeitstempel(e.zeit)} · {e.quelle}
                    </span>
                  </div>
                </li>
              );
            }
            const aus = e.art === "aus";
            return (
              <li key={e.id} className="relative flex gap-3 pb-3">
                {!letzter && <span aria-hidden className="absolute left-[11px] top-6 bottom-0 w-px bg-border" />}
                <span
                  className="h-6 w-6 shrink-0 rounded-full flex items-center justify-center"
                  style={{
                    background: aus ? "color-mix(in oklab, var(--status-blue) 16%, transparent)" : "color-mix(in oklab, var(--foreground) 9%, transparent)",
                    color: aus ? "var(--status-blue)" : "var(--muted-foreground)",
                  }}
                  data-tooltip={aus ? "Ausgehend" : "Eingehend"}
                >
                  {aus ? <ArrowUpRight className="h-3.5 w-3.5" /> : <ArrowDownLeft className="h-3.5 w-3.5" />}
                </span>
                <div className="min-w-0 flex-1 rounded-lg border border-border px-3 py-2">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
                    <span className="tabular-nums">{zeitstempel(e.zeit)}</span>
                    <span className="truncate">
                      {e.von} → {e.an}
                    </span>
                    {e.ccAuftrag && (
                      <span className="inline-flex items-center px-1.5 rounded-full bg-foreground/[0.06] dark:bg-foreground/[0.12] font-medium">
                        CC auftrag@
                      </span>
                    )}
                  </div>
                  <p className="text-sm font-medium mt-0.5">{e.betreff}</p>
                  {e.auszug && <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{e.auszug}</p>}
                  {e.anhaenge.length > 0 && (
                    <p className="text-[11px] text-muted-foreground mt-1 flex items-center gap-1 flex-wrap">
                      <Paperclip className="h-3 w-3" />
                      {e.anhaenge.join(" · ")}
                    </p>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
        {(versteckt > 0 || (alle && umgekehrt.length > 3)) && (
          <button
            type="button"
            onClick={() => setAlle((a) => !a)}
            onMouseEnter={() => setHoverAlle(true)}
            onMouseLeave={() => setHoverAlle(false)}
            className="ml-8 inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs transition-colors"
            style={{
              color: hoverAlle ? "var(--foreground)" : "var(--muted-foreground)",
              background: hoverAlle ? "color-mix(in oklab, var(--foreground) 7%, transparent)" : "transparent",
            }}
          >
            <ChevronDown className={`h-3.5 w-3.5 transition-transform ${alle ? "rotate-180" : ""}`} />
            {alle ? "weniger anzeigen" : `alle anzeigen (${versteckt} ältere)`}
          </button>
        )}
      </CardContent>
    </Card>
  );
}
