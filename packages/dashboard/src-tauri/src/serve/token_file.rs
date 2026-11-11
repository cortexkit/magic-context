//! Optional stable bearer token for serve mode.
//!
//! By default every `--serve` process generates a fresh random token. A user who
//! wants a bookmarkable URL can create `dashboard-token` in the Magic Context
//! storage directory themselves. The file is honoured only when it is opened
//! without following a symlink, is a regular file, is owner-only (Unix: owned
//! by the current user with mode exactly `0600` and no access-control entry that
//! grants another user; Windows: owned by a trusted principal — the current
//! user, SYSTEM or Administrators, because an elevated shell creates the file
//! under one of those — and with access granted to no one but those three), and
//! its trimmed contents are a URL-safe token of `MIN_TOKEN_LEN..=MAX_TOKEN_LEN`
//! characters. Anything else is ignored with a warning that names the failed
//! check and never the contents, and the process keeps the random token.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

pub const TOKEN_FILE_NAME: &str = "dashboard-token";
pub const MIN_TOKEN_LEN: usize = 32;
pub const MAX_TOKEN_LEN: usize = 512;

#[derive(PartialEq, Eq)]
pub enum TokenFile {
    /// No file at the path: keep today's per-process random token.
    Missing,
    /// The file passed every check.
    Loaded(String),
    /// The file exists but was refused; the reason is safe to print.
    Rejected(&'static str),
}

/// Hand-written so a `dbg!`, a debug log or a failed `assert_eq!` can never
/// print the token; the other variants carry nothing secret.
impl std::fmt::Debug for TokenFile {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TokenFile::Missing => f.write_str("Missing"),
            TokenFile::Loaded(_) => f.write_str("Loaded(<redacted>)"),
            TokenFile::Rejected(reason) => f.debug_tuple("Rejected").field(reason).finish(),
        }
    }
}

/// `dashboard-token` in the storage directory the plugin uses on every platform,
/// resolved in the plugin's order (packages/plugin/src/shared/data-path.ts):
/// `MAGIC_CONTEXT_STORAGE_DIR`, then `<XDG_DATA_HOME>/cortexkit/magic-context`,
/// then `~/.local/share/cortexkit/magic-context`. Blank values count as unset,
/// matching the plugin's trim and the shell's `${XDG_DATA_HOME:-...}`. `None`
/// when no absolute path can be formed (including a relative
/// `MAGIC_CONTEXT_STORAGE_DIR`, which the plugin refuses too), so the token is
/// never read relative to the working directory.
pub fn default_token_path() -> Option<PathBuf> {
    token_path_from(
        std::env::var_os("MAGIC_CONTEXT_STORAGE_DIR"),
        std::env::var_os("XDG_DATA_HOME"),
        dirs::home_dir(),
    )
}

/// Why `default_token_path` produced no path, when a variable the user set is
/// the reason. Serve mode prints this, so an override that cannot name an
/// absolute directory explains itself instead of silently dropping a token file
/// the user just created.
pub fn default_token_path_warning() -> Option<&'static str> {
    warning_from(
        std::env::var_os("MAGIC_CONTEXT_STORAGE_DIR"),
        std::env::var_os("XDG_DATA_HOME"),
        dirs::home_dir(),
    )
}

fn warning_from(
    storage_dir: Option<OsString>,
    xdg_data_home: Option<OsString>,
    home: Option<PathBuf>,
) -> Option<&'static str> {
    if token_path_from(storage_dir.clone(), xdg_data_home.clone(), home).is_some() {
        return None;
    }
    if storage_dir.and_then(non_blank).is_some() {
        return Some("ignoring MAGIC_CONTEXT_STORAGE_DIR because it is not an absolute path");
    }
    if xdg_data_home.and_then(non_blank).is_some() {
        return Some("ignoring XDG_DATA_HOME because it is not an absolute path");
    }
    None
}

fn non_blank(value: OsString) -> Option<PathBuf> {
    match value.to_str() {
        Some(text) => Some(text.trim())
            .filter(|t| !t.is_empty())
            .map(PathBuf::from),
        None => Some(PathBuf::from(value)),
    }
}

fn token_path_from(
    storage_dir: Option<OsString>,
    xdg_data_home: Option<OsString>,
    home: Option<PathBuf>,
) -> Option<PathBuf> {
    let dir = match storage_dir.and_then(non_blank) {
        Some(explicit) => explicit,
        None => xdg_data_home
            .and_then(non_blank)
            .or_else(|| home.map(|home| home.join(".local").join("share")))?
            .join("cortexkit")
            .join("magic-context"),
    };
    let path = dir.join(TOKEN_FILE_NAME);
    path.is_absolute().then_some(path)
}

pub fn read_token_file(path: &Path) -> TokenFile {
    match read_raw(path) {
        Ok(None) => TokenFile::Missing,
        Ok(Some(bytes)) => match validate_contents(&bytes) {
            Ok(token) => TokenFile::Loaded(token),
            Err(reason) => TokenFile::Rejected(reason),
        },
        Err(reason) => TokenFile::Rejected(reason),
    }
}

fn validate_contents(bytes: &[u8]) -> Result<String, &'static str> {
    let text = std::str::from_utf8(bytes).map_err(|_| "it is not valid UTF-8")?;
    // Windows editors may save UTF-8 with a byte-order mark.
    let token = text.strip_prefix('\u{feff}').unwrap_or(text).trim();
    if token.is_empty() {
        return Err("it is empty");
    }
    // Unreserved URL characters only: the token travels in the `#token=` fragment
    // (decoded with decodeURIComponent and split on `&`) and in a Bearer header.
    if !token
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~'))
    {
        return Err("it may only contain letters, digits, '-', '.', '_' and '~'");
    }
    if token.len() < MIN_TOKEN_LEN {
        return Err("it must be at least 32 characters long");
    }
    if token.len() > MAX_TOKEN_LEN {
        return Err("it must be at most 512 characters long");
    }
    Ok(token.to_string())
}

/// Reads at most this many bytes, so a huge or endless file cannot stall startup.
#[cfg(any(unix, windows))]
const READ_LIMIT: u64 = 4096;

/// Reads the already-validated handle, never the path again, so the checks and
/// the read are on the same file.
#[cfg(any(unix, windows))]
fn read_limited(file: std::fs::File) -> Result<Option<Vec<u8>>, &'static str> {
    use std::io::Read;
    let mut bytes = Vec::new();
    file.take(READ_LIMIT + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "it could not be read")?;
    if bytes.len() as u64 > READ_LIMIT {
        return Err("it is larger than 4 KiB");
    }
    Ok(Some(bytes))
}

