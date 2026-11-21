/** Both example hosts render uniform choice rows in a scrollable list. */
export function completionPageSize(list: HTMLElement | null | undefined): number {
    const height = list?.getBoundingClientRect().height, row = list?.firstElementChild?.getBoundingClientRect().height;
    return height && row ? Math.max(1, Math.floor(height / row)) : 0;
}

/** Each list positions its rows relative to itself. Only the list should scroll. */
export function revealCompletionRow(row: HTMLElement | null): void {
    const list = row?.parentElement;
    if (!row || !list || list.scrollHeight <= list.clientHeight) return;
    const top = row.offsetTop, bottom = top + row.offsetHeight;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight;
}
