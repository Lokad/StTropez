import { builtinKeyPriority } from "./command-registry.ts";
import { listenUntil } from "./listen.ts";
import { emptyList } from "../core/empty-list.ts";
import { refused } from "../core/outcome.ts";
import { mountAnchoredOverlay, type OverlayPosition } from "./anchored-overlay.ts";
import { mountDocumentation, type DocumentationOptions } from "./documentation.ts";
import { revealSelectionHead } from "./input-caret.ts";
import { editorElement } from "./editor-element.ts";
import type { HoverController } from "./hover-controller.ts";
import { observePointerDwell } from "./pointer-dwell.ts";
import type { TextEditor } from "./text-editor.ts";

export type HoverPopupOptions = DocumentationOptions & Readonly<{
    closeHint?: string;
    beforeInspect?: (trigger: "pointer" | "keyboard") => boolean;
}>;

export function mountHoverPopup(editor: TextEditor, hover: HoverController, options: HoverPopupOptions) {
    const { element, view, commands } = editor;
    const doc = element.ownerDocument;
    const win = doc.defaultView!;
    const popup = editorElement(doc, "div", "hover");
    popup.tabIndex = -1;
    popup.setAttribute("role", "tooltip");
    const content = mountDocumentation(popup, options);
    const hint = doc.createElement("small");
    hint.textContent = options.closeHint ?? "Esc to close";
    popup.append(hint);
    const events = new AbortController();
    const { signal } = events;
    const listen = listenUntil(signal);
    let anchor: OverlayPosition | undefined;
    let pointer = false;
    let leaveTimer: number | undefined;
    let origin: HTMLElement | undefined;
    const overlay = mountAnchoredOverlay(editor, popup, {
        dismissOn: ["focus-leave"],
        onHide: reason => { if (reason === "focus-leave" || reason === "expired") cancel(); },
    });
    function render() {
        const state = hover.getSnapshot();
        const visible = state.status === "ready" || state.status === "failed" || (!pointer && state.status === "pending");
        if (!anchor || !visible) {
            if (state.status !== "pending") anchor = undefined;
            content.setContent(emptyList);
            overlay.hide();
            return;
        }
        content.setContent(state.content ?? [{ kind: "plaintext", value: state.message }]);
        overlay.show(!pointer && state.range ? { revision: anchor.revision, ...state.range } : anchor);
    }
    function cancel() {
        win.clearTimeout(leaveTimer);
        anchor = undefined;
        dwell.cancel();
        hover.cancel();
    }
    async function inspect(point?: OverlayPosition, mode?: "refresh" | "reuse", byPointer = false) {
        if (signal.aborted || options.beforeInspect?.(byPointer ? "pointer" : "keyboard") === false) return refused("unavailable-view");
        const selected = view.getSnapshot();
        const target = point ?? { revision: selected.revision, offset: selected.selection.head, affinity: selected.selection.headAffinity ?? "after" };
        if (!point) revealSelectionHead(editor);
        anchor = target;
        pointer = byPointer;
        const result = await hover.request(target, mode);
        if (anchor === target) {
            if (result.status === "refused" || result.status === "stale") cancel();
            else render();
        }
        return result;
    }
    const dwell = observePointerDwell(editor, point => { void inspect(point, "reuse", true); }, {
        enabled: () => !anchor || pointer,
        onMiss: () => { if (pointer && anchor) cancel(); },
    });
    const stops = [dwell.dispose, hover.subscribe(render)];
    function dispose() {
        events.abort();
        win.clearTimeout(leaveTimer);
        for (const stop of stops) stop();
        overlay.dispose();
        content.dispose();
    }
    try {
        stops.push(commands.register({ id: "hover.inspect", label: "Inspect type", owner: "editor", category: "Hover",
            run: () => { void inspect(); } }, { keys: ["Mod+k Mod+i"], priority: builtinKeyPriority.editor }).dispose);
        stops.push(commands.register({ id: "hover.dismiss", label: "Dismiss hover", owner: "editor", category: "Hover",
            enabled: () => !!anchor || dwell.isPending(), run: () => {
                const shown = !!anchor && !popup.hidden;
                cancel();
                return shown;
            } }, { keys: ["Escape"], priority: builtinKeyPriority.hover, shared: true }).dispose);
    } catch (error) { dispose(); throw error; }
    listen(element, "pointerenter", () => win.clearTimeout(leaveTimer));
    listen(element, "pointerleave", () => {
        if (anchor && pointer) leaveTimer = win.setTimeout(() => {
            if (pointer && anchor && !popup.matches(":hover, :focus-within")) cancel();
        }, 200);
    });
    listen(element, "pointerdown", () => { if (anchor) cancel(); });
    editor.onEditIntent(() => { if (anchor || dwell.isPending()) cancel(); }, signal);
    listen(win, "scroll", event => {
        const target = event.target;
        if (anchor && pointer && (target === win || target instanceof win.Node && target.contains(element))) cancel();
    }, { capture: true });
    listen(win, "resize", () => { if (anchor) cancel(); });
    listen(win, "keydown", event => {
        if (!anchor || !pointer || popup.matches(":focus-within")) return;
        if (event.key === "Control" || event.key === "Meta" || (event.key === "Escape" && !event.defaultPrevented
            && !element.matches(":focus-within") && !event.isComposing && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey)) cancel();
    });
    listen(popup, "focusin", event => {
        if (event.relatedTarget instanceof win.HTMLElement && !popup.contains(event.relatedTarget)) origin = event.relatedTarget;
    });
    listen(popup, "pointerdown", event => {
        if (event.target instanceof win.Element && event.target.closest("button")) event.preventDefault();
    });
    listen(popup, "click", event => {
        if (event.detail === 1 && popup.matches(":focus-within") && !doc.getSelection()?.toString()
            && !(event.target instanceof win.Element && event.target.closest("button"))) origin?.focus({ preventScroll: true });
    });
    listen(popup, "keydown", event => {
        if (editor.keymap.handle(event)) {
            if (!anchor && origin?.isConnected) origin.focus({ preventScroll: true });
        } else if (event.target === popup && !event.defaultPrevented && !event.isComposing && event.keyCode !== 229
            && !event.ctrlKey && !event.metaKey && !event.altKey && [...event.key].length === 1 && origin && element.contains(origin)) {
            origin.focus({ preventScroll: true });
            cancel();
        }
    });
    return { request: inspect, cancel, dispose };
}
