// Kleine In-Memory-Nachbildung des Supabase-Query-Builders fuer Tests der KI-Abholung (api/ki/sync):
// select/update/upsert, eq/lt/gte/in, order/limit, maybeSingle. upsert: Konflikt ueber `id` — vorhandene Zeile wird
// ergaenzt. Sortiert wird als Text (Tests vergleichen nur ISO-Zeiten und gleiche Prioritaeten).

type Zeile = Record<string, unknown>;
type Filter = (z: Zeile) => boolean;

export interface FakeDb {
  tabellen: Record<string, Zeile[]>;
  aufrufe: { tabelle: string; op: string }[];
}

export function fakeAdmin(db: FakeDb) {
  return {
    from(tabelle: string) {
      return new Abfrage(db, tabelle);
    },
  };
}

class Abfrage implements PromiseLike<{ data: unknown; error: { code?: string; message: string } | null }> {
  private op: "select" | "update" | "upsert" = "select";
  private payload: Zeile | Zeile[] | null = null;
  private filter: Filter[] = [];
  private sortierung: { spalte: string; auf: boolean }[] = [];
  private grenze: number | null = null;
  private einzeln = false;

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
  upsert(x: Zeile | Zeile[]) {
    this.op = "upsert";
    this.payload = x;
    return this;
  }
  eq(s: string, w: unknown) {
    this.filter.push((z) => z[s] === w);
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
  in(s: string, w: readonly unknown[]) {
    this.filter.push((z) => w.includes(z[s]));
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
  maybeSingle() {
    this.einzeln = true;
    return this;
  }

  private ausfuehren(): { data: unknown; error: { code?: string; message: string } | null } {
    this.db.aufrufe.push({ tabelle: this.tabelle, op: this.op });
    const t = (this.db.tabellen[this.tabelle] ??= []);
    const passt = (z: Zeile) => this.filter.every((f) => f(z));
    let daten: Zeile[];
    if (this.op === "upsert") {
      daten = [];
      for (const z of Array.isArray(this.payload) ? this.payload : [this.payload!]) {
        const da = t.find((alt) => alt.id === z.id);
        if (da) Object.assign(da, z);
        else t.push({ ...z });
        daten.push(da ?? z);
      }
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
