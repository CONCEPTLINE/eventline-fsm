"use client";

/**
 * Detail eines Kampagnen-Kontakts (Modal, ausgewählt über ?k=<id>):
 * links Kontakt, Status und Notizen, rechts die E-Mail wie eine
 * Mail-Vorschau — Empfänger, Betreff, Versandzeit, Anhang, voller Text —
 * und die Antwort-Info aus dem Postfach-Abgleich.
 *
 * Status von Hand setzen → status_manuell = true: der automatische Abgleich
 * ändert ihn danach nie mehr. Notizen speichern beim Verlassen des Felds.
 * Lädt die volle Zeile erst beim Öffnen (die Liste hält keinen Mailtext).
 */

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Check, Copy, Globe, Loader2, Mail, MessageSquareReply, Paperclip, Phone } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { Modal } from "@/components/ui/modal";
import { Skeleton } from "@/components/ui/skeleton";
import { AutoTextarea } from "@/components/ui/auto-textarea";
import { SearchableSelect } from "@/components/searchable-select";
import { TOAST } from "@/lib/messages";
import { KAMPAGNE_STATUS, STATUS_REIHENFOLGE, datumLang, istKampagneStatus } from "@/lib/vertrieb/kampagnen";
import type { KampagneKontakt, KampagneStatus } from "@/types/vertrieb";

interface Props {
  id: string;
  gruppeLabel: string;
  darfBearbeiten: boolean;
  /** Postfach, in dem die Antworten liegen (aus dem Sync-Stand). */
  postfach: string | null;
  onAenderung: (patch: Partial<KampagneKontakt>) => void;
  onSchliessen: () => void;
}

function Label({ children }: { children: React.ReactNode }) {
  return <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{children}</p>;
}

