import { HostController } from "./controller.ts";
import { hostEditor, ViewBindings } from "./bindings.ts";
import { mountPlain } from "./plain.ts";
import { installHostHarness } from "./harness.ts";
import { HostLifecycle } from "./lifecycle.ts";
import { HostDraftRecovery } from "./draft-recovery.ts";
import { createBrowserDraftStore } from "./draft-store.ts";
import "./style.css";

const controller = new HostController(), bindings = new ViewBindings(controller, hostEditor()), host = document.getElementById("host")!;
const draft = new HostDraftRecovery(controller, createBrowserDraftStore(window)); draft.attachNavigation(window);
let cleanup: (() => void) | undefined;
const unmount = () => { const current = cleanup; cleanup = undefined; current?.(); };
const mount = () => { unmount(); cleanup = mountPlain(host, controller, bindings, draft); };
const lifecycle = new HostLifecycle(window, document.getElementById("recover")!, { controller, bindings, draft, mount, unmount });
lifecycle.start();
installHostHarness(controller, bindings, "plain", lifecycle, () => ({ form: 0, metadata: 0 }), draft);
