"use client";

/**
 * Vertrieb › Haus-Profil (Leo 09.11.2026): ein Haus auf einer Seite.
 * Kopf: Name, Stufe (Auswahl), Gebiet, Prio, Gruppe, Fortschritt und
 * «Anruf erfassen» (schreibt Verlauf + nächsten Schritt über
 * /api/vertrieb/haeuser/<id>). Links: nächster Schritt (Kalender), Bedarf
 * mit Beleg, Kontakt, Räume und Fakten, Unterlagen. Rechts: Verlauf.
 *
 * Einfache Felder speichern beim Verlassen (onBlur) direkt über Supabase
 * (RLS vertrieb:edit) — wie früher die Räume (raum-detail.tsx). Die Seite
 * rendert das Profil mit key={haus.id}: ein anderes Haus startet frisch.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  Building2, CalendarClock, Copy, FileText, History, Loader2, Paperclip, Phone, Target, Trash2, Users,
  ChevronLeft, LayoutGrid,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { createClient } from "@/lib/supabase/client";
import { Input } from "@/components/ui/input";
import { AutoTextarea } from "@/components/ui/auto-textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { PdfPopup } from "@/components/pdf-popup";
import { useConfirm } from "@/components/ui/use-confirm";
import { SearchableSelect } from "@/components/searchable-select";
import { Karte, TON_KLASSEN } from "@/components/dashboard/karte";
import { StufePille } from "@/components/vertrieb/pipeline-ansicht";
import { usePermissions } from "@/lib/use-permissions";
import { validateFileSize } from "@/lib/file-upload";
import { deleteRow } from "@/lib/db-mutations";
import { datumKurz } from "@/lib/vertrieb-datum";
import { TOAST } from "@/lib/messages";
import { ALLE_STUFEN, ANRUF_ERGEBNISSE, STUFEN, stufeInfo, type AnrufErgebnis } from "@/lib/vertrieb/haeuser";
import type { HausStufe, HausVerlauf, VertriebDokument, VertriebRaum } from "@/types/vertrieb";

type Textfeld =
  | "name" | "ort" | "ansprechperson" | "email" | "telefon" | "website" | "infos" | "erstmail"
  | "datum" | "aufgabe" | "gebiet" | "gruppe" | "bedarf" | "bedarf_beleg";

const GEBIETE = ["Basel-Stadt", "Baselland", "Fricktal", "Solothurn Nord", "Ring 2"];

interface Props {
  haus: VertriebRaum | null;
  laedt: boolean;
  onZurPipeline: () => void;
  /** Nach erfolgreichem Speichern: Haus in der geteilten Liste nachführen. */
  onLokal: (id: string, patch: Partial<VertriebRaum>) => void;
  /** Nach Aktionen über die API (Stufe/Anruf): alles neu laden. */
  onNeuLaden: () => void;
  onGeloescht: (id: string) => void;
}

function Label({ children }: { children: React.ReactNode }) {
  return <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{children}</p>;
}

export function HausProfil({ haus, laedt, onZurPipeline, onLokal, onNeuLaden, onGeloescht }: Props) {
  if (laedt) return <Skeleton className="h-[520px] rounded-xl" />;
  if (!haus) {
    return (
      <div className="rounded-xl border bg-card">
        <EmptyState icon={Target} title="Kein Haus gewählt"
                    description="Wähle in der Pipeline ein Haus, dann erscheint hier sein Profil."
                    action={<button type="button" onClick={onZurPipeline} className="kasten kasten-blue">Zur Pipeline</button>} />
      </div>
    );
  }
  return <Profil haus={haus} onZurPipeline={onZurPipeline} onLokal={onLokal} onNeuLaden={onNeuLaden} onGeloescht={onGeloescht} />;
}

