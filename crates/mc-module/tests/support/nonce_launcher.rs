// Test-only launcher for the registration live suite, never shipped.
//
// The suite's daemon hands every module it starts a private registration
// channel. To run ck-mc the legacy way, where it dials the daemon and
// presents its launch nonce, this launcher runs the program named in
// NONCE_LAUNCH_PROGRAM as a child with the channel withheld: the channel's
// descriptor is closed and the variables naming it are removed, as under a
// daemon that offers no channel. The launch-nonce pipe and its variable pass
// through unchanged.
//
// The launcher stays alive as the supervised process, so the daemon's check of
// the configured program's image holds, and it exits when the module exits.
fn main() {
    use subc_os::registration_channel::{
        DAEMON_PID_ENV, REGISTRATION_FD_ENV, REGISTRATION_PIPE_ENV,
    };

    let program = std::env::var_os("NONCE_LAUNCH_PROGRAM").expect("module program to launch");
    #[cfg(unix)]
    if let Some(descriptor) = std::env::var(REGISTRATION_FD_ENV)
        .ok()
        .and_then(|metadata| metadata.split(':').next()?.parse::<i32>().ok())
    {
        use std::os::fd::FromRawFd;
        // SAFETY: the daemon placed its registration socket at this descriptor
        // for this process, and nothing else in this process uses it.
        drop(unsafe { std::os::fd::OwnedFd::from_raw_fd(descriptor) });
    }
    let status = std::process::Command::new(program)
        .args(std::env::args_os().skip(1))
        .env_remove(REGISTRATION_FD_ENV)
        .env_remove(REGISTRATION_PIPE_ENV)
        .env_remove(DAEMON_PID_ENV)
        .env_remove("NONCE_LAUNCH_PROGRAM")
        .status()
        .expect("start the module");
    std::process::exit(status.code().unwrap_or(1));
}
