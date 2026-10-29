"use client";

/**
 * Anstellung (Lohn-Umbau Phase 2, Migration 364) — kompakte Karte im
 * Lohn-Editor einer Person (Lohn › Mitarbeiter-Lohn): Eintritt, Austritt,
 * ruhend von–bis, Vertragsart, befristet bis, Pensum, AHV-Beiträge auch
 * unter CHF 2'500 verlangt (je Jahr). Nur was der Lohn im ERP braucht;
 * Personalien gehören ins Backoffice.
 *
 * GET/POST /api/hr/anstellungen. Ändern schickt nur geänderte Felder.
 * Betrifft die Änderung abgerechnete Monate, fragt das Begründungs-Modal
 * nach (Antrag, Vier Augen). Die eigene Anstellung ändert eine zweite Person.
 */

import { useEffect, useState } from "react";
import { AlertTriangle, Briefcase, Info, Loader2, Pencil, Plus } from "lucide-react";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { SearchableSelect } from "@/components/searchable-select";
import { TOAST } from "@/lib/messages";
import { formatDateFull } from "@/lib/format";
import { todayLocalIso } from "@/lib/swiss-time";
import { useLohnSenden, zeigeAntragHinweis } from "@/components/hr/lohn/begruendung-modal";

type Vertragsart = "abruf_unecht" | "abruf_echt" | "fest";

interface Anstellung {
  id: string;
  profile_id: string;
  eintritt: string;
  austritt: string | null;
  ruhend_von: string | null;
  ruhend_bis: string | null;
  vertragsart: Vertragsart;
  befristet_bis: string | null;
  pensum_pct: number | string | null;
  ahv_verlangt_jahre: number[] | null;
  notiz: string | null;
}

const VERTRAGSART: Record<Vertragsart, string> = {
  abruf_unecht: "Arbeit auf Abruf (unecht)",
  abruf_echt: "Arbeit auf Abruf (echt)",
  fest: "Festanstellung",
};

/** Formular-Entwurf (Datumsfelder als "" = leer). */
interface Entwurf {
  eintritt: string;
  austritt: string;
  ruhend_von: string;
  ruhend_bis: string;
  vertragsart: Vertragsart;
  befristet_bis: string;
  pensum: string;
  jahre: number[];
  notiz: string;
}

function pensumText(v: number | string | null): string {
  if (v == null || v === "") return "";
  const n = Number(v);
  return Number.isFinite(n) ? String(n) : "";
}

function ausAnstellung(a: Anstellung | null): Entwurf {
  return {
    eintritt: a?.eintritt ?? "",
    austritt: a?.austritt ?? "",
    ruhend_von: a?.ruhend_von ?? "",
    ruhend_bis: a?.ruhend_bis ?? "",
    vertragsart: a?.vertragsart ?? "abruf_unecht",
    befristet_bis: a?.befristet_bis ?? "",
    pensum: pensumText(a?.pensum_pct ?? null),
    jahre: [...(a?.ahv_verlangt_jahre ?? [])].sort((x, y) => x - y),
    notiz: a?.notiz ?? "",
  };
}

/** Werte so, wie die API sie erwartet (leer → null). */
function alsWerte(e: Entwurf): Record<string, unknown> {
  return {
    eintritt: e.eintritt,
    austritt: e.austritt || null,
    ruhend_von: e.ruhend_von || null,
    ruhend_bis: e.ruhend_bis || null,
    vertragsart: e.vertragsart,
    befristet_bis: e.befristet_bis || null,
    pensum_pct: e.pensum.trim() ? Number(e.pensum.replace(",", ".")) : null,
    ahv_verlangt_jahre: e.jahre,
    notiz: e.notiz.trim() || null,
  };
}

function pruefe(e: Entwurf): string | null {
  if (!e.eintritt) return "Eintritt fehlt";
  if (e.austritt && e.austritt < e.eintritt) return "Austritt liegt vor dem Eintritt";
  if (e.ruhend_bis && !e.ruhend_von) return "«Ruhend bis» braucht ein «Ruhend von»";
  if (e.ruhend_von && e.ruhend_bis && e.ruhend_bis < e.ruhend_von) return "«Ruhend bis» liegt vor «Ruhend von»";
  if (e.pensum.trim()) {
    const p = Number(e.pensum.replace(",", "."));
    if (!(p > 0 && p <= 100)) return "Pensum: 1–100 %";
  }
  return null;
}

