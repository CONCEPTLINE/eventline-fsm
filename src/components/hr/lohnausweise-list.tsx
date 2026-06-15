"use client";

/**
 * Lohndokumente-Liste fuer den eingeloggten Mitarbeiter — zeigt
 * monatliche Lohnabrechnungen + jaehrliche Lohnausweise zum Download.
 *
 * Erst-Zugriff: Consent-Modal mit Datenschutz-Hinweis. Akzeptanz wird
 * auf profiles.lohndokumente_digital_accepted_at + _version protokolliert.
 *
 * Download via Signed-URL (5min) — kein direkter Storage-Zugriff vom
 * Client, alles ueber /api/hr/wage-documents.
 */

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Modal } from "@/components/ui/modal";
import { FileText, Download, ShieldCheck, Mail } from "lucide-react";
import { toast } from "sonner";
import { Loading } from "@/components/ui/spinner";

interface WageDoc {
  id: string;
  doc_type: "lohnabrechnung" | "lohnausweis";
  year: number;
  period_month: number | null;
  file_size: number | null;
  uploaded_at: string;
}

interface ConsentState {
  accepted_at: string | null;
  accepted_version: string | null;
}

const MONTH_NAMES = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"];
const CONSENT_VERSION = "1.0";

export function LohnausweiseList() {
  const supabase = createClient();
  const [docs, setDocs] = useState<WageDoc[]>([]);
  const [consent, setConsent] = useState<ConsentState | null>(null);
  const [loading, setLoading] = useState(true);
  const [consentNeeded, setConsentNeeded] = useState(false);
  const [accepting, setAccepting] = useState(false);

  useEffect(() => {
    (async () => {
      // Consent-State via SECURITY-DEFINER-RPC statt direkt profiles-Read —
      // konsistent mit der "Profile-Reads ueber RPC"-Konvention.
      const { data } = await supabase.rpc("get_my_wage_consent");
      const prof = (Array.isArray(data) ? data[0] : null) as ConsentState | null;
      const accepted = prof?.accepted_at
        && prof.accepted_version === CONSENT_VERSION;
      setConsent(prof ?? null);
      if (!accepted) { setConsentNeeded(true); setLoading(false); return; }
      const res = await fetch("/api/hr/wage-documents");
      const j = await res.json();
      if (j.success) setDocs(j.documents as WageDoc[]);
      setLoading(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function accept() {
    setAccepting(true);
    const res = await fetch("/api/hr/wage-documents/accept-digital", { method: "POST" });
    const j = await res.json();
    if (!j.success) { toast.error(j.error || "Speichern fehlgeschlagen"); setAccepting(false); return; }
    setConsentNeeded(false);
    setConsent({ accepted_at: new Date().toISOString(), accepted_version: CONSENT_VERSION });
    setLoading(true);
    const docsRes = await fetch("/api/hr/wage-documents");
    const docsJ = await docsRes.json();
    if (docsJ.success) setDocs(docsJ.documents as WageDoc[]);
    setLoading(false);
    setAccepting(false);
  }

  async function download(id: string) {
    const res = await fetch(`/api/hr/wage-documents/${id}`);
    const j = await res.json();
    if (!j.success) { toast.error(j.error || "Download fehlgeschlagen"); return; }
    const a = document.createElement("a");
    a.href = j.url; a.download = j.filename; a.target = "_blank";
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
  }

  const byYear = docs.reduce<Record<number, WageDoc[]>>((acc, d) => {
    (acc[d.year] ??= []).push(d);
    return acc;
  }, {});
  const years = Object.keys(byYear).map(Number).sort((a, b) => b - a);

  return (
    <div className="space-y-3">
      <div>
        <h2 className="text-sm font-semibold">Meine Lohndokumente</h2>
        <p className="text-xs text-muted-foreground">
          Monatliche Lohnabrechnungen + jährlicher Lohnausweis (für die Steuererklärung).
        </p>
      </div>

      {!loading && !consentNeeded && consent?.accepted_at && (
        <DigitalConsentCard acceptedAt={consent.accepted_at} version={consent.accepted_version} />
      )}

      {loading ? (
        <Card className="bg-card"><CardContent><Loading /></CardContent></Card>
      ) : docs.length === 0 && !consentNeeded ? (
        <Card className="bg-card border-dashed">
          <CardContent className="py-10 text-center space-y-2">
            <div className="mx-auto w-12 h-12 rounded-2xl bg-foreground/10 dark:bg-foreground/15 flex items-center justify-center">
              <FileText className="h-6 w-6 text-foreground/40" />
            </div>
            <p className="text-sm font-medium">Noch keine Dokumente</p>
            <p className="text-xs text-muted-foreground">
              Sobald deine Lohnabrechnung oder dein Lohnausweis verfügbar ist, erscheint sie hier.
            </p>
          </CardContent>
        </Card>
      ) : !consentNeeded ? (
        <div className="space-y-3">
          {years.map((y) => (
            <Card key={y} className="bg-card">
              <CardHeader className="pb-2">
                <CardTitle className="text-xs uppercase tracking-wider text-muted-foreground">{y}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-1">
                {byYear[y].sort(sortDocs).map((d) => (
                  <DocRow key={d.id} doc={d} onDownload={() => download(d.id)} />
                ))}
              </CardContent>
            </Card>
          ))}
        </div>
      ) : null}

      <ConsentModal open={consentNeeded} onAccept={accept} accepting={accepting} />
    </div>
  );
}

function sortDocs(a: WageDoc, b: WageDoc): number {
  if (a.doc_type !== b.doc_type) return a.doc_type === "lohnausweis" ? -1 : 1;
  return (b.period_month ?? 0) - (a.period_month ?? 0);
}

function DocRow({ doc, onDownload }: { doc: WageDoc; onDownload: () => void }) {
  const label = doc.doc_type === "lohnausweis"
    ? `Lohnausweis ${doc.year}`
    : `Lohnabrechnung ${MONTH_NAMES[(doc.period_month ?? 1) - 1]} ${doc.year}`;
  const tag = doc.doc_type === "lohnausweis" ? "Jahres-Dokument" : "Monatsabrechnung";
  return (
    <div className="flex items-center justify-between gap-2 px-3 py-2 rounded-lg border border-border bg-foreground/[0.02] dark:bg-foreground/[0.04]">
      <div className="min-w-0 flex items-center gap-2">
        <FileText className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        <div className="min-w-0">
          <p className="text-sm font-medium truncate">{label}</p>
          <p className="text-[10px] text-muted-foreground">{tag}</p>
        </div>
      </div>
      <button type="button" onClick={onDownload} className="kasten kasten-blue shrink-0">
        <Download className="h-3.5 w-3.5" /> PDF
      </button>
    </div>
  );
}

function DigitalConsentCard({ acceptedAt, version }: { acceptedAt: string; version: string | null }) {
  const fmt = new Date(acceptedAt).toLocaleDateString("de-CH", {
    day: "2-digit", month: "2-digit", year: "numeric",
  });
  return (
    <Card className="bg-card border-emerald-500/30">
      <CardContent className="py-3">
        <div className="flex items-start gap-2.5">
          <div className="w-8 h-8 rounded-xl bg-emerald-500/15 flex items-center justify-center shrink-0">
            <ShieldCheck className="h-4 w-4 text-emerald-700 dark:text-emerald-300" />
          </div>
          <div className="flex-1 min-w-0 space-y-1">
            <p className="text-sm font-medium">Einwilligung digitale Lohndokumente</p>
            <p className="text-[11px] text-muted-foreground leading-relaxed">
              Du hast am <span className="font-medium text-foreground">{fmt}</span> zugestimmt,
              Lohnabrechnungen und Lohnausweise digital in dieser App zu erhalten.
              {version && <span className="text-muted-foreground/70"> (Version {version})</span>}
            </p>
            <a
              href="mailto:admin@eventline-basel.com?subject=Lohndokumente%20auf%20Papier%20-%20Wechsel&body=Hallo,%0A%0Aich%20m%C3%B6chte%20meine%20Lohndokumente%20in%20Zukunft%20wieder%20in%20Papierform%20erhalten.%0A%0ADanke."
              className="inline-flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground underline underline-offset-2"
            >
              <Mail className="h-3 w-3" /> Wieder auf Papier wechseln
            </a>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function ConsentModal({ open, onAccept, accepting }: { open: boolean; onAccept: () => void; accepting: boolean }) {
  return (
    <Modal open={open} onClose={() => { /* nicht schliessbar */ }} title="Digitale Lohndokumente" closable={false} size="md">
      <div className="space-y-4">
        <div className="flex items-start gap-3 p-3 rounded-lg bg-blue-50 dark:bg-blue-500/15 border border-blue-200 dark:border-blue-500/30">
          <ShieldCheck className="h-5 w-5 text-blue-700 dark:text-blue-300 shrink-0 mt-0.5" />
          <div className="text-xs text-blue-900 dark:text-blue-100 space-y-1">
            <p className="font-semibold">Lohnabrechnungen + Lohnausweis digital</p>
            <p>
              EVENTLINE stellt dir deine Lohndokumente (monatliche Abrechnungen + jährlicher Lohnausweis)
              digital in dieser App zur Verfügung. Du kannst sie hier jederzeit als PDF herunterladen.
            </p>
          </div>
        </div>

        <div className="text-xs text-muted-foreground space-y-2">
          <p>
            <strong>Datenschutz:</strong> Deine Lohndokumente liegen verschlüsselt im Eventline-System.
            Nur du und die HR-Verantwortlichen können sie sehen. Download-Links sind 5 Minuten gültig.
          </p>
          <p>
            <strong>Alternative:</strong> Du kannst stattdessen Papier-Lohndokumente anfordern.
          </p>
        </div>

        <div className="flex flex-col gap-2">
          <button type="button" onClick={onAccept} disabled={accepting} className="kasten kasten-red w-full">
            {accepting ? "Speichert…" : "Ich stimme der digitalen Bereitstellung zu"}
          </button>
          <a
            href="mailto:admin@eventline-basel.com?subject=Lohndokumente%20auf%20Papier%20-%20Anfrage&body=Hallo,%0A%0Aich%20m%C3%B6chte%20meine%20Lohndokumente%20stattdessen%20in%20Papierform%20erhalten.%0A%0ADanke."
            className="kasten kasten-muted w-full justify-center"
          >
            <Mail className="h-3.5 w-3.5" /> Stattdessen Papier anfordern
          </a>
        </div>
      </div>
    </Modal>
  );
}
