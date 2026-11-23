import type { DocumentId, Workspace } from "../../src/index.ts";
import { captureViewRequest, createNavigationController, mountAnchoredOverlay } from "../../src/browser/index.ts";
import type { CapturedViewRequest, NavigationChoice, NavigationPage, TextEditor } from "../../src/browser/index.ts";
import type { LspWorkspace } from "../../src/protocol/index.ts";
import { HostRenameTools } from "../hosts/rename.ts";
import { pageActions, renderPanelActions, renderPanelButton } from "../hosts/panel-actions.ts";
import type { DemoFile } from "./project.ts";
import type { CleanupScope } from "../shared/cleanup-scope.ts";
import { bindPopupCommands } from "./language-commands.ts";
import { locationExcerpt } from "../shared/location-excerpt.ts";

export type DemoSymbolTarget = Readonly<{ documentId: DocumentId; revision: number; from: number; to: number }>;

function locationButton(file: DemoFile, location: NavigationChoice): HTMLButtonElement {
    const excerpt = locationExcerpt(location);
    const button = document.createElement("button"), code = document.createElement("code"), match = document.createElement("mark");
    button.textContent = file.name + " · " + excerpt.line + ":" + excerpt.column;
    match.textContent = excerpt.match;
    code.append(excerpt.before, match, excerpt.after);
    button.append(code);
    return button;
}

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
    document.body.append(popup);
    (editor.element.closest("#workspace") ?? editor.element.ownerDocument.body).append(renamePopup);
    const locationsOverlay = mountAnchoredOverlay(editor, popup, { dismissOn: ["focus-leave"], onDismiss: () => cancelNavigation() });
    scope.defer(locationsOverlay.dispose);
    type Query = { message: string; offset: number; revision: number; page: NavigationPage | undefined };
    let query: Query | undefined;
    const idle = () => { const s = editor.activity(); return !disposed && valid() && !s.composing && !s.pendingInput && !s.pendingCommand; };
    const navigation = createNavigationController(editor, provider, { canCapture: idle, resultLifetime: "view", documents: () => files().map(file => workspace.document(file.resource.documentId)),
        onDefinition: offset => request("definition", offset) });
    scope.defer(navigation.dispose);
    const pendingNavigation = editor.latestOperation();
    scope.defer(pendingNavigation.dispose);
    const target = workspace.tabs.capture(file.tab);
    const hideLocations = () => { pendingNavigation.cancel(); query = undefined; locationsOverlay.hide(); };
    const cancelNavigation = () => { hideLocations(); navigation.cancel(); };
    scope.defer(cancelNavigation);
    const markChoice = (captured: Query) => {
        for (const button of popup.querySelectorAll<HTMLButtonElement>("[data-location]")) button.dataset.chosen = String(Number(button.dataset.location) === captured.page?.selected.index);
        popup.querySelector<HTMLElement>('[data-chosen="true"]')?.scrollIntoView({ block: "nearest" });
    };
    const choose = (choice: NavigationChoice) => choice.open(at => {
        const file = files().find(file => file.resource.documentId === at.document.documentId); if (!file) return;
        cancelNavigation(); open({ documentId: file.resource.documentId, revision: at.document.revision, from: at.from, to: at.to });
    });
    const showNavigation = (captured: Query, message: string) => {
        captured.message = message;
        const focused = popup.contains(document.activeElement);
        const note = document.createElement("p"); note.textContent = message;
        const page = captured.page;
        const buttons: HTMLButtonElement[] = [];
        for (const location of page?.locations ?? []) {
            const file = files().find(file => file.resource.documentId === location.document.documentId); if (!file) continue;
            const button = locationButton(file, location);
            button.dataset.location = String(location.index);
            button.addEventListener("click", () => choose(location)); buttons.push(button);
        }
        const pages = document.createElement("div"), previous = document.createElement("button"), next = document.createElement("button"), count = document.createElement("span");
        previous.textContent = "Previous locations"; next.textContent = "Next locations";
        previous.disabled = !page?.previousPage; next.disabled = !page?.nextPage; pages.hidden = previous.disabled && next.disabled;
        if (page) count.textContent = `${page.first + 1}–${page.first + page.locations.length} of ${page.count}`;
        const movePage = (action: "previousPage" | "nextPage") => {
            if (query !== captured || captured.page?.first !== page?.first) return;
            const moved = captured.page?.[action]?.();
            if (moved) { captured.page = moved; showNavigation(captured, message); }
        };
        previous.onclick = () => movePage("previousPage"); next.onclick = () => movePage("nextPage"); pages.append(previous, count, next);
        const close = document.createElement("button"); close.textContent = "Close locations"; close.addEventListener("click", () => { if (query === captured) { cancelNavigation(); editor.focus(); } });
        const rows = document.createElement("div"); rows.className = "demo-location-rows"; rows.append(...buttons);
        popup.replaceChildren(note, pages, rows, close); locationsOverlay.show({ revision: captured.revision, offset: captured.offset }); markChoice(captured);
        if (focused) editor.focus();
    };
    function request(kind: "definition" | "references", pointed?: number) {
        if (!idle()) return; dismissOther(); closeRename(false); cancelNavigation(); editor.focus();
        const caret = editor.view.getSnapshot().selection;
        if (pointed === undefined) editor.viewport.revealOffset(caret.head, { affinity: caret.headAffinity ?? "after" });
        void pendingNavigation.run({}, op => {
            const captured: Query = { page: undefined, message: "", offset: pointed ?? caret.head, revision: op.document.revision };
            query = captured; showNavigation(captured, kind === "definition" ? "Finding definition…" : "Finding references…");
            const reply = navigation.request(kind, captured.offset).catch((error: unknown) =>
                error instanceof Error ? `Cannot open this location: ${error.message}` : "This location is unavailable in the sample.");
            return op.step(reply, result => {
                if (typeof result === "string") { showNavigation(captured, result); return; }
                if (kind === "definition" && result.count === 1) { choose(result.locationAt(0)!); return; }
                captured.page = result.pageFor();
                showNavigation(captured, result.count ? `Choose a ${kind === "definition" ? "definition" : "reference"}.` : `No ${kind} in this sample.`);
            });
        }).catch(reportError);
    }
    const rename = new HostRenameTools({ workspace, canCapture: idle, present: id => id === file.resource.documentId && valid() ? editor : undefined },
        { provider, open: beginRename });
    scope.defer(() => rename.dispose());
    const heading = document.createElement("h2"), status = document.createElement("p"), label = document.createElement("label"), name = document.createElement("input");
    heading.textContent = `Rename in ${file.name}`; status.setAttribute("aria-label", "Rename status"); name.maxLength = 256; label.append("New name ", name);
    const preview = document.createElement("button"), cancel = document.createElement("button"), targets = document.createElement("ol"), pages = document.createElement("div");
    let apply = renderPanelButton(document.createElement("button"), { label: "Apply rename", disabled: true, invoke: null });
    preview.textContent = "Preview rename"; cancel.textContent = "Cancel rename"; targets.setAttribute("aria-label", "Rename edits");
    const controls = document.createElement("div");
    controls.append(preview, apply, cancel); targets.tabIndex = 0;
    renamePopup.append(heading, label, status, controls, pages, targets);
    let renameSource: CapturedViewRequest | undefined;
    const closeRename = (focus: boolean) => {
        const previous = renameSource; renameSource = undefined;
        renamePopup.hidden = true; previous?.cancel(); rename.cancel(); if (focus && valid()) editor.focus();
    };
    scope.defer(() => closeRename(false));
    function beginRename() {
        if (!idle()) return false;
        dismissOther(); cancelNavigation(); closeRename(false);
        const caret = editor.view.getSnapshot().selection;
        editor.viewport.revealOffset(caret.head, { affinity: caret.headAffinity ?? "after" });
        const source = captureViewRequest(workspace, target, editor.view, { available: idle }); if (!source) return false;
        renameSource = source;
        source.signal.addEventListener("abort", () => {
            if (renameSource === source) closeRename(rename.state.getSnapshot().status === "applied" || renamePopup.contains(document.activeElement));
        }, { once: true });
        renamePopup.hidden = false; return true;
    }
    name.addEventListener("input", () => rename.setName(name.value), { signal: events.signal });
    preview.addEventListener("click", rename.prepare, { signal: events.signal }); cancel.addEventListener("click", () => closeRename(true), { signal: events.signal });
    rename.bindName(name); scope.defer(() => rename.bindName(null));
    let displayed = rename.state.getSnapshot().locations;
    scope.defer(rename.state.subscribe(() => {
        const state = rename.state.getSnapshot();
        status.textContent = state.status === "pending" ? "Preparing rename preview…" : state.status === "ready" ? state.message
            : state.status === "expired" ? "The code or selection changed. Preview again." : state.status === "failed" ? state.message : "Enter a name, then preview its changes.";
        if (name.value !== state.name) name.value = state.name;
        apply = renderPanelButton(apply, { label: "Apply rename", reviewKey: state.reviewKey, disabled: !state.canApply, invoke: state.preview?.confirm ?? null });
        preview.disabled = state.pending || !state.name.trim();
        if (displayed !== state.locations) {
            displayed = state.locations; targets.start = (displayed[0]?.ordinal ?? 0) + 1;
            targets.replaceChildren(...displayed.map(at => {
                const item = document.createElement("li"), before = document.createElement("del"), after = document.createElement("ins"), code = document.createElement("code");
                before.textContent = at.before; after.textContent = at.after; code.append(before, " → ", after);
                item.append(`${at.title} · ${at.line + 1}:${at.column + 1} `, code); return item;
            }));
            targets.scrollTop = 0;
        }
        renderPanelActions(pages, pageActions("edits", state.paging)); pages.hidden = !state.paging;
        if (state.status === "applied") queueMicrotask(() => { if (!disposed && rename.state.getSnapshot() === state) closeRename(true); });
    }));
    popup.addEventListener("pointerdown", event => event.preventDefault(), { signal: events.signal });
    renamePopup.addEventListener("keydown", event => {
        if (event.target === targets && ["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) return;
        if (event.target !== name && editor.keymap.handle(event)) event.stopPropagation();
    }, { signal: events.signal });
    scope.defer(editor.commands.register({ id: "rename.dismiss", label: "Dismiss rename",
        enabled: () => !!renameSource && (editor.getSnapshot().focused || renamePopup.matches(":focus-within")),
        run: () => closeRename(true) }, { keys: ["Escape"], priority: 39, shared: true }).dispose);
    const bind = bindPopupCommands(scope, editor, popup, 36);
    bind("locations.dismiss", "Close locations", "Escape", () => { cancelNavigation(); editor.focus(); });
    const move = (direction: -1 | 1, byPage = false) => {
        const result = navigation.getSnapshot().result;
        if (!query?.page || !result) return false;
        const focused = popup.querySelector<HTMLElement>("[data-location]:focus")?.dataset.location;
        const current = focused === undefined ? query.page : result.pageFor(Number(focused));
        if (!current) return false;
        let moved: NavigationPage | undefined;
        if (!byPage) moved = current.moveSelection(direction);
        else if (direction < 0) moved = current.previousPage?.() ?? result.pageFor(0);
        else moved = current.nextPage?.() ?? result.pageFor(result.count - 1);
        if (!moved) return false;
        editor.focus();
        const first = query.page.first;
        query.page = moved;
        if (query.page.first !== first) showNavigation(query, query.message); else markChoice(query);
        return true;
    };
    bind("locations.previous", "Previous location", "ArrowUp", () => move(-1));
    bind("locations.next", "Next location", "ArrowDown", () => move(1));
    bind("locations.pageUp", "Previous locations page", "PageUp", () => move(-1, true));
    bind("locations.pageDown", "Next locations page", "PageDown", () => move(1, true));
    bind("locations.open", "Open selected location", "Enter", () => {
        const location = query?.page?.selected;
        return !!location && choose(location);
    });
    scope.defer(rename.attach("source", file.tab, editor));
    scope.defer(navigation.subscribe(() => {
        const status = navigation.getSnapshot().status;
        if (query && (status === "expired" || status === "idle")) hideLocations();
    }));
    return Object.freeze({ definition: () => request("definition"), references: () => request("references"), rename: () => editor.commands.run("rename.start"),
        dismiss: () => { cancelNavigation(); closeRename(false); }, isOpen: () => !!query || !!renameSource });
}
