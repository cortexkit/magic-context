use std::ffi::{OsStr, OsString};
use std::fs::{self, File};
use std::os::fd::OwnedFd;
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};

use nix::dir::Dir;
use nix::errno::Errno;
use nix::fcntl::{open, openat, AtFlags, OFlag};
use nix::sys::stat::{fchmod, fstat, fstatat, FileStat, Mode, SFlag};
use nix::unistd::geteuid;

use crate::storage_paths::{CONTEXT_DB, MODULE_DIR, SESSION_DB};

const BACKUPS: &str = "backups";
const SPECIMENS: &str = "specimens";
const LOGS: &str = "logs";
const DB_NAMES: [&str; 2] = [CONTEXT_DB, SESSION_DB];
const CHILD_FLAGS: OFlag = OFlag::O_RDONLY
    .union(OFlag::O_CLOEXEC)
    .union(OFlag::O_NOFOLLOW)
    .union(OFlag::O_NONBLOCK)
    .union(OFlag::O_NOCTTY);

pub(super) struct DataDir {
    pub(super) path: PathBuf,
    pub(super) fd: OwnedFd,
}

impl DataDir {
    pub(super) fn open(home: &Path) -> Result<Option<Self>, Errno> {
        // The runner's supplied home is the trust root (on macOS the OS may
        // spell it through /var). Below it, open every named component without
        // following links.
        let home = match fs::canonicalize(home) {
            Ok(home) => home,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => {
                return Err(Errno::from_raw(
                    error.raw_os_error().unwrap_or(Errno::EIO as i32),
                ))
            }
        };
        let home_fd = open(&home, CHILD_FLAGS | OFlag::O_DIRECTORY, Mode::empty())?;
        let Some(fleet) = child_dir(&home_fd, OsStr::new("cortexkit"))? else {
            return Ok(None);
        };
        Ok(child_dir(&fleet, OsStr::new(MODULE_DIR))?.map(|fd| Self {
            path: home.join("cortexkit").join(MODULE_DIR),
            fd,
        }))
    }

    pub(super) fn has_sidecar(&self, db: &str) -> bool {
        ["-wal", "-shm"].into_iter().any(|suffix| {
            let name = sidecar(db, suffix);
            // An unexpected type or lookup error is not proof of an absent sidecar.
            !matches!(stat(&self.fd, &name), Err(Errno::ENOENT))
        })
    }

    pub(super) fn permissions(&self, stop: impl Fn() -> bool) -> PermissionScan {
        let mut result = PermissionScan::default();
        result.walk = walk(&self.fd, &permission_targets(), stop, |entry| {
            if entry.private_candidate() && entry.stat.st_mode & 0o044 != 0 {
                result.count += 1;
                if result.first.is_none() {
                    result.first = Some(entry.path.to_owned());
                }
            }
        });
        result
    }

    pub(super) fn backups(&self, stop: impl Fn() -> bool) -> BackupScan {
        let mut result = BackupScan::default();
        let targets = [BACKUPS, SPECIMENS].map(|name| (OsString::from(name), true));
        result.walk = walk(&self.fd, &targets, stop, |entry| {
            if entry.private_candidate() && entry.kind() == SFlag::S_IFREG {
                result.count += 1;
                result.bytes = result
                    .bytes
                    .saturating_add(entry.stat.st_size.max(0) as u64);
            }
        });
        result
    }

    pub(super) fn tighten(&self, stop: impl Fn() -> bool) -> Changes {
        let uid = geteuid().as_raw();
        let mut result = Changes::default();
        result.walk = walk(&self.fd, &permission_targets(), stop, |entry| {
            if entry.kind() == SFlag::S_IFLNK {
                result.links += 1;
                if result.first_link.is_none() {
                    result.first_link = Some(entry.path.to_owned());
                }
            }
            if !entry.private_candidate() || entry.stat.st_uid != uid || shared_inode(&entry.stat) {
                result.skipped += 1;
                return;
            }
            if entry.stat.st_mode & 0o077 == 0 {
                return;
            }
            match entry.tighten(uid) {
                Ok(true) => result.changed += 1,
                Ok(false) => result.skipped += 1,
                Err(_) => result.failed += 1,
            }
        });
        result.failed += result.walk.errors;
        result
    }
}

pub(super) fn child_dir(parent: &OwnedFd, name: &OsStr) -> Result<Option<OwnedFd>, Errno> {
    match openat(
        parent,
        name,
        CHILD_FLAGS | OFlag::O_DIRECTORY,
        Mode::empty(),
    ) {
        Ok(fd) => Ok(Some(fd)),
        Err(Errno::ENOENT) => Ok(None),
        Err(error) => Err(error),
    }
}

pub(super) fn regular_file(parent: &OwnedFd, name: &OsStr) -> Result<Option<File>, Errno> {
    let before = match stat(parent, name) {
        Err(Errno::ENOENT) => return Ok(None),
        other => other?,
    };
    if kind(&before) != SFlag::S_IFREG {
        return Err(Errno::EINVAL);
    }
    let fd = openat(parent, name, CHILD_FLAGS, Mode::empty())?;
    if !same_entry(&before, &fstat(&fd)?) {
        return Err(Errno::EAGAIN);
    }
    Ok(Some(fd.into()))
}

fn stat(parent: &OwnedFd, name: &OsStr) -> Result<FileStat, Errno> {
    fstatat(parent, name, AtFlags::AT_SYMLINK_NOFOLLOW)
}

fn kind(stat: &FileStat) -> SFlag {
    SFlag::from_bits_truncate(stat.st_mode) & SFlag::S_IFMT
}

