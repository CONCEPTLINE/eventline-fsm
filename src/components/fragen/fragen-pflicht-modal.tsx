"use client";

// «Fragen an dich» — Pflicht-Modal app-weit (im (app)-Layout). Erscheint nach
// dem Login, solange eine für mich geltende Frage keine Antwort zur aktuellen
// Textfassung hat; nicht schliessbar. Nie in «Ansicht als» (der Server liefert
// dort keine Fragen). Danach geht es normal weiter. Ändern jederzeit unter
// «Mein Konto › Meine Antworten».

import { useEffect } from "react";
import { MessageCircleQuestion } from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { FrageFormular } from "./frage-formular";
import { ladeFragen, useFragen, vergissFragen } from "@/lib/fragen/use-fragen";

export function FragenPflichtModal({ profileId }: { profileId: string | null }) {
  const s = useFragen();

  // Je Konto einmal laden (Kontowechsel im selben Tab: alten Stand vergessen).
  useEffect(() => {
    if (!profileId) return;
    vergissFragen();
    void ladeFragen();
  }, [profileId]);

  const offen = s.status === "bereit" && !s.ansichtAls
    ? s.fragen.filter((f) => s.offen.includes(f.schluessel))
    : [];
  const frage = offen[0] ?? null;

  return (
    <Modal
      open={!!frage}
      onClose={() => {}}
      closable={false}
      title={frage ? frage.titel : "Fragen an dich"}
      icon={<MessageCircleQuestion className="h-5 w-5 text-red-500" />}
      size="md"
      sheet
    >
      {frage && (
        <div className="space-y-3">
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
            Frage an dich{offen.length > 1 ? ` · noch ${offen.length}` : ""}
          </p>
          {/* key: nach dem Speichern frisches Formular für die nächste Frage */}
          <FrageFormular key={`${frage.schluessel}|${frage.version}`} frage={frage} />
        </div>
      )}
    </Modal>
  );
}
