import { pageActions, panelPaging, renderPanelButton } from "../hosts/panel-actions.ts";

/** Keep the controls mounted while replacing the rows of this diagnostic batch. */
export function mountProblemPages<T>(list: HTMLElement, subject: string, items: readonly T[], size: number, key: number,
    current: () => boolean, row: (item: T) => HTMLElement, firstPage = 0, remember?: (page: number) => void): void {
    if (items.length <= size) { list.replaceChildren(...items.map(row)); return; }
    const pages = document.createElement("div"), count = document.createElement("span"), rows = document.createElement("div");
    pages.className = "problem-pages"; rows.className = "problem-rows";
    const previous = document.createElement("button"), next = document.createElement("button");
    pages.append(previous, count, next); list.replaceChildren(pages, rows);
    let page = firstPage;
    function show(at: number) {
        page = at;
        const paging = panelPaging(key, at, items.length, size, target => {
            if (current() && page === at) { remember?.(target); show(target); }
        });
        const [back, forward] = pageActions(subject, paging);
        renderPanelButton(previous, back); renderPanelButton(next, forward);
        count.textContent = `${paging.first + 1}–${Math.min(paging.first + size, items.length)} of ${items.length}`;
        rows.replaceChildren(...items.slice(paging.first, paging.first + size).map(row));
    }
    show(firstPage);
}
