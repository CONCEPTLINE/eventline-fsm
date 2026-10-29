"use client";

/**
 * Antworten eines Kampagnen-Kontakts im Detail — live aus Leos Postfach
 * (/api/vertrieb/antworten), nie in der DB gespeichert. Neueste zuerst,
 * Text wie im Mail-Programm (Absätze, ohne zitierte eigene Mail).
 */

import { useEffect, useState } from "react";
import { MessageSquareReply } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { datumLang } from "@/lib/vertrieb/kampagnen";
import type { KampagneAntwort } from "@/types/vertrieb";

interface Props {
  kontaktId: string;
  anzahl: number;
  /** Postfach für den Hinweis, falls das Laden scheitert. */
  postfach: string | null;
}

export function KampagneAntworten({ kontaktId, anzahl, postfach }: Props) {
  const [antworten, setAntworten] = useState<KampagneAntwort[] | null>(null);
  const [fehler, setFehler] = useState<string | null>(null);

  useEffect(() => {
    let aktiv = true;
    fetch(`/api/vertrieb/antworten?id=${encodeURIComponent(kontaktId)}`, { cache: "no-store" })
      .then(async (r) => {
        const j = await r.json().catch(() => null);
        if (!aktiv) return;
        if (!j?.ok) { setFehler(j?.fehler ?? j?.error ?? "Antworten konnten nicht geladen werden"); return; }
        setAntworten(j.antworten as KampagneAntwort[]);
      })
      .catch(() => { if (aktiv) setFehler("Antworten konnten nicht geladen werden"); });
    return () => { aktiv = false; };
  }, [kontaktId]);

  const kopf = (
    <p className="mb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-green-700 dark:text-green-300">
      <MessageSquareReply className="h-3.5 w-3.5" />
      {anzahl === 1 ? "Antwort" : `${anzahl} Antworten`}
    </p>
  );

  if (fehler) {
    return (
      <section>
        {kopf}
        <div className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-800 dark:border-red-500/40 dark:bg-red-500/10 dark:text-red-200">
          {fehler}. Antwort im Postfach {postfach ?? "leo@"} ansehen.
        </div>
      </section>
    );
  }

  if (!antworten) {
    return (
      <section>
        {kopf}
        <div className="space-y-2 rounded-lg border border-green-300 p-3 dark:border-green-500/40">
          <Skeleton className="h-3.5 w-1/2" />
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-5/6" />
          <Skeleton className="h-3 w-2/3" />
        </div>
      </section>
    );
  }

  if (antworten.length === 0) {
    return (
      <section>
        {kopf}
        <p className="text-xs text-muted-foreground">Im Posteingang nicht (mehr) gefunden — evtl. verschoben. Im Postfach {postfach ?? "leo@"} nachsehen.</p>
      </section>
    );
  }

  return (
    <section className="space-y-2">
      {kopf}
      {antworten.map((a) => (
        <article key={a.id} className="overflow-hidden rounded-lg border border-green-300 dark:border-green-500/40">
          <div className="border-b border-green-200 bg-green-50 px-3 py-2 text-xs dark:border-green-500/30 dark:bg-green-500/10">
            <div className="flex items-baseline justify-between gap-3">
              <span className="truncate font-medium">{a.vonName ? `${a.vonName} <${a.von}>` : a.von}</span>
              <span className="shrink-0 text-muted-foreground">{datumLang(a.empfangenAm)}</span>
            </div>
            <p className="mt-0.5 truncate font-semibold">{a.betreff || "(ohne Betreff)"}</p>
          </div>
          <div className="max-h-[40vh] overflow-y-auto whitespace-pre-wrap px-4 py-3 text-sm leading-relaxed">
            {a.text || <span className="text-muted-foreground">Kein Text.</span>}
          </div>
        </article>
      ))}
    </section>
  );
}
