import { splitsTextPairAt } from "../core/utf16.ts";

/** Keep excerpts bounded without cutting a surrogate pair or CRLF at the ellipsis. */
export function previewText(
    source: { length: number; slice(from: number, to: number): string },
    from = 0,
    to = source.length,
): string {
    const limit = 160;
    const sample = source.slice(from, Math.min(to, from + limit + 1));
    if (sample.length <= limit) return sample;
    const end = splitsTextPairAt(sample, limit) ? limit - 1 : limit;
    return sample.slice(0, end) + "…";
}
