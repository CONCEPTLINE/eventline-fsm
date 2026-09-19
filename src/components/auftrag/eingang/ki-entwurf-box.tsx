"use client";

/**
 * KiEntwurfBox — auf /auftraege/neu: Kunden-Mail oder diktierten Satz
 * einfuegen, «Ausfüllen» — die KI extrahiert die Eckdaten und der Parent
 * uebernimmt sie ins Formular (Erfassen wird Kontrolle statt Tipparbeit).
 * Einklappbar, damit die Seite fuer den normalen Weg schlank bleibt.
 */

import { useState } from "react";
import { toast } from "sonner";
import { Sparkles, Loader2, ChevronDown, ChevronRight } from "lucide-react";

export type KiEntwurf = {
  titel: string | null;
  beschreibung: string | null;
  kunde_name: string | null;
  ort_name: string | null;
  adresse: string | null;
  start_datum: string | null;
  end_datum: string | null;
  kontakt_person: string | null;
  kontakt_telefon: string | null;
  kontakt_email: string | null;
};

export function KiEntwurfBox({ onEntwurf }: { onEntwurf: (e: KiEntwurf) => void }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  async function ausfuellen() {
    const t = text.trim();
    if (t.length < 10 || busy) return;
    setBusy(true);
    try {
      const res = await fetch("/api/ai/auftrag-entwurf", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: t }),
      });
      const j = await res.json();
      if (!res.ok || !j.success) throw new Error(j.error || "Anfrage fehlgeschlagen");
      onEntwurf(j.entwurf as KiEntwurf);
      toast.success("Formular ausgefüllt — bitte kontrollieren");
      setOpen(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Anfrage fehlgeschlagen");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-2xl border border-border bg-card mb-4 overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full px-4 py-2.5 flex items-center gap-2 text-sm font-semibold hover:bg-foreground/[0.03] dark:hover:bg-foreground/[0.06]"
      >
        {open ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
        <Sparkles className="h-4 w-4 text-muted-foreground" />
        Aus Text ausfüllen
        <span className="text-[11px] font-normal text-muted-foreground">— Kunden-Mail einfügen oder Auftrag diktieren</span>
      </button>
      {open && (
        <div className="px-4 pb-3 space-y-2">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={5}
            placeholder={"z.B. die weitergeleitete Kunden-Mail — oder:\n«Aufbau Hochzeit im Volkshaus am 12. Oktober, Kontakt Frau Meier 079 …»"}
            className="w-full text-sm rounded-xl border border-border bg-muted/20 px-3 py-2 focus:outline-none focus:border-foreground/40 resize-y"
          />
          <div className="flex justify-end">
            <button type="button" onClick={ausfuellen} disabled={text.trim().length < 10 || busy} className="kasten kasten-red">
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
              {busy ? "Liest…" : "Ausfüllen"}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
