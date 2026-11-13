/** A deliberately small host fixture for metadata the TypeScript service does not emit here. */
export function demoDiagnosticFixture(text: string, at: (offset: number) => { line: number; character: number }, uri: string) {
    if (!text.startsWith("// Demo diagnostic metadata fixture\n")) return [];
    const from = text.indexOf("legacyPrice", text.indexOf("console.log")), related = text.indexOf("currentPrice");
    if (from < 0 || related < 0) return [];
    return [{ range: { start: at(from), end: at(from + "legacyPrice".length) }, message: "Use currentPrice instead of this deprecated alias.",
        severity: 2 as const, source: "Demo host", code: "legacy-price", tags: [2 as const],
        codeDescription: { href: "https://www.typescriptlang.org/docs/handbook/2/everyday-types.html" },
        relatedInformation: [{ location: { uri, range: { start: at(related), end: at(related + "currentPrice".length) } }, message: "Replacement declared here" }],
        data: { fixture: "legacy-price", offset: from } }];
}

/** Host help policy shared by diagnostic, hover and signature presentation. */
export function canOpenDemoHelp(target: string): boolean {
    try { const url = new URL(target); return url.protocol === "https:" && url.hostname === "www.typescriptlang.org"
        && !url.port && !url.username && !url.password && url.pathname.startsWith("/docs/"); } catch { return false; }
}