#[cfg(unix)]
fn read_raw(path: &Path) -> Result<Option<Vec<u8>>, &'static str> {
    use std::fs::OpenOptions;
    use std::io::ErrorKind;
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt};

    let file = match OpenOptions::new()
        .read(true)
        // O_NOFOLLOW refuses a symlink at the final component; O_NONBLOCK keeps a
        // FIFO planted at the path from blocking startup before the type check.
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
    {
        Ok(file) => file,
        Err(err) if err.kind() == ErrorKind::NotFound => return Ok(None),
        Err(err) if err.raw_os_error() == Some(libc::ELOOP) => {
            return Err("it is a symlink");
        }
        Err(_) => return Err("it could not be opened"),
    };
    let metadata = file.metadata().map_err(|_| "it could not be inspected")?;
    if !metadata.file_type().is_file() {
        return Err("it is not a regular file");
    }
    // SAFETY: geteuid has no preconditions and cannot fail.
    if metadata.uid() != unsafe { libc::geteuid() } {
        return Err("it is not owned by the current user");
    }
    if metadata.mode() & 0o777 != 0o600 {
        return Err("it must have owner-only permissions (0600)");
    }
    // On macOS an access-control entry grants access without changing the mode
    // bits, so `0600` alone does not mean owner-only (see `macos_acl`).
    #[cfg(target_os = "macos")]
    macos_acl::check_owner_only(&file)?;
    read_limited(file)
}

/// Windows has no mode bits; the equivalent guarantee comes from the file's
/// security descriptor, read from the open handle (see `windows_acl`).
#[cfg(windows)]
fn read_raw(path: &Path) -> Result<Option<Vec<u8>>, &'static str> {
    use std::fs::OpenOptions;
    use std::io::ErrorKind;
    use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
    use windows_sys::Win32::Foundation::ERROR_ACCESS_DENIED;
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_OPEN_REPARSE_POINT, FILE_READ_ATTRIBUTES,
        FILE_READ_DATA, READ_CONTROL,
    };

    let file = match OpenOptions::new()
        // Only what the checks need: FILE_READ_DATA for the contents,
        // FILE_READ_ATTRIBUTES for std's metadata(), READ_CONTROL for
        // GetSecurityInfo below. CreateFileW still adds SYNCHRONIZE for a
        // synchronous handle, so an entry that denies it (`deny write` does)
        // refuses the open; that is reported as access denied, never trusted.
        .access_mode(FILE_READ_DATA | FILE_READ_ATTRIBUTES | READ_CONTROL)
        // Opens a symlink or junction itself instead of its target.
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
    {
        Ok(file) => file,
        Err(err) if err.kind() == ErrorKind::NotFound => return Ok(None),
        // Without backup semantics a directory cannot be opened; name it anyway.
        Err(_) if std::fs::symlink_metadata(path).is_ok_and(|m| m.is_dir()) => {
            return Err("it is not a regular file");
        }
        Err(err) if err.raw_os_error() == Some(ERROR_ACCESS_DENIED as i32) => {
            return Err("access to it was denied");
        }
        Err(_) => return Err("it could not be opened"),
    };
    let metadata = file.metadata().map_err(|_| "it could not be inspected")?;
    if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err("it is a symlink or other reparse point");
    }
    if !metadata.is_file() {
        return Err("it is not a regular file");
    }
    windows_acl::check_owner_only(&file)?;
    read_limited(file)
}

#[cfg(not(any(unix, windows)))]
fn read_raw(path: &Path) -> Result<Option<Vec<u8>>, &'static str> {
    // No owner-only check is implemented here, so the file is refused rather
    // than trusted.
    match std::fs::symlink_metadata(path) {
        Ok(_) => Err("owner-only permissions cannot be verified on this platform"),
        Err(_) => Ok(None),
    }
}

/// The Windows rule for "owner-only": the file's owner is the current user (or
/// SYSTEM / Administrators, which is what an elevated process assigns), the
/// DACL exists, and every ACE that grants anything grants it to the current
/// user, SYSTEM or BUILTIN\Administrators. Deny ACEs only take access away and
/// inherit-only ACEs do not apply to a file, so both are skipped; any other ACE
/// type (callback, object, conditional) is refused because it cannot be judged
/// here. A file created normally under the user profile inherits exactly this
/// shape (user, SYSTEM, Administrators).
#[cfg(windows)]
mod windows_acl {
    use std::ffi::c_void;
    use std::os::windows::io::AsRawHandle;
    use std::ptr::null_mut;
    use windows_sys::Win32::Foundation::{CloseHandle, LocalFree, ERROR_SUCCESS, HANDLE};
    use windows_sys::Win32::Security::Authorization::{GetSecurityInfo, SE_FILE_OBJECT};
    use windows_sys::Win32::Security::{
        AclSizeInformation, EqualSid, GetAce, GetAclInformation, GetTokenInformation,
        IsWellKnownSid, TokenUser, WinBuiltinAdministratorsSid, WinLocalSystemSid,
        ACCESS_ALLOWED_ACE, ACE_HEADER, ACL, ACL_SIZE_INFORMATION, DACL_SECURITY_INFORMATION,
        INHERIT_ONLY_ACE, OWNER_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, PSID, TOKEN_QUERY,
        TOKEN_USER,
    };
    use windows_sys::Win32::System::SystemServices::{
        ACCESS_ALLOWED_ACE_TYPE, ACCESS_DENIED_ACE_TYPE,
    };
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    pub(super) const NOT_OWNER: &str = "it is not owned by the current user";
    pub(super) const NULL_DACL: &str = "it has no access list, so every user can read it";
    pub(super) const OTHER_USERS: &str =
        "other users can access it (only you, SYSTEM and Administrators may)";
    pub(super) const UNKNOWN_ACE: &str = "its access list has entries that cannot be verified";
    const UNREADABLE: &str = "its access list could not be read";

    /// Frees a security descriptor returned by GetSecurityInfo.
    struct LocalBox(PSECURITY_DESCRIPTOR);
    impl Drop for LocalBox {
        fn drop(&mut self) {
            // SAFETY: the pointer came from GetSecurityInfo, which documents
            // LocalFree as its release function; it is freed exactly once.
            unsafe { LocalFree(self.0 as _) };
        }
    }

