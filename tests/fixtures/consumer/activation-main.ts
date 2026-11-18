import type { ActivationSession } from "./activate.js";
import type { WorkspaceSession } from "./workspace.js";
import type { Selection } from "sttropez";
import { createPreview } from "./preview.js";

const preview = document.getElementById("text")!, editorHost = document.getElementById("editor")!, status = document.getElementById("status")!;
const edit = document.getElementById("edit") as HTMLButtonElement, cancel = document.getElementById("cancel") as HTMLButtonElement, readOnly = document.getElementById("preview") as HTMLButtonElement;
const snapshot = document.getElementById("snapshot") as HTMLButtonElement;
const query = document.getElementById("query") as HTMLInputElement, regex = document.getElementById("regex") as HTMLInputElement, next = document.getElementById("next") as HTMLButtonElement, findStatus = document.getElementById("find-status")!;
const large = new URLSearchParams(location.search).get("large") === "1";
const original = "// café😀 e\u0301\r\nconst café = '😀';\r\nend\rthird\n" + (large ? "row Δ😀 12345678901234\r\n" : "row Δ😀\r\n").repeat(large ? 100000 : 8);
const workspaceMode = document.body.hasAttribute("data-workspace");
const listeners = new AbortController(); let session: ActivationSession | WorkspaceSession | undefined, generation = 0, abort: AbortController | undefined, stylesheet: HTMLLinkElement | undefined;
let phase: "preview" | "loading" | "editing" | "reading" | "disposed" = "preview";
let retainedText = original, toolbarSelection: Selection | undefined;
const reader = createPreview(preview, listeners.signal, () => { if (phase === "preview") { toolbarSelection = reader.selection() ?? toolbarSelection; edit.focus(); } }); reader.setText(original);
// Some engines clear native DOM selection when Tab moves between toolbar controls.
document.addEventListener("keydown", event => { if (phase === "preview" && event.key === "Tab") toolbarSelection = reader.selection() ?? toolbarSelection; }, { capture: true, signal: listeners.signal });
const mounted = () => phase === "editing" || phase === "reading";
const controls = () => { edit.disabled = phase !== "preview" && phase !== "reading"; cancel.disabled = phase !== "loading"; readOnly.disabled = phase !== "preview" && phase !== "editing"; snapshot.disabled = !mounted();
    query.disabled = regex.disabled = next.disabled = !mounted(); };
