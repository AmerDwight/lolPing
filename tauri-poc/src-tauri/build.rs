use std::path::PathBuf;

// The hook helper is embedded in the executable, so the portable build stays one file.
fn main() {
    let windows = std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows");
    let file = if windows { "hook-helper.exe" } else { "hook-helper" };
    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let path = std::env::var("LOLPING_POC_HELPER")
        .map(PathBuf::from)
        .unwrap_or_else(|_| manifest.join("../../native/hook-helper/build").join(file));
    let path = path
        .canonicalize()
        .unwrap_or_else(|_| panic!("no hook helper at {}: run `npm run build:helper` first", path.display()));
    println!("cargo:rustc-env=LOLPING_POC_HELPER={}", path.display());
    println!("cargo:rerun-if-changed={}", path.display());
    println!("cargo:rerun-if-env-changed=LOLPING_POC_HELPER");
    tauri_build::build()
}
