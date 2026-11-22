import type { Workspace } from "../../src/index.ts";

/** Keep the button for one preview across repaints. A replacement preview gets a fresh button. */
export function createReviewKey(workspace: Workspace) {
    const keys = new WeakMap<object, number>();
    return (review: object | null | undefined): number | null => {
        if (!review) return null;
        let key = keys.get(review);
        if (key === undefined) {
            key = workspace.allocateIdentity();
            keys.set(review, key);
        }
        return key;
    };
}

export type PanelAction = Readonly<{ label: string; reviewKey?: number | string | null | undefined; pageStart?: number | undefined; disabled: boolean; invoke: (() => void) | null }>;

export type PanelPaging = Readonly<{ key: number; first: number; previous: (() => void) | null; next: (() => void) | null }>;

export function panelPaging(key: number, page: number, count: number, size: number, show: (page: number) => void): PanelPaging {
    return { key, first: page * size, previous: page > 0 ? () => show(page - 1) : null, next: (page + 1) * size < count ? () => show(page + 1) : null };
}

export function pageActions(subject: string, paging: PanelPaging | null) {
    return [
        { label: "Previous " + subject, reviewKey: paging?.key, pageStart: paging?.first, disabled: !paging?.previous, invoke: paging?.previous ?? null },
        { label: "Next " + subject, reviewKey: paging?.key, pageStart: paging?.first, disabled: !paging?.next, invoke: paging?.next ?? null },
    ] as const;
}

export function panelActionKey(action: PanelAction): string {
    return action.reviewKey == null ? action.label : `${action.label}:${action.reviewKey}`;
}

function rememberPointerPage(this: HTMLButtonElement) { this.dataset.pointerPage = this.dataset.page; }
function releasePointerPage(this: HTMLButtonElement, event: MouseEvent) {
    if (event.detail && this.dataset.pointerPage !== undefined && this.dataset.pointerPage !== this.dataset.page) {
        event.preventDefault(); event.stopImmediatePropagation();
    }
}
function spacePage(this: HTMLButtonElement, event: KeyboardEvent) {
    if (event.key !== " ") return;
    if (event.type === "keydown" && !event.repeat) this.dataset.spacePage = this.dataset.page;
    if (event.type === "keyup" && this.dataset.spacePage !== this.dataset.page) event.preventDefault();
}

/** Keep keyboard focus on the button, but never release a press onto a different page. */
export function bindPageButton(button: HTMLButtonElement | null) {
    if (!button) return;
    button.addEventListener("pointerdown", rememberPointerPage);
    button.addEventListener("click", releasePointerPage, true);
    button.addEventListener("keydown", spacePage);
    button.addEventListener("keyup", spacePage);
}

export function renderPanelButton(button: HTMLButtonElement, action: PanelAction): HTMLButtonElement {
    const key = panelActionKey(action);
    if (button.dataset.actionKey !== key) {
        if (button.dataset.actionKey !== undefined) {
            const next = button.ownerDocument.createElement("button");
            button.replaceWith(next);
            button = next;
        }
        button.dataset.actionKey = key;
        button.textContent = action.label;
    }
    button.disabled = action.disabled;
    button.onclick = action.invoke;
    if (action.pageStart !== undefined) {
        if (button.dataset.page === undefined) bindPageButton(button);
        button.dataset.page = String(action.pageStart);
    }
    return button;
}

export function renderPanelActions(controls: HTMLElement, actions: readonly PanelAction[]): void {
    for (const [i, action] of actions.entries()) {
        const button = controls.children.item(i) as HTMLButtonElement | null;
        renderPanelButton(button ?? controls.appendChild(controls.ownerDocument.createElement("button")), action);
    }
    while (controls.children.length > actions.length) controls.lastElementChild!.remove();
}
