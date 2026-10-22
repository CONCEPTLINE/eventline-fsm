"use client";

// Eine wartende Auftrags-Mail (Seite /auftraege/mails): Betreff, Absender,
// Text (aufklappbar), Anhaenge, Vorschlaege als Ein-Klick-Knoepfe,
// Auswahlfeld fuer einen anderen Auftrag, Verwerfen.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Check, ChevronDown, ChevronUp, Loader2, Paperclip, Trash2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { SearchableSelect, type SelectItem } from "@/components/searchable-select";
import { useConfirm } from "@/components/ui/use-confirm";
import { formatLocalDate, formatZurichDateTime } from "@/lib/utils";

export type WarteMail = {
  id: string;
  absender: string | null;
  betreff: string | null;
  empfangen_am: string;
  inhalt: string;
  anhaenge: { name: string; mime: string; groesse: number; url: string | null }[];
  vorschlaege: { job_id: string; grund: string; quelle: string; job_number: number; title: string | null; start_date: string | null }[];
};

export function MailKarte({ mail, auftraege, onErledigt }: { mail: WarteMail; auftraege: SelectItem[]; onErledigt: () => void }) {
  const router = useRouter();
  const { confirm, ConfirmModalElement } = useConfirm();
  const [offen, setOffen] = useState(false);
  const [wahl, setWahl] = useState("");
  const [laeuft, setLaeuft] = useState<string | null>(null); // job_id | "verwerfen"
  const lang = mail.inhalt.length > 400 || mail.inhalt.split("\n").length > 5;

  async function senden(body: { aktion: "zuordnen"; job_id: string } | { aktion: "verwerfen" }) {
    setLaeuft(body.aktion === "zuordnen" ? body.job_id : "verwerfen");
    try {
      const res = await fetch(`/api/auftrag-mails/${mail.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => ({}));
      if (res.status === 409) {
        toast.info(json.error ?? "Diese Mail wurde schon erledigt.");
        onErledigt();
        return;
      }
      if (!res.ok || !json.success) throw new Error(json.error ?? `HTTP ${res.status}`);
      if (body.aktion === "zuordnen") {
        const jobId = body.job_id;
        toast.success(`Mail im Eingang von INT-${json.job_number} abgelegt`, {
          description: "Die KI liest sie jetzt wie jede Auftrags-Mail.",
          action: { label: "Öffnen", onClick: () => router.push(`/auftraege/${jobId}?tab=eingang`) },
        });
      } else {
        toast.success("Mail verworfen");
      }
      onErledigt();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setLaeuft(null);
    }
  }

  async function verwerfen() {
    const ok = await confirm({
      title: "Mail verwerfen?",
      message: `«${mail.betreff || "(kein Betreff)"}» gehört zu keinem Auftrag — Text und Anhänge werden gelöscht.`,
      confirmLabel: "Verwerfen",
      variant: "red",
    });
    if (ok) senden({ aktion: "verwerfen" });
  }

  const beschaeftigt = laeuft !== null;

  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="font-semibold leading-snug break-words">{mail.betreff || "(kein Betreff)"}</p>
            <p className="text-xs text-muted-foreground mt-0.5 break-all">Von {mail.absender ?? "?"}</p>
          </div>
          <span className="text-xs text-muted-foreground whitespace-nowrap shrink-0">{formatZurichDateTime(mail.empfangen_am)}</span>
        </div>

        {mail.inhalt ? (
          <div>
            <p className={`text-sm text-foreground/80 whitespace-pre-wrap break-words ${offen ? "max-h-96 overflow-y-auto" : "line-clamp-4"}`}>
              {mail.inhalt}
            </p>
            {lang && (
              <button type="button" onClick={() => setOffen((o) => !o)} className="kasten kasten-muted mt-1.5">
                {offen ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                {offen ? "Weniger anzeigen" : "Ganze Mail anzeigen"}
              </button>
            )}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground italic">(kein Text)</p>
        )}

        {mail.anhaenge.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {mail.anhaenge.map((a, i) => (
              <AnhangLink key={i} name={a.name} url={a.url} />
            ))}
          </div>
        )}

        <div className="border-t border-border pt-3 space-y-2">
          {mail.vorschlaege.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[11px] uppercase tracking-wide text-muted-foreground mr-1">Wahrscheinlich</span>
              {mail.vorschlaege.map((v) => (
                <button
                  key={v.job_id}
                  type="button"
                  disabled={beschaeftigt}
                  onClick={() => senden({ aktion: "zuordnen", job_id: v.job_id })}
                  className="kasten kasten-green max-w-full"
                  data-tooltip={`${v.grund}${v.start_date ? ` · Auftrag am ${formatLocalDate(v.start_date)}` : ""} — Klick legt die Mail dort ab`}
                >
                  {laeuft === v.job_id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                  <span className="truncate">
                    INT-{v.job_number} · {v.title ?? ""}
                  </span>
                  <span className="text-[11px] opacity-70 whitespace-nowrap">({v.grund})</span>
                </button>
              ))}
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex-1 min-w-[16rem] max-w-md">
              <SearchableSelect value={wahl} onChange={setWahl} items={auftraege} placeholder="Anderen Auftrag wählen …" />
            </div>
            <button
              type="button"
              disabled={!wahl || beschaeftigt}
              onClick={() => senden({ aktion: "zuordnen", job_id: wahl })}
              className="kasten kasten-blue"
            >
              {laeuft === wahl && wahl ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
              {laeuft === wahl && wahl ? "Wird abgelegt …" : "Zuordnen"}
            </button>
            <button type="button" disabled={beschaeftigt} onClick={verwerfen} className="kasten kasten-muted ml-auto" data-tooltip="Mail gehört zu keinem Auftrag">
              {laeuft === "verwerfen" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
              Verwerfen
            </button>
          </div>
        </div>
      </CardContent>
      {ConfirmModalElement}
    </Card>
  );
}

/** Anhang als Link (oeffnet die Datei in neuem Tab) — kein Kasten, Kasten
 *  sind Aktionen, keine Navigation. Hover state-driven (CLAUDE.md §3). */
function AnhangLink({ name, url }: { name: string; url: string | null }) {
  const [hover, setHover] = useState(false);
  const stil = "inline-flex items-center gap-1.5 max-w-full text-xs px-2 py-1 rounded-md border border-border";
  if (!url) {
    return (
      <span className={stil + " opacity-60"} data-tooltip="Anhang nicht abrufbar">
        <Paperclip className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">{name}</span>
      </span>
    );
  }
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className={stil}
      style={{ background: hover ? "color-mix(in oklab, var(--foreground) 8%, transparent)" : "transparent" }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      data-tooltip="Anhang öffnen"
    >
      <Paperclip className="h-3.5 w-3.5 shrink-0" />
      <span className="truncate">{name}</span>
    </a>
  );
}
