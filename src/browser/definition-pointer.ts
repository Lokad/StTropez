import { codeWordConstituentPattern } from "../core/words.ts";
import { hitTestRoot } from "./dom-coordinates.ts";
import { editorInput } from "./editor-input.ts";
import type { TextEditor } from "./text-editor.ts";
import type { NavigationPointerLink } from "./navigation-controller.ts";

export type DefinitionHit = Readonly<{ revision: number; offset: number; from: number; to: number; open?: () => void }>;
const words = new RegExp(`(?:\\$|${codeWordConstituentPattern})+`, "gu");
const modified = (event: MouseEvent | KeyboardEvent) => event.ctrlKey !== event.metaKey && !event.shiftKey && !event.altKey;

/** The viewport supplies the painted glyph edge, including its affinity in bidi text. */
export function bindDefinitionPointer(editor: TextEditor, inspect: (hit: DefinitionHit) => void, leave: () => void,
    activate: (hit: DefinitionHit) => void, signal: AbortSignal, linkAt?: (offset: number) => NavigationPointerLink | undefined) {
    const root = editor.element, owner = root.ownerDocument, win = owner.defaultView!, input = editorInput(editor);
    let pointer: { x: number; y: number } | undefined, press: { hit: DefinitionHit; id: number; x: number; y: number } | undefined;
    let timer: number | undefined;
    const stopTimer = () => { win.clearTimeout(timer); timer = undefined; };
    const clear = () => { stopTimer(); press = undefined; leave(); };
    const hitAt = (x: number, y: number): DefinitionHit | undefined => {
        const tree = hitTestRoot(root), over = tree.elementFromPoint(x, y);
        const row = over === input ? tree.elementsFromPoint(x, y).find(element => element.matches(".st-viewport-row")) as HTMLElement | undefined
            : over?.closest<HTMLElement>(".st-viewport-row");
        if (!row || !editor.viewport.element.contains(row)) return;
        const point = editor.viewport.hitTest(x, y), doc = editor.workspace.observeDocument(editor.view.documentId).getSnapshot();
        if (!doc || !point || point.padding || point.revision !== doc.revision || y < point.top || y >= point.top + point.height) return;
        let offset = point.offset - (point.affinity === "before" ? 1 : 0);
        if (offset < Number(row.dataset.from) || offset >= Number(row.dataset.to)) return;
        const link = linkAt?.(offset);
        if (link && Number.isSafeInteger(link.from) && Number.isSafeInteger(link.to)
            && 0 <= link.from && link.from <= offset && offset < link.to && link.to <= doc.buffer.length)
            return { revision: point.revision, offset, from: link.from, to: link.to, open: link.open };
        const from = Math.max(0, offset - 2048), to = Math.min(doc.buffer.length, offset + 2049), text = doc.buffer.slice(from, to);
        if (offset > from && /[\uDC00-\uDFFF]/u.test(text[offset - from]!)) offset--;
        for (const match of text.matchAll(words)) {
            const start = from + match.index, end = start + match[0].length;
            if (start > offset) break;
            if (offset < end && (start > from || from === 0) && (end < to || to === doc.buffer.length))
                return { revision: point.revision, offset, from: start, to: end };
        }
    };
    const hover = () => {
        stopTimer();
        if (!pointer) return;
        const { x, y } = pointer;
        timer = win.setTimeout(() => { const hit = hitAt(x, y); if (hit) inspect(hit); else leave(); }, 75);
    };
    root.addEventListener("pointermove", event => {
        if (event.pointerType === "touch") return;
        pointer = { x: event.clientX, y: event.clientY };
        if (press && Math.hypot(event.clientX - press.x, event.clientY - press.y) > 4) clear();
        if (!event.buttons && modified(event)) hover(); else if (!press) clear();
    }, { signal });
    root.addEventListener("pointerleave", () => { pointer = undefined; clear(); }, { signal });
    win.addEventListener("keydown", event => {
        if (!pointer || event.repeat) return;
        if ((event.key === "Control" || event.key === "Meta") && modified(event)) hover(); else clear();
    }, { signal, capture: true });
    win.addEventListener("keyup", event => { if (!modified(event)) clear(); }, { signal, capture: true });
    root.addEventListener("pointerdown", event => {
        if (event.button !== 0 || !event.isPrimary || !modified(event)) { clear(); return; }
        const hit = hitAt(event.clientX, event.clientY); if (!hit) { clear(); return; }
        stopTimer(); press = { hit, id: event.pointerId, x: event.clientX, y: event.clientY };
        event.preventDefault(); event.stopPropagation(); inspect(hit);
    }, { signal, capture: true });
    root.addEventListener("pointerup", event => {
        const pressed = press; press = undefined;
        if (!pressed || pressed.id !== event.pointerId || event.button !== 0 || !modified(event)) return;
        const hit = hitAt(event.clientX, event.clientY);
        if (!hit || hit.revision !== pressed.hit.revision || hit.from !== pressed.hit.from || hit.to !== pressed.hit.to || !!hit.open !== !!pressed.hit.open
            || Math.hypot(event.clientX - pressed.x, event.clientY - pressed.y) > 4) { clear(); return; }
        event.preventDefault(); event.stopPropagation(); activate(pressed.hit.open ? pressed.hit : hit);
    }, { signal, capture: true });
    root.addEventListener("pointercancel", clear, { signal });
    editor.viewport.element.addEventListener("scroll", clear, { signal });
    win.addEventListener("blur", () => { pointer = undefined; clear(); }, { signal });
    signal.addEventListener("abort", stopTimer, { once: true });
}
