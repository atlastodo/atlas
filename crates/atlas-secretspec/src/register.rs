//! The provider claim SecretSpec discovers the endpoint by: `atlas.secretspec.json` in its user
//! or system `providers.d` directory, naming this executable and the environment it reads.

use std::path::{Path, PathBuf};

use serde_json::json;

use crate::{ENVIRONMENT, SCHEME};

/// The claim's file name.
pub fn claim_file_name() -> String {
    format!("{SCHEME}.secretspec.json")
}

/// The claim for `executable` (absolute).
pub fn claim(executable: &Path) -> String {
    let claim = json!({
        "executable": executable.to_string_lossy(),
        "environment": ENVIRONMENT,
    });
    serde_json::to_string_pretty(&claim).expect("JSON") + "\n"
}

/// SecretSpec's user (`system == false`) or system registration directory on this platform.
pub fn directory(system: bool, env: impl Fn(&str) -> Option<String>) -> Option<PathBuf> {
    let env = |k: &str| env(k).filter(|v| !v.is_empty()).map(PathBuf::from);
    if cfg!(windows) {
        let base = env(if system { "PROGRAMDATA" } else { "APPDATA" })?;
        return Some(base.join("SecretSpec").join("providers.d"));
    }
    if cfg!(target_os = "macos") {
        let base = if system {
            PathBuf::from("/Library/Application Support")
        } else {
            env("HOME")?.join("Library").join("Application Support")
        };
        return Some(base.join("SecretSpec").join("providers.d"));
    }
    if system {
        return Some(PathBuf::from("/etc/secretspec/providers.d"));
    }
    let config = env("XDG_CONFIG_HOME").or_else(|| env("HOME").map(|h| h.join(".config")))?;
    Some(config.join("secretspec").join("providers.d"))
}

/// Write the claim for `executable` into `directory`; returns the claim's path.
pub fn write(directory: &Path, executable: &Path) -> std::io::Result<PathBuf> {
    std::fs::create_dir_all(directory)?;
    let path = directory.join(claim_file_name());
    std::fs::write(&path, claim(executable))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        // SecretSpec refuses a claim others may write.
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644))?;
    }
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_claim_names_the_executable_and_the_environment() {
        let claim: serde_json::Value =
            serde_json::from_str(&claim(Path::new("/opt/atlas/secretspec-provider-atlas")))
                .unwrap();
        assert_eq!(
            claim,
            json!({
                "executable": "/opt/atlas/secretspec-provider-atlas",
                "environment": ["ATLAS_URL", "ATLAS_TOKEN", "ATLAS_STATE_DIR"],
            })
        );
        assert_eq!(claim_file_name(), "atlas.secretspec.json");
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    #[test]
    fn the_directories_are_secretspecs() {
        let env = |k: &str| match k {
            "HOME" => Some("/home/me".to_owned()),
            _ => None,
        };
        assert_eq!(
            directory(false, env),
            Some(PathBuf::from("/home/me/.config/secretspec/providers.d"))
        );
        let xdg = |k: &str| match k {
            "XDG_CONFIG_HOME" => Some("/cfg".to_owned()),
            _ => None,
        };
        assert_eq!(
            directory(false, xdg),
            Some(PathBuf::from("/cfg/secretspec/providers.d"))
        );
        assert_eq!(
            directory(true, |_| None),
            Some(PathBuf::from("/etc/secretspec/providers.d"))
        );
    }
}