    pub(super) fn check_owner_only(file: &std::fs::File) -> Result<(), &'static str> {
        let mut owner: PSID = null_mut();
        let mut dacl: *mut ACL = null_mut();
        let mut descriptor: PSECURITY_DESCRIPTOR = null_mut();
        // SAFETY: the handle is open with READ_CONTROL for the duration of the
        // call, and every out pointer refers to a live local.
        let status = unsafe {
            GetSecurityInfo(
                file.as_raw_handle() as HANDLE,
                SE_FILE_OBJECT,
                OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
                &mut owner,
                null_mut(),
                &mut dacl,
                null_mut(),
                &mut descriptor,
            )
        };
        if status != ERROR_SUCCESS {
            return Err(UNREADABLE);
        }
        // `owner` and `dacl` point into `descriptor`, which lives until here.
        let _descriptor = LocalBox(descriptor);
        let user = current_user()?;
        // SAFETY: owner/dacl point into the live descriptor; user.sid() points
        // into the live token buffer.
        unsafe { evaluate(owner, dacl, user.sid()) }
    }

    /// The TOKEN_USER of this process, kept in a u64 buffer for alignment.
    struct CurrentUser(Vec<u64>);
    impl CurrentUser {
        fn sid(&self) -> PSID {
            // SAFETY: the buffer was filled by GetTokenInformation(TokenUser).
            unsafe { (*(self.0.as_ptr() as *const TOKEN_USER)).User.Sid }
        }
    }

    fn current_user() -> Result<CurrentUser, &'static str> {
        // SAFETY: standard token query; the handle is closed on every path and
        // the buffer is sized by the first call.
        unsafe {
            let mut token: HANDLE = null_mut();
            if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
                return Err(UNREADABLE);
            }
            let mut len = 0u32;
            GetTokenInformation(token, TokenUser, null_mut(), 0, &mut len);
            let mut buffer = vec![0u64; (len as usize).div_ceil(8).max(1)];
            let ok = GetTokenInformation(
                token,
                TokenUser,
                buffer.as_mut_ptr() as *mut c_void,
                (buffer.len() * 8) as u32,
                &mut len,
            );
            CloseHandle(token);
            if ok == 0 {
                return Err(UNREADABLE);
            }
            Ok(CurrentUser(buffer))
        }
    }

    unsafe fn trusted(sid: PSID, user: PSID) -> bool {
        EqualSid(sid, user) != 0
            || IsWellKnownSid(sid, WinLocalSystemSid) != 0
            || IsWellKnownSid(sid, WinBuiltinAdministratorsSid) != 0
    }

    unsafe fn evaluate(owner: PSID, dacl: *mut ACL, user: PSID) -> Result<(), &'static str> {
        if owner.is_null() || !trusted(owner, user) {
            return Err(NOT_OWNER);
        }
        if dacl.is_null() {
            return Err(NULL_DACL);
        }
        let mut info: ACL_SIZE_INFORMATION = std::mem::zeroed();
        if GetAclInformation(
            dacl,
            &mut info as *mut ACL_SIZE_INFORMATION as *mut c_void,
            std::mem::size_of::<ACL_SIZE_INFORMATION>() as u32,
            AclSizeInformation,
        ) == 0
        {
            return Err(UNREADABLE);
        }
        for index in 0..info.AceCount {
            let mut ace: *mut c_void = null_mut();
            if GetAce(dacl, index, &mut ace) == 0 || ace.is_null() {
                return Err(UNREADABLE);
            }
            let header = &*(ace as *const ACE_HEADER);
            if u32::from(header.AceFlags) & INHERIT_ONLY_ACE != 0 {
                continue;
            }
            match u32::from(header.AceType) {
                ACCESS_DENIED_ACE_TYPE => {}
                ACCESS_ALLOWED_ACE_TYPE => {
                    let allowed = ace as *const ACCESS_ALLOWED_ACE;
                    // The SID runs past the 4-byte SidStart field, so derive the
                    // pointer from the ACE itself rather than from a reference.
                    let sid = std::ptr::addr_of!((*allowed).SidStart) as PSID;
                    if (*allowed).Mask != 0 && !trusted(sid, user) {
                        return Err(OTHER_USERS);
                    }
                }
                _ => return Err(UNKNOWN_ACE),
            }
        }
        Ok(())
    }
}

/// The macOS rule for "owner-only". macOS keeps access-control entries outside
/// the mode bits, so a file with mode `0600` can still grant another local user
/// read access:
///
/// ```text
/// $ chmod 600 token && chmod +a "user:nobody allow read" token
/// $ stat -f %Sp token   ->  -rw-------
/// $ ls -le token        ->  0: user:nobody allow read
/// ```
///
/// Every entry on the file is therefore inspected through the same open handle:
/// a deny entry is skipped (it only takes access away), as is an inherit-only
/// entry (a template for children that does not apply to the file), and every
/// remaining allow entry must name the current user. Anything else—including a
/// group entry, which cannot be proven to exclude other members—is refused,
/// and an unknown entry type is refused because it cannot be judged here.
#[cfg(target_os = "macos")]
mod macos_acl {
    use std::ffi::{c_int, c_void};
    use std::fs::File;
    use std::io::ErrorKind;
    use std::os::unix::io::AsRawFd;
    use std::ptr;

    pub(super) const OTHER_USERS: &str = "other users can reach it through its access-control list";
    pub(super) const UNKNOWN_ACE: &str =
        "its access-control list has entries that cannot be verified";
    const UNREADABLE: &str = "its access-control list could not be read";
    /// Refuses an ACL that never ends rather than spinning on a broken libc.
    const MAX_ENTRIES: usize = 1 << 16;

    // From <sys/acl.h>. `libc` exposes none of these on Apple targets.
    const ACL_TYPE_EXTENDED: c_int = 0x0000_0100;
    const ACL_FIRST_ENTRY: c_int = 0;
    const ACL_NEXT_ENTRY: c_int = -1;
    const ACL_EXTENDED_ALLOW: c_int = 1;
    const ACL_EXTENDED_DENY: c_int = 2;
    const ACL_ENTRY_ONLY_INHERIT: c_int = 1 << 8;
    const UUID_LEN: usize = 16;

    /// Opaque `struct _acl_permset` / `_acl_flagset` handles.
    #[repr(C)]
    struct Flagset {
        _private: [u8; 0],
    }

    extern "C" {
        fn acl_get_fd_np(fd: c_int, acl_type: c_int) -> *mut c_void;
        fn acl_get_entry(acl: *mut c_void, entry_id: c_int, entry_p: *mut *mut c_void) -> c_int;
        fn acl_get_tag_type(entry_d: *mut c_void, tag_type_p: *mut c_int) -> c_int;
        fn acl_get_flagset_np(obj_p: *mut c_void, flagset_p: *mut *mut Flagset) -> c_int;
        fn acl_get_flag_np(flagset_d: *mut Flagset, flag: c_int) -> c_int;
        fn acl_get_qualifier(entry_d: *mut c_void) -> *mut c_void;
        fn acl_free(obj_p: *mut c_void) -> c_int;
        fn acl_size(acl: *mut c_void) -> isize;
        fn mbr_uid_to_uuid(uid: libc::uid_t, uu: *mut u8) -> c_int;
    }

    /// Frees an ACL returned by `acl_get_fd_np`.
    struct AclBox(*mut c_void);
    impl Drop for AclBox {
        fn drop(&mut self) {
            // SAFETY: the pointer came from acl_get_fd_np and is freed once.
            unsafe { acl_free(self.0) };
        }
    }

