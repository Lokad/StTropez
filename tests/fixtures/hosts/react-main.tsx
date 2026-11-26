import { activatePanelAction, bindPageButton, panelActionKey, type PanelAction } from "../../../examples/shared/panel-actions.ts";
import type { DestinationList, PanelTextField } from "./tool-panel.ts";
import { editPageSize, formatEditNote, type EditNotes } from "../../../examples/shared/edit-review.ts";
import { memo, Profiler, StrictMode, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import type { Root } from "react-dom/client";
import type { Observable } from "../../../src/index.ts";
import { HostController } from "./controller.ts";
import { ViewBindings } from "./bindings.ts";
import { actions } from "./actions.ts";
import { inputRecoveryModel, operationStatusModel, saveConflictPanelModel } from "./operation-panels.ts";
import { readHostScene } from "./scene-model.ts";
import { variantPanelModel } from "./variant-panel.ts";
import { installHostHarness } from "./harness.ts";
import { HostLifecycle } from "./lifecycle.ts";
import { languagePanelModel } from "./language-panel.ts";
import { domainPanelModel } from "./domain-panel.ts";
import { tablePastePanelModel } from "./table-panel.ts";
import { navigationPanelModel } from "./navigation-panel.ts";
import { mountLocationsDock } from "./locations-dock.ts";
import { projectPanelModel } from "./project-panel.ts";
import { documentColorsPanelModel } from "./document-colors-panel.ts";
import { documentLinksPanelModel } from "./document-links-panel.ts";
import { actionsPanelModel } from "./actions-panel.ts";
import { renamePanelModel } from "./rename-panel.ts";
import { signatureCommandsModel } from "./signature-panel.ts";
import { HostDraftRecovery } from "./draft-recovery.ts";
import { createBrowserDraftStore } from "../../../examples/shared/draft-store.ts";
import { draftPanelModel } from "./draft-panel.ts";
import { configurationFormModel, formSavePanelModel, formSaveKey } from "./configuration-panel.ts";
import { transferFormModel, runPanelModel } from "./transfer-panel.ts";
import "./style.css";

function Destinations({ results }: { results: DestinationList }) {
    return <ul ref={results.bind} tabIndex={results.bind ? -1 : undefined} aria-label={results.label}>
        {results.items().map(item => <li key={item.key}><button disabled={results.disabled || item.available === false}
            onClick={item.invoke}>{item.label}</button>{item.details !== undefined && <p>{item.details}</p>}</li>)}</ul>;
}

function LanguageField({ field }: { field: PanelTextField }) {
    return <label>{field.label}<input ref={field.bind} type="text" maxLength={field.maxLength}
        value={field.value} onChange={event => field.change(event.currentTarget.value)} /></label>;
}

export function startReactHost() {
const controller = new HostController(), bindings = new ViewBindings(controller);
const draft = new HostDraftRecovery(controller, createBrowserDraftStore(window)); draft.attachNavigation(window);
const counters = { form: 0, metadata: 0 };
const formCommitted = () => { counters.form++; };
const metadataCommitted = () => { counters.metadata++; };
// Stable refs lend empty subtrees to the shared presenters. Their returned cleanup also
// handles Strict Mode replay; documentation and fitting never synchronize through effects.
function useObserved<T>(store: Observable<T>): T { return useSyncExternalStore(store.subscribe, store.getSnapshot); }

function Commands() {
    return <nav aria-label="Host commands">{actions(controller, bindings).map(action => <button key={action.label} onClick={action.invoke}>{action.label}</button>)}</nav>;
}
function Status() {
    const model = operationStatusModel(useObserved(controller.activity), useObserved(controller.source.metadata));
    return <output aria-label={model.label}>{model.text}</output>;
}
const locationDockRef = (host: HTMLDivElement | null) => host ? mountLocationsDock(host, bindings) : undefined;
function SourceMetadata() {
    const metadata = useObserved(controller.source.metadata);
    return <p>{metadata.title} · {metadata.dirty ? "Unsaved" : "Saved"}</p>;
}
function SaveConflict() {
    const model = saveConflictPanelModel(controller, useObserved(controller.saveConflictPresentation));
    return model.hidden ? null : <section aria-label={model.label}><output>{model.status}</output>
        {model.actions.map(action => <button key={action.label} onClick={action.invoke} disabled={action.disabled}>{action.label}</button>)}</section>;
}
function InputRecovery() {
    const model = inputRecoveryModel(useObserved(controller.recovery));
    return <section hidden={model.hidden} aria-label={model.label}><output>{model.status}</output>
        <pre hidden={model.preview.hidden}>{model.preview.text}</pre></section>;
}
function DraftRecovery() {
    const model = draftPanelModel(draft, useObserved(draft.state));
    return <section className="host-language" aria-label={model.title}><h2>{model.title}</h2>
        <output aria-label={model.status.label}>{model.status.text}</output>
        <progress aria-label={model.progress.label} hidden={model.progress.hidden} />
        <p>{model.protection}</p>
        <div>{model.actions.map(action => <button key={action.label} disabled={action.disabled} onClick={action.invoke}>{action.label}</button>)}</div>
        <pre hidden={model.preview.hidden}>{model.preview.text}</pre></section>;
}
function ConfigurationSavePanel() {
    const save = controller.configurationSave, model = formSavePanelModel(save, useObserved(save.presentation));
    return <section className="host-language" aria-label={model.title} onKeyDown={event => formSaveKey(event, save)}><h2>{model.title}</h2>
        <output aria-label={model.status.label}>{model.status.text}</output>
        <div>{model.actions.map(action => <button key={action.label} disabled={action.disabled} onClick={action.invoke}>{action.label}</button>)}</div>
        <pre hidden={model.preview.hidden}>{model.preview.text}</pre></section>;
}
function TransferWorkspace() {
    const transfer = controller.transfer, model = transferFormModel(transfer, useObserved(transfer.save.presentation));
    return <section className="host-language" aria-label={model.title}><h2>{model.title}</h2>
        <div onKeyDown={e => formSaveKey(e, transfer.save)}>{model.available ? <div>{model.fields.map(field =>
            <label key={field.key}>{field.label}<input value={field.value} readOnly={field.readOnly} inputMode={field.inputMode} aria-invalid={field.invalid}
                onChange={e => field.change(e.currentTarget.value)} /></label>)}</div> : <p>{model.status}</p>}
            <output aria-label={model.save.status.label}>{model.save.status.text}</output>
            <div>{model.save.actions.map(a => <button key={a.label} disabled={a.disabled} onClick={a.invoke}>{a.label}</button>)}</div>
            <pre hidden={model.save.preview.hidden}>{model.save.preview.text}</pre></div><RunPanel /></section>;
}
function RunPanel() {
    const model = runPanelModel(controller.runResources, useObserved(controller.runResources.state)), inspection = model.inspection;
    return <><h3>{model.title}</h3><ul>{model.rows.items().map(run => <li key={run.key}><span>{run.status}</span>
        <button onClick={run.inspect.invoke}>{run.inspect.label}</button>
        <button disabled={run.progress.disabled} onClick={run.progress.invoke}>{run.progress.label}</button>
        {run.logs().map(log => <button key={log.key} onClick={log.invoke}>{log.label}</button>)}</li>)}</ul>
        <section aria-label={inspection.label} hidden={inspection.hidden}><h3>{inspection.title}</h3><p>{inspection.text}</p>
            <pre hidden={inspection.preview.hidden}>{inspection.preview.text}</pre>
            <div>{inspection.links().map(link => <button key={link.key} onClick={link.invoke}>{link.label}</button>)}</div>
            <button onClick={inspection.refresh.invoke}>{inspection.refresh.label}</button></section></>;
}
function Form() {
    const state = useObserved(controller.connection), layout = useObserved(controller.layout);
    if (layout.formFault) throw new Error("Synthetic host form render failure");
    const model = configurationFormModel(controller, state);
    return model.available ? <div onKeyDown={event => formSaveKey(event, controller.configurationSave)}><label>{model.field.label}<input value={model.field.value}
        readOnly={model.field.readOnly} aria-invalid={model.field.invalid}
        onChange={event => model.field.change(event.currentTarget.value)} /></label><p>{model.validation}</p></div> : <p>{model.status}</p>;
}
function useScene() {
    return readHostScene(controller, useObserved(controller.layout));
}
function Scene() {
    const model = useScene();
    const primary = model.primaryKey !== undefined ? <div key={model.primaryKey} className="editor-host" ref={bindings.primary} />
        : model.placeholder !== undefined ? <p>{model.placeholder}</p> : null;
    return <><main><section aria-label="Left host pane">{model.position === "left" ? primary : null}</section>
        <section aria-label="Right host pane"><Profiler id="form" onRender={formCommitted}><Form /></Profiler>
            {model.position === "right" ? primary : null}
            {model.secondary ? <div key="secondary" className="editor-host" ref={bindings.secondary} /> : null}</section></main>
        <div role="status" aria-label="Host messages">{model.message}</div></>;
}
function SourceReview() {
    const model = useScene();
    return model.reviewKey !== undefined
        ? <section className="host-review" aria-label="Source review surface"><ReviewVersions /><div key={model.reviewKey} ref={bindings.comparison} /></section> : null;
}
function ReviewVersions() {
    const model = variantPanelModel(controller.variants, bindings, useObserved(controller.variants.state), useObserved(controller.comparisonReference));
    return <div><label>{model.label} <select aria-label={model.label} value={model.value} onChange={event => model.choose(event.currentTarget.value)}>
        <option value="">{model.empty}</option><option value={model.captured.key} disabled hidden={model.captured.hidden}>{model.captured.label}</option>
        {model.choices.map(choice => <option key={choice.key} value={choice.key}>{choice.label}</option>)}
    </select></label><output aria-label={model.status.label}>{model.status.text}</output>
        {model.actions.map(action => <button key={action.label} onClick={() => action.invoke()} disabled={action.disabled}>{action.label}</button>)}</div>;
}
function LanguageTools() {
    const tools = bindings.language, model = languagePanelModel(tools, useObserved(tools.state));
    return <section ref={model.bind} onKeyDown={event => model.key(event.nativeEvent)} className="host-language" aria-label={model.label}><h2>{model.title}</h2>
        <p>{model.help}</p><output aria-label={model.status.label}>{model.status.text}</output>
        <output aria-label={model.diagnosticStatus.label}>{model.diagnosticStatus.text}</output>
        <ul aria-label={model.diagnostics.label} onPointerDown={event => event.preventDefault()}>{model.diagnostics.items().map(row => <li key={row.key}><button onClick={row.invoke}>{row.label}</button></li>)}</ul>
        <ul aria-label={model.uncertain.label}>{model.uncertain.items().map((message, index) => <li key={index}>{message}</li>)}</ul>
        <label>{model.query.label}<input ref={model.query.bind} value={model.query.value} onChange={event => model.query.change(event.currentTarget.value)} /></label>
        <label>{model.replacement.label}<input ref={model.replacement.bind} disabled={model.replacement.disabled} value={model.replacement.value} onChange={event => model.replacement.change(event.currentTarget.value)} /></label>
        {model.options.map(option => <label key={option.label}><input type="checkbox" checked={option.checked} onChange={event => option.change(event.currentTarget.checked)} />{option.label}</label>)}
        <output aria-label={model.find.label}>{model.find.text}</output><output aria-label={model.folds.label}>{model.folds.text}</output>
        <div>{model.actions.map(action => <button key={action.label} onClick={action.invoke} disabled={action.disabled}>{action.label}</button>)}</div>
    </section>;
}
function SignatureTools() {
    const tools = bindings.signature, model = signatureCommandsModel(tools, useObserved(tools.state));
    return <section className="host-language" aria-label={model.label}><h2>{model.title}</h2><output aria-label={model.status.label}>{model.status.text}</output>
        <div>{model.actions.map(action => <button key={action.label} onPointerDown={event => event.preventDefault()} onClick={action.invoke} disabled={action.disabled}>{action.label}</button>)}</div></section>;
}
function TablePasteTools() {
    const tools = bindings.tablePaste, model = tablePastePanelModel(tools, useObserved(tools.state));
    return <section className="host-language" aria-label={model.label}><label><input type="checkbox" checked={model.enabled.checked}
        onChange={event => model.enabled.change(event.currentTarget.checked)} />{model.enabled.label}</label>
        <output aria-label={model.status.label}>{model.status.text}</output>
        <progress aria-label={model.progress.label} hidden={model.progress.hidden} />
        <button disabled={model.cancel.disabled} onClick={model.cancel.invoke}>{model.cancel.label}</button></section>;
}
function App() {
    return <><Commands /><Status /><Profiler id="metadata" onRender={metadataCommitted}><SourceMetadata /></Profiler><InputRecovery /><SaveConflict /><Scene /><SourceReview />
        <div ref={locationDockRef} className="host-locations" role="region" aria-label="Locations" /><NavigationTools /><DocumentLinksTools />
        <ConfigurationSavePanel /><TransferWorkspace /><DraftRecovery /><LanguageTools /><TablePasteTools /><DomainTools /><ProjectTools /><RenameTools /><ActionsTools /><DocumentColorsTools /><SignatureTools /></>;
}
const EditNoteList = memo(function EditNoteList({ label, page, notes }: EditNotes) {
    return <ol aria-label={label} start={page * editPageSize + 1}>{notes?.map((note, i) => <li key={i}><pre>{formatEditNote(note)}</pre></li>)}</ol>;
});
function PanelControls({ actions }: { actions: readonly PanelAction[] }) {
    return <div>{actions.map(action => <button key={panelActionKey(action)} ref={action.pageStart === undefined ? undefined : bindPageButton}
        data-page={action.pageStart} data-page-group={action.pageGroup} disabled={action.disabled}
        onClick={action.pageGroup ? event => activatePanelAction(event.currentTarget, action) : action.invoke ?? undefined}>{action.label}</button>)}</div>;
}
function DocumentColorsTools() {
    const tools = bindings.colors, model = documentColorsPanelModel(tools, useObserved(tools.state));
    return <section className="host-language" aria-label={model.title}><h2>{model.title}</h2><p>{model.description}</p>
        <output aria-label={model.status.label}>{model.status.text}</output><PanelControls actions={model.actions} />
        <ul ref={model.results.bind} tabIndex={-1} aria-label={model.results.label}>{model.results.items().map(color => <li key={color.key}><span className="host-color-swatch" aria-hidden="true" style={{backgroundColor: color.css}} /><button disabled={model.results.disabled} aria-pressed={model.results.isSelected(color.key)} onClick={color.invoke}>{color.label}</button></li>)}</ul>
        <LanguageField field={model.value} /><span className="host-color-swatch" aria-hidden="true" style={{backgroundColor: model.value.css}} />
        <button disabled={model.preview.disabled} onClick={model.preview.invoke}>{model.preview.label}</button><label>{model.presentation.label}<select disabled={model.presentation.disabled} value={model.presentation.value} onChange={event => model.presentation.change(event.currentTarget.selectedIndex)}>{model.presentation.choices.map((choice, i) => <option key={i} value={`provider-${i}`}>{choice.label}</option>)}</select></label>
        <button key={panelActionKey(model.apply)} disabled={model.apply.disabled} onClick={model.apply.invoke}>{model.apply.label}</button><ol aria-label={model.edits.label}>{model.edits.items.map((text,i) => <li key={i}><pre>{text}</pre></li>)}</ol>
        {model.changed.visible && <button key={panelActionKey(model.changed)} disabled={model.changed.disabled} onClick={model.changed.invoke}>{model.changed.label}</button>}</section>;
}
function DocumentLinksTools() {
    const tools = bindings.links, model = documentLinksPanelModel(tools, useObserved(tools.state));
    return <section className="host-language" aria-label={model.title}><h2>{model.title}</h2><p>{model.description}</p>
        <PanelControls actions={model.actions} /></section>;
}
function ActionsTools() {
    const tools = bindings.actions, model = actionsPanelModel(tools, useObserved(tools.state));
    return <section className="host-language" aria-label={model.title}><h2>{model.title}</h2><p>{model.description}</p>
        <output aria-label={model.status.label}>{model.status.text}</output>
        <LanguageField field={model.module} />
        <PanelControls actions={model.actions} />
        <ol aria-label={model.choices.label} start={model.choices.start}>{model.choices.items().map(choice => <li key={choice.key}><button disabled={model.choices.disabled} aria-pressed={model.choices.isSelected(choice.key)} onClick={choice.invoke}>{choice.label}</button></li>)}</ol>
        <p aria-label={model.preview.label}>{model.preview.text}</p><EditNoteList {...model.edits} />
        <Destinations results={model.changes} /></section>;
}
function RenameTools() {
    const tools = bindings.rename, model = renamePanelModel(tools, useObserved(tools.state));
    return <section className="host-language" aria-label={model.title}><h2>{model.title}</h2><p>{model.description}</p>
        <output aria-label={model.status.label}>{model.status.text}</output>
        <LanguageField field={model.name} />
        <PanelControls actions={model.actions} />
        <ol aria-label={model.targets.label} start={model.targets.start}>{model.targets.items().map(at => <li key={at.key}>{at.text}</li>)}</ol>
        <Destinations results={model.changes} /></section>;
}
function ProjectTools() {
    const tools = bindings.project, model = projectPanelModel(tools, useObserved(tools.state));
    return <section className="host-language" aria-label={model.title}><h2>{model.title}</h2>
        <output aria-label={model.status.label}>{model.status.text}</output>
        <PanelControls actions={model.actions} />
        {model.review.visible && <><p aria-label={model.review.titleLabel}>{model.review.title}</p><EditNoteList {...model.edits} /></>}
        {model.changesDescription && <p>{model.changesDescription}</p>}
        <Destinations results={model.changes} /></section>;
}
function NavigationTools() {
    const tools = bindings.navigation, model = navigationPanelModel(tools, useObserved(tools.state));
    return <section className="host-language" aria-label={model.title}><h2>{model.title}</h2>
        <progress aria-label={model.progress.label} hidden={model.progress.hidden} />
        <label><input type="checkbox" checked={model.declarations.checked} onChange={event => model.declarations.change(event.currentTarget.checked)} />{model.declarations.label}</label>
        <PanelControls actions={model.actions} /></section>;
}
function DomainTools() {
    const tools = bindings.domain, model = domainPanelModel(tools, useObserved(tools.state));
    return <section className="host-language" aria-label={model.title}><h2>{model.title}</h2>
        <output aria-label={model.status.label}>{model.status.text}</output>
        <progress aria-label={model.progress.label} hidden={model.progress.hidden} max={model.progress.max} value={model.progress.value} />
        <div>{model.actions.map(action => <button key={action.label} onClick={action.invoke} disabled={action.disabled}>{action.label}</button>)}</div>
        <ul aria-label={model.annotations.label}>{model.annotations.items().map(note => <li key={note.key}>
            <button onClick={note.invoke}>{note.label}</button></li>)}</ul></section>;
}
let root: Root | undefined;
const unmount = () => { const current = root; root = undefined; current?.unmount(); };
const mount = () => {
    root ??= createRoot(document.getElementById("host")!, { onUncaughtError: controller.reportError,
        onCaughtError: controller.reportError, onRecoverableError: controller.reportError });
    // The explicit host lifecycle returns after refs and Strict Mode's replay are ready for input.
    flushSync(() => root!.render(<StrictMode><App /></StrictMode>));
};
const lifecycle = new HostLifecycle(window, document.getElementById("recover")!, { controller, bindings, draft, mount, unmount });
lifecycle.start();
installHostHarness(controller, bindings, "react", lifecycle, () => ({ ...counters }), draft);

}
