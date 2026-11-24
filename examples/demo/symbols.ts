import type { DocumentId } from "../../src/index.ts";
import { attachEditorLanguage, captureViewRequest, mountAnchoredOverlay } from "../../src/browser/index.ts";
import type { CapturedViewRequest, NavigationChoice, NavigationOrigin, TextEditor } from "../../src/browser/index.ts";
import type { LspWorkspace } from "../../src/protocol/index.ts";
import { HostRenameTools } from "../hosts/rename.ts";
import { pageActions, renderPanelActions, renderPanelButton } from "../hosts/panel-actions.ts";
import type { DemoFile, DemoProject } from "./project.ts";
import type { CleanupScope } from "../shared/cleanup-scope.ts";
import { bindPopupCommands } from "./language-commands.ts";
import { locationExcerpt, locationPage, type NavigationPage } from "../shared/location-excerpt.ts";
import { prepareRenameTarget } from "./rename-target.ts";

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
export function mountDemoSymbols(scope: CleanupScope, project: DemoProject, file: DemoFile, editor: TextEditor,
    provider: LspWorkspace, valid: () => boolean, dismissOther: () => void, open: (target: DemoSymbolTarget, origin: NavigationOrigin) => void,
    notice: (message: string, signal: AbortSignal) => void) {
    const { workspace } = project;
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
    type Query = { kind: "definition" | "references"; message: string; offset: number; revision: number;
        origin: NavigationOrigin; page: NavigationPage | undefined };
    let query: Query | undefined;
    const idle = () => { const s = editor.activity(); return !disposed && valid() && !s.composing && !s.pendingInput && !s.pendingCommand; };
    const language = attachEditorLanguage(editor, provider, { navigation: { canCapture: idle, resultLifetime: "view", documents: () => project.files.map(file => workspace.document(file.resource.documentId)),
        onDefinition: offset => request("definition", offset) } });
    const { navigation } = language;
    scope.defer(language.dispose);
    const target = workspace.tabs.capture(file.tab);
    const hideLocations = () => { query = undefined; locationsOverlay.hide(); };
    const cancelNavigation = () => { hideLocations(); navigation.cancel(); };
    scope.defer(cancelNavigation);
    const markChoice = (captured: Query) => {
        for (const button of popup.querySelectorAll<HTMLButtonElement>("[data-location]")) button.dataset.chosen = String(Number(button.dataset.location) === captured.page?.selected.index);
        popup.querySelector<HTMLElement>('[data-chosen="true"]')?.scrollIntoView({ block: "nearest" });
    };
    const choose = (captured: Query, choice: NavigationChoice) => query === captured && choice.open(at => {
        const file = project.files.find(file => file.resource.documentId === at.document.documentId); if (!file) return;
        cancelNavigation();
        open({ documentId: file.resource.documentId, revision: at.document.revision,
            from: at.from, to: captured.kind === "definition" ? at.from : at.to }, captured.origin);
    });
    const showNavigation = (captured: Query, message: string) => {
        captured.message = message;
        const focused = popup.contains(document.activeElement);
        const note = document.createElement("p"); note.textContent = message;
        const page = captured.page;
        const buttons: HTMLButtonElement[] = [];
        for (const location of page?.locations ?? []) {
            const file = project.files.find(file => file.resource.documentId === location.document.documentId); if (!file) continue;
            const button = locationButton(file, location);
            button.dataset.location = String(location.index);
            button.addEventListener("click", () => choose(captured, location)); buttons.push(button);
        }
        const pages = document.createElement("div"), previous = document.createElement("button"), next = document.createElement("button"), count = document.createElement("span");
        pages.className = "demo-location-pages";
        previous.textContent = "Previous";
        previous.setAttribute("aria-label", "Previous locations");
        next.textContent = "Next";
        next.setAttribute("aria-label", "Next locations");
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
    function request(kind: Query["kind"], pointed?: number) {
        if (!idle()) return; dismissOther(); closeRename(false); cancelNavigation(); editor.focus();
        const caret = editor.view.getSnapshot().selection;
        if (pointed === undefined) editor.viewport.revealOffset(caret.head, {
            affinity: caret.headAffinity ?? "after", vertical: "center-if-outside", horizontal: "nearest",
        });
        const origin = project.navigation.capture(editor, pointed); if (!origin) return;
        const captured: Query = { kind, page: undefined, message: "", offset: pointed ?? caret.head,
            revision: editor.view.getSnapshot().revision, origin };
        query = captured;
        showNavigation(captured, kind === "definition" ? "Finding definition…" : "Finding references…");
        void navigation.request(kind, captured.offset).then(outcome => {
            if (query !== captured) return;
            if (outcome.status === "stale" || outcome.status === "refused") { hideLocations(); return; }
            if (outcome.status === "failed") {
                const message = outcome.error instanceof Error ? outcome.error.message : "Location unavailable.";
                showNavigation(captured, `Cannot open this location: ${message}`);
                return;
            }
            const result = outcome.value;
            if (kind === "definition" && result.count === 1) { choose(captured, result.locationAt(0)!); return; }
            captured.page = locationPage(result);
            showNavigation(captured, result.count ? `Choose a ${kind === "definition" ? "definition" : "reference"}.` : `No ${kind} in this sample.`);
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
    let checking: { edited: boolean; submit: boolean } | undefined;
    const closeRename = (focus: boolean) => {
        const previous = renameSource; renameSource = undefined;
        checking = undefined;
        renamePopup.hidden = true; previous?.cancel(); rename.cancel(); if (focus && valid()) editor.focus();
    };
    scope.defer(() => closeRename(false));
    renamePopup.addEventListener("focusout", event => {
        if (checking && !renamePopup.contains(event.relatedTarget as Node | null)) closeRename(false);
    }, { signal: events.signal });
    window.addEventListener("blur", () => { if (checking) closeRename(false); }, { signal: events.signal });
    function beginRename(prompt: (name?: string) => void) {
        if (!idle()) return false;
        dismissOther(); cancelNavigation(); closeRename(false);
        const caret = editor.view.getSnapshot().selection;
        editor.viewport.revealOffset(caret.head, {
            affinity: caret.headAffinity ?? "after", vertical: "center-if-outside", horizontal: "nearest",
        });
        const source = captureViewRequest(workspace, target, editor.view, { available: idle }); if (!source) return false;
        renameSource = source;
        source.signal.addEventListener("abort", () => {
            if (renameSource === source) closeRename(rename.state.getSnapshot().status === "applied" || renamePopup.contains(document.activeElement));
        }, { once: true });
        const needsCheck = provider.queryFeatureOptions("textDocument/rename", source.document)
            .some(options => options.prepareProvider === true);
        const pending = needsCheck ? { edited: false, submit: false } : undefined;
        checking = pending;
        renamePopup.hidden = false;
        prompt();
        if (!pending) return true;
        const rejectTarget = (message: string) => {
            if (renameSource !== source || !source.isCurrent()) return;
            closeRename(true);
            notice(message, events.signal);
        };
        void prepareRenameTarget(provider, source, caret.head, name.maxLength).then(placeholder => {
            if (renameSource !== source || !source.isCurrent()) return;
            if (placeholder === null) return rejectTarget("Place the caret on a name to rename it.");
            checking = undefined;
            if (!pending.edited && name.value !== placeholder) {
                rename.setName(placeholder);
                if (document.activeElement === name) name.select();
            }
            refreshPrompt();
            if (pending.submit && !preview.disabled) rename.prepare();
        }, () => rejectTarget("TypeScript could not prepare a rename here."));
        return true;
    }
    name.addEventListener("input", () => {
        if (checking) {
            checking.edited = true;
            checking.submit = false;
        }
        rename.setName(name.value);
    }, { signal: events.signal });
    scope.defer(editor.commands.register({ id: "rename.submitWhenReady", label: "Preview after checking the rename target",
        enabled: () => !!checking && document.activeElement === name,
        run: () => { if (checking) checking.submit = true; } }, { keys: ["Enter"], shared: true, priority: 34, repeat: false }).dispose);
    preview.addEventListener("click", () => {
        name.focus();
        rename.prepare();
    }, { signal: events.signal });
    cancel.addEventListener("click", () => closeRename(true), { signal: events.signal });
    rename.bindName(name); scope.defer(() => rename.bindName(null));
    let displayed = rename.state.getSnapshot().locations;
    function refreshPrompt() {
        const state = rename.state.getSnapshot();
        status.textContent = checking ? "Checking rename target…" : state.status === "pending" ? "Preparing rename preview…" : state.status === "ready" ? state.message
            : state.status === "expired" ? "The code or selection changed. Preview again." : state.status === "failed" ? state.message : "Enter a name, then preview its changes.";
        preview.disabled = !!checking || state.pending || !state.name.trim();
    }
    scope.defer(rename.state.subscribe(() => {
        const state = rename.state.getSnapshot();
        refreshPrompt();
        if (name.value !== state.name) name.value = state.name;
        apply = renderPanelButton(apply, { label: "Apply rename", reviewKey: state.reviewKey, disabled: !state.canApply, invoke: state.preview?.apply ?? null });
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
        const current = focused === undefined ? query.page : locationPage(result, Number(focused));
        if (!current) return false;
        let moved: NavigationPage | undefined;
        if (!byPage) moved = current.moveSelection(direction);
        else if (direction < 0) moved = current.previousPage?.() ?? locationPage(result, 0);
        else moved = current.nextPage?.() ?? locationPage(result, result.count - 1);
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
        return !!query && !!location && choose(query, location);
    });
    scope.defer(rename.attach("source", file.tab, editor));
    scope.defer(navigation.subscribe(() => {
        const status = navigation.getSnapshot().status;
        if (query && (status === "expired" || status === "idle")) hideLocations();
    }));
    return Object.freeze({ definition: () => request("definition"), references: () => request("references"), rename: () => editor.commands.run("rename.start"),
        dismiss: () => { cancelNavigation(); closeRename(false); }, isOpen: () => !!query || !!renameSource });
}
