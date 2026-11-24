import { after } from "node:test";
import { observeBufferReads } from "./observe-buffer-reads.ts";

const observer = observeBufferReads();
after(observer.dispose);
export const bufferReads = observer.read;
