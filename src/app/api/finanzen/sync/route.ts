// POST /api/finanzen/sync { voll?: boolean }
//
// Manueller Bexio-Abgleich von der Seite /finanzen (Knopf «Jetzt
// abgleichen»). Guard requireFinanzen (Admin + vertrautes Gerät + Step-up,
// keine Impersonation). Fail-closed-Protokoll: ohne Zeile in
// finanzen.zugriffe läuft kein Abgleich (503 protokoll_nicht_verfuegbar).
//
// `voll: true` ignoriert alle Wasserzeichen — Neuaufbau nach
// scripts/finanzen-neuaufbau.sql. Doppelstart → 409 sync_laeuft (DB-
// garantiert über den Unique-Index). Antworten ohne Bexio-Texte/Beträge.

import { getConnection, hasFinanzScopes } from "@/lib/bexio";
import { finanzenFehler, finanzenJson, protokollFehler, requireFinanzen } from "@/lib/finanzen/auth";
import { finanzenSyncAusfuehren, SyncLaeuftFehler } from "@/lib/finanzen/spiegel";
import { FINANZEN_FEHLER, ZUGRIFF_AKTION, type SyncStartAntwort, type SyncStartBody } from "@/lib/finanzen/types";
import { protokolliereZugriff } from "@/lib/finanzen/zugriffe";
import { logError } from "@/lib/log";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const auth = await requireFinanzen();
  if (auth.error) return auth.error;

  let body: SyncStartBody | null = null;
  try {
    body = (await request.json()) as SyncStartBody;
  } catch {
    body = null;
  }
  const voll = body?.voll === true;

  const protokolliert = await protokolliereZugriff({
    actorProfileId: auth.user.id,
    bereich: "finanzen",
    aktion: ZUGRIFF_AKTION.FINANZEN_SYNC_MANUELL,
    geraetHash: auth.geraetHash,
    details: { art: "manuell", voll },
  });
  if (!protokolliert) return protokollFehler();

  const conn = await getConnection();
  if (!conn) return finanzenFehler(FINANZEN_FEHLER.BEXIO_NICHT_VERBUNDEN, 409, "Bexio ist nicht verbunden.");
  if (!hasFinanzScopes(conn)) {
    return finanzenFehler(FINANZEN_FEHLER.BEXIO_SCOPE, 409, "Bexio muss mit den Finanz-Freigaben neu verbunden werden.");
  }

  try {
    const { lauf } = await finanzenSyncAusfuehren({ art: "manuell", ausgeloestVon: auth.user.id, voll });
    const antwort: SyncStartAntwort = { success: true, lauf };
    return finanzenJson(antwort);
  } catch (e) {
    if (e instanceof SyncLaeuftFehler) {
      return finanzenFehler(FINANZEN_FEHLER.SYNC_LAEUFT, 409, "Ein Abgleich läuft bereits.");
    }
    logError("api.finanzen.sync", e);
    return finanzenFehler("sync_fehlgeschlagen", 502, "Abgleich fehlgeschlagen — Details im Lauf-Protokoll.");
  }
}
