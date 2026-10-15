"use client";

// Technik-Seite, Tab «Wissen» (Mischa 2026-10-16: «sollte bei Technik sein unter einem Tab ‹Wissen›; bei Unklarheiten
// soll dort die KI auch fragen»). Migration 344, API /api/technik/wissen und /api/technik/wissen/fragen.
// - Links das Firmenwissen: Einträge, die Admins pflegen (Kategorie, Begriff, Erklärung, Bezug auf Stammdaten, aktiv).
//   Suche und Filter in der DB (?wq=, ?wkat=, ?wstatus= in der URL — Reload behält sie, §10).
// - Rechts «Offene Fragen der KI»: Rückfragen von Claude beim Einordnen im Rückstau ZZ, dedupliziert mit «betrifft n
//   Dokumente». Beantworten = Wissens-Eintrag (Kategorie vorgeschlagen, editierbar), die offenen, unentschiedenen
//   Vorschläge der betroffenen Dateien werden neu berechnet.
// Nur Admins, nur Laptop (die Seite gated). Bearbeiten im Modal (ui/modal), Enter = Tab (global), Toasts bei Fehlern.

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { AlertTriangle, BookOpen, HelpCircle, Loader2, MessageCircleQuestion, Plus, RotateCw, Search, Trash2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { AutoTextarea } from "@/components/ui/auto-textarea";
import { Modal } from "@/components/ui/modal";
import { EmptyState } from "@/components/ui/empty-state";
import { useConfirm } from "@/components/ui/use-confirm";
import { SearchableSelect, type SelectItem } from "@/components/searchable-select";
import {
  BEGRIFF_MAX,
  BEZUG_ART_TEXT,
  ERKLAERUNG_MAX,
  FRAGE_ART_TEXT,
  KATEGORIE_FUER_FRAGE,
  WISSEN_KATEGORIE_TEXT,
  WISSEN_KATEGORIEN,
  type BezugArt,
  type FrageArt,
  type WissenKategorie,
} from "@/lib/ki/wissen";
import { datumLang, tausend, uhr } from "./format";

type Status = "aktiv" | "inaktiv" | "alle";
const STATUS_TEXT: Readonly<Record<Status, string>> = { aktiv: "Aktiv", inaktiv: "Inaktiv", alle: "Alle" };

interface Eintrag {
  id: string;
  kategorie: WissenKategorie;
  begriff: string;
  erklaerung: string;
  bezug_art: BezugArt | null;
  bezug_id: string | null;
  bezug_name: string | null;
  aktiv: boolean;
  geaendert_am: string;
  geaendert_von_name: string | null;
}

interface Frage {
  id: string;
  art: FrageArt;
  begriff: string | null;
  frage: string;
  zuletzt_gefragt: string;
  dokumente: number;
}

interface Formular {
  kategorie: WissenKategorie;
  begriff: string;
  erklaerung: string;
  bezug: string; // «art:id» oder ""
  aktiv: boolean;
}

const LEER: Formular = { kategorie: "abkuerzung", begriff: "", erklaerung: "", bezug: "", aktiv: true };
const KATEGORIE_ITEMS: SelectItem[] = WISSEN_KATEGORIEN.map((k) => ({ id: k, label: WISSEN_KATEGORIE_TEXT[k] }));
const FILTER_ITEMS: SelectItem[] = [{ id: "", label: "Alle Kategorien" }, ...KATEGORIE_ITEMS];

const zeitText = (z: string) => `${datumLang(z)}, ${uhr(z)}`;
const dokText = (n: number) => `betrifft ${tausend(n)} ${n === 1 ? "Dokument" : "Dokumente"}`;

function leseUrl(): { q: string; kategorie: string; status: Status } {
  if (typeof window === "undefined") return { q: "", kategorie: "", status: "aktiv" };
  const p = new URLSearchParams(window.location.search);
  const k = p.get("wkat") ?? "";
  const s = p.get("wstatus");
  return {
    q: (p.get("wq") ?? "").slice(0, 100),
    kategorie: (WISSEN_KATEGORIEN as readonly string[]).includes(k) ? k : "",
    status: s === "inaktiv" || s === "alle" ? s : "aktiv",
  };
}

function schreibeUrl(q: string, kategorie: string, status: Status) {
  const url = new URL(window.location.href);
  const setze = (k: string, v: string) => (v ? url.searchParams.set(k, v) : url.searchParams.delete(k));
  setze("wq", q);
  setze("wkat", kategorie);
  setze("wstatus", status === "aktiv" ? "" : status);
  window.history.replaceState(window.history.state, "", url.toString());
}

async function json<T>(r: Response): Promise<T> {
  const j = (await r.json().catch(() => null)) as (T & { success?: boolean; error?: string }) | null;
  if (!r.ok || !j || j.success !== true) throw new Error(j?.error || `HTTP ${r.status}`);
  return j;
}

/** Feld mit Mini-Label (Form-Layout-Referenz). */
function Feld({ label, htmlFor, hinweis, children }: { label: string; htmlFor?: string; hinweis?: ReactNode; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <label htmlFor={htmlFor} className="text-xs font-medium text-muted-foreground mb-1 block">{label}</label>
      {children}
      {hinweis ? <p className="text-[11px] text-muted-foreground mt-1">{hinweis}</p> : null}
    </div>
  );
}

function Chip({ children, ton = "neutral" }: { children: ReactNode; ton?: "neutral" | "amber" | "grau" }) {
  const farbe = ton === "amber"
    ? "bg-amber-500/15 text-amber-800 dark:bg-amber-400/20 dark:text-amber-200"
    : ton === "grau"
      ? "bg-foreground/[0.06] text-muted-foreground dark:bg-foreground/[0.14]"
      : "bg-foreground/[0.07] text-foreground/80 dark:bg-foreground/[0.15]";
  return <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium whitespace-nowrap ${farbe}`}>{children}</span>;
}

/** Spalten der Wissens-Liste (Kopf und Zeilen gleich): Kategorie · Begriff mit Bezug · Erklärung · geändert. */
const LISTE_SPALTEN = "grid-cols-[118px_minmax(0,190px)_minmax(0,1fr)_96px]";

/** Eine Zeile der Wissens-Liste — ganze Zeile klickbar (öffnet das Bearbeiten), Hover über .row-hover. */
function EintragZeile({ e, onOeffnen }: { e: Eintrag; onOeffnen: (e: Eintrag) => void }) {
  const bezug = e.bezug_name ? `${e.bezug_art ? `${BEZUG_ART_TEXT[e.bezug_art]}: ` : ""}${e.bezug_name}` : null;
  return (
    <button
      type="button"
      onClick={() => onOeffnen(e)}
      className={`row-hover [--row-hover-x:0.5rem] w-full text-left grid ${LISTE_SPALTEN} gap-3 items-start px-2 py-2 border-t first:border-t-0`}
      aria-label={`${e.begriff} bearbeiten`}
    >
      <span className="pt-0.5"><Chip>{WISSEN_KATEGORIE_TEXT[e.kategorie]}</Chip></span>
      <span className="min-w-0">
        <span className="block text-sm font-medium truncate">{e.begriff}</span>
        {bezug || !e.aktiv ? (
          <span className="mt-0.5 flex items-center gap-1.5 min-w-0">
            {!e.aktiv ? <Chip ton="grau">inaktiv</Chip> : null}
            {bezug ? <span className="text-xs text-muted-foreground truncate" data-tooltip={bezug}>{bezug}</span> : null}
          </span>
        ) : null}
      </span>
      <span className="min-w-0 text-sm text-muted-foreground line-clamp-2 whitespace-pre-line">{e.erklaerung}</span>
      <span className="min-w-0 text-xs text-muted-foreground">
        <span className="block tabular-nums">{datumLang(e.geaendert_am)}</span>
        <span className="block truncate">{e.geaendert_von_name ?? "—"}</span>
      </span>
    </button>
  );
}

function FrageZeile({ f, busy, onAntwort, onVerwerfen }: { f: Frage; busy: boolean; onAntwort: (f: Frage) => void; onVerwerfen: (f: Frage) => void }) {
  return (
    <li className="px-3 py-2.5 border-t first:border-t-0 flex flex-col gap-1.5">
      <div className="flex items-start gap-2">
        <span className="pt-0.5"><Chip ton="amber">{FRAGE_ART_TEXT[f.art] ?? f.art}</Chip></span>
        <p className="text-sm min-w-0 flex-1">{f.frage}</p>
      </div>
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <span className="text-xs text-muted-foreground">{dokText(f.dokumente)} · zuletzt {zeitText(f.zuletzt_gefragt)}</span>
        <span className="flex gap-1.5">
          <button type="button" className="kasten kasten-muted" disabled={busy} onClick={() => onVerwerfen(f)}>
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            Verwerfen
          </button>
          <button type="button" className="kasten kasten-blue" disabled={busy} onClick={() => onAntwort(f)}>
            <MessageCircleQuestion className="h-3.5 w-3.5" />
            Beantworten
          </button>
        </span>
      </div>
    </li>
  );
}

export function WissenTeil({ tabs, onFragenAnzahl }: { tabs: ReactNode; onFragenAnzahl: (n: number) => void }) {
  const { confirm, ConfirmModalElement } = useConfirm();
  const start = useRef(leseUrl());
  const [suche, setSuche] = useState(start.current.q);
  const [kategorie, setKategorie] = useState(start.current.kategorie);
  const [status, setStatus] = useState<Status>(start.current.status);
  const [eintraege, setEintraege] = useState<Eintrag[]>([]);
  const [anzahl, setAnzahl] = useState(0);
  const [gesamt, setGesamt] = useState(0);
  const [laden, setLaden] = useState<"laedt" | "fehler" | "ok">("laedt");
  const [fragen, setFragen] = useState<Frage[] | null>(null);
  const [fragenFehler, setFragenFehler] = useState(false);
  const [optionen, setOptionen] = useState<SelectItem[] | null>(null);
  const [offen, setOffen] = useState<{ art: "neu" | "bearbeiten" | "antwort"; eintrag?: Eintrag; frage?: Frage } | null>(null);
  const [form, setForm] = useState<Formular>(LEER);
  const [saving, setSaving] = useState(false);
  const [busyFrage, setBusyFrage] = useState<string | null>(null);
  // Liste wird gerade neu geholt (Suche/Filter/nach dem Speichern) — Spinner im Suchfeld.
  const [aktualisiert, setAktualisiert] = useState(false);
  const abfrageNr = useRef(0);

  const listeLaden = useCallback(async (q: string, kat: string, st: Status) => {
    const nr = ++abfrageNr.current;
    setAktualisiert(true);
    try {
      const p = new URLSearchParams({ status: st });
      if (q) p.set("q", q);
      if (kat) p.set("kategorie", kat);
      const j = await json<{ eintraege: Eintrag[]; anzahl: number; gesamt: number }>(await fetch(`/api/technik/wissen?${p}`, { cache: "no-store" }));
      if (nr !== abfrageNr.current) return;
      setEintraege(j.eintraege);
      setAnzahl(j.anzahl);
      setGesamt(j.gesamt);
      setLaden("ok");
    } catch (e) {
      if (nr !== abfrageNr.current) return;
      setLaden("fehler");
      toast.error("Wissen konnte nicht geladen werden", { description: e instanceof Error ? e.message : undefined });
    } finally {
      if (nr === abfrageNr.current) setAktualisiert(false);
    }
  }, []);

  const fragenLaden = useCallback(async () => {
    try {
      const j = await json<{ fragen: Frage[] }>(await fetch("/api/technik/wissen/fragen", { cache: "no-store" }));
      setFragen(j.fragen);
      setFragenFehler(false);
      onFragenAnzahl(j.fragen.length);
    } catch (e) {
      setFragenFehler(true);
      toast.error("Fragen der KI konnten nicht geladen werden", { description: e instanceof Error ? e.message : undefined });
    }
  }, [onFragenAnzahl]);

  // Suche entprellt (erster Aufruf sofort), Filter sofort; Zustand in der URL.
  const erster = useRef(true);
  useEffect(() => {
    const q = suche.trim();
    const t = setTimeout(() => {
      schreibeUrl(q, kategorie, status);
      void listeLaden(q, kategorie, status);
    }, erster.current ? 0 : 250);
    erster.current = false;
    return () => clearTimeout(t);
  }, [suche, kategorie, status, listeLaden]);

  useEffect(() => {
    void fragenLaden();
  }, [fragenLaden]);

  const optionenLaden = useCallback(async () => {
    if (optionen) return;
    try {
      const j = await json<{ optionen: SelectItem[] }>(await fetch("/api/technik/wissen?optionen=1", { cache: "no-store" }));
      setOptionen(j.optionen);
    } catch (e) {
      setOptionen([]);
      toast.error("Stammdaten für den Bezug konnten nicht geladen werden", { description: e instanceof Error ? e.message : undefined });
    }
  }, [optionen]);

  function oeffneNeu() {
    setForm({ ...LEER, kategorie: (kategorie || "abkuerzung") as WissenKategorie });
    setOffen({ art: "neu" });
    void optionenLaden();
  }

  function oeffneEintrag(e: Eintrag) {
    setForm({ kategorie: e.kategorie, begriff: e.begriff, erklaerung: e.erklaerung, bezug: e.bezug_art && e.bezug_id ? `${e.bezug_art}:${e.bezug_id}` : "", aktiv: e.aktiv });
    setOffen({ art: "bearbeiten", eintrag: e });
    void optionenLaden();
  }

  function oeffneAntwort(f: Frage) {
    setForm({ ...LEER, kategorie: KATEGORIE_FUER_FRAGE[f.art] ?? "sonstiges", begriff: (f.begriff ?? "").slice(0, BEGRIFF_MAX) });
    setOffen({ art: "antwort", frage: f });
    void optionenLaden();
  }

  const schliessen = () => {
    if (!saving) setOffen(null);
  };

  async function speichern(ev: React.FormEvent) {
    ev.preventDefault();
    if (!offen) return;
    if (!form.begriff.trim() || !form.erklaerung.trim()) {
      toast.error(offen.art === "antwort" ? "Begriff und Antwort sind Pflichtfelder" : "Begriff und Erklärung sind Pflichtfelder");
      return;
    }
    const [bezug_art, bezug_id] = form.bezug ? form.bezug.split(":") : [null, null];
    const nutzlast = { kategorie: form.kategorie, begriff: form.begriff, erklaerung: form.erklaerung, bezug_art, bezug_id, aktiv: form.aktiv };
    setSaving(true);
    try {
      if (offen.art === "antwort" && offen.frage) {
        const j = await json<{ neu_berechnen: number }>(await fetch("/api/technik/wissen/fragen", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ aktion: "beantworten", id: offen.frage.id, ...nutzlast }),
        }));
        toast.success("Antwort gespeichert", {
          description: j.neu_berechnen > 0
            ? `${j.neu_berechnen === 1 ? "1 offener Vorschlag wird" : `${tausend(j.neu_berechnen)} offene Vorschläge werden`} mit dem neuen Wissen neu berechnet.`
            : "Kein offener Vorschlag betroffen — das Wissen gilt ab jetzt.",
        });
        void fragenLaden();
      } else {
        await json(await fetch("/api/technik/wissen", {
          method: offen.art === "neu" ? "POST" : "PATCH", headers: { "Content-Type": "application/json" },
          body: JSON.stringify(offen.art === "neu" ? nutzlast : { id: offen.eintrag!.id, ...nutzlast }),
        }));
        toast.success(offen.art === "neu" ? "Eintrag angelegt" : "Gespeichert");
      }
      setOffen(null);
      void listeLaden(suche.trim(), kategorie, status);
    } catch (e) {
      toast.error("Speichern fehlgeschlagen", { description: e instanceof Error ? e.message : undefined });
    } finally {
      setSaving(false);
    }
  }

  async function loeschen() {
    const e = offen?.eintrag;
    if (!e) return;
    const ok = await confirm({ title: "Eintrag löschen?", message: `«${e.begriff}» wird entfernt. Die KI kennt ihn danach nicht mehr.`, confirmLabel: "Löschen", variant: "red" });
    if (!ok) return;
    setSaving(true);
    try {
      await json(await fetch(`/api/technik/wissen?id=${encodeURIComponent(e.id)}`, { method: "DELETE" }));
      toast.success("Gelöscht");
      setOffen(null);
      void listeLaden(suche.trim(), kategorie, status);
    } catch (err) {
      toast.error("Löschen fehlgeschlagen", { description: err instanceof Error ? err.message : undefined });
    } finally {
      setSaving(false);
    }
  }

  async function verwerfen(f: Frage) {
    const ok = await confirm({ title: "Frage verwerfen?", message: "Die KI stellt diese Frage danach nicht mehr.", confirmLabel: "Verwerfen", variant: "red" });
    if (!ok) return;
    setBusyFrage(f.id);
    try {
      await json(await fetch("/api/technik/wissen/fragen", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ aktion: "verwerfen", id: f.id }),
      }));
      toast.success("Frage verworfen");
      void fragenLaden();
    } catch (e) {
      toast.error("Verwerfen fehlgeschlagen", { description: e instanceof Error ? e.message : undefined });
    } finally {
      setBusyFrage(null);
    }
  }

  const gefiltert = suche.trim().length > 0 || kategorie !== "" || status !== "aktiv";
  const titel = offen?.art === "antwort" ? "Frage der KI beantworten" : offen?.art === "bearbeiten" ? "Eintrag bearbeiten" : "Neuer Eintrag";

  return (
    <div className="page-enter flex flex-col gap-3">
      <header className="flex items-baseline gap-x-3 gap-y-0.5 flex-wrap">
        <h1 className="text-2xl font-bold leading-tight m-0" style={{ fontFamily: "var(--font-heading)" }}>Technik</h1>
        <span className="text-[13px] text-muted-foreground">Wissen der KI · Begriffe, Regeln und Zuordnungen, die die lokale KI und Claude beim Einordnen kennen</span>
      </header>
      {tabs}

      <div className="grid gap-4 items-start grid-cols-[minmax(0,1fr)_340px] 2xl:grid-cols-[minmax(0,1fr)_420px] mt-1">
        {/* Firmenwissen */}
        <section aria-labelledby="wissen-liste" className="rounded-xl border bg-card min-w-0">
          {/* Kopf in zwei Zeilen: Titel + Primäraktion, darunter Suche und Filter (passt auch bei 1366 px ohne Umbruch). */}
          <div className="px-3 py-2.5 border-b flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <h2 id="wissen-liste" className="text-sm font-semibold flex items-center gap-1.5">
                <BookOpen className="h-4 w-4 text-muted-foreground" /> Firmenwissen
                {laden === "ok" ? <span className="text-xs font-normal text-muted-foreground tabular-nums">{gefiltert ? `${tausend(anzahl)} von ${tausend(gesamt)}` : tausend(anzahl)}</span> : null}
              </h2>
              <button type="button" onClick={oeffneNeu} className="kasten kasten-red ml-auto shrink-0">
                <Plus className="h-3.5 w-3.5" /> Neuer Eintrag
              </button>
            </div>
            <div className="flex items-center gap-2">
              <div className="relative flex-1 min-w-0">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
                <Input placeholder="Begriff, Erklärung oder Bezug suchen…" value={suche} onChange={(e) => setSuche(e.target.value)} className="pl-9 pr-9" aria-label="Wissen durchsuchen" />
                {aktualisiert && laden === "ok" ? <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 animate-spin text-muted-foreground pointer-events-none" aria-label="Wird geladen" /> : null}
              </div>
              <div className="w-48 shrink-0">
                <SearchableSelect value={kategorie} onChange={(v) => setKategorie(v)} items={FILTER_ITEMS} searchable={false} clearable={false} active={kategorie !== ""} placeholder="Alle Kategorien" />
              </div>
              <div role="group" aria-label="Status" className="inline-flex gap-1 shrink-0">
                {(Object.keys(STATUS_TEXT) as Status[]).map((s) => (
                  <button key={s} type="button" aria-pressed={status === s} onClick={() => setStatus(s)} className={`kasten ${status === s ? "kasten-active" : "kasten-toggle-off"}`}>
                    {STATUS_TEXT[s]}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {laden === "laedt" ? (
            <div className="p-3 flex flex-col gap-2" aria-busy="true">
              {[0, 1, 2, 3, 4].map((i) => <div key={i} className="shimmer rounded-md h-10" />)}
            </div>
          ) : laden === "fehler" ? (
            <EmptyState
              icon={AlertTriangle}
              title="Wissen konnte nicht geladen werden"
              action={<button type="button" className="kasten kasten-muted" onClick={() => { setLaden("laedt"); void listeLaden(suche.trim(), kategorie, status); }}><RotateCw className="h-3.5 w-3.5" /> Erneut laden</button>}
            />
          ) : eintraege.length === 0 ? (
            <EmptyState
              icon={BookOpen}
              title={gefiltert ? "Keine Treffer" : "Noch kein Firmenwissen"}
              description={gefiltert
                ? "Anderen Suchbegriff oder Filter versuchen."
                : "Hier steht, was die KI über EVENTLINE wissen soll: Abkürzungen, Benennungsregeln, wer zu wem gehört, Ansprechpartner und Ordner-Hinweise. Fragen der KI rechts lassen sich direkt beantworten."}
              action={gefiltert
                ? <button type="button" className="kasten kasten-muted" onClick={() => { setSuche(""); setKategorie(""); setStatus("aktiv"); }}>Filter zurücksetzen</button>
                : <button type="button" className="kasten kasten-red" onClick={oeffneNeu}><Plus className="h-3.5 w-3.5" /> Ersten Eintrag anlegen</button>}
            />
          ) : (
            <div className="px-1 py-1">
              <div className={`grid ${LISTE_SPALTEN} gap-3 px-2 pt-1 pb-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground`}>
                <span>Kategorie</span><span>Begriff · Bezug</span><span>Erklärung</span><span>Geändert</span>
              </div>
              {eintraege.map((e) => <EintragZeile key={e.id} e={e} onOeffnen={oeffneEintrag} />)}
            </div>
          )}
        </section>

        {/* Offene Fragen der KI */}
        <section aria-labelledby="wissen-fragen" className="rounded-xl border bg-card min-w-0">
          <div className="px-3 py-2.5 border-b">
            <h2 id="wissen-fragen" className="text-sm font-semibold flex items-center gap-1.5">
              <HelpCircle className="h-4 w-4 text-muted-foreground" /> Offene Fragen der KI
              {fragen && fragen.length > 0 ? <span className="text-xs font-normal text-muted-foreground tabular-nums">{tausend(fragen.length)}</span> : null}
            </h2>
            <p className="text-xs text-muted-foreground mt-0.5">Claude fragt hier, wenn beim Einordnen etwas unklar ist. Die Antwort wird Firmenwissen; betroffene offene Vorschläge werden neu berechnet.</p>
          </div>
          {fragen === null && !fragenFehler ? (
            <div className="p-3 flex flex-col gap-2" aria-busy="true">
              {[0, 1, 2].map((i) => <div key={i} className="shimmer rounded-md h-14" />)}
            </div>
          ) : fragenFehler && !fragen ? (
            <EmptyState
              icon={AlertTriangle}
              title="Fragen konnten nicht geladen werden"
              action={<button type="button" className="kasten kasten-muted" onClick={() => { setFragenFehler(false); void fragenLaden(); }}><RotateCw className="h-3.5 w-3.5" /> Erneut laden</button>}
            />
          ) : !fragen || fragen.length === 0 ? (
            <EmptyState icon={MessageCircleQuestion} title="Keine offenen Fragen" description="Sobald Claude beim Einordnen eine Abkürzung, eine Person oder eine Zuordnung nicht kennt, steht die Frage hier." />
          ) : (
            <ul className="max-h-[calc(100dvh-230px)] overflow-y-auto overscroll-contain">
              {fragen.map((f) => <FrageZeile key={f.id} f={f} busy={busyFrage === f.id} onAntwort={oeffneAntwort} onVerwerfen={verwerfen} />)}
            </ul>
          )}
        </section>
      </div>

      <Modal open={offen !== null} onClose={schliessen} title={titel} size="lg" closable={!saving} icon={offen?.art === "antwort" ? <MessageCircleQuestion className="h-5 w-5 text-blue-500" /> : <BookOpen className="h-5 w-5 text-muted-foreground" />}>
        <form onSubmit={speichern} className="space-y-4">
          {offen?.art === "antwort" && offen.frage ? (
            <div className="rounded-lg border bg-muted/40 px-3 py-2.5">
              <div className="flex items-start gap-2">
                <span className="pt-0.5"><Chip ton="amber">{FRAGE_ART_TEXT[offen.frage.art] ?? offen.frage.art}</Chip></span>
                <p className="text-sm">{offen.frage.frage}</p>
              </div>
              <p className="text-xs text-muted-foreground mt-1">{dokText(offen.frage.dokumente)} · zuletzt {zeitText(offen.frage.zuletzt_gefragt)}</p>
            </div>
          ) : null}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Feld label="Kategorie" htmlFor="wissen-kategorie">
              <SearchableSelect id="wissen-kategorie" value={form.kategorie} onChange={(v) => setForm({ ...form, kategorie: v as WissenKategorie })} items={KATEGORIE_ITEMS} searchable={false} clearable={false} />
            </Feld>
            <Feld label="Bezug (optional)" htmlFor="wissen-bezug">
              <SearchableSelect id="wissen-bezug" value={form.bezug} onChange={(v) => setForm({ ...form, bezug: v })} items={optionen ?? []} placeholder={optionen ? "— kein Bezug —" : "Wird geladen…"} />
            </Feld>
            <div className="sm:col-span-2">
              <Feld label="Begriff / Titel *" htmlFor="wissen-begriff">
                <Input id="wissen-begriff" value={form.begriff} maxLength={BEGRIFF_MAX} onChange={(e) => setForm({ ...form, begriff: e.target.value })} required autoFocus={offen?.art !== "antwort"} />
              </Feld>
            </div>
            <div className="sm:col-span-2">
              <Feld
                label={offen?.art === "antwort" ? "Antwort *" : "Erklärung *"}
                htmlFor="wissen-erklaerung"
                hinweis={`Geht an die lokale KI und an Claude — keine E-Mails, Konto-, AHV- oder Telefonnummern, Beträge oder Gesundheitsangaben. ${form.erklaerung.length}/${ERKLAERUNG_MAX}`}
              >
                <AutoTextarea
                  id="wissen-erklaerung"
                  value={form.erklaerung}
                  maxLength={ERKLAERUNG_MAX}
                  minHeight={72}
                  autoFocus={offen?.art === "antwort"}
                  onChange={(e) => setForm({ ...form, erklaerung: e.target.value })}
                  className="w-full rounded-xl border bg-background px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-ring/40 focus:border-ring"
                />
              </Feld>
            </div>
            {offen?.art !== "antwort" ? (
              <Feld label="Status">
                <div role="group" aria-label="Status des Eintrags" className="inline-flex gap-1">
                  <button type="button" aria-pressed={form.aktiv} onClick={() => setForm({ ...form, aktiv: true })} className={`kasten ${form.aktiv ? "kasten-active" : "kasten-toggle-off"}`}>Aktiv</button>
                  <button type="button" aria-pressed={!form.aktiv} onClick={() => setForm({ ...form, aktiv: false })} className={`kasten ${!form.aktiv ? "kasten-active" : "kasten-toggle-off"}`}>Inaktiv</button>
                </div>
              </Feld>
            ) : null}
            {offen?.art === "bearbeiten" && offen.eintrag ? (
              <p className="text-xs text-muted-foreground self-end sm:text-right">
                Zuletzt geändert{offen.eintrag.geaendert_von_name ? ` von ${offen.eintrag.geaendert_von_name}` : ""} am {zeitText(offen.eintrag.geaendert_am)}
              </p>
            ) : null}
          </div>
          <div className="flex gap-2 pt-2">
            {offen?.art === "bearbeiten" ? (
              <button type="button" onClick={() => void loeschen()} disabled={saving} className="kasten kasten-red" aria-label="Eintrag löschen">
                <Trash2 className="h-3.5 w-3.5" /> Löschen
              </button>
            ) : null}
            <button type="button" onClick={schliessen} disabled={saving} className="kasten kasten-muted flex-1">Abbrechen</button>
            <button type="submit" disabled={saving} className="kasten kasten-red flex-1">
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              {saving ? "Wird gespeichert…" : offen?.art === "antwort" ? "Antwort speichern" : offen?.art === "bearbeiten" ? "Speichern" : "Anlegen"}
            </button>
          </div>
        </form>
      </Modal>
      {ConfirmModalElement}
    </div>
  );
}
