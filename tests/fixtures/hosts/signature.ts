import { fixtureRequests, type FixturePolicy } from "../language/fixture-requests.ts";
import { onSourceFocus } from "../../../examples/shared/source-focus.ts";
import { attachPanelSession } from "../../../examples/shared/editor-attachment.ts";
import { CleanupScope } from "../../../examples/shared/cleanup-scope.ts";
import type { DocumentId, TabId } from "../../../src/index.ts";
import { attachEditorLanguage } from "../../../src/browser/index.ts";
import type { HostHoverTools } from "./hover.ts";
import type { SignatureController, SignatureSnapshot, TextEditor } from "../../../src/browser/index.ts";
import type { LspPrepare, LspWorkspace } from "../../../src/protocol/index.ts";
import type { SignatureInput } from "../language/signature.ts";
import { HostCell } from "../../../examples/shared/observable.ts";

type SignatureFault = NonNullable<SignatureInput["fault"]>;
export type SignatureHostOptions = Readonly<{ provider: LspWorkspace; prepare?: (policy: FixturePolicy<SignatureFault>) => LspPrepare }>;
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
    private active: Session | undefined;
    private disconnected = false;
    private disposed = false;
    readonly fixture = fixtureRequests<SignatureFault>("signature");
    private readonly stopProvider: () => void;
    private readonly canCapture: (id: DocumentId) => boolean;
    private readonly hover: HostHoverTools;
    private readonly options: SignatureHostOptions;
    private readonly reconnectProvider: (() => void) | undefined;
    constructor(canCapture: (id: DocumentId) => boolean, hover: HostHoverTools, options: SignatureHostOptions, reconnectProvider?: () => void) {
        this.canCapture = canCapture; this.hover = hover; this.options = options; this.reconnectProvider = reconnectProvider;
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
    command(id: Command) {
        const session = this.active, state = session?.controller.getSnapshot(), entry = session?.editor.commands.get(id);
        return { label: entry?.label ?? labels[id], disabled: !entry?.enabled,
            invoke: () => { if (session && this.active === session && (id === "signature.request" || session.controller.getSnapshot() === state)) session.editor.commands.run(id); } };
    }
    readonly inspect = () => { this.active?.controller.request(); };
    readonly dismiss = () => { this.active?.controller.cancel(); };
    readonly disconnect = () => { this.disconnected = true; for (const s of this.sessions.keys()) s.controller.cancel(); this.publish("Signature provider disconnected."); };
    readonly reconnect = () => { this.disconnected = false; this.reconnectProvider?.(); this.publish(); };
    attach(id: string, _tab: TabId, editor: TextEditor): () => void {
        if (this.disposed) throw new Error("Signature panel is disposed.");
        const settings = { delay: 0 };
        const language = attachEditorLanguage(editor, this.options.provider, {
            hover: this.hover.controllerOptions(editor, settings),
            signature: {
                popup: { overloadControls: false },
                canCapture: () => !this.disconnected && this.canCapture(editor.view.documentId),
                beforeRequest: () => { this.active = session; this.hover.dismiss(); },
                ...(this.options.prepare ? { prepareRequest: access => this.options.prepare!(this.fixture.take())(access) } : {}),
            },
        });
        const controller = language.signature;
        const session: Session = { editor, controller };
        const inspection = new CleanupScope();
        inspection.defer(language.dispose);
        return attachPanelSession(this.sessions, session, signal => {
            inspection.defer(this.hover.bind(id, editor, language.hover, settings));
            controller.subscribe(() => { if (this.active === session) this.publish(); });
            onSourceFocus(editor, signal, () => { this.active = session; this.publish(); });
        }, () => {
            if (this.active === session) this.active = undefined;
            this.publish();
        }, inspection.dispose);
    }
    debug() {
        const state = this.cell.get();
        return { pending: state.pending,
            sessions: this.sessions.size, subscriptions: this.cell.count(), presentation: state, capture: state.anchor, disposed: this.disposed };
    }
    dispose() { if (!this.disposed) { this.disposed = true; this.stopProvider(); for (const detach of this.sessions.values()) detach(); } }
}
