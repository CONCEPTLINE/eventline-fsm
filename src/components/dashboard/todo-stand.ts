// Stand der Todos auf dem Dashboard («Meine Todos»). Abhaken setzt den
// Status einer gelieferten Todo lokal auf «erledigt» (wie toggleTodo auf
// /todos), Rueckgaengig wieder auf «offen». Die Eintraege bleiben dabei in
// der Liste stehen — Rueckgaengig bringt die Todo an ihren alten Platz
// zurueck —, die Karte zeigt nur die offenen (plus die gerade
// ausblendenden). Die Zaehler sind die des Servers minus die lokal
// erledigten. Reine Funktionen: genutzt von Seite, Session-Cache, Karte
// und Kopf-Satz.

import { todayLocalIso } from "@/lib/swiss-time";
import type { DashboardDaten, TodoEintrag, TodosDaten } from "@/components/dashboard/typen";

export type TodoStatus = TodoEintrag["status"];

/** Liefern die Daten diese Todo (egal mit welchem Status)? */
export function enthaeltTodo(d: DashboardDaten | null, id: string): boolean {
  return d?.todos?.eintraege.some((e) => e.id === id) ?? false;
}

/** Daten mit neuem Status einer gelieferten Todo. Fehlt sie oder hat sie
 *  den Status schon: dasselbe Objekt (React rendert dann nicht neu). */
export function mitTodoStatus(d: DashboardDaten, id: string, status: TodoStatus): DashboardDaten {
  const t = d.todos;
  if (!t || !t.eintraege.some((e) => e.id === id && e.status !== status)) return d;
  return { ...d, todos: { ...t, eintraege: t.eintraege.map((e) => (e.id === id ? { ...e, status } : e)) } };
}

/** Zaehler nach lokalem Abhaken: offen gesamt, davon faellig (ueberfaellig
 *  oder heute) und davon ueberfaellig — fuer Karten-Kopf und Kopf-Satz. */
export function todoZahlen(t: TodosDaten): { offen: number; faellig: number; ueberfaellig: number } {
  const heute = todayLocalIso();
  let { offen, faellig, ueberfaellig } = t;
  for (const e of t.eintraege) {
    if (e.status !== "erledigt") continue;
    offen -= 1;
    if (e.due_date !== null && e.due_date <= heute) faellig -= 1;
    if (e.due_date !== null && e.due_date < heute) ueberfaellig -= 1;
  }
  return { offen: Math.max(0, offen), faellig: Math.max(0, faellig), ueberfaellig: Math.max(0, ueberfaellig) };
}