    pub(super) fn check_owner_only(file: &File) -> Result<(), &'static str> {
        let me = current_user_uuid()?;
        // SAFETY: `errno` is thread-local and writable; clearing it first means a
        // NULL return that failed to set it cannot be misread as "no ACL" below.
        unsafe { *libc::__error() = 0 };
        // SAFETY: the file handle stays open for the whole call.
        let acl = unsafe { acl_get_fd_np(file.as_raw_fd(), ACL_TYPE_EXTENDED) };
        if acl.is_null() {
            // Ordinary case: no extended ACL at all, so the mode bits checked
            // by the caller are the whole story. Anything else -- including a
            // failure that left errno untouched -- is unreadable.
            return match std::io::Error::last_os_error().kind() {
                ErrorKind::NotFound => Ok(()),
                _ => Err(UNREADABLE),
            };
        }
        let acl = AclBox(acl);
        let mut entry: *mut c_void = ptr::null_mut();
        // SAFETY: `acl` is live and `entry` receives an entry owned by it.
        let mut status = unsafe { acl_get_entry(acl.0, ACL_FIRST_ENTRY, &mut entry) };
        let mut seen = 0usize;
        // Darwin returns 0 per entry and -1 once the list is exhausted; a
        // negative status is how it reports both that and a real failure.
        while status == 0 {
            if seen >= MAX_ENTRIES || entry.is_null() {
                return Err(UNREADABLE);
            }
            // SAFETY: `entry` belongs to the live ACL and is only read here.
            if unsafe { grants_another_user(entry, &me) }? {
                return Err(OTHER_USERS);
            }
            seen += 1;
            entry = ptr::null_mut();
            // SAFETY: as above.
            status = unsafe { acl_get_entry(acl.0, ACL_NEXT_ENTRY, &mut entry) };
        }
        // The walk ends with -1 and EINVAL whether the list is exhausted or the
        // call failed, so the end alone proves nothing. Reconcile the count
        // against acl_size(), which reports KAUTH_FILESEC_SIZE(entry count)
        // from <sys/kauth.h>; a walk that stopped early is refused.
        // SAFETY: `acl` is live.
        let size = unsafe { acl_size(acl.0) };
        if status != -1 || entry_count(size) != Some(seen) {
            return Err(UNREADABLE);
        }
        Ok(())
    }

    /// KAUTH_FILESEC_COUNT: a filesec header (magic, owner and group guids,
    /// entry count, flags) followed by fixed-size entries (guid, flags, rights).
    pub(super) fn entry_count(size: isize) -> Option<usize> {
        const HEADER: usize = 4 + UUID_LEN + UUID_LEN + 4 + 4;
        const ENTRY: usize = UUID_LEN + 4 + 4;
        let body = usize::try_from(size).ok()?.checked_sub(HEADER)?;
        (body % ENTRY == 0).then_some(body / ENTRY)
    }

    /// Whether one ACL entry lets somebody other than the current user in.
    ///
    /// # Safety
    /// `entry` must be an entry of a live ACL.
    unsafe fn grants_another_user(
        entry: *mut c_void,
        me: &[u8; UUID_LEN],
    ) -> Result<bool, &'static str> {
        let mut tag: c_int = 0;
        if acl_get_tag_type(entry, &mut tag) != 0 {
            return Err(UNREADABLE);
        }
        match tag {
            // Only takes access away, so it cannot grant anybody anything.
            ACL_EXTENDED_DENY => Ok(false),
            ACL_EXTENDED_ALLOW => {
                let mut flags: *mut Flagset = ptr::null_mut();
                if acl_get_flagset_np(entry, &mut flags) != 0 || flags.is_null() {
                    return Err(UNREADABLE);
                }
                // A template for children; it does not apply to this file. A
                // negative answer is an error, not "not set", and is refused.
                match acl_get_flag_np(flags, ACL_ENTRY_ONLY_INHERIT) {
                    1 => return Ok(false),
                    0 => {}
                    _ => return Err(UNREADABLE),
                }
                let qualifier = acl_get_qualifier(entry);
                if qualifier.is_null() {
                    return Err(UNREADABLE);
                }
                // The qualifier of an extended entry is a 16-byte uuid, not a uid.
                let mut uuid = [0u8; UUID_LEN];
                uuid.copy_from_slice(std::slice::from_raw_parts(qualifier as *const u8, UUID_LEN));
                acl_free(qualifier);
                Ok(uuid != *me)
            }
            _ => Err(UNKNOWN_ACE),
        }
    }

    /// The uuid macOS uses for this user in an extended ACL entry.
    fn current_user_uuid() -> Result<[u8; UUID_LEN], &'static str> {
        let mut uuid = [0u8; UUID_LEN];
        // SAFETY: geteuid cannot fail; `uuid` is a 16-byte buffer as required.
        let status = unsafe { mbr_uid_to_uuid(libc::geteuid(), uuid.as_mut_ptr()) };
        if status != 0 {
            return Err(UNREADABLE);
        }
        Ok(uuid)
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use tempfile::tempdir;

    const GOOD: &str = "Abcdefghijklmnopqrstuvwxyz0123456789-._~";

    fn write_with_mode(path: &Path, contents: &[u8], mode: u32) {
        // Remove first: a previous case may have left the file read-only.
        let _ = fs::remove_file(path);
        fs::write(path, contents).unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(mode)).unwrap();
    }

    #[test]
    fn missing_file_keeps_random_token() {
        let dir = tempdir().unwrap();
        assert_eq!(
            read_token_file(&dir.path().join(TOKEN_FILE_NAME)),
            TokenFile::Missing
        );
    }

    #[test]
    fn owner_only_file_is_loaded_and_trimmed() {
        let dir = tempdir().unwrap();
        let path = dir.path().join(TOKEN_FILE_NAME);
        write_with_mode(&path, format!("  {GOOD}\n").as_bytes(), 0o600);
        assert_eq!(read_token_file(&path), TokenFile::Loaded(GOOD.to_string()));
    }

    #[test]
    fn group_or_world_readable_file_is_refused() {
        let dir = tempdir().unwrap();
        let path = dir.path().join(TOKEN_FILE_NAME);
        for mode in [0o640, 0o644, 0o604, 0o400, 0o700] {
            write_with_mode(&path, GOOD.as_bytes(), mode);
            assert_eq!(
                read_token_file(&path),
                TokenFile::Rejected("it must have owner-only permissions (0600)"),
                "mode {mode:o}"
            );
        }
    }

    #[test]
    fn symlink_is_refused_even_to_an_owner_only_target() {
        let dir = tempdir().unwrap();
        let target = dir.path().join("real-token");
        write_with_mode(&target, GOOD.as_bytes(), 0o600);
        let link = dir.path().join(TOKEN_FILE_NAME);
        std::os::unix::fs::symlink(&target, &link).unwrap();
        assert_eq!(
            read_token_file(&link),
            TokenFile::Rejected("it is a symlink")
        );
    }

    #[test]
    fn directory_is_refused() {
        let dir = tempdir().unwrap();
        let path = dir.path().join(TOKEN_FILE_NAME);
        fs::create_dir(&path).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(
            read_token_file(&path),
            TokenFile::Rejected("it is not a regular file")
        );
    }

    #[test]
    fn fifo_is_refused_without_blocking() {
        let dir = tempdir().unwrap();
        let path = dir.path().join(TOKEN_FILE_NAME);
        let c_path = std::ffi::CString::new(path.as_os_str().as_encoded_bytes()).unwrap();
        // SAFETY: c_path is a valid NUL-terminated path for the duration of the call.
        assert_eq!(unsafe { libc::mkfifo(c_path.as_ptr(), 0o600) }, 0);
        assert_eq!(
            read_token_file(&path),
            TokenFile::Rejected("it is not a regular file")
        );
    }

    #[test]
    fn short_empty_or_oversized_contents_are_refused() {
        let dir = tempdir().unwrap();
        let path = dir.path().join(TOKEN_FILE_NAME);
        let cases: [(Vec<u8>, &str); 5] = [
            (b"\n  \n".to_vec(), "it is empty"),
            (
                vec![b'a'; MIN_TOKEN_LEN - 1],
                "it must be at least 32 characters long",
            ),
            (
                vec![b'a'; MAX_TOKEN_LEN + 1],
                "it must be at most 512 characters long",
            ),
            (
                vec![b'a'; READ_LIMIT as usize + 1],
                "it is larger than 4 KiB",
            ),
            (vec![0xff; MIN_TOKEN_LEN], "it is not valid UTF-8"),
        ];
        for (contents, reason) in cases {
            write_with_mode(&path, &contents, 0o600);
            assert_eq!(read_token_file(&path), TokenFile::Rejected(reason));
        }
    }

    #[test]
    fn characters_that_break_the_url_fragment_are_refused() {
        let dir = tempdir().unwrap();
        let path = dir.path().join(TOKEN_FILE_NAME);
        for bad in ["&", "%", "#", "=", " ", "+", "/", "é"] {
            let token = format!("{}{bad}{}", "a".repeat(20), "b".repeat(20));
            write_with_mode(&path, token.as_bytes(), 0o600);
            assert_eq!(
                read_token_file(&path),
                TokenFile::Rejected("it may only contain letters, digits, '-', '.', '_' and '~'"),
                "char {bad:?}"
            );
        }
    }

    #[test]
    fn exact_length_bounds_are_accepted() {
        let dir = tempdir().unwrap();
        let path = dir.path().join(TOKEN_FILE_NAME);
        for len in [MIN_TOKEN_LEN, MAX_TOKEN_LEN] {
            let token = "x".repeat(len);
            write_with_mode(&path, token.as_bytes(), 0o600);
            assert_eq!(read_token_file(&path), TokenFile::Loaded(token));
        }
    }
}

