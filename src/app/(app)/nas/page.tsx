"use client";

// NAS-Ablage (Leo 2026-09-26): Dokumente hier ablegen statt von Hand auf
// dem UGREEN-NAS einsortieren. Pro Datei PFLICHT: Kurzbeschrieb + Ziel-
// ordner aus der gepflegten NAS-Struktur. BEWUSST OHNE KI — sensible
// Dokumente werden nie inhaltlich analysiert; einsortiert wird rein nach
// den Angaben des Nutzers. Die Dateien landen im privaten Uebergabe-
// Bucket, das NAS holt sie per Sync ab (kein offener Port am NAS).
//
// Admin-only: Sidebar zeigt den Eintrag nur Admins, die Seite gated
// zusaetzlich selbst, RLS + API (requireAdmin) sichern die Daten.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { usePermissions } from "@/lib/use-permissions";
import { BackupTab } from "@/components/nas/backup-tab";
import { TabsNav } from "@/components/ui/tabs-nav";
import { DOK_TYPEN, dokTyp, baueAblageName } from "@/lib/ablage-doktypen";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { SearchableSelect } from "@/components/searchable-select";
import { toast } from "sonner";
import {
  HardDriveUpload, Upload, Loader2, Check, Trash2, FolderTree,
  ShieldCheck, FileText, ChevronRight,
} from "lucide-react";

interface OrdnerRow { id: string; pfad: string; aktiv: boolean }
interface ItemRow {
  id: string;
  ordner_pfad: string;
  beschrieb: string;
  abgelegt_name: string;
  created_at: string;
  synced_at: string | null;
  autor: { full_name: string }[] | { full_name: string } | null;
}
interface PendingFile {
  key: string;
  file: File;
  typ: string;
  betreff: string;
  partei: string;
  nummer: string;
  dokDatum: string;
  ordner: string;
  status: "offen" | "laedt" | "fertig" | "fehler";
  fehler?: string;
}

function heuteZurich(): string {
  return new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Zurich" });
}

const LETZTE_ORDNER_KEY = "ablage-letzte-ordner";

