export const extendPattern = "[\\p{M}\\u200c\\u200d]";
export const basePattern = "[\\p{L}\\p{N}\\p{Pc}]";
/** One code point in the editor's code-word policy, for Unicode expressions. */
export const codeWordConstituentPattern = `(?:${basePattern}|${extendPattern})`;
