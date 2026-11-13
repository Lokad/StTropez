import type { InlineDecoration, PresentedLine, EditingCandidate } from "../../src/browser/index.ts";
import type { LanguageConfiguration } from "../../src/index.ts";
import type { DemoFile, DemoProject } from "./project.ts";
import { HostTablePaste } from "../hosts/table-paste.ts";
import type { HostSourceNotes } from "../shared/source-notes.ts";

export const exampleTable = "sku\tquantity\nA-100\t12\nB-200\t8\n";
export function hostConfiguration(tabSize: number, insertSpaces: boolean): LanguageConfiguration {
    return { tabSize, insertSpaces, lineComment: "#", pairs: [{ open: "(", close: ")" }, { open: "[", close: "]" }],
        enter: ({ buffer, from }) => ({ indent: buffer.slice(Math.max(buffer.offsetAt(buffer.lineAt(from)), from - 256), from).trimEnd().endsWith(":") ? 1 : 0 }) };
}
/** Tiny example-owned lexer over bounded presented fragments, with no compiler/provider dependency. */
export function hostDecorations(line: PresentedLine): readonly InlineDecoration[] {
    return [...line.text.matchAll(/#[^\n]*|"(?:""|[^"\n])*"|\b(?:dataset|columns|row|rule|when|emit)\b|\b\d+(?:\.\d+)?\b/g)].map(match => ({
        from: line.from + match.index, to: line.from + match.index + match[0].length,
        className: match[0].startsWith("#") ? "demo-token-comment" : match[0].startsWith('"') ? "demo-token-string" : /^\d/.test(match[0]) ? "demo-token-number" : "demo-token-keyword" }));
}

function mountNotes(model: HostSourceNotes, project: DemoProject, file: DemoFile, editor: EditingCandidate) {
    const layer = document.createElement("div"), events = new AbortController(), nodes = new Map<number, HTMLSpanElement>();
    layer.className = "demo-source-notes"; layer.setAttribute("aria-label", "Host source notes"); document.body.append(layer);
    const render = () => {
        const doc = project.workspace.document(file.resource.documentId), state = model.state.getSnapshot(), box = editor.element.getBoundingClientRect();
        const shown = new Set<number>();
        if (state.revision === doc.revision && editor.element.isConnected) for (const note of state.notes) {
            const point = editor.viewport.coordsAt(note.range.from); if (!point || point.top < box.top || point.top + point.height > box.bottom) continue;
            const folded = editor.view.folding.getSnapshot().index.hiddenBy(doc.buffer.lineAt(note.range.from));
            const text = note.text + (folded ? " · folded" : ""), node = nodes.get(note.id) ?? document.createElement("span");
            if (!nodes.has(note.id)) { nodes.set(note.id, node); layer.append(node); }
            if (node.textContent !== text) node.textContent = text;
            node.dataset.note = String(note.id); node.dataset.line = String(doc.buffer.lineAt(note.range.from) + 1);
            node.style.top = `${point.top}px`; node.style.right = `${Math.max(12, innerWidth - box.right + 24)}px`; node.style.maxWidth = `${Math.max(80, box.width * .4)}px`;
            shown.add(note.id);
        }
        for (const [id, node] of nodes) if (!shown.has(id)) { node.remove(); nodes.delete(id); }
    };
    const stop = model.state.subscribe(render), stopFolds = editor.view.folding.subscribe(render);
    editor.element.addEventListener("sttropez-render", render, { signal: events.signal });
    window.addEventListener("resize", render, { signal: events.signal }); render();
    return () => { events.abort(); stop(); stopFolds(); layer.remove(); nodes.clear(); };
}

/** The sample composes the public editor hooks; formatting, UI and note content stay in the host. */
export function mountHostIntegrations(project: DemoProject, file: DemoFile, editor: EditingCandidate,
    controls: Readonly<{ mode: HTMLSelectElement; insert: HTMLButtonElement; annotate: HTMLButtonElement; status: HTMLElement }>) {
    const table = new HostTablePaste(project.workspace), events = new AbortController(), model = project.notesFor(file);
    const stopNotes = mountNotes(model, project, file, editor), detach = table.attach("source", file.tab, editor);
    const mode = () => { table.setEnabled(controls.mode.value === "csv"); };
    const renderStatus = () => { controls.status.textContent = table.state.getSnapshot().message; };
    const stop = table.state.subscribe(renderStatus); mode(); renderStatus();
    controls.mode.addEventListener("change", () => { mode(); editor.focus(); }, { signal: events.signal });
    controls.insert.addEventListener("click", () => {
        if (controls.mode.value === "csv") table.insertTable("source", exampleTable);
        else { const capture = editor.captureInsertion(); controls.status.textContent = capture?.insert(exampleTable) ? "Inserted literal tab-separated example text. Undo restores your selection." : "Finish pending input before inserting."; }
        editor.focus();
    }, { signal: events.signal });
    const annotate = () => {
        const snapshot = editor.snapshot(); if (snapshot.pendingInput || snapshot.pendingCommand || snapshot.composing) return;
        editor.captureView(); const selected = editor.view.getSnapshot();
        const added = model.add(selected.revision, Math.min(selected.selection.anchor, selected.selection.head), Math.max(selected.selection.anchor, selected.selection.head), "Host note");
        controls.status.textContent = added ? "Added a source note. It follows edits and folded lines; deleting its range removes it." : "The note could not be added (64-note limit)."; editor.focus();
    };
    controls.annotate.addEventListener("click", annotate, { signal: events.signal });
    editor.input.addEventListener("keydown", event => {
        if (event.defaultPrevented || event.isComposing || !event.ctrlKey || !event.altKey || event.metaKey || event.shiftKey) return;
        if (event.key.toLowerCase() === "m") { event.preventDefault(); annotate(); }
        if (event.key.toLowerCase() === "v") { event.preventDefault(); controls.mode.value = controls.mode.value === "csv" ? "literal" : "csv"; mode(); }
    }, { capture: true, signal: events.signal });
    return { dispose: () => { events.abort(); detach(); table.cancel(); stop(); stopNotes(); controls.status.textContent = ""; } };
}
