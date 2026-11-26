import { posix, relative, resolve, sep } from "node:path";
import ts from "typescript-demo";
import { libraryModules } from "./library-entries.mjs";

export const apiIndexPath = "docs/api.md";

/** @param {import("typescript-demo").Symbol} symbol @param {import("typescript-demo").TypeChecker} checker */
function exportKind(symbol, checker) {
    if (symbol.flags & ts.SymbolFlags.Class) return "class";
    if (symbol.flags & ts.SymbolFlags.Interface) return "interface";
    if (symbol.flags & ts.SymbolFlags.TypeAlias) return "type";
    if (symbol.flags & ts.SymbolFlags.Enum) return "enum";
    const value = symbol.valueDeclaration;
    if (value && checker.getTypeOfSymbolAtLocation(symbol, value).getCallSignatures().length) return "function";
    return "value";
}

/** @param {string} root */
export function renderApiIndex(root) {
    const program = ts.createProgram(
        libraryModules.map((entry) => resolve(root, entry.source)),
        {
            module: ts.ModuleKind.NodeNext,
            allowImportingTsExtensions: true,
            noEmit: true,
            types: []
        }
    );
    const checker = program.getTypeChecker();
    const lines = [
        "# Public API index",
        "",
        "Import a name from the entry above its table. Each entry includes TypeScript declarations in the package.",
        "Follow a name to its source, or use Go to Definition in your project to open the installed declaration."
    ];
    for (const { specifier, source, types } of libraryModules) {
        const file = program.getSourceFile(resolve(root, source));
        const entry = file && checker.getSymbolAtLocation(file);
        if (!entry) throw new Error(`Cannot read exports from ${source}.`);
        lines.push(
            "",
            `## \`${specifier}\``,
            "",
            `Declarations start at \`${types}\` in the assets directory.`,
            "",
            "| Export | Kind | Purpose |",
            "| --- | --- | --- |"
        );
        const symbols = checker.getExportsOfModule(entry).sort((a, b) => a.name.localeCompare(b.name, "en"));
        for (const symbol of symbols) {
            const target = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
            const declaration = target.declarations?.[0];
            if (!declaration) throw new Error(`Cannot locate ${specifier} export ${symbol.name}.`);
            const path = relative(root, declaration.getSourceFile().fileName).split(sep).join("/");
            const url = posix.relative(posix.dirname(apiIndexPath), path);
            const prose = ts.displayPartsToString(target.getDocumentationComment(checker)).trim().replace(/\s+/g, " ");
            const comment = prose.split(/(?<=[.!?])\s+/u, 1)[0] ?? "";
            lines.push(
                `| [\`${symbol.name}\`](${url}) | ${exportKind(target, checker)} | ${comment.replaceAll("|", "\\|")} |`
            );
        }
    }
    return lines.join("\n") + "\n";
}
