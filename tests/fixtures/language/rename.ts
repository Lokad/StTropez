const reserved = new Set("await break case catch class const continue debugger default delete do else enum export extends false finally for function if implements import in instanceof interface let new null package private protected public return static super switch this throw true try typeof var void while with yield".split(" "));
/** The fixture deliberately supports the synthetic provider's identifier subset. */
export function renameName(value: string): boolean {
    return value.length > 0 && value.length <= 256 && /^[\p{L}\p{Nl}_][\p{L}\p{N}\p{Pc}\p{M}\u200c\u200d]*$/u.test(value) && !reserved.has(value);
}
