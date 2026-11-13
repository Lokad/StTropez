import type { DocumentId, Workspace } from "../../src/index.ts";
import type { EditingCandidate } from "../../src/browser/index.ts";
import { createLspNavigationClient } from "../../src/protocol/index.ts";
import type { LspLocation, LspWorkspace } from "../../src/protocol/index.ts";
import { HostRenameTools } from "../hosts/rename.ts";
import { createLspRenameClient } from "../editing/lsp-rename-client.ts";
import type { DemoFile } from "./project.ts";

export type DemoSymbolTarget = Readonly<{ documentId: DocumentId; revision: number; from: number; to: number }>;

/** Host presentation around validated public results. Navigation may replace this editor view. */
export function mountDemoSymbols(workspace: Workspace, files: () => readonly DemoFile[], file: DemoFile, editor: EditingCandidate,
    provider: LspWorkspace, valid: () => boolean, dismissOther: () => void, open: (target: DemoSymbolTarget) => void) {
    const events = new AbortController(), navigation = createLspNavigationClient(provider);
    const popup = document.createElement("section"); popup.className = "demo-symbols"; popup.hidden = true; popup.setAttribute("aria-label", "Symbol locations");
    const renamePopup = document.createElement("section"); renamePopup.className = "demo-rename"; renamePopup.hidden = true;
    renamePopup.setAttribute("role", "dialog"); renamePopup.setAttribute("aria-label", "Rename symbol");
    document.body.append(popup, renamePopup);
    let disposed = false;
    type Query = { choice: number; message: string; current: () => boolean; result?: Awaited<ReturnType<typeof navigation.run>> };
    let query: Query | undefined;
    const idle = () => { const s = editor.snapshot(); return !disposed && valid() && !s.composing && !s.pendingInput && !s.pendingCommand; };
    const position = (element: HTMLElement) => {
        const point = editor.viewport.coordsAt(editor.view.getSnapshot().selection.head), box = editor.element.getBoundingClientRect();
        element.style.left = `${Math.max(8, Math.min(innerWidth - 360, point?.left ?? box.left + 8))}px`;
        element.style.top = `${Math.max(8, Math.min(innerHeight - 280, point ? point.top + point.height + 6 : box.top + 8))}px`;
    };
    const cancelNavigation = () => { query = undefined; popup.hidden = true; navigation.cancel(); };
    const markChoice = (captured: Query) => {
        for (const button of popup.querySelectorAll<HTMLButtonElement>("[data-location]")) button.dataset.chosen = String(Number(button.dataset.location) === captured.choice);
        popup.querySelector<HTMLElement>('[data-chosen="true"]')?.scrollIntoView({ block: "nearest" });
    };
    const choose = (captured: Query, location: LspLocation) => {
        if (query !== captured || !captured.current() || !captured.result?.isCurrent() || !location.target.isCurrent()) return;
        const file = files().find(file => file.resource.documentId === location.target.document.documentId); if (!file) return;
        const target = { documentId: file.resource.documentId, revision: location.target.document.revision, from: location.from, to: location.to };
        cancelNavigation(); open(target);
    };
    const showNavigation = (captured: Query, message: string) => {
        captured.message = message;
        const focused = popup.contains(document.activeElement);
        const note = document.createElement("p"); note.textContent = message;
        const first = Math.floor(captured.choice / 64) * 64, total = captured.result?.locations.length ?? 0;
        const buttons = captured.result?.locations.slice(first, first + 64).flatMap((location, index) => {
            const file = files().find(file => file.resource.documentId === location.target.document.documentId); if (!file) return [];
            const button = document.createElement("button"), doc = workspace.document(file.resource.documentId), line = doc.buffer.lineAt(location.from);
            button.textContent = `${doc.title} · ${line + 1}:${location.from - doc.buffer.offsetAt(line) + 1}`;
            button.dataset.location = String(first + index);
            button.addEventListener("click", () => choose(captured, location)); return button;
        }) ?? [];
        const pages = document.createElement("div"), previous = document.createElement("button"), next = document.createElement("button"), count = document.createElement("span");
        previous.textContent = "Previous locations"; next.textContent = "Next locations"; pages.hidden = total <= 64;
        previous.disabled = first === 0; next.disabled = first + 64 >= total; count.textContent = `${first + 1}–${Math.min(first + 64, total)} of ${total}`;
        const move = (direction: number) => {
            if (query !== captured || !captured.current() || !captured.result?.isCurrent()) return;
            captured.choice = first + direction * 64; showNavigation(captured, message);
        };
        previous.onclick = () => move(-1); next.onclick = () => move(1); pages.append(previous, count, next);
        const close = document.createElement("button"); close.textContent = "Close locations"; close.addEventListener("click", () => { cancelNavigation(); editor.focus(); });
        popup.replaceChildren(note, pages, ...buttons, close); popup.hidden = false; position(popup); markChoice(captured);
        if (focused) editor.focus();
    };
    const request = (kind: "definition" | "references") => {
        if (!idle()) return; dismissOther(); closeRename(false); cancelNavigation(); editor.focus();
        const snapshots = files().map(file => workspace.document(file.resource.documentId)), selected = editor.view.getSnapshot().selectionSet;
        const folds = editor.view.folding.getSnapshot().index, metadata = snapshots.map(doc => workspace.resourceForDocument(doc.id).metadata.getSnapshot());
        const captured: Query = { choice: 0, message: "", current: () => idle() && editor.view.getSnapshot().selectionSet === selected
            && folds.sameProjection(editor.view.folding.getSnapshot().index) && (document.activeElement === editor.input || popup.contains(document.activeElement))
            && snapshots.every((doc, i) => { const current = workspace.document(doc.id), access = workspace.resourceForDocument(doc.id).metadata.getSnapshot();
                return current.revision === doc.revision && current.buffer === doc.buffer && access.editLock === metadata[i]!.editLock && access.capabilities === metadata[i]!.capabilities; }) };
        query = captured; showNavigation(captured, kind === "definition" ? "Finding definition…" : "Finding references…");
        void navigation.run(snapshots, file.resource.documentId, editor.view.getSnapshot().selection.head, kind).then(result => {
            if (query !== captured || !captured.current() || !result.isCurrent()) return;
            captured.result = result;
            if (kind === "definition" && result.locations.length === 1) choose(captured, result.locations[0]!);
            else showNavigation(captured, result.locations.length ? `Choose a ${kind === "definition" ? "definition" : "reference"}.` : `No ${kind} in this sample.`);
        }).catch(error => { if (query === captured && captured.current()) showNavigation(captured,
            error instanceof Error ? `Cannot open this location: ${error.message}` : "This location is unavailable in the sample."); });
    };
    const rename = new HostRenameTools(workspace, () => idle(), id => id === file.resource.documentId && valid() ? editor : undefined, () => createLspRenameClient({ provider }));
    const heading = document.createElement("h2"), status = document.createElement("p"), label = document.createElement("label"), name = document.createElement("input");
    heading.textContent = `Rename in ${file.name}`; status.setAttribute("aria-label", "Rename status"); name.maxLength = 256; label.append("New name ", name);
    const preview = document.createElement("button"), apply = document.createElement("button"), cancel = document.createElement("button"), targets = document.createElement("ol"), pages = document.createElement("div");
    preview.textContent = "Preview rename"; apply.textContent = "Apply rename"; cancel.textContent = "Cancel rename"; targets.setAttribute("aria-label", "Rename edits");
    const previous = document.createElement("button"), next = document.createElement("button"); previous.textContent = "Previous edits"; next.textContent = "Next edits"; pages.append(previous, next);
    renamePopup.append(heading, label, status, preview, apply, cancel, targets, pages);
    const closeRename = (focus: boolean) => { renamePopup.hidden = true; rename.cancel(); if (focus && valid()) editor.focus(); };
    const beginRename = () => { if (!idle()) return; dismissOther(); cancelNavigation(); renamePopup.hidden = false; position(renamePopup); rename.begin("source"); };
    name.addEventListener("input", () => rename.setName(name.value), { signal: events.signal });
    preview.addEventListener("click", rename.prepare, { signal: events.signal }); cancel.addEventListener("click", () => closeRename(true), { signal: events.signal });
    previous.addEventListener("click", rename.previousPage, { signal: events.signal }); next.addEventListener("click", rename.nextPage, { signal: events.signal });
    rename.bindName(name);
    const stopRename = rename.state.subscribe(() => {
        const state = rename.state.getSnapshot();
        status.textContent = state.status === "pending" ? "Preparing rename preview…" : state.status === "ready" ? `Review ${state.count} changes before applying.`
            : state.status === "expired" ? "The code or selection changed. Preview again." : state.status === "failed" ? state.message : "Enter a name, then preview its changes.";
        if (name.value !== state.name) name.value = state.name;
        apply.disabled = !state.canApply; apply.onclick = () => rename.apply(state.token); preview.disabled = state.pending || !state.name.trim();
        targets.replaceChildren(...state.locations.map(at => { const item = document.createElement("li"), before = document.createElement("del"), after = document.createElement("ins"), code = document.createElement("code");
            before.textContent = at.before ?? state.symbol; after.textContent = at.after ?? state.name; code.append(before, " → ", after); item.append(`${at.title} · ${at.line + 1}:${at.column + 1} `, code); return item; }));
        pages.hidden = state.count <= 64; previous.disabled = state.page === 0; next.disabled = (state.page + 1) * 64 >= state.count;
        if (state.status === "applied") queueMicrotask(() => { if (!disposed && rename.state.getSnapshot() === state) closeRename(true); });
    });
    popup.addEventListener("pointerdown", event => event.preventDefault(), { signal: events.signal });
    renamePopup.addEventListener("keydown", event => { if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); closeRename(true); } }, { capture: true, signal: events.signal });
    editor.input.addEventListener("keydown", event => {
        if (event.defaultPrevented || event.isComposing || editor.snapshot().composing || event.ctrlKey || event.metaKey || event.altKey) return;
        if (event.key === "F12") { event.preventDefault(); event.stopImmediatePropagation(); request(event.shiftKey ? "references" : "definition"); }
        else if (event.key === "F2" && !event.shiftKey) { event.preventDefault(); event.stopImmediatePropagation(); beginRename(); }
        else if (event.key === "Escape" && query) { event.preventDefault(); event.stopImmediatePropagation(); cancelNavigation(); }
        else if (query?.result?.locations.length && !event.shiftKey) {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault(); event.stopImmediatePropagation();
                const previousPage = Math.floor(query.choice / 64);
                query.choice = (query.choice + (event.key === "ArrowDown" ? 1 : query.result.locations.length - 1)) % query.result.locations.length;
                if (Math.floor(query.choice / 64) !== previousPage) showNavigation(query, query.message); else markChoice(query);
            } else if (event.key === "Enter") { event.preventDefault(); event.stopImmediatePropagation(); choose(query, query.result.locations[query.choice]!); }
        }
    }, { capture: true, signal: events.signal });
    const detachRename = rename.attach("source", file.tab, editor);
    const changed = () => { const captured = query; if (captured && (!captured.current() || captured.result && !captured.result.isCurrent())) {
        query = undefined; popup.hidden = true; queueMicrotask(() => { if (!disposed && !query) navigation.cancel(); });
    } };
    // Expanded discovery metadata does not change the captured source projection.
    const stops = [editor.view.subscribe(changed), editor.view.folding.subscribe(changed), workspace.tabState.subscribe(changed), provider.state.subscribe(changed),
        ...files().flatMap(file => [workspace.observeDocument(file.resource.documentId).subscribe(changed), file.resource.metadata.subscribe(changed)])];
    editor.input.addEventListener("blur", () => queueMicrotask(() => { if (!disposed) changed(); }), { signal: events.signal });
    return Object.freeze({ definition: () => request("definition"), references: () => request("references"), rename: beginRename,
        dismiss: () => { cancelNavigation(); closeRename(false); }, isOpen: () => !!query || !renamePopup.hidden,
        destroy: () => { disposed = true; events.abort(); stops.forEach(stop => stop()); detachRename(); stopRename(); rename.bindName(null); rename.dispose(); navigation.dispose(); popup.remove(); renamePopup.remove(); } });
}
