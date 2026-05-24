import { setGlobalOptions } from "firebase-functions/v2";

setGlobalOptions({ maxInstances: 10, region: "us-central1" });

export { askClaude } from "./askClaude";
export { createPR } from "./createPR";