fn same_entry(left: &FileStat, right: &FileStat) -> bool {
    left.st_dev == right.st_dev && left.st_ino == right.st_ino && kind(left) == kind(right)
}

fn shared_inode(stat: &FileStat) -> bool {
    // A hard link under the data folder can name a file outside it. There is
    // no way to tighten just one name's mode, so leave the inode unchanged.
    kind(stat) == SFlag::S_IFREG && stat.st_nlink != 1
}

fn sidecar(db: &str, suffix: &str) -> OsString {
    format!("{db}{suffix}").into()
}

fn permission_targets() -> Vec<(OsString, bool)> {
    DB_NAMES
        .into_iter()
        .flat_map(|db| ["", "-wal", "-shm"].map(|suffix| (sidecar(db, suffix), false)))
        .chain([BACKUPS, LOGS].map(|name| (name.into(), true)))
        .collect()
}

#[derive(Default)]
pub(super) struct PermissionScan {
    pub(super) walk: Walk,
    pub(super) first: Option<PathBuf>,
    pub(super) count: u64,
}

#[derive(Default)]
pub(super) struct BackupScan {
    pub(super) walk: Walk,
    pub(super) bytes: u64,
    pub(super) count: u64,
}

#[derive(Default)]
pub(super) struct Changes {
    pub(super) walk: Walk,
    pub(super) changed: u64,
    pub(super) skipped: u64,
    pub(super) failed: u64,
    pub(super) links: u64,
    pub(super) first_link: Option<PathBuf>,
}

#[derive(Default)]
pub(super) struct Walk {
    pub(super) examined: u64,
    pub(super) incomplete: bool,
    errors: u64,
}

struct Entry<'a> {
    parent: &'a OwnedFd,
    name: &'a OsStr,
    path: &'a Path,
    stat: FileStat,
    type_allowed: bool,
}

impl Entry<'_> {
    fn kind(&self) -> SFlag {
        kind(&self.stat)
    }

    fn private_candidate(&self) -> bool {
        self.type_allowed && matches!(self.kind(), SFlag::S_IFDIR | SFlag::S_IFREG)
    }

    fn tighten(&self, uid: nix::libc::uid_t) -> Result<bool, Errno> {
        let flags = if self.kind() == SFlag::S_IFDIR {
            CHILD_FLAGS | OFlag::O_DIRECTORY
        } else {
            CHILD_FLAGS
        };
        let fd = openat(self.parent, self.name, flags, Mode::empty())?;
        let current = fstat(&fd)?;
        if !same_entry(&self.stat, &current)
            || current.st_uid != uid
            || shared_inode(&current)
            || !same_entry(&current, &stat(self.parent, self.name)?)
            || current.st_mode & 0o077 == 0
        {
            return Ok(false);
        }
        fchmod(&fd, Mode::from_bits_truncate(current.st_mode & 0o700))?;
        Ok(true)
    }
}

fn walk(
    root: &OwnedFd,
    targets: &[(OsString, bool)],
    stop: impl Fn() -> bool,
    visit: impl FnMut(Entry<'_>),
) -> Walk {
    let mut walk = Walker {
        result: Walk::default(),
        stop,
        visit,
    };
    for (name, tree) in targets {
        if walk.stop() {
            break;
        }
        walk.entry(root, name, Path::new(name), Some(*tree));
    }
    walk.result
}

struct Walker<S, V> {
    result: Walk,
    stop: S,
    visit: V,
}

impl<S: Fn() -> bool, V: FnMut(Entry<'_>)> Walker<S, V> {
    fn stop(&mut self) -> bool {
        self.result.incomplete |= (self.stop)();
        self.result.incomplete
    }

    /// A named root must have the expected type. Inside a tree, visit both
    /// regular files and directories, but never descend into a link.
    fn entry(&mut self, parent: &OwnedFd, name: &OsStr, path: &Path, tree: Option<bool>) {
        let status = match stat(parent, name) {
            Ok(status) => status,
            Err(Errno::ENOENT) => return,
            Err(_) => {
                self.result.errors += 1;
                return;
            }
        };
        self.result.examined += 1;
        let directory = kind(&status) == SFlag::S_IFDIR;
        let type_allowed = tree.is_none_or(|tree| tree == directory);
        (self.visit)(Entry {
            parent,
            name,
            path,
            stat: status,
            type_allowed,
        });
        if directory && type_allowed {
            match child_dir(parent, name) {
                Ok(Some(fd)) => self.children(&fd, path),
                Ok(None) => (),
                Err(_) => self.result.errors += 1,
            }
        }
    }

    fn children(&mut self, fd: &OwnedFd, path: &Path) {
        // Keep the directory descriptor separate from the read cursor, so a
        // rename or link swap cannot redirect a child's path lookup.
        let cursor = fd
            .try_clone()
            .map_err(|_| Errno::EIO)
            .and_then(Dir::from_fd);
        let Ok(cursor) = cursor else {
            self.result.errors += 1;
            return;
        };
        let mut entries = cursor.into_iter();
        while !self.stop() {
            let Some(entry) = entries.next() else { break };
            let entry = match entry {
                Ok(entry) => entry,
                Err(_) => {
                    self.result.errors += 1;
                    break;
                }
            };
            let bytes = entry.file_name().to_bytes();
            if bytes == b"." || bytes == b".." {
                continue;
            }
            let name = OsStr::from_bytes(bytes);
            self.entry(fd, name, &path.join(name), None);
        }
    }
}
