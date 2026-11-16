import { fromMarkdown } from "mdast-util-from-markdown";
import { gfm } from "micromark-extension-gfm";
import { gfmFromMarkdown } from "mdast-util-gfm";
import GithubSlugger from "github-slugger";
import { posix, relative, resolve } from "node:path";
import { build } from "esbuild";
import ts from "typescript-demo";

export const apiPages = ["getting-started", "editor", "viewport", "folding", "search", "comparison", "text-model", "workspace", "language-server", "language-features", "unicode", "host-integration", "packaging", "architecture"].map(name => `docs/${name}.md`);
export const subjectPages = [...apiPages, "docs/README.md", "docs/testing.md", "docs/examples.md"];
export const documentationPages = [...subjectPages, "README.md", "packaging/README.md", "AGENTS.md"];
export const publicEntries = { sttropez: "src/index.ts", "sttropez/browser": "src/browser/index.ts", "sttropez/protocol": "src/protocol/index.ts" };

// Declaration owners, rather than a second manually maintained list of public names.
const ownerGroups = {
    "text-model": ["core/changes", "core/positions", "core/newlines", "core/text-buffer", "core/buffer-change", "core/selections", "core/snippets"],
    workspace: ["core/workspace", "core/commands"],
    editor: ["core/language-edits", "core/bracket-matching", "browser/index", "browser/editing-candidate"],
    viewport: ["browser/viewport"],
    folding: ["core/folding", "core/fold-discovery", "browser/folding-controller", "protocol/lsp-folding"],
    search: ["core/search", "browser/find", "browser/regex-find"],
    comparison: ["core/diff", "core/comparison", "browser/comparison"],
    unicode: ["core/words", "core/graphemes", "core/grapheme-data", "core/bidi", "core/bidi-cursor", "core/bidi-controller", "core/character-warnings", "browser/font-asset"],
    "host-integration": ["browser/input-conflict", "browser/captured-view"],
    "language-server": ["protocol/json-rpc", "protocol/lsp-positions", "protocol/lsp-session", "protocol/lsp-workspace", "protocol/lsp-command", "browser/lsp-websocket"],
    "language-features": ["protocol/lsp-features", "protocol/lsp-code-actions", "protocol/lsp-workspace-edit", "protocol/lsp-hover", "protocol/lsp-highlights", "protocol/lsp-rename", "protocol/lsp-navigation", "protocol/lsp-actions", "protocol/lsp-language", "browser/lsp-editor", "browser/lsp-highlights", "browser/documentation"]
};
export const declarationOwners = Object.fromEntries(Object.entries(ownerGroups).flatMap(([page, sources]) => sources.map(source => [`src/${source}.ts`, `docs/${page}.md`])));

function visit(node, action) { action(node); for (const child of node.children ?? []) visit(child, action); }
function inlineText(node, code = true) {
    if (node.type === "text") return node.value;
    if (node.type === "inlineCode") return code ? node.value : node.value.replace(/[^\n]/g, " ");
    if (node.type === "image" || node.type === "imageReference") return node.alt ?? "";
    if (node.type === "break") return " ";
    return (node.children ?? []).map(child => inlineText(child, code)).join("");
}
const diagnostic = (page, node, code, message) => ({ path: page.path, line: node?.position?.start.line ?? 1, code, message });

