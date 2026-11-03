//! Machine-readable gate summaries under `out/evidence/tests/<gate>.json` (gitignored).

use serde_json::{Value, json};
use std::path::PathBuf;
use std::process::Command;

/// Repository root; `MANDATE_REPO_ROOT` overrides it for out-of-tree harness runs.
pub fn repo_root() -> PathBuf {
    std::env::var_os("MANDATE_REPO_ROOT").map_or_else(
        || PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(".."),
        PathBuf::from,
    )
}

pub fn evidence_dir() -> PathBuf {
    repo_root().join("out").join("evidence").join("tests")
}

fn git(args: &[&str]) -> Option<String> {
    let out = Command::new("git")
        .args(args)
        .current_dir(repo_root())
        .output()
        .ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).trim().to_owned())
}

/// Writes `<gate>.json` (or `<gate>.<part>.json`) with provenance; `passed` is the assertion
/// outcome computed by the caller before writing. Returns the path.
pub fn write(gate: &str, part: Option<&str>, passed: bool, mode: &str, data: Value) -> PathBuf {
    let dir = evidence_dir();
    std::fs::create_dir_all(&dir).expect("create evidence dir");
    let name = match part {
        Some(p) => format!("{gate}.{p}.json"),
        None => format!("{gate}.json"),
    };
    let path = dir.join(name);
    let doc = json!({
        "gate": gate,
        "part": part,
        "passed": passed,
        "mode": mode,
        "source_revision": git(&["rev-parse", "HEAD"]),
        "dirty": git(&["status", "--porcelain"]).map(|s| !s.is_empty()),
        "test_binary": std::env::args().next(),
        "generated_at_unix": std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or_default(),
        "data": data,
    });
    std::fs::write(&path, serde_json::to_vec_pretty(&doc).expect("json")).expect("write evidence");
    path
}
