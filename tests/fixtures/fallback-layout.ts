import { coverageFontFixture } from "./font-coverage.ts";
import { assembleFont, fontTables } from "./consumer/font-fixture.ts";
import { gsub, lookup, single } from "./substitution.ts";
export function fallbackFontFixtures(revised = false): readonly [Uint8Array, Uint8Array] {
    const primary = fontTables(coverageFontFixture([[65, 2], [66, 3], [0xc5, 3], [0x301, 9], [0x30a, 9], [0x327, 9], [0x2126, 7], [0x2764, 7], [0x1f469, 7], [0x1f1e6, 7]]));
    primary.set("GSUB", gsub([lookup(1, [single([2], [4])])], { features: [{ tag: "ccmp", lookups: [0] }] }));
    const secondary = fontTables(coverageFontFixture([[65, 2], [66, 2], [0xc1, 7], [0x1fa, 7], [0x3b1, 3], [0x3a9, 5], [0x2764, 2], [0x1f469, 2], [0x1f4bb, 3], [0x1f1e6, 2], [0x1f1e7, 3], [0xfb01, 6]], [{ base: 65, selector: 0xfe0f, glyph: 8 }, { base: 0x2764, selector: 0xfe0f, glyph: 8 }], { advanceA: revised ? 800 : 600 }));
    secondary.set("GSUB", gsub([lookup(1, [single([3], [5])])], { features: [{ tag: "locl", lookups: [0] }] }));
    return [assembleFont(primary), assembleFont(secondary)];
}
export const fallbackNativeCases = Object.freeze([
    { name: "primary-feature", text: "A" }, { name: "secondary-feature", text: "α" }, { name: "mixed-fonts", text: "AαA" },
    { name: "decomposed-primary", text: "A\u0301" }, { name: "composed-primary", text: "Á" }, { name: "partial-composition", text: "A\u0327\u030a\u0301" },
    { name: "canonical-alias", text: "Ω" }, { name: "original-alias", text: "Ω" }, { name: "variation-priority", text: "A\ufe0f" }, { name: "variation-fallback", text: "B\ufe0f" },
    { name: "orphan-selector", text: "\ufe0f" }, { name: "emoji-cluster", text: "👩‍💻" }, { name: "regional-cluster", text: "🇦🇧" }, { name: "compatibility-preserved", text: "ﬁ" }, { name: "uncovered", text: "☯" }, { name: "registered-variation-priority", text: "❤\ufe0f" }
].map(v => Object.freeze(v)));
export const visibilityNativeCases = Object.freeze([
    ["joiner", "A\u200dB"], ["non-joiner", "A\u200cB"], ["soft-hyphen", "A\u00adB"], ["grapheme-joiner", "A\u034fB"],
    ["word-joiner", "A\u2060B"], ["zero-width-space", "A\u200bB"], ["byte-order-mark", "A\ufeffB"], ["left-mark", "A\u200eB"],
    ["right-mark", "A\u200fB"], ["tag", "A\u{e0061}B"], ["mongolian-selector", "A\u180bB"], ["invisible-operator", "A\u2061B"],
    ["unassigned-ignorable", "A\u{e0fff}B"], ["lone-joiner", "\u200d"], ["emoji-cluster", "👩‍💻"],
    ["non-ignorable-format", "A\u0600B"], ["non-ignorable-control", "A\u0000B"]
].map(([name, text]) => Object.freeze({ name: name!, text: text! })));
