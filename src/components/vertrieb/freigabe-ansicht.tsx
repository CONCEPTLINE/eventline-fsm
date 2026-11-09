"use client";

/**
 * Vertrieb › Heute › Freigabe eines Wochenpakets (Leos Entscheid «Weg 1»,
 * 09.11.2026). Je Mail: Kundenblatt, Prüfungen, die Mail genau wie sie
 * rausgeht, das PDF und die Knöpfe Streichen / Freigeben.
 *
 * Das FSM sendet NICHTS. «Freigeben» setzt nur den Status
 * (/api/vertrieb/wochenpaket/<id>); der Mac holt die Mail ab, prüft sie
 * nochmals und plant sie bei Microsoft ein — Absender leo@. Darum steht
 * nach der Freigabe «So geht es weiter».
 */

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Building2, Check, ChevronLeft, FileText, Loader2, Mail, ShieldCheck, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { createClient } from "@/lib/supabase/client";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { PdfPopup } from "@/components/pdf-popup";
import { useConfirm } from "@/components/ui/use-confirm";
import { Karte, TON_KLASSEN, type Ton } from "@/components/dashboard/karte";
import { usePermissions } from "@/lib/use-permissions";
import { ZRH_TZ } from "@/lib/swiss-time";
import type { VertriebRaum, WochenpaketMail, WochenpaketStatus } from "@/types/vertrieb";

const STATUS: Record<WochenpaketStatus, { label: string; ton: Ton }> = {
  offen: { label: "Wartet auf Freigabe", ton: "rot" },
  freigegeben: { label: "Freigegeben", ton: "gruen" },
  gestrichen: { label: "Gestrichen", ton: "neutral" },
  eingeplant: { label: "Bei Microsoft eingeplant", ton: "gruen" },
  gesendet: { label: "Gesendet", ton: "gruen" },
};

const SPALTEN =
  "id, kw, haus_id, an, betreff, text, anhang_name, anhang_bucket_pfad, versand_ab, kundenblatt, pruefungen, status, freigegeben_am, eingeplant_am";

function versandText(iso: string | null): string {
  if (!iso) return "Di–Do ab 09:30, verteilt";
  return new Intl.DateTimeFormat("de-CH", {
    timeZone: ZRH_TZ, weekday: "short", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit",
  }).format(new Date(iso));
}

interface Props {
  kw: string;
  haeuser: VertriebRaum[];
  onZurueck: () => void;
  onGeaendert: () => void;
}

