import type { HostDocumentLinks, LinkNote, DocumentLinksSnapshot } from "./document-links.ts";
import { pageActions } from "./panel-actions.ts";
import { createDestinationList, createToolPanel } from "./tool-panel.ts";
type DocumentLinksPanelTools = Pick<HostDocumentLinks, "discover" | "returnToOrigin" | "cancel" | "addCompanion" | "disconnect" | "reconnect" | "bindList">;
function documentLinkActions(tools: DocumentLinksPanelTools, s: DocumentLinksSnapshot) {
    return [
        { label: "Discover module links", invoke: tools.discover, disabled: !s.available || s.disconnected || s.pending },
        { label: "Return to link origin", invoke: tools.returnToOrigin, disabled: !s.canReturn },
        { label: "Dismiss module links", invoke: tools.cancel, disabled: s.requestView === null },
        ...pageActions("module links", s.status === "ready" ? s.paging : null),
        { label: "Add module companion", invoke: tools.addCompanion, disabled: s.pending },
        { label: "Disconnect link provider", invoke: tools.disconnect, disabled: !s.connected && !s.pending },
        { label: "Reconnect link provider", invoke: tools.reconnect, disabled: !s.disconnected && s.status !== "failed" }
    ];
}
export const documentLinkDescription = 'Exact import-line fixture: import "module"; with LF/CRLF and optional leading BOM. Only host-registered working resources can open. Unresolved modules stay visible. This line grammar does not resolve general language syntax, scopes or URLs. F4 discovers/focuses the list; Shift+F4 returns to the captured source.';
export const documentLinkLabel = (link: LinkNote) => `Open ${link.module} at ${link.line}:${link.column} → ${link.targetTitle ?? "unresolved"}`;
export const documentLinkDetails = (link: LinkNote) => `${link.title} [${link.from},${link.to}) · ${link.tooltip}${link.target ? ` · ${link.target.resource} · ${link.target.document} @ revision ${link.target.revision}` : ""}`;
/** Result callbacks retain the displayed request even when a later page is published. */
export function documentLinksPanelModel(tools: DocumentLinksPanelTools, s: DocumentLinksSnapshot) {
    return {
        title: "Module document links", description: documentLinkDescription, status: { label: "Module link status", text: s.message },
        actions: documentLinkActions(tools, s),
        results: { label: "Module link results", identity: s.links, retainKeys: true, bind: tools.bindList, disabled: s.status !== "ready",
            items: () => s.links.map((link, index) => ({ key: `${s.page}:${index}:${link.from}:${link.to}`, label: documentLinkLabel(link), details: documentLinkDetails(link), available: !!link.target || !!link.resolvable,
                invoke: link.open } as const)) },
    } as const;
}
export function mountDocumentLinksPanel(host: HTMLElement, tools: HostDocumentLinks): () => void {
    const { owner, initial, controls, mount } = createToolPanel(host, tools.state, state => documentLinksPanelModel(tools, state));
    const results = createDestinationList(owner, initial.results);
    return mount([controls, results.element], model => results.render(model.results), results.dispose);
}
