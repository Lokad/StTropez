import { fromMarkdown } from "mdast-util-from-markdown";
import { gfm } from "micromark-extension-gfm";
import { gfmFromMarkdown } from "mdast-util-gfm";
import GithubSlugger from "github-slugger";
import { posix } from "node:path";
import { libraryModules } from "./library-entries.mjs";
import { apiIndexPath } from "./api-index.mjs";

/** @typedef {import("mdast").Nodes} MarkdownNode */
/** @typedef {{path: string, line: number, language: string, code: string, file?: string}} DocumentationExample */
/** @typedef {{path: string, line: number, code: string, message: string}} DocumentationIssue */
/** @typedef {{path: string, tree: import("mdast").Root, examples: DocumentationExample[],
 * links: {url: string, node: MarkdownNode}[], anchors: Set<string>,
 * prose: {text: string, node: MarkdownNode}[], diagnostics: DocumentationIssue[]}} DocumentationPage */

/** UTF-8 bytes with LF line endings. @type {Record<string, number>} */
const pageBudgets = {
    "docs/architecture.md": 8_000,
    "docs/comparison.md": 18_000,
    "docs/editor.md": 18_000,
    "docs/examples.md": 5_000,
    "docs/folding.md": 10_900,
    "docs/getting-started.md": 17_000,
    "docs/host-integration.md": 14_000,
    "docs/language-features.md": 18_000,
    "docs/language-server.md": 19_000,
    "docs/packaging.md": 9_000,
    "docs/README.md": 11_000,
    "docs/search.md": 7_600,
    "docs/testing.md": 20_000,
    "docs/text-model.md": 16_000,
    "docs/unicode.md": 9_000,
    "docs/viewport.md": 18_000,
    "docs/workspace.md": 21_500,
};
export const subjectPages = [...Object.keys(pageBudgets), apiIndexPath];
const guides = ["docs/README.md", "docs/testing.md", "docs/examples.md"];
export const apiPages = Object.keys(pageBudgets).filter(path => !guides.includes(path));
export const documentationPages = [...subjectPages, "README.md", "packaging/README.md", "AGENTS.md"];
export const publicEntries = Object.fromEntries(libraryModules.map(entry => [entry.specifier, entry.source]));
export const exampleExtensions = new Map([["js", "js"], ["javascript", "js"], ["ts", "ts"], ["typescript", "ts"], ["tsx", "tsx"]]);

/** @param {MarkdownNode} node @param {(node: MarkdownNode) => void} action */
function visit(node, action) { action(node); for (const child of "children" in node ? node.children : []) visit(child, action); }
/** @param {MarkdownNode} node @param {boolean} [code] @returns {string} */
function inlineText(node, code = true) {
    if (node.type === "text") return node.value;
    if (node.type === "inlineCode") return code ? node.value : node.value.replace(/[^\n]/g, " ");
    if (node.type === "image" || node.type === "imageReference") return node.alt ?? "";
    if (node.type === "break") return " ";
    return ("children" in node ? node.children : []).map(child => inlineText(child, code)).join("");
}
/** @param {Pick<DocumentationPage, "path">} page @param {MarkdownNode | undefined} node @param {string} code @param {string} message */
const diagnostic = (page, node, code, message) => ({ path: page.path, line: node?.position?.start.line ?? 1, code, message });

/** Parse once for links, headings, prose and checked examples.
 * @param {string} path @param {string} markdown */
