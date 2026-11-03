"use client";

// «Mein Konto › Meine Antworten» — jede Frage aus «Fragen an dich» mit der
// aktuellen Antwort; «Ändern» speichert einen neuen Eintrag im Verlauf.

import { useEffect, useState } from "react";
import { MessageCircleQuestion, Pencil } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Loading } from "@/components/ui/spinner";
import { FrageFormular } from "./frage-formular";
import { ladeFragen, useFragen } from "@/lib/fragen/use-fragen";
import type { Frage } from "@/lib/fragen/katalog";
import { formatDateFull } from "@/lib/format";


export function MeineAntworten() {
  const s = useFragen();
  useEffect(() => { void ladeFragen(); }, []);

  if (s.status === "leer" || s.status === "laedt") return <Loading />;
  if (s.ansichtAls) {
    return <EmptyState icon={MessageCircleQuestion} title="Nicht in «Ansicht als»" description="Antworten sieht und gibt nur die Person selbst." />;
  }
  if (s.status === "fehler") {
    return <EmptyState icon={MessageCircleQuestion} title="Konnte nicht geladen werden" description="Bitte die Seite neu laden." />;
  }
  if (s.fragen.length === 0) {
    return <EmptyState icon={MessageCircleQuestion} title="Keine Fragen an dich" description="Sobald es eine Frage an dich gibt, findest du sie hier." />;
  }
  return (
    <div className="space-y-3">
      {s.fragen.map((f) => <FrageKarte key={f.schluessel} frage={f} />)}
    </div>
  );
}

function FrageKarte({ frage }: { frage: Frage }) {
  const s = useFragen();
  const a = s.antworten[frage.schluessel] ?? null;
  const offen = s.offen.includes(frage.schluessel);
  const [bearbeiten, setBearbeiten] = useState(false);
  const label = a ? frage.optionen.find((o) => o.wert === a.antwort)?.label ?? a.antwort : null;

  return (
    <Card className="bg-card">
      <CardContent className="py-4 space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-semibold">{frage.titel}</p>
            {a && !offen ? (
              <p className="text-xs text-muted-foreground mt-0.5">
                Deine Antwort: <span className="font-medium text-foreground">{label}</span> · seit {formatDateFull(a.beantwortet_at)}
                {a.quelle === "verwaltung" ? " (auf deinen Wunsch eingetragen)" : ""}
              </p>
            ) : (
              <p className="text-xs text-amber-700 dark:text-amber-300 mt-0.5">Noch nicht beantwortet</p>
            )}
          </div>
          {a && !offen && !bearbeiten && (
            <button type="button" onClick={() => setBearbeiten(true)} className="kasten kasten-muted shrink-0">
              <Pencil className="h-3.5 w-3.5" /> Ändern
            </button>
          )}
        </div>
        {(offen || bearbeiten) && (
          <FrageFormular
            key={`${frage.version}|${a?.beantwortet_at ?? ""}`}
            frage={frage}
            aktuell={offen ? null : a?.antwort ?? null}
            onGespeichert={() => setBearbeiten(false)}
          />
        )}
        {bearbeiten && (
          <button type="button" onClick={() => setBearbeiten(false)} className="kasten kasten-muted">Abbrechen</button>
        )}
      </CardContent>
    </Card>
  );
}
