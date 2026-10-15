// Kleine In-Memory-Nachbildung des Supabase-Query-Builders fuer Tests
// (nur was zz-warteschlange/vorschlaege brauchen): select/update/insert/
// delete, eq/neq/lt/gte/in/is, order/limit/range, single/maybeSingle. `.or()` wird
// ignoriert (Tests legen keine Zeilen an, die es ausschliessen wuerde).
// Unique-Regeln je Tabelle als Funktion (-> Fehler 23505).

type Zeile = Record<string, unknown>;
type Filter = (z: Zeile) => boolean;

export interface FakeDb {
  tabellen: Record<string, Zeile[]>;
  unique?: Record<string, (neu: Zeile, alle: Zeile[]) => boolean>;
  aufrufe: { tabelle: string; op: string }[];
  /** Aufrufe von Datenbank-Funktionen (rpc) mit ihren Argumenten; Antwort je Name aus `rpcAntwort`. */
  rpc?: { name: string; args: Record<string, unknown> }[];
  rpcAntwort?: Record<string, unknown>;
}

let zaehler = 0;

export function fakeAdmin(db: FakeDb) {
  return {
    from(tabelle: string) {
      return new Abfrage(db, tabelle);
    },
    rpc(name: string, args: Record<string, unknown>) {
      db.aufrufe.push({ tabelle: `rpc:${name}`, op: "rpc" });
      (db.rpc ??= []).push({ name, args: JSON.parse(JSON.stringify(args)) as Record<string, unknown> });
      return Promise.resolve({ data: db.rpcAntwort?.[name] ?? null, error: null });
    },
  };
}

class Abfrage implements PromiseLike<{ data: unknown; error: { code?: string; message: string } | null; count?: number }> {
  private op: "select" | "update" | "insert" | "delete" = "select";
  private payload: Zeile | Zeile[] | null = null;
  private filter: Filter[] = [];
  private sortierung: { spalte: string; auf: boolean }[] = [];
  private grenze: number | null = null;
  private einzeln: "single" | "maybe" | null = null;

  constructor(private db: FakeDb, private tabelle: string) {}

  select(spalten?: string) {
    void spalten;
    return this;
  }
  update(x: Zeile) {
    this.op = "update";
    this.payload = x;
    return this;
  }
  insert(x: Zeile | Zeile[]) {
    this.op = "insert";
    this.payload = x;
    return this;
  }
  delete() {
    this.op = "delete";
    return this;
  }
  is(s: string, w: unknown) {
    this.filter.push((z) => (z[s] ?? null) === w);
    return this;
  }
  eq(s: string, w: unknown) {
    this.filter.push((z) => z[s] === w);
    return this;
  }
  neq(s: string, w: unknown) {
    this.filter.push((z) => z[s] !== w);
    return this;
  }
  lt(s: string, w: unknown) {
    this.filter.push((z) => (z[s] as string | number) < (w as string | number));
    return this;
  }
  gte(s: string, w: unknown) {
    this.filter.push((z) => (z[s] as string | number) >= (w as string | number));
    return this;
  }
  in(s: string, w: unknown[]) {
    this.filter.push((z) => w.includes(z[s]));
    return this;
  }
  or() {
    return this;
  }
  order(spalte: string, o?: { ascending?: boolean }) {
    this.sortierung.push({ spalte, auf: o?.ascending !== false });
    return this;
  }
  limit(n: number) {
    this.grenze = n;
    return this;
  }
  range(von: number, bis: number) {
    this.grenze = bis - von + 1;
    return this;
  }
  single() {
    this.einzeln = "single";
    return this;
  }
  maybeSingle() {
    this.einzeln = "maybe";
    return this;
  }

  private ausfuehren(): { data: unknown; error: { code?: string; message: string } | null } {
    this.db.aufrufe.push({ tabelle: this.tabelle, op: this.op });
    const t = (this.db.tabellen[this.tabelle] ??= []);
    const passt = (z: Zeile) => this.filter.every((f) => f(z));
    let daten: Zeile[];
    if (this.op === "insert") {
      const neu = (Array.isArray(this.payload) ? this.payload : [this.payload!]).map((z) => ({ id: `id-${++zaehler}`, ...z }));
      const regel = this.db.unique?.[this.tabelle];
      for (const z of neu) if (regel && regel(z, t)) return { data: null, error: { code: "23505", message: "duplicate key" } };
      t.push(...neu);
      daten = neu;
    } else if (this.op === "delete") {
      daten = t.filter(passt);
      this.db.tabellen[this.tabelle] = t.filter((z) => !passt(z));
    } else if (this.op === "update") {
      daten = t.filter(passt);
      for (const z of daten) Object.assign(z, this.payload);
    } else {
      daten = t.filter(passt);
      for (const { spalte, auf } of [...this.sortierung].reverse()) {
        daten = [...daten].sort((a, b) => (String(a[spalte]) < String(b[spalte]) ? -1 : String(a[spalte]) > String(b[spalte]) ? 1 : 0) * (auf ? 1 : -1));
      }
      if (this.grenze !== null) daten = daten.slice(0, this.grenze);
    }
    const kopie = daten.map((z) => ({ ...z }));
    if (this.einzeln) return { data: kopie[0] ?? null, error: null };
    return { data: kopie, error: null };
  }

  then<A, B>(ok?: ((v: { data: unknown; error: { code?: string; message: string } | null }) => A | PromiseLike<A>) | null, nein?: ((e: unknown) => B | PromiseLike<B>) | null) {
    return Promise.resolve(this.ausfuehren()).then(ok, nein);
  }
}