export function parseDocumentation(path, markdown) {
    const tree = fromMarkdown(markdown, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
    /** @type {DocumentationPage} */
    const page = { path, tree, examples: [], links: [], anchors: new Set(), prose: [], diagnostics: [] };
    const budget = pageBudgets[path];
    if (budget !== undefined) {
        const bytes = Buffer.byteLength(markdown.replaceAll("\r\n", "\n"));
        if (bytes > budget) {
            page.diagnostics.push(diagnostic(page, undefined, "size", `Page uses ${bytes} of ${budget} UTF-8 bytes.`));
        }
    }
    const slugger = new GithubSlugger();
    /** @type {Map<string, DocumentationExample>} */
    const modules = new Map();
    /** @type {Map<string, import("mdast").Definition>} */ const definitions = new Map();
    visit(tree, node => { if (node.type === "definition" && !definitions.has(node.identifier)) definitions.set(node.identifier, node); });
    visit(tree, node => {
        if (node.type === "heading") {
            const title = inlineText(node);
            page.anchors.add(slugger.slug(title));
        }
        if (["paragraph", "heading", "tableCell"].includes(node.type)) page.prose.push({ text: inlineText(node, false), node });
        if (node.type === "link" || node.type === "image" || node.type === "definition") page.links.push({ url: node.url, node });
        if (node.type === "linkReference" || node.type === "imageReference") {
            const definition = definitions.get(node.identifier);
            if (definition) page.links.push({ url: definition.url, node });
        }
        if (node.type === "html") {
            // Keep repository docs in Markdown. Support explicit anchors and comments,
            // but reject other HTML so href/src attributes cannot evade the link gate.
            const value = node.value.trim(), anchor = /^<a\s+(?:id|name)=["']([^"'<>]+)["']\s*>(?:<\/a>)?$/i.exec(value);
            if (anchor) page.anchors.add(/** @type {string} */ (anchor[1])); // Required nonempty regex capture.
            else if (value !== "</a>" && !/^(?:<!--(?:(?!-->)[\s\S])*-->\s*)+$/.test(value)) page.diagnostics.push(diagnostic(page, node, "html", "Use Markdown links/content or a standalone <a id=\"anchor\"></a>."));
        }
        if (node.type !== "code") return;
        if (!node.position || node.position.start.offset === undefined || node.position.end.offset === undefined) throw new Error(`${path}: Markdown code node has no source offsets.`);
        const raw = markdown.slice(node.position.start.offset, node.position.end.offset);
        const marker = /^(`{3,}|~{3,})/.exec(raw)?.[1];
        if (!marker) return; // Indented code has no declared TypeScript language.
        const lines = raw.split(/\r\n|\r|\n/), last = lines.at(-1) ?? "";
        const close = new RegExp(`^[ >\\t]*${marker[0]}{${marker.length},}\\s*$`);
        // A fence-looking line indented as code is retained in the parsed value.
        // A real closing fence consumes a source line without adding a value line.
        const closed = lines.length > 1 && close.test(last)
            && (!node.value || node.value.split(/\r\n|\r|\n/).length < lines.length - 1);
        if (!closed) page.diagnostics.push(diagnostic(page, node, "fence", "Unclosed code fence."));
        if (!node.lang) return;
        const extension = exampleExtensions.get(node.lang);
        if (!extension) return;
        const line = node.position.start.line + 1;
        const file = node.meta?.startsWith("file=") ? node.meta.slice(5) : undefined;
        if (file !== undefined && !file.endsWith("." + extension)) {
            page.diagnostics.push(diagnostic(page, node, "fence", `Expected a .${extension} filename.`));
            return;
        }
        const previous = file && modules.get(file);
        if (previous) {
            // Keep the Markdown line numbers in a file assembled from several fences.
            const lastLine = previous.line + previous.code.split(/\r\n|\r|\n/).length - 1;
            previous.code += "\n".repeat(line - lastLine) + node.value;
        } else {
            const example = { path, line, language: node.lang, code: node.value, ...(file !== undefined && { file }) };
            page.examples.push(example);
            if (file) modules.set(file, example);
        }
    });
    return page;
}

/** Only authored prose is scanned: public identifiers and commands keep their spelling.
 * @param {DocumentationPage} page */
export function auditPage(page, { api = false, vocabulary = true } = {}) {
    const issues = [...page.diagnostics];
    if (vocabulary) for (const { text, node } of page.prose) {
        const banned = /\b(?:now|still|no\s+longer|previously|remains|candidate|pilot|scaffold)\b|\b(?:M\d+|P[0-7]|E\d+)\b|\b\d{4}-\d{2}-\d{2}\b|\b(?:[0-9a-f]{40}|(?:commit|revision)\s+[0-9a-f]{7,40})\b|\b\d+\s+(?:tests?\s+)?(?:passes|passed)\b/gi;
        for (const match of text.matchAll(banned)) issues.push({ ...diagnostic(page, node, "prose", `Describe current behavior; move historical wording ${JSON.stringify(match[0])} to ignored research (code identifiers belong in inline code).`), line: (node.position?.start.line ?? 1) + text.slice(0, match.index).split("\n").length - 1 });
    }
    if (api) {
        if (!page.examples.length) issues.push(diagnostic(page, undefined, "example", "Expected a checked code example."));
        if (!page.links.some(link => link.url === "README.md#support-matrix")) {
            issues.push(diagnostic(page, undefined, "support", "Link to the support matrix in docs/README.md."));
        }
    }
    return issues;
}

/** Check repository links against non-ignored files; inline-code asset paths are not links.
 * @param {DocumentationPage[]} pages @param {Set<string>} files @param {(path: string) => Promise<string>} read */
export async function auditLinks(pages, files, read) {
    /** @type {DocumentationIssue[]} */ const issues = [];
    const cache = new Map(pages.map(page => [page.path, page]));
    for (const page of pages) for (const link of page.links) {
        /** @param {string} message */
        const fail = message => issues.push(diagnostic(page, link.node, "link", `${JSON.stringify(link.url)}: ${message}`));
        if (/^file:|^[a-z]:[\\/]/i.test(link.url)) { fail("Use a relative repository path."); continue; }
        if (/^[a-z][a-z\d+.-]*:/i.test(link.url) || link.url.startsWith("//")) continue;
        const [address = "", ...fragments] = link.url.split("#");
        let target, anchor;
        try {
            const decoded = decodeURIComponent(address.split("?")[0] ?? "");
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
            let targetPage = cache.get(target);
            if (!targetPage) { targetPage = parseDocumentation(target, content); cache.set(target, targetPage); }
            if (!targetPage.anchors.has(anchor)) fail(`Missing heading/anchor in ${target}.`);
        } else {
            const lines = /^L([1-9]\d*)(?:-L([1-9]\d*))?$/.exec(anchor), count = content.split(/\r?\n/).length;
            if (!lines || Number(lines[1]) > count || lines[2] && (Number(lines[2]) < Number(lines[1]) || Number(lines[2]) > count)) fail(`Invalid source-line anchor in ${target}.`);
        }
    }
    return issues;
}
