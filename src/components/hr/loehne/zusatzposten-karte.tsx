"use client";

/**
 * Einmalige Lohnposten (Lohn-Umbau Phase 4, Tabelle lohn_zusatzposten) —
 * kompakte Karte im Lohn-Editor einer Person (Lohn › Mitarbeiter-Lohn), im
 * Muster der Karte «Anstellung».
 *
 *   Lohn            im Brutto (AHV-pflichtig / steuerbar wählbar)
 *   Rückerstattung  eines Abzugs (z. B. AHV/ALV unter CHF 2'500) — senkt die Abzüge
 *   Spesen          nach dem Netto ausbezahlt (Lohnausweis Ziff. 13)
 *
 * GET/POST/PATCH/DELETE /api/hr/zusatzposten. Abgerechneter Lohnmonat:
 *   - Erfassen → Antrag mit der Begründung des Postens («Antrag stellen»)
 *   - Ändern   → Begründungs-Modal der Lohnzeilen (useLohnSenden), dann Antrag
 *   - Löschen  → Begründung im Lösch-Dialog, dann Antrag
 * Gleiche Wortwahl wie die Lohnzeilen-Anträge. Den eigenen Lohn ändert eine
 * zweite Person (gesperrt).
 * Nach dem letzten ERP-Lohnmonat (lauf_bis, ab Dezember 2026 Trust flow/Bexio)
 * sind keine Monate mehr wählbar; der Server liefert dazu den Klartext.
 */

