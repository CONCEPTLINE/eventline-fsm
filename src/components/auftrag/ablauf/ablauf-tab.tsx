"use client";

/**
 * Reiter «Ablauf» der Auftragsseite (Vermietung, Etappe 2 — Vertrag:
 * docs/barakuba/VERTRAG-ABLAUF.md). Erscheint nur, wenn der Auftrag eine
 * Zeile in auftrag_ablauf hat; dann ersetzt er Übersicht/Technik/Catering.
 *
 * Links der Strahl mit den 5 Schritten, rechts das Panel des aktuellen (oder
 * angeklickten) Schritts, darüber die zuklappbare Eckdaten-Karte, darunter
 * der Mailverlauf. Daten: GET/PATCH /api/jobs/[id]/ablauf (+ schritt,
 * rueckgaengig, vertrag, eml). Mails werden nie aus der App gesendet.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { Loading } from "@/components/ui/spinner";
import { PdfPopup } from "@/components/pdf-popup";
import { FELDER_LEER, type AblaufAntwort, type AblaufFelder, type AblaufPatch, type SchrittNr } from "@/lib/ablauf/typen";
import type { Document as DocType, JobDetailWithRelations } from "@/types";
import { SCHRITTE, UEBERGABE_DAUER_MIN, UEBERGABE_VON, type Erledigt } from "./konstanten";
import { hhmm, minuten, plusTage, tagZuerich, uhrzeit, zuerichIso } from "./format";
import { Strahl } from "./strahl";
import { SchrittPanel, type DokRef } from "./panels";
import { Mailverlauf, type MailEintrag, type VerlaufEintrag } from "./mailverlauf";
import { Eckdaten } from "./eckdaten";

type Props = {
  jobId: string;
  job: JobDetailWithRelations;
  /** auftraege:edit und nicht archiviert */
  canEdit: boolean;
  documents: DocType[];
  notesText: string;
  setNotesText: (v: string) => void;
  canFinish: boolean;
  finishBlockReason: string;
  /** Normaler Abschluss (Rapport-Modal) der Auftragsseite. */
  onAbschliessen: () => void;
  /** Auftrag + Dokumente neu laden (Status, neue Vertrags-PDF). */
  onReload: () => void | Promise<void>;
};

async function fehlerText(res: Response): Promise<string> {
  try {
    const j = (await res.json()) as { error?: string };
    if (j?.error) return j.error;
  } catch {
    /* kein JSON */
  }
  return `Fehler ${res.status}`;
}

const QUELLE_TEXT: Record<string, string> = { mail: "aus Mail erkannt", manuell: "von Hand", system: "System" };

