"use client";

/**
 * Nachfassen im Kontakt-Detail: Stand (fällig seit / ab …), KI-Vorschlag
 * vorbereiten (/api/vertrieb/nachfass), Text bearbeiten (speichert beim
 * Verlassen des Felds), kopieren und «Als nachgefasst markieren».
 * Kein Versand aus dem FSM. Regeln: src/lib/vertrieb/nachfassen.ts.
 */

import { useState } from "react";
import { toast } from "sonner";
import { Check, Copy, Loader2, Sparkles } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { Input } from "@/components/ui/input";
import { AutoTextarea } from "@/components/ui/auto-textarea";
import { TOAST } from "@/lib/messages";
import { datumKurz } from "@/lib/vertrieb/kampagnen";
import { NACHFASS_MAX, nachfassStand } from "@/lib/vertrieb/nachfassen";
import type { KampagneKontakt } from "@/types/vertrieb";

interface Props {
  k: KampagneKontakt;
  darfBearbeiten: boolean;
  onAenderung: (patch: Partial<KampagneKontakt>) => void;
}

/** Zeigen, wenn fällig, schon ein Text da ist oder schon nachgefasst wurde. */
export function zeigeNachfassen(k: KampagneKontakt): boolean {
  if (k.antworten_anzahl > 0) return false;
  return nachfassStand(k).faellig || !!k.nachfass_text || (k.status === "gesendet" && k.nachfass_anzahl > 0);
}

