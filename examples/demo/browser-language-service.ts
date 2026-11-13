import ts from "typescript-demo";
import { TextDocument } from "vscode-languageserver-protocol/browser.js";
import { RpcError } from "../../src/protocol/index.ts";

type ObjectValue = Record<string, unknown>;
type Document = ReturnType<typeof TextDocument.create>;
type OpenFile = Readonly<{ path: string; document: Document }>;
const object = (value: unknown): ObjectValue => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new RpcError(-32602, "Expected structured provider parameters.");
    return value as ObjectValue;
};
const string = (value: unknown): string => { if (typeof value !== "string") throw new RpcError(-32602, "Expected text."); return value; };
const integer = (value: unknown): number => { if (!Number.isSafeInteger(value) || (value as number) < 0) throw new RpcError(-32602, "Expected a nonnegative integer."); return value as number; };
const position = (value: unknown) => { const p = object(value); return { line: integer(p.line), character: integer(p.character) }; };
const range = (value: unknown) => { const r = object(value); return { start: position(r.start), end: position(r.end) }; };
const display = (parts: readonly ts.SymbolDisplayPart[] | undefined) => ts.displayPartsToString(parts ? [...parts] : undefined).slice(0, 4096);

/** Example-only, in-memory TypeScript provider. The compiler supplies all language intelligence.
 * This adapter exposes the demo's bounded LSP subset through existing public editor clients.
 */
export class BrowserLanguageService {
    private readonly files = new Map<string, OpenFile>();
    private readonly allowed = new Map<string, string>();
    private readonly libraries = new Map<string, ts.IScriptSnapshot>();
    private readonly snapshots = new Map<string, Readonly<{ version: number; snapshot: ts.IScriptSnapshot }>>();
    private readonly completions = new Map<number, Readonly<{ uri: string; offset: number; entry: ts.CompletionEntry }>>();
    private readonly service: ts.LanguageService;
    private version = 0;
    private serial = 0;
    private disposed = false;

