import { DemoProject } from "../../../examples/demo/project.ts";

const state = { armed: true, reported: 0, failure: new Error("Injected project startup failure") };
Object.assign(window, { demoProjectFailure: state });
const open = DemoProject.open;
DemoProject.open = async (...args) => {
    if (state.armed) {
        state.armed = false;
        throw state.failure;
    }
    return open(...args);
};
const report = console.error;
console.error = (...args) => {
    if (args.length === 1 && args[0] === state.failure) state.reported++;
    else report(...args);
};
await import("../../../examples/demo/browser-main.ts");
