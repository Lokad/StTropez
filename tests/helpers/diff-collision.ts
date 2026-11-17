import assert from "node:assert/strict";
import { TextBuffer } from "../../src/core/text-buffer.ts";
import { getLine, indexLines } from "../../src/core/diff-index.ts";
import type { DiffStats } from "../../src/core/diff-index.ts";
import { lineHash } from "../../src/core/diff-identities.ts";

/** Validate the fixture against the actual eager/lazy hash owners before exercising exact diff. */
export function collidingDiffLines(kind: "short" | "long" = "short"): readonly [string, string] {
    const suffix = kind === "short" ? "\n" : "x".repeat(400) + "\n";
    const lines = Object.freeze(["F\"]:`#\"/Q" + suffix, "S/:hvp6FJ" + suffix] as const);
    assert.notEqual(lines[0], lines[1]); assert.equal(lines[0].length, lines[1].length);
    const complete = <T>(cursor: Generator<void, T>): T => {
        let result = cursor.next(); while (!result.done) result = cursor.next(); return result.value;
    };
    const hashes = lines.map(text => {
        const stats: DiffStats = { work: 0, yielded: 0, readUnits: 0, lineComparisons: 0, lineEdits: 0 };
        const index = complete(indexLines(TextBuffer.from(text), stats)), line = complete(getLine(index, 0, stats));
        assert.equal(line.hash === undefined, kind === "long", "Collision fixture must exercise its intended hash owner.");
        return complete(lineHash(index, 0, line, stats));
    });
    assert.equal(hashes[0], hashes[1], "Synthetic rows must still collide under the current comparison hash.");
    return lines;
}
