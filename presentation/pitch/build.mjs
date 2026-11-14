#!/usr/bin/env node
// Builds the narrated explainer (an explainer based on recorded evidence, not a certified cut):
// presentation/pitch/bounded-mandate-pitch.mp4 with burned-in captions, captions.srt, captions.vtt, poster.png and
// pitch.json (provenance). Scene timing comes from the measured duration of each narration file, so the pictures,
// captions and voice stay in step whenever the narration is regenerated.
//
// Usage (from the repository root):
//   node presentation/pitch/build.mjs           # final build; needs presentation/pitch/audio/<id>.wav for every segment
//   node presentation/pitch/build.mjs --draft   # silent draft with estimated durations -> out/pitch/draft.mp4
//
// Inputs: presentation/pitch/narration.md (segment id, spoken text, caption text), presentation/pitch/audio/<id>.wav,
// presentation/pitch/scenes/* (boards rendered by headless Chrome), the sandbox console screenshot and
// evidence/dd665d1/live-mainnet.json (every receipt card is checked against it). Scratch files go to out/pitch/.
// Prerequisites: ffmpeg/ffprobe on PATH (FFMPEG / FFPROBE override), Google Chrome (PW_CHANNEL override) and
// playwright-core from the globally installed playwright-cli (PLAYWRIGHT_CORE overrides the path).
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const OUT = join(ROOT, "out/pitch");
const FFMPEG = process.env.FFMPEG ?? "ffmpeg";
const FFPROBE = process.env.FFPROBE ?? "ffprobe";
const DRAFT = process.argv.includes("--draft");

const W = 1920;
const H = 1080;
const FPS = 30;
const LEAD = 0.2; // silence before the first segment (s01 is on screen from frame 0)
const GAP = 0.28; // silence between segments; the scene crossfade fills it
const TAIL = 0.6; // hold on the last board after the voice ends
const SCENE_XF = 0.28; // scene crossfade, ends exactly when the next segment's voice starts
const STATE_XF = 0.3; // crossfade between build states inside a scene
const CUE_LEAD = 0.12; // a build state starts this much before its cue word
const WORDS_PER_SEC = 2.6; // draft estimate only
const LOUDNESS = { I: -16, TP: -2, LRA: 11 }; // TP -2 leaves margin under the -1.5 dBTP ceiling after AAC
const STATEMENT = "Explainer based on recorded evidence (evidence/dd665d1, mainnet attempt 3); not a certified cut; mainnet timings are actual; diagrams are illustrative.";

// Per segment: the board and its build states; each state starts at a cue phrase of the spoken text (null: scene start).
const PLAN = {
  "s01-proof": { board: "proof", states: [[1, null], [2, "rejected"]] },
  "s02-name": { board: "name", states: [[1, null]] },
  "s03-problem": { board: "pause", states: [[1, null], [2, "but does not"]] },
  "s04-agent": { board: "arch", states: [[1, null], [2, "Its key can only"]] },
  "s05-contract": { board: "arch", states: [[3, null], [4, "checks your limits"], [5, "then asks"]] },
  "s06-verifier": { board: "arch", states: [[6, null], [7, "So revoking"]] },
  "s07-run": { board: "run", states: [[1, null], [2, "the contract refused"], [3, "then signed"]] },
  "s08-revoke": { board: "revoke", states: [[1, null], [2, "The owner revoked"]] },
  "s09-reject": { board: "revoke", states: [[3, null]] },
  "s10-recover": { board: "run", states: [[4, null]] },
  "s11-sandbox": { board: "sandbox", states: [[1, null], [2, "thirty-nine"]] },
  "s12-limits": { board: "limits", states: [[1, null], [2, "This is not"], [3, "and it promises"]] },
  "s13-verify": { board: "verify", states: [[1, null], [2, "with the verify script"], [3, "Start at"]] },
};
const POSTER = ["proof", 2];
const SCREENSHOTS = ["evidence/dd665d1/console/screens/demo-console-review.png"];
const MAINNET = "evidence/dd665d1/live-mainnet.json";

// ---- helpers -------------------------------------------------------------------------------------

