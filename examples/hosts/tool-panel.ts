import type { Observable } from "../../src/index.ts";
import { renderPanelActions } from "./panel-actions.ts";

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
