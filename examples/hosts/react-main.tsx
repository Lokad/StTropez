import { Profiler, StrictMode, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import type { Root } from "react-dom/client";
import type { Observable } from "../../src/index.ts";
import { HostController } from "./controller.ts";
import { hostEditor, ViewBindings } from "./bindings.ts";
import { actions, conflictText, statusText } from "./actions.ts";
import { installHostHarness } from "./harness.ts";
import { findText, foldText, languageActions, languageToolsKey } from "./language-panel.ts";
import { domainActions } from "./domain-panel.ts";
import { navigationActions } from "./navigation-panel.ts";
import { projectActions } from "./project-panel.ts";
import { documentColorActions, documentColorDescription, documentColorLabel, colorEditLabel } from "./document-colors-panel.ts";
import { documentLinkActions, documentLinkDescription, documentLinkLabel, documentLinkDetails } from "./document-links-panel.ts";
import { actionsControls, actionsDescription, actionTarget } from "./actions-panel.ts";
import { renameActions, renameDescriptionFor, renameTarget } from "./rename-panel.ts";
import { signatureActions } from "./signature-panel.ts";
import { HostDraftRecovery } from "./draft-recovery.ts";
import { createBrowserDraftStore } from "./draft-store.ts";
import { draftActions } from "./draft-panel.ts";
import { configurationValidation } from "./configuration.ts";
import { configurationActions, formActions, formSaveKey } from "./configuration-panel.ts";
import "./style.css";

const controller = new HostController(), bindings = new ViewBindings(controller, hostEditor());
const draft = new HostDraftRecovery(controller, createBrowserDraftStore(window)); draft.attachNavigation(window);
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
    return conflict ? <section aria-label="Save conflict"><output>{conflictText(controller)}</output>
        <button onClick={controller.reviewSaveConflict}>Review remote source</button>
        <button onClick={controller.finishConflictReview} disabled={conflict.review !== "loading"}>Finish remote review</button>
        <button onClick={controller.saveReviewedSource} disabled={!controller.canSaveReviewedSource()}>Save reviewed source</button></section> : null;
}
function InputRecovery() {
    const state = useObserved(controller.recovery), text = state.items.at(-1)?.attemptedText ?? "";
    return <section hidden={state.items.length === 0} aria-label="Input recovery"><output>{state.items.length} input {state.items.length === 1 ? "change" : "changes"} retained for recovery.</output>
        <pre hidden={!state.visible}>{state.visible ? text.slice(0, 4096) + (text.length > 4096 ? "…" : "") : ""}</pre></section>;
}
function DraftRecovery() {
    const s = useObserved(draft.state);
    return <section className="host-language" aria-label="Draft recovery"><h2>Draft recovery</h2>
        <output aria-label="Draft recovery status">{s.message}</output>
        <progress aria-label="Draft storage progress" hidden={!s.busy} />
        <p>{s.unprotected ? "Current inputs need a recovery checkpoint before leaving." : "Checkpoint copies do not save or run inputs."}</p>
        <div>{draftActions(draft).map(action => <button key={action.label} disabled={action.disabled} onClick={action.invoke}>{action.label}</button>)}</div>
        <pre hidden={s.preview === null}>{s.preview ?? ""}</pre></section>;
}
function ConfigurationSavePanel() {
    const save = controller.configurationSave, state = useObserved(save.state); useObserved(controller.connection);
    return <section className="host-language" aria-label="Configuration save" onKeyDown={event => formSaveKey(event, save)}><h2>Configuration save</h2>
        <output aria-label="Configuration save status">{save.statusText()}</output>
        <div>{configurationActions(save).map(action => <button key={action.label} disabled={action.disabled} onClick={action.invoke}>{action.label}</button>)}</div>
        <pre hidden={state.preview === null}>{state.preview ?? ""}</pre></section>;
}
function TransferWorkspace() {
    const transfer = controller.transfer, state = useObserved(transfer.resource), save = useObserved(transfer.save.state), runs = useObserved(controller.runResources.state), inspection = controller.runResources.inspect();
    const readOnly = state.state !== "ready" || !state.metadata.capabilities.edit.includes("human") || state.metadata.editLock !== null;
    return <section className="host-language" aria-label="Transfer workspace"><h2>Transfer workspace</h2>
        <div onKeyDown={e => formSaveKey(e, transfer.save)}>{state.state === "ready" ? <>
            <label>Transfer destination<input value={state.value.destination} readOnly={readOnly} aria-invalid={transfer.save.validation() !== null} onChange={e => transfer.update("destination", e.currentTarget.value)} /></label>
            <label>Transfer batch size<input value={state.value.batchSize} readOnly={readOnly} inputMode="numeric" aria-invalid={transfer.save.validation() !== null} onChange={e => transfer.update("batchSize", e.currentTarget.value)} /></label></> : <p>{state.state}</p>}
            <output aria-label="Transfer save status">{transfer.save.statusText()}</output>
            <div>{formActions(transfer.save, "transfer settings").map(a => <button key={a.label} disabled={a.disabled} onClick={a.invoke}>{a.label}</button>)}</div><pre hidden={save.preview === null}>{save.preview ?? ""}</pre></div>
        <h3>Captured Runs and logs</h3><ul>{runs.runs.map(run => <li key={run.id}><span>Run {run.number}: {run.status}, {run.progress}% · {run.id} </span>
            <button onClick={() => controller.runResources.open(run.id)}>Inspect Run {run.number}</button>
            <button disabled={run.status !== "running" || run.progress >= 90} onClick={() => controller.runResources.advance(run.id)}>Advance Run {run.number} progress</button>
            {run.logs.map((id, i) => <button key={id} onClick={() => controller.runResources.open(id)}>Inspect Run {run.number} log {i + 1}</button>)}</li>)}</ul>
        <section aria-label="Resource inspection" hidden={inspection === null}><h3>{inspection?.title}</h3><p>{inspection?.text}</p><pre hidden={inspection?.preview == null}>{inspection?.preview ?? ""}</pre>
            <div>{inspection?.links.map(l => <button key={l.id} onClick={() => controller.runResources.open(l.id)}>{l.label}</button>)}</div>
            <button onClick={() => { if (runs.selected) controller.runResources.open(runs.selected); }}>Refresh resource inspection</button></section></section>;
}
function Form() {
    const state = useObserved(controller.connection), layout = useObserved(controller.layout);
    if (layout.formFault) throw new Error("Synthetic host form render failure");
    return state.state === "ready" ? <div onKeyDown={event => formSaveKey(event, controller.configurationSave)}><label>Configuration path<input value={state.value.path}
        readOnly={!state.metadata.capabilities.edit.includes("human") || state.metadata.editLock !== null} aria-invalid={configurationValidation(state.value) !== null}
        onChange={event => controller.setPath(event.currentTarget.value)} /></label><p>{configurationValidation(state.value)}</p></div> : <p>{state.state}</p>;
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
        ? <section className="host-review" aria-label="Source review surface"><ReviewVersions /><div key={`${tab.id}:${tab.generation}`} ref={bindings.comparison} /></section> : null;
}
function ReviewVersions() {
    const state = useObserved(controller.variants.state), reference = useObserved(controller.comparisonReference), selected = state.requested ?? state.selected,
        pinned = selected && !state.choices.some(choice => choice.id === selected.id && choice.version === selected.version);
    return <div><label>Review version <select aria-label="Review version" value={pinned ? "__captured" : selected?.id ?? ""}
        onChange={event => { if (event.currentTarget.value) controller.variants.review(event.currentTarget.value); }}>
        <option value="">Choose a version</option><option value="__captured" disabled hidden={!pinned}>{pinned ? `Captured ${selected.label} · ${selected.version}` : ""}</option>
        {state.choices.map(choice => <option key={choice.id} value={choice.id}>{choice.label} · {choice.version}</option>)}
    </select></label><output aria-label="Version review status">{state.message} Reference: {reference.baseline.version}.</output>
        <button onClick={controller.variants.keepDraft}>Keep draft version</button><button onClick={controller.variants.finishNext} disabled={!state.pending}>Finish version load</button>
        <button onClick={controller.variants.failNext} disabled={!state.pending}>Fail version load</button><button onClick={controller.variants.cancel} disabled={!state.pending}>Cancel version load</button>
        <button onClick={bindings.beginDiscard}>Discard reviewed changes</button><button onClick={bindings.finishDiscard}>Confirm reviewed discard</button><button onClick={bindings.cancelDiscard}>Cancel reviewed discard</button></div>;
}
function LanguageTools() {
    const tools = bindings.language, state = useObserved(tools.state);
    const choices = state.provider?.choices ?? (state.provider?.offerText != null ? [state.provider.offerText] : []);
    return <section ref={tools.toolsRef} onKeyDown={event => languageToolsKey(event.nativeEvent, tools)} className="host-language" aria-label="Language and find tools"><h2>Language and find</h2>
        <p>Ctrl+Space requests completion; Alt+Enter replaces it. Ctrl+F finds, Ctrl+H replaces, F3 moves to the next match, and Escape returns to source. Ctrl+S saves the working source.</p>
        <output aria-label="Language status">{state.readOnlyReference ? "Search in the read-only reference. Replacement is unavailable." : state.provider?.message ?? "Focus a source view to use language actions."}</output>
        <ul role="listbox" aria-label="Completion choices">{choices.map((label, index) => <li key={`${index}:${label}`} role="option" aria-selected={index === (state.provider?.choiceIndex ?? 0)}><button onClick={() => tools.chooseCompletion(index)}>{label}</button></li>)}</ul>
        <ul aria-label="Source diagnostics">{state.provider?.diagnostics.map((diagnostic, index) => <li key={`${diagnostic.from}:${diagnostic.to}:${index}`}>
            <button onClick={() => tools.selectDiagnostic(index)}>{diagnostic.from}: {diagnostic.message}</button></li>)}</ul>
        <ul aria-label="Unversioned diagnostics">{state.provider?.unversionedDiagnostics?.map((message, index) => <li key={index}>{message}</li>)}</ul>
        <label>Find source<input ref={tools.queryRef} value={state.query} onChange={event => tools.setQuery(event.currentTarget.value)} /></label>
        <label>Replacement<input ref={tools.replacementRef} disabled={state.readOnlyReference} value={state.replacement} onChange={event => tools.setReplacement(event.currentTarget.value)} /></label>
        <label><input type="checkbox" checked={state.wholeWord} onChange={event => tools.setWholeWord(event.currentTarget.checked)} />Whole word</label>
        <label><input type="checkbox" checked={state.matchCase} onChange={event => tools.setMatchCase(event.currentTarget.checked)} />Match case</label>
        <label><input type="checkbox" checked={state.regularExpression} onChange={event => tools.setRegularExpression(event.currentTarget.checked)} />Regular expression</label>
        <output aria-label="Find status">{findText(tools)}</output>
        <output aria-label="Fold status">{foldText(tools)}</output>
        <div>{languageActions(tools).map(action => <button key={action.label} onClick={action.invoke} disabled={action.disabled}>{action.label}</button>)}</div>
    </section>;
}
function SymbolInfo() {
    const state = useObserved(bindings.hover.state);
    return <div className="host-symbol-info" role="tooltip" hidden={!state.visible} style={{ left: state.left, top: state.top }}
        onPointerEnter={bindings.hover.enterPopup} onPointerLeave={bindings.hover.leavePopup} onPointerDown={event => event.preventDefault()}>
        <pre>{state.text || state.message}</pre><span>Escape dismisses symbol information.</span></div>;
}
function SignatureTools() {
    const tools = bindings.signature, s = useObserved(tools.state);
    return <><section className="host-language" aria-label="Signature commands"><h2>Signature help</h2><output aria-label="Signature help status">{s.message}</output>
        <div>{signatureActions(tools).map(action => <button key={action.label} onPointerDown={event => event.preventDefault()} onClick={action.invoke} disabled={action.disabled}>{action.label}</button>)}</div></section>
        <div className="host-symbol-info host-signature" role="tooltip" aria-label="Signature help" hidden={!s.visible} style={{ left: s.left, top: s.top }} onPointerDown={event => event.preventDefault()}>
            <pre>{s.before || (s.status === "pending" ? s.message : "")}{s.parameter && <mark aria-label="Active signature parameter">{s.parameter}</mark>}{s.after}</pre><p>{s.documentation}</p><p>{s.parameterDocumentation}</p></div></>;
}
function TablePasteTools() {
    const tools = bindings.tablePaste, state = useObserved(tools.state);
    return <section className="host-language" aria-label="Table paste tools"><label><input type="checkbox" checked={state.enabled} disabled={!state.available}
        onChange={event => tools.setEnabled(event.currentTarget.checked)} />Paste tables as CSV</label>
        <output aria-label="Table paste status">{state.message}</output>
        <progress aria-label="Table conversion progress" hidden={state.status !== "converting"} />
        <button disabled={state.status !== "converting"} onClick={tools.cancel}>Cancel table paste</button></section>;
}
function App() {
    return <><Commands /><Status /><Profiler id="metadata" onRender={metadataCommitted}><SourceMetadata /></Profiler><InputRecovery /><SaveConflict /><Scene /><SourceReview /><ConfigurationSavePanel /><TransferWorkspace /><DraftRecovery /><LanguageTools /><TablePasteTools /><DomainTools /><NavigationTools /><ProjectTools /><RenameTools /><ActionsTools /><DocumentLinksTools /><DocumentColorsTools /><SignatureTools /><SymbolInfo /></>;
}
function DocumentColorsTools() {
    const tools = bindings.colors, s = useObserved(tools.state);
    return <section className="host-language" aria-label="Document colors"><h2>Document colors</h2><p>{documentColorDescription}</p>
        <output aria-label="Document color status">{s.message}</output><div>{documentColorActions(tools).map(action => <button key={action.label} disabled={action.disabled} onClick={action.invoke}>{action.label}</button>)}</div>
        <ul ref={tools.bindList} tabIndex={-1} aria-label="Document color results">{s.colors.map(color => <li key={color.from}><span className="host-color-swatch" aria-hidden="true" style={{backgroundColor: color.css}} /><button disabled={s.pending} aria-pressed={s.selected === color.ordinal} onClick={() => tools.inspect(s.token, color.ordinal)}>{documentColorLabel(color)}</button></li>)}</ul>
        <label>Proposed color <input ref={tools.bindValue} type="text" maxLength={96} value={s.value} onChange={event => tools.setValue(event.currentTarget.value)} /></label><span className="host-color-swatch" aria-hidden="true" style={{backgroundColor: s.css ?? "transparent"}} />
        <button disabled={!s.canPreview || s.pending} onClick={tools.preview}>Preview color presentations</button><label>Color presentation <select disabled={!s.choices.length || s.pending} value={s.presentation} onChange={event => tools.setPresentation(event.currentTarget.value)}>{s.choices.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}</select></label>
        <button disabled={!s.canApply || s.pending} onClick={() => tools.apply(s.token, s.previewToken, s.presentation)}>Apply captured color</button><ol aria-label="Proposed color edits">{s.edits.map((at,i) => <li key={i}><pre>{colorEditLabel(at)}</pre></li>)}</ol>
        {s.changed && <button disabled={s.pending || s.token !== null} onClick={tools.openChanged}>Open color changes in {s.changed.title}</button>}</section>;
}
function DocumentLinksTools() {
    const tools = bindings.links, s = useObserved(tools.state);
    return <section className="host-language" aria-label="Module document links"><h2>Module document links</h2><p>{documentLinkDescription}</p>
        <output aria-label="Module link status">{s.message}</output>
        <div>{documentLinkActions(tools).map(action => <button key={action.label} disabled={action.disabled} onClick={action.invoke}>{action.label}</button>)}</div>
        <ul ref={tools.bindList} tabIndex={-1} aria-label="Module link results">{s.links.map(link => <li key={link.from}><button disabled={!link.target || s.status !== "ready"} onClick={() => tools.open(s.token, link.ordinal)}>{documentLinkLabel(link)}</button><p>{documentLinkDetails(link)}</p></li>)}</ul></section>;
}
function ActionsTools() {
    const tools = bindings.actions, s = useObserved(tools.state);
    return <section className="host-language" aria-label="Code actions"><h2>Code actions</h2><p>{actionsDescription}</p>
        <output aria-label="Code action status">{s.message}</output>
        <label>Action module <input ref={tools.bindModule} type="text" maxLength={64} value={s.module} onChange={event => tools.setModule(event.currentTarget.value)} /></label>
        <div>{actionsControls(tools).map(action => <button key={action.label} onClick={action.invoke} disabled={action.disabled}>{action.label}</button>)}</div>
        <p aria-label="Captured action title">{s.title}</p><ol aria-label="Proposed action edits">{s.edits.map((at, i) => <li key={i}><pre>{actionTarget(at)}</pre></li>)}</ol>
        {s.changed && <button disabled={s.token !== null} onClick={tools.openChanged}>Open action changes in {s.changed.title}</button>}</section>;
}
function RenameTools() {
    const tools = bindings.rename, s = useObserved(tools.state);
    return <section className="host-language" aria-label="Rename preview"><h2>Rename preview</h2><p>{renameDescriptionFor(tools)}</p>
        <output aria-label="Rename status">{s.message}</output>
        <label>New identifier <input ref={tools.bindName} type="text" maxLength={256} value={s.name} onChange={event => tools.setName(event.currentTarget.value)} /></label>
        <div>{renameActions(tools).map(action => <button key={action.label} onClick={action.invoke} disabled={action.disabled}>{action.label}</button>)}</div>
        <ol aria-label="Captured rename targets" start={s.page * 64 + 1}>{s.locations.map(at => <li key={at.ordinal}>{renameTarget(at, s.symbol, s.name)}</li>)}</ol>
        <ul aria-label="Renamed resources">{s.changes.map(c => <li key={c.document}><button disabled={s.token !== null} onClick={() => tools.openChanged(c.document)}>Open renamed changes in {c.title}</button></li>)}</ul></section>;
}
function ProjectTools() {
    const tools = bindings.project, state = useObserved(tools.state);
    return <section className="host-language" aria-label="Workspace provider"><h2>Workspace provider</h2>
        <output aria-label="Workspace provider status">{state.message}</output>
        <div>{projectActions(tools).map(action => <button key={action.label} onClick={action.invoke} disabled={action.disabled}>{action.label}</button>)}</div>
        {state.changes.length > 0 && <p>Last applied provider edits</p>}
        <ul aria-label="Provider changed resources">{state.changes.map(c => <li key={c.document}><button disabled={state.pending} onClick={() => tools.openChanged(c.document)}>Open provider changes in {c.title}</button></li>)}</ul></section>;
}
function NavigationTools() {
    const tools = bindings.navigation, state = useObserved(tools.state);
    return <section className="host-language" aria-label="Symbol navigation"><h2>Symbol navigation</h2>
        <output aria-label="Symbol navigation status">{state.message}</output>
        <progress aria-label="Symbol navigation progress" hidden={state.status !== "pending"} max={Math.max(1, state.total)} value={state.work} />
        <label><input type="checkbox" checked={state.includeDeclaration} onChange={event => tools.setIncludeDeclaration(event.currentTarget.checked)} />Include declarations in references</label>
        <div>{navigationActions(tools).map(action => <button key={action.label} onClick={action.invoke} disabled={action.disabled}>{action.label}</button>)}</div>
        <ul aria-label="Navigation results">{state.locations.map(note => <li key={`${state.token}:${note.ordinal}`}><button onClick={() => tools.open(state.token!, note.ordinal)}>
            {note.title}:{note.line}:{note.column}{note.declaration ? " · declaration" : ""}</button></li>)}</ul></section>;
}
function DomainTools() {
    const tools = bindings.domain, state = useObserved(tools.state);
    return <section className="host-language" aria-label="Domain tools"><h2>Domain tools</h2>
        <output aria-label="Domain command status">{state.message}</output>
        <progress aria-label="Domain discovery progress" hidden={state.status !== "running"} max={Math.max(1, state.total)} value={state.work} />
        <div>{domainActions(tools).map(action => <button key={action.label} onClick={action.invoke} disabled={action.disabled}>{action.label}</button>)}</div>
        <ul aria-label="Domain annotations">{state.annotations.map(note => <li key={`${state.token}:${state.revision}:${note.id}`}>
            <button onClick={() => tools.reveal(state.token!, state.revision!, note.id)}>{note.label}</button></li>)}</ul></section>;
}
let root: Root | undefined;
const unmount = () => { root?.unmount(); root = undefined; };
const mount = () => {
    root ??= createRoot(document.getElementById("host")!, { onUncaughtError: controller.reportError,
        onCaughtError: controller.reportError, onRecoverableError: controller.reportError });
    // The explicit host lifecycle returns after refs and Strict Mode's replay are ready for input.
    flushSync(() => root!.render(<StrictMode><App /></StrictMode>));
};
installHostHarness(controller, bindings, "react", mount, unmount, () => ({ ...counters }), draft);
