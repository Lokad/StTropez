import { Workspace } from "sttropez";
import type { Operation, ResourceId, ResourceTarget, Selection, TabId, TextBuffer, TextEdit, TextResourceHandle } from "sttropez";
import { createActivationSession as createViewSession } from "./activate.js";
import type { ActivationSession } from "./activate.js";

type Source = { key: string; title: string; resource: TextResourceHandle; tab: TabId | undefined; epoch: number; primary: ActivationSession | undefined };
type Discard = { source: Source; target: ResourceTarget; revision: number; epoch: number; confirmed: boolean };
type Job = { operation: Operation; resourceId: ResourceId; revision: number; buffer: TextBuffer };

/** Host-owned tabs and caches; inactive documents own no editor DOM or observable listeners. */
export function createActivationSession(original: string, selection: Selection) {
    const workspace = new Workspace(), sources = new Map<ResourceId, Source>();
    const add = (key: string, title: string, text: string) => {
        const resource = workspace.createTextResource({ scope: "workspace-consumer", resource: key, variant: "working" }, title, { value: text });
        const source: Source = { key, title, resource, tab: workspace.tabs.open({ kind: "text", documentId: resource.documentId }, "primary"), epoch: 0, primary: undefined };
        sources.set(resource.id, source); return source;
    };
    let current = add("source", "Source", original);
    const peerSource = add("peer", "Peer document", "// peer\r\n" + original), peerTab = workspace.tabs.open({ kind: "text", documentId: peerSource.resource.documentId }, "peer");
    for (let i = 1; i <= 100; i++) add(`document-${i}`, `Document ${String(i).padStart(3, "0")}`, `// document ${i}\r\n` + "row Δ😀\r\n".repeat(1000));
    const view = (s: Source) => s.primary ??= createViewSession("", s.key === "source" ? selection : { anchor: 0, head: 0 }, { workspace, source: s.resource, tab: () => s.tab });
    let peer: ActivationSession | undefined = createViewSession("", { anchor: 4, head: 1 }, { workspace, source: peerSource.resource, tab: () => peerTab, label: "Peer source", focus: false });
    view(current);
    let root: HTMLElement | undefined, primaryHost: HTMLElement | undefined, peerHost: HTMLElement | undefined, options: HTMLSelectElement | undefined, closed: HTMLSelectElement | undefined, messageNode: HTMLOutputElement | undefined, progressNode: HTMLOutputElement | undefined;
    let listeners: AbortController | undefined, updateFind: ((value: string) => void) | undefined, chosenClosed = "", message = "Closing a tab retains its document and history.";
    let discard: Discard | undefined, job: Job | undefined, lastJob: Readonly<{ resourceId: ResourceId; revision: number; prefix: string }> | undefined;
    let ticks = 0, disposed = false, query = "", regex = false, readOnly = false, lastBase: ReturnType<ActivationSession["snapshot"]> | undefined;
    const refresh = () => {
        if (messageNode) messageNode.textContent = message;
        if (options) { options.replaceChildren(); for (const s of sources.values()) if (s.tab) options.add(new Option(s.title, s.resource.id)); options.value = current.tab ? current.resource.id : ""; }
        if (closed) { closed.replaceChildren(); for (const s of sources.values()) if (!s.tab) closed.add(new Option(s.title, s.resource.id)); if (sources.has(chosenClosed as ResourceId)) closed.value = chosenClosed; chosenClosed = closed.value; }
    };
    const notify = (value: string) => { message = value; refresh(); };
    const release = () => {
        const captured = discard; if (!captured?.confirmed) return;
        const s = captured.source, valid = () => !s.tab && s.epoch === captured.epoch && workspace.resolveResource(captured.target)?.getSnapshot().revision === captured.revision;
        if (!valid()) { discard = undefined; notify("Discard expired because the captured document changed or reopened."); return; }
        if (workspace.ownership(s.resource.id).tabs) { discard = undefined; notify("Close the document's other view before discarding it."); return; }
        if (job?.resourceId === s.resource.id) { notify("Discard waits for the captured job to finish."); return; }
        s.primary?.dispose(); s.primary = undefined;
        if (workspace.ownership(s.resource.id).leases) { notify("Discard waits for the captured job to finish."); return; }
        if (!valid()) { discard = undefined; notify("Discard expired because the captured document changed."); return; }
        workspace.releaseResource(s.resource.id, true); sources.delete(s.resource.id); if (current === s) current = sources.values().next().value!;
        discard = undefined; notify("Closed document discarded.");
    };
    const mountPrimary = () => { if (primaryHost && current.tab) { view(current).mount(primaryHost, undefined, value => updateFind?.(value), readOnly); if (query) view(current).search(query, regex); else updateFind?.(""); } };
    const open = (s: Source) => {
        if (disposed || !view(current).canUnmount()) { notify("Finish primary typing before switching documents."); return; }
        view(current).unmount(); if (!s.tab) { s.tab = workspace.tabs.open({ kind: "text", documentId: s.resource.documentId }, "primary"); s.epoch++; }
        current = s; mountPrimary(); release(); refresh();
    };
    const close = () => {
        if (!current.tab || !view(current).canUnmount()) { notify("Finish primary typing before closing its tab."); return; }
        const s = current; view(s).unmount(); workspace.tabs.close(s.tab!); s.tab = undefined; s.epoch++; chosenClosed = s.resource.id;
        const next = [...sources.values()].find(candidate => candidate.tab); if (next) { current = next; mountPrimary(); }
        notify("Tab closed. Its document and history are retained."); release();
    };
    const captureJob = () => {
        if (job || !current.tab || !view(current).canUnmount()) return; const d = workspace.document(current.resource.documentId);
        job = { operation: workspace.operations.begin(current.resource.id, "consumer-job"), resourceId: current.resource.id, revision: d.revision, buffer: d.buffer };
        notify(`Job captured ${current.title} at revision ${d.revision}.`);
    };
    const finishJob = () => { if (!job) return; const captured = job; job = undefined;
        lastJob = Object.freeze({ resourceId: captured.resourceId, revision: captured.revision, prefix: captured.buffer.slice(0, Math.min(128, captured.buffer.length)) });
        captured.operation.finish(); notify(`Job finished for captured revision ${captured.revision}.`); release(); };
    const timer = setInterval(() => { ticks++; if (progressNode) progressNode.textContent = `Background activity: ${ticks}`; }, 50);
    const clearDOM = () => { listeners?.abort(); listeners = undefined; root?.remove(); root = primaryHost = peerHost = options = closed = messageNode = progressNode = undefined; updateFind = undefined; };
    const unmount = () => { if (!view(current).canUnmount() || !peer?.canUnmount()) return false; view(current).unmount(); peer.unmount(); clearDOM(); return true; };
    return Object.freeze({
        mount: (host: HTMLElement, at: Selection | undefined, update: (message: string) => void, reading = false) => {
            if (disposed || root) throw new Error("Workspace is unavailable."); listeners = new AbortController(); updateFind = update;
            readOnly = reading;
            const owner = host.ownerDocument, signal = listeners.signal; root = owner.createElement("section"); root.className = "activation-workspace";
            const controls = owner.createElement("div"), label = owner.createElement("label"); label.textContent = "Primary document"; options = owner.createElement("select"); label.append(options); controls.append(label);
            options.addEventListener("change", () => { const s = sources.get(options!.value as ResourceId); if (s) open(s); }, { signal });
            const button = (name: string, action: () => void) => { const node = owner.createElement("button"); node.textContent = name; node.addEventListener("click", action, { signal }); controls.append(node); };
            button("Close primary tab", close); const closedLabel = owner.createElement("label"); closedLabel.textContent = "Closed document"; closed = owner.createElement("select"); closedLabel.append(closed); controls.append(closedLabel);
            closed.addEventListener("change", () => { chosenClosed = closed!.value; }, { signal });
            button("Reopen closed tab", () => { const s = sources.get(chosenClosed as ResourceId); if (s && !s.tab) open(s); });
            button("Discard closed document", () => { const s = sources.get(chosenClosed as ResourceId); if (!s || s.tab) return; discard = { source: s, target: workspace.captureResource(s.resource.id), revision: s.resource.getSnapshot().revision, epoch: s.epoch, confirmed: false }; notify(`Confirm discard of ${s.title} at revision ${discard.revision}.`); });
            button("Confirm discard", () => { if (discard) { discard.confirmed = true; release(); } }); button("Cancel discard", () => { discard = undefined; notify("Discard cancelled."); });
            button("Capture job", captureJob); button("Finish job", finishJob);
            messageNode = owner.createElement("output"); messageNode.setAttribute("aria-label", "Workspace status"); progressNode = owner.createElement("output"); progressNode.setAttribute("aria-label", "Background activity"); progressNode.textContent = `Background activity: ${ticks}`;
            const panes = owner.createElement("div"); panes.className = "workspace-panes"; primaryHost = owner.createElement("div"); peerHost = owner.createElement("div"); panes.append(primaryHost, peerHost); root.append(controls, messageNode, progressNode, panes); host.append(root);
            view(current).mount(primaryHost, at, update, readOnly); peer!.mount(peerHost, undefined, () => {}, readOnly); refresh();
        }, unmount, canUnmount: () => view(current).canUnmount() && !!peer?.canUnmount(),
        search: (value: string, regularExpression: boolean) => { query = value; regex = regularExpression; if (current.tab) view(current).search(query, regex); }, next: () => view(current).next(),
        select: (ranges: readonly Selection[], primary = 0) => view(current).select(ranges, primary), selection: () => view(current).selection(),
        text: () => { const b = workspace.document(current.resource.documentId).buffer; return b.slice(0, b.length); },
        snapshot: () => ({ ...(disposed ? { ...lastBase!, input: null, viewport: null, find: null } : view(current).snapshot()), disposed, diagnostics: workspace.diagnostics(), peer: peer?.snapshot() ?? null,
            workspace: { ticks, timerActive: !disposed, mounted: !!root, current: current.resource.id, pendingJob: job && { resourceId: job.resourceId, revision: job.revision }, lastJob,
                discard: discard && { resourceId: discard.source.resource.id, revision: discard.revision, epoch: discard.epoch, confirmed: discard.confirmed },
                documents: [...sources.values()].map(s => ({ key: s.key, title: s.title, resourceId: s.resource.id, documentId: s.resource.documentId, revision: s.resource.getSnapshot().revision, dirty: s.resource.metadata.getSnapshot().dirty, tab: s.tab ?? null, cachedView: !!s.primary, epoch: s.epoch })) } }),
        workspaceApi: Object.freeze({
            text: (id: ResourceId) => { const s = sources.get(id); if (!s) throw new Error("Document was released."); const b = workspace.document(s.resource.documentId).buffer; return b.slice(0, b.length); },
            edit: (id: ResourceId, expectedRevision: number, edits: readonly TextEdit[]) => { const s = sources.get(id); if (!s) return false; return workspace.edit({ documentId: s.resource.documentId, expectedRevision, edits, origin: "host" }).applied; },
            selectPeer: (ranges: readonly Selection[], primary = 0) => peer?.select(ranges, primary),
        }),
        dispose: () => { if (!disposed) { lastBase = view(current).snapshot(); clearInterval(timer); job?.operation.finish(); job = undefined; discard = undefined; clearDOM();
            peer?.dispose(); peer = undefined; workspace.tabs.close(peerTab);
            for (const s of sources.values()) { s.primary?.dispose(); s.primary = undefined; if (s.tab) workspace.tabs.close(s.tab); s.tab = undefined; workspace.releaseResource(s.resource.id, true); }
            sources.clear(); disposed = true; } return workspace.diagnostics(); },
    });
}
export type WorkspaceSession = ReturnType<typeof createActivationSession>;
