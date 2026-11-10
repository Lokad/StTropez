import type { Selection } from "sttropez";

/** Host-owned native reader; all source text remains in the DOM, including skipped chunks. */
export function createPreview(host: HTMLElement, signal: AbortSignal, escape: () => void) {
    let length = 0;
    let value = "", remembered: Selection = { anchor: 0, head: 0 };
    let preferred: Readonly<{ range: Selection; x: number }> | undefined;
    let chunks: { start: number; text: Text }[] = [];
    let offsets = new WeakMap<Node, { start: number; end: number }>();
    function setText(text: string) {
        value = text;
        preferred = undefined;
        length = value.length; chunks = []; offsets = new WeakMap();
        const ends: number[] = []; let lines = 0;
        for (let i = 0; i < value.length; i++) {
            const code = value.charCodeAt(i);
            if (code !== 10 && code !== 13) continue;
            if (code === 13 && value.charCodeAt(i + 1) === 10) i++;
            if (++lines % 500 === 0) ends.push(i + 1);
        }
        if (ends.at(-1) !== length) ends.push(length);
        const fragmented = ends.length > 1, fragment = document.createDocumentFragment();
        host.style.whiteSpace = fragmented ? "normal" : "pre";
        let start = 0;
        for (const end of ends) {
            const text = document.createTextNode(value.slice(start, end));
            chunks.push({ start, text }); offsets.set(text, { start, end });
            if (fragmented) {
                const block = document.createElement("span"); block.className = "preview-chunk";
                block.append(text); offsets.set(block, { start, end }); fragment.append(block);
            } else fragment.append(text);
            start = end;
        }
        host.replaceChildren(fragment);
    }
    function offset(node: Node | null, at: number): number | undefined {
        if (node === host) return at === chunks.length ? length : chunks[at]?.start;
        const span = node && offsets.get(node);
        return span ? node?.nodeType === Node.TEXT_NODE ? span.start + at : at === 0 ? span.start : span.end : undefined;
    }
    function selection(): Selection | undefined {
        const s = window.getSelection(); if (!s) return;
        const anchor = offset(s.anchorNode, s.anchorOffset), head = offset(s.focusNode, s.focusOffset);
        return anchor === undefined || head === undefined ? undefined : { anchor, head };
    }
    function point(at: number): [Text, number] {
        const bounded = Math.max(0, Math.min(length, at));
        const chunk = chunks.find(c => bounded < c.start + c.text.length) ?? chunks[chunks.length - 1]!;
        return [chunk.text, bounded - chunk.start];
    }
    function select(at: Selection) {
        const [anchor, anchorOffset] = point(at.anchor), [head, headOffset] = point(at.head);
        window.getSelection()?.setBaseAndExtent(anchor, anchorOffset, head, headOffset);
        remembered = { anchor: Math.max(0, Math.min(length, at.anchor)), head: Math.max(0, Math.min(length, at.head)) };
    }
    function reveal(at: number, horizontal = true) {
        const [text] = point(at), box = host.getBoundingClientRect(), block = text.parentElement!.getBoundingClientRect();
        // Bring only the target block into this scroller before querying its native caret geometry.
        if (block.bottom < box.top || block.top > box.bottom) host.scrollTop += block.top - box.top;
        const caret = caretGeometry(at);
        if (!caret.height) return;
        const top = box.top + host.clientTop + 2, left = box.left + host.clientLeft + 2;
        if (caret.top < top) host.scrollTop += caret.top - top;
        else if (caret.bottom > top + host.clientHeight - 4) host.scrollTop += caret.bottom - top - host.clientHeight + 4;
        if (horizontal && caret.left < left) host.scrollLeft += caret.left - left;
        else if (horizontal && caret.right > left + host.clientWidth - 4) host.scrollLeft += caret.right - left - host.clientWidth + 4;
    }
    function normalize(at: number, forward: boolean): number {
        const before = value.charCodeAt(at - 1), after = value.charCodeAt(at);
        return at > 0 && at < length && (before === 13 && after === 10 || before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff)
            ? at + (forward ? 1 : -1) : at;
    }
    function lineEdge(at: number, forward: boolean): number {
        const [node, local] = point(normalize(at, false)), text = node.data, start = offsets.get(node)!.start;
        if (!forward) return start + (local === 0 ? 0 : Math.max(text.lastIndexOf("\r", local - 1), text.lastIndexOf("\n", local - 1)) + 1);
        const cr = text.indexOf("\r", local), lf = text.indexOf("\n", local);
        return start + Math.min(cr < 0 ? text.length : cr, lf < 0 ? text.length : lf);
    }
    function adjacentLine(at: number, forward: boolean): number | undefined {
        const edge = lineEdge(at, forward);
        if (forward) return edge === length ? undefined : normalize(edge + 1, true);
        return edge === 0 ? undefined : lineEdge(normalize(edge - 1, false), false);
    }
    function textRange(from: number, to = from): Range {
        const range = document.createRange(); range.setStart(...point(from)); range.setEnd(...point(to)); return range;
    }
    function caretGeometry(at: number): DOMRect {
        if (at === lineEdge(at, false) && at < lineEdge(at, true)) return textRange(at, normalize(at + 1, true)).getBoundingClientRect();
        const [text, local] = point(at), range = textRange(at); let rect = range.getBoundingClientRect();
        if (!rect.height && local) { range.setStart(text, local - 1); range.setEnd(text, local); rect = range.getBoundingClientRect(); }
        return rect;
    }
    function hit(x: number, y: number): number | undefined {
        const owner = host.ownerDocument as Document & {
            caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
            caretRangeFromPoint?: (x: number, y: number) => Range | null;
        };
        const position = owner.caretPositionFromPoint?.(x, y), range = position ? undefined : owner.caretRangeFromPoint?.(x, y);
        return offset(position?.offsetNode ?? range?.startContainer ?? null, position?.offset ?? range?.startOffset ?? 0);
    }
    host.addEventListener("pointerdown", () => { preferred = undefined; }, { signal });
    host.addEventListener("keydown", event => {
        if (event.defaultPrevented || event.isComposing || event.altKey) return;
        if (event.key === "Escape") { event.preventDefault(); escape(); return; }
        const modified = event.ctrlKey || event.metaKey;
        if (event.key === "Backspace" || event.key === "Delete" || modified && /^(z|y)$/i.test(event.key)) { event.preventDefault(); return; }
        const all = modified && event.key.toLowerCase() === "a", edge = event.key === "Home" || event.key === "End";
        const horizontal = event.key === "ArrowLeft" || event.key === "ArrowRight", vertical = event.key === "ArrowUp" || event.key === "ArrowDown";
        const page = event.key === "PageUp" || event.key === "PageDown";
        if (!all && !edge && !horizontal && (!vertical || event.ctrlKey) && (!page || modified)) return;
        event.preventDefault();
        const current = selection(), before = current ?? remembered; if (!current) select(before);
        const forward = event.key === "End" || event.key === "ArrowRight" || event.key === "ArrowDown" || event.key === "PageDown";
        if (all || edge || horizontal || vertical && event.metaKey) preferred = undefined;
        if (all) { select({ anchor: 0, head: length }); return; }
        const visible = new Map<HTMLElement, string>();
        const scroll = (at: number, horizontal = true) => {
            const block = point(at)[0].parentElement!;
            if (block !== host && !visible.has(block)) { visible.set(block, block.style.contentVisibility); block.style.contentVisibility = "visible"; }
            reveal(at, horizontal);
        };
        try {
            if (horizontal && !event.shiftKey && before.anchor !== before.head) {
                const head = forward ? Math.max(before.anchor, before.head) : Math.min(before.anchor, before.head);
                select({ anchor: head, head }); scroll(head); return;
            }
            const absolute = edge && modified || vertical && event.metaKey;
            if (absolute || edge || horizontal && event.metaKey) {
                const head = absolute ? forward ? length : 0 : lineEdge(before.head, forward);
                select({ anchor: event.shiftKey ? before.anchor : head, head }); scroll(head); return;
            }
            const count = page ? Math.max(1, Math.floor(host.clientHeight / parseFloat(getComputedStyle(host).lineHeight)) - 1) : 1;
            if (!horizontal) {
                scroll(before.head);
                const box = host.getBoundingClientRect(), caret = caretGeometry(before.head), y = (caret.top + caret.bottom) / 2;
                const leading = before.head === lineEdge(before.head, false) && caret.width && hit(caret.left + .01, y) !== before.head && hit(caret.right - .01, y) === before.head ? caret.right : caret.left;
                const x = preferred && preferred.range.anchor === before.anchor && preferred.range.head === before.head ? preferred.x
                    : caret.height ? leading - box.left - host.clientLeft + host.scrollLeft : parseFloat(getComputedStyle(host).paddingLeft);
                let row = lineEdge(before.head, false), boundary = false;
                for (let i = 0; i < count; i++) {
                    const next = adjacentLine(row, forward); if (next === undefined) { boundary = true; break; } row = next;
                }
                const end = lineEdge(row, true); let head = boundary ? forward ? length : 0 : row;
                if (!boundary && row !== end) {
                    scroll(row, false); const range = textRange(row, end); let rect = range.getBoundingClientRect();
                    let target = Math.max(rect.left, Math.min(rect.right, box.left + host.clientLeft + x - host.scrollLeft));
                    const left = box.left + host.clientLeft + 2, right = left + host.clientWidth - 4;
                    if (target < left) host.scrollLeft += target - left; else if (target > right) host.scrollLeft += target - right;
                    rect = range.getBoundingClientRect(); target = Math.max(rect.left, Math.min(rect.right, box.left + host.clientLeft + x - host.scrollLeft));
                    head = Math.max(row, Math.min(end, normalize(hit(target, (rect.top + rect.bottom) / 2) ?? (target <= rect.left ? row : end), false)));
                }
                select({ anchor: event.shiftKey ? before.anchor : head, head }); scroll(head); preferred = { range: remembered, x }; return;
            }
            const native = window.getSelection(); if (!native) return;
            const granularity = event.ctrlKey ? "word" : "character", direction = forward ? "right" : "left", neighbor = adjacentLine(before.head, forward);
            for (let attempt = 0; attempt < 2; attempt++) {
                const [text, at] = point(before.head);
                if (attempt === 0 && (native.focusNode !== text || native.focusOffset !== at)) select(before);
                scroll(before.head); if (neighbor !== undefined) scroll(neighbor, false);
                native.modify(event.shiftKey ? "extend" : "move", direction, granularity);
                const raw = offset(native.focusNode, native.focusOffset), head = normalize(raw ?? (forward ? length : 0), forward);
                remembered = { anchor: event.shiftKey ? before.anchor : head, head };
                if (raw !== head) select(remembered);
                if (raw === undefined || head !== before.head) break;
            }
            scroll(remembered.head);
        } finally { for (const [block, prior] of visible) block.style.contentVisibility = prior; }
    }, { signal });
    return { setText, selection, select };
}