function fmtWann(iso: string): string {
  return new Date(iso).toLocaleString("de-CH", { timeZone: "Europe/Zurich", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

export default function NasPage() {
  const supabase = useMemo(() => createClient(), []);
  const { role, ready } = usePermissions();
  // Tab via URL-Param (?tab=backup) — ueberlebt Reload (§10);
  // replaceState statt useSearchParams (kein Suspense-Boundary noetig).
  const [tab, setTab] = useState<"ablage" | "backup">(() =>
    typeof window !== "undefined" && new URLSearchParams(window.location.search).get("tab") === "backup"
      ? "backup"
      : "ablage",
  );
  function wechsleTab(t: "ablage" | "backup") {
    setTab(t);
    window.history.replaceState(null, "", `/nas?tab=${t}`);
  }
  const [ordner, setOrdner] = useState<OrdnerRow[] | null>(null);
  const [items, setItems] = useState<ItemRow[]>([]);
  const [pending, setPending] = useState<PendingFile[]>([]);
  const [alleBusy, setAlleBusy] = useState(false);
  const [ordnerVerwalten, setOrdnerVerwalten] = useState(false);
  const [ordnerFilter, setOrdnerFilter] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const [letzteOrdner, setLetzteOrdner] = useState<string[]>(() => {
    if (typeof window === "undefined") return [];
    try { return JSON.parse(localStorage.getItem(LETZTE_ORDNER_KEY) ?? "[]"); } catch { return []; }
  });

  const load = useCallback(async () => {
    const [oRes, iRes] = await Promise.all([
      supabase.from("ablage_ordner").select("id, pfad, aktiv").order("pfad"),
      supabase
        .from("ablage_items")
        .select("id, ordner_pfad, beschrieb, abgelegt_name, created_at, synced_at, autor:profiles!ablage_items_created_by_fkey(full_name)")
        .order("created_at", { ascending: false })
        .limit(50),
    ]);
    setOrdner((oRes.data ?? []) as OrdnerRow[]);
    setItems((iRes.data ?? []) as unknown as ItemRow[]);
  }, [supabase]);

  useEffect(() => { if (ready && role === "admin") load(); }, [ready, role, load]);

  // Deaktivierung vererbt sich auf den ganzen Zweig: Pfade unter einem
  // inaktiven Ordner sind ebenfalls nicht waehlbar.
  const inaktivePfade = useMemo(() => (ordner ?? []).filter((o) => !o.aktiv).map((o) => o.pfad), [ordner]);
  const gesperrtDurch = useCallback((pfad: string): string | null => {
    for (const p of inaktivePfade) {
      if (pfad === p || pfad.startsWith(p + "/")) return p;
    }
    return null;
  }, [inaktivePfade]);

  // Ordner-Optionen: nur effektiv aktive, zuletzt verwendete zuoberst.
  const ordnerOptionen = useMemo(() => {
    const alle = (ordner ?? []).filter((o) => gesperrtDurch(o.pfad) === null).map((o) => o.pfad);
    const zuletzt = letzteOrdner.filter((p) => alle.includes(p));
    const rest = alle.filter((p) => !zuletzt.includes(p));
    return [
      ...zuletzt.map((p) => ({ id: p, label: p, sublabel: "zuletzt verwendet" })),
      ...rest.map((p) => ({ id: p, label: p })),
    ];
  }, [ordner, letzteOrdner, gesperrtDurch]);
  // Aufgeklappte Top-Ordner im Verwalten-Baum.
  const [offeneTops, setOffeneTops] = useState<Set<string>>(new Set());

  /** Ordner (de)aktivieren — optimistisch, direkter DB-Write (RLS admin). */
  async function toggleOrdner(o: OrdnerRow) {
    setOrdner((prev) => (prev ?? []).map((x) => (x.id === o.id ? { ...x, aktiv: !o.aktiv } : x)));
    const { error } = await supabase.from("ablage_ordner").update({ aktiv: !o.aktiv }).eq("id", o.id);
    if (error) {
      setOrdner((prev) => (prev ?? []).map((x) => (x.id === o.id ? { ...x, aktiv: o.aktiv } : x)));
      toast.error("Änderung fehlgeschlagen: " + error.message);
    }
  }

  function merkeOrdner(pfad: string) {
    setLetzteOrdner((prev) => {
      const next = [pfad, ...prev.filter((p) => p !== pfad)].slice(0, 5);
      try { localStorage.setItem(LETZTE_ORDNER_KEY, JSON.stringify(next)); } catch { /* egal */ }
      return next;
    });
  }

  function dateienWaehlen(files: FileList | null) {
    if (!files || files.length === 0) return;
    const defaultOrdner = letzteOrdner[0] ?? "";
    setPending((prev) => [
      ...prev,
      ...Array.from(files).map((f, i) => ({
        key: `${Date.now()}_${i}_${f.name}`,
        file: f,
        typ: "sonstiges",
        betreff: "",
        partei: "",
        nummer: "",
        dokDatum: "",
        ordner: defaultOrdner,
        status: "offen" as const,
      })),
    ]);
    if (fileRef.current) fileRef.current.value = "";
  }

  function updatePending(key: string, patch: Partial<PendingFile>) {
    setPending((prev) => prev.map((p) => (p.key === key ? { ...p, ...patch } : p)));
  }

  async function ablegen(p: PendingFile): Promise<boolean> {
    const typ = dokTyp(p.typ);
    if (!p.betreff.trim() || !p.ordner) {
      updatePending(p.key, { status: "fehler", fehler: typ?.key === "sonstiges" ? "Beschrieb und Zielordner sind Pflicht" : "Betreff und Zielordner sind Pflicht" });
      return false;
    }
    if (typ?.partei?.pflicht && !p.partei.trim()) {
      updatePending(p.key, { status: "fehler", fehler: `${typ.partei.label} fehlt noch — gehört bei «${typ.label}» in den Namen` });
      return false;
    }
    updatePending(p.key, { status: "laedt", fehler: undefined });
    try {
      const fd = new FormData();
      fd.append("file", p.file);
      fd.append("typ", p.typ);
      fd.append("betreff", p.betreff.trim());
      fd.append("partei", p.partei.trim());
      fd.append("nummer", p.nummer.trim());
      fd.append("dok_datum", p.dokDatum);
      fd.append("ordner", p.ordner);
      const res = await fetch("/api/ablage/upload", { method: "POST", body: fd });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.success) {
        updatePending(p.key, { status: "fehler", fehler: json?.error ?? "Upload fehlgeschlagen" });
        return false;
      }
      merkeOrdner(p.ordner);
      updatePending(p.key, { status: "fertig" });
      return true;
    } catch {
      updatePending(p.key, { status: "fehler", fehler: "Netzwerkfehler" });
      return false;
    }
  }

  async function alleAblegen() {
    const offen = pending.filter((p) => p.status === "offen" || p.status === "fehler");
    if (offen.length === 0) return;
    setAlleBusy(true);
    let ok = 0;
    for (const p of offen) {
      if (await ablegen(p)) ok++;
    }
    setAlleBusy(false);
    if (ok > 0) {
      toast.success(`${ok} Dokument${ok === 1 ? "" : "e"} abgelegt`);
      // Fertige nach kurzer Sichtbarkeit aus der Liste raeumen.
      setTimeout(() => setPending((prev) => prev.filter((p) => p.status !== "fertig")), 1500);
      load();
    }
  }

  if (!ready) {
    return <div className="h-64 rounded-xl bg-foreground/10 dark:bg-foreground/15 animate-pulse" />;
  }
  if (role !== "admin") {
    return <p className="text-sm text-muted-foreground p-6">Kein Zugriff — die NAS-Ablage ist Admins vorbehalten.</p>;
  }

  const offeneAnzahl = pending.filter((p) => p.status === "offen" || p.status === "fehler").length;

  return (
    <div className="space-y-6 page-enter max-w-4xl mx-auto">
      <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
        <HardDriveUpload className="h-6 w-6" /> NAS
      </h1>
      {/* Kanonisches Nav-Tab-Muster (Underline, border-red-500) — Ablage
          und Backup sind unterschiedliche Sektionen, kein Filter. */}
      <TabsNav
        tabs={[
          { key: "ablage", label: "Ablage" },
          { key: "backup", label: "Backup" },
        ]}
        active={tab}
        onChange={(k) => wechsleTab(k as "ablage" | "backup")}
        ariaLabel="NAS-Bereiche"
        className="mb-4"
      />

      {tab === "backup" ? (
        <BackupTab />
      ) : (
      <>
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <p className="text-sm text-muted-foreground flex items-center gap-1.5">
          <ShieldCheck className="h-4 w-4 text-green-600 shrink-0" />
          Ohne KI: Inhalte werden nie analysiert — einsortiert wird nur nach deinem Beschrieb und Zielordner.
        </p>
        <button type="button" onClick={() => setOrdnerVerwalten((o) => !o)} className="kasten kasten-muted">
          <FolderTree className="h-3.5 w-3.5" />
          Ordner verwalten
        </button>
      </div>

      {ordnerVerwalten && (
        <Card className="bg-card">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">NAS-Ordnerstruktur</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <p className="text-xs text-muted-foreground">
              Die Liste kommt automatisch vom NAS (Abgleich ca. alle 10 Minuten).
              Häkchen weg = Ordner erscheint nicht mehr in der Zielordner-Auswahl —
              die Einstellung bleibt auch nach jedem Struktur-Update erhalten.
            </p>
            {(ordner ?? []).length > 12 && (
              <Input
                value={ordnerFilter}
                onChange={(e) => setOrdnerFilter(e.target.value)}
                placeholder="Ordner filtern…"
                className="h-8 text-xs"
              />
            )}
            {(ordner ?? []).length === 0 ? (
              <p className="text-xs text-muted-foreground italic">
                Noch keine Ordner — sie erscheinen automatisch, sobald der Sync-Container auf dem NAS läuft.
              </p>
            ) : (
              (() => {
                // Baum-Darstellung aus der flachen Pfadliste: jede Ebene ist
                // eine eigene Row (der Scan meldet alle Ebenen). Top-Ordner
                // sind auf-/zuklappbar; ein aktiver Filter zeigt alle Treffer.
                const filter = ordnerFilter.trim().toLowerCase();
                const sichtbar = (ordner ?? []).filter((o) => !filter || o.pfad.toLowerCase().includes(filter));
                const deaktiviert = (ordner ?? []).filter((o) => !o.aktiv).length;
                return (
                  <>
                    <p className="text-[11px] text-muted-foreground">
                      {(ordner ?? []).length} Ordner{deaktiviert > 0 && <> · <span className="text-amber-700 dark:text-amber-400">{deaktiviert} deaktiviert</span></>}
                    </p>
                    <ul className="max-h-96 overflow-y-auto">
                      {sichtbar.map((o) => {
                        const teile = o.pfad.split("/");
                        const tiefe = teile.length - 1;
                        const top = teile[0];
                        const istTop = tiefe === 0;
                        const offen = filter !== "" || offeneTops.has(top);
                        if (!istTop && !offen) return null;
                        const hatKinder = istTop && (ordner ?? []).some((x) => x.pfad.startsWith(o.pfad + "/"));
                        const sperrer = gesperrtDurch(o.pfad);
                        const vererbGesperrt = sperrer !== null && sperrer !== o.pfad;
                        return (
                          <li key={o.id} style={{ paddingLeft: tiefe * 22 }}>
                            <div className="flex items-center gap-1.5 py-1 rounded-md">
                              {istTop ? (
                                <button
                                  type="button"
                                  onClick={() => setOffeneTops((prev) => {
                                    const next = new Set(prev);
                                    if (next.has(top)) next.delete(top); else next.add(top);
                                    return next;
                                  })}
                                  disabled={!hatKinder}
                                  className="p-0.5 rounded text-muted-foreground disabled:opacity-25"
                                  aria-label={offen ? "Zuklappen" : "Aufklappen"}
                                >
                                  <ChevronRight className={`h-3.5 w-3.5 transition-transform ${offen && hatKinder ? "rotate-90" : ""}`} />
                                </button>
                              ) : (
                                <span className="w-[18px] shrink-0 text-center text-muted-foreground/40 select-none">└</span>
                              )}
                              <label
                                className={`flex items-center gap-2 min-w-0 ${vererbGesperrt ? "cursor-not-allowed" : "cursor-pointer"}`}
                                data-tooltip={vererbGesperrt ? `Über «${sperrer}» deaktiviert` : undefined}
                              >
                                <input
                                  type="checkbox"
                                  checked={o.aktiv}
                                  onChange={() => toggleOrdner(o)}
                                  disabled={vererbGesperrt}
                                  className="h-4 w-4 accent-red-600 shrink-0 disabled:opacity-40"
                                />
                                <span className={`text-xs truncate ${istTop ? "font-semibold" : "font-mono"} ${sperrer ? "text-muted-foreground/50 line-through" : ""}`}>
                                  {teile[teile.length - 1]}
                                </span>
                              </label>
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  </>
                );
              })()
            )}
          </CardContent>
        </Card>
      )}

      {/* ── Ablegen ────────────────────────────────────────── */}
      <Card className="bg-card">
        <CardContent className="p-4 space-y-3">
          {ordner !== null && ordner.length === 0 && (
            <div className="px-3 py-2.5 rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-500/10 dark:border-amber-500/30 text-xs text-amber-800 dark:text-amber-200">
              Noch keine Ordnerstruktur hinterlegt — zuerst oben rechts «Ordner verwalten» öffnen und die NAS-Ordner einfügen.
            </div>
          )}
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => { e.preventDefault(); dateienWaehlen(e.dataTransfer.files); }}
            className="w-full flex items-center justify-center gap-2 py-6 rounded-xl border-2 border-dashed text-sm font-medium text-muted-foreground hover:text-foreground hover:border-foreground/30 transition-colors"
          >
            <Upload className="h-4 w-4" />
            Dateien wählen oder hierhin ziehen
          </button>
          <input ref={fileRef} type="file" multiple className="hidden" onChange={(e) => dateienWaehlen(e.target.files)} />

          {pending.length > 0 && (
            <div className="space-y-2">
              {pending.map((p) => (
                <div key={p.key} className={`p-3 rounded-xl border space-y-2 ${p.status === "fertig" ? "border-green-300 bg-green-50/50 dark:bg-green-500/10 dark:border-green-500/30" : p.status === "fehler" ? "border-red-300 bg-red-50/40 dark:bg-red-500/10 dark:border-red-500/30" : "bg-muted/20"}`}>
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-medium truncate flex items-center gap-1.5 min-w-0">
                      <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <span className="truncate">{p.file.name}</span>
                      <span className="text-[11px] text-muted-foreground shrink-0">({(p.file.size / 1024 / 1024).toFixed(1)} MB)</span>
                    </p>
                    <span className="flex items-center gap-1.5 shrink-0">
                      {p.status === "laedt" && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
                      {p.status === "fertig" && <span className="text-[11px] font-medium text-green-700 dark:text-green-400 flex items-center gap-1"><Check className="h-3.5 w-3.5" /> Abgelegt</span>}
                      {p.status !== "laedt" && p.status !== "fertig" && (
                        <button type="button" onClick={() => setPending((prev) => prev.filter((x) => x.key !== p.key))} className="icon-btn icon-btn-red" aria-label="Entfernen" data-tooltip="Entfernen">
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </span>
                  </div>
                  {p.status !== "fertig" && (() => {
                    const typ = dokTyp(p.typ);
                    const laedt = p.status === "laedt";
                    const vorschau = p.betreff.trim()
                      ? baueAblageName(
                          { typKey: p.typ, betreff: p.betreff, partei: p.partei, nummer: p.nummer, dokDatum: p.dokDatum },
                          p.file.name,
                          heuteZurich(),
                        )
                      : null;
                    return (
                      <div className="space-y-2">
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                          <SearchableSelect
                            value={p.typ}
                            onChange={(v) => updatePending(p.key, { typ: v })}
                            items={DOK_TYPEN.map((t) => ({ id: t.key, label: t.label }))}
                            placeholder="Dokumenttyp…"
                          />
                          <SearchableSelect
                            value={p.ordner}
                            onChange={(v) => updatePending(p.key, { ordner: v })}
                            items={ordnerOptionen}
                            placeholder="Zielordner wählen… *"
                          />
                        </div>
                        <Input
                          placeholder={typ?.key === "sonstiges" ? "Kurzbeschrieb — was enthält das Dokument? *" : "Betreff — worum geht es? (z.B. Haftpflicht) *"}
                          value={p.betreff}
                          onChange={(e) => updatePending(p.key, { betreff: e.target.value })}
                          disabled={laedt}
                        />
                        {/* "Folgefragen": typ-abhaengige Zusatzfelder, die der
                            Name braucht — erscheinen direkt beim Typ-Wechsel. */}
                        {typ && typ.key !== "sonstiges" && (typ.partei || typ.nummer) && (
                          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                            {typ.partei && (
                              <Input
                                placeholder={`${typ.partei.label}${typ.partei.pflicht ? " *" : ""} — ${typ.partei.placeholder ?? ""}`}
                                value={p.partei}
                                onChange={(e) => updatePending(p.key, { partei: e.target.value })}
                                disabled={laedt}
                              />
                            )}
                            {typ.nummer && (
                              <Input
                                placeholder={`${typ.nummer.label} — optional`}
                                value={p.nummer}
                                onChange={(e) => updatePending(p.key, { nummer: e.target.value })}
                                disabled={laedt}
                              />
                            )}
                            <Input
                              type="date"
                              value={p.dokDatum}
                              onChange={(e) => updatePending(p.key, { dokDatum: e.target.value })}
                              disabled={laedt}
                              aria-label="Dokument-Datum (optional, sonst heute)"
                              data-tooltip="Datum des Dokuments — leer = heutiges Ablage-Datum"
                            />
                          </div>
                        )}
                        {vorschau && (
                          <p className="text-[11px] text-muted-foreground font-mono truncate" data-tooltip={vorschau}>
                            → {vorschau}
                          </p>
                        )}
                      </div>
                    );
                  })()}
                  {p.fehler && <p className="text-xs text-red-600 dark:text-red-400">{p.fehler}</p>}
                </div>
              ))}
              <button
                type="button"
                onClick={alleAblegen}
                disabled={alleBusy || offeneAnzahl === 0}
                className="kasten kasten-red w-full"
              >
                {alleBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <HardDriveUpload className="h-3.5 w-3.5" />}
                {alleBusy ? "Legt ab…" : offeneAnzahl === 1 ? "Dokument ablegen" : `${offeneAnzahl} Dokumente ablegen`}
              </button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Historie ───────────────────────────────────────── */}
      <Card className="bg-card">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Zuletzt abgelegt</CardTitle>
        </CardHeader>
        <CardContent>
          {items.length === 0 ? (
            <p className="text-sm text-muted-foreground">Noch nichts abgelegt.</p>
          ) : (
            <ul className="divide-y divide-border">
              {items.map((i) => {
                const a = Array.isArray(i.autor) ? i.autor[0] : i.autor;
                return (
                  <li key={i.id} className="py-2 flex items-start gap-2.5">
                    <FileText className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm truncate">{i.abgelegt_name}</p>
                      <p className="text-[11px] text-muted-foreground flex items-center gap-1 flex-wrap">
                        <span className="font-mono">{i.ordner_pfad}</span>
                        <ChevronRight className="h-3 w-3" />
                        {fmtWann(i.created_at)}{a?.full_name ? ` · ${a.full_name}` : ""}
                      </p>
                    </div>
                    {i.synced_at ? (
                      <span className="shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-green-100 text-green-700 dark:bg-green-500/20 dark:text-green-300" data-tooltip={`Übertragen ${fmtWann(i.synced_at)}`}>
                        <Check className="h-2.5 w-2.5" /> Auf NAS
                      </span>
                    ) : (
                      <span className="shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300" data-tooltip="Der NAS-Sync hat die Datei noch nicht abgeholt">
                        <Loader2 className="h-2.5 w-2.5" /> Wartet auf Sync
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>
      </>
      )}
    </div>
  );
}