/** Jahre für die AHV-Wahl: ab Eintritt (frühestens 2020) bis Austritt bzw. nächstes Jahr, höchstens 8. */
function jahrAuswahl(e: Entwurf): number[] {
  const heute = Number(todayLocalIso().slice(0, 4));
  const bis = Math.min(e.austritt ? Number(e.austritt.slice(0, 4)) : heute + 1, 2100);
  const von = Math.max(e.eintritt ? Number(e.eintritt.slice(0, 4)) : heute - 1, 2020, bis - 7);
  const set = new Set<number>(e.jahre);
  for (let j = von; j <= bis; j++) set.add(j);
  return Array.from(set).sort((a, b) => a - b);
}

function fmt(iso: string | null): string {
  return iso ? formatDateFull(iso) : "offen";
}

export function AnstellungKarte({ profileId, gesperrt, onBeschaeftigt }: {
  profileId: string;
  gesperrt: boolean;
  /** Speichern läuft (inkl. offenem Begründungs-Modal) — der Lohn-Editor
   *  schliesst dann nicht per Esc/Hintergrund mit. */
  onBeschaeftigt?: (b: boolean) => void;
}) {
  const [liste, setListe] = useState<Anstellung[] | null>(null);
  const [version, setVersion] = useState(0);
  // null = Ansicht, "neu" = erfassen, sonst id der bearbeiteten Anstellung
  const [bearbeite, setBearbeite] = useState<string | null>(null);
  const [entwurf, setEntwurf] = useState<Entwurf>(() => ausAnstellung(null));
  const [speichert, setSpeichert] = useState(false);
  const { senden, BegruendungModalElement } = useLohnSenden();

  useEffect(() => {
    let aktiv = true;
    fetch(`/api/hr/anstellungen?profile_id=${encodeURIComponent(profileId)}`, { cache: "no-store" })
      .then((r) => r.json().catch(() => ({})).then((j) => ({ ok: r.ok, j })))
      .then(({ ok, j }) => {
        if (!aktiv) return;
        if (!ok || !j.success) {
          toast.error(`Anstellung: ${j.error ?? "konnte nicht geladen werden"}`);
          setListe([]);
          return;
        }
        setListe((j.anstellungen ?? []) as Anstellung[]);
      })
      .catch((err) => {
        if (!aktiv) return;
        toast.error(`Anstellung: ${err instanceof Error ? err.message : String(err)}`);
        setListe([]);
      });
    return () => { aktiv = false; };
  }, [profileId, version]);

  function oeffne(a: Anstellung | null) {
    setEntwurf(ausAnstellung(a));
    setBearbeite(a?.id ?? "neu");
  }

  const setze = <K extends keyof Entwurf>(k: K, v: Entwurf[K]) => setEntwurf((e) => ({ ...e, [k]: v }));

  async function speichern() {
    const fehler = pruefe(entwurf);
    if (fehler) { toast.error(fehler); return; }
    const werte = alsWerte(entwurf);
    let body: Record<string, unknown>;
    if (bearbeite === "neu") {
      body = { profile_id: profileId, ...werte };
    } else {
      const original = liste?.find((a) => a.id === bearbeite);
      if (!original) { toast.error("Anstellung nicht mehr vorhanden — bitte neu öffnen"); return; }
      const alt = alsWerte(ausAnstellung(original));
      body = { id: original.id };
      for (const [k, v] of Object.entries(werte)) {
        if (JSON.stringify(v) !== JSON.stringify(alt[k])) body[k] = v;
      }
      if (Object.keys(body).length === 1) { setBearbeite(null); return; }
    }
    setSpeichert(true);
    onBeschaeftigt?.(true);
    const r = await senden({ url: "/api/hr/anstellungen", method: "POST", body });
    setSpeichert(false);
    onBeschaeftigt?.(false);
    if (!r) return;
    if (!r.ok) { TOAST.errorOr(r.json.error); return; }
    if (!zeigeAntragHinweis(r.json)) toast.success(r.json.mode === "angelegt" ? "Anstellung erfasst" : "Anstellung geändert");
    if (r.json.warnung) toast.warning(r.json.warnung);
    setBearbeite(null);
    setVersion((v) => v + 1);
  }

  // Neue Anstellung nur, wenn keine offene (ohne Austritt) besteht — sonst
  // überlappten zwei Anstellungen.
  const kannErfassen = !gesperrt && bearbeite === null && liste !== null && liste.every((a) => !!a.austritt);

  return (
    <div className="pt-3 border-t border-foreground/10 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
          <Briefcase className="h-3 w-3" />
          Anstellung
        </p>
        {kannErfassen && (
          <button type="button" onClick={() => oeffne(null)} className="kasten kasten-muted text-xs">
            <Plus className="h-3 w-3" /> Erfassen
          </button>
        )}
      </div>

      {liste === null ? (
        <div className="shimmer rounded-md h-9" />
      ) : (
        <>
          {liste.length === 0 && bearbeite === null && (
            <p className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
              <Info className="h-3 w-3 mt-0.5 shrink-0" />
              Anstellung nicht erfasst — Lohn wird für den ganzen Monat gerechnet.
            </p>
          )}
          {liste.map((a) =>
            bearbeite === a.id ? null : (
              <div key={a.id} className="flex items-start gap-2 px-2.5 py-2 rounded-lg border border-border bg-muted/40 text-xs">
                <div className="min-w-0 flex-1">
                  <p className="font-medium tabular-nums">
                    {formatDateFull(a.eintritt)} – {fmt(a.austritt)}
                    <span className="font-normal text-muted-foreground"> · {VERTRAGSART[a.vertragsart] ?? a.vertragsart}</span>
                  </p>
                  <p className="text-[11px] text-muted-foreground">
                    {[
                      pensumText(a.pensum_pct) ? `Pensum ${pensumText(a.pensum_pct)} %` : null,
                      a.befristet_bis ? `befristet bis ${formatDateFull(a.befristet_bis)}` : null,
                      a.ruhend_von ? `ruhend ${formatDateFull(a.ruhend_von)} – ${fmt(a.ruhend_bis)}` : null,
                      (a.ahv_verlangt_jahre ?? []).length > 0 ? `AHV unter CHF 2'500 verlangt: ${[...(a.ahv_verlangt_jahre ?? [])].sort((x, y) => x - y).join(", ")}` : null,
                    ].filter(Boolean).join(" · ") || "unbefristet"}
                  </p>
                  {a.notiz && <p className="text-[11px] text-muted-foreground/80 italic truncate">{a.notiz}</p>}
                </div>
                {!gesperrt && bearbeite === null && (
                  <button type="button" onClick={() => oeffne(a)} className="kasten kasten-muted text-xs shrink-0">
                    <Pencil className="h-3 w-3" /> Bearbeiten
                  </button>
                )}
              </div>
            ),
          )}
          {bearbeite !== null && (
            <AnstellungFormular
              entwurf={entwurf}
              setze={setze}
              neu={bearbeite === "neu"}
              speichert={speichert}
              onAbbrechen={() => setBearbeite(null)}
              onSpeichern={() => void speichern()}
            />
          )}
        </>
      )}
      {BegruendungModalElement}
    </div>
  );
}

