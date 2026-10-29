"use client";

/**
 * Admin-Manager fuer Lohndokumente: pro Mitarbeiter eine Liste der
 * gueltigen Lohnabrechnungen + Lohnausweise. Aktionen:
 *   - PDF hochladen (manueller Upload — z.B. von Bexio generierter
 *     Jahres-Lohnausweis)
 *   - Monats-Abrechnung erzeugen (nur gesperrte Monate, ab dem 5. des
 *     Folgemonats; Vorgabe = letzter gesperrter Monat)
 *   - Herunterladen, in den Papierkorb legen, aus dem Papierkorb holen
 *
 * Lohn-Umbau Phase 1: nichts wird mehr ueberschrieben oder geloescht.
 * Gibt es fuer den Zeitraum schon ein Dokument, entsteht nach Rueckfrage eine
 * neue Fassung (die bisherige bleibt, Protokoll in der DB). Der Papierkorb
 * loescht nie endgueltig. «Alle neu erstellen» gibt es nicht mehr.
 * Oben steht der Status des automatischen Laufs (Fehler sichtbar), dazu das
 * Protokoll der letzten Läufe mit Ergebnis je Person/Monat und Grund
 * (erstellt / blockiert: Stempel prüfen / Fehler) und dem Stand der
 * Alarm-Mail (Phase 4).
 *
 * Zustellung (Phase 4): je Person die Wahl digital/Papier (Historie, auf
 * Wunsch von der Lohnverwaltung eintragbar) und je Dokument der Nachweis —
 * bereitgestellt / benachrichtigt / geöffnet bzw. «Papier — ausdrucken» mit
 * «ausgedruckt» abhaken (/api/hr/lohn-zustellung).
 */

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Modal } from "@/components/ui/modal";
import { Input } from "@/components/ui/input";
import { SearchableSelect } from "@/components/searchable-select";
import { Upload, Download, FileText, Sparkles, Plus, Archive, ArchiveRestore, Loader2, AlertTriangle, CheckCircle2, Printer, Mail, History, ChevronDown, ChevronRight } from "lucide-react";
import { toast } from "sonner";
import { TOAST } from "@/lib/messages";
import { Loading } from "@/components/ui/spinner";
import { useConfirm } from "@/components/ui/use-confirm";
import { istIntern } from "@/lib/roles";
import { formatDateFull, formatDateTimeFull } from "@/lib/format";
import { todayLocalIso } from "@/lib/swiss-time";
import { letzteGesperrteMonate, monatLabel, monatSchluessel } from "@/lib/lohn/monate";
import { KorrekturEingabe, KORREKTUR_MIN, korrekturText } from "@/components/hr/lohn/korrektur-eingabe";
import { KorrekturVorschlaege } from "@/components/hr/lohn/korrektur-vorschlaege";
import { JahreslisteKarte } from "@/components/hr/lohn/jahresliste-karte";

interface WageDoc {
  id: string;
  profile_id: string;
  doc_type: "lohnabrechnung" | "lohnausweis";
  year: number;
  period_month: number | null;
  file_size: number | null;
  uploaded_at: string;
  uploaded_by_name: string | null;
  notes: string | null;
  source: "auto" | "manual" | null;
  version: number | null;
  archived_at: string | null;
  archived_by_name: string | null;
  archive_reason: string | null;
}

interface Employee { id: string; full_name: string; role: string; }

interface LaufErgebnis { name: string; monat: string; ok: boolean; version?: number; fehler?: string; uebersprungen?: string; blockiert?: string }
interface LaufHinweis { name: string; text: string }
interface Lauf {
  id: string;
  gestartet_at: string;
  beendet_at: string | null;
  ausloeser: string;
  status: "laeuft" | "ok" | "teilweise" | "fehler" | "abgebrochen" | "pausiert" | "blockiert";
  erstellt: number;
  fehler: number;
  blockiert: number | null;
  offen: number;
  ergebnisse: LaufErgebnis[];
  hinweise: LaufHinweis[];
  zusammenfassung: string | null;
  alarm_gesendet_at: string | null;
  alarm_empfaenger: number | null;
  alarm_fehler: string | null;
}

