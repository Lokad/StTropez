import type { Connection, HostController } from "./controller.ts";
import type { HostDraftRecovery } from "./draft-recovery.ts";
import type { ViewBindings } from "./bindings.ts";
import type { HostLifecycle } from "./lifecycle.ts";
import type { DocumentId, HistorySnapshot, ResourceId, Selection, TabTarget, TextEdit, TextResourceHandle } from "../../src/index.ts";
import type { JsonValue } from "../../src/protocol/index.ts";

type TransferTargetSnapshot = Readonly<{ documentId: DocumentId; revision: number; text: string; exports: number; history: HistorySnapshot }>;

export function installHostHarness(controller: HostController, bindings: ViewBindings, mode: "plain" | "react",
    lifecycle: HostLifecycle, commits: () => Readonly<{ form: number; metadata: number }>, draft?: HostDraftRecovery): void {
    let transferTarget: TextResourceHandle | undefined;
    const inactive: { resource: TextResourceHandle; tab: TabTarget }[] = [];
    const seedInactiveDocuments = () => {
        if (lifecycle.disposed || inactive.length) throw new Error("Inactive workload can be created once on a live host.");
        for (let index = 0; index < 100; index++) {
            const resource = controller.workspace.createTextResource({ scope: "host-workload", resource: `inactive-${index}`, variant: "working" },
                `Inactive ${index}`, { value: `// inactive ${index}\r\n` + "row Δ😀\r\n".repeat(1000) });
            let target: TabTarget | undefined;
            lifecycle.onDispose(async () => {
                const index = inactive.findIndex(owner => owner.resource === resource); if (index >= 0) inactive.splice(index, 1);
                if (target && controller.workspace.tabs.resolve(target)) controller.workspace.tabs.close(target.id);
                // Provider bindings defer lease release out of workspace notification delivery.
                await Promise.resolve();
                controller.workspace.releaseResource(resource.id);
            });
            const id = controller.workspace.tabs.open({ kind: "text", documentId: resource.documentId }, "inactive");
            target = controller.workspace.tabs.capture(id); inactive.push({ resource, tab: target });
        }
    };
    const inactiveDocuments = () => Object.freeze(inactive.map(({ resource, tab }) => Object.freeze({ id: resource.id,
        revision: resource.getSnapshot().revision, dirty: resource.metadata.getSnapshot().dirty, current: !!controller.workspace.tabs.resolve(tab),
        exports: controller.workspace.document(resource.documentId).buffer.readMetrics().textExports })));
    const transferSnapshot = (): TransferTargetSnapshot => {
        if (!transferTarget) throw new Error("No transfer target is mounted.");
        const current = controller.workspace.document(transferTarget.documentId);
        return { documentId: transferTarget.documentId, revision: current.revision, text: current.buffer.slice(0, current.buffer.length),
            exports: current.buffer.readMetrics().textExports, history: controller.workspace.observeHistory(transferTarget.documentId).getSnapshot() };
    };
    const fixture = Object.freeze({ ready: true, get settled() { return !lifecycle.disposed && bindings.settled(); }, mode, snapshot: () => { const state = controller.debug(), views = bindings.debug();
        return { ...state, hostSubscriptions: state.hostSubscriptions + views.language.subscriptions + views.hover.subscriptions + views.tablePaste.subscriptions + views.domain.subscriptions + views.navigation.subscriptions + views.project.subscriptions + views.signature.subscriptions + views.rename.subscriptions + views.actions.subscriptions + views.links.subscriptions + views.colors.subscriptions + (draft?.debug().subscriptions ?? 0), draft: draft?.debug() ?? null, bindings: views, commits: commits() }; },
        editSource: (expectedRevision: number, edits: readonly TextEdit[]) => controller.workspace.edit({ documentId: controller.source.documentId,
            expectedRevision, edits, origin: "host", history: { kind: "live" } }),
        previewProposal: controller.previewProposalText, applyProposal: controller.applyProposal, runCapture: (index: number) => controller.runCapture(index), setPath: controller.setPath, recoveryText: () => controller.recoveryText(),
        finishRun: controller.finishRun, failRun: controller.failRun, finishSave: controller.finishSave, failSave: controller.failSave,
        externalWrite: (text: string) => controller.externalWrite(text), finishConflictReview: controller.finishConflictReview, saveReviewedSource: controller.saveReviewedSource,
        configurationCapture: () => controller.configurationSave.capture(), configurationValue: () => { const s = controller.connection.getSnapshot(); return s.state === "ready" ? s.value() : null; },
        transferCapture: () => controller.transfer.save.capture(), transferValue: () => { const s = controller.transfer.resource.getSnapshot(); return s.state === "ready" ? s.value() : null; },
        setTransfer: controller.transfer.update, runInput: (id: ResourceId) => controller.runResources.capture(id),
        range: (from: number, to: number) => controller.workspace.document(controller.source.documentId).buffer.slice(from, to),
        referenceRange: (from: number, to: number) => bindings.referenceRange(from, to),
        onSourceRender: (id: "primary" | "secondary" | "comparison", listener: () => void) => bindings.onSourceRender(id, listener),
        selectSource: (id: "primary" | "secondary", revision: number, selection: Selection) => bindings.selectSource(id, revision, selection),
        selectSourceSet: (id: "primary" | "secondary" | "comparison", revision: number, ranges: readonly Selection[], primary = 0) => bindings.selectSourceSet(id, revision, ranges, primary),
        configureSource: (id: "primary" | "secondary" | "comparison", configuration: import("../../src/index.ts").LanguageConfiguration) => bindings.configureSource(id, configuration),
        setSourceReadOnly: (value: boolean) => controller.workspace.setCapabilities(controller.source.id, { edit: value ? ["host"] : ["human", "host", "agent"], save: true, run: true }),
        cycleSourceEditLease: () => { const lease = controller.workspace.acquireEditLease(controller.source.id, "host-fixture", "host"); lease.release(); },
        openTransferTarget: (text: string) => {
            if (lifecycle.disposed || transferTarget) throw new Error("Transfer target cannot be mounted.");
            lifecycle.unmount();
            const resource = controller.workspace.createTextResource({ scope: "host-fixture", resource: "transfer-text", variant: "working" }, "Transfer target", { value: text });
            transferTarget = resource; let target: TabTarget | undefined;
            lifecycle.onDispose(async () => {
                if (target && controller.workspace.tabs.resolve(target)) controller.workspace.tabs.close(target.id);
                await Promise.resolve();
                controller.workspace.releaseResource(resource.id, true); transferTarget = undefined;
            });
            controller.workspace.tabs.replace(controller.viewTab("secondary"), { kind: "text", documentId: resource.documentId });
            target = controller.workspace.tabs.capture(controller.viewTab("secondary")); lifecycle.mount();
        },
        transferSnapshot,
        editTransferTarget: (expectedRevision: number, edits: readonly TextEdit[]) => controller.workspace.edit({ documentId: transferSnapshot().documentId, expectedRevision, edits, origin: "host" }),
        setTransferReadOnly: (value: boolean) => { if (!transferTarget) throw new Error("No transfer target is mounted.");
            controller.workspace.setCapabilities(transferTarget.id, { edit: value ? ["host"] : ["human", "host"], save: true, run: false }); },
        setProviderDelay: (delay: number) => bindings.language.setDelay(delay), faultProviderNext: (fault: "malformed" | "failure") => bindings.language.faultNext(fault),
        providerCustom: (method: string, params: JsonValue) => bindings.language.customRequest(method, params),
        providerState: () => bindings.language.state.getSnapshot().provider,
        requestProvider: bindings.language.request,
        setDomainDelay: (delay: number) => { if (!Number.isFinite(delay) || delay < 0 || delay > 10000) throw new RangeError("Invalid domain delay."); bindings.domain.fixture.delay = delay; },
        faultDomainNext: (fault: "malformed" | "failure" | "late") => { bindings.domain.fixture.fault = fault; },
        setNavigationDelay: (delay: number) => bindings.navigation.setDelay(delay), faultNavigationNext: (fault: "malformed" | "failure") => bindings.navigation.faultNext(fault),
        releaseNavigationCompanion: () => bindings.navigation.releaseCompanion(),
        setProjectDelay: (value: number) => bindings.project.setDelay(value), faultProjectNext: (value: "malformed" | "failure" | "ack") => bindings.project.faultNext(value),
        confirmProjectReview: (token: number | null) => bindings.project.confirmReview(token), declineProjectReview: (token: number | null) => bindings.project.declineReview(token),
        setSignatureDelay: (value: number) => bindings.signature.setDelay(value), faultSignatureNext: (value: "malformed" | "failure" | "markup") => bindings.signature.faultNext(value), requestSignature: bindings.signature.inspect,
        setColorsDelay: (value: number) => bindings.colors.setDelay(value), faultColorsNext: (value: "malformed" | "failure" | "incomplete" | "markup") => bindings.colors.faultNext(value), requestColors: bindings.colors.discover, previewColor: bindings.colors.preview,
        setLinksDelay: (value: number) => bindings.links.setDelay(value), faultLinksNext: (value: "malformed" | "failure" | "incomplete" | "markup") => bindings.links.faultNext(value), requestLinks: bindings.links.discover, setLinkAlias: (module: string, document: DocumentId | null) => bindings.links.setAlias(module, document),
        editLinkTarget: (id: DocumentId, revision: number, edits: readonly TextEdit[]) => controller.workspace.edit({ documentId: id, expectedRevision: revision, origin: "host", edits }),
        setActionDelay: (value: number) => bindings.actions.setDelay(value), faultActionNext: (value: "malformed" | "failure" | "incomplete" | "markup") => bindings.actions.faultNext(value), faultIdleAction: () => bindings.actions.faultIdle(), requestAction: bindings.actions.request,
        setRenameDelay: (value: number) => bindings.rename.setDelay(value), faultRenameNext: (value: "malformed" | "failure") => bindings.rename.faultNext(value), faultIdleRename: () => bindings.rename.faultIdle(),
        faultIdleProject: () => bindings.project.faultIdle(),
        setProjectTargetReadOnly: (id: DocumentId, value: boolean) => { const resource = controller.workspace.resourceForDocument(id), metadata = resource.metadata.getSnapshot();
            controller.workspace.setCapabilities(resource.id, { ...metadata.capabilities, edit: value ? ["host"] : ["human", "host", "agent"] }); },
        navigationDocument: (id: DocumentId) => { const doc = controller.workspace.document(id); return { revision: doc.revision, length: doc.buffer.length, text: doc.buffer.slice(0, Math.min(4096, doc.buffer.length)), exports: doc.buffer.readMetrics().textExports }; },
        inspectSymbol: (id: "primary" | "secondary" | "comparison") => bindings.hover.inspectCaret(id),
        setHoverDelay: (id: string, value: number) => bindings.hover.setDelay(id, value),
        faultHoverNext: (id: string, value: "malformed" | "failure" | "markup") => bindings.hover.faultNext(id, value),
        seedInactiveDocuments, inactiveDocuments, unmount: lifecycle.unmount, mount: lifecycle.mount, dispose: lifecycle.dispose });
    window.hostFixture = fixture;
}
declare global { interface Window { hostFixture: Readonly<{ ready: boolean; settled: boolean; mode: string; snapshot: () => ReturnType<HostController["debug"]> &
    { bindings: ReturnType<ViewBindings["debug"]>; commits: Readonly<{ form: number; metadata: number }>; draft: ReturnType<HostDraftRecovery["debug"]> | null };
    editSource: (expectedRevision: number, edits: readonly TextEdit[]) => ReturnType<HostController["workspace"]["edit"]>;
    seedInactiveDocuments: () => void;
    inactiveDocuments: () => readonly Readonly<{ id: ResourceId; revision: number; dirty: boolean; current: boolean; exports: number }>[];
    previewProposal: (text: string) => void; applyProposal: () => void; runCapture: (index: number) => ReturnType<HostController["runCapture"]>; setPath: (path: string) => void;
    recoveryText: () => string | null;
    finishRun: () => void; failRun: () => void; finishSave: () => void; failSave: () => void; range: (from: number, to: number) => string;
    externalWrite: (text: string) => void; finishConflictReview: () => boolean; saveReviewedSource: () => void;
    configurationCapture: () => ReturnType<HostController["configurationSave"]["capture"]>; configurationValue: () => Connection | null;
    transferCapture: () => ReturnType<HostController["transfer"]["save"]["capture"]>; transferValue: () => import("./transfers.ts").TransferSettings | null;
    setTransfer: HostController["transfer"]["update"]; runInput: (id: ResourceId) => ReturnType<HostController["runResources"]["capture"]>;
    referenceRange: (from: number, to: number) => string | undefined;
    onSourceRender: (id: "primary" | "secondary" | "comparison", listener: () => void) => () => void;
    selectSource: (id: "primary" | "secondary", revision: number, selection: Selection) => boolean;
    selectSourceSet: (id: "primary" | "secondary" | "comparison", revision: number, ranges: readonly Selection[], primary?: number) => boolean;
    configureSource: (id: "primary" | "secondary" | "comparison", configuration: import("../../src/index.ts").LanguageConfiguration) => boolean;
    setSourceReadOnly: (value: boolean) => void;
    cycleSourceEditLease: () => void;
    openTransferTarget: (text: string) => void; transferSnapshot: () => TransferTargetSnapshot;
    editTransferTarget: (expectedRevision: number, edits: readonly TextEdit[]) => ReturnType<HostController["workspace"]["edit"]>;
    setTransferReadOnly: (value: boolean) => void;
    setProviderDelay: (delay: number) => void; faultProviderNext: (fault: "malformed" | "failure") => void;
    providerCustom: (method: string, params: JsonValue) => Promise<JsonValue>;
    providerState: () => ReturnType<ViewBindings["language"]["state"]["getSnapshot"]>["provider"];
    requestProvider: () => void;
    setDomainDelay: (delay: number) => void; faultDomainNext: (fault: "malformed" | "failure" | "late") => void;
    setNavigationDelay: (delay: number) => void; faultNavigationNext: (fault: "malformed" | "failure") => void;
    releaseNavigationCompanion: () => boolean;
    setProjectDelay: (value: number) => void; faultProjectNext: (value: "malformed" | "failure" | "ack") => void;
    confirmProjectReview: (token: number | null) => void; declineProjectReview: (token: number | null) => void;
    setSignatureDelay: (value: number) => void; faultSignatureNext: (value: "malformed" | "failure" | "markup") => void; requestSignature: () => void;
    setColorsDelay: (value: number) => void; faultColorsNext: (value: "malformed" | "failure" | "incomplete" | "markup") => void; requestColors: () => void; previewColor: () => void;
    setLinksDelay: (value: number) => void; faultLinksNext: (value: "malformed" | "failure" | "incomplete" | "markup") => void; requestLinks: () => void; setLinkAlias: (module: string, document: DocumentId | null) => void; editLinkTarget: (id: DocumentId, revision: number, edits: readonly TextEdit[]) => unknown;
    setActionDelay: (value: number) => void; faultActionNext: (value: "malformed" | "failure" | "incomplete" | "markup") => void; faultIdleAction: () => boolean; requestAction: () => void;
    setRenameDelay: (value: number) => void; faultRenameNext: (value: "malformed" | "failure") => void; faultIdleRename: () => boolean;
    faultIdleProject: () => boolean;
    setProjectTargetReadOnly: (id: DocumentId, value: boolean) => void;
    navigationDocument: (id: DocumentId) => Readonly<{ revision: number; length: number; text: string; exports: number }>;
    inspectSymbol: (id: "primary" | "secondary" | "comparison") => boolean;
    setHoverDelay: (id: string, value: number) => void;
    faultHoverNext: (id: string, value: "malformed" | "failure" | "markup") => void;
    unmount: () => void; mount: () => void; dispose: () => Promise<void> }> } }
