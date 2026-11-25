import { startPlayground } from "./main.ts";
import { openDemoProvider } from "./worker-provider.ts";

await startPlayground(openDemoProvider);
