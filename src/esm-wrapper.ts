
//vexa-core-host/src/esm-wrapper.ts
import * as cjs from "./index.js";
export const CoreHost = (cjs as any).CoreHost;
export * from "./protocol.js";
export default CoreHost;
