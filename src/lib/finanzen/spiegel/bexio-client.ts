// Bexio-Lesezugriffe des Finanz-Spiegels: JSON-Hülle, Paginierung,
// Zeitbudget. Alle Entitäten gehen über diese Datei — nie direkt über
// bexioFetch. Fehlertexte enthalten NIE den Response-Body (kann Beträge/
// Namen enthalten), nur Status + Pfad ohne Query.

import { bexioFinanzFetch, BexioFristFehler } from "@/lib/bexio";
import type { SyncKontext } from "./index";

/** Bexio antwortete mit einem Fehlerstatus. message = "Bexio HTTP <status> <pfad>". */
export class BexioAntwortFehler extends Error {
  status: number;
  pfad: string;
  constructor(status: number, pfad: string) {
    super(`Bexio HTTP ${status} ${pfad}`);
    this.name = "BexioAntwortFehler";
    this.status = status;
    this.pfad = pfad;
  }
}

/** Zeitbudget des Laufs (SYNC_ZEITBUDGET_MS) erschöpft — Entität bricht
 *  sauber als 'teilweise' ab, nie Lambda-Kill. */
export class ZeitbudgetFehler extends Error {
  constructor() {
    super("Zeitbudget erschöpft");
    this.name = "ZeitbudgetFehler";
  }
}

/** Vor JEDEM Bexio-Call: Date.now() >= ctx.frist → ZeitbudgetFehler. */
export function pruefeFrist(ctx: SyncKontext): void {
  if (Date.now() >= ctx.frist) throw new ZeitbudgetFehler();
}

export const PAUSE_MS = 150;

export function pause(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function pfadOhneQuery(pfad: string): string {
  const i = pfad.indexOf("?");
  return i < 0 ? pfad : pfad.slice(0, i);
}

/** GET/POST → JSON. !ok → BexioAntwortFehler (ohne Body). Die Frist des
 *  Laufs (ctx.frist) geht an bexioFinanzFetch: kein Call, kein Token-
 *  Refresh und keine 429-/Backoff-Wartezeit laeuft darueber hinaus —
 *  stattdessen ZeitbudgetFehler (Entitaet endet sauber als 'teilweise'). */
export async function bexioJson<T>(ctx: SyncKontext, pfad: string, init?: RequestInit): Promise<T> {
  pruefeFrist(ctx);
  let res: Response;
  try {
    res = await bexioFinanzFetch(pfad, init, ctx.frist);
  } catch (e) {
    if (e instanceof BexioFristFehler) throw new ZeitbudgetFehler();
    throw e;
  }
  if (!res.ok) throw new BexioAntwortFehler(res.status, pfadOhneQuery(pfad));
  return (await res.json()) as T;
}

/** Schutz gegen Endlosschleifen bei unerwarteter Paginierung. */
const MAX_SEITEN = 200;

/** Bexio 2.0/3.0: nacktes Array, `limit` + `offset`; Ende sobald eine Seite
 *  weniger als `limit` Zeilen liefert. Vor jeder Seite pruefeFrist(ctx). */
export async function alleSeiten2<T>(
  ctx: SyncKontext,
  pfad: (limit: number, offset: number) => string,
  init?: RequestInit,
  limit = 500,
): Promise<T[]> {
  const alle: T[] = [];
  for (let seite = 0; seite < MAX_SEITEN; seite++) {
    pruefeFrist(ctx);
    const teil = await bexioJson<unknown>(ctx, pfad(limit, seite * limit), init);
    const zeilen = Array.isArray(teil) ? (teil as T[]) : [];
    alle.push(...zeilen);
    if (zeilen.length < limit) break;
  }
  return alle;
}

interface Huelle4<T> {
  data?: T[] | T | null;
  paging?: { page?: number; page_size?: number; page_count?: number; item_count?: number } | null;
}

/** Bexio 4.0: Hülle {data, paging}, `page` ab 1 + `limit`; Ende bei
 *  page >= page_count (oder Seite kürzer als limit). `data` kann laut Spec
 *  auch ein einzelnes Objekt sein. Vor jeder Seite pruefeFrist(ctx). */
export async function alleSeiten4<T>(
  ctx: SyncKontext,
  pfad: (page: number, limit: number) => string,
  limit = 500,
): Promise<T[]> {
  const alle: T[] = [];
  for (let page = 1; page <= MAX_SEITEN; page++) {
    pruefeFrist(ctx);
    const teil = await bexioJson<Huelle4<T>>(ctx, pfad(page, limit));
    const zeilen = datenAlsListe(teil?.data);
    alle.push(...zeilen);
    const pageCount = Number(teil?.paging?.page_count ?? NaN);
    if (Number.isFinite(pageCount) ? page >= pageCount : zeilen.length < limit) break;
  }
  return alle;
}

/** 4.0-`data` normalisieren: Array → Array, Objekt → [Objekt], leer → []. */
export function datenAlsListe<T>(data: T[] | T | null | undefined): T[] {
  if (Array.isArray(data)) return data;
  return data ? [data] : [];
}

/** 403/404 auf einem Listen-Endpunkt = Entität für diesen Mandanten nicht
 *  verfügbar (Scope/Modul/Endpunkt) → sync_stand.verfuegbar = false. */
export function istNichtVerfuegbar(e: unknown): boolean {
  return e instanceof BexioAntwortFehler && (e.status === 403 || e.status === 404);
}

/** 404 auf einem Einzel-GET = Objekt in Bexio gelöscht (Verwaisten-Prüfung). */
export function istNichtGefunden(e: unknown): boolean {
  return e instanceof BexioAntwortFehler && e.status === 404;
}
