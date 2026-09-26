use crate::{hardware::Records, model::Config, tone::Ramp};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    io::Write,
    path::{Path, PathBuf},
};

#[derive(Clone, Serialize, Deserialize)]
pub struct Recovery {
    pub version: u32,
    pub display_id: String,
    pub device: String,
    pub gamma: Vec<u16>,
    #[serde(default)]
    pub gamma_changed: bool,
    pub hardware: BTreeMap<String, u32>,
}
impl Recovery {
    pub fn ramp(&self) -> Result<Ramp, String> {
        if self.version != 1 || self.gamma.len() != 768 {
            return Err("Invalid recovery record".into());
        }
        Ok(std::array::from_fn(|c| {
            std::array::from_fn(|i| self.gamma[c * 256 + i])
        }))
    }
}

pub struct Storage {
    pub root: PathBuf,
}
impl Storage {
    pub fn new(root: PathBuf) -> Result<Self, String> {
        std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
        Ok(Self { root })
    }
    pub fn load(&self) -> Result<Config, String> {
        let path = self.root.join("config.json");
        if !path.exists() {
            return Ok(Config::default());
        }
        let config: Config =
            serde_json::from_slice(&std::fs::read(path).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
        config.validate()?;
        Ok(config)
    }
    pub fn save(&self, config: &Config) -> Result<(), String> {
        config.validate()?;
        atomic_json(&self.root.join("config.json"), config)
    }
    pub fn journal(&self, recovery: &Recovery) -> Result<(), String> {
        atomic_json(&self.root.join("recovery.json"), recovery)
    }
    pub fn hardware_journal(&self, records: &Records) -> Result<(), String> {
        atomic_json(&self.root.join("hardware-recovery.json"), records)
    }
    pub fn split_hardware_recovery(&self) -> Result<Records, String> {
        let path = self.root.join("hardware-recovery.json");
        let mut records: Records = if path.exists() {
            serde_json::from_slice(&std::fs::read(path).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?
        } else {
            Records::default()
        };
        if let Some(mut legacy) = self.recovery()? {
            if !legacy.hardware.is_empty() {
                let values = records
                    .displays
                    .entry(legacy.display_id.clone())
                    .or_default();
                for (key, value) in &legacy.hardware {
                    values.entry(key.clone()).or_insert(*value);
                }
                // Persist hardware FIRST. A crash between these writes can leave
                // duplicate originals, but can never erase the only copy.
                self.hardware_journal(&records)?;
                legacy.hardware.clear();
                if legacy.gamma_changed {
                    self.journal(&legacy)?;
                } else {
                    self.clear_recovery()?;
                }
            }
        }
        Ok(records)
    }
    pub fn recovery(&self) -> Result<Option<Recovery>, String> {
        let path = self.root.join("recovery.json");
        if !path.exists() {
            return Ok(None);
        }
        let item: Recovery =
            serde_json::from_slice(&std::fs::read(path).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
        item.ramp()?;
        Ok(Some(item))
    }
    pub fn clear_recovery(&self) -> Result<(), String> {
        match std::fs::remove_file(self.root.join("recovery.json")) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }
    pub fn log(&self, message: &str) {
        let path = self.root.join("lumashift.log");
        if std::fs::metadata(&path).is_ok_and(|m| m.len() > 512_000) {
            let _ = std::fs::rename(&path, self.root.join("lumashift.previous.log"));
        }
        if let Ok(mut file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
        {
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs();
            let _ = writeln!(file, "[{now}] {message}");
        }
    }
}

pub fn atomic_json(path: &Path, value: &impl Serialize) -> Result<(), String> {
    let tmp = path.with_extension("json.tmp");
    let data = serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?;
    let mut file = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
    file.write_all(&data)
        .and_then(|_| file.sync_all())
        .map_err(|e| e.to_string())?;
    drop(file);
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows::{
            core::PCWSTR,
            Win32::Storage::FileSystem::{
                MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
            },
        };
        let from: Vec<u16> = tmp.as_os_str().encode_wide().chain(Some(0)).collect();
        let to: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        unsafe {
            MoveFileExW(
                PCWSTR(from.as_ptr()),
                PCWSTR(to.as_ptr()),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        }
        .map_err(|e| e.to_string())?;
    }
    #[cfg(not(windows))]
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn migrates_legacy_hardware_before_gamma_and_keeps_journals_independent() {
        let dir =
            std::env::temp_dir().join(format!("lumashift-migration-test-{}", std::process::id()));
        let store = Storage::new(dir.clone()).unwrap();
        let mut original = Recovery {
            version: 1,
            display_id: "A".into(),
            device: "A".into(),
            gamma: crate::tone::identity().into_iter().flatten().collect(),
            gamma_changed: true,
            hardware: BTreeMap::from([("redGain".into(), 50)]),
        };
        store.journal(&original).unwrap();
        let hardware = store.split_hardware_recovery().unwrap();
        assert_eq!(hardware.displays["A"]["redGain"], 50);
        assert!(store.recovery().unwrap().unwrap().hardware.is_empty());
        // Simulate interruption between the hardware and Gamma migration writes.
        store.journal(&original).unwrap();
        assert_eq!(store.split_hardware_recovery().unwrap(), hardware);
        store.clear_recovery().unwrap();
        original.hardware.clear();
        original.display_id = "B".into();
        store.journal(&original).unwrap();
        assert_eq!(store.split_hardware_recovery().unwrap(), hardware);
        store.clear_recovery().unwrap();
        std::fs::remove_file(dir.join("hardware-recovery.json")).unwrap();
        std::fs::remove_dir(dir).unwrap();
    }
    #[test]
    fn journal_requires_a_complete_ramp_before_recovery() {
        let record = Recovery {
            version: 1,
            display_id: "test".into(),
            device: "test".into(),
            gamma: vec![0; 767],
            gamma_changed: false,
            hardware: BTreeMap::new(),
        };
        assert!(record.ramp().is_err());
    }
    #[test]
    fn replaces_existing_config_and_round_trips() {
        let dir =
            std::env::temp_dir().join(format!("lumashift-storage-test-{}", std::process::id()));
        let store = Storage::new(dir.clone()).unwrap();
        let mut config = Config::default();
        store.save(&config).unwrap();
        config.settings.theme = "light".into();
        store.save(&config).unwrap();
        assert_eq!(store.load().unwrap().settings.theme, "light");
        std::fs::remove_file(dir.join("config.json")).unwrap();
        std::fs::remove_dir(dir).unwrap();
    }
}