/// macOS keeps access-control entries outside the mode bits, so these cases are
/// the ones `0600` alone lets through. Each one is built with `chmod +a` on a
/// copy of a file that already passed every other check.
#[cfg(all(test, target_os = "macos"))]
mod macos_acl_tests {
    use super::*;
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use std::process::Command;
    use tempfile::tempdir;

    const GOOD: &str = "Abcdefghijklmnopqrstuvwxyz0123456789-._~";

    fn write_0600(dir: &Path) -> PathBuf {
        let path = dir.join(TOKEN_FILE_NAME);
        let _ = fs::remove_file(&path);
        fs::write(&path, GOOD.as_bytes()).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        path
    }

    /// Adds one access-control entry. Fails the test (rather than silently
    /// passing) when the entry could not be created, since then the case would
    /// be exercising nothing.
    fn add_entry(path: &Path, entry: &str) {
        let out = Command::new("chmod")
            .arg("+a")
            .arg(entry)
            .arg(path)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "chmod +a {entry:?} failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        // Guard against the entry being rejected by chmod in some other way.
        // `-d` so a directory's own entry is listed instead of its contents.
        let listing = Command::new("ls").arg("-led").arg(path).output().unwrap();
        let listing = String::from_utf8_lossy(&listing.stdout).into_owned();
        assert!(
            listing.contains("user:") || listing.contains("group:"),
            "no entry was added to {path:?}:\n{listing}"
        );
    }

    fn current_user() -> String {
        // SAFETY: getpwuid returns a pointer into a static buffer or null.
        let name = unsafe {
            let pw = libc::getpwuid(libc::geteuid());
            if pw.is_null() {
                None
            } else {
                std::ffi::CStr::from_ptr((*pw).pw_name)
                    .to_str()
                    .ok()
                    .map(str::to_owned)
            }
        };
        name.expect("the current user has no name")
    }

    #[test]
    fn file_without_extended_acl_is_loaded() {
        let dir = tempdir().unwrap();
        let path = write_0600(dir.path());
        assert_eq!(read_token_file(&path), TokenFile::Loaded(GOOD.to_string()));
    }

    #[test]
    fn entry_granting_another_user_is_refused() {
        let dir = tempdir().unwrap();
        let path = write_0600(dir.path());
        // Mode stays 0600, so the check this test is about is reached.
        add_entry(&path, "user:nobody allow read");
        assert_eq!(
            read_token_file(&path),
            TokenFile::Rejected("other users can reach it through its access-control list")
        );
    }

    #[test]
    fn group_entry_is_refused() {
        let dir = tempdir().unwrap();
        let path = write_0600(dir.path());
        // `wheel` is a group the current user is not in, so this entry names
        // other users; a group entry cannot prove it names only the owner.
        add_entry(&path, "group:wheel allow read");
        assert_eq!(
            read_token_file(&path),
            TokenFile::Rejected("other users can reach it through its access-control list")
        );
    }

    #[test]
    fn inherit_only_entry_does_not_count() {
        let dir = tempdir().unwrap();
        let path = write_0600(dir.path());
        // A template for children; it grants nothing on this file.
        add_entry(&path, "user:nobody allow read,only_inherit");
        assert_eq!(read_token_file(&path), TokenFile::Loaded(GOOD.to_string()));
    }

    #[test]
    fn deny_entry_does_not_count() {
        let dir = tempdir().unwrap();
        let path = write_0600(dir.path());
        // Deny only removes access, so it cannot be the reason to refuse.
        add_entry(&path, "user:root deny read");
        assert_eq!(read_token_file(&path), TokenFile::Loaded(GOOD.to_string()));
    }

    #[test]
    fn entry_naming_the_current_user_is_accepted() {
        let dir = tempdir().unwrap();
        let path = write_0600(dir.path());
        add_entry(&path, &format!("user:{} allow read", current_user()));
        assert_eq!(read_token_file(&path), TokenFile::Loaded(GOOD.to_string()));
    }

