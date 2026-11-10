import { HostController } from "./controller.ts";
import { hostEditor, ViewBindings } from "./bindings.ts";
import { mountPlain } from "./plain.ts";
import { installHostHarness } from "./harness.ts";
import { HostDraftRecovery } from "./draft-recovery.ts";
import { createBrowserDraftStore } from "./draft-store.ts";
import "./style.css";

const controller = new HostController(), bindings = new ViewBindings(controller, hostEditor()), host = document.getElementById("host")!;
const draft = new HostDraftRecovery(controller, createBrowserDraftStore(window)); draft.attachNavigation(window);
let cleanup: (() => void) | undefined;
const unmount = () => { cleanup?.(); cleanup = undefined; };
const mount = () => { unmount(); cleanup = mountPlain(host, controller, bindings, draft); };
installHostHarness(controller, bindings, "plain", mount, unmount, () => ({ form: 0, metadata: 0 }), draft);
