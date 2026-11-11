// Rundung von Beträgen (Trust-flow-Schnittstelle, /api/flow/vergleich).

/** Summe ohne Gleitkomma-Rauschen (auf Rappen). */
export function summeChf(werte: number[]): number {
  const v = Number(werte.reduce((a, b) => a + b, 0).toFixed(2));
  return v === 0 ? 0 : v;
}
