/** Generic, deterministic UTF-16 corpora shared by browser and headless measurements. */
export const workloadSeed = 0x51_7a_02;
export const sourceLine = "const sample = 1234567;\n";
export const corpusIds = ["normal", "lines-100", "lines-10000", "lines-100000", "single-line", "unicode"] as const;
export type CorpusId = typeof corpusIds[number];
export const workspaceWorkload = Object.freeze({ resources: [1, 10, 100], activeViews: [1, 2],
    annotations: 1_000, backgroundUpdatesPerSecond: 20 });

export function corpus(id: CorpusId): string {
    switch (id) {
        case "normal": return "// Synthetic source\nconst rows = [12, 18, 24];\nconst total = rows.reduce((sum, row) => sum + row, 0);\n";
        case "lines-100": return sourceLine.repeat(100);
        case "lines-10000": return sourceLine.repeat(10_000);
        case "lines-100000": return sourceLine.repeat(100_000);
        case "single-line": return "x".repeat(2_400_000);
        case "unicode": return "\tconst café = 'e\u0301 😀 👩‍💻';\r\n// العربية עברית\nconst 漢字 = '日本語';\n".repeat(100);
    }
}

/** Seeded replay; offsets intentionally use UTF-16, including positions within a surrogate pair. */
export function editLog(length: number, count: number, seed = workloadSeed) {
    let state = seed >>> 0;
    const next = () => { state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0; return state; };
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