    #[test]
    fn several_harmless_entries_are_all_walked() {
        let dir = tempdir().unwrap();
        let path = write_0600(dir.path());
        // The end of the list and a failed walk look alike, so the count is
        // reconciled against acl_size(): a walk that stops early is refused.
        for user in ["root", "daemon", "nobody"] {
            add_entry(&path, &format!("user:{user} deny read"));
        }
        add_entry(&path, &format!("user:{} allow read", current_user()));
        assert_eq!(read_token_file(&path), TokenFile::Loaded(GOOD.to_string()));
    }

    #[test]
    fn foreign_grant_after_a_harmless_first_entry_is_refused() {
        let dir = tempdir().unwrap();
        let path = write_0600(dir.path());
        // `chmod +a` puts new entries first, so the foreign grant goes in first
        // and the harmless deny lands in front of it: the grant is entry 1.
        add_entry(&path, "user:nobody allow read");
        add_entry(&path, "user:root deny read");
        let listing = Command::new("ls").arg("-le").arg(&path).output().unwrap();
        let listing = String::from_utf8_lossy(&listing.stdout).into_owned();
        assert!(
            listing.contains(" 0: user:root deny read")
                && listing.contains(" 1: user:nobody allow read"),
            "entries are not in the order this case needs:\n{listing}"
        );
        assert_eq!(
            read_token_file(&path),
            TokenFile::Rejected("other users can reach it through its access-control list")
        );
    }

    #[test]
    fn inherited_entry_that_applies_to_the_file_is_refused() {
        let dir = tempdir().unwrap();
        // The directory hands this grant down to files created in it; on the
        // file it is marked inherited but not inherit-only, so it applies.
        add_entry(dir.path(), "user:nobody allow read,file_inherit");
        let path = write_0600(dir.path());
        let listing = Command::new("ls").arg("-le").arg(&path).output().unwrap();
        let listing = String::from_utf8_lossy(&listing.stdout).into_owned();
        assert!(
            listing.contains("user:nobody inherited allow read"),
            "the file did not inherit the entry:\n{listing}"
        );
        assert_eq!(
            read_token_file(&path),
            TokenFile::Rejected("other users can reach it through its access-control list")
        );
    }

    #[test]
    fn entry_count_comes_from_the_filesec_size() {
        // KAUTH_FILESEC_SIZE(count) = header + count * entry, measured against
        // acl_size() on this platform for 1, 2, 3, 4, 5 and 6 entries
        // (68, 92, 116, 140, 164, 188).
        for (size, count) in [(68, 1), (92, 2), (116, 3), (140, 4), (164, 5), (188, 6)] {
            assert_eq!(macos_acl::entry_count(size), Some(count));
        }
        // Too small to hold even the header, or a size that is not a whole
        // number of entries, means the list cannot be trusted.
        assert_eq!(macos_acl::entry_count(43), None);
        assert_eq!(macos_acl::entry_count(70), None);
        assert_eq!(macos_acl::entry_count(-1), None);
    }
}

#[cfg(test)]
mod content_tests {
    use super::*;

    #[test]
    fn debug_output_never_contains_the_token() {
        let token = "Abcdefghijklmnopqrstuvwxyz0123456789-._~";
        let loaded = format!("{:?}", TokenFile::Loaded(token.to_string()));
        assert_eq!(loaded, "Loaded(<redacted>)");
        let pretty = format!("{:#?}", TokenFile::Loaded(token.to_string()));
        assert!(!pretty.contains(token));
        assert_eq!(format!("{:?}", TokenFile::Missing), "Missing");
        assert_eq!(
            format!("{:?}", TokenFile::Rejected("it is a directory")),
            "Rejected(\"it is a directory\")"
        );
    }

    fn abs(tail: &str) -> PathBuf {
        if cfg!(windows) {
            PathBuf::from(format!("C:\\{tail}"))
        } else {
            PathBuf::from(format!("/{tail}"))
        }
    }

    fn os(path: &Path) -> Option<OsString> {
        Some(path.as_os_str().to_owned())
    }

    #[test]
    fn storage_dir_override_wins_like_the_plugin() {
        let store = abs("store");
        assert_eq!(
            token_path_from(os(&store), os(&abs("xdg")), Some(abs("home"))),
            Some(store.join(TOKEN_FILE_NAME))
        );
    }

    #[test]
    fn relative_storage_dir_override_is_not_used() {
        assert_eq!(
            token_path_from(Some("rel".into()), os(&abs("xdg")), Some(abs("home"))),
            None
        );
    }

    #[test]
    fn a_relative_override_explains_why_the_token_file_is_ignored() {
        assert_eq!(
            warning_from(Some("rel".into()), os(&abs("xdg")), Some(abs("home"))),
            Some("ignoring MAGIC_CONTEXT_STORAGE_DIR because it is not an absolute path")
        );
        assert_eq!(
            warning_from(Some("  ".into()), Some("rel".into()), Some(abs("home"))),
            Some("ignoring XDG_DATA_HOME because it is not an absolute path")
        );
    }

    #[test]
    fn nothing_is_said_when_the_path_resolves_or_no_variable_can_be_blamed() {
        assert_eq!(
            warning_from(os(&abs("store")), os(&abs("xdg")), Some(abs("home"))),
            None
        );
        // No variable set and no home directory: nothing the user can fix by
        // editing a variable, so the startup output stays quiet.
        assert_eq!(warning_from(None, None, None), None);
    }

    #[test]
    fn xdg_then_home_when_no_override() {
        let tail = |base: PathBuf| {
            base.join("cortexkit")
                .join("magic-context")
                .join(TOKEN_FILE_NAME)
        };
        assert_eq!(
            token_path_from(Some("  ".into()), os(&abs("xdg")), Some(abs("home"))),
            Some(tail(abs("xdg")))
        );
        assert_eq!(
            token_path_from(None, Some("".into()), Some(abs("home"))),
            Some(tail(abs("home").join(".local").join("share")))
        );
        assert_eq!(token_path_from(None, None, None), None);
    }

    #[test]
    fn utf8_byte_order_mark_is_ignored() {
        let token = "x".repeat(MIN_TOKEN_LEN);
        assert_eq!(
            validate_contents(format!("\u{feff}{token}\r\n").as_bytes()),
            Ok(token)
        );
    }
}

/// Linux POSIX ACLs are not invisible the way macOS extended entries are: an
/// effective entry sets the mask, the mask is the group permission bits, and the
/// 0600 check therefore refuses it. These tests pin that down with a real
/// `setfacl` entry instead of leaving it as an argument. Skipped where
/// `setfacl` is not installed.
#[cfg(all(test, target_os = "linux"))]
mod posix_acl_tests {
    use super::*;
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use std::process::Command;
    use tempfile::tempdir;

    const GOOD: &str = "Abcdefghijklmnopqrstuvwxyz0123456789-._~";
    const NOT_0600: &str = "it must have owner-only permissions (0600)";

    fn has_setfacl() -> bool {
        Command::new("setfacl")
            .arg("--version")
            .output()
            .is_ok_and(|out| out.status.success())
    }

