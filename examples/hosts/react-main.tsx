import { Profiler, StrictMode, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import type { Root } from "react-dom/client";
import type { Observable } from "../../src/index.ts";
import { HostController } from "./controller.ts";
import { hostEditor, ViewBindings } from "./bindings.ts";
import { actions, conflictText, statusText } from "./actions.ts";
import { installHostHarness } from "./harness.ts";
import { findText, languageActions, languageFieldKey } from "./language-panel.ts";
import "./style.css";

const controller = new HostController(), bindings = new ViewBindings(controller, hostEditor());
const counters = { form: 0, metadata: 0 };
const formCommitted = () => { counters.form++; };
const metadataCommitted = () => { counters.metadata++; };
function useObserved<T>(store: Observable<T>): T { return useSyncExternalStore(store.subscribe, store.getSnapshot); }

function Commands() {
    return <nav aria-label="Host commands">{actions(controller, bindings).map(action => <button key={action.label} onClick={action.invoke}>{action.label}</button>)}</nav>;
}
function Status() {
    useObserved(controller.review); useObserved(controller.activity); useObserved(controller.source.metadata);
    return <output aria-label="Host operation status">{statusText(controller)}</output>;
}
function SourceMetadata() {
    const metadata = useObserved(controller.source.metadata);
    return <p>{metadata.title} · {metadata.dirty ? "Unsaved" : "Saved"}</p>;
}
function SaveConflict() {
    const conflict = useObserved(controller.saveConflict);
    useObserved(controller.source.metadata); useObserved(controller.comparisonReference); useObserved(controller.layout); useObserved(controller.workspace.tabState);
    return conflict ? <section aria-label="Save conflict"><output aria-live="polite">{conflictText(controller)}</output>
        <button onClick={controller.reviewSaveConflict}>Review remote source</button>
        <button onClick={controller.finishConflictReview} disabled={conflict.review !== "loading"}>Finish remote review</button>
        <button onClick={controller.saveReviewedSource} disabled={!controller.canSaveReviewedSource()}>Save reviewed source</button></section> : null;
}
function InputRecovery() {
    const state = useObserved(controller.recovery), text = state.items.at(-1)?.attemptedText ?? "";
    return <section hidden={state.items.length === 0} aria-label="Input recovery"><output aria-live="polite">{state.items.length} input {state.items.length === 1 ? "change" : "changes"} retained for recovery.</output>
        <pre hidden={!state.visible}>{state.visible ? text.slice(0, 4096) + (text.length > 4096 ? "…" : "") : ""}</pre></section>;
}
function Form() {
    const state = useObserved(controller.connection), layout = useObserved(controller.layout);
    if (layout.formFault) throw new Error("Synthetic host form render failure");
    return state.state === "ready" ? <div><label>Configuration path<input value={state.value.path} onChange={event => controller.setPath(event.currentTarget.value)} /></label>
        <p>{state.value.path ? "" : "Path is required."}</p></div> : <p>{state.state}</p>;
}
function Scene() {
    const layout = useObserved(controller.layout);
    const tabs = useObserved(controller.workspace.tabState);
    const tab = tabs.find(candidate => candidate.id === controller.viewTab("primary"));
    const ready = tab?.surface.kind === "text" && controller.workspace.observeDocument(tab.surface.documentId).getSnapshot() !== undefined;
    const primary = layout.visible && layout.primarySurface === "text" && ready
        ? <div key={`primary:${tab.id}:${tab.generation}`} className="editor-host" ref={bindings.primary} /> : <p>{layout.primarySurface}</p>;
    return <><main><section aria-label="Left host pane">{layout.position === "left" ? primary : null}</section>
        <section aria-label="Right host pane"><Profiler id="form" onRender={formCommitted}><Form /></Profiler>
            {layout.position === "right" ? primary : null}
            {layout.visible ? <div key="secondary" className="editor-host" ref={bindings.secondary} /> : null}</section></main>
        <div role="status" aria-label="Host messages">{layout.modal.kind === "error" ? layout.modal.message : layout.modal.kind === "close" ? "Close the captured tab?" : ""}</div></>;
}
function SourceReview() {
    const layout = useObserved(controller.layout);
    const tabs = useObserved(controller.workspace.tabState), tab = tabs.find(tab => tab.id === controller.viewTab("primary"));
    return layout.navigation.kind === "review" && layout.visible && !layout.formFault && layout.primarySurface === "text"
        && tab?.surface.kind === "text" && tab.surface.documentId === controller.source.documentId
        ? <section className="host-review" aria-label="Source review surface"><div key={`${tab.id}:${tab.generation}`} ref={bindings.comparison} /></section> : null;
}
function LanguageTools() {
    const tools = bindings.language, state = useObserved(tools.state);
    return <section className="host-language" aria-label="Language and find tools"><h2>Language and find</h2>
        <p>Ctrl+Space requests completion; Alt+Enter replaces it. Ctrl+F finds, Ctrl+H replaces, F3 moves to the next match, and Escape returns to source.</p>
        <output aria-label="Language status" aria-live="polite">{state.provider?.message ?? "Focus a source view to use language actions."}</output>
        <ul role="listbox" aria-label="Completion choices">{state.provider?.offerText != null ? <li role="option" aria-selected="true">{state.provider.offerText}</li> : null}</ul>
        <ul aria-label="Source diagnostics">{state.provider?.diagnostics.map((diagnostic, index) => <li key={`${diagnostic.from}:${diagnostic.to}:${index}`}>
            <button onClick={() => tools.selectDiagnostic(index)}>{diagnostic.from}: {diagnostic.message}</button></li>)}</ul>
        <label>Find source<input ref={tools.queryRef} value={state.query} onChange={event => tools.setQuery(event.currentTarget.value)} onKeyDown={event => languageFieldKey(event.nativeEvent, tools, false)} /></label>
        <label>Replacement<input ref={tools.replacementRef} value={state.replacement} onChange={event => tools.setReplacement(event.currentTarget.value)} onKeyDown={event => languageFieldKey(event.nativeEvent, tools, true)} /></label>
        <output aria-label="Find status">{findText(tools)}</output>
        <div>{languageActions(tools).map(action => <button key={action.label} onClick={action.invoke} disabled={action.disabled}>{action.label}</button>)}</div>
    </section>;
}
function App() {
    return <><Commands /><Status /><Profiler id="metadata" onRender={metadataCommitted}><SourceMetadata /></Profiler><InputRecovery /><SaveConflict /><Scene /><SourceReview /><LanguageTools /></>;
}
let root: Root | undefined;
const unmount = () => { root?.unmount(); root = undefined; };
const mount = () => {
    root ??= createRoot(document.getElementById("host")!, { onUncaughtError: controller.reportError,
        onCaughtError: controller.reportError, onRecoverableError: controller.reportError });
    // The explicit host lifecycle returns after refs and Strict Mode's replay are ready for input.
    flushSync(() => root!.render(<StrictMode><App /></StrictMode>));
};
installHostHarness(controller, bindings, "react", mount, unmount, () => ({ ...counters }));
