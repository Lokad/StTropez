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

type PanelChoice = Readonly<{ key: number | string; label: string; invoke: () => void }>;
type ChoiceList<T extends PanelChoice> = Readonly<{ label: string; identity: readonly unknown[]; page?: number; disabled: boolean;
    items: () => readonly T[]; isSelected?: (key: T["key"]) => boolean }>;

/** Keep each button while its result page is displayed, including when only selection changes. */
export function bindChoiceList<T extends PanelChoice>(list: HTMLElement, initial: ChoiceList<T>, decoration?: (item: T) => HTMLElement) {
    const owner = list.ownerDocument, buttons: [T["key"], HTMLButtonElement][] = [];
    list.setAttribute("aria-label", initial.label);
    let identity: readonly unknown[] | undefined, page: number | undefined;
    return (model: ChoiceList<T>) => {
        if (identity !== model.identity || page !== model.page) {
            buttons.length = 0;
            list.replaceChildren(...model.items().map(item => {
                const row = owner.createElement("li"), button = owner.createElement("button");
                button.textContent = item.label; button.onclick = item.invoke; buttons.push([item.key, button]);
                if (decoration) row.append(decoration(item));
                row.append(button);
                return row;
            }));
            identity = model.identity; page = model.page;
        }
        for (const [key, button] of buttons) {
            button.disabled = model.disabled;
            if (model.isSelected) button.setAttribute("aria-pressed", String(model.isSelected(key)));
        }
    };
}

type ToolPanel = Readonly<{ title: string; description?: string; status: { label: string; text: string };
    actions: Parameters<typeof renderPanelActions>[1] }>;

/** Plain-host panels share the heading, status and command buttons. Each tool owns its form and results. */
export function createToolPanel<S, M extends ToolPanel>(host: HTMLElement, state: Observable<S>, describe: (snapshot: S) => M) {
    const owner = host.ownerDocument, controls = owner.createElement("div"), initial = describe(state.getSnapshot());
    function mount(body: HTMLElement[], render: (model: M, snapshot: S) => void, unbind?: () => void) {
        const heading = owner.createElement("h2"), status = owner.createElement("output");
        host.setAttribute("aria-label", initial.title); heading.textContent = initial.title;
        status.setAttribute("aria-label", initial.status.label);
        host.replaceChildren(heading);
        if (initial.description) {
            const description = owner.createElement("p"); description.textContent = initial.description; host.append(description);
        }
        host.append(status, ...body);
        const update = () => {
            const snapshot = state.getSnapshot(), model = describe(snapshot);
            status.textContent = model.status.text;
            renderPanelActions(controls, model.actions);
            render(model, snapshot);
        };
        const stop = state.subscribe(update);
        const dispose = () => { stop(); unbind?.(); host.replaceChildren(); };
        try { update(); } catch (error) { dispose(); throw error; }
        return dispose;
    }
    return { owner, controls, initial, mount };
}
