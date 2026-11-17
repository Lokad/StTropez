import ts from "typescript-demo";

// The pinned parser supplies syntax diagnostics that its public SourceFile type omits.
/** @typedef {import("typescript-demo").SourceFile & {parseDiagnostics: readonly import("typescript-demo").DiagnosticWithLocation[]}} ParsedSourceFile */

/**
 * Development-only parsing shared by declaration finalization and host staging.
 * @param {string} path
 * @param {string} text
 */
export function moduleSpecifiers(path, text) {
    const file = /** @type {ParsedSourceFile} */ (ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true));
    /** @type {{value: string, from: number, to: number}[]} */
    const result = [];
    const first = file.parseDiagnostics[0];
    if (first) {
        throw Object.assign(new Error(`Invalid module syntax in ${path}: ${ts.flattenDiagnosticMessageText(first.messageText, " ")}`), { offset: first.start ?? 0 });
    }
    /** @param {import("typescript-demo").Node} node */
    function visit(node) {
        const literal = ts.isImportDeclaration(node) || ts.isExportDeclaration(node) ? node.moduleSpecifier
            : ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) ? node.argument.literal
            : ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword ? node.arguments[0]
            : ts.isExternalModuleReference(node) ? node.expression
            : ts.isModuleDeclaration(node) ? node.name : undefined;
        if (literal && ts.isStringLiteralLike(literal)) result.push({ value: literal.text, from: literal.getStart(file), to: literal.end });
        ts.forEachChild(node, visit);
    }
    visit(file); return result;
}

const sourceExtension = /(?:\.d)?\.(ts|tsx|mts|cts)$/;
/** @param {string} value */
const relativeSource = value => /^\.\.?\//.test(value) && sourceExtension.test(value);
/**
 * @param {string} path
 * @param {string} text
 */
export function portableDeclaration(path, text) {
    for (const specifier of moduleSpecifiers(path, text).filter(item => relativeSource(item.value)).sort((a, b) => b.from - a.from)) {
        const value = specifier.value.replace(sourceExtension, (_match, extension) => extension === "mts" ? ".mjs" : extension === "cts" ? ".cjs" : ".js");
        text = text.slice(0, specifier.from) + JSON.stringify(value) + text.slice(specifier.to);
    }
    if (moduleSpecifiers(path, text).some(item => relativeSource(item.value))) throw new Error(`Source module specifier remains in ${path}`);
    return text;
}
