import { mountAnchoredOverlay } from "../../src/browser/index.ts";
import type { AnchoredOverlay, AnchoredOverlayOptions, OverlayAnchor, TextEditor } from "../../src/browser/index.ts";

/** One host popup follows the pane that supplied its current language result. */
export function bindPopup(element: HTMLElement, defaults: AnchoredOverlayOptions) {
    let editor: TextEditor | undefined, overlay: AnchoredOverlay | undefined, policy = defaults;
    element.hidden = true;
    function dispose(): void { overlay?.dispose(); overlay = undefined; editor = undefined; }
    function update(target: (OverlayAnchor & { editor: TextEditor }) | undefined, options = defaults): void {
        if (!target) { overlay?.hide(); return; }
        if (editor !== target.editor || policy !== options) {
            dispose(); editor = target.editor; policy = options; overlay = mountAnchoredOverlay(editor, element, options);
        }
        const { editor: _editor, ...anchor } = target;
        overlay!.show(anchor);
    }
    return { update, dispose };
}
