import type { DocumentId, Workspace } from "../../src/index.ts";
import { captureViewRequest, createNavigationController, mountAnchoredOverlay } from "../../src/browser/index.ts";
import type { CapturedViewRequest, TextEditor } from "../../src/browser/index.ts";
import type { LspLocation, LspWorkspace } from "../../src/protocol/index.ts";
import { HostRenameTools } from "../hosts/rename.ts";
import { createLspRenameClient } from "../shared/language/lsp-rename-client.ts";
import type { DemoFile } from "./project.ts";
import type { CleanupScope } from "../shared/cleanup-scope.ts";

export type DemoSymbolTarget = Readonly<{ documentId: DocumentId; revision: number; from: number; to: number }>;

/** Host presentation around validated public results. Navigation may replace this editor view. */
export function mountDemoSymbols(scope: CleanupScope, workspace: Workspace, files: () => readonly DemoFile[], file: DemoFile, editor: TextEditor,
    provider: LspWorkspace, valid: () => boolean, dismissOther: () => void, open: (target: DemoSymbolTarget) => void) {
    const events = new AbortController(); let disposed = false;
    scope.defer(() => { disposed = true; events.abort(); });
    const popup = document.createElement("section"); scope.defer(() => popup.remove());
    popup.className = "demo-symbols"; popup.hidden = true; popup.setAttribute("aria-label", "Symbol locations");
    const renamePopup = document.createElement("section"); scope.defer(() => renamePopup.remove());
    renamePopup.className = "demo-rename"; renamePopup.hidden = true;
    renamePopup.setAttribute("role", "dialog"); renamePopup.setAttribute("aria-label", "Rename symbol");
    document.body.append(popup, renamePopup);
    const locationsOverlay = mountAnchoredOverlay(editor, popup);
    const renameOverlay = mountAnchoredOverlay(editor, renamePopup, { onFocusedAnchorHidden: editor.focus });
    scope.defer(locationsOverlay.dispose); scope.defer(renameOverlay.dispose);
    type Query = { choice: number; message: string; offset: number; source: CapturedViewRequest; current: () => boolean; result?: Awaited<ReturnType<typeof navigation.request>> };
    let query: Query | undefined;
    const idle = () => { const s = editor.activity(); return !disposed && valid() && !s.composing && !s.pendingInput && !s.pendingCommand; };
    const navigation = createNavigationController(editor, provider, { canCapture: idle, documents: () => files().map(file => workspace.document(file.resource.documentId)),
        onDefinition: offset => request("definition", offset) });
    scope.defer(navigation.dispose);
    const target = workspace.tabs.capture(file.tab);
    const captureSource = (available: () => boolean, revealCaret = true) => {
        const caret = editor.view.getSnapshot().selection;
        if (revealCaret) editor.viewport.revealOffset(caret.head, { horizontal: "nearest", vertical: "nearest", affinity: caret.headAffinity ?? "after" });
        return captureViewRequest(workspace, target, editor.view, { available });
    };
    const sourceAnchor = (capture: CapturedViewRequest) => {
        const caret = capture.selectionSet.ranges[capture.selectionSet.primary]!;
        return { revision: capture.document.revision, offset: caret.head, affinity: caret.headAffinity ?? "after" };
    };
    const cancelNavigation = () => {
        const previous = query; query = undefined;
        locationsOverlay.hide(); previous?.source.cancel(); navigation.cancel();
    };
    scope.defer(cancelNavigation);
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
        const close = document.createElement("button"); close.textContent = "Close locations"; close.addEventListener("click", () => { if (query === captured) { cancelNavigation(); editor.focus(); } });
        popup.replaceChildren(note, pages, ...buttons, close); locationsOverlay.show({ revision: captured.source.document.revision, offset: captured.offset }); markChoice(captured);
        if (focused) editor.focus();
    };
    function request(kind: "definition" | "references", pointed?: number) {
        if (!idle()) return; dismissOther(); closeRename(false); cancelNavigation(); editor.focus();
        const source = captureSource(() => idle() && (document.activeElement === editor.input || popup.contains(document.activeElement)), pointed === undefined);
        if (!source) return;
        const snapshots = files().map(file => workspace.document(file.resource.documentId));
        const others = snapshots.filter(doc => doc.id !== source.document.id), metadata = others.map(doc => workspace.resourceForDocument(doc.id).metadata.getSnapshot());
        const captured: Query = { choice: 0, message: "", offset: pointed ?? sourceAnchor(source).offset, source, current: () => source.isCurrent()
            && others.every((doc, i) => { const current = workspace.document(doc.id), access = workspace.resourceForDocument(doc.id).metadata.getSnapshot();
                return current.revision === doc.revision && current.buffer === doc.buffer && access.editLock === metadata[i]!.editLock && access.capabilities === metadata[i]!.capabilities; }) };
        query = captured; showNavigation(captured, kind === "definition" ? "Finding definition…" : "Finding references…");
        void navigation.request(kind, captured.offset).then(result => {
            if (query !== captured || !captured.current() || !result.isCurrent()) return;
            captured.result = result;
            if (kind === "definition" && result.locations.length === 1) choose(captured, result.locations[0]!);
            else showNavigation(captured, result.locations.length ? `Choose a ${kind === "definition" ? "definition" : "reference"}.` : `No ${kind} in this sample.`);
        }).catch(error => { if (query === captured && captured.current()) showNavigation(captured,
            error instanceof Error ? `Cannot open this location: ${error.message}` : "This location is unavailable in the sample."); });
    }
    const rename = new HostRenameTools(workspace, () => idle(), id => id === file.resource.documentId && valid() ? editor : undefined,
        () => createLspRenameClient({ provider }), { open: beginRename });
    scope.defer(() => rename.dispose());
    const heading = document.createElement("h2"), status = document.createElement("p"), label = document.createElement("label"), name = document.createElement("input");
    heading.textContent = `Rename in ${file.name}`; status.setAttribute("aria-label", "Rename status"); name.maxLength = 256; label.append("New name ", name);
    const preview = document.createElement("button"), apply = document.createElement("button"), cancel = document.createElement("button"), targets = document.createElement("ol"), pages = document.createElement("div");
    preview.textContent = "Preview rename"; apply.textContent = "Apply rename"; cancel.textContent = "Cancel rename"; targets.setAttribute("aria-label", "Rename edits");
    const previous = document.createElement("button"), next = document.createElement("button"); previous.textContent = "Previous edits"; next.textContent = "Next edits"; pages.append(previous, next);
    renamePopup.append(heading, label, status, preview, apply, cancel, targets, pages);
    let renameSource: CapturedViewRequest | undefined;
    const closeRename = (focus: boolean) => {
        const previous = renameSource; renameSource = undefined;
        renameOverlay.hide(); previous?.cancel(); rename.cancel(); if (focus && valid()) editor.focus();
    };
    scope.defer(() => closeRename(false));
    function beginRename() {
        if (!idle()) return false;
        dismissOther(); cancelNavigation(); closeRename(false);
        const source = captureSource(idle); if (!source) return false;
        renameSource = source;
        source.signal.addEventListener("abort", () => {
            if (renameSource === source) closeRename(rename.state.getSnapshot().status === "applied" || renamePopup.contains(document.activeElement));
        }, { once: true });
        // F2 gives the name field focus immediately, including before the first placement frame.
        renamePopup.hidden = false; renameOverlay.show(sourceAnchor(source)); return true;
    }
    name.addEventListener("input", () => rename.setName(name.value), { signal: events.signal });
    preview.addEventListener("click", rename.prepare, { signal: events.signal }); cancel.addEventListener("click", () => closeRename(true), { signal: events.signal });
    previous.addEventListener("click", rename.previousPage, { signal: events.signal }); next.addEventListener("click", rename.nextPage, { signal: events.signal });
    rename.bindName(name); scope.defer(() => rename.bindName(null));
    scope.defer(rename.state.subscribe(() => {
        const state = rename.state.getSnapshot();
        status.textContent = state.status === "pending" ? "Preparing rename preview…" : state.status === "ready" ? state.message
            : state.status === "expired" ? "The code or selection changed. Preview again." : state.status === "failed" ? state.message : "Enter a name, then preview its changes.";
        if (name.value !== state.name) name.value = state.name;
        apply.disabled = !state.canApply; apply.onclick = () => rename.apply(state.token); preview.disabled = state.pending || !state.name.trim();
        targets.replaceChildren(...state.locations.map(at => { const item = document.createElement("li"), before = document.createElement("del"), after = document.createElement("ins"), code = document.createElement("code");
            before.textContent = at.before ?? state.symbol; after.textContent = at.after ?? state.name; code.append(before, " → ", after); item.append(`${at.title} · ${at.line + 1}:${at.column + 1} `, code); return item; }));
        pages.hidden = state.count <= 64; previous.disabled = state.page === 0; next.disabled = (state.page + 1) * 64 >= state.count;
        if (state.status === "applied") queueMicrotask(() => { if (!disposed && rename.state.getSnapshot() === state) closeRename(true); });
    }));
    popup.addEventListener("pointerdown", event => event.preventDefault(), { signal: events.signal });
    renamePopup.addEventListener("keydown", event => { if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); closeRename(true); } }, { capture: true, signal: events.signal });
    editor.input.addEventListener("keydown", event => {
        if (event.defaultPrevented || event.isComposing || editor.activity().composing || event.ctrlKey || event.metaKey || event.altKey) return;
        if (event.key === "F12") { event.preventDefault(); event.stopImmediatePropagation(); request(event.shiftKey ? "references" : "definition"); }
        else if (event.key === "Escape" && query) { event.preventDefault(); event.stopImmediatePropagation(); cancelNavigation(); }
        else if (event.key === "Escape" && renameSource) { event.preventDefault(); event.stopImmediatePropagation(); closeRename(true); }
        else if (query?.result?.locations.length && !popup.hidden && !event.shiftKey) {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault(); event.stopImmediatePropagation();
                const previousPage = Math.floor(query.choice / 64);
                query.choice = (query.choice + (event.key === "ArrowDown" ? 1 : query.result.locations.length - 1)) % query.result.locations.length;
                if (Math.floor(query.choice / 64) !== previousPage) showNavigation(query, query.message); else markChoice(query);
            } else if (event.key === "Enter") { event.preventDefault(); event.stopImmediatePropagation(); choose(query, query.result.locations[query.choice]!); }
        }
    }, { capture: true, signal: events.signal });
    scope.defer(rename.attach("source", file.tab, editor));
    const changed = () => { const captured = query; if (captured && (!captured.current() || captured.result && !captured.result.isCurrent())) {
        query = undefined; locationsOverlay.hide(); queueMicrotask(() => { captured.source.cancel(); if (!disposed && !query) navigation.cancel(); });
    } };
    // Expanded discovery metadata does not change the captured source projection.
    for (const state of [editor.view, editor.view.folding, workspace.tabs, provider]) scope.defer(state.subscribe(changed));
    for (const file of files()) {
        scope.defer(workspace.observeDocument(file.resource.documentId).subscribe(changed));
        scope.defer(file.resource.metadata.subscribe(changed));
    }
    editor.input.addEventListener("blur", () => queueMicrotask(() => { if (!disposed) changed(); }), { signal: events.signal });
    return Object.freeze({ definition: () => request("definition"), references: () => request("references"), rename: () => editor.commands.run("rename.start"),
        dismiss: () => { cancelNavigation(); closeRename(false); }, isOpen: () => !!query || !!renameSource });
}
