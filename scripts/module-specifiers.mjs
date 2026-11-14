import ts from "typescript-demo";

/** Development-only parsing shared by declaration finalization and host staging. */
export function moduleSpecifiers(path, text) {
    const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true), result = [];
    if (file.parseDiagnostics.length) throw new Error(`Invalid module syntax in ${path}: ${ts.flattenDiagnosticMessageText(file.parseDiagnostics[0].messageText, " ")}`);
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
const relativeSource = value => /^\.\.?\//.test(value) && sourceExtension.test(value);
export function portableDeclaration(path, text) {
    for (const specifier of moduleSpecifiers(path, text).filter(item => relativeSource(item.value)).sort((a, b) => b.from - a.from)) {
        const value = specifier.value.replace(sourceExtension, (_match, extension) => extension === "mts" ? ".mjs" : extension === "cts" ? ".cjs" : ".js");
        text = text.slice(0, specifier.from) + JSON.stringify(value) + text.slice(specifier.to);
    }
    if (moduleSpecifiers(path, text).some(item => relativeSource(item.value))) throw new Error(`Source module specifier remains in ${path}`);
    return text;
}
