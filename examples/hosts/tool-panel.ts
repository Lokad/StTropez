import type { Observable } from "../../src/index.ts";
import { renderPanelActions } from "./panel-actions.ts";

export type PanelTextField = Readonly<{ label: string; value: string; maxLength: number;
    bind: (input: HTMLInputElement | null) => void; change: (value: string) => void }>;

export function createPanelTextField(owner: Document, field: PanelTextField) {
    const label = owner.createElement("label"), input = owner.createElement("input");
    input.type = "text"; input.maxLength = field.maxLength; input.value = field.value;
    input.oninput = () => field.change(input.value);
    label.append(field.label, input); field.bind(input);
    return {
        label,
        render(value: string) { if (input.value !== value) input.value = value; },
        dispose() { input.oninput = null; field.bind(null); },
    };
}

type PanelChoice = Readonly<{ key: number | string; label: string; invoke: () => void; details?: string; available?: boolean }>;
type ChoiceList<T extends PanelChoice> = Readonly<{ label: string; identity: readonly unknown[]; page?: number; disabled?: boolean;
    items: () => readonly T[]; isSelected?: (key: T["key"]) => boolean; retainKeys?: boolean }>;
export type DestinationList = ChoiceList<PanelChoice> & { bind?: (list: HTMLUListElement | null) => void };

export function bindChoiceList<T extends PanelChoice>(list: HTMLElement, initial: ChoiceList<T>, decoration?: (item: T) => HTMLElement) {
    const owner = list.ownerDocument;
    const rows: { item: T; li: HTMLLIElement; button: HTMLButtonElement }[] = [];
    list.setAttribute("aria-label", initial.label);
    let identity: readonly unknown[] | undefined, page: number | undefined;
    return (model: ChoiceList<T>) => {
        if (identity !== model.identity || page !== model.page) {
            const items = model.items();
            const batch = model.retainKeys ? null : owner.createDocumentFragment();
            if (batch) rows.length = 0;
            items.forEach((item, index) => {
                let row = rows[index];
                // A resolving link retains its key and focus. A new result replaces the button even during a press.
                if (!row || row.item.key !== item.key) {
                    const li = owner.createElement("li"), button = owner.createElement("button");
                    if (decoration) li.append(decoration(item));
                    li.append(button);
                    if (row) row.li.replaceWith(li); else (batch ?? list).append(li);
                    rows[index] = row = { item, li, button };
                }
                row.item = item; row.button.textContent = item.label; row.button.onclick = item.invoke;
                if (item.details !== undefined) {
                    const detail = row.button.nextElementSibling ?? row.li.appendChild(owner.createElement("p"));
                    detail.textContent = item.details;
                } else row.button.nextElementSibling?.remove();
            });
            if (batch) list.replaceChildren(batch);
            else for (const row of rows.splice(items.length)) row.li.remove();
            identity = model.identity; page = model.page;
        }
        for (const { item, button } of rows) {
            const disabled = !!model.disabled || item.available === false;
            if (button.disabled !== disabled) button.disabled = disabled;
            if (model.isSelected) button.setAttribute("aria-pressed", String(model.isSelected(item.key)));
        }
    };
}

export function createDestinationList(owner: Document, initial: DestinationList) {
    const element = owner.createElement("ul"), render = bindChoiceList(element, initial);
    if (initial.bind) { element.tabIndex = -1; initial.bind(element); }
    return { element, render, dispose: () => initial.bind?.(null) };
}

type ToolPanel = Readonly<{ title: string; description?: string; status: { label: string; text: string };
    actions: Parameters<typeof renderPanelActions>[1] }>;

/** Plain-host panels share the heading, status and command buttons. Each tool owns its form and results. */
export function createToolPanel<S, M extends ToolPanel>(host: HTMLElement, state: Observable<S>, describe: (snapshot: S) => M, showStatus = true) {
    const owner = host.ownerDocument, controls = owner.createElement("div"), initial = describe(state.getSnapshot());
    function mount(body: HTMLElement[], render: (model: M) => void, unbind?: () => void) {
        const heading = owner.createElement("h2"), status = owner.createElement("output");
        host.setAttribute("aria-label", initial.title); heading.textContent = initial.title;
        status.setAttribute("aria-label", initial.status.label);
        host.replaceChildren(heading);
        if (initial.description) {
            const description = owner.createElement("p"); description.textContent = initial.description; host.append(description);
        }
        if (showStatus) host.append(status);
        host.append(...body);
        const update = () => {
            const model = describe(state.getSnapshot());
            if (showStatus) status.textContent = model.status.text;
            renderPanelActions(controls, model.actions);
            render(model);
        };
        const stop = state.subscribe(update);
        const dispose = () => { stop(); unbind?.(); host.replaceChildren(); };
        try { update(); } catch (error) { dispose(); throw error; }
        return dispose;
    }
    return { owner, controls, initial, mount };
}
