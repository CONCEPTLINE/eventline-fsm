/**
 * GET /api/finanzen/sync-status — Bexio-Verbindung (Scopes), laufender/
 * letzter Abgleich und Stand je Entitaet fuer den SyncKopf der Seite.
 * Guard requireFinanzen, Protokoll FAIL-CLOSED. Antwort ohne Betraege
 * (sync_laeufe.ergebnis enthaelt nur Zaehlungen/Kurztexte).
 */
import { requireFinanzen, finanzenJson, protokollFehler } from "@/lib/finanzen/auth";
import { protokolliereZugriff } from "@/lib/finanzen/zugriffe";
import { finanzenDb } from "@/lib/finanzen/db";
import { laufendenSyncFinden, letztenSyncLaden, syncStandLaden } from "@/lib/finanzen/spiegel";
import { ZUGRIFF_AKTION, type SyncStatusAntwort } from "@/lib/finanzen/types";
import { getConnection, hasFinanzScopes, fehlendeFinanzScopes } from "@/lib/bexio";
import { logError } from "@/lib/log";

export const dynamic = "force-dynamic";

export async function GET() {
  const auth = await requireFinanzen();
  if (auth.error) return auth.error;

  // FAIL-CLOSED: ohne Protokollzeile keine Finanzdaten.
  if (!(await protokolliereZugriff({
    actorProfileId: auth.user.id,
    bereich: "finanzen",
    aktion: ZUGRIFF_AKTION.FINANZEN_SYNC_STATUS,
    geraetHash: auth.geraetHash,
  }))) return protokollFehler();

  try {
    const db = finanzenDb();
    const [conn, laufend, letzter, stand] = await Promise.all([
      getConnection(),
      laufendenSyncFinden(db),
      letztenSyncLaden(db),
      syncStandLaden(db),
    ]);
    const verbunden = !!conn;
    const antwort: SyncStatusAntwort = {
      success: true,
      verbunden,
      scopesOk: verbunden && hasFinanzScopes(conn),
      scopesFehlend: verbunden ? fehlendeFinanzScopes(conn) : [],
      laeuft: !!laufend,
      letzterLauf: laufend ?? letzter,
      stand,
    };
    return finanzenJson(antwort);
  } catch (err) {
    // Nie den Fehler serialisieren (koennte Bexio-/Postgres-Texte tragen).
    logError("api.finanzen.sync-status", err instanceof Error ? new Error(err.name) : new Error("unbekannt"));
    return finanzenJson({ success: false, error: "Abgleich-Status konnte nicht geladen werden" }, { status: 500 });
  }
}
