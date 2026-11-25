import type { DocumentId } from "../../src/index.ts";
import { attachEditorLanguage, mountAnchoredOverlay } from "../../src/browser/index.ts";
import type { NavigationChoice, NavigationOrigin, TextEditor } from "../../src/browser/index.ts";
import type { LspWorkspace } from "../../src/protocol/index.ts";
import type { DemoFile, DemoProject } from "./project.ts";
import type { CleanupScope } from "../shared/cleanup-scope.ts";
import { bindPopupCommands } from "./language-commands.ts";
import { locationExcerpt, locationPage, type NavigationPage } from "../shared/location-excerpt.ts";

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
export function mountDemoSymbols(scope: CleanupScope, project: DemoProject, editor: TextEditor,
    provider: LspWorkspace, valid: () => boolean, dismissOther: () => void, open: (target: DemoSymbolTarget, origin: NavigationOrigin) => void,
    notice: (message: string, signal: AbortSignal) => void) {
    const { workspace } = project;
    const events = new AbortController(); let disposed = false;
    scope.defer(() => { disposed = true; events.abort(); });
    const popup = document.createElement("section"); scope.defer(() => popup.remove());
    popup.className = "demo-symbols"; popup.hidden = true; popup.setAttribute("aria-label", "Symbol locations");
    document.body.append(popup);
    const locationsOverlay = mountAnchoredOverlay(editor, popup, {
        dismissOn: ["focus-leave"],
        onHide(reason) { if (reason === "focus-leave" || reason === "expired") cancelNavigation(); },
    });
    scope.defer(locationsOverlay.dispose);
    type Query = { kind: "definition" | "references"; message: string; offset: number; revision: number;
        origin: NavigationOrigin; page: NavigationPage | undefined };
    let query: Query | undefined;
    const idle = () => { const s = editor.activity(); return !disposed && valid() && !s.composing && !s.pendingInput && !s.pendingCommand; };
    const language = attachEditorLanguage(editor, provider, { navigation: { canCapture: idle, resultLifetime: "view", documents: () => project.files.map(file => workspace.document(file.resource.documentId)),
        onDefinition: offset => request("definition", offset) }, rename: {
            canCapture: idle, popup: { beforeOpen() { dismissOther(); cancelNavigation(); },
                onNotice: message => notice(message, events.signal) },
        } });
    const { navigation } = language;
    scope.defer(language.dispose);
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
        if (!idle()) return; dismissOther(); editor.commands.run("rename.dismiss", false); cancelNavigation(); editor.focus();
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
    popup.addEventListener("pointerdown", event => event.preventDefault(), { signal: events.signal });
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
    scope.defer(navigation.subscribe(() => {
        const status = navigation.getSnapshot().status;
        if (query && (status === "expired" || status === "idle")) hideLocations();
    }));
    return Object.freeze({ definition: () => request("definition"), references: () => request("references"), rename: () => editor.commands.run("rename.start"),
        dismiss: () => { cancelNavigation(); editor.commands.run("rename.dismiss", false); }, isOpen: () => !!query || editor.commands.get("rename.dismiss")?.enabled === true });
}
