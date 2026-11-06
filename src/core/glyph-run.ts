import type { SfntFont } from "./font-data.ts";
import type { GlyphSourceSpan, SubstitutionInputGlyph } from "./font-substitution.ts";
import { copyGlyphProperties } from "./glyph-properties.ts";
import type { GlyphProperties } from "./glyph-properties.ts";

export type GlyphRunEntry = Readonly<{ glyphId: number; source: GlyphSourceSpan; glyphClass?: number; properties?: GlyphProperties }>;
export type NominalGlyph = Readonly<{ glyphId: number; source: GlyphSourceSpan; glyphClass: number; properties?: GlyphProperties }>;
export type GlyphRunBuildSnapshot = Readonly<{ status: "building" | "ready" | "disposed"; length: number; result: GlyphRun | null }>;
export type GlyphRunBuilder = Readonly<{ append: (entries: readonly GlyphRunEntry[]) => void; finish: () => GlyphRun;
    snapshot: () => GlyphRunBuildSnapshot; dispose: () => void }>;
const owned = new WeakSet<GlyphRun<SubstitutionInputGlyph>>();
export const ownedGlyphRun = (value: unknown): value is GlyphRun<SubstitutionInputGlyph> => typeof value === "object" && value !== null && owned.has(value as GlyphRun<SubstitutionInputGlyph>);
let publish: <T extends SubstitutionInputGlyph>(font: SfntFont, blocks: readonly (readonly T[])[], length: number, offset?: number) => GlyphRun<T>;

/** Owned immutable logical input. Source spans are provenance, not certified Unicode clusters. */
export class GlyphRun<T extends SubstitutionInputGlyph = NominalGlyph> {
    readonly font: SfntFont;
    readonly length: number;
    readonly #blocks: readonly (readonly T[])[];
    readonly #offset: number;
    private constructor(font: SfntFont, blocks: readonly (readonly T[])[], length: number, offset = 0) { this.font = font; this.#blocks = blocks; this.length = length; this.#offset = offset; owned.add(this); Object.freeze(this); }
    at(index: number): T { if (!Number.isSafeInteger(index) || index < 0 || index >= this.length) throw new RangeError("Invalid glyph run index."); const absolute = this.#offset + index; return this.#blocks[Math.floor(absolute / 256)]![absolute % 256]!; }
    /** Constant-work immutable view; retains the backing blocks and original source coordinates. */
    slice(from = 0, to = this.length): GlyphRun<T> { if (![from, to].every(Number.isSafeInteger) || from < 0 || from > to || to > this.length) throw new RangeError("Invalid glyph run range."); return publish(this.font, this.#blocks, to - from, this.#offset + from); }
    static { publish = <P extends SubstitutionInputGlyph>(font: SfntFont, blocks: readonly (readonly P[])[], length: number, offset?: number) => new GlyphRun<P>(font, blocks, length, offset); }
}

/** Internal producers call this only after incremental validation and freezing of every record/block. */
export const glyphRunFromOwnedBlocks = <T extends SubstitutionInputGlyph>(font: SfntFont, blocks: readonly (readonly T[])[], length: number): GlyphRun<T> => publish(font, blocks, length);

/** Each append copies at most 256 fixed-size nominal records before atomically updating state. */
export function createGlyphRunBuilder(font: SfntFont): GlyphRunBuilder {
    const glyphCount = font.metadata.glyphCount; let capturedFont: SfntFont | null = font;
    let blocks: (readonly NominalGlyph[])[] = [], pending: NominalGlyph[] = [], busy = false;
    let state: GlyphRunBuildSnapshot = Object.freeze({ status: "building", length: 0, result: null });
    const writable = () => { if (busy || state.status !== "building") throw new Error("Glyph run builder is unavailable."); };
    return Object.freeze({ snapshot: () => state,
        append: entries => {
            writable(); busy = true;
            try {
                const count = entries.length; if (!Number.isSafeInteger(count) || count < 0 || count > 256) throw new RangeError("Append at most 256 glyphs per step.");
                const copied: NominalGlyph[] = [];
                for (let i = 0; i < count; i++) {
                    const entry = entries[i]; if (!entry) throw new RangeError("Invalid nominal glyph record."); const { glyphId, source } = entry, { from, to } = source, glyphClass = entry.glyphClass ?? 0;
                    if (!Number.isSafeInteger(glyphId) || glyphId < 0 || glyphId >= glyphCount || !Number.isInteger(glyphClass) || glyphClass < 0 || glyphClass > 4 || !Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < from) throw new RangeError("Invalid nominal glyph record.");
                    const properties = copyGlyphProperties(entry.properties);
                    copied.push(Object.freeze({ glyphId, glyphClass, ...(properties ? { properties } : {}), source: Object.freeze({ from, to }) }));
                }
                const merged = [...pending, ...copied]; if (merged.length >= 256) blocks.push(Object.freeze(merged.slice(0, 256)));
                pending = merged.length >= 256 ? merged.slice(256) : merged;
                state = Object.freeze({ status: "building", length: state.length + copied.length, result: null });
            } finally { busy = false; }
        },
        finish: () => { if (busy || state.status === "disposed") throw new Error("Glyph run builder is unavailable."); if (state.result) return state.result;
            if (pending.length) blocks.push(Object.freeze(pending)); const result = publish(capturedFont!, Object.freeze(blocks), state.length); blocks = []; pending = []; capturedFont = null;
            state = Object.freeze({ status: "ready", length: result.length, result }); return result; },
        dispose: () => { if (busy) throw new Error("Glyph run builder is busy."); blocks = []; pending = []; capturedFont = null; state = Object.freeze({ status: "disposed", length: 0, result: null }); }
    });
}
