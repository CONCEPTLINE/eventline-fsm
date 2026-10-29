"use client";

/**
 * Detail eines Vertriebs-Raums: Kontakt, Infos, PDF-Anhaenge, Erstmail
 * und der naechste Schritt (Datum + Aufgabe → Kalender).
 *
 * Jedes Feld speichert beim Verlassen (onBlur) — kein Speichern-Knopf,
 * damit nichts verloren geht, wenn man einfach zum naechsten Raum klickt.
 * Die Seite rendert das Detail mit key={raum.id}: ein anderer Raum baut
 * die Komponente neu auf, die Felder starten also immer frisch.
 */

import { useRef, useState } from "react";
import { toast } from "sonner";
import { CalendarClock, Copy, FileText, Loader2, Paperclip, Trash2, X } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { Input } from "@/components/ui/input";
import { AutoTextarea } from "@/components/ui/auto-textarea";
import { PdfPopup } from "@/components/pdf-popup";
import { useConfirm } from "@/components/ui/use-confirm";
import { validateFileSize } from "@/lib/file-upload";
import { TOAST } from "@/lib/messages";
import type { VertriebDokument, VertriebRaum } from "@/types/vertrieb";

type Textfeld = "name" | "ort" | "ansprechperson" | "email" | "telefon" | "website" | "infos" | "erstmail" | "datum" | "aufgabe";

interface Props {
  raum: VertriebRaum;
  onAendern: (patch: Partial<VertriebRaum>) => Promise<boolean>;
  /** null = kein Loeschrecht (vertrieb:delete), Knopf entfaellt. */
  onLoeschen: (() => Promise<void>) | null;
  /** vertrieb:edit — ohne Recht nur lesen (keine Felder, kein Upload). */
  darfBearbeiten: boolean;
  onSchliessen: () => void;
}

function Label({ children }: { children: React.ReactNode }) {
  return <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{children}</p>;
}

