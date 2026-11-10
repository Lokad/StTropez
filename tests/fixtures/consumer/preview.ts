import type { Selection } from "sttropez";

/** Host-owned native reader; all source text remains in the DOM, including skipped chunks. */
export function createPreview(host: HTMLElement) {
    let length = 0;
    let chunks: { start: number; text: Text }[] = [];
    let offsets = new WeakMap<Node, { start: number; end: number }>();
    function setText(value: string) {
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
    }
    return { setText, selection, select };
}