const webLink = (w: string) => (/^https?:\/\//i.test(w) ? w : `https://${w}`);

export function KontaktDetail({ id, gruppeLabel, darfBearbeiten, postfach, onAenderung, onSchliessen }: Props) {
  const supabase = createClient();
  const [k, setK] = useState<KampagneKontakt | null>(null);
  const [notizen, setNotizen] = useState("");
  const [statusSpeichert, setStatusSpeichert] = useState(false);
  const [notizSpeichert, setNotizSpeichert] = useState(false);
  const [notizGespeichert, setNotizGespeichert] = useState(false);

  useEffect(() => {
    let aktiv = true;
    void supabase
      .from("vertrieb_kampagne_kontakte")
      .select("*")
      .eq("id", id)
      .maybeSingle()
      .then(({ data, error }) => {
        if (!aktiv) return;
        if (error || !data) {
          toast.error(error ? `Kontakt laden fehlgeschlagen: ${error.message}` : "Kontakt nicht gefunden");
          onSchliessen();
          return;
        }
        setK(data as KampagneKontakt);
        setNotizen((data as KampagneKontakt).notizen ?? "");
      });
    return () => { aktiv = false; };
    // onSchliessen bewusst nicht als Abhängigkeit: neu laden nur bei anderer id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supabase, id]);

  async function statusSetzen(neu: string) {
    if (!k || !istKampagneStatus(neu) || neu === k.status) return;
    setStatusSpeichert(true);
    const patch = { status: neu as KampagneStatus, status_manuell: true };
    const { error } = await supabase.from("vertrieb_kampagne_kontakte").update(patch).eq("id", k.id);
    setStatusSpeichert(false);
    if (error) { TOAST.supabaseError(error, "Status speichern fehlgeschlagen"); return; }
    setK({ ...k, ...patch });
    onAenderung(patch);
    toast.success(`Status: ${KAMPAGNE_STATUS[neu].label}`);
  }

  async function notizenSpeichern() {
    if (!k) return;
    const neu = notizen.trim() === "" ? null : notizen;
    if (neu === (k.notizen ?? null)) return;
    setNotizSpeichert(true);
    const { error } = await supabase.from("vertrieb_kampagne_kontakte").update({ notizen: neu }).eq("id", k.id);
    setNotizSpeichert(false);
    if (error) { TOAST.supabaseError(error, "Notizen speichern fehlgeschlagen"); return; }
    setK({ ...k, notizen: neu });
    onAenderung({ notizen: neu });
    setNotizGespeichert(true);
    setTimeout(() => setNotizGespeichert(false), 2000);
  }

  async function mailKopieren() {
    if (!k?.mail_text) return;
    try {
      await navigator.clipboard.writeText(k.mail_text);
      toast.success("Mailtext kopiert");
    } catch {
      toast.error("Kopieren nicht möglich");
    }
  }

  return (
    <Modal
      open
      onClose={() => { void notizenSpeichern(); onSchliessen(); }}
      title={k?.firma ?? "Kontakt"}
      size="4xl"
    >
      {!k ? (
        <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)]">
          <div className="space-y-2">
            <Skeleton className="h-4 w-40" /><Skeleton className="h-4 w-56" /><Skeleton className="h-9 w-full" /><Skeleton className="h-24 w-full" />
          </div>
          <Skeleton className="h-72 w-full" />
        </div>
      ) : (
        <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)]">
          {/* Links: Kontakt, Status, Notizen */}
          <div className="space-y-4">
            <section>
              <Label>Kontakt</Label>
              <p className="text-xs text-muted-foreground">
                {[`Nr. ${k.nr}`, k.gruppe && `${gruppeLabel}: ${k.gruppe}`, k.prioritaet && `Priorität ${k.prioritaet}`]
                  .filter(Boolean).join(" · ")}
              </p>
              {(k.ansprechperson || k.funktion) && (
                <p className="mt-1.5 text-sm">
                  <span className="font-medium">{k.ansprechperson}</span>
                  {k.funktion && <span className="text-muted-foreground">{k.ansprechperson ? ", " : ""}{k.funktion}</span>}
                </p>
              )}
              <div className="mt-1.5 space-y-1 text-sm">
                {k.email && (
                  <a href={`mailto:${k.email}`} className="flex items-center gap-2 text-blue-700 dark:text-blue-300">
                    <Mail className="h-3.5 w-3.5 shrink-0" /><span className="truncate">{k.email}</span>
                  </a>
                )}
                {k.telefon && (
                  <a href={`tel:${k.telefon.replace(/[^\d+]/g, "")}`} className="flex items-center gap-2 text-blue-700 dark:text-blue-300">
                    <Phone className="h-3.5 w-3.5 shrink-0" />{k.telefon}
                  </a>
                )}
                {k.website && (
                  <a href={webLink(k.website)} target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 text-blue-700 dark:text-blue-300">
                    <Globe className="h-3.5 w-3.5 shrink-0" /><span className="truncate">{k.website.replace(/^https?:\/\//i, "")}</span>
                  </a>
                )}
                {(k.ort || k.region) && (
                  <p className="text-muted-foreground">{[k.ort, k.region].filter(Boolean).join(", ")}</p>
                )}
              </div>
              {k.hinweis && (
                <p className="mt-2 rounded-md bg-muted/50 px-2.5 py-1.5 text-xs text-muted-foreground dark:bg-muted">{k.hinweis}</p>
              )}
            </section>

            <section>
              <div className="flex items-center gap-2">
                <Label>Status</Label>
                {statusSpeichert && <Loader2 className="mb-1 h-3 w-3 animate-spin text-muted-foreground" />}
                {k.status_manuell && !statusSpeichert && (
                  <span className="mb-1 text-[10px] text-muted-foreground" data-tooltip="Der automatische Abgleich ändert diesen Status nicht mehr.">
                    · von Hand gesetzt
                  </span>
                )}
              </div>
              {darfBearbeiten ? (
                <SearchableSelect
                  value={k.status}
                  onChange={(v) => void statusSetzen(v)}
                  items={STATUS_REIHENFOLGE.map((s) => ({ id: s, label: KAMPAGNE_STATUS[s].label }))}
                  searchable={false}
                  clearable={false}
                />
              ) : (
                <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${KAMPAGNE_STATUS[k.status].farbe}`}>
                  {KAMPAGNE_STATUS[k.status].label}
                </span>
              )}
            </section>

            <section>
              <div className="flex items-center gap-2">
                <Label>Notizen</Label>
                {notizSpeichert && <Loader2 className="mb-1 h-3 w-3 animate-spin text-muted-foreground" />}
                {notizGespeichert && <Check className="mb-1 h-3 w-3 text-green-600 dark:text-green-400" />}
              </div>
              {darfBearbeiten ? (
                <AutoTextarea
                  value={notizen}
                  onChange={(e) => setNotizen(e.target.value)}
                  onBlur={() => void notizenSpeichern()}
                  placeholder="z. B. angerufen, will im Januar nochmals reden …"
                  className="min-h-[5rem] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm"
                />
              ) : (
                <p className="whitespace-pre-wrap text-sm">{k.notizen || <span className="text-muted-foreground">—</span>}</p>
              )}
            </section>
          </div>

          {/* Rechts: die E-Mail */}
          <section className="min-w-0">
            <div className="flex items-center justify-between">
              <Label>E-Mail</Label>
              {k.mail_text && (
                <button type="button" onClick={() => void mailKopieren()} className="kasten kasten-muted mb-1 text-xs">
                  <Copy className="h-3 w-3" />Text kopieren
                </button>
              )}
            </div>

            {k.antworten_anzahl > 0 && k.letzte_antwort_am && (
              <div className="mb-3 rounded-lg border border-green-300 bg-green-50 px-3 py-2 text-sm dark:border-green-500/40 dark:bg-green-500/10">
                <p className="flex items-center gap-1.5 font-medium text-green-800 dark:text-green-200">
                  <MessageSquareReply className="h-4 w-4 shrink-0" />
                  {k.antworten_anzahl === 1 ? "1 Antwort" : `${k.antworten_anzahl} Antworten`} · zuletzt {datumLang(k.letzte_antwort_am)}
                </p>
                {k.letzte_antwort_betreff && <p className="mt-0.5 truncate text-xs text-green-900/80 dark:text-green-100/80">«{k.letzte_antwort_betreff}»</p>}
                <p className="mt-1 text-xs text-green-900/70 dark:text-green-100/70">Antwort im Postfach {postfach ?? "leo@"} ansehen</p>
              </div>
            )}

            {!k.mail_betreff && !k.mail_text ? (
              <p className="text-sm text-muted-foreground">Keine Mail hinterlegt.</p>
            ) : (
              <div className="overflow-hidden rounded-lg border">
                <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 border-b bg-muted/30 px-3 py-2.5 text-xs dark:bg-muted/50">
                  <dt className="text-muted-foreground">An</dt>
                  <dd className="truncate">{k.mail_an ?? k.email ?? "—"}</dd>
                  <dt className="text-muted-foreground">Betreff</dt>
                  <dd className="font-semibold">{k.mail_betreff ?? "—"}</dd>
                  {k.mail_gesendet_am ? (
                    <><dt className="text-muted-foreground">Gesendet</dt><dd>{datumLang(k.mail_gesendet_am)}</dd></>
                  ) : k.mail_geplant_am ? (
                    <><dt className="text-muted-foreground">Geplant</dt><dd className="text-blue-700 dark:text-blue-300">{datumLang(k.mail_geplant_am)}</dd></>
                  ) : null}
                  {k.mail_anhang && (
                    <><dt className="text-muted-foreground">Anhang</dt><dd className="flex items-center gap-1 truncate"><Paperclip className="h-3 w-3 shrink-0" />{k.mail_anhang}</dd></>
                  )}
                </dl>
                <div className="max-h-[55vh] overflow-y-auto whitespace-pre-wrap px-4 py-3 text-sm leading-relaxed">
                  {k.mail_text ?? <span className="text-muted-foreground">Kein Text hinterlegt.</span>}
                </div>
              </div>
            )}
          </section>
        </div>
      )}
    </Modal>
  );
}
