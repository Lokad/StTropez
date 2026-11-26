import { editorElement } from "./editor-element.ts";

/** A scroll track for every option, with at most sixteen buttons mounted at once. */
export function choiceRows(parent: HTMLElement, rowHeight: number, part: string) {
    const doc = parent.ownerDocument;
    const list = editorElement(doc, "div", part);
    parent.append(list);
    list.style.setProperty("--st-completion-row", rowHeight + "px");
    let count = 0, selected = 0, first = -1, followSelection = true;
    let lastScroll = 0, pendingReveal = false;
    let makeRow: ((index: number, button: HTMLButtonElement) => void) | undefined;

    function paint(top: number) {
        const start = Math.max(0, Math.min(count - 16, Math.floor(top / rowHeight) - 2));
        if (first === start) return;
        first = start;
        const buttons: HTMLButtonElement[] = [];
        for (let index = start; makeRow && index < Math.min(count, start + 16); index++) {
            const button = doc.createElement("button");
            button.type = "button";
            button.setAttribute("role", "option");
            button.setAttribute("aria-selected", String(index === selected));
            button.style.top = index * rowHeight + "px";
            makeRow(index, button);
            buttons.push(button);
        }
        list.replaceChildren(...buttons);
    }
    function trackScroll() {
        // A detail or overlay resize can run before the browser reports a user's scroll.
        if (list.scrollTop === lastScroll) return;
        lastScroll = list.scrollTop;
        const top = selected * rowHeight;
        followSelection = top >= lastScroll && top + rowHeight <= lastScroll + list.clientHeight + 1;
    }
    function reveal() {
        const top = selected * rowHeight, height = list.clientHeight;
        if (height && pendingReveal) {
            pendingReveal = false;
            followSelection = true;
        } else if (height) trackScroll();
        if (height && followSelection) {
            if (top < list.scrollTop) list.scrollTop = top;
            else if (top + rowHeight > list.scrollTop + height) list.scrollTop = top + rowHeight - height;
            lastScroll = list.scrollTop;
        }
        paint(height ? list.scrollTop : top);
    }
    list.onscroll = () => {
        if (!list.clientHeight) return;
        if (pendingReveal) { reveal(); return; }
        trackScroll();
        paint(list.scrollTop);
    };
    const resize = new doc.defaultView!.ResizeObserver(reveal);
    resize.observe(list);
    return {
        set(total: number, index: number, row?: typeof makeRow) {
            count = total;
            selected = index;
            makeRow = row;
            first = -1;
            pendingReveal = true;
            list.style.setProperty("--st-completion-extent", count * rowHeight + "px");
            reveal();
        },
        reveal,
        pageSize: () => Math.floor(list.clientHeight / rowHeight),
        dispose() { resize.disconnect(); list.onscroll = null; list.replaceChildren(); makeRow = undefined; },
    };
}

export function moveChoice(current: number, count: number, direction: -1 | 1, page?: number) {
    return page === undefined ? (current + direction + count) % count
        : Math.max(0, Math.min(count - 1, current + direction * page));
}