const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const rel = (p) => relative(ROOT, p);
const fileInfo = (p) => ({ path: rel(p), sha256: sha256(p), bytes: statSync(p).size });
const r3 = (x) => Math.round(x * 1000) / 1000;
const ffmpeg = (args) => {
  const r = spawnSync(FFMPEG, ["-hide_banner", "-nostdin", ...args], { encoding: "utf8", maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error(`ffmpeg failed (${r.status}):\n${r.stderr.slice(-4000)}`);
  return r.stderr;
};
const probeDuration = (path, stream) => {
  const args = ["-v", "error", "-of", "json"];
  args.push(...(stream === undefined ? ["-show_entries", "format=duration"] : ["-select_streams", stream, "-show_entries", "stream=duration"]));
  const j = JSON.parse(execFileSync(FFPROBE, [...args, path], { encoding: "utf8" }));
  return Number(stream === undefined ? j.format.duration : j.streams[0].duration);
};
const stamp = (t, sep) => {
  const ms = Math.round(t * 1000);
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)}${sep}${p(ms % 1000, 3)}`;
};
/** Two balanced lines for the caption files (the burned-in caption is balanced by the browser). */
const twoLines = (text) => {
  if (text.length <= 42) return text;
  const words = text.split(" ");
  let best = text;
  let score = Infinity;
  for (let i = 1; i < words.length; i++) {
    const a = words.slice(0, i).join(" ");
    const b = words.slice(i).join(" ");
    const s = Math.abs(a.length - b.length);
    if (s < score) [best, score] = [`${a}\n${b}`, s];
  }
  return best;
};

// ---- narration and timing ------------------------------------------------------------------------

const narrationPath = join(HERE, "narration.md");
const rows = readFileSync(narrationPath, "utf8")
  .split("\n")
  .map((l) => /^\| (s\d{2}-[a-z]+) \| (.+?) \| (.+?) \|$/.exec(l))
  .filter((m) => m !== null)
  .map(([, id, spoken, caption]) => ({ id, spoken, caption }));
const planIds = Object.keys(PLAN);
if (rows.map((r) => r.id).join() !== planIds.join()) throw new Error(`narration.md segments (${rows.map((r) => r.id).join(", ")}) differ from the scene plan (${planIds.join(", ")})`);

const audioOf = (id) => ["wav", "flac", "mp3", "m4a"].map((e) => join(HERE, "audio", `${id}.${e}`)).find(existsSync);
const missing = rows.filter((r) => audioOf(r.id) === undefined).map((r) => r.id);
if (!DRAFT && missing.length > 0) throw new Error(`no narration audio for ${missing.join(", ")}: run with --draft for a silent draft (never a final cut)`);

let clock = LEAD;
const segments = rows.map((r) => {
  const audio = DRAFT ? undefined : audioOf(r.id);
  const duration = audio === undefined ? r.spoken.split(/\s+/).length / WORDS_PER_SEC : probeDuration(audio);
  const seg = { ...r, audio, duration, start: clock, end: clock + duration };
  clock = seg.end + GAP;
  return seg;
});
const last = segments.at(-1);
const total = Math.ceil((last.end + TAIL) * FPS) / FPS;

// Clips: one per build state, in order; each fades in over `xf` starting at `at`.
const clips = [];
for (const [i, seg] of segments.entries()) {
  const plan = PLAN[seg.id];
  for (const [state, cue] of plan.states) {
    let at;
    if (cue === null) at = i === 0 ? 0 : seg.start - SCENE_XF;
    else {
      const idx = seg.spoken.indexOf(cue);
      if (idx < 0) throw new Error(`${seg.id}: cue "${cue}" is not in the spoken text`);
      at = seg.start + (idx / seg.spoken.length) * seg.duration - CUE_LEAD;
    }
    const xf = cue === null ? SCENE_XF : STATE_XF;
    const prev = clips.at(-1);
    if (prev !== undefined && prev.board === plan.board && prev.state === state) continue;
    if (prev !== undefined && at < prev.at + prev.xf + 0.5) throw new Error(`${seg.id}: state ${state} would start ${r3(at - prev.at)} s after the previous one`);
    clips.push({ segment: seg.id, board: plan.board, state, at, xf });
  }
}

// ---- render boards and captions ------------------------------------------------------------------

const FRAMES = join(OUT, "frames");
const CAPS = join(OUT, "captions");
rmSync(FRAMES, { recursive: true, force: true });
rmSync(CAPS, { recursive: true, force: true });
mkdirSync(FRAMES, { recursive: true });
mkdirSync(CAPS, { recursive: true });

const require = createRequire(import.meta.url);
const pwPath = process.env.PLAYWRIGHT_CORE ?? join(execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(), "@playwright/cli/node_modules/playwright-core");
const { chromium } = require(pwPath);
const browser = await chromium.launch({ channel: process.env.PW_CHANNEL ?? "chrome", headless: true });
const chromeVersion = browser.version();
const problems = [];
const receipts = JSON.parse(readFileSync(join(ROOT, MAINNET), "utf8")).receipts;
const cardsChecked = new Set();
try {
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  const scenesUrl = pathToFileURL(join(HERE, "scenes/scenes.html")).href;
  const rendered = new Map();
  for (const c of [...clips, { board: POSTER[0], state: POSTER[1] }]) {
    const key = `${c.board}-${c.state}`;
    if (!rendered.has(key)) {
      await page.goto(`${scenesUrl}?board=${c.board}&state=${c.state}`);
      await page.evaluate(async () => {
        await document.fonts.ready;
        await Promise.all([...document.images].map((i) => (i.complete ? null : new Promise((ok) => i.addEventListener("load", ok)))));
      });
      const broken = await page.evaluate(() => [...document.images].filter((i) => i.naturalWidth === 0).map((i) => i.src));
      for (const b of broken) problems.push(`${key}: image did not load: ${b}`);
      for (const p of await page.evaluate(() => window.__check())) problems.push(`${key}: ${p}`);
      // Every receipt card must name a real receipt of the run: abbreviated hash, block height and outcome.
      const cards = await page.evaluate(() =>
        [...document.querySelectorAll(".board.active .card")]
          .filter((c) => c.getClientRects().length > 0)
          .map((c) => ({ abbr: c.querySelector(".meta b")?.textContent ?? "", block: (c.querySelectorAll(".meta")[1]?.textContent ?? "").replace(/\D+$/, "").replace(/\D/g, ""), fail: c.querySelector(".out.fail") !== null })),
      );
      for (const card of cards) {
        const [head, tail] = card.abbr.split("…");
        const r = receipts.find((x) => x.tx_hash.startsWith(head) && x.tx_hash.endsWith(tail) && head.length === 6 && tail.length === 4);
        if (r === undefined) problems.push(`${key}: card ${card.abbr} matches no receipt in ${MAINNET}`);
        else if (String(r.block_height) !== card.block) problems.push(`${key}: card ${card.abbr} shows block ${card.block}, the receipt is in ${r.block_height}`);
        else if ((r.outcome === "failure") !== card.fail) problems.push(`${key}: card ${card.abbr} outcome badge differs from ${r.outcome}`);
        else cardsChecked.add(`${card.abbr} #${card.block} ${r.outcome}`);
      }
      const file = join(FRAMES, `${key}.png`);
      await page.screenshot({ path: file });
      rendered.set(key, file);
    }
    c.png = rendered.get(key);
  }
  const capUrl = pathToFileURL(join(HERE, "scenes/caption.html")).href;
  await page.goto(capUrl);
  await page.evaluate(() => document.fonts.ready);
  for (const seg of segments) {
    const m = await page.evaluate((t) => window.__setCaption(t), seg.caption);
    if (m.lines > 2) problems.push(`${seg.id}: caption needs ${m.lines} lines`);
    if (m.top < 875) problems.push(`${seg.id}: caption box reaches y=${Math.round(m.top)} (content band ends at 870)`);
    seg.capPng = join(CAPS, `${seg.id}.png`);
    await page.screenshot({ path: seg.capPng, omitBackground: true });
  }
} finally {
  await browser.close();
}
if (problems.length > 0) throw new Error(`layout or content checks failed:\n  ${problems.join("\n  ")}`);