export function KampagneNachfassen({ k, darfBearbeiten, onAenderung }: Props) {
  const supabase = createClient();
  const stand = nachfassStand(k);
  const [betreff, setBetreff] = useState(k.nachfass_betreff ?? "");
  const [text, setText] = useState(k.nachfass_text ?? "");
  const [bereitet, setBereitet] = useState(false);
  const [markiert, setMarkiert] = useState(false);
  const [speichert, setSpeichert] = useState(false);

  async function vorbereiten() {
    setBereitet(true);
    try {
      const res = await fetch("/api/vertrieb/nachfass", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: k.id }),
      });
      const j = await res.json().catch(() => null);
      if (!res.ok || !j?.ok) { toast.error(j?.error ?? "Vorschlag konnte nicht erstellt werden"); return; }
      setBetreff(j.betreff);
      setText(j.text);
      onAenderung({ nachfass_betreff: j.betreff, nachfass_text: j.text });
      toast.success("Nachfass-Mail vorbereitet");
    } catch {
      TOAST.networkError("Vorbereiten");
    } finally {
      setBereitet(false);
    }
  }

  async function speichern(feld: "nachfass_betreff" | "nachfass_text", wert: string) {
    const neu = wert.trim() === "" ? null : wert;
    if (neu === (k[feld] ?? null)) return;
    setSpeichert(true);
    const { error } = await supabase.from("vertrieb_kampagne_kontakte").update({ [feld]: neu }).eq("id", k.id);
    setSpeichert(false);
    if (error) { TOAST.supabaseError(error, "Speichern fehlgeschlagen"); return; }
    onAenderung({ [feld]: neu });
  }

  async function kopieren() {
    try {
      await navigator.clipboard.writeText(text);
      toast.success("Nachfass-Text kopiert");
    } catch {
      toast.error("Kopieren nicht möglich");
    }
  }

  async function alsNachgefasst() {
    setMarkiert(true);
    const patch = {
      nachgefasst_am: new Date().toISOString(),
      nachfass_anzahl: k.nachfass_anzahl + 1,
      // Der Text dieser Runde ist erledigt — die nächste Runde bekommt einen neuen.
      nachfass_betreff: null,
      nachfass_text: null,
    };
    const { data, error } = await supabase
      .from("vertrieb_kampagne_kontakte")
      .update(patch)
      .eq("id", k.id)
      .eq("nachfass_anzahl", k.nachfass_anzahl) // doppelter Klick zählt nicht doppelt
      .select("id");
    setMarkiert(false);
    if (error) { TOAST.supabaseError(error, "Markieren fehlgeschlagen"); return; }
    if (!data?.length) { toast.error("Wurde inzwischen schon markiert — bitte neu öffnen"); return; }
    setBetreff("");
    setText("");
    onAenderung(patch);
    toast.success(patch.nachfass_anzahl >= NACHFASS_MAX ? "Als nachgefasst markiert (letzte Runde)" : "Als nachgefasst markiert");
  }

  const info = stand.fertig
    ? `${NACHFASS_MAX}× nachgefasst — keine weitere Runde`
    : stand.faellig && stand.faelligAb
      ? `Fällig seit ${datumKurz(stand.faelligAb)}`
      : stand.faelligAb
        ? `Wieder fällig ab ${datumKurz(stand.faelligAb)}`
        : null;

  return (
    <section>
      <div className="mb-1 flex items-center gap-2">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-orange-700 dark:text-orange-300">Nachfassen</p>
        {info && <span className="text-[11px] text-muted-foreground">· {info}</span>}
        {k.nachgefasst_am && <span className="text-[11px] text-muted-foreground">· zuletzt {datumKurz(k.nachgefasst_am)}</span>}
        {speichert && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
      </div>

      {text || betreff ? (
        <div className="overflow-hidden rounded-lg border border-orange-300 dark:border-orange-500/40">
          <div className="border-b border-orange-200 bg-orange-50 px-3 py-2 dark:border-orange-500/30 dark:bg-orange-500/10">
            {darfBearbeiten ? (
              <Input
                value={betreff}
                onChange={(e) => setBetreff(e.target.value)}
                onBlur={() => void speichern("nachfass_betreff", betreff)}
                placeholder="Betreff"
                className="h-8 bg-card text-sm font-semibold"
                aria-label="Betreff Nachfass-Mail"
              />
            ) : (
              <p className="text-sm font-semibold">{betreff}</p>
            )}
          </div>
          {darfBearbeiten ? (
            <AutoTextarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              onBlur={() => void speichern("nachfass_text", text)}
              className="min-h-[7rem] w-full border-0 bg-transparent px-4 py-3 text-sm leading-relaxed focus:outline-none"
            />
          ) : (
            <p className="whitespace-pre-wrap px-4 py-3 text-sm leading-relaxed">{text}</p>
          )}
          <div className="flex flex-wrap items-center gap-2 border-t border-orange-200 px-3 py-2 dark:border-orange-500/30">
            <button type="button" onClick={() => void kopieren()} disabled={!text.trim()} className="kasten kasten-muted text-xs">
              <Copy className="h-3 w-3" />Text kopieren
            </button>
            {darfBearbeiten && (
              <button type="button" onClick={() => void alsNachgefasst()} disabled={markiert} className="kasten kasten-green ml-auto text-xs">
                {markiert ? <><Loader2 className="h-3 w-3 animate-spin" />Wird markiert…</> : <><Check className="h-3 w-3" />Als nachgefasst markieren</>}
              </button>
            )}
          </div>
        </div>
      ) : darfBearbeiten && stand.faellig ? (
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => void vorbereiten()} disabled={bereitet || !k.mail_text} className="kasten kasten-amber">
            {bereitet
              ? <><Loader2 className="h-3.5 w-3.5 animate-spin" />Wird vorbereitet…</>
              : <><Sparkles className="h-3.5 w-3.5" />Nachfass-Mail vorbereiten</>}
          </button>
          <button type="button" onClick={() => void alsNachgefasst()} disabled={markiert} className="kasten kasten-muted">
            {markiert ? <><Loader2 className="h-3.5 w-3.5 animate-spin" />Wird markiert…</> : <><Check className="h-3.5 w-3.5" />Als nachgefasst markieren</>}
          </button>
        </div>
      ) : null}
    </section>
  );
}
