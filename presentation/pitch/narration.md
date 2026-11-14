# Pitch narration

An explainer based on recorded evidence; not a certified cut. Each segment is synthesized separately so the scenes can be timed to the actual audio. The spoken column is written for the speech model ("Near" rather than "NEAR", letters spaced out); the caption column uses the written forms.

| id | spoken text | caption text |
| --- | --- | --- |
| s01-proof | On Near main net, a signed trading order was rejected sixty-seven seconds before it expired, because the owner had already revoked its key. | On NEAR mainnet, a signed order was rejected 67 s before it expired, because the owner had already revoked its key. |
| s02-name | Bounded Mandate gives an AI agent trading authority, without unrestricted control of your treasury. | Bounded Mandate: give an AI agent trading authority without unrestricted control of your treasury. |
| s03-problem | Pausing an agent stops new orders. But orders it already signed stay valid until they expire, or are cancelled one by one. | Pausing an agent stops new orders. Orders it already signed stay valid until they expire or are cancelled one by one. |
| s04-agent | Here, the agent holds no signing key. Its only key can propose an order. | The agent holds no signing key. Its only key can propose an order. |
| s05-contract | A Near contract prices each order from the oracle, checks your limits, then asks Near's M P C network to sign it, through Chain Signatures. | A NEAR contract prices each order from the oracle, checks your limits, then asks NEAR's MPC network to sign it (Chain Signatures). |
| s06-verifier | The Near Intents verifier checks that key on every order. So revoking is one owner call that removes it. | The NEAR Intents verifier checks that key on every order, so revoking is one owner call that removes it. |
| s07-run | On main net, with fixed proposals and our own filler, the contract refused an over-limit order, then signed a one U S D C trade that was filled. | Mainnet, fixed proposals, our own filler: an over-limit order refused; a 1 USDC order signed and filled. |
| s08-revoke | A second signed order was held back. The owner revoked, and the key's removal was confirmed. | A second signed order was held back. The owner revoked; removal of the key was confirmed. |
| s09-reject | The held order was then relayed, and rejected: its signing key no longer exists. | The held order was relayed and rejected: its signing key no longer exists. |
| s10-recover | Recovery returned both assets to the owner's Intents account. | Recovery returned both assets to the owner's Intents account. |
| s11-sandbox | In the sandbox, with labelled test doubles, thirty-nine scripted hostile requests were refused across five layers. | Sandbox, labelled test doubles: 39 scripted hostile requests refused across five layers. |
| s12-limits | Orders that execute before removal is confirmed stay executed. This is not an audit, and it promises no profit. | Orders executed before confirmed removal stay executed. Not an audit; no profit promised. |
| s13-verify | Check every transaction on the explorer, or run make verify. Start at the overview page. | Check each transaction on nearblocks, or run make verify. Start at the overview page. |