import { useEffect, useId, useState } from "react";
import { AlertTriangle, Coins, Info, Loader2, Lock, Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { useConfirm } from "@/components/ui/use-confirm";
import { SearchableSelect } from "@/components/searchable-select";
import { TOAST } from "@/lib/messages";
import { formatChf } from "@/lib/format";
import { monatLabel } from "@/lib/lohn/monate";
import { ABZUG_KLARTEXT, istFuenfRappen, type AbzugArt } from "@/lib/lohn/kern";
import { BEGRUENDUNG_MIN, useLohnSenden, zeigeAntragHinweis, type LohnJson } from "@/components/hr/lohn/begruendung-modal";

type Art = "lohn" | "rueckerstattung" | "spesen";

interface Posten {
  id: string;
  profile_id: string;
  jahr: number;
  monat: number;
  art: Art;
  bezeichnung: string;
  betrag: number;
  ahv_pflichtig: boolean;
  steuerbar: boolean;
  abzug_art: AbzugArt | null;
  begruendung: string;
  created_by_name: string | null;
  updated_by_name: string | null;
  gesperrt: boolean;
  /** Lohnmonat nach lauf_bis (Trust flow/Bexio) — im ERP nicht mehr änderbar. */
  nach_lauf_bis?: boolean;
}

interface Monat {
  jahr: number;
  monat: number;
  gesperrt: boolean;
}

const ART: Record<Art, { label: string; kurz: string; tip: string }> = {
  lohn: { label: "Lohn (im Brutto)", kurz: "Lohn", tip: "Einmaliger Lohnposten im Bruttolohn, z. B. Übernahme der Quellensteuer durch die Firma" },
  rueckerstattung: { label: "Rückerstattung eines Abzugs", kurz: "Rückerstattung", tip: "Senkt die Abzüge, z. B. AHV/ALV zurück, wenn die 2'500-Grenze im Jahr nicht erreicht wird" },
  spesen: { label: "Spesen (nach dem Netto)", kurz: "Spesen", tip: "Effektive Spesen — nicht im Bruttolohn, keine Abzüge, mit dem Lohn ausbezahlt" },
};

interface Entwurf {
  monat: string; // "YYYY-M"
  art: Art;
  bezeichnung: string;
  betrag: string;
  ahv: boolean;
  steuerbar: boolean;
  abzug: AbzugArt | "";
  begruendung: string;
}

const monatsKey = (j: number, m: number) => `${j}-${m}`;

function ausPosten(p: Posten | null, standardMonat: string): Entwurf {
  return {
    monat: p ? monatsKey(p.jahr, p.monat) : standardMonat,
    art: p?.art ?? "lohn",
    bezeichnung: p?.bezeichnung ?? "",
    betrag: p ? p.betrag.toFixed(2) : "",
    ahv: p ? p.ahv_pflichtig : true,
    steuerbar: p ? p.steuerbar : true,
    abzug: p?.abzug_art ?? "",
    begruendung: p?.begruendung ?? "",
  };
}

function betragZahl(t: string): number {
  const s = t.replace(/['’\s]/g, "").replace(",", ".");
  return s === "" ? NaN : Number(s);
}

function pruefe(e: Entwurf): string | null {
  if (!e.monat) return "Lohnmonat wählen";
  const b = e.bezeichnung.trim();
  if (b.length < 3 || b.length > 80) return "Bezeichnung: 3–80 Zeichen";
  const n = betragZahl(e.betrag);
  if (!Number.isFinite(n) || n === 0) return "Betrag fehlt";
  if (!istFuenfRappen(n)) return "Betrag in 5-Rappen-Schritten (z. B. 12.35)";
  if (e.art === "rueckerstattung" && !e.abzug) return "Welcher Abzug wird zurückerstattet?";
  if (e.begruendung.trim().length < BEGRUENDUNG_MIN) return `Begründung: mindestens ${BEGRUENDUNG_MIN} Zeichen`;
  return null;
}

function alsWerte(e: Entwurf): Record<string, unknown> {
  const [jahr, monat] = e.monat.split("-").map(Number);
  return {
    jahr,
    monat,
    art: e.art,
    bezeichnung: e.bezeichnung.trim(),
    betrag: betragZahl(e.betrag),
    ahv_pflichtig: e.art === "lohn" ? e.ahv : false,
    steuerbar: e.art === "lohn" ? e.steuerbar : false,
    abzug_art: e.art === "rueckerstattung" ? e.abzug || null : null,
    posten_begruendung: e.begruendung.trim(),
  };
}

const ANTRAG_TEXT =
  "eine zweite Person (anderer Admin oder Vertretung) bestätigt innert 24 h. Danach schlägt das System Korrekturfassungen vor.";

export function ZusatzpostenKarte({ profileId, gesperrt, onBeschaeftigt }: {
  profileId: string;
  /** Eigener Lohn: nur ansehen (Vier Augen). */
  gesperrt: boolean;
  onBeschaeftigt?: (b: boolean) => void;
}) {
  const [daten, setDaten] = useState<{ posten: Posten[]; monate: Monat[]; offene: number; laufBis: string | null } | null>(null);
  const [version, setVersion] = useState(0);
  // null = Ansicht, "neu" = erfassen, sonst id
  const [bearbeite, setBearbeite] = useState<string | null>(null);
  const [entwurf, setEntwurf] = useState<Entwurf>(() => ausPosten(null, ""));
  const [speichert, setSpeichert] = useState(false);
  const [loeschen, setLoeschen] = useState<Posten | null>(null);
  const { senden, BegruendungModalElement } = useLohnSenden();
  const { confirm, ConfirmModalElement } = useConfirm();

  useEffect(() => {
    let aktiv = true;
    fetch(`/api/hr/zusatzposten?profile_id=${encodeURIComponent(profileId)}`, { cache: "no-store" })
      .then((r) => r.json().catch(() => ({})).then((j) => ({ ok: r.ok, j })))
      .then(({ ok, j }) => {
        if (!aktiv) return;
        if (!ok || !j.success) {
          toast.error(`Einmalige Lohnposten: ${j.error ?? j.message ?? "konnten nicht geladen werden"}`);
          setDaten({ posten: [], monate: [], offene: 0, laufBis: null });
          return;
        }
        setDaten({
          posten: (j.posten ?? []) as Posten[],
          monate: (j.monate ?? []) as Monat[],
          offene: Number(j.offene_antraege ?? 0),
          laufBis: typeof j.lauf_bis_hinweis === "string" ? j.lauf_bis_hinweis : null,
        });
      })
      .catch((err) => {
        if (!aktiv) return;
        toast.error(`Einmalige Lohnposten: ${err instanceof Error ? err.message : String(err)}`);
        setDaten({ posten: [], monate: [], offene: 0, laufBis: null });
      });
    return () => { aktiv = false; };
  }, [profileId, version]);

  // Standard: jüngster noch offener Monat, sonst der jüngste.
  const standardMonat = (() => {
    const m = daten?.monate ?? [];
    const offen = [...m].reverse().find((x) => !x.gesperrt) ?? m[0];
    return offen ? monatsKey(offen.jahr, offen.monat) : "";
  })();

  function oeffne(p: Posten | null) {
    setEntwurf(ausPosten(p, standardMonat));
    setBearbeite(p?.id ?? "neu");
  }

  const setze = <K extends keyof Entwurf>(k: K, v: Entwurf[K]) => setEntwurf((e) => ({ ...e, [k]: v }));

  function beschaeftigt(b: boolean) {
    setSpeichert(b);
    onBeschaeftigt?.(b);
  }

  function nachher(json: LohnJson, text: string) {
    if (!zeigeAntragHinweis(json)) toast.success(text);
    setBearbeite(null);
    setVersion((v) => v + 1);
  }

  async function speichern() {
    const f = pruefe(entwurf);
    if (f) { toast.error(f); return; }
    const werte = alsWerte(entwurf);
    let body: Record<string, unknown>;
    if (bearbeite === "neu") {
      body = { profile_id: profileId, ...werte };
    } else {
      const original = daten?.posten.find((p) => p.id === bearbeite);
      if (!original) { toast.error("Posten nicht mehr vorhanden — bitte neu öffnen"); return; }
      const alt = alsWerte(ausPosten(original, standardMonat));
      body = { id: original.id };
      for (const [k, v] of Object.entries(werte)) if (JSON.stringify(v) !== JSON.stringify(alt[k])) body[k] = v;
      if (Object.keys(body).length === 1) { setBearbeite(null); return; }
    }
    beschaeftigt(true);
    const r = await senden({ url: "/api/hr/zusatzposten", method: bearbeite === "neu" ? "POST" : "PATCH", body });
    beschaeftigt(false);
    if (!r) return;
    if (!r.ok) { TOAST.errorOr(r.json.error); return; }
    nachher(r.json, bearbeite === "neu" ? "Posten erfasst" : "Posten geändert");
  }

  async function loescheDirekt(p: Posten) {
    const ok = await confirm({
      title: "Posten löschen?",
      message: `${monatLabel({ jahr: p.jahr, monat: p.monat })}: ${ART[p.art].kurz} «${p.bezeichnung}» ${formatChf(p.betrag)}. Der Lohn des Monats wird ohne diesen Posten gerechnet.`,
      confirmLabel: "Löschen",
      variant: "red",
    });
    if (!ok) return;
    await sendeLoeschen(p, null);
  }

  async function sendeLoeschen(p: Posten, begruendung: string | null): Promise<boolean> {
    beschaeftigt(true);
    try {
      const res = await fetch("/api/hr/zusatzposten", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: p.id, ...(begruendung ? { begruendung } : {}) }),
      });
      const json = (await res.json().catch(() => ({}))) as LohnJson;
      if (!res.ok || !json.success) {
        TOAST.errorOr(json.error);
        return false;
      }
      nachher(json, "Posten gelöscht");
      return true;
    } catch (e) {
      toast.error(`Netzwerkfehler: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    } finally {
      beschaeftigt(false);
    }
  }

  const monate = daten?.monate ?? [];
  const posten = daten?.posten ?? [];

  return (
    <div className="pt-3 border-t border-foreground/10 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
          <Coins className="h-3 w-3" />
          Einmalige Lohnposten
          <span className="inline-flex normal-case font-normal tracking-normal" data-tooltip={"Lohn im Brutto, Rückerstattung eines Abzugs oder Spesen —\nje Person und Lohnmonat. Rechnen in Monatstabelle, Lohnabrechnung und Jahresliste mit."}>
            <Info className="h-3 w-3" />
          </span>
        </p>
        {!gesperrt && bearbeite === null && daten !== null && monate.length > 0 && (
          <button type="button" onClick={() => oeffne(null)} className="kasten kasten-muted text-xs">
            <Plus className="h-3 w-3" /> Erfassen
          </button>
        )}
      </div>

      {daten === null ? (
        <div className="shimmer rounded-md h-9" />
      ) : (
        <>
          {daten.laufBis && (
            <p className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
              <Info className="h-3 w-3 mt-0.5 shrink-0" />
              {daten.laufBis}
            </p>
          )}
          {daten.offene > 0 && (
            <p className="flex items-start gap-1.5 text-[11px] text-amber-700 dark:text-amber-300">
              <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" />
              {daten.offene === 1 ? "1 Antrag" : `${daten.offene} Anträge`} offen — bestätigt eine zweite Person unter Anträge › Rechte &amp; Lohndaten.
            </p>
          )}
          {posten.length === 0 && bearbeite === null && (
            <p className="text-[11px] text-muted-foreground">Keine einmaligen Lohnposten.</p>
          )}
          {posten.length > 0 && (
            <div className="space-y-1 max-h-64 overflow-y-auto">
              {posten.map((p) =>
                bearbeite === p.id ? null : (
                  <PostenZeile
                    key={p.id}
                    p={p}
                    aktionen={!gesperrt && bearbeite === null && !speichert && !p.nach_lauf_bis}
                    onBearbeiten={() => oeffne(p)}
                    onLoeschen={() => (p.gesperrt ? setLoeschen(p) : void loescheDirekt(p))}
                  />
                ),
              )}
            </div>
          )}
          {bearbeite !== null && (
            <PostenFormular
              entwurf={entwurf}
              setze={setze}
              monate={monate}
              neu={bearbeite === "neu"}
              speichert={speichert}
              onAbbrechen={() => setBearbeite(null)}
              onSpeichern={() => void speichern()}
            />
          )}
        </>
      )}
      <LoeschAntragModal
        key={loeschen?.id ?? "zu"}
        posten={loeschen}
        sendet={speichert}
        onAbbrechen={() => setLoeschen(null)}
        onSenden={async (b) => {
          if (!loeschen) return;
          if (await sendeLoeschen(loeschen, b)) setLoeschen(null);
        }}
      />
      {BegruendungModalElement}
      {ConfirmModalElement}
    </div>
  );
}

function PostenZeile({ p, aktionen, onBearbeiten, onLoeschen }: {
  p: Posten;
  aktionen: boolean;
  onBearbeiten: () => void;
  onLoeschen: () => void;
}) {
  const merkmale =
    p.art === "lohn"
      ? [p.ahv_pflichtig ? "AHV-pflichtig" : "nicht AHV-pflichtig", p.steuerbar ? "steuerbar" : "nicht steuerbar"]
      : p.art === "rueckerstattung" && p.abzug_art
        ? [ABZUG_KLARTEXT[p.abzug_art]]
        : ["nach dem Netto"];
  return (
    <div className="flex items-start gap-2 px-2.5 py-2 rounded-lg border border-border bg-muted/40 text-xs">
      <div
        className="min-w-0 flex-1"
        data-tooltip={`${p.bezeichnung}\nBegründung: ${p.begruendung}${p.updated_by_name ? `\nzuletzt geändert: ${p.updated_by_name}` : p.created_by_name ? `\nerfasst: ${p.created_by_name}` : ""}`}
      >
        <p className="font-medium truncate">{p.bezeichnung}</p>
        <p className="text-[11px] text-muted-foreground flex items-center gap-1 min-w-0">
          <span className="tabular-nums shrink-0">{monatLabel({ jahr: p.jahr, monat: p.monat })}</span>
          {p.gesperrt && (
            <span className="inline-flex shrink-0" data-tooltip="Monat abgerechnet — Änderungen nur per Antrag">
              <Lock className="h-3 w-3" />
            </span>
          )}
          <span className="truncate">· {ART[p.art].kurz} · {merkmale.join(" · ")}</span>
        </p>
      </div>
      <span className={`tabular-nums font-semibold shrink-0 ${p.betrag < 0 ? "text-red-600 dark:text-red-400" : ""}`}>{formatChf(p.betrag)}</span>
      {aktionen && (
        <div className="flex gap-1 shrink-0">
          <button type="button" onClick={onBearbeiten} className="kasten kasten-muted text-xs" data-tooltip="Bearbeiten" aria-label="Bearbeiten">
            <Pencil className="h-3 w-3" />
          </button>
          <button type="button" onClick={onLoeschen} className="kasten kasten-red text-xs" data-tooltip="Löschen" aria-label="Löschen">
            <Trash2 className="h-3 w-3" />
          </button>
        </div>
      )}
    </div>
  );
}

function PostenFormular({ entwurf: e, setze, monate, neu, speichert, onAbbrechen, onSpeichern }: {
  entwurf: Entwurf;
  setze: <K extends keyof Entwurf>(k: K, v: Entwurf[K]) => void;
  monate: Monat[];
  neu: boolean;
  speichert: boolean;
  onAbbrechen: () => void;
  onSpeichern: () => void;
}) {
  const fehler = pruefe(e);
  const begruendungId = useId();
  const gewaehlt = monate.find((m) => monatsKey(m.jahr, m.monat) === e.monat);
  // Ein Posten in einem Monat ausserhalb der Liste (alt) gilt als abgerechnet.
  const monatGesperrt = gewaehlt ? gewaehlt.gesperrt : !!e.monat;
  const monatsItems = monate.map((m) => ({ id: monatsKey(m.jahr, m.monat), label: monatLabel(m), sub: m.gesperrt ? "abgerechnet — per Antrag" : undefined }));
  if (e.monat && !gewaehlt) {
    const [j, m] = e.monat.split("-").map(Number);
    monatsItems.push({ id: e.monat, label: monatLabel({ jahr: j, monat: m }), sub: "abgerechnet — per Antrag" });
  }
  return (
    <div className="p-2.5 rounded-lg border border-border bg-muted/40 space-y-2">
      <div className="grid grid-cols-2 gap-2">
        <Feld label="Lohnmonat *">
          <SearchableSelect value={e.monat} onChange={(v) => { if (v) setze("monat", v); }} items={monatsItems} clearable={false} />
        </Feld>
        <Feld label="Art *">
          <SearchableSelect
            value={e.art}
            onChange={(v) => { if (v) setze("art", v as Art); }}
            items={(Object.keys(ART) as Art[]).map((k) => ({ id: k, label: ART[k].label, sub: ART[k].tip }))}
            searchable={false}
            clearable={false}
          />
        </Feld>
        <Feld label="Bezeichnung * (steht auf der Lohnabrechnung)" className="col-span-2">
          <Input value={e.bezeichnung} onChange={(ev) => setze("bezeichnung", ev.target.value)} maxLength={80} placeholder={e.art === "spesen" ? "z. B. Verpflegung auswärts" : e.art === "rueckerstattung" ? "z. B. AHV zurück, Jahreslohn unter CHF 2'500" : "z. B. Quellensteuer vom Arbeitgeber bezahlt"} className="h-8 text-xs" />
        </Feld>
        <Feld label="Betrag CHF *">
          <Input type="text" inputMode="decimal" value={e.betrag} onChange={(ev) => setze("betrag", ev.target.value)} placeholder="z. B. 120.50" className="h-8 text-xs tabular-nums" />
        </Feld>
        {e.art === "lohn" && (
          <div className="flex items-end gap-3 pb-1.5 text-xs">
            <label className="flex items-center gap-1.5 cursor-pointer" data-tooltip="Zählt zum AHV-, ALV- und UVG-Lohn (Abzüge und Arbeitgeberbeiträge)">
              <input type="checkbox" checked={e.ahv} onChange={(ev) => setze("ahv", ev.target.checked)} className="h-3.5 w-3.5" />
              AHV-pflichtig
            </label>
            <label className="flex items-center gap-1.5 cursor-pointer" data-tooltip="Steht im Lohnausweis (Ziffer 7, andere Leistungen)">
              <input type="checkbox" checked={e.steuerbar} onChange={(ev) => setze("steuerbar", ev.target.checked)} className="h-3.5 w-3.5" />
              steuerbar
            </label>
          </div>
        )}
        {e.art === "rueckerstattung" && (
          <Feld label="Abzug *">
            <SearchableSelect
              value={e.abzug}
              onChange={(v) => setze("abzug", (v || "") as AbzugArt | "")}
              items={(Object.keys(ABZUG_KLARTEXT) as AbzugArt[]).map((k) => ({ id: k, label: ABZUG_KLARTEXT[k] }))}
              placeholder="Abzug wählen"
              searchable={false}
              clearable={false}
            />
          </Feld>
        )}
        {e.art === "spesen" && (
          <p className="flex items-end pb-1.5 text-[11px] text-muted-foreground">Ohne Abzüge, mit dem Lohn ausbezahlt.</p>
        )}
        <div className="col-span-2 space-y-0.5">
          <label htmlFor={begruendungId} className="text-[10px] text-muted-foreground/70 ml-1">
            Begründung * (mind. {BEGRUENDUNG_MIN} Zeichen, intern)
          </label>
          <textarea
            id={begruendungId}
            value={e.begruendung}
            onChange={(ev) => setze("begruendung", ev.target.value)}
            rows={2}
            maxLength={1000}
            placeholder="z. B. Quellensteuer März–September von der Firma übernommen (Entscheid 29.10.)"
            className="w-full px-3 py-2 text-xs rounded-lg border bg-background focus:outline-none focus:ring-2 focus:ring-ring/40 focus:border-ring resize-none"
          />
        </div>
      </div>
      <p className="text-[10px] text-muted-foreground ml-1">Negativer Betrag = Rückforderung bzw. Korrektur.</p>
      {monatGesperrt && (
        <p className="flex items-start gap-1.5 p-2 rounded-lg bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/30 text-[11px] text-amber-800 dark:text-amber-200">
          <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" />
          <span>
            Die Änderung betrifft abgerechnete Monate ab {gewaehlt ? `01.${String(gewaehlt.monat).padStart(2, "0")}.${gewaehlt.jahr}` : "dem gewählten Monat"}. Sie wird als Antrag gestellt
            {neu ? " (mit dieser Begründung)" : ""}; {ANTRAG_TEXT}
          </span>
        </p>
      )}
      {fehler && e.bezeichnung && (
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
          {speichert ? (
            <><Loader2 className="h-3 w-3 animate-spin" /> Speichert…</>
          ) : neu ? (monatGesperrt ? "Antrag stellen" : "Posten erfassen") : "Änderung speichern"}
        </button>
      </div>
    </div>
  );
}

/** Löschen im abgerechneten Monat: Begründung → Antrag (Wortwahl wie das Begründungs-Modal der Lohnzeilen). */
function LoeschAntragModal({ posten, sendet, onAbbrechen, onSenden }: {
  posten: Posten | null;
  sendet: boolean;
  onAbbrechen: () => void;
  onSenden: (begruendung: string) => Promise<void>;
}) {
  const [text, setText] = useState("");
  const feldId = useId();
  const laenge = text.trim().length;
  return (
    <Modal
      open={!!posten}
      onClose={() => { if (!sendet) onAbbrechen(); }}
      closable={!sendet}
      title="Begründung nötig"
      icon={<AlertTriangle className="h-5 w-5 text-amber-500" />}
      size="md"
    >
      {posten && (
        <p className="text-sm text-muted-foreground">
          Löschen: {monatLabel({ jahr: posten.jahr, monat: posten.monat })}, {ART[posten.art].kurz} «{posten.bezeichnung}» {formatChf(posten.betrag)}.
          Die Änderung betrifft abgerechnete Monate ab 01.{String(posten.monat).padStart(2, "0")}.{posten.jahr}. Sie wird als Antrag gestellt; {ANTRAG_TEXT}
        </p>
      )}
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
          placeholder="z. B. Posten doppelt erfasst"
          className="w-full px-3 py-2 text-sm rounded-lg border bg-background focus:outline-none focus:ring-2 focus:ring-ring/40 focus:border-ring resize-none"
        />
        {laenge < BEGRUENDUNG_MIN && <p className="text-[10px] text-muted-foreground ml-1">noch {BEGRUENDUNG_MIN - laenge} Zeichen</p>}
      </div>
      <div className="flex gap-2 pt-1">
        <button type="button" onClick={onAbbrechen} disabled={sendet} className="kasten kasten-muted flex-1">
          Abbrechen
        </button>
        <button
          type="button"
          onClick={() => void onSenden(text.trim())}
          disabled={sendet || laenge < BEGRUENDUNG_MIN}
          className="kasten kasten-red flex-1 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {sendet ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Wird gestellt…</> : "Antrag stellen"}
        </button>
      </div>
    </Modal>
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