    constructor(libraries: Readonly<Record<string, string>>, names: readonly string[]) {
        if (!names.length || names.length > 16 || new Set(names).size !== names.length || names.some(name => !/^[\w-]+\.ts$/.test(name))) throw new Error("Invalid demo file names.");
        for (const name of names) this.allowed.set(`file:///sttropez/${name}`, `/sttropez/${name}`);
        for (const [name, text] of Object.entries(libraries)) {
            if (!/^lib[\w.-]*\.d\.ts$/.test(name) || typeof text !== "string") throw new Error("Invalid compiler library asset.");
            this.libraries.set(`/lib/${name}`, ts.ScriptSnapshot.fromString(text));
        }
        const options: ts.CompilerOptions = { strict: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
            moduleResolution: ts.ModuleResolutionKind.Bundler, allowNonTsExtensions: false, types: [] };
        const host: ts.LanguageServiceHost = {
            getCompilationSettings: () => options, getCurrentDirectory: () => "/sttropez", getNewLine: () => "\n", useCaseSensitiveFileNames: () => true,
            getProjectVersion: () => String(this.version), getScriptFileNames: () => [...this.files.values()].map(file => file.path),
            getScriptVersion: path => String(this.fileAt(path)?.document.version ?? 0),
            getDefaultLibFileName: () => `/lib/${ts.getDefaultLibFileName(options)}`,
            fileExists: path => this.libraries.has(path) || !!this.fileAt(path),
            directoryExists: path => path === "/sttropez" || path === "/lib" || path === "/", getDirectories: () => [],
            readFile: path => this.fileAt(path)?.document.getText() ?? this.libraries.get(path)?.getText(0, this.libraries.get(path)!.getLength()),
            getScriptSnapshot: path => {
                const library = this.libraries.get(path); if (library) return library;
                const file = this.fileAt(path); if (!file) return;
                let cached = this.snapshots.get(path);
                if (cached?.version !== file.document.version) { cached = { version: file.document.version, snapshot: ts.ScriptSnapshot.fromString(file.document.getText()) }; this.snapshots.set(path, cached); }
                return cached.snapshot;
            },
        };
        this.service = ts.createLanguageService(host);
    }
    private fileAt(path: string): OpenFile | undefined { return [...this.files.values()].find(file => file.path === path); }
    private file(uri: unknown): OpenFile {
        const file = this.files.get(string(uri)); if (!file) throw new RpcError(-32602, "Only open demo files are available."); return file;
    }
    private cursor(params: unknown) {
        const p = object(params), file = this.file(object(p.textDocument).uri), at = position(p.position), offset = file.document.offsetAt(at);
        const actual = file.document.positionAt(offset);
        if (actual.line !== at.line || actual.character !== at.character) throw new RpcError(-32602, "Position is outside its file.");
        return { p, file, offset };
    }
    private span(file: OpenFile, span: ts.TextSpan) { return { start: file.document.positionAt(span.start), end: file.document.positionAt(span.start + span.length) }; }
    private edits(changes: readonly ts.FileTextChanges[]) {
        if (changes.some(change => change.isNewFile || !this.fileAt(change.fileName))) throw new RpcError(-32602, "Edits outside open demo files are unsupported.");
        return { documentChanges: changes.map(change => {
            const file = this.fileAt(change.fileName)!;
            return { textDocument: { uri: file.document.uri, version: file.document.version },
                edits: change.textChanges.map(edit => ({ range: this.span(file, edit.span), newText: edit.newText })) };
        }) };
    }
    notify(method: string, params: unknown): void {
        if (this.disposed) return;
        if (method === "exit") { this.dispose(); return; }
        if (method === "textDocument/didOpen") {
            const doc = object(object(params).textDocument), uri = string(doc.uri), path = this.allowed.get(uri), text = string(doc.text);
            if (!path || this.files.has(uri) || text.length > 8_000_000) throw new RpcError(-32602, "Invalid demo document.");
            this.files.set(uri, { path, document: TextDocument.create(uri, "typescript", integer(doc.version), text) }); this.version++;
        } else if (method === "textDocument/didChange") {
            const p = object(params), identity = object(p.textDocument), file = this.file(identity.uri), version = integer(identity.version);
            if (!Array.isArray(p.contentChanges) || p.contentChanges.length > 1024 || version <= file.document.version) throw new RpcError(-32602, "Invalid incremental synchronization.");
            let text = file.document.getText();
            for (const value of p.contentChanges) {
                const change = object(value), next = string(change.text);
                text = change.range === undefined ? next : TextDocument.applyEdits(TextDocument.create(file.document.uri, "typescript", version, text), [{ range: range(change.range), newText: next }]);
                if (text.length > 8_000_000) throw new RpcError(-32602, "Demo document exceeds its limit.");
            }
            this.files.set(file.document.uri, { path: file.path, document: TextDocument.create(file.document.uri, "typescript", version, text) }); this.version++;
        } else if (method === "textDocument/didClose") {
            const file = this.file(object(object(params).textDocument).uri);
            this.files.delete(file.document.uri); this.snapshots.delete(file.path); this.version++;
        }
    }
    request(method: string, params: unknown): unknown {
        if (this.disposed) throw new RpcError(-32097, "Browser provider is closed.");
        if (method === "initialize") return { serverInfo: { name: "StTropez browser demo", version: "1" }, capabilities: {
            positionEncoding: "utf-16", textDocumentSync: { openClose: true, change: 2 },
            completionProvider: { triggerCharacters: ["."], resolveProvider: true }, hoverProvider: true,
            signatureHelpProvider: { triggerCharacters: ["(", ","], retriggerCharacters: [","] },
            definitionProvider: true, referencesProvider: true, renameProvider: { prepareProvider: true }, codeActionProvider: { codeActionKinds: ["quickfix"] },
        } };
        if (method === "shutdown") return null;
        if (method === "sttropez/diagnostics") {
            const p = object(params), file = this.file(p.uri);
            if (p.kind !== "syntactic" && p.kind !== "semantic") throw new RpcError(-32602, "Unknown diagnostic kind.");
            const diagnostics = p.kind === "syntactic" ? this.service.getSyntacticDiagnostics(file.path) : this.service.getSemanticDiagnostics(file.path);
            return { success: true, body: diagnostics.slice(0, 256).map(d => ({ start: d.start ?? 0, length: d.length ?? 0,
                code: d.code, message: ts.flattenDiagnosticMessageText(d.messageText, "\n").slice(0, 4096) })) };
        }
        if (method === "completionItem/resolve") {
            const p = object(params), stored = this.completions.get(integer(object(p.data).key));
            if (!stored) throw new RpcError(-32801, "Completion is no longer available.");
            const file = this.file(stored.uri), entry = stored.entry;
            const details = this.service.getCompletionEntryDetails(file.path, stored.offset, entry.name, {}, entry.source, {}, entry.data);
            return { ...p, detail: display(details?.displayParts), documentation: display(details?.documentation) };
        }
        if (method === "textDocument/codeAction") {
            const p = object(params), file = this.file(object(p.textDocument).uri), at = range(p.range);
            const from = file.document.offsetAt(at.start), to = file.document.offsetAt(at.end);
            const codes = [...this.service.getSyntacticDiagnostics(file.path), ...this.service.getSemanticDiagnostics(file.path)]
                .filter(d => (d.start ?? 0) <= to && (d.start ?? 0) + (d.length ?? 0) >= from).map(d => d.code);
            if (!codes.length) return [];
            return this.service.getCodeFixesAtPosition(file.path, from, to, codes, {}, {}).filter(fix => !fix.commands?.length
                && fix.changes.every(change => !change.isNewFile && this.fileAt(change.fileName))).slice(0, 64)
                .map(fix => ({ title: fix.description, kind: "quickfix", edit: this.edits(fix.changes) }));
        }
        const { p, file, offset } = this.cursor(params);
        if (method === "textDocument/completion") {
            const info = this.service.getCompletionsAtPosition(file.path, offset, { includeCompletionsForModuleExports: false, includeCompletionsWithInsertText: true });
            if (!info) return null;
            const before = file.document.getText().slice(Math.max(0, offset - 2048), offset), prefix = before.match(/[\p{L}\p{N}\p{Pc}\p{M}\u200c\u200d$]*$/u)?.[0] ?? "";
            const fallback = info.optionalReplacementSpan ?? { start: offset - prefix.length, length: prefix.length };
            let entries = info.entries.filter(entry => !entry.isSnippet && !entry.hasAction && !entry.source);
            const oversized = entries.length > 256;
            if (oversized) entries = entries.filter(entry => (entry.filterText ?? entry.name).toLowerCase().startsWith(prefix.toLowerCase()));
            // A client may keep a provisional page visible while an incomplete list refreshes.
            // Keep its opaque resolution keys available within a small bounded cache.
            while (this.completions.size > 256) this.completions.delete(this.completions.keys().next().value!);
            const items = entries.slice(0, 256).flatMap(entry => {
                const span = entry.replacementSpan ?? fallback;
                if (span.start > offset || span.start + span.length < offset) return [];
                const key = ++this.serial; this.completions.set(key, { uri: file.document.uri, offset, entry });
                return [{ label: entry.name, sortText: entry.sortText, filterText: entry.filterText ?? (span.start < fallback.start ? entry.insertText ?? entry.name : entry.name),
                    textEdit: { range: this.span(file, span), newText: entry.insertText ?? entry.name }, data: { key } }];
            });
            return { isIncomplete: !!info.isIncomplete || entries.length > 256, items };
        }
        if (method === "textDocument/hover") {
            const info = this.service.getQuickInfoAtPosition(file.path, offset);
            return info ? { contents: { kind: "plaintext", value: [display(info.displayParts), display(info.documentation)].filter(Boolean).join("\n\n") }, range: this.span(file, info.textSpan) } : null;
        }
        if (method === "textDocument/signatureHelp") {
            const info = this.service.getSignatureHelpItems(file.path, offset, undefined); if (!info) return null;
            return { activeSignature: info.selectedItemIndex, activeParameter: info.argumentIndex, signatures: info.items.slice(0, 32).map(item => {
                let label = display(item.prefixDisplayParts); const separator = display(item.separatorDisplayParts);
                const parameters = item.parameters.map((parameter, i) => {
                    if (i) label += separator; const from = label.length; label += display(parameter.displayParts);
                    return { label: [from, label.length], documentation: display(parameter.documentation) };
                });
                label += display(item.suffixDisplayParts); return { label, parameters, documentation: display(item.documentation) };
            }) };
        }
        if (method === "textDocument/definition" || method === "textDocument/references") {
            const entries = method === "textDocument/definition" ? this.service.getDefinitionAtPosition(file.path, offset) : this.service.getReferencesAtPosition(file.path, offset);
            const known = (entries ?? []).filter(entry => this.fileAt(entry.fileName));
            if (known.length > 1024) throw new RpcError(-32000, "Too many demo navigation results.");
            return known.map(entry => { const target = this.fileAt(entry.fileName)!; return { uri: target.document.uri, range: this.span(target, entry.textSpan) }; });
        }
        if (method === "textDocument/prepareRename" || method === "textDocument/rename") {
            const info = this.service.getRenameInfo(file.path, offset, { allowRenameOfImportPath: false });
            if (!info.canRename || info.fileToRename) throw new RpcError(-32602, info.canRename ? "File renaming is unsupported." : info.localizedErrorMessage);
            if (method === "textDocument/prepareRename") return { range: this.span(file, info.triggerSpan), placeholder: info.displayName };
            const name = string(p.newName), scanner = ts.createScanner(ts.ScriptTarget.ES2022, false, ts.LanguageVariant.Standard, name);
            if (scanner.scan() !== ts.SyntaxKind.Identifier || scanner.scan() !== ts.SyntaxKind.EndOfFileToken) throw new RpcError(-32602, "Enter an identifier.");
            const locations = this.service.findRenameLocations(file.path, offset, false, false, { providePrefixAndSuffixTextForRename: true }) ?? [];
            if (locations.length > 1024 || locations.some(location => !this.fileAt(location.fileName))) throw new RpcError(-32602, "Rename exceeds the open demo project.");
            const changes = new Map<string, ts.TextChange[]>();
            for (const location of locations) {
                let edits = changes.get(location.fileName); if (!edits) { edits = []; changes.set(location.fileName, edits); }
                edits.push({ span: location.textSpan, newText: (location.prefixText ?? "") + name + (location.suffixText ?? "") });
            }
            return this.edits([...changes].map(([fileName, textChanges]) => ({ fileName, textChanges })));
        }
        throw new RpcError(-32601, "Unsupported browser demo request.");
    }
    dispose(): void { if (this.disposed) return; this.disposed = true; this.service.dispose(); this.files.clear(); this.libraries.clear(); this.snapshots.clear(); this.completions.clear(); }
}