export function FreigabeAnsicht({ kw, haeuser, onZurueck, onGeaendert }: Props) {
  const { can } = usePermissions();
  const darf = can("vertrieb:edit");
  const { confirm, ConfirmModalElement } = useConfirm();
  const [mails, setMails] = useState<WochenpaketMail[] | null>(null);
  const [laeuft, setLaeuft] = useState<string | null>(null);
  const [vorschau, setVorschau] = useState<{ url: string; title: string } | null>(null);

  const laden = useCallback(async () => {
    const { data, error } = await createClient()
      .from("vertrieb_wochenpaket_mails").select(SPALTEN).eq("kw", kw).order("an");
    if (error) { toast.error(`Wochenpaket laden fehlgeschlagen: ${error.message}`); setMails([]); return; }
    setMails((data ?? []) as unknown as WochenpaketMail[]);
  }, [kw]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void laden();
  }, [laden]);

  async function aktion(m: WochenpaketMail, was: "freigeben" | "streichen"): Promise<boolean> {
    const res = await fetch(`/api/vertrieb/wochenpaket/${m.id}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ aktion: was }),
    }).catch(() => null);
    const json = await res?.json().catch(() => null);
    if (!res?.ok || !json?.ok) { toast.error(json?.error ?? "Verbindung unterbrochen"); return false; }
    if (json.warnung) toast.warning(json.warnung);
    return true;
  }

  async function eine(m: WochenpaketMail, was: "freigeben" | "streichen") {
    if (was === "streichen") {
      const ok = await confirm({ title: "Mail streichen?", message: `Die Mail an ${m.an} wird nicht gesendet.`, confirmLabel: "Streichen", variant: "red" });
      if (!ok) return;
    }
    setLaeuft(m.id);
    const ok = await aktion(m, was);
    setLaeuft(null);
    if (ok) {
      toast.success(was === "freigeben" ? "Freigegeben — der Mac plant die Mail ein" : "Mail gestrichen");
      await laden();
      onGeaendert();
    }
  }

  async function alle() {
    const offen = (mails ?? []).filter((m) => m.status === "offen");
    const ok = await confirm({
      title: `Ganzes ${kw.replace("KW", "KW ")} freigeben?`,
      message: `${offen.length} ${offen.length === 1 ? "Mail geht" : "Mails gehen"} von leo@ raus, verteilt Di–Do ab 09:30.`,
      confirmLabel: "Alle freigeben",
      variant: "blue",
    });
    if (!ok) return;
    setLaeuft("alle");
    let n = 0;
    for (const m of offen) if (await aktion(m, "freigeben")) n++;
    setLaeuft(null);
    toast.success(`${n} von ${offen.length} freigegeben`);
    await laden();
    onGeaendert();
  }

  async function pdf(m: WochenpaketMail) {
    if (!m.anhang_bucket_pfad) return;
    const { data, error } = await createClient().storage.from("documents").createSignedUrl(m.anhang_bucket_pfad, 3600);
    if (error || !data?.signedUrl) { toast.error("PDF nicht verfügbar"); return; }
    setVorschau({ url: data.signedUrl, title: m.anhang_name ?? "Anhang" });
  }

  const hausName = new Map(haeuser.map((h) => [h.id, h.name]));
  const offen = (mails ?? []).filter((m) => m.status === "offen").length;

  return (
    <div className="flex flex-col gap-4">
      <button type="button" onClick={onZurueck} className="inline-flex w-fit items-center gap-1 text-[13px] text-muted-foreground">
        <ChevronLeft className="h-3.5 w-3.5" />Heute
      </button>

      <section className="flex flex-wrap items-center justify-between gap-4 rounded-xl border bg-card p-5">
        <div className="min-w-0">
          <h2 className="font-heading text-[22px] font-bold">Wochenpaket {kw.replace("KW", "KW ")}</h2>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <span className={cn("rounded-full px-2.5 py-0.5 text-xs font-semibold", TON_KLASSEN.neutral)}>{mails?.length ?? "…"} Mails</span>
            <span className={cn("rounded-full px-2.5 py-0.5 text-xs font-semibold", TON_KLASSEN.neutral)}>Versand Di–Do ab 09:30</span>
            <span className={cn("rounded-full px-2.5 py-0.5 text-xs font-semibold", TON_KLASSEN.neutral)}>von leo@eventline-basel.com</span>
          </div>
        </div>
        {darf && offen > 1 && (
          <button type="button" onClick={() => void alle()} disabled={laeuft !== null} className="kasten kasten-green">
            {laeuft === "alle" ? <><Loader2 className="h-4 w-4 animate-spin" />Wird freigegeben…</> : <><Check className="h-4 w-4" />Alle {offen} freigeben</>}
          </button>
        )}
      </section>

      {mails === null ? (
        <Skeleton className="h-[420px] rounded-xl" />
      ) : mails.length === 0 ? (
        <EmptyState icon={Mail} title="Keine Mails in diesem Paket" description="Das Wochenpaket wird jeden Montag um 08:00 auf dem Mac vorbereitet." />
      ) : mails.map((m) => {
        const st = STATUS[m.status];
        const kb = m.kundenblatt ?? {};
        return (
          <div key={m.id} className="flex flex-col gap-4">
            <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
              <div className="flex min-w-0 flex-col gap-4">
                <Karte titel="Kundenblatt" icon={Building2}>
                  <div className="grid grid-cols-[92px_minmax(0,1fr)] gap-x-3 gap-y-2.5 text-[13px]">
                    <span className="text-muted-foreground">Haus</span>
                    <b>{kb.haus ?? (m.haus_id && hausName.get(m.haus_id)) ?? "—"}</b>
                    <span className="text-muted-foreground">Bedarf</span><span>{kb.bedarf ?? "—"}</span>
                    <span className="text-muted-foreground">Aufhänger</span><span>{kb.aufhaenger ?? "—"}</span>
                    <span className="text-muted-foreground">Beleg</span>
                    {kb.beleg_url
                      ? <a href={kb.beleg_url} target="_blank" rel="noreferrer" className="truncate underline underline-offset-2">{kb.beleg_url.replace(/^https?:\/\//, "").replace(/\/$/, "")}</a>
                      : <span>—</span>}
                    {kb.anrede_hinweis && (<>
                      <span className="text-muted-foreground">Anrede</span>
                      <span><span className={cn("rounded-full px-2 py-0.5 text-xs font-semibold", TON_KLASSEN.amber)}>{kb.anrede_hinweis}</span></span>
                    </>)}
                  </div>
                </Karte>
                <Karte titel="Prüfungen" icon={ShieldCheck}>
                  {m.pruefungen.length === 0 ? (
                    <p className="text-sm text-muted-foreground">Noch nicht geprüft — der Mac prüft vor dem Einplanen.</p>
                  ) : (
                    <div className="flex flex-col gap-1.5">
                      {m.pruefungen.map((p) => (
                        <div key={p.text} className="flex items-center gap-2.5 text-[13px]">
                          <span className={cn("flex h-5 w-5 shrink-0 items-center justify-center rounded-full", p.ok ? TON_KLASSEN.gruen : TON_KLASSEN.rot)}>
                            {p.ok ? <Check className="h-3 w-3" /> : <X className="h-3 w-3" />}
                          </span>
                          {p.text}
                        </div>
                      ))}
                    </div>
                  )}
                </Karte>
              </div>

              <section aria-label="Mail" className="min-w-0 overflow-hidden rounded-xl border bg-card">
                <div className="grid grid-cols-[70px_minmax(0,1fr)] gap-y-1.5 border-b px-5 py-4 text-[13px]">
                  <span className="text-muted-foreground">Von</span><span>Leo Balaszeskul &lt;leo@eventline-basel.com&gt;</span>
                  <span className="text-muted-foreground">An</span><span className="truncate">{m.an}</span>
                  <span className="text-muted-foreground">Betreff</span><b>{m.betreff}</b>
                  <span className="text-muted-foreground">Versand</span><span>{versandText(m.versand_ab)}</span>
                  <span className="text-muted-foreground">Status</span>
                  <span><span className={cn("rounded-full px-2 py-0.5 text-xs font-semibold", TON_KLASSEN[st.ton])}>{st.label}</span></span>
                </div>
                <div className="whitespace-pre-line px-5 py-4 text-sm leading-relaxed">{m.text}</div>
                <p className="px-5 pb-3 text-[13px] text-muted-foreground">Gruss und Signatur setzt das Versandskript.</p>
                {m.anhang_name && (
                  <div className="px-5 pb-4">
                    <button type="button" onClick={() => void pdf(m)} disabled={!m.anhang_bucket_pfad}
                            className="card-hover flex w-full items-center gap-3 rounded-xl border-2 p-3 text-left">
                      <span className={cn("flex h-12 w-10 shrink-0 items-center justify-center rounded-md", TON_KLASSEN.rot)}>
                        <FileText className="h-5 w-5" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <b className="block truncate text-[13px]">{m.anhang_name}</b>
                        <span className="text-xs text-muted-foreground">{m.anhang_bucket_pfad ? "Zum Ansehen klicken" : "Liegt auf dem Mac (Wochenordner)"}</span>
                      </span>
                    </button>
                  </div>
                )}
                {m.status === "offen" && darf && (
                  <div className="flex flex-wrap justify-end gap-2 border-t bg-foreground/[0.02] px-5 py-3.5 dark:bg-foreground/[0.05]">
                    <button type="button" onClick={() => void eine(m, "streichen")} disabled={laeuft !== null} className="kasten kasten-muted">
                      Streichen
                    </button>
                    <button type="button" onClick={() => void eine(m, "freigeben")} disabled={laeuft !== null} className="kasten kasten-green">
                      {laeuft === m.id ? <><Loader2 className="h-4 w-4 animate-spin" />Wird freigegeben…</> : <><Check className="h-4 w-4" />Freigeben</>}
                    </button>
                  </div>
                )}
              </section>
            </div>

            {(m.status === "freigegeben" || m.status === "eingeplant") && <Weiter mail={m} />}
          </div>
        );
      })}

      {vorschau && <PdfPopup url={vorschau.url} title={vorschau.title} onClose={() => setVorschau(null)} />}
      {ConfirmModalElement}
    </div>
  );
}

/** «So geht es weiter» nach der Freigabe (Weg 1). */
function Weiter({ mail }: { mail: WochenpaketMail }) {
  const schritte = [
    { titel: "Freigegeben", text: "Im FSM, durch dich", fertig: true },
    { titel: "Mac holt ab und prüft", text: "Prüfer, Sperrliste, Opt-out, Duplikate", fertig: mail.status === "eingeplant" },
    { titel: "Bei Microsoft eingeplant", text: "Läuft danach ohne Mac", fertig: mail.status === "eingeplant" },
    { titel: "Gesendet von leo@", text: `${versandText(mail.versand_ab)} · Haus wird «Angeschrieben»`, fertig: false },
  ];
  return (
    <section aria-label="So geht es weiter" className="rounded-xl border bg-card p-5">
      <h3 className="font-heading text-base font-bold">So geht es weiter · {mail.an}</h3>
      <div className="mt-3.5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {schritte.map((s, i) => (
          <div key={s.titel} className={cn("rounded-xl p-3.5", s.fertig ? "bg-emerald-500/10 dark:bg-emerald-500/15" : "bg-foreground/[0.04] dark:bg-foreground/[0.08]")}>
            <span className={cn("inline-flex h-[26px] w-[26px] items-center justify-center rounded-full text-xs font-bold",
                                s.fertig ? "bg-emerald-600 text-white" : "border-2 bg-card text-muted-foreground")}>
              {s.fertig ? <Check className="h-3.5 w-3.5" /> : i + 1}
            </span>
            <b className="mt-2.5 block text-sm">{s.titel}</b>
            <span className="mt-0.5 block text-xs text-muted-foreground">{s.text}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
