// Test-only privacy trampoline for the registration live suite, never shipped.
//
// On macOS the daemon starts every module through a trampoline, so the
// system attributes a module's privacy requests to the module rather than to
// the process that launched it. The suite's in-process daemon starts its
// modules through this one. Other systems never run it.
fn main() {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    subc_os::privacy_identity::trampoline_main(&args);
    std::process::exit(2);
}