function captureSnapshot() {
    const s = session!.snapshot();
    return { resourceId: s.resourceId, documentId: s.documentId, viewId: s.viewId, revision: s.revision, tab: s.tab, selections: s.selections };
}
let snapshotCapture: ReturnType<typeof captureSnapshot> | undefined;
function currentSnapshot(captured: typeof snapshotCapture): boolean {
    if (!captured || !session) return false; const current = captureSnapshot();
    return captured.resourceId === current.resourceId && captured.documentId === current.documentId && captured.viewId === current.viewId
        && captured.revision === current.revision && captured.tab?.id === current.tab?.id && captured.tab?.generation === current.tab?.generation && captured.selections === current.selections;
}
function selection(): Selection | undefined {
    return reader.selection() ?? toolbarSelection;
}
function styles(signal: AbortSignal, attempt: number): Promise<HTMLLinkElement> {
    return new Promise((resolve, reject) => {
        const link = document.createElement("link"); link.rel = "stylesheet"; link.href = new URL(`./editor.css?activation=${attempt}`, import.meta.url).href;
        const finish = (error?: Error) => { link.onload = link.onerror = null; signal.removeEventListener("abort", stop); if (error) { link.remove(); reject(error); } else resolve(link); };
        const stop = () => finish(new Error("Cancelled")); link.onload = () => finish(); link.onerror = () => finish(new Error("Styles unavailable")); signal.addEventListener("abort", stop, { once: true }); document.head.append(link);
    });
}
async function activate(reading = false) {
    if (mounted()) { if ((phase === "reading") !== reading) switchMode(reading); return; }
    if (phase !== "preview") return; const token = ++generation, at = selection(), captured = snapshotCapture, restoring = !!session, controller = new AbortController(); abort = controller; phase = "loading"; controls(); status.textContent = reading ? "Loading reader…" : "Loading editor…";
    let link: HTMLLinkElement | undefined;
    controller.signal.addEventListener("abort", () => link?.remove(), { once: true });
    try {
        const module = session ? undefined : import(new URL(`./${workspaceMode ? "workspace" : "activate"}.js?activation=${token}`, import.meta.url).href) as Promise<{ createActivationSession: (text: string, at: Selection) => ActivationSession | WorkspaceSession }>;
        const [loaded, css] = await Promise.all([module, styles(controller.signal, token).then(value => { link = value; return value; })]);
        if (generation !== token || controller.signal.aborted) { css.remove(); return; }
        const expired = restoring && !currentSnapshot(captured);
        session ??= loaded!.createActivationSession(original, at ?? { anchor: 0, head: 0 });
        editorHost.hidden = false; session.mount(editorHost, expired ? undefined : at, message => { findStatus.textContent = message; }, reading);
        stylesheet = css; link = undefined; preview.hidden = true; phase = reading ? "reading" : "editing"; controls();
        const label = reading ? "Read only" : "Editing"; status.textContent = expired ? `${label}. Snapshot selection expired; kept the current selection.` : label;
        snapshotCapture = undefined; toolbarSelection = undefined;
        if (query.value) session.search(query.value, regex.checked);
    } catch {
        controller.abort(); link?.remove();
        if (generation === token) { session?.unmount(); editorHost.hidden = true; preview.hidden = false; phase = "preview"; controls(); status.textContent = reading ? "Reader unavailable. Text retained; retry Read only." : "Editor unavailable. Text retained; retry Edit."; }
    } finally { if (generation === token) abort = undefined; }
}
function showPreview() {
    if (!mounted()) return; if (!session!.unmount()) { status.textContent = "Finish typing before showing a snapshot."; return; }
    snapshotCapture = captureSnapshot(); toolbarSelection = undefined;
    const at = session!.selection(); reader.setText(session!.text()); preview.hidden = false; editorHost.hidden = true; stylesheet?.remove(); stylesheet = undefined;
    phase = "preview"; controls(); status.textContent = "Snapshot"; findStatus.textContent = ""; preview.focus({ preventScroll: true });
    reader.select(at);
}
function switchMode(reading: boolean) {
    if (!mounted()) return;
    if (!session!.unmount()) { status.textContent = "Finish typing before switching modes."; return; }
    try {
        session!.mount(editorHost, undefined, message => { findStatus.textContent = message; }, reading);
        phase = reading ? "reading" : "editing"; controls(); status.textContent = reading ? "Read only" : "Editing";
        if (query.value) session!.search(query.value, regex.checked);
    } catch { showPreview(); status.textContent = reading ? "View unavailable. Text retained in snapshot; retry Read only." : "View unavailable. Text retained in snapshot; retry Edit."; }
}
function cancelActivation() { if (phase !== "loading") return; generation++; abort?.abort(); abort = undefined; phase = "preview"; controls(); status.textContent = "Activation cancelled. Text retained."; }
function dispose() { if (phase !== "disposed") { generation++; abort?.abort(); abort = undefined; stylesheet?.remove(); stylesheet = undefined; retainedText = session?.text() ?? original;
    snapshotCapture = undefined; toolbarSelection = undefined; reader.setText(retainedText); preview.hidden = false; editorHost.hidden = true; listeners.abort(); phase = "disposed"; controls(); status.textContent = "Closed. Text retained."; } return session?.dispose() ?? null; }
edit.addEventListener("click", () => { void activate(); }, { signal: listeners.signal }); cancel.addEventListener("click", cancelActivation, { signal: listeners.signal }); readOnly.addEventListener("click", () => { void activate(true); }, { signal: listeners.signal }); snapshot.addEventListener("click", showPreview, { signal: listeners.signal });
const search = () => { if (mounted()) session?.search(query.value, regex.checked); };
query.addEventListener("input", search, { signal: listeners.signal }); regex.addEventListener("change", search, { signal: listeners.signal }); next.addEventListener("click", () => session?.next(), { signal: listeners.signal });
window.addEventListener("pagehide", event => { if (!event.persisted) dispose(); }, { signal: listeners.signal });
// Preserve both session shapes instead of inferring only their structural common type.
const fixture = Object.freeze({ snapshot: () => ({ phase, generation, session: (session?.snapshot() ?? null) as ReturnType<ActivationSession["snapshot"]> | ReturnType<WorkspaceSession["snapshot"]> | null }), text: () => phase === "disposed" ? retainedText : session?.text() ?? original,
    select: (ranges: readonly Selection[], primary?: number) => session?.select(ranges, primary), workspace: () => session && "workspaceApi" in session ? session.workspaceApi : undefined, dispose });
declare global { interface Window { activationFixture: typeof fixture } }
window.activationFixture = fixture;
