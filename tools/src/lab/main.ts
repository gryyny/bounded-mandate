// `make lab`: serves the sandbox lab. Local by default (127.0.0.1:8791); the same process runs hosted when the
// bind address, port and limits come from the environment (LAB_*, see config.ts). It refuses to start unless every
// WASM it would deploy matches its pinned hash, and it never contacts a public network.
import { resolve } from "node:path";
import { LAB_LABEL, configFromEnv } from "./config.js";
import { Lab } from "./lab.js";
import { serveLab } from "./server.js";

async function main(): Promise<void> {
  const config = configFromEnv(process.env);
  let lab: Lab;
  try {
    lab = Lab.start({ config, ...(process.env.LAB_SOURCE_REVISION === undefined ? {} : { declaredRevision: process.env.LAB_SOURCE_REVISION }) });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error("lab: refusing to start on unpinned bytes");
    process.exitCode = 1;
    return;
  }
  const server = await serveLab(lab);
  console.log(LAB_LABEL);
  console.log(`lab: ${server.origin}/ (revision ${lab.source.revision}${lab.source.dirty ? ", dirty" : ""}; up to ${config.maxSessions} sessions)`);
  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    void server
      .close()
      .then(() => lab.close())
      .finally(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  await main();
}
