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

export type PanelAction = Readonly<{ label: string; reviewKey?: number | string | null | undefined; pageStart?: number | undefined; pageGroup?: string; disabled: boolean; invoke: (() => void) | null }>;

export type PanelPaging = Readonly<{ key: number; first: number; previous: (() => void) | null; next: (() => void) | null }>;

export function panelPaging(key: number, page: number, count: number, size: number, show: (page: number) => void): PanelPaging {
    return { key, first: page * size, previous: page > 0 ? () => show(page - 1) : null, next: (page + 1) * size < count ? () => show(page + 1) : null };
}

export function pageActions(subject: string, paging: PanelPaging | null) {
    return [
        { label: "Previous " + subject, pageGroup: subject, reviewKey: paging?.key, pageStart: paging?.first, disabled: !paging?.previous, invoke: paging?.previous ?? null },
        { label: "Next " + subject, pageGroup: subject, reviewKey: paging?.key, pageStart: paging?.first, disabled: !paging?.next, invoke: paging?.next ?? null },
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
function pageKey(this: HTMLButtonElement, event: KeyboardEvent) {
    if (event.key === "Enter" && event.type === "keydown") {
        if (!event.repeat) this.dataset.enterHeld = "";
        else if (this.dataset.enterHeld === undefined) event.preventDefault();
    }
    if (event.key === "Enter" && event.type === "keyup") clearEnterPress.call(this);
    if (event.key !== " ") return;
    if (event.type === "keydown" && !event.repeat) this.dataset.spacePage = this.dataset.page;
    if (event.type === "keyup" && this.dataset.spacePage !== this.dataset.page) event.preventDefault();
}
function clearEnterPress(this: HTMLButtonElement) { delete this.dataset.enterHeld; }

export function activatePanelAction(button: HTMLButtonElement, action: PanelAction): void {
    const group = button.parentElement, page = button.dataset.page;
    const paging = action.pageGroup !== undefined && page !== undefined && button.matches(":focus");
    action.invoke?.();
    if (!paging || !group) return;
    // React commits the new disabled state after its click handler. A replaced request has different buttons.
    queueMicrotask(() => {
        if (!button.isConnected || button.parentElement !== group || !button.disabled || button.dataset.page === page) return;
        const owner = button.ownerDocument, active = (button.getRootNode() as Document | ShadowRoot).activeElement;
        if (!owner.hasFocus() || (active && active !== owner.body && active !== button)) return;
        const partner = [...group.querySelectorAll<HTMLButtonElement>("button[data-page-group]:enabled")]
            .find(candidate => candidate.dataset.pageGroup === action.pageGroup);
        partner?.focus();
    });
}

/** Keep keyboard focus on the button, but never release a press onto a different page. */
export function bindPageButton(button: HTMLButtonElement | null) {
    if (!button) return;
    button.addEventListener("pointerdown", rememberPointerPage);
    button.addEventListener("click", releasePointerPage, true);
    button.addEventListener("keydown", pageKey);
    button.addEventListener("keyup", pageKey);
    button.addEventListener("blur", clearEnterPress);
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
    button.onclick = action.pageGroup ? () => activatePanelAction(button, action) : action.invoke;
    if (action.pageGroup) button.dataset.pageGroup = action.pageGroup;
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
