// Inline stylesheet for the evidence page: an audit-dossier look, light and dark, no external assets.
export const STYLES = `
:root {
  color-scheme: light dark;
  --paper: #f3efe6; --sheet: #fbf9f4; --ink: #1c1d21; --muted: #5f5b52; --rule: #d9d2c3; --rule-strong: #b9b09d;
  --accent: #7d2a1c; --pass: #1d6a48; --pass-bg: #e3efe7; --fail: #b02a1e; --fail-bg: #f7e2de;
  --stale: #8a5d00; --stale-bg: #f5ead0; --none: #6f6b62; --none-bg: #ebe7de;
  --m-source: #6f6b62; --m-sandbox: #24577a; --m-model: #8a5d00; --m-mainnet: #1c1d21;
  --serif: "Iowan Old Style", "Palatino Linotype", "Book Antiqua", Palatino, "URW Palladio L", Georgia, serif;
  --text: Charter, "Bitstream Charter", "Sitka Text", Cambria, "Noto Serif", serif;
  --mono: "Berkeley Mono", "SF Mono", ui-monospace, "Cascadia Mono", "JetBrains Mono", Menlo, Consolas, monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    --paper: #0f1216; --sheet: #151a20; --ink: #ebe6da; --muted: #a39d8f; --rule: #2a3039; --rule-strong: #3d4552;
    --accent: #e0866f; --pass: #6fcf9f; --pass-bg: #15291f; --fail: #ff8a7a; --fail-bg: #3a1a16;
    --stale: #e6b450; --stale-bg: #332710; --none: #9a958a; --none-bg: #22262c;
    --m-source: #9a958a; --m-sandbox: #7fb6dc; --m-model: #e6b450; --m-mainnet: #ebe6da;
  }
}
* { box-sizing: border-box; }
html { background: var(--paper); }
body {
  margin: 0; color: var(--ink); font: 17px/1.6 var(--text);
  background:
    repeating-linear-gradient(0deg, transparent 0 31px, color-mix(in srgb, var(--rule) 35%, transparent) 31px 32px),
    var(--paper);
  -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility;
}
a { color: var(--accent); }
:focus-visible { outline: 3px solid var(--accent); outline-offset: 3px; }
.skip { position: absolute; left: -999px; top: 0; background: var(--sheet); padding: .5rem 1rem; }
.skip:focus { left: 1rem; z-index: 10; }
.dossier { max-width: 1180px; margin: 0 auto; padding: 3rem 1.5rem 5rem; }
header.docket {
  position: relative; background: var(--sheet); border: 1px solid var(--rule-strong);
  box-shadow: 0 1px 0 var(--rule), 0 18px 40px -28px rgb(0 0 0 / .45); padding: 2.5rem 2.5rem 2rem; overflow: hidden;
}
header.docket::before {
  content: ""; position: absolute; inset: 0 auto 0 0; width: 6px;
  background: repeating-linear-gradient(180deg, var(--accent) 0 14px, transparent 14px 20px);
}
.kicker { font: 600 .74rem/1.2 var(--mono); letter-spacing: .18em; text-transform: uppercase; color: var(--muted); margin: 0 0 .9rem; }
h1 { font: 600 clamp(2rem, 4.6vw, 3.4rem)/1.04 var(--serif); letter-spacing: -.015em; margin: 0 0 .6rem; max-width: 22ch; }
h1.lead-line { font-size: clamp(1.9rem, 4vw, 3rem); max-width: 30ch; }
.position.lead-sub { font-size: clamp(1.02rem, 1.6vw, 1.18rem); max-width: 78ch; margin-bottom: .4rem; }
.position { font: 500 clamp(1.15rem, 2.2vw, 1.45rem)/1.35 var(--serif); max-width: 46ch; margin: 0 0 1.2rem; color: var(--accent); }
ul.modes-key { list-style: none; margin: 0 0 1.3rem; padding: .8rem 1rem; display: grid; gap: .45rem; background: color-mix(in srgb, var(--rule) 22%, var(--sheet)); border: 1px solid var(--rule); font-size: .9rem; }
ul.modes-key li { display: grid; grid-template-columns: 11.5rem minmax(0, 1fr); gap: .8rem; align-items: baseline; }
ul.modes-key .mode { justify-self: start; }
h2 { font: 600 1.7rem/1.15 var(--serif); margin: 0 0 1rem; letter-spacing: -.01em; }
h3 { font: 600 1.12rem/1.3 var(--serif); margin: 1.4rem 0 .5rem; }
.lede { max-width: 62ch; font-size: 1.08rem; color: var(--ink); margin: 0 0 1.4rem; }
.facts { display: flex; flex-wrap: wrap; gap: .5rem 1.6rem; margin: 0; font: .82rem/1.4 var(--mono); color: var(--muted); }
.facts div { display: flex; gap: .45rem; }
.facts dt { text-transform: uppercase; letter-spacing: .12em; }
.facts dd { margin: 0; color: var(--ink); word-break: break-all; }
.stamp {
  position: absolute; right: 2.2rem; top: 2.2rem; transform: rotate(-6deg);
  font: 700 .82rem/1.25 var(--mono); letter-spacing: .16em; text-transform: uppercase; text-align: center;
  padding: .7rem 1rem; border: 3px double currentColor; border-radius: 6px; max-width: 15rem;
  mix-blend-mode: multiply; opacity: .9;
}
@media (prefers-color-scheme: dark) { .stamp { mix-blend-mode: normal; } }
.stamp.ok { color: var(--pass); } .stamp.no { color: var(--fail); } .stamp.partial { color: var(--stale); }
.banner { margin: 1.4rem 0 0; padding: .8rem 1rem; border-left: 4px solid var(--stale); background: var(--stale-bg); font-size: .95rem; }
.banner.fail { border-color: var(--fail); background: var(--fail-bg); }
section.folio { display: grid; grid-template-columns: 9.5rem minmax(0, 1fr); gap: 0 2rem; margin-top: 3.2rem; }
.folio > .num {
  font: 600 3.2rem/1 var(--serif); color: var(--accent); text-align: right; border-right: 1px solid var(--rule-strong);
  padding-right: 1.4rem; position: sticky; top: 1rem; align-self: start;
}
.folio > .num small { display: block; font: 600 .68rem/1.4 var(--mono); letter-spacing: .16em; text-transform: uppercase; color: var(--muted); margin-top: .5rem; }
.folio > .body { min-width: 0; }
.source { font: .74rem/1.4 var(--mono); color: var(--muted); margin: -.4rem 0 1rem; }
.claims { display: grid; grid-template-columns: repeat(auto-fit, minmax(17rem, 1fr)); gap: 1rem; }
.card { background: var(--sheet); border: 1px solid var(--rule); padding: 1.1rem 1.2rem; }
.card h3 { margin-top: 0; }
.card ul { margin: .4rem 0 0; padding-left: 1.1rem; }
.card li { margin: .25rem 0; }
.not li::marker { content: "\\2715  "; color: var(--fail); }
table { width: 100%; border-collapse: collapse; background: var(--sheet); border: 1px solid var(--rule); font-size: .94rem; }
caption { text-align: left; font: 600 .72rem/1.4 var(--mono); letter-spacing: .14em; text-transform: uppercase; color: var(--muted); padding: 0 0 .5rem; }
th, td { text-align: left; vertical-align: top; padding: .62rem .8rem; border-bottom: 1px solid var(--rule); }
thead th { font: 600 .72rem/1.3 var(--mono); letter-spacing: .1em; text-transform: uppercase; color: var(--muted); background: color-mix(in srgb, var(--rule) 30%, var(--sheet)); }
tbody tr:hover { background: color-mix(in srgb, var(--rule) 22%, var(--sheet)); }
.scroll { overflow-x: auto; }
code, .mono { font-family: var(--mono); font-size: .84em; word-break: break-all; }
.status {
  display: inline-flex; align-items: center; gap: .35rem; font: 700 .72rem/1 var(--mono); letter-spacing: .1em;
  text-transform: uppercase; padding: .32rem .5rem; border-radius: 3px; white-space: nowrap; border: 1px solid currentColor;
}
.status.passed, .status.blocked, .status.executed, .status.demonstrated, .status.success { color: var(--pass); background: var(--pass-bg); }
.status.failed, .status.attack_succeeded, .status.failure, .status.mismatched, .status.duplicate { color: var(--fail); background: var(--fail-bg); }
.status.stale, .status.inconclusive, .status.unproven, .status.parity, .status.uncertified { color: var(--stale); background: var(--stale-bg); }
.status.not-run, .status.unsupported_by_design, .status.not_run, .status.not-comparable, .status.missing, .status.incomplete {
  color: var(--none); background: repeating-linear-gradient(135deg, var(--none-bg) 0 6px, transparent 6px 9px);
}
.mode {
  display: inline-block; font: 700 .68rem/1 var(--mono); letter-spacing: .14em; text-transform: uppercase;
  padding: .3rem .45rem; border-radius: 2px; white-space: nowrap;
}
.mode.source { color: var(--m-source); border: 1px dashed currentColor; }
.mode.sandbox { color: var(--m-sandbox); border: 1px solid currentColor; }
.mode.recorded-model, .mode.live-model { color: var(--m-model); border: 1px dotted currentColor; }
.mode.live-model { border-style: solid; }
.mode.mainnet { color: var(--sheet); background: var(--m-mainnet); border: 3px double var(--sheet); outline: 1px solid var(--m-mainnet); }
.mode.pending { color: var(--none); border: 1px dashed currentColor; }
.mode.other { color: var(--muted); border: 1px solid var(--rule-strong); white-space: normal; line-height: 1.4; }
th[scope="row"], td code { white-space: nowrap; }
td.reason { min-width: 16rem; }
.chips { display: flex; flex-wrap: wrap; gap: .45rem; margin: 0 0 1.2rem; }
.mode.label { color: var(--m-sandbox); border: 1px solid currentColor; }
.facts-line { font: .82rem/1.4 var(--mono); color: var(--muted); margin: 0; }
ul.receipts, ul.checks { list-style: none; margin: .5rem 0 0; padding: 0; }
ul.receipts > li, ul.checks > li { margin: .35rem 0; }
.step-head { margin-bottom: .3rem; }
ol.timeline { list-style: none; margin: 0; padding: 0; position: relative; counter-reset: step; }
ol.timeline::before { content: ""; position: absolute; left: 1.05rem; top: .4rem; bottom: .4rem; width: 2px; background: var(--rule-strong); }
ol.timeline > li {
  position: relative; padding: 0 0 1.3rem 3.2rem; counter-increment: step;
  animation: rise .5s both cubic-bezier(.2,.7,.2,1); animation-delay: calc(var(--i, 0) * 60ms);
}
ol.timeline > li::before {
  content: counter(step); position: absolute; left: 0; top: 0; width: 2.2rem; height: 2.2rem; border-radius: 50%;
  display: grid; place-items: center; background: var(--sheet); border: 2px solid var(--ink); font: 700 .85rem/1 var(--mono);
}
ol.timeline > li.failure::before { border-color: var(--fail); color: var(--fail); }
.step-head { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem .7rem; }
.step-head strong { font: 600 1.05rem/1.3 var(--serif); }
.step-meta { font: .76rem/1.5 var(--mono); color: var(--muted); margin: .25rem 0 0; word-break: break-all; }
details { margin-top: .4rem; }
summary { cursor: pointer; font: 600 .74rem/1.6 var(--mono); letter-spacing: .08em; text-transform: uppercase; color: var(--accent); }
pre { margin: .5rem 0 0; padding: .8rem; background: color-mix(in srgb, var(--rule) 25%, var(--sheet)); border: 1px solid var(--rule); overflow-x: auto; font: .78rem/1.5 var(--mono); max-height: 26rem; }
.lifecycle { background: var(--sheet); border: 1px solid var(--rule); padding: 1rem; overflow-x: auto; }
.lifecycle svg { min-width: 760px; width: 100%; height: auto; display: block; color: var(--ink); }
.lifecycle .node rect { fill: var(--sheet); stroke: var(--ink); stroke-width: 1.5; }
.lifecycle .node.warn rect { stroke: var(--stale); stroke-width: 2; }
.lifecycle .node.safe rect { stroke: var(--pass); stroke-width: 2.5; }
.lifecycle .node text { fill: var(--ink); font: 600 15px var(--serif); }
.lifecycle .note { fill: var(--muted); font: 11.5px var(--mono); }
.lifecycle .edge { stroke: var(--ink); stroke-width: 1.4; fill: none; }
.lifecycle .edge.back { stroke: var(--accent); stroke-dasharray: 5 4; }
.lifecycle .label { fill: var(--accent); font: 600 11px var(--mono); letter-spacing: .04em; }
.verdict { display: flex; align-items: center; gap: 1rem; margin: 0 0 1.2rem; padding: 1rem 1.2rem; background: var(--sheet); border: 1px solid var(--rule-strong); }
.verdict p { margin: 0; }
dl.kv { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: .35rem 1.2rem; margin: 0; background: var(--sheet); border: 1px solid var(--rule); padding: 1rem 1.2rem; }
dl.kv dt { font: 600 .74rem/1.6 var(--mono); letter-spacing: .08em; text-transform: uppercase; color: var(--muted); }
dl.kv dd { margin: 0; font: .82rem/1.6 var(--mono); word-break: break-all; }
ul.unknowns { margin: 0; padding: 0; list-style: none; }
ul.unknowns li { padding: .6rem .9rem; margin-bottom: .5rem; background: var(--sheet); border: 1px solid var(--rule); border-left: 4px solid var(--stale); }
section.story, section.paths { margin-top: 2.6rem; }
section.story h2, section.paths h2 { font-size: 1.5rem; }
ol.stages { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr)); gap: 1rem; counter-reset: none; }
li.stage {
  position: relative; background: var(--sheet); border: 1px solid var(--rule-strong); border-top: 5px solid var(--ink);
  padding: .9rem 1rem 1rem; display: flex; flex-direction: column; gap: .45rem; min-width: 0;
  animation: rise .5s both cubic-bezier(.2,.7,.2,1);
}
li.stage.revoked, li.stage.rejected { border-top-color: var(--accent); background: color-mix(in srgb, var(--accent) 6%, var(--sheet)); }
li.stage.recovered { border-top-color: var(--pass); }
li.stage.failure, li.stage.missing { border-top-color: var(--fail); }
li.stage.inconclusive { border-top-color: var(--stale); }
.stage-head { display: flex; align-items: center; gap: .6rem; margin: 0; }
.stage-n { flex: none; width: 1.9rem; height: 1.9rem; border-radius: 50%; display: grid; place-items: center; border: 2px solid currentColor; font: 700 .85rem/1 var(--mono); }
li.stage.revoked .stage-n, li.stage.rejected .stage-n { color: var(--accent); }
.stage-title { font: 600 1.08rem/1.2 var(--serif); }
.stage-modes { display: flex; flex-wrap: wrap; gap: .3rem; margin: 0; }
.stage-modes .mode { white-space: normal; line-height: 1.3; }
.headline { font: 600 1.18rem/1.3 var(--serif); margin: .1rem 0; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.headline.absent { font: .82rem/1.4 var(--mono); color: var(--fail); }
dl.stage-facts { margin: 0; display: grid; grid-template-columns: minmax(0, 6.6rem) minmax(0, 1fr); gap: .15rem .7rem; font-size: .84rem; }
dl.stage-facts dt { color: var(--muted); }
dl.stage-facts dd { margin: 0; overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
.bound { margin: auto 0 0; padding-top: .4rem; border-top: 1px dotted var(--rule-strong); font: .72rem/1.55 var(--mono); color: var(--muted); overflow-wrap: anywhere; }
.bound .absent { color: var(--fail); }
li.stage.withdrawn { border-top-style: dashed; border-top-color: var(--m-sandbox); }
.stage-state { margin: 0; font: .72rem/1.5 var(--mono); color: var(--muted); overflow-wrap: anywhere; }
.stage-state span { text-transform: uppercase; letter-spacing: .1em; color: var(--ink); }
.replay-guide { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: end; gap: .6rem 1.25rem; margin-top: 1.35rem; }
.replay-guide h2 { margin-bottom: .25rem; font-size: 1.4rem; }
.replay-guide p { margin: 0; color: var(--muted); font-size: .91rem; }
.replay-guide nav { display: flex; flex-wrap: wrap; gap: .25rem .85rem; font: .72rem/1.5 var(--mono); }
ol.journey { list-style: none; margin: .8rem 0 1.2rem; padding: 0; display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: .8rem; }
li.jstep { position: relative; background: color-mix(in srgb, var(--rule) 14%, var(--sheet)); border: 1px solid var(--rule-strong); border-top: 4px solid var(--pass); padding: .7rem .8rem .75rem; display: flex; flex-direction: column; gap: .35rem; min-width: 0; animation: rise .5s both cubic-bezier(.2,.7,.2,1); }
li.jstep.revoked, li.jstep.rejected { border-top-color: var(--accent); background: color-mix(in srgb, var(--accent) 7%, var(--sheet)); }
li.jstep.withdrawn { border-top-style: dashed; border-top-color: var(--m-sandbox); }
li.jstep.failure, li.jstep.missing { border-top-color: var(--fail); background: color-mix(in srgb, var(--fail-bg) 55%, var(--sheet)); }
li.jstep.inconclusive { border-top-color: var(--stale); background: color-mix(in srgb, var(--stale-bg) 55%, var(--sheet)); }
.jhead { display: flex; align-items: baseline; gap: .5rem; margin: 0; }
.jn { flex: none; font: 700 1.5rem/1 var(--mono); color: var(--muted); }
li.jstep.revoked .jn, li.jstep.rejected .jn { color: var(--accent); }
.jtitle { font: 600 1rem/1.2 var(--serif); }
.jresult { margin: 0; font-size: .86rem; line-height: 1.4; overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
.jmeta { margin: auto 0 0; display: flex; flex-wrap: wrap; gap: .25rem; align-items: center; font: .7rem/1.3 var(--mono); }
.jmeta .mode { white-space: normal; line-height: 1.25; font-size: .62rem; }
.jmeta a { margin-left: auto; }
details.replay { margin: .2rem 0 0; padding: 0; border: 0; border-top: 1px solid var(--rule-strong); background: transparent; }
.replay summary { padding: .35rem 0 .05rem; color: var(--accent); font: 600 .74rem/1.5 var(--mono); }
.replay-stage { display: grid; gap: .35rem; padding: .45rem 0; }
.replay-stage + .replay-stage { border-top: 1px solid var(--rule); }
.replay-stage > p:first-child { margin: 0; font-size: .82rem; }
.replay-stage .stage-facts { grid-template-columns: minmax(0, 2fr) minmax(0, 3fr); font-size: .76rem; }
p.journey-note { margin: 0 0 1.2rem; font: .78rem/1.5 var(--mono); color: var(--muted); max-width: 90ch; }
@media (max-width: 980px) { ol.journey { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 560px) { ol.journey { grid-template-columns: minmax(0, 1fr); gap: .55rem; } }
p.planned { margin: .9rem 0 0; font-size: .88rem; overflow-wrap: anywhere; }
.result-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 17rem), 1fr)); gap: .85rem; }
.result-grid > article { min-width: 0; padding: .85rem 1rem; border: 1px solid var(--rule-strong); background: var(--sheet); }
.result-grid h3 { margin: 0; }
.result-grid p { margin: .45rem 0; }
.result-grid .result-number { font: 600 clamp(1.8rem, 3.4vw, 2.75rem)/1 var(--serif); color: var(--accent); font-variant-numeric: tabular-nums; }
.revocation-results th[scope="row"] { min-width: 9rem; white-space: normal; }
table.attack-log td { vertical-align: top; overflow-wrap: anywhere; }
td.route { font-weight: 600; min-width: 12rem; }
td.route code { white-space: normal; word-break: normal; overflow-wrap: anywhere; }
table.attack-log td.reason { font: .8rem/1.45 var(--mono); }
table.attack-log .mono { font: .74rem/1.4 var(--mono); }
ol.path-list { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr)); gap: 1rem; counter-reset: path; }
ol.path-list > li { background: var(--sheet); border: 1px solid var(--rule); padding: 1rem 1.1rem; counter-increment: path; overflow-wrap: anywhere; }
ol.path-list > li p { margin: .3rem 0; }
ol.path-list .do { font: 600 1.05rem/1.3 var(--serif); margin-top: 0; }
ol.path-list .do::before { content: counter(path, lower-alpha) ") "; color: var(--accent); font-family: var(--mono); }
ol.path-list .see { font-size: .92rem; }
.pending-panel { background: repeating-linear-gradient(135deg, var(--none-bg) 0 10px, var(--sheet) 10px 20px); border: 2px dashed var(--rule-strong); padding: 1.1rem 1.3rem; }
.pending-panel p { margin: .3rem 0; }
.pending-title { font: 700 1.05rem/1.35 var(--serif); }
pre.commands { white-space: pre-wrap; overflow-wrap: anywhere; }
.outcome { margin: 0 0 1.4rem; padding: 1rem 1.2rem; border: 1px solid var(--rule); background: color-mix(in srgb, var(--pass-bg) 45%, var(--sheet)); }
.outcome p { margin: 0 0 .7rem; max-width: 80ch; }
.outcome table { font-variant-numeric: tabular-nums; }
.outcome .source { margin: .7rem 0 0; }
.verify-controls { display: flex; flex-wrap: wrap; gap: .5rem .8rem; align-items: center; }
.verify-controls input { font: .86rem var(--mono); padding: .45rem .6rem; border: 1px solid var(--rule-strong); background: var(--sheet); color: var(--ink); min-width: 0; flex: 1 1 22rem; }
.verify-controls button { font: 700 .78rem/1 var(--mono); letter-spacing: .08em; text-transform: uppercase; padding: .6rem .9rem; border: 2px solid var(--accent); background: var(--sheet); color: var(--accent); cursor: pointer; }
.verify-controls button:disabled { opacity: .5; cursor: progress; }
.vparts { display: grid; gap: 1rem; margin-top: 1rem; }
.vpart { background: var(--sheet); border: 1px solid var(--rule); padding: .9rem 1.1rem; min-width: 0; }
.vpart h3 { margin-top: 0; }
ol.vitems { list-style: none; margin: .6rem 0 0; padding: 0; display: grid; gap: .6rem; }
li.vitem { border-left: 4px solid var(--rule-strong); padding: .2rem 0 .2rem .8rem; overflow-wrap: anywhere; }
li.vitem.verified { border-color: var(--pass); } li.vitem.failed { border-color: var(--fail); } li.vitem.inconclusive, li.vitem.error { border-color: var(--stale); }
li.vitem p { margin: 0 0 .4rem; }
article.casefile { background: var(--sheet); border: 1px solid var(--rule); padding: .9rem 1.1rem; margin: 0 0 1rem; min-width: 0; }
article.casefile h3 { margin-top: 0; display: flex; flex-wrap: wrap; gap: .6rem; align-items: center; }
.note-line { font: 700 .72rem/1.4 var(--mono); letter-spacing: .1em; text-transform: uppercase; color: var(--stale); margin: 0 0 .5rem; }
footer { margin-top: 4rem; padding-top: 1.2rem; border-top: 1px solid var(--rule-strong); font: .76rem/1.6 var(--mono); color: var(--muted); }
.muted { color: var(--muted); }
@keyframes rise { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
@media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }
@media (max-width: 760px) {
  body { font-size: 16px; }
  .dossier { padding: 1.2rem .8rem 3rem; }
  header.docket { padding: 1.6rem 1.2rem 1.4rem 1.6rem; }
  .stamp { position: static; display: inline-block; margin: 0 0 1rem; transform: rotate(-2deg); }
  section.folio { grid-template-columns: 1fr; margin-top: 2.4rem; }
  .folio > .num { position: static; text-align: left; border-right: 0; border-bottom: 1px solid var(--rule-strong); padding: 0 0 .5rem; margin-bottom: 1rem; font-size: 2.2rem; }
  .folio > .num small { display: inline; margin-left: .6rem; }
  ul.modes-key li { grid-template-columns: 1fr; gap: .2rem; }
  .mode, .status { white-space: normal; line-height: 1.35; }
  .verdict { flex-wrap: wrap; } .verdict p { min-width: 0; flex: 1 1 100%; overflow-wrap: anywhere; }
  dl.kv { grid-template-columns: minmax(0, 1fr); } dl.kv dt { overflow-wrap: anywhere; }
  li.stage + li.stage::before { content: "↓"; position: absolute; top: -1.05rem; left: 1.4rem; font: 700 .9rem/1 var(--mono); color: var(--muted); }
}
@media print {
  body { background: #fff; } .stamp { mix-blend-mode: normal; } details { display: block; } ol.timeline > li, li.stage, li.jstep { animation: none; }
}
`;
