//! Gate reports, envelope v2: `out/evidence/tests/<gate>.<case>.json` (gitignored).

use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;

pub const SCHEMA: &str = "bounded-mandate/gate-report/2";

/// WASM files under target/near this test process loaded, by file stem.
static LOADED_WASM: Mutex<BTreeMap<String, PathBuf>> = Mutex::new(BTreeMap::new());

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

/// Records that a built WASM was loaded, so its hash goes into every report of this process.
pub fn note_wasm(path: &Path) {
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    LOADED_WASM
        .lock()
        .expect("wasm registry")
        .insert(stem, path.to_path_buf());
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

pub fn sha256_file(path: &Path) -> Option<String> {
    std::fs::read(path)
        .ok()
        .map(|b| hex::encode(Sha256::digest(b)))
}

/// Writes one gate report. `passed` must be the outcome of the test's own assertions, computed
/// before writing. Never overwrites: a second report for the same case in one run goes to
/// `<gate>.<case>.duplicate-N.json` so acceptance flags it. Returns the path.
pub fn write(gate: &str, case: &str, passed: bool, mode: &str, data: Value) -> PathBuf {
    write_in(&evidence_dir(), gate, case, passed, mode, data)
}

/// Creates `<gate>.<case>.json` in `dir` atomically (`create_new`), falling back to
/// `<gate>.<case>.duplicate-N.json` (N = 2, 3, ...) when it already exists.
pub fn write_in(
    dir: &Path,
    gate: &str,
    case: &str,
    passed: bool,
    mode: &str,
    data: Value,
) -> PathBuf {
    use std::io::Write;
    assert!(
        mode == "sandbox" || mode == "unit-vm",
        "unknown report mode {mode}"
    );
    std::fs::create_dir_all(dir).expect("create evidence dir");
    let bytes = serde_json::to_vec_pretty(&envelope(gate, case, passed, mode, data)).expect("json");
    for n in 1u32.. {
        let name = if n == 1 {
            format!("{gate}.{case}.json")
        } else {
            format!("{gate}.{case}.duplicate-{n}.json")
        };
        let path = dir.join(name);
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
        {
            Ok(mut f) => {
                f.write_all(&bytes).expect("write evidence");
                return path;
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => panic!("create {}: {e}", path.display()),
        }
    }
    unreachable!("report name space exhausted")
}

fn envelope(gate: &str, case: &str, passed: bool, mode: &str, data: Value) -> Value {
    let root = repo_root();
    let wasm: Map<String, Value> = LOADED_WASM
        .lock()
        .expect("wasm registry")
        .iter()
        .map(|(stem, p)| (stem.clone(), json!(sha256_file(p))))
        .collect();
    json!({
        "schema": SCHEMA,
        "gate": gate,
        "case": case,
        "passed": passed,
        "mode": mode,
        "run_id": std::env::var("MANDATE_RUN_ID").ok(),
        "source": {
            "revision": git(&["rev-parse", "HEAD"]),
            "dirty": git(&["status", "--porcelain"]).map(|s| !s.is_empty()),
        },
        "spec_sha256": sha256_file(&root.join("SPEC.md")),
        "fixture_manifest_sha256": sha256_file(&root.join("fixtures").join("manifest.json")),
        "wasm_sha256": wasm,
        "command": portable_command(&root),
        "generated_at_unix": std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or_default(),
        "data": data,
    })
}

/// The invoking command with machine-local paths removed: an absolute argument inside the repository is
/// shown relative to it, any other absolute argument by its file name.
fn portable_command(root: &std::path::Path) -> String {
    let canonical = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    std::env::args()
        .map(|a| {
            let p = std::path::Path::new(&a);
            if !p.is_absolute() {
                return a.clone();
            }
            let resolved = p.canonicalize().unwrap_or_else(|_| p.to_path_buf());
            match resolved.strip_prefix(&canonical) {
                Ok(rel) => rel.display().to_string(),
                Err(_) => p
                    .file_name()
                    .map_or_else(|| a.clone(), |f| f.to_string_lossy().into_owned()),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}
