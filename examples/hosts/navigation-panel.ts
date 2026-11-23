import type { HostNavigationTools, NavigationSnapshot } from "./navigation.ts";
import { pageActions } from "./panel-actions.ts";
import { createDestinationList, createToolPanel } from "./tool-panel.ts";
type NavigationPanelTools = Pick<HostNavigationTools, "findDefinition" | "findReferences" | "cancel" | "returnToOrigin" | "addCompanion" | "disconnect" | "reconnect" | "setIncludeDeclaration" | "bindList">;

/** Pure presentation of one captured snapshot; list rows are read only when a renderer needs them. */
export function navigationPanelModel(tools: NavigationPanelTools, state: NavigationSnapshot) {
    const pending = state.status === "pending", paging = state.paging;
    return {
        title: "Symbol navigation", status: { label: "Symbol navigation status", text: state.message },
        progress: { label: "Symbol navigation progress", hidden: !pending },
        declarations: { label: "Include declarations in references", checked: state.includeDeclaration, change: (value: boolean) => tools.setIncludeDeclaration(value) },
        actions: [
            { label: "Find definition", invoke: tools.findDefinition, disabled: !state.available || pending || state.disconnected },
            { label: "Find references", invoke: tools.findReferences, disabled: !state.available || pending || state.disconnected },
            { label: "Cancel symbol navigation", invoke: tools.cancel, disabled: !state.canCancel },
            { label: "Return to navigation origin", invoke: tools.returnToOrigin, disabled: !state.canReturn },
            ...pageActions("navigation results", paging),
            { label: "Add navigation companion", invoke: tools.addCompanion, disabled: pending },
            { label: "Disconnect navigation provider", invoke: tools.disconnect, disabled: !state.connected && !pending },
            { label: "Reconnect navigation provider", invoke: tools.reconnect, disabled: !state.disconnected && state.status !== "failed" }
        ],
        results: { label: "Navigation results", identity: state.locations, bind: tools.bindList,
            items: () => state.locations.map(note => ({ key: `${paging?.key}:${note.ordinal}`,
                label: `${note.title}:${note.line}:${note.column}${note.declaration ? " · declaration" : ""}`,
                invoke: note.open } as const)) },
    } as const;
}
export function mountNavigationPanel(host: HTMLElement, tools: HostNavigationTools): () => void {
    const { owner, initial, controls, mount } = createToolPanel(host, tools.state, state => navigationPanelModel(tools, state));
    const progress = owner.createElement("progress"), notes = createDestinationList(owner, initial.results), label = owner.createElement("label"), include = owner.createElement("input");
    progress.setAttribute("aria-label", initial.progress.label); include.type = "checkbox"; label.append(include, initial.declarations.label); include.onchange = () => initial.declarations.change(include.checked);
    return mount([progress, notes.element, label, controls], model => {
        progress.hidden = model.progress.hidden; include.checked = model.declarations.checked;
        notes.render(model.results);
    }, notes.dispose);
}
