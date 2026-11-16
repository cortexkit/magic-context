// Test-only nonce holder for the registration live suite, never shipped.
//
// The suite's daemon launches this program for each reserved module the test
// itself plays (the runner ck-mc calls back, and ck-bus). It hands the test
// the launch nonce the daemon gave it, through the file NONCE_OUT names, and
// then stays alive, so the daemon keeps that module's launch current while
// the test registers it with the nonce. One native image is kept alive
// because the daemon checks that the launched program is the configured one.
fn main() {
    let nonce = subc_os::launch_nonce()
        .expect("read the daemon's launch nonce")
        .expect("the daemon supplies a launch nonce");
    let path = std::path::PathBuf::from(std::env::var_os("NONCE_OUT").expect("nonce output path"));
    let temporary = path.with_extension("tmp");
    std::fs::write(&temporary, nonce.value()).expect("write the launch nonce");
    std::fs::rename(temporary, path).expect("publish the launch nonce");
    loop {
        std::thread::park();
    }
}
