import { onSourceFocus } from "./source-focus.ts";
import { attachPanelSession } from "../shared/editor-attachment.ts";
import type { DocumentId, TabId } from "../../src/index.ts";
import { createSignatureController } from "../../src/browser/index.ts";
import type { SignatureController, SignatureSnapshot, TextEditor } from "../../src/browser/index.ts";
import type { LspPrepare, LspWorkspace } from "../../src/protocol/index.ts";
import type { SignatureInput } from "../../fixtures/language/signature.ts";
import { HostCell } from "../shared/observable.ts";

export type SignatureHostOptions = Readonly<{ provider: LspWorkspace; prepare?: (delay: number, fault?: SignatureInput["fault"]) => LspPrepare }>;
type Session = { editor: TextEditor; controller: SignatureController };
const labels = { "signature.request": "Show signature help", "signature.previous": "Previous signature",
    "signature.next": "Next signature", "signature.dismiss": "Dismiss signature help" } as const;
type Command = keyof typeof labels;
export type HostSignatureSnapshot = SignatureSnapshot & Readonly<{ visible: boolean; pending: boolean; connected: boolean; disconnected: boolean }>;
const idle: HostSignatureSnapshot = { status: "idle", visible: false, pending: false, connected: false, disconnected: false,
    message: "Use Ctrl/Cmd+Shift+Space for signature help.", anchor: null, signature: null, activeSignature: 0, signatureCount: 0 };

/** The panel follows the active editor. Each editor owns its requests and shortcuts. */
export class HostSignatureTools {
    private readonly cell = new HostCell(idle);
    readonly state = this.cell.observable;
    private readonly sessions = new Map<Session, () => void>();
    private readonly retired = { requested: 0, applied: 0 };
    private active: Session | undefined;
    private disconnected = false;
    private disposed = false;
    private delay = 0;
    private fault: SignatureInput["fault"];
    private readonly stopProvider: () => void;
    private readonly canCapture: (id: DocumentId) => boolean;
    private readonly beforeRequest: () => void;
    private readonly options: SignatureHostOptions;
    private readonly reconnectProvider: (() => void) | undefined;
    constructor(canCapture: (id: DocumentId) => boolean, beforeRequest: () => void, options: SignatureHostOptions, reconnectProvider?: () => void) {
        this.canCapture = canCapture; this.beforeRequest = beforeRequest; this.options = options; this.reconnectProvider = reconnectProvider;
        this.stopProvider = options.provider.subscribe(() => {
            if (this.cell.get().connected !== this.connected()) queueMicrotask(() => { if (!this.disposed) this.publish(); });
        });
    }
    private connected() { return !this.disconnected && this.options.provider.getSnapshot().phase === "ready"; }
    private publish(message?: string) {
        const state = this.active?.controller.getSnapshot() ?? idle;
        this.cell.set({ ...state, message: message ?? state.message, visible: !!state.anchor, pending: state.status === "pending",
            connected: this.connected(), disconnected: this.disconnected });
    }
    readonly activeEditor = () => this.active?.editor;
    command(id: Command) {
        const session = this.active, state = session?.controller.getSnapshot(), entry = session?.editor.commands.get(id);
        return { label: entry?.label ?? labels[id], disabled: !entry?.enabled,
            invoke: () => { if (session && this.active === session && (id === "signature.request" || session.controller.getSnapshot() === state)) session.editor.commands.run(id); } };
    }
    readonly inspect = () => { this.active?.controller.request(); };
    readonly dismiss = () => { this.active?.controller.cancel(); };
    readonly disconnect = () => { this.disconnected = true; for (const s of this.sessions.keys()) s.controller.cancel(); this.publish("Signature provider disconnected."); };
    readonly reconnect = () => { this.disconnected = false; this.reconnectProvider?.(); this.publish(); };
    attach(_id: string, _tab: TabId, editor: TextEditor): () => void {
        if (this.disposed) throw new Error("Signature panel is disposed.");
        const controller = createSignatureController(editor, this.options.provider, {
            canCapture: () => !this.disconnected && this.canCapture(editor.view.documentId),
            beforeRequest: () => { this.active = session; this.beforeRequest(); },
            ...(this.options.prepare ? { prepareRequest: access => {
                const fault = this.fault; this.fault = undefined;
                return this.options.prepare!(this.delay, fault)(access);
            } } : {}),
        });
        const session: Session = { editor, controller };
        return attachPanelSession(this.sessions, session, signal => {
            controller.subscribe(() => { if (this.active === session) this.publish(); });
            onSourceFocus(editor, signal, () => { this.active = session; this.publish(); });
        }, () => {
            const counts = controller.getDiagnostics();
            this.retired.requested += counts.requested; this.retired.applied += counts.applied;
            if (this.active === session) this.active = undefined;
            this.publish();
        });
    }
    setDelay(value: number): void { if (!Number.isFinite(value) || value < 0 || value > 1000) throw new RangeError("Invalid signature delay."); this.delay = value; }
    faultNext(value: NonNullable<SignatureInput["fault"]>): void { this.fault = value; }
    debug() {
        const counts = { ...this.retired }, state = this.cell.get();
        for (const s of this.sessions.keys()) { const d = s.controller.getDiagnostics(); counts.requested += d.requested; counts.applied += d.applied; }
        return { ...counts, pending: state.pending, scheduled: this.active?.controller.getDiagnostics().scheduled ?? false,
            sessions: this.sessions.size, subscriptions: this.cell.count(), presentation: state, capture: state.anchor, disposed: this.disposed };
    }
    dispose() { if (!this.disposed) { this.disposed = true; this.stopProvider(); for (const detach of this.sessions.values()) detach(); } }
}
