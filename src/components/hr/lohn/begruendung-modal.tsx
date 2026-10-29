"use client";

/**
 * Begründung für Lohndaten-Änderungen nach der Monatssperre (Lohn-Umbau Phase 2).
 *
 * Betrifft eine Änderung (Lohnzeile, Firmensätze, Anstellung) abgerechnete
 * Monate, antwortet der Server mit 409 { code: "begruendung_noetig", error,
 * betrifft_ab? }. Dann fragt dieses Modal nach einer Begründung (mind. 10
 * Zeichen) und sendet DENSELBEN Request mit `begruendung` erneut. Der Server
 * stellt daraus einen Antrag (Vier Augen, /rechte-antraege) und antwortet
 * { success: true, mode: "antrag", hinweis }.
 *
 * Verwendung (eine Stelle je Fläche, Element einmal rendern):
 *   const { senden, BegruendungModalElement } = useLohnSenden();
 *   const r = await senden({ url: "/api/hr/compensation", method: "POST", body });
 *   if (!r) return;                                  // Begründung abgebrochen
 *   if (!r.ok) { TOAST.errorOr(r.json.error); return; }
 *   if (!zeigeAntragHinweis(r.json)) toast.success("Gespeichert");
 *   return <>{…}{BegruendungModalElement}</>;
 */

import { useCallback, useId, useRef, useState } from "react";
import { FileWarning, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Modal } from "@/components/ui/modal";
import { formatDateFull } from "@/lib/format";

export const BEGRUENDUNG_MIN = 10;

export interface LohnAnfrage {
  url: string;
  method: "POST" | "PATCH";
  body: Record<string, unknown>;
}

export interface LohnJson {
  success?: boolean;
  error?: string;
  code?: string | null;
  mode?: string;
  hinweis?: string;
  warnung?: string | null;
  betrifft_ab?: string | null;
  [k: string]: unknown;
}

export interface LohnAntwort {
  ok: boolean;
  status: number;
  json: LohnJson;
}

async function schicke(a: LohnAnfrage, begruendung?: string): Promise<LohnAntwort> {
  try {
    const res = await fetch(a.url, {
      method: a.method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(begruendung ? { ...a.body, begruendung } : a.body),
    });
    const json = (await res.json().catch(() => ({}))) as LohnJson;
    return { ok: res.ok && json.success === true, status: res.status, json };
  } catch (e) {
    return { ok: false, status: 0, json: { success: false, error: `Netzwerkfehler: ${e instanceof Error ? e.message : String(e)}` } };
  }
}

function brauchtBegruendung(r: LohnAntwort): boolean {
  return r.status === 409 && r.json.code === "begruendung_noetig";
}

/** «TT.MM.JJJJ» aus betrifft_ab (ISO) oder aus der Server-Meldung «(ab TT.MM.JJJJ)». */
function abDatum(json: LohnJson): string | null {
  if (typeof json.betrifft_ab === "string" && /^\d{4}-\d{2}-\d{2}$/.test(json.betrifft_ab)) return formatDateFull(json.betrifft_ab);
  const t = /\(ab (\d{2}\.\d{2}\.\d{4})\)/.exec(json.error ?? "");
  return t ? t[1] : null;
}

/** mode «antrag» → Toast mit dem Hinweis des Servers (kein «gespeichert»). */
export function zeigeAntragHinweis(json: LohnJson): boolean {
  if (json.mode !== "antrag") return false;
  toast.info("Antrag gestellt", {
    description: json.hinweis ?? "Eine zweite Person bestätigt innert 24 h (Rechte-Anträge).",
    duration: 12000,
  });
  return true;
}

export function useLohnSenden() {
  const [offen, setOffen] = useState<{ anfrage: LohnAnfrage; ab: string | null } | null>(null);
  const [text, setText] = useState("");
  const [sendet, setSendet] = useState(false);
  const resolverRef = useRef<((r: LohnAntwort | null) => void) | null>(null);
  const feldId = useId();

  const senden = useCallback(async (anfrage: LohnAnfrage): Promise<LohnAntwort | null> => {
    const r = await schicke(anfrage);
    if (!brauchtBegruendung(r)) return r;
    return new Promise((resolve) => {
      resolverRef.current?.(null);
      resolverRef.current = resolve;
      setText("");
      setOffen({ anfrage, ab: abDatum(r.json) });
    });
  }, []);

  function abbrechen() {
    if (sendet) return;
    setOffen(null);
    resolverRef.current?.(null);
    resolverRef.current = null;
  }

  async function antragStellen() {
    if (!offen || sendet) return;
    const b = text.trim();
    if (b.length < BEGRUENDUNG_MIN) {
      toast.error(`Begründung: mindestens ${BEGRUENDUNG_MIN} Zeichen`);
      return;
    }
    setSendet(true);
    const r = await schicke(offen.anfrage, b);
    setSendet(false);
    if (brauchtBegruendung(r)) {
      toast.error(r.json.error ?? "Begründung nötig");
      return;
    }
    setOffen(null);
    resolverRef.current?.(r);
    resolverRef.current = null;
  }

  const laenge = text.trim().length;
  const BegruendungModalElement = (
    <Modal
      open={!!offen}
      onClose={abbrechen}
      closable={!sendet}
      title="Begründung nötig"
      icon={<FileWarning className="h-5 w-5 text-amber-500" />}
      size="md"
    >
      <p className="text-sm text-muted-foreground">
        Die Änderung betrifft abgerechnete Monate{offen?.ab ? ` ab ${offen.ab}` : ""}. Sie wird als Antrag gestellt; eine
        zweite Person (anderer Admin oder Vertretung) bestätigt innert 24 h. Danach schlägt das System Korrekturfassungen vor.
      </p>
      <div className="space-y-1">
        <label htmlFor={feldId} className="text-[10px] text-muted-foreground/70 ml-1">
          Begründung (Pflicht, mind. {BEGRUENDUNG_MIN} Zeichen)
        </label>
        <textarea
          id={feldId}
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={3}
          maxLength={1000}
          placeholder="z. B. Stundenlohn laut Vertrag CHF 26.00 statt 25.00"
          className="w-full px-3 py-2 text-sm rounded-lg border bg-background focus:outline-none focus:ring-2 focus:ring-ring/40 focus:border-ring resize-none"
        />
        {laenge < BEGRUENDUNG_MIN && (
          <p className="text-[10px] text-muted-foreground ml-1">noch {BEGRUENDUNG_MIN - laenge} Zeichen</p>
        )}
      </div>
      <div className="flex gap-2 pt-1">
        <button type="button" onClick={abbrechen} disabled={sendet} className="kasten kasten-muted flex-1">
          Abbrechen
        </button>
        <button
          type="button"
          onClick={() => void antragStellen()}
          disabled={sendet || laenge < BEGRUENDUNG_MIN}
          className="kasten kasten-red flex-1 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {sendet ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Wird gestellt…</> : "Antrag stellen"}
        </button>
      </div>
    </Modal>
  );

  return { senden, BegruendungModalElement };
}
