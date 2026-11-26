import type { ViewBindings } from "./bindings.ts";
import { documentLinksPanelModel } from "./document-links-panel.ts";
import { createDestinationList } from "./tool-panel.ts";

/** Module links stay beside the source. Symbol navigation uses the editor's chooser. */
export function mountLocationsDock(host: HTMLElement, { links }: Pick<ViewBindings, "links">) {
    const model = () => documentLinksPanelModel(links, links.state.getSnapshot());
    const list = createDestinationList(host.ownerDocument, model().results);
    const status = host.ownerDocument.createElement("output");
    status.setAttribute("aria-label", "Locations status");
    function render() {
        const state = model();
        status.textContent = state.status.text;
        list.render(state.results);
    }
    host.replaceChildren(status, list.element);
    render();
    const stop = links.state.subscribe(render);
    return () => { stop(); list.dispose(); host.replaceChildren(); };
}