/** Zustellung einer Person laden (Wahl, Verlauf, Nachweis je Dokument). null = Fehler (Toast). */
interface ZustellStand { profileId: string; wahl: ZustellWahl | null; historie: ZustellWahl[]; dokumente: Record<string, Zustellung> }
async function holeZustellung(profileId: string): Promise<ZustellStand | null> {
  try {
    const res = await fetch(`/api/hr/lohn-zustellung?profile_id=${profileId}`, { cache: "no-store" });
    const j = await res.json().catch(() => ({}));
    if (!j.success) { toast.error(`Zustellung: ${j.error === "device_not_trusted" ? j.message : j.error ?? j.message ?? "Fehler beim Laden"}`); return null; }
    return { profileId, wahl: j.wahl ?? null, historie: j.historie ?? [], dokumente: j.zustellung ?? {} };
  } catch (e) {
    toast.error(`Zustellung: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/** Zustell-Wahl einer Person (lohn_zustellung_wahl). */
interface ZustellWahl {
  wahl: "digital" | "papier";
  version: string | null;
  gewaehlt_at: string;
  quelle: "selbst" | "lohnverwaltung" | "uebernommen";
  akteur_name: string | null;
  notiz: string | null;
}

/** Zustellnachweis je Dokument (lohn_dokument_zustellung). */
interface Zustellung {
  wage_document_id: string;
  bereitgestellt_at: string;
  wahl: "digital" | "papier" | null;
  benachrichtigt_at: string | null;
  benachrichtigt_kanaele: string[] | null;
  erstmals_geoeffnet_at: string | null;
  zuletzt_geoeffnet_at: string | null;
  anzahl_geoeffnet: number;
  ausgedruckt_at: string | null;
  ausgedruckt_von_name: string | null;
}

const KANAL_LABEL: Record<string, string> = { app: "App", push: "Push", mail: "Mail" };
const QUELLE_LABEL: Record<ZustellWahl["quelle"], string> = { selbst: "selbst gewählt", lohnverwaltung: "von der Lohnverwaltung eingetragen", uebernommen: "übernommen (frühere Einwilligung)" };
const tagKurz = (iso: string) => formatDateFull(iso);

const MONTH_NAMES = ["Jan", "Feb", "Mär", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dez"];

export function LohndokumenteAdmin() {
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [selectedEmployee, setSelectedEmployee] = useState<string>("");
  const [docs, setDocs] = useState<WageDoc[]>([]);
  const [papierkorb, setPapierkorb] = useState(false);
  const [papierkorbAnzahl, setPapierkorbAnzahl] = useState(0);
  const [loading, setLoading] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [generateOpen, setGenerateOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const { confirm, ConfirmModalElement } = useConfirm();
  // Zustellung (Phase 4): Wahl der Person + Nachweis je Dokument.
  // profileId: für wen geladen (beim Personenwechsel gilt der alte Stand als «lädt»).
  const [zustellungRoh, setZustellung] = useState<ZustellStand | null>(null);
  const [zustellVersion, setZustellVersion] = useState(0);
  const [wahlOpen, setWahlOpen] = useState(false);
  const zustellung = zustellungRoh && zustellungRoh.profileId === selectedEmployee ? zustellungRoh : null;
  const loadZustellung = useCallback(() => setZustellVersion((v) => v + 1), []);

  useEffect(() => {
    if (!selectedEmployee) return;
    let aktiv = true;
    holeZustellung(selectedEmployee).then((z) => { if (aktiv && z) setZustellung(z); });
    return () => { aktiv = false; };
  }, [selectedEmployee, zustellVersion]);

  async function ausgedruckt(d: WageDoc) {
    setBusyId(d.id);
    try {
      const res = await fetch("/api/hr/lohn-zustellung", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wage_document_id: d.id, ausgedruckt: true }),
      });
      const j = await res.json().catch(() => ({}));
      if (!j.success) { TOAST.errorOr(j.error, "Konnte nicht abgehakt werden"); return; }
      toast.success("Als ausgedruckt abgehakt");
      loadZustellung();
    } finally {
      setBusyId(null);
    }
  }

  // Mitarbeiter-Liste via SECURITY-DEFINER-RPC (admin-only)
  useEffect(() => {
    const supabase = createClient();
    supabase.rpc("get_all_profiles_admin").then(({ data, error }) => {
      if (error) { toast.error(`Mitarbeiter konnten nicht geladen werden: ${error.message}`); return; }
      if (!data) return;
      const list = (data as { id: string; full_name: string; role: string; is_active: boolean }[])
        .filter((u) => istIntern(u.role) && u.is_active)
        .sort((a, b) => a.full_name.localeCompare(b.full_name));
      setEmployees(list);
    });
  }, []);

  const loadDocs = useCallback(async (employeeId: string, korb: boolean) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/hr/wage-documents?profile_id=${employeeId}${korb ? "&papierkorb=1" : ""}`);
      const j = await res.json().catch(() => ({}));
      if (j.success) {
        setDocs(j.documents as WageDoc[]);
        if (typeof j.papierkorb_anzahl === "number") setPapierkorbAnzahl(j.papierkorb_anzahl);
      } else {
        toast.error(j.error || "Fehler beim Laden");
      }
    } catch (e) {
      toast.error(`Fehler beim Laden: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (selectedEmployee) loadDocs(selectedEmployee, papierkorb);
    else setDocs([]);
  }, [selectedEmployee, papierkorb, loadDocs]);

  const neuLaden = () => { if (selectedEmployee) loadDocs(selectedEmployee, papierkorb); };

  async function downloadDoc(id: string) {
    const res = await fetch(`/api/hr/wage-documents/${id}`);
    const j = await res.json().catch(() => ({}));
    if (!j.success) { toast.error(j.error || "Download-Link konnte nicht erzeugt werden"); return; }
    const a = document.createElement("a");
    a.href = j.url; a.download = j.filename; a.target = "_blank";
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
  }

  async function archiveDoc(d: WageDoc) {
    const ok = await confirm({
      title: "In den Papierkorb legen?",
      message: `${docLabel(d)} wird ausgeblendet — auch für die Person selbst. Nichts wird gelöscht; Wiederherstellen ist jederzeit möglich. Die Aktion wird protokolliert.`,
      confirmLabel: "In den Papierkorb",
      variant: "red",
    });
    if (!ok) return;
    setBusyId(d.id);
    try {
      const res = await fetch(`/api/hr/wage-documents/${d.id}`, { method: "DELETE" });
      const j = await res.json().catch(() => ({}));
      if (!j.success) { TOAST.errorOr(j.error, "Konnte nicht in den Papierkorb gelegt werden"); return; }
      toast.success("Im Papierkorb");
      neuLaden();
    } finally {
      setBusyId(null);
    }
  }

  async function restoreDoc(d: WageDoc) {
    setBusyId(d.id);
    try {
      const res = await fetch(`/api/hr/wage-documents/${d.id}/wiederherstellen`, { method: "POST" });
      const j = await res.json().catch(() => ({}));
      if (!j.success) { TOAST.errorOr(j.error, "Wiederherstellen fehlgeschlagen"); return; }
      toast.success("Wiederhergestellt");
      neuLaden();
    } finally {
      setBusyId(null);
    }
  }

  // Docs gruppieren: nach Jahr
  const byYear = docs.reduce<Record<number, WageDoc[]>>((acc, d) => {
    (acc[d.year] ??= []).push(d);
    return acc;
  }, {});
  const years = Object.keys(byYear).map(Number).sort((a, b) => b - a);

  return (
    <div className="space-y-4">
      <div className="min-w-0">
        <h2 className="text-sm font-semibold flex items-center gap-2">
          <FileText className="h-4 w-4" /> Lohndokumente
        </h2>
        <p className="text-xs text-muted-foreground">
          PDFs für Lohnabrechnungen (monatlich) + Lohnausweise (jährlich). Mitarbeiter sehen ihre eigenen Dokumente unter HR › Lohn.
        </p>
      </div>
      {ConfirmModalElement}

      <LaufStatus />

      <Card>
        <CardContent className="p-4 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex-1 min-w-[200px] max-w-sm">
              <SearchableSelect
                value={selectedEmployee}
                onChange={(v) => { setSelectedEmployee(v); setPapierkorb(false); }}
                items={employees.map((e) => ({ id: e.id, label: e.full_name, sub: e.role }))}
                placeholder="Mitarbeiter wählen…"
              />
            </div>
            {selectedEmployee && (
              <>
                <button type="button" onClick={() => setGenerateOpen(true)} className="kasten kasten-red">
                  <Sparkles className="h-3.5 w-3.5" /> Monats-Abrechnung erzeugen
                </button>
                <button type="button" onClick={() => setUploadOpen(true)} className="kasten kasten-muted">
                  <Upload className="h-3.5 w-3.5" /> PDF hochladen
                </button>
                <div className="flex gap-1 ml-auto">
                  <button type="button" onClick={() => setPapierkorb(false)} className={!papierkorb ? "kasten-active" : "kasten-toggle-off"}>
                    Gültig
                  </button>
                  <button type="button" onClick={() => setPapierkorb(true)} className={papierkorb ? "kasten-active" : "kasten-toggle-off"}>
                    <Archive className="h-3.5 w-3.5" /> Papierkorb{papierkorbAnzahl > 0 ? ` (${papierkorbAnzahl})` : ""}
                  </button>
                </div>
              </>
            )}
          </div>

          {selectedEmployee && !papierkorb && (
            <ZustellWahlZeile wahl={zustellung?.wahl ?? null} geladen={zustellung !== null} onEintragen={() => setWahlOpen(true)} />
          )}

          {!selectedEmployee ? (
            <p className="text-xs text-muted-foreground py-4 text-center">Mitarbeiter wählen um Dokumente zu sehen.</p>
          ) : loading ? (
            <Loading />
          ) : docs.length === 0 ? (
            <p className="text-xs text-muted-foreground py-4 text-center">
              {papierkorb ? "Der Papierkorb ist leer." : "Noch keine Dokumente für diesen Mitarbeiter."}
            </p>
          ) : (
            <div className="space-y-3">
              {years.map((y) => (
                <div key={y}>
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">{y}</p>
                  <div className="space-y-1">
                    {byYear[y].sort(sortDocs).map((d) => (
                      <DocRow
                        key={d.id}
                        doc={d}
                        busy={busyId === d.id}
                        onDownload={() => downloadDoc(d.id)}
                        onArchive={() => archiveDoc(d)}
                        onRestore={() => restoreDoc(d)}
                        zustellung={zustellung?.dokumente[d.id] ?? null}
                        wahlAktuell={zustellung?.wahl?.wahl ?? null}
                        onAusgedruckt={() => void ausgedruckt(d)}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Phase 2: Korrektur-Vorschläge nach Änderungen an Lohndaten + Jahresliste */}
      <KorrekturVorschlaege onFassungErstellt={(pid) => { if (pid === selectedEmployee) neuLaden(); }} />
      <JahreslisteKarte />

      <UploadModal
        open={uploadOpen}
        onClose={() => setUploadOpen(false)}
        profileId={selectedEmployee}
        onDone={() => { setUploadOpen(false); setPapierkorb(false); neuLaden(); }}
      />

      <GenerateModal
        open={generateOpen}
        onClose={() => setGenerateOpen(false)}
        profileId={selectedEmployee}
        employee={employees.find((e) => e.id === selectedEmployee)}
        onDone={() => { setGenerateOpen(false); setPapierkorb(false); neuLaden(); loadZustellung(); }}
      />

      <WahlModal
        open={wahlOpen}
        onClose={() => setWahlOpen(false)}
        profileId={selectedEmployee}
        name={employees.find((e) => e.id === selectedEmployee)?.full_name ?? "—"}
        wahl={zustellung?.wahl ?? null}
        historie={zustellung?.historie ?? []}
        onDone={() => { setWahlOpen(false); loadZustellung(); }}
      />
    </div>
  );
}

/** Wahl digital/Papier der Person, eine Zeile über den Dokumenten. */
function ZustellWahlZeile({ wahl, geladen, onEintragen }: { wahl: ZustellWahl | null; geladen: boolean; onEintragen: () => void }) {
  if (!geladen) return <div className="shimmer rounded-md h-4 w-64" />;
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      {wahl?.wahl === "digital" ? (
        <Mail className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400 shrink-0" />
      ) : (
        <Printer className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400 shrink-0" />
      )}
      <span className="text-muted-foreground">
        Zustellung:{" "}
        {wahl ? (
          <>
            <span className="font-medium text-foreground">{wahl.wahl === "digital" ? "digital" : "auf Papier"}</span>
            {` seit ${tagKurz(wahl.gewaehlt_at)} (${QUELLE_LABEL[wahl.quelle]})`}
          </>
        ) : (
          <span className="font-medium text-amber-700 dark:text-amber-300">noch keine Wahl — Lohndokumente auf Papier abgeben</span>
        )}
      </span>
      <button type="button" onClick={onEintragen} className="kasten kasten-muted text-[11px]" data-tooltip="Wahl auf Wunsch der Person eintragen, Verlauf ansehen">
        <History className="h-3 w-3" /> Wahl eintragen
      </button>
    </div>
  );
}

/** Lohnverwaltung trägt die Wahl auf Wunsch ein (quelle «lohnverwaltung»), mit Verlauf. */
function WahlModal({ open, onClose, profileId, name, wahl, historie, onDone }: {
  open: boolean;
  onClose: () => void;
  profileId: string;
  name: string;
  wahl: ZustellWahl | null;
  historie: ZustellWahl[];
  onDone: () => void;
}) {
  const [neu, setNeu] = useState<"digital" | "papier">("papier");
  const [notiz, setNotiz] = useState("");
  const [busy, setBusy] = useState(false);
  const [geoeffnetFuer, setGeoeffnetFuer] = useState<string | null>(null);
  // Beim Öffnen: Vorgabe = Gegenteil der aktuellen Wahl (der übliche Wunsch).
  if (open && geoeffnetFuer !== profileId) {
    setGeoeffnetFuer(profileId);
    setNeu(wahl?.wahl === "papier" ? "digital" : "papier");
    setNotiz("");
  }
  if (!open && geoeffnetFuer !== null) setGeoeffnetFuer(null);

  async function speichern() {
    setBusy(true);
    try {
      const res = await fetch("/api/hr/lohn-zustellung", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profile_id: profileId, wahl: neu, notiz: notiz.trim() }),
      });
      const j = await res.json().catch(() => ({}));
      if (!j.success) { TOAST.errorOr(j.error ?? j.message, "Speichern fehlgeschlagen"); return; }
      toast.success("Wahl eingetragen");
      onDone();
    } catch (e) {
      toast.error(`Speichern fehlgeschlagen: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={() => { if (!busy) onClose(); }} closable={!busy} title={`Zustellung · ${name}`} size="md">
      <div className="space-y-3 text-sm">
        <p className="text-xs text-muted-foreground">
          Normalerweise wählt die Person selbst (Lohn › Meine). Hier nur auf ihren Wunsch eintragen — die Notiz hält fest, wie sie es gewünscht hat.
        </p>
        <div className="flex gap-1">
          <button type="button" onClick={() => setNeu("digital")} disabled={busy} className={neu === "digital" ? "kasten-active" : "kasten-toggle-off"}>
            <Mail className="h-3.5 w-3.5" /> Digital
          </button>
          <button type="button" onClick={() => setNeu("papier")} disabled={busy} className={neu === "papier" ? "kasten-active" : "kasten-toggle-off"}>
            <Printer className="h-3.5 w-3.5" /> Papier
          </button>
        </div>
        <div>
          <label className="text-[10px] text-muted-foreground">Notiz (wie gewünscht, z. B. «per Mail vom 3.11.»)</label>
          <Input value={notiz} onChange={(e) => setNotiz(e.target.value)} maxLength={300} className="mt-1" disabled={busy} />
        </div>
        {historie.length > 0 && (
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">Verlauf</p>
            <ul className="space-y-1 max-h-40 overflow-y-auto">
              {historie.map((h, i) => (
                <li key={i} className="text-xs">
                  <span className="font-medium">{h.wahl === "digital" ? "Digital" : "Papier"}</span>
                  <span className="text-muted-foreground"> · {formatDateTimeFull(h.gewaehlt_at)} · {QUELLE_LABEL[h.quelle]}{h.akteur_name && h.quelle === "lohnverwaltung" ? ` (${h.akteur_name})` : ""}{h.notiz ? ` · ${h.notiz}` : ""}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="flex gap-2 pt-1">
          <button type="button" onClick={onClose} disabled={busy} className="kasten kasten-muted flex-1">Abbrechen</button>
          <button type="button" onClick={() => void speichern()} disabled={busy || notiz.trim().length < 5} className="kasten kasten-red flex-1 disabled:opacity-50 disabled:cursor-not-allowed">
            {busy ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Speichert…</> : neu === "digital" ? "Digital eintragen" : "Papier eintragen"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** Status des letzten automatischen Laufs (lohn_lauf) + Protokoll der letzten
 *  Läufe mit Ergebnis je Person/Monat und Grund. */
function LaufStatus() {
  const [laeufe, setLaeufe] = useState<Lauf[] | null | undefined>(undefined);
  const [protokollOpen, setProtokollOpen] = useState(false);

  useEffect(() => {
    let aktiv = true;
    fetch("/api/hr/lohn-lauf?anzahl=20", { cache: "no-store" })
      .then((r) => r.json().then((j) => ({ ok: r.ok, j })))
      .then(({ ok, j }) => {
        if (!aktiv) return;
        if (!ok || !j.success) { toast.error(`Status des Lohnlaufs: ${j.error ?? j.message ?? "Fehler"}`); setLaeufe(null); return; }
        setLaeufe((j.laeufe as Lauf[]) ?? []);
      })
      .catch((e) => { if (aktiv) { toast.error(`Status des Lohnlaufs: ${String(e)}`); setLaeufe(null); } });
    return () => { aktiv = false; };
  }, []);

  if (laeufe === undefined) return <div className="shimmer rounded-md h-5 w-72" />;
  const lauf = laeufe?.[0] ?? null;
  if (!lauf) {
    return <p className="text-xs text-muted-foreground">Automatischer Lauf: {laeufe === null ? "Status nicht ladbar." : "noch kein Lauf protokolliert."}</p>;
  }
  const art = laufArt(lauf);
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <LaufIcon art={art} />
      <span className={art === "problem" ? "text-red-700 dark:text-red-300" : art === "blockiert" ? "text-amber-700 dark:text-amber-300" : "text-muted-foreground"}>
        Automatischer Lauf {formatDateTimeFull(lauf.gestartet_at)}: {laufText(lauf)}
      </span>
      {lauf.alarm_fehler && (
        <span className="text-amber-700 dark:text-amber-300" data-tooltip={lauf.alarm_fehler}>· Alarm-Mail nicht versendet</span>
      )}
      <button type="button" onClick={() => setProtokollOpen(true)} className="kasten kasten-muted">
        <History className="h-3.5 w-3.5" /> Protokoll
      </button>
      <Modal open={protokollOpen} onClose={() => setProtokollOpen(false)} title="Automatischer Lohnlauf — Protokoll" size="lg">
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground mb-2">
            Die letzten {laeufe?.length ?? 0} Läufe. «Blockiert» heisst: offener oder ungeprüfter sehr langer Stempel — unter Monatsstunden prüfen, dann wird die Abrechnung erstellt.
          </p>
          {(laeufe ?? []).map((l, i) => <LaufZeile key={l.id} lauf={l} offen={i === 0} />)}
        </div>
      </Modal>
    </div>
  );
}

type LaufArtT = "problem" | "blockiert" | "pause" | "ok";
function laufArt(l: Lauf): LaufArtT {
  if (l.status === "fehler" || l.status === "teilweise" || l.status === "abgebrochen") return "problem";
  if (l.status === "blockiert") return "blockiert";
  if (l.status === "pausiert" || l.status === "laeuft") return "pause";
  return "ok";
}
function laufText(l: Lauf): string {
  if (l.status === "laeuft") return "läuft gerade";
  if (l.status === "abgebrochen") return "abgebrochen";
  return l.zusammenfassung ?? "—";
}
function LaufIcon({ art }: { art: LaufArtT }) {
  if (art === "problem") return <AlertTriangle className="h-3.5 w-3.5 text-red-600 dark:text-red-400 shrink-0" />;
  if (art === "blockiert" || art === "pause") return <AlertTriangle className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400 shrink-0" />;
  return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400 shrink-0" />;
}

const laufMonat = (s: string) => monatLabel({ jahr: Number(s.slice(0, 4)), monat: Number(s.slice(5, 7)) });

/** Ein Lauf im Protokoll, aufklappbar: Ergebnisse je Person/Monat mit Grund. */
function LaufZeile({ lauf, offen: anfangsOffen }: { lauf: Lauf; offen: boolean }) {
  const [offen, setOffen] = useState(anfangsOffen);
  const [hover, setHover] = useState(false);
  const fehler = lauf.ergebnisse.filter((e) => !e.ok && !e.blockiert);
  const blockiert = lauf.ergebnisse.filter((e) => !e.ok && e.blockiert);
  const erstellt = lauf.ergebnisse.filter((e) => e.ok && !e.uebersprungen);
  const uebersprungen = lauf.ergebnisse.filter((e) => e.ok && e.uebersprungen);
  const hatDetails = lauf.ergebnisse.length > 0 || lauf.hinweise.length > 0 || !!lauf.alarm_gesendet_at || !!lauf.alarm_fehler;
  return (
    <div className="rounded-md border border-border">
      <button
        type="button"
        onClick={() => hatDetails && setOffen((o) => !o)}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        className="w-full flex items-center gap-2 px-2 py-1.5 text-left text-xs rounded-md"
        style={{ backgroundColor: hover && hatDetails ? "color-mix(in srgb, var(--foreground) 6%, transparent)" : undefined, cursor: hatDetails ? "pointer" : "default" }}
      >
        {hatDetails ? (offen ? <ChevronDown className="h-3.5 w-3.5 shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0" />) : <span className="w-3.5 shrink-0" />}
        <LaufIcon art={laufArt(lauf)} />
        <span className="tabular-nums shrink-0">{formatDateTimeFull(lauf.gestartet_at)}</span>
        <span className="text-muted-foreground truncate">{lauf.ausloeser === "manuell" ? "von Hand · " : ""}{laufText(lauf)}</span>
        {lauf.alarm_gesendet_at && <Mail className="h-3 w-3 ml-auto shrink-0 text-muted-foreground" />}
      </button>
      {offen && hatDetails && (
        <div className="px-3 pb-2 pt-1 space-y-2 border-t border-border">
          {(lauf.alarm_gesendet_at || lauf.alarm_fehler) && (
            <p className={`text-[11px] ${lauf.alarm_fehler ? "text-amber-700 dark:text-amber-300" : "text-muted-foreground"}`}>
              Alarm-Mail: {lauf.alarm_gesendet_at ? `an ${lauf.alarm_empfaenger ?? 0} Person(en) ${formatDateTimeFull(lauf.alarm_gesendet_at)}` : "nicht versendet"}
              {lauf.alarm_fehler ? ` — ${lauf.alarm_fehler}` : ""}
            </p>
          )}
          <ErgebnisGruppe titel="Fehler" zeilen={fehler} ton="rot" text={(e) => e.fehler ?? "unbekannt"} />
          <ErgebnisGruppe titel="Blockiert — Stempel prüfen" zeilen={blockiert} ton="amber" text={(e) => e.blockiert ?? ""} />
          <ErgebnisGruppe titel="Erstellt" zeilen={erstellt} ton="neutral" text={(e) => (e.version && e.version > 1 ? `Fassung ${e.version}` : "")} />
          <ErgebnisGruppe titel="Übersprungen" zeilen={uebersprungen} ton="neutral" text={(e) => e.uebersprungen ?? ""} />
          {lauf.hinweise.length > 0 && (
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">Hinweise</p>
              <ul className="space-y-0.5">
                {lauf.hinweise.map((h, i) => (
                  <li key={i} className="text-xs">{h.name ? <span className="font-medium">{h.name}: </span> : null}{h.text}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ErgebnisGruppe({ titel, zeilen, ton, text }: { titel: string; zeilen: LaufErgebnis[]; ton: "rot" | "amber" | "neutral"; text: (e: LaufErgebnis) => string }) {
  if (zeilen.length === 0) return null;
  const rahmen = ton === "rot"
    ? "border-red-200 dark:border-red-500/30 bg-red-50/60 dark:bg-red-500/[0.08]"
    : ton === "amber"
      ? "border-amber-200 dark:border-amber-500/30 bg-amber-50/60 dark:bg-amber-500/[0.08]"
      : "border-border";
  return (
    <div>
      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">{titel} ({zeilen.length})</p>
      <ul className="space-y-1">
        {zeilen.map((e, i) => {
          const t = text(e);
          return (
            <li key={i} className={`text-xs rounded-md border px-2 py-1 ${rahmen}`}>
              <span className="font-medium">{e.name} · {laufMonat(e.monat)}</span>
              {t && <span className={ton === "neutral" ? "text-muted-foreground" : "block text-muted-foreground"}>{ton === "neutral" ? ` — ${t}` : t}</span>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function sortDocs(a: WageDoc, b: WageDoc): number {
  // Lohnausweis zuerst, dann Lohnabrechnungen absteigend nach Monat
  if (a.doc_type !== b.doc_type) return a.doc_type === "lohnausweis" ? -1 : 1;
  return (b.period_month ?? 0) - (a.period_month ?? 0) || (b.version ?? 1) - (a.version ?? 1);
}

function docLabel(doc: WageDoc): string {
  return doc.doc_type === "lohnausweis"
    ? `Lohnausweis ${doc.year}`
    : `Lohnabrechnung ${MONTH_NAMES[(doc.period_month ?? 1) - 1]} ${doc.year}`;
}

function DocRow({ doc, busy, onDownload, onArchive, onRestore, zustellung, wahlAktuell, onAusgedruckt }: {
  doc: WageDoc;
  busy: boolean;
  onDownload: () => void;
  onArchive: () => void;
  onRestore: () => void;
  zustellung: Zustellung | null;
  wahlAktuell: "digital" | "papier" | null;
  onAusgedruckt: () => void;
}) {
  const sizeMb = doc.file_size ? (doc.file_size / 1024 / 1024).toFixed(2) : null;
  const herkunft = doc.source === "manual" ? "hochgeladen" : "erzeugt";
  const von = doc.uploaded_by_name ? ` von ${doc.uploaded_by_name}` : "";
  return (
    <div className="flex items-center justify-between gap-2 px-3 py-2 rounded-lg border border-border bg-foreground/[0.02] dark:bg-foreground/[0.04]">
      <div className="min-w-0 flex items-center gap-2">
        <FileText className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        <div className="min-w-0">
          <p className="text-sm font-medium truncate">
            {docLabel(doc)}
            {(doc.version ?? 1) > 1 && (
              <span className="ml-2 text-[10px] font-semibold rounded-full px-1.5 py-0.5 bg-foreground/[0.07] dark:bg-foreground/[0.15] text-muted-foreground align-middle">
                Fassung {doc.version}
              </span>
            )}
          </p>
          <p className="text-[10px] text-muted-foreground">
            {doc.archived_at
              ? `Im Papierkorb seit ${formatDateTimeFull(doc.archived_at)}${doc.archived_by_name ? ` (${doc.archived_by_name})` : ""}${doc.archive_reason ? ` · ${doc.archive_reason}` : ""}`
              : `${herkunft[0].toUpperCase()}${herkunft.slice(1)} am ${new Date(doc.uploaded_at).toLocaleDateString("de-CH", { timeZone: "Europe/Zurich" })}${von}${sizeMb ? ` · ${sizeMb} MB` : ""}`}
          </p>
          {!doc.archived_at && zustellung && (
            <ZustellNachweis z={zustellung} wahlAktuell={wahlAktuell} busy={busy} onAusgedruckt={onAusgedruckt} />
          )}
        </div>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <button type="button" onClick={onDownload} className="kasten kasten-muted" data-tooltip="Herunterladen" aria-label="Herunterladen">
          <Download className="h-3.5 w-3.5" />
        </button>
        {doc.archived_at ? (
          <button type="button" onClick={onRestore} disabled={busy} className="kasten kasten-muted" data-tooltip="Wiederherstellen" aria-label="Wiederherstellen">
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ArchiveRestore className="h-3.5 w-3.5" />}
          </button>
        ) : (
          <button type="button" onClick={onArchive} disabled={busy} className="kasten kasten-red" data-tooltip="In den Papierkorb (nie endgültig gelöscht)" aria-label="In den Papierkorb">
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Archive className="h-3.5 w-3.5" />}
          </button>
        )}
      </div>
    </div>
  );
}

/** Zustellnachweis: digital = bereitgestellt / benachrichtigt / geöffnet;
 *  Papier (oder noch keine Einwilligung) = «Papier — ausdrucken» → abhaken. */
function ZustellNachweis({ z, wahlAktuell, busy, onAusgedruckt }: { z: Zustellung; wahlAktuell: "digital" | "papier" | null; busy: boolean; onAusgedruckt: () => void }) {
  const geoeffnet = z.erstmals_geoeffnet_at
    ? `geöffnet ${tagKurz(z.erstmals_geoeffnet_at)}${z.anzahl_geoeffnet > 1 ? ` (${z.anzahl_geoeffnet}×, zuletzt ${tagKurz(z.zuletzt_geoeffnet_at ?? z.erstmals_geoeffnet_at)})` : ""}`
    : "noch nicht geöffnet";
  const benachrichtigt = z.benachrichtigt_at
    ? `benachrichtigt (${(z.benachrichtigt_kanaele ?? []).map((k) => KANAL_LABEL[k] ?? k).join(", ")})`
    : "nicht benachrichtigt";
  // Digital, oder inzwischen digital eingewilligt und von der Person geöffnet.
  const digital = z.wahl === "digital" || (wahlAktuell === "digital" && !!z.erstmals_geoeffnet_at && !z.ausgedruckt_at);
  if (digital) {
    return (
      <p className="text-[10px] text-muted-foreground flex items-center gap-1">
        <Mail className="h-3 w-3 shrink-0" />
        Bereitgestellt {tagKurz(z.bereitgestellt_at)} · {benachrichtigt} ·{" "}
        <span className={z.erstmals_geoeffnet_at ? "text-emerald-700 dark:text-emerald-300" : ""}>{geoeffnet}</span>
      </p>
    );
  }
  return (
    <p className="text-[10px] text-muted-foreground flex flex-wrap items-center gap-1">
      <Printer className="h-3 w-3 shrink-0" />
      {z.ausgedruckt_at ? (
        <span className="text-emerald-700 dark:text-emerald-300">Ausgedruckt {tagKurz(z.ausgedruckt_at)}{z.ausgedruckt_von_name ? ` (${z.ausgedruckt_von_name})` : ""}</span>
      ) : (
        <>
          <span className="font-medium text-amber-700 dark:text-amber-300">Papier{z.wahl === null ? " (keine Einwilligung digital)" : ""} — ausdrucken</span>
          <button type="button" onClick={onAusgedruckt} disabled={busy} className="kasten kasten-muted text-[10px] py-0 px-1.5 ml-1" data-tooltip="Ausgedruckt und abgegeben — wird mit Datum und Name festgehalten">
            {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <CheckCircle2 className="h-3 w-3" />} Ausgedruckt
          </button>
        </>
      )}
      {z.erstmals_geoeffnet_at && <span>· {geoeffnet}</span>}
    </p>
  );
}

function UploadModal({ open, onClose, profileId, onDone }: { open: boolean; onClose: () => void; profileId: string; onDone: () => void }) {
  const thisYear = new Date().getFullYear();
  const [docType, setDocType] = useState<"lohnabrechnung" | "lohnausweis">("lohnabrechnung");
  const [year, setYear] = useState(String(thisYear));
  const [month, setMonth] = useState(String(new Date().getMonth() + 1));
  const [file, setFile] = useState<File | null>(null);
  const [notes, setNotes] = useState("");
  const [uploading, setUploading] = useState(false);
  // Rückfrage «neue Fassung», wenn es für den Zeitraum schon ein Dokument gibt.
  const [rueckfrage, setRueckfrage] = useState<string | null>(null);

  async function senden(neueFassung: boolean) {
    if (!file) { toast.error("PDF auswählen"); return; }
    if (file.type !== "application/pdf") { toast.error("Nur PDF erlaubt"); return; }
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("profile_id", profileId);
      fd.append("doc_type", docType);
      fd.append("year", year);
      if (docType === "lohnabrechnung") fd.append("period_month", month);
      if (notes) fd.append("notes", notes);
      if (neueFassung) fd.append("neue_fassung", "true");
      const res = await fetch("/api/hr/wage-documents", { method: "POST", body: fd });
      const j = await res.json().catch(() => ({}));
      if (!j.success) {
        if (j.requires_confirm === "neue_fassung") { setRueckfrage(j.error); return; }
        TOAST.errorOr(j.error);
        return;
      }
      toast.success(j.version > 1 ? `Hochgeladen als Fassung ${j.version}` : "Dokument hochgeladen");
      setFile(null); setNotes(""); setRueckfrage(null);
      onDone();
    } catch (e) {
      toast.error(`Hochladen fehlgeschlagen: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setUploading(false);
    }
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    void senden(false);
  }

  return (
    <Modal open={open} onClose={() => { if (!uploading) { setRueckfrage(null); onClose(); } }} title="Lohndokument hochladen" size="md">
      <form onSubmit={submit} className="space-y-3">
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="text-[10px] text-muted-foreground">Typ</label>
            <div className="mt-1">
              <SearchableSelect
                value={docType}
                onChange={(v) => { setDocType((v || "lohnabrechnung") as "lohnabrechnung" | "lohnausweis"); setRueckfrage(null); }}
                items={[
                  { id: "lohnabrechnung", label: "Lohnabrechnung (monatlich)" },
                  { id: "lohnausweis",    label: "Lohnausweis (jährlich)" },
                ]}
                searchable={false}
                clearable={false}
              />
            </div>
          </div>
          <div>
            <label className="text-[10px] text-muted-foreground">Jahr</label>
            <Input type="number" value={year} onChange={(e) => { setYear(e.target.value); setRueckfrage(null); }} min={2020} max={2100} className="mt-1" />
          </div>
        </div>
        {docType === "lohnabrechnung" && (
          <div>
            <label className="text-[10px] text-muted-foreground">Monat</label>
            <div className="mt-1">
              <SearchableSelect
                value={month}
                onChange={(v) => { setMonth(v || String(new Date().getMonth() + 1)); setRueckfrage(null); }}
                items={MONTH_NAMES.map((m, i) => ({ id: String(i + 1), label: m }))}
                searchable={false}
                clearable={false}
              />
            </div>
          </div>
        )}
        <div>
          <label className="text-[10px] text-muted-foreground">PDF-Datei</label>
          <input type="file" accept="application/pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="mt-1 block w-full text-xs file:mr-2 file:px-3 file:py-1.5 file:rounded-lg file:border file:border-border file:bg-foreground/[0.05] file:text-foreground file:text-xs file:cursor-pointer" />
          {file && <p className="text-[10px] text-muted-foreground mt-1">{file.name} · {(file.size / 1024 / 1024).toFixed(2)} MB</p>}
        </div>
        <div>
          <label className="text-[10px] text-muted-foreground">Notiz (optional)</label>
          <Input value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} className="mt-1" />
        </div>
        {rueckfrage && (
          <p className="text-xs rounded-md border border-amber-200 dark:border-amber-500/30 bg-amber-50/60 dark:bg-amber-500/[0.08] px-2 py-1.5">{rueckfrage}</p>
        )}
        <div className="flex gap-2 pt-2">
          <button type="button" onClick={() => { setRueckfrage(null); onClose(); }} disabled={uploading} className="kasten kasten-muted flex-1">Abbrechen</button>
          {rueckfrage ? (
            <button type="button" onClick={() => void senden(true)} disabled={uploading || !file} className="kasten kasten-red flex-1">
              {uploading ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Lädt…</> : "Als neue Fassung hochladen"}
            </button>
          ) : (
            <button type="submit" disabled={uploading || !file} className="kasten kasten-red flex-1">
              {uploading ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Lädt…</> : "Hochladen"}
            </button>
          )}
        </div>
      </form>
    </Modal>
  );
}

function GenerateModal({ open, onClose, profileId, employee, onDone }: { open: boolean; onClose: () => void; profileId: string; employee: Employee | undefined; onDone: () => void }) {
  // Nur gesperrte Monate (ab dem 5. des Folgemonats); Vorgabe = letzter gesperrter.
  const [monate] = useState(() => letzteGesperrteMonate(todayLocalIso(), 24));
  const [wahl, setWahl] = useState(() => monatSchluessel(monate[0]));
  const [busy, setBusy] = useState(false);
  const [rueckfrage, setRueckfrage] = useState<string | null>(null);
  // Phase 2: eine weitere Fassung ist eine KORREKTURFASSUNG — Begründung
  // Pflicht, Auszahlungsdatum optional (leer = nächster Lohn).
  const [begruendung, setBegruendung] = useState("");
  const [auszahlungsdatum, setAuszahlungsdatum] = useState("");

  function zuruecksetzen() {
    setRueckfrage(null);
    setBegruendung("");
    setAuszahlungsdatum("");
  }

  async function erzeugen(neueFassung: boolean) {
    const [year, month] = wahl.split("-").map(Number);
    if (neueFassung && begruendung.trim().length < KORREKTUR_MIN) {
      toast.error(`Begründung: mindestens ${KORREKTUR_MIN} Zeichen`);
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/hr/wage-documents/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          neueFassung
            ? { profile_id: profileId, year, month, neue_fassung: true, begruendung: begruendung.trim(), ...(auszahlungsdatum ? { auszahlungsdatum } : {}) }
            : { profile_id: profileId, year, month, neue_fassung: false },
        ),
      });
      const j = await res.json().catch(() => ({}));
      if (!j.success) {
        // altbestand (409) / begruendung_fehlt (400): Meldung des Servers zeigen.
        if (j.code === "altbestand" || j.code === "begruendung_fehlt") { TOAST.errorOr(j.error); return; }
        if (j.requires_confirm === "neue_fassung") { setRueckfrage(j.error); return; }
        TOAST.errorOr(j.error);
        return;
      }
      toast.success(j.art === "korrektur" ? korrekturText(j) : "Lohnabrechnung erzeugt");
      zuruecksetzen();
      onDone();
    } catch (e) {
      toast.error(`Erzeugen fehlgeschlagen: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={() => { if (!busy) { zuruecksetzen(); onClose(); } }} closable={!busy} title="Lohnabrechnung erzeugen" size="md">
      <div className="space-y-3">
        <p className="text-xs text-muted-foreground">
          Erzeugt die PDF-Lohnabrechnung für <strong>{employee?.full_name ?? "—"}</strong> aus den erfassten Stunden + Lohndaten.
          Nur abgeschlossene Monate (gesperrt ab dem 5. des Folgemonats). Gibt es schon eine, wird nachgefragt — eine weitere
          Fassung ist eine Korrekturfassung mit Begründung; die bisherige bleibt erhalten.
        </p>
        <div>
          <label className="text-[10px] text-muted-foreground">Monat</label>
          <div className="mt-1">
            <SearchableSelect
              value={wahl}
              onChange={(v) => { if (v) setWahl(v); zuruecksetzen(); }}
              items={monate.map((m) => ({ id: monatSchluessel(m), label: monatLabel(m) }))}
              clearable={false}
            />
          </div>
        </div>
        {rueckfrage && (
          <>
            <p className="text-xs rounded-md border border-amber-200 dark:border-amber-500/30 bg-amber-50/60 dark:bg-amber-500/[0.08] px-2 py-1.5">{rueckfrage}</p>
            <KorrekturEingabe
              begruendung={begruendung}
              setBegruendung={setBegruendung}
              datum={auszahlungsdatum}
              setDatum={setAuszahlungsdatum}
              disabled={busy}
            />
          </>
        )}
        <div className="flex gap-2 pt-2">
          <button type="button" onClick={() => { zuruecksetzen(); onClose(); }} disabled={busy} className="kasten kasten-muted flex-1">Abbrechen</button>
          <button
            type="button"
            onClick={() => void erzeugen(!!rueckfrage)}
            disabled={busy || (!!rueckfrage && begruendung.trim().length < KORREKTUR_MIN)}
            className="kasten kasten-red flex-1 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {busy
              ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Erzeugt…</>
              : rueckfrage
              ? "Korrekturfassung erzeugen"
              : <><Plus className="h-3.5 w-3.5" /> Erzeugen</>}
          </button>
        </div>
      </div>
    </Modal>
  );
}