function AnstellungFormular({
  entwurf: e, setze, neu, speichert, onAbbrechen, onSpeichern,
}: {
  entwurf: Entwurf;
  setze: <K extends keyof Entwurf>(k: K, v: Entwurf[K]) => void;
  neu: boolean;
  speichert: boolean;
  onAbbrechen: () => void;
  onSpeichern: () => void;
}) {
  const fehler = pruefe(e);
  const jahre = jahrAuswahl(e);
  const toggleJahr = (j: number) =>
    setze("jahre", e.jahre.includes(j) ? e.jahre.filter((x) => x !== j) : [...e.jahre, j].sort((a, b) => a - b));

  return (
    <div className="p-2.5 rounded-lg border border-border bg-muted/40 space-y-2">
      <div className="grid grid-cols-2 gap-2">
        <Feld label="Eintritt *">
          <Input type="date" value={e.eintritt} onChange={(ev) => setze("eintritt", ev.target.value)} className="h-8 text-xs" />
        </Feld>
        <Feld label="Austritt">
          <Input type="date" value={e.austritt} min={e.eintritt || undefined} onChange={(ev) => setze("austritt", ev.target.value)} className="h-8 text-xs" />
        </Feld>
        <Feld label="Vertragsart" className="col-span-2">
          <SearchableSelect
            value={e.vertragsart}
            onChange={(v) => { if (v) setze("vertragsart", v as Vertragsart); }}
            items={(Object.keys(VERTRAGSART) as Vertragsart[]).map((k) => ({ id: k, label: VERTRAGSART[k] }))}
            searchable={false}
            clearable={false}
          />
        </Feld>
        <Feld label="Pensum %">
          <Input type="text" inputMode="decimal" value={e.pensum} onChange={(ev) => setze("pensum", ev.target.value)} placeholder="z. B. 40" className="h-8 text-xs" />
        </Feld>
        <Feld label="Befristet bis">
          <Input type="date" value={e.befristet_bis} onChange={(ev) => setze("befristet_bis", ev.target.value)} className="h-8 text-xs" />
        </Feld>
        <Feld label="Ruhend von">
          <Input type="date" value={e.ruhend_von} onChange={(ev) => setze("ruhend_von", ev.target.value)} className="h-8 text-xs" />
        </Feld>
        <Feld label="Ruhend bis">
          <Input type="date" value={e.ruhend_bis} min={e.ruhend_von || undefined} onChange={(ev) => setze("ruhend_bis", ev.target.value)} className="h-8 text-xs" />
        </Feld>
        <Feld label="Notiz" className="col-span-2">
          <Input value={e.notiz} onChange={(ev) => setze("notiz", ev.target.value)} maxLength={500} placeholder="optional" className="h-8 text-xs" />
        </Feld>
      </div>
      <div className="space-y-1">
        <p className="text-[10px] text-muted-foreground/70 ml-1 flex items-center gap-1">
          AHV-Beiträge auch unter CHF 2&apos;500 verlangt
          <span
            className="inline-flex"
            data-tooltip={"Bis CHF 2'500 Lohn im Jahr sind AHV-Beiträge nur geschuldet, wenn die Person sie verlangt (Art. 34d AHVV).\nJahr anklicken, in dem sie es verlangt hat."}
          >
            <Info className="h-3 w-3" />
          </span>
        </p>
        <div className="flex flex-wrap gap-1">
          {jahre.map((j) => (
            <button
              key={j}
              type="button"
              onClick={() => toggleJahr(j)}
              className={`${e.jahre.includes(j) ? "kasten-active" : "kasten-toggle-off"} text-xs tabular-nums`}
              aria-pressed={e.jahre.includes(j)}
            >
              {j}
            </button>
          ))}
        </div>
      </div>
      {fehler && e.eintritt && (
        <p className="flex items-center gap-1 text-[10px] text-amber-700 dark:text-amber-300">
          <AlertTriangle className="h-3 w-3 shrink-0" /> {fehler}
        </p>
      )}
      <div className="flex gap-2 pt-0.5">
        <button type="button" onClick={onAbbrechen} disabled={speichert} className="kasten kasten-muted flex-1 text-xs">
          Abbrechen
        </button>
        <button
          type="button"
          onClick={onSpeichern}
          disabled={speichert || !!fehler}
          className="kasten kasten-red flex-1 text-xs disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {speichert ? <><Loader2 className="h-3 w-3 animate-spin" /> Speichert…</> : neu ? "Anstellung erfassen" : "Änderung speichern"}
        </button>
      </div>
    </div>
  );
}

function Feld({ label, className, children }: { label: string; className?: string; children: React.ReactNode }) {
  return (
    <div className={`space-y-0.5 min-w-0 ${className ?? ""}`}>
      <p className="text-[10px] text-muted-foreground/70 ml-1">{label}</p>
      {children}
    </div>
  );
}
