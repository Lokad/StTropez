import type { HostDocumentLinks, LinkNote } from "./document-links.ts";
export function documentLinkActions(tools: HostDocumentLinks) {
    const s = tools.state.getSnapshot();
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
export function mountDocumentLinksPanel(host: HTMLElement, tools: HostDocumentLinks): () => void {
    const owner = host.ownerDocument, heading = owner.createElement("h2"), description = owner.createElement("p"), status = owner.createElement("output"), controls = owner.createElement("div"), list = owner.createElement("ul");
    heading.textContent = "Module document links"; description.textContent = documentLinkDescription; status.setAttribute("aria-label", "Module link status"); list.setAttribute("aria-label", "Module link results"); list.tabIndex = -1; tools.bindList(list);
    const buttons = documentLinkActions(tools).map(action => { const button = owner.createElement("button"); button.textContent = action.label; controls.append(button); return button; });
    host.replaceChildren(heading, description, status, controls, list); let previous: unknown, token: number | null = null, page = -1;
    const render = () => { const s = tools.state.getSnapshot(); status.textContent = s.message; for (const [i, action] of documentLinkActions(tools).entries()) { buttons[i]!.disabled = action.disabled; buttons[i]!.onclick = action.invoke; }
        if (previous === s.links && token === s.token && page === s.page) return; previous = s.links; token = s.token; page = s.page;
        list.replaceChildren(...s.links.map(link => { const li = owner.createElement("li"), button = owner.createElement("button"), text = owner.createElement("p"), captured = s.token;
            button.textContent = documentLinkLabel(link); button.disabled = !link.target && !link.resolvable || s.status !== "ready"; button.onclick = () => tools.open(captured, link.ordinal); text.textContent = documentLinkDetails(link); li.append(button, text); return li; }));
    };
    const stop = tools.state.subscribe(render); render(); return () => { stop(); tools.bindList(null); host.replaceChildren(); };
}
