import type { TextDocument, Position, CompletionItem, CompletionList } from "vscode-languageserver-protocol/browser.js";

const object = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === "object" && !Array.isArray(value);
const linked =
    'export const ${1:record} = {\n    state: "${2|draft,ready,archived|}",\n    value: ${3:0},\n};\nconsole.log($1);\n$0';
const lazy = 'const ${1:result}: TemplateRecord = {\n    state: "${2|draft,ready|}",\n};\nconsole.log($1);\n$0';

/** Clearly labeled example-owned templates use the same completion/resolve protocol as TypeScript. */
export function demoTemplateCompletions(document: TextDocument, position: Position): CompletionList | undefined {
    if (!document.uri.endsWith("/templates.ts")) return;
    const offset = document.offsetAt(position),
        text = document.getText(),
        word = text.slice(0, offset).match(/\btemplate$/)?.[0];
    if (!word) return;
    const range = { start: document.positionAt(offset - word.length), end: document.positionAt(offset) };
    const data = (kind: string) => ({ demoTemplate: kind, uri: document.uri, version: document.version, range });
    return {
        isIncomplete: false,
        items: [
            {
                label: "Template · linked placeholders",
                filterText: "template",
                sortText: "01",
                insertTextFormat: 2,
                textEdit: { range, newText: linked },
                data: data("linked"),
                detail: "Demo template provider · numbered stops, choices and linked names"
            },
            {
                label: "Template · lazy declaration",
                filterText: "template",
                sortText: "02",
                insertTextFormat: 2,
                data: data("lazy"),
                detail: "Demo template provider · declaration and import supplied on resolve"
            },
            {
                label: "Template · plain declaration",
                filterText: "template",
                sortText: "03",
                textEdit: { range, newText: 'const record = { state: "draft" };\n' },
                data: data("plain")
            },
            {
                label: "Template · unsupported variable",
                filterText: "template",
                sortText: "04",
                insertTextFormat: 2,
                textEdit: { range, newText: "$TM_FILENAME" }
            }
        ]
    };
}

export function demoTemplateUri(params: unknown): string | undefined {
    return object(params) &&
        object(params.data) &&
        typeof params.data.demoTemplate === "string" &&
        typeof params.data.uri === "string"
        ? params.data.uri
        : undefined;
}

export function resolveDemoTemplate(params: unknown, document: TextDocument): CompletionItem {
    if (
        !object(params) ||
        !object(params.data) ||
        params.data.uri !== document.uri ||
        params.data.version !== document.version
    )
        throw new Error("Demo template source changed.");
    const item = params as unknown as CompletionItem;
    if (params.data.demoTemplate !== "lazy")
        return {
            ...item,
            detail: "Demo template provider · Tab moves to the next placeholder; Alt+Up/Down changes a choice."
        };
    return {
        ...item,
        detail: "Demo template provider · declaration and import resolved together",
        textEdit: { range: item.data.range, newText: lazy },
        additionalTextEdits: [
            {
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
                newText: 'import type { TemplateRecord } from "./types";\n'
            }
        ]
    };
}