    fn setfacl(path: &Path, args: &[&str]) {
        let out = Command::new("setfacl")
            .args(args)
            .arg(path)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "setfacl {args:?} failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    fn write_0600(dir: &Path) -> PathBuf {
        let path = dir.join(TOKEN_FILE_NAME);
        fs::write(&path, GOOD).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        path
    }

    fn mode(path: &Path) -> u32 {
        fs::metadata(path).unwrap().permissions().mode() & 0o777
    }

    #[test]
    fn effective_named_user_entry_is_refused() {
        if !has_setfacl() {
            eprintln!("skipped: setfacl is not installed, so the POSIX ACL case is not tested");
            return;
        }
        let dir = tempdir().unwrap();
        let path = write_0600(dir.path());
        setfacl(&path, &["-m", "u:nobody:r"]);
        // The entry is effective, so the mask grants read and the group bits
        // say so: the 0600 check is what refuses the file.
        assert_eq!(mode(&path), 0o640);
        assert_eq!(read_token_file(&path), TokenFile::Rejected(NOT_0600));
    }

    #[test]
    fn named_user_entry_with_an_empty_mask_is_accepted() {
        if !has_setfacl() {
            eprintln!("skipped: setfacl is not installed, so the POSIX ACL case is not tested");
            return;
        }
        let dir = tempdir().unwrap();
        let path = write_0600(dir.path());
        setfacl(&path, &["-m", "u:nobody:r"]);
        // With the mask empty the entry is listed but grants nothing, and the
        // mode bits are back to 0600.
        setfacl(&path, &["-m", "m::---"]);
        assert_eq!(mode(&path), 0o600);
        assert_eq!(read_token_file(&path), TokenFile::Loaded(GOOD.to_string()));
    }
}

/// Windows cases build each access list from SDDL and apply it to the file with
/// a protected DACL, so the result does not depend on what the temp directory
/// happens to inherit. Run on a real Windows host (see the PR for the CI run).
#[cfg(all(test, windows))]
mod windows_tests {
    use super::windows_acl::{NOT_OWNER, NULL_DACL, OTHER_USERS, UNKNOWN_ACE};
    use super::*;
    use std::ffi::c_void;
    use std::fs;
    use std::os::windows::ffi::OsStrExt;
    use std::ptr::null_mut;
    use tempfile::tempdir;
    use windows_sys::Win32::Foundation::{CloseHandle, LocalFree, ERROR_SUCCESS};
    use windows_sys::Win32::Security::Authorization::{
        ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
        SetNamedSecurityInfoW, SDDL_REVISION_1, SE_FILE_OBJECT,
    };
    use windows_sys::Win32::Security::{
        GetSecurityDescriptorDacl, GetTokenInformation, TokenElevation, TokenUser, ACL,
        DACL_SECURITY_INFORMATION, PROTECTED_DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR,
        TOKEN_ELEVATION, TOKEN_QUERY, TOKEN_USER,
    };
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    const GOOD: &str = "Abcdefghijklmnopqrstuvwxyz0123456789-._~";
    const REPARSE: &str = "it is a symlink or other reparse point";

    fn wide(value: &std::ffi::OsStr) -> Vec<u16> {
        value.encode_wide().chain(std::iter::once(0)).collect()
    }

