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

type PanelAction = Readonly<{ label: string; reviewKey?: number | null | undefined; disabled: boolean; invoke: () => void }>;

export function panelActionKey(action: PanelAction): string {
    return action.reviewKey == null ? action.label : `${action.label}:${action.reviewKey}`;
}

export function renderPanelActions(controls: HTMLElement, actions: readonly PanelAction[]): void {
    for (const [i, action] of actions.entries()) {
        const key = panelActionKey(action);
        let button = controls.children.item(i) as HTMLButtonElement | null;
        if (button?.dataset.actionKey !== key) {
            const next = controls.ownerDocument.createElement("button");
            next.textContent = action.label;
            next.dataset.actionKey = key;
            if (button) button.replaceWith(next);
            else controls.append(next);
            button = next;
        }
        button.disabled = action.disabled;
        button.onclick = action.invoke;
    }
    while (controls.children.length > actions.length) controls.lastElementChild!.remove();
}