function Profil({ haus, onZurPipeline, onLokal, onNeuLaden, onGeloescht }: Omit<Props, "haus" | "laedt"> & { haus: VertriebRaum }) {
  const supabase = createClient();
  const { can } = usePermissions();
  const darf = can("vertrieb:edit");
  const { confirm, ConfirmModalElement } = useConfirm();
  const [werte, setWerte] = useState<Record<Textfeld, string>>(() => ausHaus(haus));
  const [verlauf, setVerlauf] = useState<HausVerlauf[] | null>(null);
  const [anrufOffen, setAnrufOffen] = useState(false);
  const [notiz, setNotiz] = useState("");
  const [laeuft, setLaeuft] = useState<string | null>(null);
  const [hochladen, setHochladen] = useState(false);
  const [vorschau, setVorschau] = useState<{ url: string; title: string } | null>(null);
  const dateiRef = useRef<HTMLInputElement>(null);

  const ladeVerlauf = useCallback(async () => {
    const { data, error } = await createClient()
      .from("vertrieb_haus_verlauf")
      .select("id, haus_id, datum, art, titel, text, ton, created_at")
      .eq("haus_id", haus.id)
      .order("datum", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(200);
    if (error && error.code !== "PGRST205") toast.error(`Verlauf laden fehlgeschlagen: ${error.message}`);
    setVerlauf((data ?? []) as HausVerlauf[]);
  }, [haus.id]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void ladeVerlauf();
  }, [ladeVerlauf]);

  // Stufe/Datum/Aufgabe ändern sich auch über die API (Anruf) → Felder nachziehen.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setWerte((w) => ({ ...w, datum: haus.datum ?? "", aufgabe: haus.aufgabe ?? "" }));
  }, [haus.datum, haus.aufgabe]);

  const setze = (feld: Textfeld, wert: string) => setWerte((w) => ({ ...w, [feld]: wert }));

  async function aendern(patch: Partial<VertriebRaum>): Promise<boolean> {
    const { error } = await supabase.from("vertrieb_raeume").update(patch).eq("id", haus.id);
    if (error) { TOAST.supabaseError(error, "Speichern fehlgeschlagen"); return false; }
    onLokal(haus.id, patch);
    return true;
  }

  async function speichere(feld: Textfeld, wert = werte[feld]) {
    if (!darf) return;
    const neu = wert.trim() === "" ? null : wert.trim();
    if (neu === ((haus[feld] as string | null) ?? null)) return;
    if (feld === "name" && !neu) { TOAST.requiredField("Name"); setze("name", haus.name); return; }
    const ok = await aendern({ [feld]: neu } as Partial<VertriebRaum>);
    if (!ok) setze(feld, (haus[feld] as string | null) ?? "");
  }

  async function api(body: Record<string, unknown>, schluessel: string): Promise<boolean> {
    setLaeuft(schluessel);
    const res = await fetch(`/api/vertrieb/haeuser/${haus.id}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    }).catch(() => null);
    const json = await res?.json().catch(() => null);
    setLaeuft(null);
    if (!res?.ok || !json?.ok) { toast.error(json?.error ?? "Verbindung unterbrochen"); return false; }
    onNeuLaden();
    void ladeVerlauf();
    return true;
  }

  async function stufeSetzen(stufe: string) {
    if (!stufe || stufe === haus.stufe) return;
    if (await api({ aktion: "stufe", stufe }, "stufe")) {
      onLokal(haus.id, { stufe: stufe as HausStufe });
      toast.success(`Stufe: ${stufeInfo(stufe as HausStufe).label}`);
    }
  }

  async function anruf(ergebnis: AnrufErgebnis) {
    if (await api({ aktion: "anruf", ergebnis, notiz }, `anruf-${ergebnis}`)) {
      setAnrufOffen(false);
      setNotiz("");
      toast.success("Anruf erfasst");
    }
  }

  async function dateiHochladen(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !validateFileSize(file)) return;
    setHochladen(true);
    const path = uploadPfad(haus.id, file.name);
    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("path", path);
      const res = await fetch("/api/upload", { method: "POST", body: formData });
      const json = await res.json();
      if (!json.success) { TOAST.uploadError(json.error); return; }
    } catch {
      TOAST.networkError("Upload");
      return;
    } finally {
      setHochladen(false);
    }
    const dokumente: VertriebDokument[] = [...haus.dokumente, { name: file.name, path, uploaded_at: new Date().toISOString() }];
    if (await aendern({ dokumente })) toast.success("PDF angehängt");
  }

  async function dateiOeffnen(doc: VertriebDokument) {
    const { data, error } = await supabase.storage.from("documents").createSignedUrl(doc.path, 3600);
    if (error || !data?.signedUrl) { toast.error("Datei nicht verfügbar"); return; }
    setVorschau({ url: data.signedUrl, title: doc.name });
  }

  async function dateiLoeschen(doc: VertriebDokument) {
    const ok = await confirm({ title: "Anhang löschen?", message: `«${doc.name}» wird entfernt.`, confirmLabel: "Löschen", variant: "red" });
    if (!ok) return;
    const { error } = await supabase.storage.from("documents").remove([doc.path]);
    if (error) { TOAST.supabaseError(error, "Anhang konnte nicht gelöscht werden"); return; }
    if (await aendern({ dokumente: haus.dokumente.filter((d) => d.path !== doc.path) })) toast.success("Anhang gelöscht");
  }

  async function hausLoeschen() {
    const ok = await confirm({
      title: "Haus löschen?",
      message: `«${haus.name}» wird mit Verlauf und Anhängen endgültig gelöscht. Besser: Stufe «Absage» oder «Pause».`,
      confirmLabel: "Löschen",
      variant: "red",
    });
    if (!ok) return;
    setLaeuft("loeschen");
    if (haus.dokumente.length) {
      const { error } = await supabase.storage.from("documents").remove(haus.dokumente.map((d) => d.path));
      if (error) { setLaeuft(null); TOAST.supabaseError(error, "Anhänge konnten nicht gelöscht werden"); return; }
    }
    const res = await deleteRow("vertrieb_raeume", haus.id);
    setLaeuft(null);
    if (!res.ok) { TOAST.deleteError(res.error); return; }
    toast.success("Haus gelöscht");
    onGeloescht(haus.id);
  }

  async function erstmailKopieren() {
    try { await navigator.clipboard.writeText(werte.erstmail); toast.success("Erstmail kopiert"); }
    catch { toast.error("Kopieren nicht möglich"); }
  }

  const feld = (f: Textfeld, placeholder: string, type = "text") => (
    <Input readOnly={!darf} type={type} value={werte[f]} placeholder={placeholder}
           onChange={(e) => setze(f, e.target.value)} onBlur={() => void speichere(f)} className="h-8 text-sm" />
  );

  const rang = stufeInfo(haus.stufe).rang;
  const pfad = STUFEN.filter((s) => s.key !== "anruf");

  return (
    <div className="flex flex-col gap-4">
      <button type="button" onClick={onZurPipeline} className="inline-flex w-fit items-center gap-1 text-[13px] text-muted-foreground">
        <ChevronLeft className="h-3.5 w-3.5" />Pipeline
      </button>

      {/* Kopf */}
      <section className="rounded-xl border bg-card p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 flex-1 items-center gap-4">
            <span className={cn("flex h-[52px] w-[52px] shrink-0 items-center justify-center rounded-xl", TON_KLASSEN.rot)}>
              <Building2 className="h-6 w-6" />
            </span>
            <div className="min-w-0 flex-1">
              <Input readOnly={!darf} value={werte.name} onChange={(e) => setze("name", e.target.value)} onBlur={() => void speichere("name")}
                     className="h-10 border-transparent bg-transparent px-1 font-heading text-2xl font-bold shadow-none focus-visible:border-input" />
              <div className="mt-1.5 flex flex-wrap gap-1.5 px-1">
                <StufePille stufe={haus.stufe} />
                {haus.gebiet && <span className={cn("rounded-full px-2.5 py-0.5 text-xs font-semibold", TON_KLASSEN.neutral)}>{haus.gebiet}</span>}
                <span className={cn("rounded-full px-2.5 py-0.5 text-xs font-semibold", TON_KLASSEN.neutral)}>Prio {haus.prio}</span>
                {haus.gruppe && <span className={cn("rounded-full px-2.5 py-0.5 text-xs font-semibold", TON_KLASSEN.neutral)}>{haus.gruppe}</span>}
              </div>
            </div>
          </div>
          {darf && (
            <div className="flex flex-wrap items-center gap-2">
              <div className="w-48">
                <SearchableSelect value={haus.stufe} onChange={(v) => void stufeSetzen(v)} clearable={false} searchable={false}
                                  items={ALLE_STUFEN.map((s) => ({ id: s.key, label: s.label }))} placeholder="Stufe" />
              </div>
              <button type="button" onClick={() => setAnrufOffen((o) => !o)} className={cn("kasten", anrufOffen ? "kasten-active" : "kasten-muted")}>
                <Phone className="h-4 w-4" />Anruf erfassen
              </button>
            </div>
          )}
        </div>

        <div className="mt-5 grid grid-cols-6 gap-1.5">
          {pfad.map((s, i) => {
            const naechster = pfad[i + 1];
            const erreicht = rang >= s.rang;
            const aktuell = erreicht && (!naechster || rang < naechster.rang);
            return (
              <div key={s.key}>
                <div className={cn("h-1.5 rounded-full", aktuell ? "bg-red-600 dark:bg-red-500" : erreicht ? "bg-foreground" : "bg-foreground/10 dark:bg-foreground/15")} />
                <div className={cn("mt-1.5 truncate text-xs", aktuell ? "font-bold text-red-700 dark:text-red-300" : erreicht ? "text-foreground" : "text-muted-foreground")}>
                  {s.label}
                </div>
              </div>
            );
          })}
        </div>
        {rang < 0 && <p className="mt-3 text-[13px] text-muted-foreground">Dieses Haus ist {haus.stufe === "absage" ? "abgesagt" : "pausiert"} und erscheint nicht in der Pipeline.</p>}

        {anrufOffen && (
          <div className="mt-4 rounded-xl bg-foreground/[0.04] p-4 dark:bg-foreground/[0.08]">
            <b className="text-sm">Anruf erfassen · Ergebnis?</b>
            <Input value={notiz} onChange={(e) => setNotiz(e.target.value)} placeholder="Notiz (optional), z. B. mit wem gesprochen"
                   className="mt-2.5 h-9 text-sm" maxLength={2000} />
            <div className="mt-2.5 flex flex-wrap gap-2">
              {ANRUF_ERGEBNISSE.map((e) => (
                <button key={e.key} type="button" onClick={() => void anruf(e.key)} disabled={laeuft !== null} className={cn("kasten", e.kasten)}>
                  {laeuft === `anruf-${e.key}` && <Loader2 className="h-4 w-4 animate-spin" />}{e.label}
                </button>
              ))}
            </div>
          </div>
        )}
      </section>

      <div className="grid items-start gap-4 lg:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-4">
          <section aria-label="Nächster Schritt" className="rounded-xl border border-amber-500/35 bg-amber-500/10 p-4 dark:bg-amber-500/15">
            <Label><span className="inline-flex items-center gap-1 text-amber-800 dark:text-amber-300"><CalendarClock className="h-3 w-3" />Nächster Schritt · erscheint im Kalender</span></Label>
            <div className="flex gap-2">
              <Input readOnly={!darf} type="date" value={werte.datum}
                     onChange={(e) => { setze("datum", e.target.value); void speichere("datum", e.target.value); }}
                     className="h-8 w-40 shrink-0 bg-card text-sm" />
              <Input readOnly={!darf} value={werte.aufgabe} placeholder="Was ist zu tun? z. B. Anruf Anlassorganisation"
                     onChange={(e) => setze("aufgabe", e.target.value)} onBlur={() => void speichere("aufgabe")} className="h-8 bg-card text-sm" />
            </div>
          </section>

          <Karte titel="Bedarf" icon={Target}
                 rechts={
                   <button type="button" disabled={!darf} onClick={() => void aendern({ bedarf_belegt: !haus.bedarf_belegt })}
                           className={cn("rounded-full px-2.5 py-0.5 text-xs font-semibold", haus.bedarf_belegt ? TON_KLASSEN.gruen : TON_KLASSEN.amber)}
                           data-tooltip={darf ? "Klicken zum Umschalten" : undefined}>
                     {haus.bedarf_belegt ? "belegt" : "offen"}
                   </button>
                 }>
            <AutoTextarea readOnly={!darf} value={werte.bedarf} onChange={(e) => setze("bedarf", e.target.value)} onBlur={() => void speichere("bedarf")}
                          placeholder="Welcher Anlass, und warum braucht es externe Technik oder Betreuung?"
                          className="min-h-[3.5rem] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm" />
            <div>
              <Label>Beleg (Quelle)</Label>
              {feld("bedarf_beleg", "z. B. https://… oder «Website, Seite Vermietung»")}
            </div>
            {!haus.bedarf_belegt && (
              <p className="text-xs text-muted-foreground">Nur mit belegtem Bedarf anschreiben — sonst zuerst anrufen.</p>
            )}
          </Karte>

          <Karte titel="Kontakt" icon={Users}>
            <div className="grid grid-cols-2 gap-2">
              {feld("ort", "Ort / Adresse")}
              <SearchableSelect value={werte.gebiet} clearable searchable={false} placeholder="Gebiet"
                                onChange={(v) => { setze("gebiet", v); void speichere("gebiet", v); }}
                                items={GEBIETE.map((g) => ({ id: g, label: g }))} />
              {feld("ansprechperson", "Ansprechperson")}
              {feld("gruppe", "Gruppe / Marke, z. B. Groupe Oniro")}
              {feld("email", "E-Mail (offiziell)", "email")}
              {feld("telefon", "Telefon", "tel")}
              {feld("website", "Website")}
              <SearchableSelect value={haus.prio} clearable={false} searchable={false} placeholder="Prio"
                                onChange={(v) => { if (darf && (v === "A" || v === "B") && v !== haus.prio) void aendern({ prio: v }); }}
                                items={[{ id: "A", label: "Prio A" }, { id: "B", label: "Prio B" }]} />
            </div>
          </Karte>

          <Karte titel="Räume und Fakten" icon={LayoutGrid}>
            <AutoTextarea readOnly={!darf} value={werte.infos} onChange={(e) => setze("infos", e.target.value)} onBlur={() => void speichere("infos")}
                          placeholder="Säle, Kapazität, eigene Technik, wer vermietet heute, worauf achten …"
                          className="min-h-[4.5rem] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm" />
          </Karte>

          <Karte titel="Unterlagen" icon={FileText}
                 rechts={darf ? (
                   <button type="button" onClick={() => dateiRef.current?.click()} disabled={hochladen} className="kasten kasten-muted text-xs">
                     {hochladen ? <><Loader2 className="h-3 w-3 animate-spin" />Lädt hoch…</> : <><Paperclip className="h-3 w-3" />PDF anhängen</>}
                   </button>
                 ) : undefined}>
            <input ref={dateiRef} type="file" accept="application/pdf,.pdf" className="hidden" onChange={dateiHochladen} />
            {haus.dokumente.length === 0 ? (
              <p className="text-sm text-muted-foreground">Noch keine Unterlagen (Konzept-PDF, Offerte …).</p>
            ) : (
              <div className="flex flex-col divide-y">
                {haus.dokumente.map((d) => (
                  <div key={d.path} className="row-hover flex items-center gap-2.5 py-2">
                    <FileText className="h-4 w-4 shrink-0 text-red-600 dark:text-red-400" />
                    <button type="button" onClick={() => void dateiOeffnen(d)} className="min-w-0 flex-1 truncate text-left text-sm">{d.name}</button>
                    {darf && (
                      <button type="button" onClick={() => void dateiLoeschen(d)} data-tooltip="Anhang löschen" className="kasten kasten-muted h-7 w-7 justify-center p-0">
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
            {(werte.erstmail || darf) && (
              <div>
                <div className="flex items-center justify-between">
                  <Label>Erstmail-Entwurf</Label>
                  <button type="button" onClick={() => void erstmailKopieren()} disabled={!werte.erstmail.trim()} className="kasten kasten-muted mb-1 text-xs">
                    <Copy className="h-3 w-3" />Kopieren
                  </button>
                </div>
                <AutoTextarea readOnly={!darf} value={werte.erstmail} onChange={(e) => setze("erstmail", e.target.value)} onBlur={() => void speichere("erstmail")}
                              placeholder="Mails gehen über das Wochenpaket raus; hier nur Notizen zum Text."
                              className="min-h-[4.5rem] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm" />
              </div>
            )}
          </Karte>
        </div>

        <Karte titel="Verlauf" icon={History}>
          {verlauf === null ? (
            <div className="space-y-2">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-10" />)}</div>
          ) : verlauf.length === 0 ? (
            <p className="text-sm text-muted-foreground">Noch kein Kontakt mit diesem Haus.</p>
          ) : (
            <div className="flex flex-col">
              {verlauf.map((v, i) => (
                <div key={v.id} className="grid grid-cols-[18px_minmax(0,1fr)] gap-3">
                  <div className="flex flex-col items-center">
                    <span className={cn("mt-1 h-3 w-3 shrink-0 rounded-full",
                      v.ton === "rot" ? "bg-red-600 dark:bg-red-500"
                        : v.ton === "gruen" ? "bg-emerald-600 dark:bg-emerald-500"
                          : v.ton === "amber" ? "bg-amber-500"
                            : "border-2 border-foreground/25 bg-card")} />
                    {i < verlauf.length - 1 && <span className="mt-1 w-0.5 flex-1 bg-foreground/10 dark:bg-foreground/15" />}
                  </div>
                  <div className="min-w-0 pb-4">
                    <div className="flex justify-between gap-2.5">
                      <b className="min-w-0 truncate">{v.titel}</b>
                      <span className="whitespace-nowrap text-xs tabular-nums text-muted-foreground">{datumKurz(v.datum)}</span>
                    </div>
                    {v.text && <div className="whitespace-pre-line text-[13px] text-muted-foreground">{v.text}</div>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Karte>
      </div>

      {can("vertrieb:delete") && (
        <div>
          <button type="button" onClick={() => void hausLoeschen()} disabled={laeuft !== null} className="kasten kasten-red text-xs">
            {laeuft === "loeschen" ? <><Loader2 className="h-3 w-3 animate-spin" />Wird gelöscht…</> : <><Trash2 className="h-3 w-3" />Haus löschen</>}
          </button>
        </div>
      )}

      {vorschau && <PdfPopup url={vorschau.url} title={vorschau.title} onClose={() => setVorschau(null)} />}
      {ConfirmModalElement}
    </div>
  );
}

/** Pfad im Bucket `documents`, immer unter `vertrieb/<haus-id>/` (wie bisher). */
function uploadPfad(hausId: string, dateiname: string): string {
  return `vertrieb/${hausId}/${Date.now()}_${dateiname.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
}

function ausHaus(h: VertriebRaum): Record<Textfeld, string> {
  return {
    name: h.name, ort: h.ort ?? "", ansprechperson: h.ansprechperson ?? "", email: h.email ?? "",
    telefon: h.telefon ?? "", website: h.website ?? "", infos: h.infos ?? "", erstmail: h.erstmail ?? "",
    datum: h.datum ?? "", aufgabe: h.aufgabe ?? "", gebiet: h.gebiet ?? "", gruppe: h.gruppe ?? "",
    bedarf: h.bedarf ?? "", bedarf_beleg: h.bedarf_beleg ?? "",
  };
}
