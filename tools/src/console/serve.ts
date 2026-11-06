// Serves the owner console for a running local sandbox, with the LOCAL SANDBOX TEST SIGNER on the same origin.
//   npx tsx src/console/serve.ts --rpc http://127.0.0.1:<port> [--mandate mandate.sandbox] [--owner owner.sandbox]
//     [--verifier intents.sandbox] [--credential <owner key file>] [--evidence ../out/evidence/demo.json] [--port 8790]
// Without --credential the owner key is the deterministic sandbox key of --owner (src/near/keys.ts). The expected
// mandate code hash is the local build's (target/near/bounded_mandate); the sandbox's chain id and genesis are pinned
// when this starts, because a sandbox's genesis changes on every start.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { REPO_ROOT } from "../evidence/report.js";
import { codeHashOf } from "../live/network.js";
import { loadCredential } from "../near/credentials.js";
import { sandboxKey } from "../near/keys.js";
import { crateWasm } from "../near/sandbox.js";
import { Evidence } from "../types.js";
import { renderConsoleHtml, sandboxProfile } from "./render.js";
import { LocalSandboxSigner, TEST_SIGNER_LABEL } from "./signer.js";

const { values } = parseArgs({
  options: {
    rpc: { type: "string" },
    mandate: { type: "string", default: "mandate.sandbox" },
    owner: { type: "string", default: "owner.sandbox" },
    verifier: { type: "string", default: "intents.sandbox" },
    credential: { type: "string" },
    evidence: { type: "string", default: join(REPO_ROOT, "out/evidence/demo.json") },
    port: { type: "string", default: "8790" },
  },
});
if (values.rpc === undefined) throw new Error("--rpc <loopback sandbox RPC URL> is required");
const evidence = Evidence.parse(JSON.parse(readFileSync(values.evidence, "utf8")));
const key = values.credential === undefined ? sandboxKey(values.owner) : loadCredential(values.credential, values.owner).key;
const chain = await LocalSandboxSigner.chainOf(values.rpc);
const profile = sandboxProfile({
  rpc_url: values.rpc,
  ...chain,
  mandate_id: values.mandate,
  code_hash: codeHashOf(readFileSync(join(REPO_ROOT, crateWasm("bounded-mandate")))),
  verifier_id: values.verifier,
  source: `local build ${crateWasm("bounded-mandate")}`,
});
const signer = await LocalSandboxSigner.start({
  rpcUrl: values.rpc,
  accountId: values.owner,
  key,
  deployment: { mandate_id: values.mandate, verifier_id: values.verifier },
  port: Number(values.port),
  page: () => renderConsoleHtml(evidence, { profiles: [profile], localSigner: "" }),
});
console.log(`${TEST_SIGNER_LABEL} for ${values.owner} on sandbox ${chain.chain_id} (genesis ${chain.genesis_hash})`);
console.log(`console: ${signer.origin}/`);
process.on("SIGINT", () => {
  void signer.stop().then(() => process.exit(0));
});
