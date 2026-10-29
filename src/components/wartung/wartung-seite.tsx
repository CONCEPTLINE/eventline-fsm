/**
 * Wartungsmodus für eine ganze Seite — im layout.tsx der Route (Server).
 *
 *   <WartungSeite bereich="lohn" fallback={<Loading />}>{children}</WartungSeite>
 *
 * - bereich gesetzt: gesperrt → Hinweisseite statt der Seite (die Seite wird
 *   nicht gerendert, lädt also auch nichts); Ausnahme → Balken «Wartung aktiv»
 *   über der Seite.
 * - ohne bereich: nur der Kontext für Tabs/Karten der Seite
 *   (WartungBereichSchranke, z. B. Einstellungen).
 *
 * Läuft bei jeder Anfrage (connection(): nie zur Build-Zeit festgeschrieben).
 * Die Prüfung steht in einer eigenen Suspense-Grenze, damit beim Navigieren
 * sofort das Skelett der Seite erscheint (Doku layout.md «Interaction with
 * loading.js»). Ohne Wartung kostet sie nur einen gecachten Lesezugriff.
 */

import { Suspense, type ReactNode } from "react";
import { connection } from "next/server";
import { wartungFuerAnfrage } from "@/lib/wartung-server";
import type { WartungBereich } from "@/lib/wartung";
import { WartungBalken, WartungHinweis } from "./wartung-hinweis";
import { WartungKontext } from "./wartung-kontext";

export function WartungSeite({
  bereich,
  fallback,
  children,
}: {
  bereich?: WartungBereich;
  fallback: ReactNode;
  children: ReactNode;
}) {
  return (
    <Suspense fallback={fallback}>
      <WartungPruefung bereich={bereich}>{children}</WartungPruefung>
    </Suspense>
  );
}

async function WartungPruefung({ bereich, children }: { bereich?: WartungBereich; children: ReactNode }) {
  await connection();
  const wert = await wartungFuerAnfrage();
  const zugang = bereich ? wert.zugang[bereich] : "frei";
  if (bereich && zugang === "gesperrt") return <WartungHinweis bereich={bereich} />;
  return (
    <WartungKontext wert={wert}>
      {bereich && zugang === "ausnahme" && <WartungBalken bereich={bereich} grund={wert.grund} />}
      {children}
    </WartungKontext>
  );
}