// ---- audio: place each segment, then two-pass loudnorm -------------------------------------------

let loud;
const normWav = join(OUT, "narration-norm.wav");
if (!DRAFT) {
  const mixWav = join(OUT, "narration-mix.wav");
  const inputs = segments.flatMap((s) => ["-i", s.audio]);
  const chains = segments.map((s, i) => `[${i}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=mono,pan=stereo|c0=c0|c1=c0,adelay=delays=${Math.round(s.start * 48000)}S:all=1[a${i}]`);
  const mix = `${segments.map((_, i) => `[a${i}]`).join("")}amix=inputs=${segments.length}:normalize=0:duration=longest,apad=whole_dur=${total},atrim=0:${total}[mix]`;
  ffmpeg(["-y", ...inputs, "-filter_complex", [...chains, mix].join(";"), "-map", "[mix]", "-c:a", "pcm_f32le", mixWav]);
  const json = (stderr) => JSON.parse(stderr.slice(stderr.lastIndexOf("{"), stderr.lastIndexOf("}") + 1));
  const target = `I=${LOUDNESS.I}:TP=${LOUDNESS.TP}:LRA=${LOUDNESS.LRA}`;
  // The raw voice peaks near 0 dBFS, too hot for a linear gain to the target. A look-ahead peak limiter first takes the
  // few plosive peaks down to where the linear gain lands them under the true-peak ceiling, so loudnorm can stay
  // linear (one constant gain) instead of switching to its dynamic mode.
  const raw = json(ffmpeg(["-i", mixWav, "-af", `loudnorm=${target}:print_format=json`, "-f", "null", "-"]));
  // Limiting lowers the loudness a little and true peaks overshoot sample peaks, so tighten until the gain fits.
  const limitedWav = join(OUT, "narration-limited.wav");
  let limitDb = LOUDNESS.TP - (LOUDNESS.I - Number(raw.input_i)) - 0.5;
  let pass1;
  for (let attempt = 0; ; attempt++) {
    ffmpeg(["-y", "-i", mixWav, "-af", `alimiter=limit=${(10 ** (limitDb / 20)).toFixed(4)}:level=0:attack=5:release=60:asc=1`, "-c:a", "pcm_f32le", limitedWav]);
    pass1 = json(ffmpeg(["-i", limitedWav, "-af", `loudnorm=${target}:print_format=json`, "-f", "null", "-"]));
    const excess = Number(pass1.input_tp) + (LOUDNESS.I - Number(pass1.input_i)) - (LOUDNESS.TP - 0.2);
    if (excess <= 0) break;
    if (attempt === 5) throw new Error(`cannot limit the narration under the true-peak ceiling (excess ${excess} dB)`);
    limitDb -= excess + 0.1;
  }
  const measured = `measured_I=${pass1.input_i}:measured_TP=${pass1.input_tp}:measured_LRA=${pass1.input_lra}:measured_thresh=${pass1.input_thresh}:offset=${pass1.target_offset}`;
  const pass2 = json(ffmpeg(["-y", "-i", limitedWav, "-af", `loudnorm=${target}:${measured}:linear=true:print_format=json,aresample=48000`, "-c:a", "pcm_f32le", normWav]));
  if (pass2.normalization_type !== "linear") throw new Error(`loudnorm fell back to ${pass2.normalization_type} normalization`);
  loud = { target: LOUDNESS, raw_mix: raw, limiter_ceiling_dbfs: r3(limitDb), pass1, pass2 };
}

