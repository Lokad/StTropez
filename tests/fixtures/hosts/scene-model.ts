import type { DocumentId, TabSnapshot } from "../../../src/index.ts";
import type { HostController } from "./controller.ts";
import type { Layout } from "./layout.ts";

/** Shared eligibility and identity; each host keeps its own rendering/lifecycle mechanism. */
export function hostSceneModel(layout: Layout, tab: TabSnapshot | undefined, documentReady: boolean, source: DocumentId) {
    const tabKey = tab ? `${tab.id}:${tab.generation}` : "";
    const primary = layout.visible && !layout.formFault && layout.primarySurface === "text" && tab?.surface.kind === "text" && documentReady;
    return {
        key: `${layout.position}:${layout.visible}:${layout.formFault}:${layout.primarySurface}:${tabKey}:${documentReady}`,
        position: layout.position, fault: layout.formFault,
        primaryKey: primary ? `primary:${tabKey}` : undefined,
        placeholder: layout.visible && !layout.formFault && !primary ? layout.primarySurface : undefined,
        secondary: layout.visible && !layout.formFault,
        reviewKey: primary && layout.navigation.kind === "review" && tab.surface.kind === "text" && tab.surface.documentId === source ? tabKey : undefined,
        message: layout.modal.kind === "error" ? layout.modal.message : layout.modal.kind === "close" ? "Close the captured tab?" : "",
    };
}

export function readHostScene(controller: HostController, layout: Layout) {
    const tabs = controller.workspace.tabs;
    const tab = layout.primarySurface === "closed" ? undefined : tabs.resolve(tabs.capture(controller.viewTab("primary")));
    const ready = tab?.surface.kind === "text" && !!controller.workspace.observeDocument(tab.surface.documentId).getSnapshot();
    return hostSceneModel(layout, tab, ready, controller.source.documentId);
}
