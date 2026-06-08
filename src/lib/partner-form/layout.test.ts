import { describe, it, expect } from "vitest";
import { groupBlocksIntoRows, widthOf, colSpanClass } from "./layout";
import type { FormBlock } from "./types";

function block(id: string, width?: FormBlock["width"]): FormBlock {
  return { id, type: "text", label: id, width } as FormBlock;
}

describe("partner-form/layout", () => {
  it("widthOf default = full", () => {
    expect(widthOf(block("a"))).toBe("full");
    expect(widthOf(block("b", "1/2"))).toBe("1/2");
  });

  it("colSpanClass static (Tailwind-purgable)", () => {
    expect(colSpanClass(block("a", "1/4"))).toBe("col-span-3");
    expect(colSpanClass(block("a", "1/3"))).toBe("col-span-4");
    expect(colSpanClass(block("a", "1/2"))).toBe("col-span-6");
    expect(colSpanClass(block("a", "2/3"))).toBe("col-span-8");
    expect(colSpanClass(block("a", "3/4"))).toBe("col-span-9");
    expect(colSpanClass(block("a", "full"))).toBe("col-span-12");
    expect(colSpanClass(block("a"))).toBe("col-span-12");
  });

  it("groupBlocksIntoRows: drei Blocks zu je 1/3 in einer Zeile", () => {
    const blocks = [block("a", "1/3"), block("b", "1/3"), block("c", "1/3")];
    const rows = groupBlocksIntoRows(blocks);
    expect(rows.length).toBe(1);
    expect(rows[0].blocks.length).toBe(3);
  });

  it("groupBlocksIntoRows: 1/2 + 1/2 fit, 1/2 + 2/3 nicht", () => {
    const rows = groupBlocksIntoRows([block("a", "1/2"), block("b", "1/2")]);
    expect(rows.length).toBe(1);

    const rows2 = groupBlocksIntoRows([block("a", "1/2"), block("b", "2/3")]);
    expect(rows2.length).toBe(2);
  });

  it("groupBlocksIntoRows: leere Liste", () => {
    expect(groupBlocksIntoRows([])).toEqual([]);
  });

  it("groupBlocksIntoRows: startIndex korrekt fuer mehrere Zeilen", () => {
    const blocks = [block("a"), block("b", "1/2"), block("c", "1/2"), block("d")];
    const rows = groupBlocksIntoRows(blocks);
    expect(rows.length).toBe(3);
    expect(rows[0].startIndex).toBe(0); // d=full
    expect(rows[1].startIndex).toBe(1); // b+c
    expect(rows[2].startIndex).toBe(3);
  });

  it("3/4 + 1/4 = 1 → eine Zeile", () => {
    const rows = groupBlocksIntoRows([block("a", "3/4"), block("b", "1/4")]);
    expect(rows.length).toBe(1);
    expect(rows[0].blocks.length).toBe(2);
  });
});
