import type { LspDocumentOwner } from "../protocol/lsp-client.ts";
import type { LspColor, LspDocumentColor } from "../protocol/lsp-features.ts";
import { colorClient } from "../protocol/lsp-language.ts";
import { documentColorMethod } from "../protocol/lsp-methods.ts";
import type { LspWorkspace } from "../protocol/lsp-workspace.ts";
import { documentRangeWatch } from "./document-range-watch.ts";
import type { TextEditor } from "./text-editor.ts";

const css = (c: LspColor) => `rgba(${c.red * 255}, ${c.green * 255}, ${c.blue * 255}, ${c.alpha})`;
const watch = documentRangeWatch<LspDocumentColor>(documentColorMethod, colorClient, ({ from, to, color }) => ({
    from, to, className: "st-document-color", before: "st-color-swatch", properties: { "--st-swatch-color": css(color) }
}), { name: "document colors", order: 35 });

export function mountSwatches(editor: TextEditor, provider: LspWorkspace, owner: LspDocumentOwner | LspWorkspace,
    activate?: (item: LspDocumentColor) => void) {
    const group = watch(editor, provider, owner);
    const events = new AbortController();
    if (activate) {
        editor.element.classList.add("st-interactive-swatches");
        const hit = (event: PointerEvent) => {
            const mark = event.target;
            if (!(mark instanceof HTMLElement) || !mark.classList.contains("st-color-swatch")) return;
            const point = editor.viewport.hitTest(event.clientX, event.clientY);
            if (point && point.revision === editor.view.getSnapshot().revision) {
                const swatch = mark.style.getPropertyValue("--st-swatch-color");
                return group.at(point.offset, item => css(item.color) === swatch);
            }
        };
        let press: { id: number; item: LspDocumentColor; x: number; y: number } | undefined;
        const options = { capture: true, signal: events.signal };
        editor.element.addEventListener("pointerdown", event => {
            press = undefined;
            if (!event.isPrimary || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
            const item = hit(event);
            if (!item) return;
            press = { id: event.pointerId, item, x: event.clientX, y: event.clientY };
            event.preventDefault();
            event.stopPropagation();
        }, options);
        editor.element.addEventListener("pointerup", event => {
            const down = press;
            press = undefined;
            if (!down || event.pointerId !== down.id || hit(event) !== down.item
                || Math.hypot(event.clientX - down.x, event.clientY - down.y) > 4) return;
            event.preventDefault();
            event.stopPropagation();
            activate(down.item);
        }, options);
        editor.element.addEventListener("pointercancel", () => { press = undefined; }, options);
    }
    return { ...group, dispose() {
        events.abort();
        if (activate) editor.element.classList.remove("st-interactive-swatches");
        group.dispose();
    } };
}
