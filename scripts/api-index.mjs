import { posix, relative, resolve, sep } from "node:path";
import ts from "typescript-demo";
import { libraryModules } from "./library-entries.mjs";

export const apiIndexPath = "docs/api.md";

/** @param {string} root */
export function renderApiIndex(root) {
    const program = ts.createProgram(libraryModules.map(entry => resolve(root, entry.source)), {
        module: ts.ModuleKind.NodeNext,
        allowImportingTsExtensions: true,
        noEmit: true,
        types: [],
    });
    const checker = program.getTypeChecker();
    const lines = [
        "# Public API index", "",
        "Each heading is an import path. Follow a source link to read the declarations for the names in that row.",
    ];
    for (const { specifier, source } of libraryModules) {
        const file = program.getSourceFile(resolve(root, source));
        const entry = file && checker.getSymbolAtLocation(file);
        if (!entry) throw new Error(`Cannot read exports from ${source}.`);
        /** @type {Map<string, string[]>} */
        const byFile = new Map();
        for (const symbol of checker.getExportsOfModule(entry)) {
            const target = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
            const declaration = target.declarations?.[0];
            if (!declaration) throw new Error(`Cannot locate ${specifier} export ${symbol.name}.`);
            const path = relative(root, declaration.getSourceFile().fileName).split(sep).join("/");
            const names = byFile.get(path) ?? [];
            names.push(symbol.name);
            byFile.set(path, names);
        }
        lines.push("", `## \`${specifier}\``, "", "| Source | Public names |", "| --- | --- |");
        for (const [path, exports] of [...byFile].sort(([a], [b]) => a.localeCompare(b, "en"))) {
            const url = posix.relative(posix.dirname(apiIndexPath), path);
            const names = exports.sort().map(name => `\`${name}\``).join(", ");
            lines.push(`| [${path.replace(/^src\//, "")}](${url}) | ${names} |`);
        }
    }
    return lines.join("\n") + "\n";
}