// ---- video: crossfade the boards, overlay captions, mux ------------------------------------------

const mp4 = DRAFT ? join(OUT, "draft.mp4") : join(HERE, "bounded-mandate-pitch.mp4");
{
  const args = ["-y", "-loglevel", "error"];
  clips.forEach((c, k) => {
    const next = clips[k + 1];
    c.len = (next === undefined ? total : next.at + next.xf) - c.at;
    args.push("-loop", "1", "-framerate", String(FPS), "-t", c.len.toFixed(3), "-i", c.png);
  });
  const capBase = clips.length;
  for (const s of segments) args.push("-loop", "1", "-framerate", String(FPS), "-t", total.toFixed(3), "-i", s.capPng);
  const audioIdx = capBase + segments.length;
  if (!DRAFT) args.push("-i", normWav);
  const f = clips.map((_, k) => `[${k}:v]format=yuv444p,setsar=1[v${k}]`);
  let cur = "v0";
  clips.slice(1).forEach((c, j) => {
    const k = j + 1;
    f.push(`[${cur}][v${k}]xfade=transition=fade:duration=${c.xf}:offset=${c.at.toFixed(3)}[x${k}]`);
    cur = `x${k}`;
  });
  segments.forEach((s, j) => {
    f.push(`[${cur}][${capBase + j}:v]overlay=0:0:enable='between(t,${s.start.toFixed(3)},${s.end.toFixed(3)})'[c${j}]`);
    cur = `c${j}`;
  });
  f.push(`[${cur}]format=yuv420p[vout]`);
  args.push("-filter_complex", f.join(";"), "-map", "[vout]");
  if (!DRAFT) args.push("-map", `${audioIdx}:a`, "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-ac", "2");
  args.push("-c:v", "libx264", "-preset", "slow", "-crf", "18", "-profile:v", "high", "-pix_fmt", "yuv420p", "-r", String(FPS), "-g", String(FPS * 2), "-movflags", "+faststart", "-t", total.toFixed(3), mp4);
  ffmpeg(args);
}

