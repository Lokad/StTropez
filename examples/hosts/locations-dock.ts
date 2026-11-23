import { CleanupScope } from "../shared/cleanup-scope.ts";
import type { ViewBindings } from "./bindings.ts";
import { documentLinksPanelModel } from "./document-links-panel.ts";
import { navigationPanelModel } from "./navigation-panel.ts";
import { focusResult } from "./panel-keys.ts";
import { createDestinationList } from "./tool-panel.ts";

/** Keep both captured pages mounted. Only the selected list occupies space beside the source. */
export function mountLocationsDock(host: HTMLElement, bindings: Pick<ViewBindings, "locationStatus" | "switchLocations" | "navigation" | "links">) {
    const { navigation, links, locationStatus } = bindings, owner = host.ownerDocument;
    const symbols = () => navigationPanelModel(navigation, navigation.state.getSnapshot()).results;
    const modules = () => documentLinksPanelModel(links, links.state.getSnapshot()).results;
    const scope = new CleanupScope(); scope.defer(() => host.replaceChildren());
    try {
        const symbolList = createDestinationList(owner, symbols()); scope.defer(symbolList.dispose);
        const moduleList = createDestinationList(owner, modules()); scope.defer(moduleList.dispose);
        const status = owner.createElement("output"), alternate = owner.createElement("button");
        status.setAttribute("aria-label", "Locations status"); alternate.type = "button";
        function render() {
            const { message, kind, alternate: other } = locationStatus.getSnapshot();
            status.textContent = message; alternate.hidden = other === null;
            alternate.textContent = other === "modules" ? "Show module links" : "Show symbol results";
            symbolList.element.hidden = kind !== "symbols"; moduleList.element.hidden = kind !== "modules";
        }
        alternate.onclick = () => {
            bindings.switchLocations();
            const list = locationStatus.getSnapshot().kind === "symbols" ? symbolList.element : moduleList.element;
            if (list.querySelector("button:enabled")) focusResult(list, 0);
        };
        const renderSymbols = () => symbolList.render(symbols()), renderModules = () => moduleList.render(modules());
        host.replaceChildren(status, alternate, symbolList.element, moduleList.element);
        renderSymbols(); renderModules(); render();
        scope.defer(locationStatus.subscribe(render)); scope.defer(navigation.state.subscribe(renderSymbols)); scope.defer(links.state.subscribe(renderModules));
        return scope.dispose;
    } catch (error) { return scope.rollback(error); }
}
