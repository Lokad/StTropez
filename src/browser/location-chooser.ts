import { locationExcerpt } from "./location-excerpt.ts";
import { showControlNotice } from "./control-notice.ts";
import { mountAnchoredOverlay } from "./anchored-overlay.ts";
import { builtinKeyPriority } from "./command-registry.ts";
import { choiceRows, moveChoice } from "./choice-rows.ts";
import { editorElement } from "./editor-element.ts";
import { failed, refused, stale } from "../core/outcome.ts";
import type { NavigationController, NavigationDestination, NavigationResult } from "./navigation-controller.ts";
import type { TextEditor } from "./text-editor.ts";

type Kind = "definition" | "references";
export type LocationChooserOptions = Readonly<{
    /** Capture the host destination handler at the issuing caret, or decline the request. */
    capture: (kind: Kind, offset: number) => ((target: NavigationDestination) => void) | undefined;
    fileLabel?: (target: NavigationDestination) => string;
}>;

export function mountLocationChooser(editor: TextEditor, navigation: NavigationController, options: LocationChooserOptions) {
    const { strings } = editor;
    const doc = editor.element.ownerDocument;
    const panel = editorElement(doc, "section", "locations");
    panel.setAttribute("aria-label", strings.text("Symbol locations"));
    const status = editorElement(doc, "div", "locations-count");
    panel.append(status);
    const rows = choiceRows(panel, 50, "locations-choices");
    const overlay = mountAnchoredOverlay(editor, panel, {
        transient: true, dismissOn: ["focus-leave", "outside-pointerdown"],
        onHide(reason, focused) {
            if (focused && (reason === "clipped" || reason === "expired")) editor.focus();
            if (reason === "focus-leave" || reason === "expired" || reason === "superseded" || reason === "outside-pointerdown") cancel();
        },
    });
    type Search = { open: (target: NavigationDestination) => void; result?: NavigationResult; index: number };
    let active: Search | undefined;
    let disposed = false;
    function hide() { active = undefined; rows.set(0, 0); overlay.hide(); }
    function cancel() { hide(); navigation.cancel(); }
    function choose(search: Search, index: number) {
        const choice = search.result?.locationAt(index);
        return active === search && !!choice?.open(target => {
            hide();
            try { search.open(target); }
            finally { if (!active) navigation.cancel(); }
        });
    }
    function render(search: Search) {
        const result = search.result!;
        status.textContent = strings.resultPosition(search.index + 1, result.count);
        rows.set(result.count, search.index, (index, button) => {
            const target = result.locationAt(index)!;
            const excerpt = locationExcerpt(target);
            const file = options.fileLabel?.(target) ?? target.document.uri;
            button.textContent = strings.location(file, excerpt.line, excerpt.column);
            button.dataset.location = String(index);
            const code = doc.createElement("code"), mark = doc.createElement("mark");
            mark.textContent = excerpt.match;
            code.append(excerpt.before, mark, excerpt.after);
            button.append(code);
            button.onclick = () => choose(search, index);
        });
    }
    const request: NavigationController["request"] = async (kind = "definition", pointed, includeDeclaration) => {
        if (disposed) return stale;
        const { selection, revision } = editor.view.getSnapshot();
        const offset = pointed ?? selection.head;
        let open: Search["open"] | undefined;
        try { open = options.capture(kind, offset); }
        catch (error) { cancel(); return failed(error); }
        if (disposed) return stale;
        if (!open) { cancel(); return refused("unavailable-view"); }
        // Preserve a prepared modifier-click lookup until the controller consumes it.
        const search: Search = { open, index: 0 };
        active = search;
        rows.set(0, 0);
        editor.focus();
        if (pointed === undefined) editor.viewport.revealOffset(offset, {
            affinity: selection.headAffinity ?? "after", vertical: "center-if-outside", horizontal: "nearest",
        });
        status.textContent = strings.text(kind === "definition" ? "Finding definition…" : "Finding references…");
        overlay.show({ revision, offset });
        const outcome = await navigation.request(kind, offset, includeDeclaration);
        if (active === search) {
            if (outcome.status === "failed") status.textContent = String(outcome.error);
            else if (outcome.status !== "done") hide();
            else {
                search.result = outcome.value;
                if (outcome.value.count === 1) choose(search, 0);
                else if (outcome.value.count) render(search);
                else {
                    hide();
                    showControlNotice(editor, strings.text(kind === "definition" ? "No definition found." : "No references found."));
                }
            }
        }
        return outcome;
    };
    const stops: (() => void)[] = [navigation.subscribe(after => {
        const state = navigation.getSnapshot();
        if (active && (state.status === "expired" || state.status === "idle")) {
            const search = active;
            after(() => { if (search === active) hide(); });
        }
    })];
    const register = (id: string, label: string, key: string, run: () => void, enabled = () => !!active && !panel.hidden) => {
        stops.push(editor.commands.register({ id: "locations." + id, label, owner: "editor", enabled, run },
            { keys: [key], priority: builtinKeyPriority.completion, shared: true }).dispose);
    };
    const blur = () => { if (active) cancel(); };
    doc.defaultView!.addEventListener("blur", blur);
    function dispose() {
        disposed = true;
        doc.defaultView!.removeEventListener("blur", blur);
        for (const stop of stops.splice(0)) stop();
        active = undefined;
        rows.dispose();
        overlay.dispose();
    }
    try {
        register("definition", "Go to definition", "F12", () => { void request("definition"); }, () => !disposed);
        register("references", "Find references", "Shift+F12", () => { void request("references"); }, () => !disposed);
        for (const [id, label, key, direction, page] of [
            ["previous", "Previous location", "ArrowUp", -1, false], ["next", "Next location", "ArrowDown", 1, false],
            ["pageUp", "Previous locations page", "PageUp", -1, true], ["pageDown", "Next locations page", "PageDown", 1, true],
        ] as const) register(id, label, key, () => {
            const search = active;
            if (!search?.result?.count) return;
            const focused = panel.querySelector<HTMLButtonElement>("button:focus");
            const index = focused ? Number(focused.dataset.location) : search.index;
            editor.focus();
            if (active !== search) return;
            search.index = moveChoice(index, search.result.count, direction, page ? Math.max(1, rows.pageSize()) : undefined);
            render(search);
        });
        register("open", "Open location", "Enter", () => { if (active) choose(active, active.index); });
        register("dismiss", "Close locations", "Escape", () => { cancel(); editor.focus(); });
    } catch (error) { dispose(); throw error; }
    panel.onpointerdown = event => event.preventDefault();
    panel.onkeydown = event => {
        if (event.key === "Enter" && (event.target as HTMLElement).closest("button")) return;
        editor.keymap.handle(event);
    };
    return { request, cancel, dispose };
}