// ---- captions files ------------------------------------------------------------------------------

const srt = segments.map((s, i) => `${i + 1}\n${stamp(s.start, ",")} --> ${stamp(s.end, ",")}\n${twoLines(s.caption)}\n`).join("\n");
const vtt = `WEBVTT\n\n${segments.map((s) => `${s.id}\n${stamp(s.start, ".")} --> ${stamp(s.end, ".")}\n${twoLines(s.caption)}\n`).join("\n")}`;
const srtPath = DRAFT ? join(OUT, "draft.srt") : join(HERE, "captions.srt");
const vttPath = DRAFT ? join(OUT, "draft.vtt") : join(HERE, "captions.vtt");
writeFileSync(srtPath, srt);
writeFileSync(vttPath, vtt);
const posterPath = DRAFT ? join(OUT, "poster-draft.png") : join(HERE, "poster.png");
copyFileSync(join(FRAMES, `${POSTER[0]}-${POSTER[1]}.png`), posterPath);

// ---- checks on the encoded file ------------------------------------------------------------------

const vDur = probeDuration(mp4, "v:0");
const checks = { duration: r3(probeDuration(mp4)), video_stream: r3(vDur) };
const fails = [];
if (checks.duration < 60 || checks.duration > 90) fails.push(`duration ${checks.duration} s is outside 60-90 s`);
if (!DRAFT) {
  const aDur = probeDuration(mp4, "a:0");
  checks.audio_stream = r3(aDur);
  checks.av_difference = r3(Math.abs(vDur - aDur));
  if (checks.av_difference >= 0.1) fails.push(`video and audio streams differ by ${checks.av_difference} s`);
  const eb = ffmpeg(["-nostats", "-i", mp4, "-map", "0:a", "-af", "ebur128=peak=true", "-f", "null", "-"]);
  const summary = eb.slice(eb.lastIndexOf("Summary:"));
  checks.integrated_lufs = Number(/I:\s+(-?[\d.]+) LUFS/.exec(summary)?.[1]);
  checks.loudness_range_lu = Number(/LRA:\s+(-?[\d.]+) LU/.exec(summary)?.[1]);
  checks.true_peak_dbtp = Number(/True peak:\s+Peak:\s+(-?[\d.]+) dBFS/.exec(summary)?.[1]);
  const vd = ffmpeg(["-i", mp4, "-map", "0:a", "-af", "volumedetect", "-f", "null", "-"]);
  checks.max_volume_db = Number(/max_volume: (-?[\d.]+) dB/.exec(vd)?.[1]);
  checks.mean_volume_db = Number(/mean_volume: (-?[\d.]+) dB/.exec(vd)?.[1]);
  if (!(checks.max_volume_db < 0)) fails.push(`max_volume ${checks.max_volume_db} dB`);
  if (!(checks.true_peak_dbtp <= -1.5)) fails.push(`true peak ${checks.true_peak_dbtp} dBTP is above -1.5`);
  if (!(Math.abs(checks.integrated_lufs - LOUDNESS.I) <= 1)) fails.push(`integrated loudness ${checks.integrated_lufs} LUFS is not within 1 LU of ${LOUDNESS.I}`);
  // Caption sync: each cue starts at its segment's placement; independently, the encoded audio must be silent just
  // before each cue (no speech of the segment before its caption) and speech must begin within 0.1 s after it.
  const sd = ffmpeg(["-i", mp4, "-map", "0:a", "-af", "silencedetect=noise=-45dB:d=0.1", "-f", "null", "-"]);
  const ends = [...sd.matchAll(/silence_end: ([\d.]+)/g)].map((m) => Number(m[1]));
  const cues = srt.split("\n\n").map((b) => b.split("\n")[1].split(" --> ")[0]);
  checks.caption_sync = segments.map((s, i) => {
    const [h, m, rest] = cues[i].split(":");
    const cueStart = Number(h) * 3600 + Number(m) * 60 + Number(rest.replace(",", "."));
    const onset = ends.filter((e) => e >= s.start - 0.1 && e <= s.start + 0.5).at(0);
    const row = { id: s.id, cue_start: r3(cueStart), audio_start: r3(s.start), cue_offset: r3(cueStart - s.start), speech_onset_after_cue: onset === undefined ? null : r3(onset - cueStart) };
    if (Math.abs(row.cue_offset) > 0.1) fails.push(`${s.id}: cue starts ${row.cue_offset} s from its audio`);
    if (row.speech_onset_after_cue === null || row.speech_onset_after_cue > 0.1 || row.speech_onset_after_cue < -0.1) fails.push(`${s.id}: speech onset ${row.speech_onset_after_cue} s from the cue`);
    return row;
  });
}