/** Parse once for links, headings, prose and independently compiled examples. */
export function parseDocumentation(path, markdown) {
    const tree = fromMarkdown(markdown, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
    const page = { path, tree, examples: [], links: [], anchors: new Set(), headings: [], prose: [], contract: "", diagnostics: [] };
    const slugger = new GithubSlugger(), definitions = new Map();
    visit(tree, node => { if (node.type === "definition" && !definitions.has(node.identifier)) definitions.set(node.identifier, node); });
    visit(tree, node => {
        if (node.type === "heading") {
            const title = inlineText(node);
            page.headings.push({ title, depth: node.depth, node });
            page.anchors.add(slugger.slug(title));
        }
        if (["paragraph", "heading", "tableCell"].includes(node.type)) page.prose.push({ text: inlineText(node, false), node });
        if (["link", "image", "definition"].includes(node.type)) page.links.push({ url: node.url, node });
        if (["linkReference", "imageReference"].includes(node.type)) {
            const definition = definitions.get(node.identifier);
            if (definition) page.links.push({ url: definition.url, node });
        }
        if (node.type === "html") {
            // Keep repository docs in Markdown. Support explicit anchors and comments,
            // but reject other HTML so href/src attributes cannot evade the link gate.
            const value = node.value.trim(), anchor = /^<a\s+(?:id|name)=["']([^"'<>]+)["']\s*>(?:<\/a>)?$/i.exec(value);
            if (anchor) page.anchors.add(anchor[1]);
            else if (value !== "</a>" && !/^(?:<!--(?:(?!-->)[\s\S])*-->\s*)+$/.test(value)) page.diagnostics.push(diagnostic(page, node, "html", "Use Markdown links/content or a standalone <a id=\"anchor\"></a>."));
        }
        if (node.type !== "code") return;
        const raw = markdown.slice(node.position.start.offset, node.position.end.offset);
        const marker = /^(`{3,}|~{3,})/.exec(raw)?.[1];
        if (!marker) return; // Indented code has no declared TypeScript language.
        const last = raw.split(/\r?\n/).at(-1);
        const close = new RegExp(`^[ >\\t]*${marker[0]}{${marker.length},}\\s*$`);
        if (!raw.includes("\n") || !close.test(last)) page.diagnostics.push(diagnostic(page, node, "fence", "Unclosed code fence."));
        if (["ts", "typescript", "tsx"].includes(node.lang)) page.examples.push({ path, line: node.position.start.line + 1, language: node.lang, code: node.value });
    });
    let contract = false;
    for (const node of tree.children) {
        if (node.type === "heading" && node.depth === 2) contract = inlineText(node) === "Contract";
        if (contract && !["code", "html", "definition"].includes(node.type)) page.contract += inlineText(node) + "\n";
    }
    return page;
}

/** Only authored prose is scanned: public identifiers and commands keep their spelling. */
export function auditPage(page, { api = false, vocabulary = true } = {}) {
    const issues = [...page.diagnostics];
    if (vocabulary) for (const { text, node } of page.prose) {
        const banned = /\b(?:now|still|no\s+longer|previously|remains|candidate|pilot|scaffold)\b|\b(?:M\d+|P[0-7]|E\d+)\b|\b\d{4}-\d{2}-\d{2}\b|\b(?:[0-9a-f]{40}|(?:commit|revision)\s+[0-9a-f]{7,40})\b|\b\d+\s+(?:tests?\s+)?(?:passes|passed)\b/gi;
        for (const match of text.matchAll(banned)) issues.push({ ...diagnostic(page, node, "prose", `Describe current behavior; move historical wording ${JSON.stringify(match[0])} to ignored research (code identifiers belong in inline code).`), line: node.position.start.line + text.slice(0, match.index).split("\n").length - 1 });
    }
    if (api) {
        const expected = ["Use", "Contract", "Host responsibilities", "Not covered"];
        const actual = page.headings.filter(heading => heading.depth === 2).map(heading => heading.title);
        if (JSON.stringify(actual) !== JSON.stringify(expected)) issues.push(diagnostic(page, undefined, "structure", `Expected second-level sections: ${expected.join(", ")}.`));
        if (!page.examples.length) issues.push(diagnostic(page, undefined, "example", "Expected a checked TypeScript example."));
        const notCovered = page.headings.find(heading => heading.depth === 2 && heading.title === "Not covered");
        if (!notCovered || !page.links.some(link => link.node.position.start.line > notCovered.node.position.start.line && link.url === "README.md#support-matrix")) issues.push(diagnostic(page, notCovered?.node, "support", "Not covered must link to README.md#support-matrix."));
    }
    return issues;
}

/** Check repository links against non-ignored files; inline-code asset paths are not links. */
export async function auditLinks(pages, files, read) {
    const issues = [], cache = new Map(pages.map(page => [page.path, page]));
    for (const page of pages) for (const link of page.links) {
        const fail = message => issues.push(diagnostic(page, link.node, "link", `${JSON.stringify(link.url)}: ${message}`));
        if (/^file:|^[a-z]:[\\/]/i.test(link.url)) { fail("Use a relative repository path."); continue; }
        if (/^[a-z][a-z\d+.-]*:/i.test(link.url) || link.url.startsWith("//")) continue;
        const [address, ...fragments] = link.url.split("#");
        let target, anchor;
        try {
            const decoded = decodeURIComponent(address.split("?")[0]);
            if (/^[\\/]|^[a-z]:|\\/i.test(decoded)) { fail("Use a relative repository path."); continue; }
            target = decoded ? posix.normalize(posix.join(posix.dirname(page.path), decoded)) : page.path;
            anchor = decodeURIComponent(fragments.join("#"));
        } catch { fail("Invalid percent encoding."); continue; }
        if (target === ".." || target.startsWith("../")) { fail("Path leaves the repository."); continue; }
        const directory = target.replace(/\/$/, "");
        if (!files.has(target)) {
            if (files.has(`${directory}/README.md`)) target = `${directory}/README.md`;
            else if (!anchor && [...files].some(file => file.startsWith(directory === "." ? "" : `${directory}/`))) continue;
            else { fail("Target is missing or ignored."); continue; }
        }
        let content;
        try { content = await read(target); } catch { fail("Target does not exist in the working tree."); continue; }
        if (!anchor) continue;
        if (/\.md$/i.test(target)) {
            if (!cache.has(target)) cache.set(target, parseDocumentation(target, content));
            if (!cache.get(target).anchors.has(anchor)) fail(`Missing heading/anchor in ${target}.`);
        } else {
            const lines = /^L([1-9]\d*)(?:-L([1-9]\d*))?$/.exec(anchor), count = content.split(/\r?\n/).length;
            if (!lines || Number(lines[1]) > count || lines[2] && (Number(lines[2]) < Number(lines[1]) || Number(lines[2]) > count)) fail(`Invalid source-line anchor in ${target}.`);
        }
    }
    return issues;
}

/** esbuild identifies runtime exports; TypeScript resolves each exported alias to its owner.
 * No entry module is executed. Type-only re-exports do not become runtime obligations. */
export async function publicValues(root, entries = publicEntries) {
    const paths = Object.values(entries).map(path => resolve(root, path));
    const result = await build({ absWorkingDir: root, entryPoints: paths, outdir: resolve(root, "artifacts/docs-check/exports"),
        bundle: true, write: false, metafile: true, format: "esm", platform: "neutral", logLevel: "silent" });
    const program = ts.createProgram(paths, { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler, allowImportingTsExtensions: true, noEmit: true, types: [], skipLibCheck: true });
    const checker = program.getTypeChecker(), values = [];
    for (const [entry, path] of Object.entries(entries)) {
        const source = program.getSourceFile(resolve(root, path));
        const symbols = new Map(checker.getExportsOfModule(checker.getSymbolAtLocation(source)).map(symbol => [symbol.name, symbol]));
        const output = Object.values(result.metafile.outputs).find(output => output.entryPoint && resolve(root, output.entryPoint) === resolve(root, path));
        if (!output) throw new Error(`No runtime export metadata for ${path}.`);
        for (const name of output.exports) {
            let symbol = symbols.get(name);
            if (symbol?.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
            const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
            if (!declaration) throw new Error(`${path}: Cannot resolve public value ${name}.`);
            const file = declaration.getSourceFile();
            values.push({ entry, name, source: relative(root, file.fileName).replaceAll("\\", "/"), line: file.getLineAndCharacterOfPosition(declaration.getStart()).line + 1 });
        }
    }
    return values;
}

export function auditValueCoverage(values, pages, owners = declarationOwners) {
    const byPath = new Map(pages.map(page => [page.path, page])), issues = [];
    for (const value of values) {
        const owner = owners[value.source], page = byPath.get(owner);
        if (!page) issues.push({ path: value.source, line: value.line, code: "owner", message: `${value.entry}: ${value.name} needs a declaration owner in documentation-audit.mjs.` });
        else if (!page.contract.split(/[^\p{L}\p{N}_$]+/u).includes(value.name)) issues.push({ path: owner, line: page.headings.find(heading => heading.title === "Contract")?.node.position.start.line ?? 1,
            code: "coverage", message: `Contract must explain public value ${value.name} (${value.entry}, ${value.source}:${value.line}).` });
    }
    return issues;
}