    /// `S-1-5-21-...` of the user running the tests.
    fn user_sid() -> String {
        unsafe {
            let mut token = null_mut();
            assert_ne!(
                OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token),
                0
            );
            let mut buffer = vec![0u64; 64];
            let mut len = 0u32;
            let ok = GetTokenInformation(
                token,
                TokenUser,
                buffer.as_mut_ptr() as *mut c_void,
                (buffer.len() * 8) as u32,
                &mut len,
            );
            // The SID was copied into `buffer`, so the handle can go now, before
            // an assertion could unwind past it.
            CloseHandle(token);
            assert_ne!(ok, 0);
            let sid = (*(buffer.as_ptr() as *const TOKEN_USER)).User.Sid;
            let mut text = null_mut();
            assert_ne!(ConvertSidToStringSidW(sid, &mut text), 0);
            let len = (0..).take_while(|&i| *text.add(i) != 0).count();
            let out = String::from_utf16(std::slice::from_raw_parts(text, len)).unwrap();
            LocalFree(text as _);
            out
        }
    }

    /// Whether this process runs with an elevated token. `icacls /setowner`
    /// needs SeRestorePrivilege, which only an elevated caller can enable.
    fn process_is_elevated() -> bool {
        unsafe {
            let mut token = null_mut();
            assert_ne!(
                OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token),
                0
            );
            let mut elevation = TOKEN_ELEVATION { TokenIsElevated: 0 };
            let mut len = 0u32;
            let ok = GetTokenInformation(
                token,
                TokenElevation,
                &mut elevation as *mut TOKEN_ELEVATION as *mut c_void,
                std::mem::size_of::<TOKEN_ELEVATION>() as u32,
                &mut len,
            );
            CloseHandle(token);
            assert_ne!(ok, 0);
            elevation.TokenIsElevated != 0
        }
    }

    /// Replaces the file's DACL with the one in `sddl` (e.g. `D:P(A;;FA;;;SY)`),
    /// protected from inheritance. `D:NO_ACCESS_CONTROL` gives a NULL DACL.
    fn set_dacl(path: &Path, sddl: &str) {
        unsafe {
            let mut descriptor: PSECURITY_DESCRIPTOR = null_mut();
            let sddl = wide(std::ffi::OsStr::new(sddl));
            assert_ne!(
                ConvertStringSecurityDescriptorToSecurityDescriptorW(
                    sddl.as_ptr(),
                    SDDL_REVISION_1,
                    &mut descriptor,
                    null_mut(),
                ),
                0,
                "bad SDDL"
            );
            let mut present = 0;
            let mut defaulted = 0;
            let mut dacl: *mut ACL = null_mut();
            assert_ne!(
                GetSecurityDescriptorDacl(descriptor, &mut present, &mut dacl, &mut defaulted),
                0
            );
            assert_ne!(present, 0);
            let status = SetNamedSecurityInfoW(
                wide(path.as_os_str()).as_ptr(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                null_mut(),
                null_mut(),
                dacl,
                null_mut(),
            );
            LocalFree(descriptor as _);
            assert_eq!(status, ERROR_SUCCESS, "SetNamedSecurityInfoW");
        }
    }

    fn token_file_with_dacl(dir: &Path, sddl: &str) -> std::path::PathBuf {
        let path = dir.join(TOKEN_FILE_NAME);
        fs::write(&path, GOOD).unwrap();
        set_dacl(&path, sddl);
        path
    }

    #[test]
    fn missing_file_keeps_random_token() {
        let dir = tempdir().unwrap();
        assert_eq!(
            read_token_file(&dir.path().join(TOKEN_FILE_NAME)),
            TokenFile::Missing
        );
    }

    /// What a user gets from creating the file in their profile with no extra
    /// steps: inherited access for the user, SYSTEM and Administrators.
    #[test]
    fn file_created_with_inherited_profile_acl_is_loaded() {
        let dir = tempdir().unwrap();
        let path = dir.path().join(TOKEN_FILE_NAME);
        fs::write(&path, format!("{GOOD}\r\n")).unwrap();
        assert_eq!(read_token_file(&path), TokenFile::Loaded(GOOD.to_string()));
    }

    #[test]
    fn user_system_and_administrators_only_is_loaded() {
        let dir = tempdir().unwrap();
        let user = user_sid();
        for sddl in [
            format!("D:P(A;;FA;;;{user})"),
            format!("D:P(A;;FA;;;{user})(A;;FA;;;SY)(A;;FA;;;BA)"),
        ] {
            let path = token_file_with_dacl(dir.path(), &sddl);
            assert_eq!(
                read_token_file(&path),
                TokenFile::Loaded(GOOD.to_string()),
                "{sddl}"
            );
        }
    }

    /// A deny entry takes access away, so it is never read as a grant. With
    /// `deny write` the open is refused first: FILE_GENERIC_WRITE contains
    /// SYNCHRONIZE, which CreateFileW requests for every synchronous handle.
    #[test]
    fn deny_write_entry_refuses_the_open() {
        let dir = tempdir().unwrap();
        let sddl = format!("D:P(D;;FW;;;WD)(A;;FA;;;{})", user_sid());
        let path = token_file_with_dacl(dir.path(), &sddl);
        assert_eq!(
            read_token_file(&path),
            TokenFile::Rejected("access to it was denied"),
            "{sddl}"
        );
    }

    /// A deny entry that leaves the open's access alone is skipped: it only
    /// takes access away, so the file stays owner-only and is used.
    #[test]
    fn deny_entry_outside_the_open_is_skipped() {
        let dir = tempdir().unwrap();
        // WD = WRITE_DAC: denies nothing the open asks for.
        let sddl = format!("D:P(D;;WD;;;WD)(A;;FA;;;{})", user_sid());
        let path = token_file_with_dacl(dir.path(), &sddl);
        assert_eq!(
            read_token_file(&path),
            TokenFile::Loaded(GOOD.to_string()),
            "{sddl}"
        );
    }

    #[test]
    fn access_for_anyone_else_is_refused() {
        let dir = tempdir().unwrap();
        let user = user_sid();
        // Everyone, Authenticated Users, Users, Guests, another account.
        for other in ["WD", "AU", "BU", "BG", "S-1-5-21-1-2-3-1001"] {
            let sddl = format!("D:P(A;;FA;;;{user})(A;;FR;;;{other})");
            let path = token_file_with_dacl(dir.path(), &sddl);
            assert_eq!(
                read_token_file(&path),
                TokenFile::Rejected(OTHER_USERS),
                "{sddl}"
            );
        }
    }

    #[test]
    fn null_dacl_is_refused() {
        let dir = tempdir().unwrap();
        let path = token_file_with_dacl(dir.path(), "D:NO_ACCESS_CONTROL");
        assert_eq!(read_token_file(&path), TokenFile::Rejected(NULL_DACL));
    }

    #[test]
    fn conditional_entry_is_refused() {
        let dir = tempdir().unwrap();
        let user = user_sid();
        let sddl = format!("D:P(A;;FA;;;{user})(XA;;FR;;;WD;(Member_of {{SID(BA)}}))");
        let path = token_file_with_dacl(dir.path(), &sddl);
        assert_eq!(read_token_file(&path), TokenFile::Rejected(UNKNOWN_ACE));
    }

    /// Changing the owner to another principal needs SeRestorePrivilege, which
    /// `icacls /setowner` enables for an elevated caller (CI runners are).
    /// Only a non-elevated caller may skip: if the process *is* elevated and the
    /// owner still could not be set, the case is not being exercised and the
    /// test must go red rather than quiet.
    ///
    /// That also means the foreign-owner refusal is untested in a non-elevated run.
    #[test]
    fn file_owned_by_another_principal_is_refused() {
        let dir = tempdir().unwrap();
        let path = dir.path().join(TOKEN_FILE_NAME);
        fs::write(&path, GOOD).unwrap();
        let output = std::process::Command::new("icacls")
            .arg(&path)
            .args(["/setowner", "*S-1-5-32-545"])
            .output()
            .unwrap();
        if !output.status.success() {
            let detail = format!(
                "stdout: {} stderr: {}",
                String::from_utf8_lossy(&output.stdout).trim(),
                String::from_utf8_lossy(&output.stderr).trim()
            );
            assert!(
                !process_is_elevated(),
                "icacls /setowner failed even though this process is elevated, so the \
                 foreign-owner refusal is not being exercised: {detail}"
            );
            eprintln!(
                "skipped: not elevated, so the foreign-owner refusal is not tested in \
                 this run: {detail}"
            );
            return;
        }
        assert_eq!(read_token_file(&path), TokenFile::Rejected(NOT_OWNER));
    }

    /// Needs the symlink privilege (elevated shell or Developer Mode). Same rule
    /// as the owner test: only a non-elevated caller may skip.
    #[test]
    fn symlink_is_refused_even_to_a_good_target() {
        let dir = tempdir().unwrap();
        let target = dir.path().join("real-token");
        fs::write(&target, GOOD).unwrap();
        let link = dir.path().join(TOKEN_FILE_NAME);
        if let Err(err) = std::os::windows::fs::symlink_file(&target, &link) {
            assert!(
                !process_is_elevated(),
                "symlink creation failed even though this process is elevated: {err}"
            );
            eprintln!("skipped: not elevated, symlink refusal not tested this run: {err}");
            return;
        }
        assert_eq!(
            read_token_file(&target),
            TokenFile::Loaded(GOOD.to_string())
        );
        assert_eq!(read_token_file(&link), TokenFile::Rejected(REPARSE));
    }

    #[test]
    fn directory_is_refused() {
        let dir = tempdir().unwrap();
        let path = dir.path().join(TOKEN_FILE_NAME);
        fs::create_dir(&path).unwrap();
        assert_eq!(
            read_token_file(&path),
            TokenFile::Rejected("it is not a regular file")
        );
    }

    #[test]
    fn bad_contents_are_refused() {
        let dir = tempdir().unwrap();
        let path = dir.path().join(TOKEN_FILE_NAME);
        fs::write(&path, "short").unwrap();
        assert_eq!(
            read_token_file(&path),
            TokenFile::Rejected("it must be at least 32 characters long")
        );
        fs::write(&path, vec![b'a'; READ_LIMIT as usize + 1]).unwrap();
        assert_eq!(
            read_token_file(&path),
            TokenFile::Rejected("it is larger than 4 KiB")
        );
    }
}
