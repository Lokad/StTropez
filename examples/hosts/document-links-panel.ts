import type { HostDocumentLinks, LinkNote, DocumentLinksSnapshot } from "./document-links.ts";
type DocumentLinksPanelTools = Pick<HostDocumentLinks, "discover" | "returnToOrigin" | "cancel" | "previousPage" | "nextPage" | "addCompanion" | "disconnect" | "reconnect" | "bindList" | "open">;
function documentLinkActions(tools: DocumentLinksPanelTools, s: DocumentLinksSnapshot) {
    return [
        { label: "Discover module links", invoke: tools.discover, disabled: !s.available || s.disconnected || s.pending },
        { label: "Return to link origin", invoke: tools.returnToOrigin, disabled: !s.canReturn },
        { label: "Dismiss module links", invoke: tools.cancel, disabled: s.token === null },
        { label: "Previous module links", invoke: tools.previousPage, disabled: !s.page || s.status !== "ready" },
        { label: "Next module links", invoke: tools.nextPage, disabled: (s.page + 1) * 64 >= s.count || s.status !== "ready" },
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
        results: { label: "Module link results", bind: tools.bindList, disabled: s.status !== "ready",
            // Publication reconstructs bounded rows even when only status/focus changes.
            retentionKey: () => JSON.stringify([s.token, s.page, s.links]),
            items: () => s.links.map(link => ({ key: link.from, label: documentLinkLabel(link), details: documentLinkDetails(link), available: !!link.target || !!link.resolvable,
                invoke: () => tools.open(s.token, link.ordinal) } as const)) },
    } as const;
}
export function mountDocumentLinksPanel(host: HTMLElement, tools: HostDocumentLinks): () => void {
    const initial = documentLinksPanelModel(tools, tools.state.getSnapshot());
    const owner = host.ownerDocument, heading = owner.createElement("h2"), description = owner.createElement("p"), status = owner.createElement("output"), controls = owner.createElement("div"), list = owner.createElement("ul");
    host.setAttribute("aria-label", initial.title); heading.textContent = initial.title; description.textContent = initial.description; status.setAttribute("aria-label", initial.status.label); list.setAttribute("aria-label", initial.results.label); list.tabIndex = -1; initial.results.bind(list);
    const buttons = initial.actions.map(action => { const button = owner.createElement("button"); button.textContent = action.label; controls.append(button); return button; });
    host.replaceChildren(heading, description, status, controls, list); let listKey = "", resultButtons: { available: boolean; button: HTMLButtonElement }[] = [];
    const render = () => { const model = documentLinksPanelModel(tools, tools.state.getSnapshot()); status.textContent = model.status.text; for (const [i, action] of model.actions.entries()) { buttons[i]!.disabled = action.disabled; buttons[i]!.onclick = action.invoke; }
        const nextList = model.results.retentionKey(); if (nextList !== listKey) { listKey = nextList; resultButtons = [];
            list.replaceChildren(...model.results.items().map(link => { const li = owner.createElement("li"), button = owner.createElement("button"), text = owner.createElement("p");
                button.textContent = link.label; button.onclick = link.invoke; text.textContent = link.details; resultButtons.push({ available: link.available, button }); li.append(button, text); return li; })); }
        for (const { available, button } of resultButtons) button.disabled = model.results.disabled || !available;
    };
    const stop = tools.state.subscribe(render); render(); return () => { stop(); initial.results.bind(null); host.replaceChildren(); };
}
