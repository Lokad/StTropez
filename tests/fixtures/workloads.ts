/** Generic, deterministic UTF-16 corpora shared by browser and headless measurements. */
export const workloadSeed = 0x51_7a_02;
export const sourceLine = "const sample = 1234567;\n";
export const corpusIds = ["normal", "lines-100", "lines-10000", "single-line", "unicode"] as const;
export type CorpusId = typeof corpusIds[number];
export const workspaceWorkload = Object.freeze({ resources: [1, 10, 100], activeViews: [1, 2],
    annotations: 1_000, backgroundUpdatesPerSecond: 20 });

export function corpus(id: CorpusId): string {
    switch (id) {
        case "normal": return "// Synthetic source\nconst rows = [12, 18, 24];\nconst total = rows.reduce((sum, row) => sum + row, 0);\n";
        case "lines-100": return sourceLine.repeat(100);
        case "lines-10000": return sourceLine.repeat(10_000);
        case "single-line": return "x".repeat(500_000);
        case "unicode": return "\tconst café = 'e\u0301 😀 👩‍💻';\r\n// élève · élision\nconst région = 'Québec';\n".repeat(100);
    }
}

/** 14,413 lines of nested source. The space-indented form is exactly 512,000 UTF-8 bytes. */
export function commandCorpus(tabs: boolean, reserveBytes: number): string {
    const sections: string[][] = [];
    let bytes = 0;
    for (let index = 0; index < 1_201; index++) {
        const section = [
            `// Source record ${index}: `,
            `function evaluate${index}(records) {`,
            "  let total = 0;",
            "  for (const record of records) {",
            "    if (record.enabled) {",
            "      total += record.quantity;",
            "    }",
            "    if (record.adjustment) {",
            "      total += record.adjustment;",
            "    }",
            "  }",
            "  return total; }",
        ];
        bytes += section.join("\n").length + 1;
        sections.push(section);
    }
    // Vary the comment lengths within one byte while keeping the same rows and nesting in both forms.
    const padding = 512_000 - bytes - reserveBytes;
    const note = "include enabled quantities and adjustments in the running total. ";
    const lines: string[] = [];
    for (const [index, section] of sections.entries()) {
        const count = Math.floor(padding / sections.length) + Number(index < padding % sections.length);
        section[0] += note.repeat(Math.ceil(count / note.length)).slice(0, count);
        lines.push(...section);
    }
    const spaces = lines.join("\n") + "\n";
    return tabs ? spaces.replace(/^(?:  )+/gm, value => "\t".repeat(value.length / 2)) : spaces;
}

/** Advance the deterministic 32-bit state; callers own seeds and range mappings. */
export function nextSeed(seed: number): number {
    return (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
}

/** Seeded replay; offsets intentionally use UTF-16, including positions within a surrogate pair. */
export function editLog(length: number, count: number, seed = workloadSeed) {
    let state = seed >>> 0;
    const next = () => { state = nextSeed(state); return state; };
    const edits: { from: number; to: number; insert: string }[] = [];
    for (let index = 0; index < count; index++) {
        const from = next() % (length + 1);
        const to = Math.min(length, from + next() % 4);
        const insert = ["x", "😀", "e\u0301", "\r\n", "", "\t"][next() % 6]!;
        edits.push({ from, to, insert });
        length += insert.length - (to - from);
    }
    return edits;
}
