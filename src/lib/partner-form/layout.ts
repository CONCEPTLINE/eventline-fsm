/**
 * Row-Grouping fuer Form-Bloecke mit variabler Breite.
 *
 * Bausteine haben eine optionale 'width' (default 'full'). Aufeinander-
 * folgende Bloecke deren Breiten-Summe ≤ 1 sind landen in derselben
 * Zeile (CSS-Grid col-span). Das matched die Darstellung im Builder und
 * im FormRenderer 1:1.
 */

import type { FormBlock, BlockWidth } from "./types";

const WIDTH_FRAC: Record<BlockWidth, number> = {
  "1/4": 0.25,
  "1/3": 1 / 3,
  "1/2": 0.5,
  "2/3": 2 / 3,
  "3/4": 0.75,
  "full": 1,
};

const WIDTH_COLS: Record<BlockWidth, number> = {
  "1/4": 3,
  "1/3": 4,
  "1/2": 6,
  "2/3": 8,
  "3/4": 9,
  "full": 12,
};

export const WIDTH_OPTIONS: BlockWidth[] = ["1/4", "1/3", "1/2", "2/3", "3/4", "full"];

export function widthOf(b: FormBlock): BlockWidth {
  return b.width ?? "full";
}

export function colSpanClass(b: FormBlock): string {
  const cols = WIDTH_COLS[widthOf(b)];
  return COL_SPAN_CLASSES[cols] ?? "col-span-12";
}

// Tailwind kann dynamische col-span-${n} Klassen nicht zuverlaessig
// purgen → statisches Mapping.
const COL_SPAN_CLASSES: Record<number, string> = {
  3: "col-span-3",
  4: "col-span-4",
  6: "col-span-6",
  8: "col-span-8",
  9: "col-span-9",
  12: "col-span-12",
};

export interface BlockRow {
  /** Index des ersten Blocks dieser Zeile im flachen blocks-Array. */
  startIndex: number;
  blocks: FormBlock[];
}

export function groupBlocksIntoRows(blocks: FormBlock[]): BlockRow[] {
  const rows: BlockRow[] = [];
  let current: FormBlock[] = [];
  let used = 0;
  let startIndex = 0;
  blocks.forEach((b, i) => {
    const w = WIDTH_FRAC[widthOf(b)];
    if (current.length > 0 && used + w > 1.0001) {
      rows.push({ startIndex, blocks: current });
      current = [];
      used = 0;
      startIndex = i;
    }
    current.push(b);
    used += w;
  });
  if (current.length > 0) rows.push({ startIndex, blocks: current });
  return rows;
}