export function RaumDetail({ raum, onAendern, onLoeschen, onSchliessen, darfBearbeiten }: Props) {
  const supabase = createClient();
  const { confirm, ConfirmModalElement } = useConfirm();
  const [werte, setWerte] = useState<Record<Textfeld, string>>(() => ausRaum(raum));
  const [hochladen, setHochladen] = useState(false);
  const [loescht, setLoescht] = useState(false);
  const [vorschau, setVorschau] = useState<{ url: string; title: string } | null>(null);
  const dateiRef = useRef<HTMLInputElement>(null);

  function setze(feld: Textfeld, wert: string) {
    setWerte((w) => ({ ...w, [feld]: wert }));
  }

  async function speichere(feld: Textfeld, wert = werte[feld]) {
    if (!darfBearbeiten) return;
    const neu = wert.trim() === "" ? null : wert.trim();
    if (neu === (raum[feld] ?? null)) return;
    if (feld === "name" && !neu) {
      TOAST.requiredField("Name");
      setze("name", raum.name);
      return;
    }
    const ok = await onAendern({ [feld]: neu } as Partial<VertriebRaum>);
    if (!ok) setze(feld, raum[feld] ?? "");
  }

  async function dateiHochladen(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !validateFileSize(file)) return;
    setHochladen(true);
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
    const path = `vertrieb/${raum.id}/${Date.now()}_${safeName}`;
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
    const dokumente: VertriebDokument[] = [...raum.dokumente, { name: file.name, path, uploaded_at: new Date().toISOString() }];
    if (await onAendern({ dokumente })) toast.success("PDF angehängt");
  }

  async function dateiOeffnen(doc: VertriebDokument) {
    // Bucket ist privat → signierte URL statt getPublicUrl().
    const { data, error } = await supabase.storage.from("documents").createSignedUrl(doc.path, 3600);
    if (error || !data?.signedUrl) { toast.error("Datei nicht verfügbar"); return; }
    setVorschau({ url: data.signedUrl, title: doc.name });
  }

  async function dateiLoeschen(doc: VertriebDokument) {
    const ok = await confirm({ title: "Anhang löschen?", message: `«${doc.name}» wird entfernt.`, confirmLabel: "Löschen", variant: "red" });
    if (!ok) return;
    const { error } = await supabase.storage.from("documents").remove([doc.path]);
    if (error) { TOAST.supabaseError(error, "Anhang konnte nicht gelöscht werden"); return; }
    if (await onAendern({ dokumente: raum.dokumente.filter((d) => d.path !== doc.path) })) toast.success("Anhang gelöscht");
  }

  async function erstmailKopieren() {
    if (!werte.erstmail.trim()) return;
    try {
      await navigator.clipboard.writeText(werte.erstmail);
      toast.success("Erstmail kopiert");
    } catch {
      toast.error("Kopieren nicht möglich");
    }
  }

  async function raumLoeschen() {
    const ok = await confirm({
      title: "Raum löschen?",
      message: `«${raum.name}» wird mit allen Anhängen endgültig gelöscht.`,
      confirmLabel: "Löschen",
      variant: "red",
    });
    if (!ok || !onLoeschen) return;
    setLoescht(true);
    try { await onLoeschen(); } finally { setLoescht(false); }
  }

  const feld = (f: Textfeld, placeholder: string, type = "text") => (
    <Input
      readOnly={!darfBearbeiten}
      type={type}
      value={werte[f]}
      placeholder={placeholder}
      onChange={(e) => setze(f, e.target.value)}
      onBlur={() => void speichere(f)}
      className="h-8 text-sm"
    />
  );

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-lg border border-border bg-card">
      {/* Kopf: Name direkt editierbar */}
      <div className="flex shrink-0 items-center gap-2 border-b border-border p-3">
        <Input
          readOnly={!darfBearbeiten}
          value={werte.name}
          onChange={(e) => setze("name", e.target.value)}
          onBlur={() => void speichere("name")}
          className="h-9 flex-1 border-transparent bg-transparent px-1 text-base font-semibold shadow-none focus-visible:border-input"
        />
        <button type="button" onClick={onSchliessen} data-tooltip="Schliessen"
                className="kasten kasten-muted h-8 w-8 justify-center p-0">
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3">
        {/* Naechster Schritt — zuoberst, weil er den Kalender fuettert */}
        <section className="rounded-lg border border-indigo-200 bg-indigo-50/60 p-2.5 dark:border-indigo-500/40 dark:bg-indigo-500/10">
          <Label><span className="inline-flex items-center gap-1"><CalendarClock className="h-3 w-3" />Nächster Schritt · erscheint im Kalender</span></Label>
          <div className="flex gap-2">
            <Input
              readOnly={!darfBearbeiten}
              type="date"
              value={werte.datum}
              onChange={(e) => { setze("datum", e.target.value); void speichere("datum", e.target.value); }}
              className="h-8 w-40 shrink-0 text-sm"
            />
            {feld("aufgabe", "Was ist zu tun? z. B. Erstmail senden")}
          </div>
        </section>

        <section>
          <Label>Kontakt</Label>
          <div className="grid grid-cols-2 gap-2">
            {feld("ort", "Ort / Adresse")}
            {feld("ansprechperson", "Ansprechperson")}
            {feld("email", "E-Mail", "email")}
            {feld("telefon", "Telefon", "tel")}
            <div className="col-span-2">{feld("website", "Website")}</div>
          </div>
        </section>

        <section>
          <Label>Infos zum Raum</Label>
          <AutoTextarea
            readOnly={!darfBearbeiten}
            value={werte.infos}
            onChange={(e) => setze("infos", e.target.value)}
            onBlur={() => void speichere("infos")}
            placeholder="Grösse, Kapazität, wer vermietet heute, worauf achten …"
            className="min-h-[4.5rem] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm"
          />
        </section>

        <section>
          <div className="flex items-center justify-between">
            <Label>PDF-Anhänge</Label>
            {darfBearbeiten && <button type="button" onClick={() => dateiRef.current?.click()} disabled={hochladen}
                    className="kasten kasten-muted mb-1 text-xs">
              {hochladen ? <><Loader2 className="h-3 w-3 animate-spin" />Lädt hoch…</> : <><Paperclip className="h-3 w-3" />PDF anhängen</>}
            </button>}
            <input ref={dateiRef} type="file" accept="application/pdf,.pdf" className="hidden" onChange={dateiHochladen} />
          </div>
          {raum.dokumente.length === 0 ? (
            <p className="text-xs text-muted-foreground">Noch keine Anhänge.</p>
          ) : (
            <div className="space-y-1">
              {raum.dokumente.map((d) => (
                <div key={d.path} className="row-hover flex items-center gap-2 rounded-md px-2 py-1.5 [--row-hover-x:0.125rem]">
                  <FileText className="h-4 w-4 shrink-0 text-red-600" />
                  <button type="button" onClick={() => void dateiOeffnen(d)} className="min-w-0 flex-1 truncate text-left text-sm">
                    {d.name}
                  </button>
                  {darfBearbeiten && (
                    <button type="button" onClick={() => void dateiLoeschen(d)} data-tooltip="Anhang löschen"
                            className="kasten kasten-muted h-7 w-7 justify-center p-0">
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>

        <section>
          <div className="flex items-center justify-between">
            <Label>Erstmail</Label>
            <button type="button" onClick={() => void erstmailKopieren()} disabled={!werte.erstmail.trim()}
                    className="kasten kasten-blue mb-1 text-xs">
              <Copy className="h-3 w-3" />Kopieren
            </button>
          </div>
          <AutoTextarea
            readOnly={!darfBearbeiten}
            value={werte.erstmail}
            onChange={(e) => setze("erstmail", e.target.value)}
            onBlur={() => void speichere("erstmail")}
            placeholder={"Betreff: …\n\nSehr geehrte Frau …"}
            className="min-h-[9rem] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm"
          />
        </section>
      </div>

      {onLoeschen && (
        <div className="shrink-0 border-t border-border p-2.5">
          <button type="button" onClick={() => void raumLoeschen()} disabled={loescht} className="kasten kasten-red text-xs">
            {loescht ? <><Loader2 className="h-3 w-3 animate-spin" />Wird gelöscht…</> : <><Trash2 className="h-3 w-3" />Raum löschen</>}
          </button>
        </div>
      )}

      {vorschau && <PdfPopup url={vorschau.url} title={vorschau.title} onClose={() => setVorschau(null)} />}
      {ConfirmModalElement}
    </div>
  );
}

function ausRaum(r: VertriebRaum): Record<Textfeld, string> {
  return {
    name: r.name,
    ort: r.ort ?? "",
    ansprechperson: r.ansprechperson ?? "",
    email: r.email ?? "",
    telefon: r.telefon ?? "",
    website: r.website ?? "",
    infos: r.infos ?? "",
    erstmail: r.erstmail ?? "",
    datum: r.datum ?? "",
    aufgabe: r.aufgabe ?? "",
  };
}
