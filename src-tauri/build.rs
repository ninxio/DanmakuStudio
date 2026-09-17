fn main() {
    // Refresh the executable resources when application icons change.
    println!("cargo:rerun-if-changed=icons");
    tauri_build::build()
}
