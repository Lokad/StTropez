/** Local provider contract. Plain text only; no markup renderer or application service. */
export type HoverInput = Readonly<{ operation: "hover"; id: number; revision: number; text: string; offset: number; delay: number;
    fault?: "malformed" | "failure" | "markup" }>;
export type HoverResult = Readonly<{ operation: "hover"; id: number; revision: number;
    range: Readonly<{ from: number; to: number }> | null; text: string }>;
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const integer = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value);

export function validateHoverInput(value: unknown): HoverInput | undefined {
    if (!record(value) || value.operation !== "hover" || !integer(value.id) || value.id < 1 || !integer(value.revision) || value.revision < 0
        || typeof value.text !== "string" || value.text.length > 4096 || !integer(value.offset) || value.offset < 0 || value.offset > value.text.length
        || typeof value.delay !== "number" || !Number.isFinite(value.delay) || value.delay < 0 || value.delay > 60000
        || value.fault !== undefined && value.fault !== "malformed" && value.fault !== "failure" && value.fault !== "markup") return undefined;
    return Object.freeze({ operation: "hover", id: value.id, revision: value.revision, text: value.text, offset: value.offset, delay: value.delay,
        ...(value.fault === undefined ? {} : { fault: value.fault }) });
}

export function provideHover(input: HoverInput): HoverResult {
    if (!validateHoverInput(input)) throw new TypeError("Invalid bounded hover request.");
    // This fixture owns its identifier policy, independently of editor navigation or a parser.
    for (const match of input.text.matchAll(/[\p{L}\p{N}\p{Pc}\p{M}\u200c\u200d]+/gu)) {
        if (input.offset < match.index || input.offset > match.index + match[0].length) continue;
        if (match[0].length > 256) break;
        const description = match[0] === "const" ? "Declares a constant binding." : match[0] === "let" ? "Declares a variable binding."
            : match[0] === "TODO" ? "Unresolved placeholder." : "Symbol in this source.";
        return Object.freeze({ operation: "hover", id: input.id, revision: input.revision,
            range: Object.freeze({ from: match.index, to: match.index + match[0].length }), text: `${match[0]}\n${description}` });
    }
    return Object.freeze({ operation: "hover", id: input.id, revision: input.revision, range: null, text: "" });
}

/** Reject the entire response before publishing any range or text. Rendering uses textContent. */
export function validateHoverResult(value: unknown, input: HoverInput): HoverResult | undefined {
    if (!record(value) || value.operation !== "hover" || value.id !== input.id || value.revision !== input.revision || typeof value.text !== "string" || value.text.length > 2048) return undefined;
    if (value.range === null) return value.text === "" ? Object.freeze({ operation: "hover", id: input.id, revision: input.revision, range: null, text: "" }) : undefined;
    if (!record(value.range) || !integer(value.range.from) || !integer(value.range.to) || value.range.from < 0 || value.range.to <= value.range.from
        || value.range.to > input.text.length || input.offset < value.range.from || input.offset > value.range.to || !value.text.length) return undefined;
    const splitPair = (at: number) => at > 0 && at < input.text.length && /[\ud800-\udbff]/.test(input.text[at - 1]!) && /[\udc00-\udfff]/.test(input.text[at]!);
    if (splitPair(value.range.from) || splitPair(value.range.to)) return undefined;
    return Object.freeze({ operation: "hover", id: input.id, revision: input.revision,
        range: Object.freeze({ from: value.range.from, to: value.range.to }), text: value.text });
}
