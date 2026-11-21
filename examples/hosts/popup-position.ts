import { mountAnchoredOverlay } from "../../src/browser/index.ts";
import type { AnchoredOverlay, OverlayAnchor, TextEditor } from "../../src/browser/index.ts";

/** One host popup follows the pane that supplied its current language result. */
export function bindPopup(element: HTMLElement, prefer: "above" | "below") {
    let editor: TextEditor | undefined, overlay: AnchoredOverlay | undefined;
    element.hidden = true;
    function dispose(): void { overlay?.dispose(); overlay = undefined; editor = undefined; }
    function update(target: (OverlayAnchor & { editor: TextEditor }) | undefined): void {
        if (!target) { overlay?.hide(); return; }
        if (editor !== target.editor) {
            dispose(); editor = target.editor; overlay = mountAnchoredOverlay(editor, element, { prefer });
        }
        const { revision, offset, affinity } = target;
        overlay!.show({ revision, offset, ...(affinity ? { affinity } : {}) });
    }
    return { update, dispose };
}
