# Narration method

Generated 14 November 2026 from the spoken column of [narration.md](../narration.md), one WAV per segment (24 kHz, mono, 16-bit PCM).

- **Speech model:** Kokoro-82M (open weights, Apache-2.0), run locally through `kokoro-onnx` 0.x with `onnxruntime` 1.31.1 on CPU. Model files `kokoro-v1.0.onnx` and `voices-v1.0.bin` from the kokoro-onnx `model-files-v1.0` release. No API, credential or paid service.
- **Voice:** stock voice `af_heart`, American English (`lang="en-us"`), speed 1.0. No voice cloning.
- **Why not the earlier route:** Codex could not use the OpenAI speech API in this session because no credential was available to it, so it generated nothing.
- **Pronunciation check:** each segment was transcribed back with a local `faster-whisper` `small.en` model. "Near", "main net", "M P C" and "U S D C" came back as NEAR, main net, MPC and USDC. "Intents" came back as "intense", which is a common speech-recognition confusion for that word, not a mispronunciation found by listening. The spoken column writes "Near" and "main net" because the all-caps and one-word forms were read wrongly.
- **Revision:** s03, s04 and s13 were rewritten and regenerated after review (precise wording on what the agent's key can do, what stopping an agent does, and which command checks the chain); the other segments are unchanged.
- **Levels:** raw per-segment peaks from −7.0 to 0.0 dBFS; the pitch build normalizes the joined track (see `../pitch.json`).

| segment | seconds |
| --- | --- |
| s01-proof | 8.62 |
| s02-name | 6.23 |
| s03-problem | 6.06 |
| s04-agent | 5.27 |
| s05-contract | 8.68 |
| s06-verifier | 6.27 |
| s07-run | 9.22 |
| s08-revoke | 5.33 |
| s09-reject | 5.01 |
| s10-recover | 3.50 |
| s11-sandbox | 7.00 |
| s12-limits | 7.49 |
| s13-verify | 5.31 |
| **total speech** | **83.99** |