export function AblaufTab({
  jobId,
  job,
  canEdit,
  documents,
  notesText,
  setNotesText,
  canFinish,
  finishBlockReason,
  onAbschliessen,
  onReload,
}: Props) {
  const supabase = createClient();
  const [daten, setDaten] = useState<AblaufAntwort | null>(null);
  const [ladeFehler, setLadeFehler] = useState<string | null>(null);
  const [laedt, setLaedt] = useState(false);
  const [f, setFelder] = useState<AblaufFelder>(FELDER_LEER);
  const [gewaehlt, setGewaehlt] = useState<SchrittNr | null>(null);
  const [pdf, setPdf] = useState<{ url: string; title: string } | null>(null);

  // Abhaken während der Übergabe und «Poller freigeschaltet»: in auftrag_ablauf.felder
  // (uebergabe_haken / poller_freigeschaltet), gespeichert per PATCH. Anzeige optimistisch,
  // `arbeitLaedt` = Punkt, der gerade gespeichert wird (Spinner in der Zeile).
  const [haken, setHaken] = useState<Record<string, boolean>>({});
  const [pollerFrei, setPollerFreiState] = useState(false);
  const [arbeitLaedt, setArbeitLaedt] = useState<string | null>(null);
  const hakenRef = useRef<Record<string, boolean>>({});
  const arbeitOffen = useRef(0);
  const arbeitKette = useRef<Promise<unknown>>(Promise.resolve());

  // ─── Laden ─────────────────────────────────────────────────────────
  // onReload als Ref: speichern() bleibt stabil (sein Aufräum-Effekt speichert beim Verlassen).
  const onReloadRef = useRef(onReload);
  useEffect(() => {
    onReloadRef.current = onReload;
  }, [onReload]);

  // Ungespeicherte Feld-Eingaben überleben jedes Nachladen.
  const offenRef = useRef<Partial<AblaufFelder>>({});
  // Feld-Änderungen, deren PATCH gerade läuft — überlagern eine Antwort, die vor dem Speichern gelesen wurde.
  const laufendRef = useRef<Partial<AblaufFelder>[]>([]);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Nur die Antwort der jüngsten Anfrage zählt (ältere, langsamere Antworten verwerfen).
  const ladeNr = useRef(0);

  const laden = useCallback(async () => {
    const nr = ++ladeNr.current;
    setLaedt(true);
    try {
      const res = await fetch(`/api/jobs/${jobId}/ablauf`, { cache: "no-store" });
      if (nr !== ladeNr.current) return;
      if (!res.ok) {
        const t = await fehlerText(res);
        if (nr !== ladeNr.current) return;
        setLadeFehler(t);
        toast.error("Ablauf konnte nicht geladen werden", { description: t });
        return;
      }
      const d = (await res.json()) as AblaufAntwort;
      if (nr !== ladeNr.current) return;
      setDaten(d);
      setLadeFehler(null);
      const laufend = Object.assign({}, ...laufendRef.current) as Partial<AblaufFelder>;
      setFelder({ ...FELDER_LEER, ...d.ablauf.felder, ...laufend, ...offenRef.current });
      // Während Haken gespeichert werden, gilt der lokale (neuere) Stand.
      if (arbeitOffen.current === 0) {
        hakenRef.current = Object.fromEntries((d.ablauf.uebergabe_haken ?? []).map((k) => [k, true]));
        setHaken(hakenRef.current);
        setPollerFreiState(!!d.ablauf.poller_freigeschaltet);
      }
    } catch {
      if (nr !== ladeNr.current) return;
      setLadeFehler("Keine Verbindung zum Server");
      toast.error("Ablauf konnte nicht geladen werden", { description: "Keine Verbindung zum Server" });
    } finally {
      if (nr === ladeNr.current) setLaedt(false);
    }
  }, [jobId]);

  useEffect(() => {
    queueMicrotask(() => void laden());
  }, [laden]);

  // Neue Mails/Ereignisse kommen vom Eingang — beim Zurückkehren in den Tab nachladen.
  useEffect(() => {
    const sichtbar = () => {
      if (document.visibilityState === "visible") void laden();
    };
    document.addEventListener("visibilitychange", sichtbar);
    return () => document.removeEventListener("visibilitychange", sichtbar);
  }, [laden]);

  // ─── Speichern ─────────────────────────────────────────────────────
  const patch = useCallback(
    async (body: AblaufPatch): Promise<boolean> => {
      try {
        const res = await fetch(`/api/jobs/${jobId}/ablauf`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          toast.error("Änderung nicht gespeichert", { description: await fehlerText(res) });
          return false;
        }
        const j = (await res.json().catch(() => null)) as { warnung?: string } | null;
        if (j?.warnung) toast.warning(j.warnung);
        return true;
      } catch {
        toast.error("Änderung nicht gespeichert", { description: "Keine Verbindung zum Server" });
        return false;
      }
    },
    [jobId],
  );

  /** Offene Feld-Änderungen sofort speichern (vor Entwurf/Vertrag/Schritt). */
  const speichern = useCallback(async (): Promise<boolean> => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const offen = offenRef.current;
    if (Object.keys(offen).length === 0) return true;
    offenRef.current = {};
    laufendRef.current = [...laufendRef.current, offen];
    let ok = false;
    try {
      ok = await patch({ felder: offen });
    } finally {
      laufendRef.current = laufendRef.current.filter((x) => x !== offen);
    }
    // Fehlgeschlagen → Eingaben behalten (neuere gewinnen), nicht still verlieren.
    if (!ok) offenRef.current = { ...offen, ...offenRef.current };
    else {
      // Server spiegelt Datum/Beginn/Kontakt in den Auftrag (und zieht die Übergabe mit) → beides frisch laden.
      if ("datum" in offen || "beginn" in offen) void laden();
      void onReloadRef.current();
    }
    return ok;
  }, [patch, laden]);

  function setF(p: Partial<AblaufFelder>) {
    setFelder((alt) => ({ ...alt, ...p }));
    offenRef.current = { ...offenRef.current, ...p };
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => void speichern(), 800);
  }

  // Beim Verlassen des Reiters nichts verlieren.
  useEffect(() => () => void speichern(), [speichern]);

  // ─── Abgeleitete Werte ─────────────────────────────────────────────
  const ablauf = daten?.ablauf ?? null;
  const ereignisse = useMemo(() => daten?.ereignisse ?? [], [daten]);
  const tag = f.datum || (job.start_date ? tagZuerich(job.start_date) : "");
  const fx: AblaufFelder = { ...f, datum: tag };

  const erledigt: Erledigt = useMemo(() => {
    const e: Erledigt = {};
    for (const n of ablauf?.erledigt ?? []) {
      const ev = [...ereignisse]
        .filter((x) => x.schritt === n && !x.rueckgaengig_am)
        .sort((a, b) => (a.zeit < b.zeit ? 1 : -1))[0];
      const quelle = ev ? (ev.quelle === "manuell" && ev.erstellt_von_name ? `von Hand (${ev.erstellt_von_name})` : QUELLE_TEXT[ev.quelle] ?? "") : "";
      e[n] = { zeit: ev?.zeit ?? null, quelle };
    }
    return e;
  }, [ablauf, ereignisse]);

  const aktuell = SCHRITTE.find((s) => !erledigt[s.nr])?.nr ?? 6;
  // Ohne eigene Auswahl folgt die rechte Seite immer dem aktuellen Schritt.
  const ausgewaehlt: SchrittNr = gewaehlt ?? (aktuell === 6 ? 5 : (aktuell as SchrittNr));

  const verlauf: VerlaufEintrag[] = useMemo(() => {
    const mails: VerlaufEintrag[] = (daten?.mails ?? []).map((m) => ({
      id: `m-${m.id}`,
      art: m.richtung,
      zeit: m.empfangen_am,
      von: m.absender ?? "—",
      // Empfänger liefert die API nicht: eingehend lief es über auftrag@, ausgehend an die Mieterin.
      an: m.richtung === "ein" ? "auftrag@" : daten?.ablauf.felder.email || "Kunde",
      ccAuftrag: m.cc.some((c) => /^auftrag@/i.test(c)),
      betreff: m.betreff ?? "(ohne Betreff)",
      auszug: m.auszug ?? "",
      anhaenge: m.anhaenge,
    }));
    const evs: VerlaufEintrag[] = ereignisse.map((e) => ({
      id: e.id,
      art: "system",
      zeit: e.zeit,
      text: e.text,
      ruecknehmbar: e.ruecknehmbar,
      quelle: e.quelle === "manuell" && e.erstellt_von_name ? e.erstellt_von_name : e.quelle === "mail" ? "aus Mail" : "System",
      rueckgaengig: !!e.rueckgaengig_am,
    }));
    return [...mails, ...evs].sort((a, b) => (a.zeit < b.zeit ? -1 : a.zeit > b.zeit ? 1 : 0));
  }, [daten, ereignisse]);

  const eingang: MailEintrag | null = useMemo(() => {
    const ein = (daten?.mails ?? []).filter((m) => m.richtung === "ein").sort((a, b) => (a.empfangen_am < b.empfangen_am ? -1 : 1))[0];
    if (!ein) return null;
    return {
      id: ein.id,
      art: "ein",
      zeit: ein.empfangen_am,
      von: ein.absender ?? "—",
      an: "auftrag@",
      ccAuftrag: false,
      betreff: ein.betreff ?? "(ohne Betreff)",
      auszug: ein.auszug ?? "",
      anhaenge: ein.anhaenge,
    };
  }, [daten]);

  // Übergabe: Beginn aus uebergabe_start, sonst 14:00; Dauer fest 1 h.
  const von = ablauf?.uebergabe_start ? uhrzeit(ablauf.uebergabe_start) : UEBERGABE_VON;
  const bis = hhmm(minuten(von) + UEBERGABE_DAUER_MIN);
  const personId = ablauf?.uebergabe_person_id ?? "";

  // Dokumente: erzeugter Vertrag + (neuester) weiterer im Ordner «Vertrag» = unterschrieben.
  const vertragDok: DokRef | null = useMemo(() => {
    const d = ablauf?.vertrag_dokument_id ? documents.find((x) => x.id === ablauf.vertrag_dokument_id) : undefined;
    return d ? { id: d.id, name: d.name, storage_path: d.storage_path } : null;
  }, [ablauf, documents]);
  const unterschriebenDok: DokRef | null = useMemo(() => {
    if (!ablauf?.unterschrieben_am) return null;
    const d = documents
      .filter((x) => x.folder === "Vertrag" && x.id !== ablauf.vertrag_dokument_id)
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))[0];
    return d ? { id: d.id, name: d.name, storage_path: d.storage_path } : null;
  }, [ablauf, documents]);

  // ─── Ort: anderer Auftrag am selben Tag? Übernahme-Zeitraum? ────────
  const locationId = job.location_id ?? job.location?.id ?? null;
  const [andereAuftraege, setAndereAuftraege] = useState<number | null>(null);
  const [zeitraum, setZeitraum] = useState<{ von: string; bis: string } | null>(null);
  useEffect(() => {
    if (!locationId || !tag) return;
    let abbruch = false;
    const start = zuerichIso(tag, "00:00");
    const ende = zuerichIso(plusTage(tag, 1), "00:00");
    void (async () => {
      const [belegt, uebernahme] = await Promise.all([
        supabase
          .from("jobs")
          .select("id", { count: "exact", head: true })
          .eq("location_id", locationId)
          .neq("id", jobId)
          .eq("is_deleted", false)
          .neq("status", "storniert")
          .lt("start_date", ende)
          .gte("end_date", start),
        supabase.from("standort_uebernahmen").select("von, bis").eq("location_id", locationId).lte("von", tag).gte("bis", tag).limit(1),
      ]);
      if (abbruch) return;
      setAndereAuftraege(belegt.error ? null : belegt.count ?? 0);
      setZeitraum(!uebernahme.error && uebernahme.data?.[0] ? (uebernahme.data[0] as { von: string; bis: string }) : null);
    })();
    return () => {
      abbruch = true;
    };
  }, [supabase, locationId, tag, jobId]);

  // ─── Aktionen ──────────────────────────────────────────────────────
  async function onSchritt(aktion: "erledigt" | "zurueck", n: SchrittNr): Promise<boolean> {
    if (!(await speichern())) return false;
    try {
      const res = await fetch(`/api/jobs/${jobId}/ablauf/schritt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ aktion, schritt: n }),
      });
      if (!res.ok) {
        toast.error(aktion === "erledigt" ? "Schritt nicht gespeichert" : "Schritt nicht geöffnet", { description: await fehlerText(res) });
        return false;
      }
    } catch {
      toast.error("Schritt nicht gespeichert", { description: "Keine Verbindung zum Server" });
      return false;
    }
    if (aktion === "erledigt") {
      setGewaehlt(null);
      toast.success(n === 5 ? "Übergabe erfasst" : `Schritt ${n} erledigt`);
    } else {
      setGewaehlt(n);
      toast.success(`Schritt ${n} wieder offen`, { description: SCHRITTE[n - 1].titel });
    }
    await laden();
    void onReload();
    return true;
  }

  async function rueckgaengig(id: string) {
    const ev = ereignisse.find((e) => e.id === id);
    try {
      const res = await fetch(`/api/jobs/${jobId}/ablauf/ereignisse/${id}/rueckgaengig`, { method: "POST" });
      if (!res.ok) {
        toast.error("Nicht zurückgenommen", { description: await fehlerText(res) });
        return;
      }
    } catch {
      toast.error("Nicht zurückgenommen", { description: "Keine Verbindung zum Server" });
      return;
    }
    if (ev?.schritt) {
      setGewaehlt(ev.schritt);
      toast.success(`Schritt ${ev.schritt} wieder offen`, { description: SCHRITTE[ev.schritt - 1].titel });
    } else {
      toast.success("Zurückgenommen");
    }
    // Rücknahme kann Felder zurücksetzen → Server-Stand übernehmen.
    offenRef.current = {};
    await laden();
    void onReload();
  }

  async function vertragErzeugen() {
    if (!(await speichern())) return;
    try {
      const res = await fetch(`/api/jobs/${jobId}/ablauf/vertrag`, { method: "POST" });
      if (!res.ok) {
        toast.error("Vertrag nicht erzeugt", { description: await fehlerText(res) });
        return;
      }
      const j = (await res.json()) as { dokumentId: string; url: string };
      toast.success("Vertrag erzeugt", { description: "Liegt unter Dokumente im Ordner «Vertrag»." });
      setPdf({ url: j.url, title: "Vertrag.pdf" });
      await Promise.all([laden(), onReload()]);
    } catch {
      toast.error("Vertrag nicht erzeugt", { description: "Keine Verbindung zum Server" });
    }
  }

  async function dokAnsehen(d: DokRef) {
    const { data, error } = await supabase.storage.from("documents").createSignedUrl(d.storage_path, 3600);
    if (error || !data?.signedUrl) {
      toast.error("Datei nicht verfügbar");
      return;
    }
    setPdf({ url: data.signedUrl, title: d.name });
  }

  async function setPersonId(id: string) {
    const body: AblaufPatch = { uebergabe_person_id: id || null };
    // Vorbelegte Zeit (14:00) mit der ersten Personenwahl festhalten.
    if (!ablauf?.uebergabe_start && tag) body.uebergabe_start = zuerichIso(tag, von);
    if (await patch(body)) await laden();
  }

  async function setVon(v: string) {
    if (!tag || !v || v === von) return;
    if (await patch({ uebergabe_start: zuerichIso(tag, v) })) await laden();
  }

  /** Arbeitsstand speichern — nacheinander (Reihenfolge bleibt), bei Fehler zurück auf den alten Stand. */
  function arbeitSpeichern(key: string, body: AblaufPatch, zurueck: () => void) {
    arbeitOffen.current += 1;
    setArbeitLaedt(key);
    arbeitKette.current = arbeitKette.current.then(async () => {
      const ok = await patch(body);
      if (!ok) zurueck();
      arbeitOffen.current -= 1;
      if (arbeitOffen.current === 0) setArbeitLaedt(null);
    });
  }

  function setPollerFrei(v: boolean) {
    setPollerFreiState(v);
    arbeitSpeichern("poller", { poller_freigeschaltet: v }, () => setPollerFreiState(!v));
  }

  function toggleHaken(k: string) {
    const neu = { ...hakenRef.current, [k]: !hakenRef.current[k] };
    hakenRef.current = neu;
    setHaken(neu);
    const liste = Object.keys(neu).filter((x) => neu[x]);
    arbeitSpeichern(`haken:${k}`, { uebergabe_haken: liste }, () => {
      hakenRef.current = { ...hakenRef.current, [k]: !neu[k] };
      setHaken(hakenRef.current);
    });
  }

  // ─── Darstellung ───────────────────────────────────────────────────
  if (!daten) {
    if (ladeFehler) {
      return (
        <div className="py-10 text-center space-y-3">
          <p className="text-sm text-muted-foreground">Ablauf konnte nicht geladen werden: {ladeFehler}</p>
          <button type="button" onClick={() => void laden()} disabled={laedt} className="kasten kasten-muted">
            <RefreshCw className={`h-4 w-4 ${laedt ? "animate-spin" : ""}`} />
            {laedt ? "Wird geladen…" : "Erneut laden"}
          </button>
        </div>
      );
    }
    return <Loading className="py-20" label="Ablauf wird geladen…" />;
  }

  const ortName = job.location?.name ?? "";
  const ortAdresse = job.location
    ? [job.location.address_street, `${job.location.address_zip || ""} ${job.location.address_city || ""}`.trim()].filter(Boolean).join(", ")
    : "";
  const nurLesen = !canEdit;

  return (
    <div className="grid grid-cols-[210px_1fr] gap-5 items-start">
      <div>
        <Strahl erledigt={erledigt} aktuell={aktuell} ausgewaehlt={ausgewaehlt} onSelect={(n) => setGewaehlt(n === aktuell ? null : n)} />
      </div>
      <div className="min-w-0 space-y-3">
        <Eckdaten
          f={fx}
          setF={setF}
          von={von}
          ortName={ortName}
          ortAdresse={ortAdresse}
          zeitraum={zeitraum}
          erkanntAm={ablauf?.created_at ?? null}
          notiz={notesText}
          setNotiz={setNotesText}
          nurLesen={nurLesen}
        />
        <SchrittPanel
          jobId={jobId}
          schritt={ausgewaehlt}
          aktuell={aktuell}
          erledigt={erledigt}
          f={fx}
          setF={setF}
          speichern={speichern}
          fixiert={!!ablauf?.fixiert_am}
          unterschrieben={!!ablauf?.unterschrieben_am}
          unterschriebenAm={ablauf?.unterschrieben_am ?? null}
          personal={daten.personal}
          personId={personId}
          setPersonId={(id) => void setPersonId(id)}
          von={von}
          bis={bis}
          setVon={(v) => void setVon(v)}
          pollerFrei={pollerFrei}
          setPollerFrei={setPollerFrei}
          haken={haken}
          toggleHaken={toggleHaken}
          arbeitLaedt={arbeitLaedt}
          nurLesen={nurLesen}
          abgeschlossen={job.status === "abgeschlossen"}
          ortName={ortName}
          andereAuftraege={andereAuftraege}
          eingang={eingang}
          vertragDok={vertragDok}
          unterschriebenDok={unterschriebenDok}
          onDokAnsehen={(d) => void dokAnsehen(d)}
          onVertragErzeugen={vertragErzeugen}
          onSchritt={onSchritt}
          canFinish={canFinish}
          finishBlockReason={finishBlockReason}
          onAbschliessen={onAbschliessen}
        />
        <Mailverlauf eintraege={verlauf} onRueckgaengig={rueckgaengig} nurLesen={nurLesen} />
      </div>
      {pdf && <PdfPopup url={pdf.url} title={pdf.title} onClose={() => setPdf(null)} />}
    </div>
  );
}
