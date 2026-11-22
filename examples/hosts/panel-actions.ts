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

type PanelAction = Readonly<{ label: string; reviewKey?: number | null | undefined; disabled: boolean; invoke: (() => void) | null }>;

export function panelActionKey(action: PanelAction): string {
    return action.reviewKey == null ? action.label : `${action.label}:${action.reviewKey}`;
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
    return button;
}

export function renderPanelActions(controls: HTMLElement, actions: readonly PanelAction[]): void {
    for (const [i, action] of actions.entries()) {
        const button = controls.children.item(i) as HTMLButtonElement | null;
        renderPanelButton(button ?? controls.appendChild(controls.ownerDocument.createElement("button")), action);
    }
    while (controls.children.length > actions.length) controls.lastElementChild!.remove();
}
