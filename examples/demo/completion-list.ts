import type { CompletionSnapshot } from "../../src/browser/index.ts";

/** The scroll track covers every candidate. Only the nearby buttons hold completion handles. */
export function mountCompletionList(list: HTMLElement, signal: AbortSignal) {
    const rowHeight = 30, windowSize = 16;
    list.style.setProperty("--choice-height", `${rowHeight}px`);
    let current: CompletionSnapshot | undefined, first = -1, followSelection = true;

    function paint(scrollTop: number): void {
        if (!current) return;
        const { choices, choiceIndex, completionAt } = current;
        const start = Math.max(0, Math.min(choices.length - windowSize, Math.floor(scrollTop / rowHeight) - 2));
        if (start === first) return;
        first = start;
        list.replaceChildren(...choices.slice(start, start + windowSize).map((label, offset) => {
            const index = start + offset, choice = completionAt(index);
            const button = list.ownerDocument.createElement("button");
            button.type = "button"; button.textContent = label; button.title = label;
            button.setAttribute("role", "option"); button.setAttribute("aria-selected", String(index === choiceIndex));
            button.style.top = `${index * rowHeight}px`;
            button.onclick = () => choice?.accept("replace");
            return button;
        }));
    }
    function reveal(): void {
        if (!current) return;
        const top = current.choiceIndex * rowHeight, height = list.clientHeight;
        if (height && followSelection) {
            if (top < list.scrollTop) list.scrollTop = top;
            else if (top + rowHeight > list.scrollTop + height) list.scrollTop = top + rowHeight - height;
        }
        paint(height ? list.scrollTop : top);
    }
    list.addEventListener("scroll", () => {
        if (!current || !list.clientHeight) return;
        const top = current.choiceIndex * rowHeight;
        followSelection = top >= list.scrollTop && top + rowHeight <= list.scrollTop + list.clientHeight + 1;
        paint(list.scrollTop);
    }, { signal });
    const resize = new ResizeObserver(reveal);
    resize.observe(list); signal.addEventListener("abort", () => resize.disconnect(), { once: true });
    return (state?: CompletionSnapshot) => {
        if (current?.choices === state?.choices && current?.choiceIndex === state?.choiceIndex) return;
        current = state; first = -1; followSelection = true;
        list.style.setProperty("--choice-extent", `${(state?.choices.length ?? 0) * rowHeight}px`);
        if (state) reveal(); else list.replaceChildren();
    };
}
