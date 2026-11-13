/** Fit asynchronous content after rendering; caret geometry alone does not know popup height. */
export function positionPopup(popup: HTMLElement, left: number, top: number): void {
    const win = popup.ownerDocument.defaultView!;
    popup.style.left = `${Math.max(8, Math.min(left, win.innerWidth - popup.offsetWidth - 8))}px`;
    popup.style.top = `${Math.max(8, Math.min(top, win.innerHeight - popup.offsetHeight - 8))}px`;
}