// Contact sheet and phone-size frames for review.
const sheet = join(OUT, DRAFT ? "draft-sheet.png" : "pitch-sheet.png");
const n = Math.ceil(checks.duration / 3);
ffmpeg(["-y", "-loglevel", "error", "-i", mp4, "-vf", `fps=1/3,scale=480:-1,tile=5x${Math.ceil(n / 5)}`, "-frames:v", "1", "-update", "1", sheet]);
for (const s of segments) {
  const t = (s.start + s.end) / 2 + 1;
  ffmpeg(["-y", "-loglevel", "error", "-ss", t.toFixed(2), "-i", mp4, "-vf", "scale=390:-1", "-frames:v", "1", "-update", "1", join(OUT, `phone-${s.id}.png`)]);
}

// ---- provenance ----------------------------------------------------------------------------------

const git = (args) => spawnSync("git", ["-C", ROOT, ...args], { encoding: "utf8" }).stdout.trim();
const prov = {
  generated: new Date().toISOString(),
  statement: STATEMENT,
  mode: DRAFT ? "draft (estimated durations, silent; not a deliverable)" : "final",
  command: `node presentation/pitch/build.mjs${DRAFT ? " --draft" : ""}`,
  source: { revision: git(["rev-parse", "HEAD"]), dirty: git(["status", "--porcelain"]) !== "" },
  tools: { ffmpeg: execFileSync(FFMPEG, ["-version"], { encoding: "utf8" }).split("\n")[0], chrome: chromeVersion, node: process.version },
  timing: { fps: FPS, lead_s: LEAD, gap_s: GAP, tail_s: TAIL, scene_crossfade_s: SCENE_XF, state_crossfade_s: STATE_XF, total_s: r3(total) },
  inputs: [
    fileInfo(narrationPath),
    ...segments.filter((s) => s.audio !== undefined).map((s) => ({ ...fileInfo(s.audio), duration_s: r3(s.duration) })),
    ...SCREENSHOTS.map((p) => fileInfo(join(ROOT, p))),
    { ...fileInfo(join(ROOT, MAINNET)), use: "receipt cards checked against it" },
    ...["build.mjs", "scenes/scenes.html", "scenes/theme.css", "scenes/scene.js", "scenes/caption.html"].map((p) => fileInfo(join(HERE, p))),
  ],
  segments: segments.map((s) => ({ id: s.id, start_s: r3(s.start), end_s: r3(s.end), duration_s: r3(s.duration), caption: s.caption })),
  scenes: clips.map((c) => ({ segment: c.segment, board: c.board, state: c.state, start_s: r3(c.at), crossfade_s: c.xf })),
  receipt_cards_checked: [...cardsChecked].sort(),
  loudnorm: loud,
  checks,
  outputs: [mp4, srtPath, vttPath, posterPath].map((p) => ({ ...fileInfo(p), ...(p === mp4 ? { duration_s: checks.duration } : {}) })),
};
writeFileSync(DRAFT ? join(OUT, "draft.json") : join(HERE, "pitch.json"), `${JSON.stringify(prov, null, 2)}\n`);

console.log(JSON.stringify({ mode: prov.mode, output: rel(mp4), checks, sheet: rel(sheet) }, null, 2));
if (fails.length > 0) {
  console.error(`checks failed:\n  ${fails.join("\n  ")}`);
  process.exit(1);
}
