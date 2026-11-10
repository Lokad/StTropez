import type { ActivationSession } from "./activate.js";
import type { WorkspaceSession } from "./workspace.js";
import type { Selection } from "sttropez";

const preview = document.getElementById("text")!, editorHost = document.getElementById("editor")!, status = document.getElementById("status")!;
const edit = document.getElementById("edit") as HTMLButtonElement, cancel = document.getElementById("cancel") as HTMLButtonElement, readOnly = document.getElementById("preview") as HTMLButtonElement;
const query = document.getElementById("query") as HTMLInputElement, regex = document.getElementById("regex") as HTMLInputElement, next = document.getElementById("next") as HTMLButtonElement, findStatus = document.getElementById("find-status")!;
const original = "// café😀 e\u0301\r\nconst café = '😀';\r\nend\rthird\n" + "row Δ😀\r\n".repeat(new URLSearchParams(location.search).get("large") === "1" ? 100000 : 8);
const workspaceMode = document.body.hasAttribute("data-workspace");
const listeners = new AbortController(); let session: ActivationSession | WorkspaceSession | undefined, generation = 0, abort: AbortController | undefined, stylesheet: HTMLLinkElement | undefined;
let phase: "preview" | "loading" | "editing" | "disposed" = "preview";
let retainedText = original;
preview.textContent = original;
const controls = () => { edit.disabled = phase !== "preview"; cancel.disabled = phase !== "loading"; readOnly.disabled = phase !== "editing";
    query.disabled = regex.disabled = next.disabled = phase !== "editing"; };
function selection(): Selection | undefined {
    const s = window.getSelection(), text = preview.firstChild;
    return s && text && s.anchorNode === text && s.focusNode === text ? { anchor: s.anchorOffset, head: s.focusOffset } : undefined;
}
function styles(signal: AbortSignal, attempt: number): Promise<HTMLLinkElement> {
    return new Promise((resolve, reject) => {
        const link = document.createElement("link"); link.rel = "stylesheet"; link.href = new URL(`./editor.css?activation=${attempt}`, import.meta.url).href;
        const finish = (error?: Error) => { link.onload = link.onerror = null; signal.removeEventListener("abort", stop); if (error) { link.remove(); reject(error); } else resolve(link); };
        const stop = () => finish(new Error("Cancelled")); link.onload = () => finish(); link.onerror = () => finish(new Error("Styles unavailable")); signal.addEventListener("abort", stop, { once: true }); document.head.append(link);
    });
}
async function activate() {
    if (phase !== "preview") return; const token = ++generation, at = selection(), controller = new AbortController(); abort = controller; phase = "loading"; controls(); status.textContent = "Loading editor…";
    let link: HTMLLinkElement | undefined;
    controller.signal.addEventListener("abort", () => link?.remove(), { once: true });
    try {
        const module = session ? undefined : import(new URL(`./${workspaceMode ? "workspace" : "activate"}.js?activation=${token}`, import.meta.url).href) as Promise<{ createActivationSession: (text: string, at: Selection) => ActivationSession | WorkspaceSession }>;
        const [loaded, css] = await Promise.all([module, styles(controller.signal, token).then(value => { link = value; return value; })]);
        if (generation !== token || controller.signal.aborted) { css.remove(); return; }
        session ??= loaded!.createActivationSession(original, at ?? { anchor: 0, head: 0 });
        editorHost.hidden = false; session.mount(editorHost, at, message => { findStatus.textContent = message; });
        stylesheet = css; link = undefined; preview.hidden = true; phase = "editing"; controls(); status.textContent = "Editing";
        if (query.value) session.search(query.value, regex.checked);
    } catch {
        controller.abort(); link?.remove();
        if (generation === token) { session?.unmount(); editorHost.hidden = true; preview.hidden = false; phase = "preview"; controls(); status.textContent = "Editor unavailable. Text retained; retry Edit."; }
    } finally { if (generation === token) abort = undefined; }
}
function showPreview() {
    if (phase !== "editing") return; if (!session!.unmount()) { status.textContent = "Finish typing before switching to read only."; return; }
    const at = session!.selection(); preview.textContent = session!.text(); preview.hidden = false; editorHost.hidden = true; stylesheet?.remove(); stylesheet = undefined;
    phase = "preview"; controls(); status.textContent = "Read only"; findStatus.textContent = ""; preview.focus({ preventScroll: true });
    const text = preview.firstChild; if (text) window.getSelection()?.setBaseAndExtent(text, at.anchor, text, at.head);
}
function cancelActivation() { if (phase !== "loading") return; generation++; abort?.abort(); abort = undefined; phase = "preview"; controls(); status.textContent = "Activation cancelled. Text retained."; }
function dispose() { if (phase !== "disposed") { generation++; abort?.abort(); abort = undefined; stylesheet?.remove(); stylesheet = undefined; retainedText = session?.text() ?? original;
    preview.textContent = retainedText; preview.hidden = false; editorHost.hidden = true; listeners.abort(); phase = "disposed"; controls(); status.textContent = "Closed. Text retained."; } return session?.dispose() ?? null; }
edit.addEventListener("click", () => { void activate(); }, { signal: listeners.signal }); cancel.addEventListener("click", cancelActivation, { signal: listeners.signal }); readOnly.addEventListener("click", showPreview, { signal: listeners.signal });
const search = () => { if (phase === "editing") session?.search(query.value, regex.checked); };
query.addEventListener("input", search, { signal: listeners.signal }); regex.addEventListener("change", search, { signal: listeners.signal }); next.addEventListener("click", () => session?.next(), { signal: listeners.signal }); window.addEventListener("pagehide", dispose, { once: true, signal: listeners.signal });
const fixture = Object.freeze({ snapshot: () => ({ phase, generation, session: session?.snapshot() ?? null }), text: () => phase === "disposed" ? retainedText : session?.text() ?? original,
    select: (ranges: readonly Selection[], primary?: number) => session?.select(ranges, primary), workspace: () => session && "workspaceApi" in session ? session.workspaceApi : undefined, dispose });
declare global { interface Window { activationFixture: typeof fixture } }
window.activationFixture = fixture;
