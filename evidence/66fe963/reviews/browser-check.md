# Browser check of the 66fe963 site and cuts

Scripted check in Google Chrome 157.0.8103.78 (headless, playwright-core) of the site assembled by `tools/src/release/main.ts site` from the fresh clone at 66fe9635f4dc0dd200f6a5e9ad1bee03f144964d, served from loopback under `/bounded-mandate/` with byte-range support. Results are in [browser-check.json](browser-check.json); screenshots and decoded video frames are in [screens/](screens/).

- Page and console at 1440 x 900 and 390 x 844: horizontal overflow 0 px, no page error, every in-page fragment link resolves, and the only request before any interaction is the document itself.
- The page names revision 66fe963 and states that no mainnet transaction has been executed.
- Short cut: decodes at 1920 x 1080, 85.866667 s, readyState 4, no media error; frames captured at 1, 46 and 81 s.
- Walkthrough: decodes at 1920 x 1080, 224 s, readyState 4, no media error; frames captured at 1, 137 and 217 s.

Not covered here: the lab and Compare tabs, the DAO preset, the unavailable-lab fallback, the invalid-RPC refusal and the synthetic mainnet UI states. Those were inspected at 2d77c38 ([presentation-final.md](../../2d77c38/reviews/presentation-final.md)) and were not repeated. This is a scripted check, not a human review. No wallet was connected, nothing was signed, and no public-network transaction was made.
