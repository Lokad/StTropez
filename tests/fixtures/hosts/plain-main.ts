import { HostController } from "./controller.ts";
import { ViewBindings } from "./bindings.ts";
import { mountPlain } from "./plain.ts";
import { installHostHarness } from "./harness.ts";
import { HostLifecycle } from "./lifecycle.ts";
import "./style.css";

export function startPlainHost() {
const controller = new HostController(), bindings = new ViewBindings(controller), host = document.getElementById("host")!;
let cleanup: (() => void) | undefined;
const unmount = () => { const current = cleanup; cleanup = undefined; current?.(); };
const mount = () => { unmount(); cleanup = mountPlain(host, controller, bindings); };
const lifecycle = new HostLifecycle(window, document.getElementById("recover")!, { controller, bindings, mount, unmount });
lifecycle.start();
installHostHarness(controller, bindings, "plain", lifecycle, () => ({ form: 0, metadata: 0 }));

}
