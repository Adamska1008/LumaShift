use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct Tone {
    pub gamma: f64,
    pub shadows: f64,
    pub contrast: f64,
    pub highlights: f64,
    pub exposure: f64,
    pub temperature: f64,
    pub black_point: f64,
}
impl Default for Tone {
    fn default() -> Self {
        Self {
            gamma: 1.0,
            shadows: 0.0,
            contrast: 0.0,
            highlights: 0.0,
            exposure: 0.0,
            temperature: 0.0,
            black_point: 0.0,
        }
    }
}
impl Tone {
    pub fn validate(&self) -> Result<(), String> {
        for (name, value, min, max) in [
            ("Gamma", self.gamma, 0.6, 2.2),
            ("Shadows", self.shadows, 0.0, 60.0),
            ("Contrast", self.contrast, -40.0, 40.0),
            ("Highlights", self.highlights, -40.0, 40.0),
            ("Exposure", self.exposure, -0.5, 0.5),
            ("Temperature", self.temperature, -50.0, 50.0),
            ("Black point", self.black_point, 0.0, 8.0),
        ] {
            if !value.is_finite() || !(min..=max).contains(&value) {
                return Err(format!("{name}: expected {min}…{max}"));
            }
        }
        Ok(())
    }
}

pub const FEATURES: [(&str, u8); 7] = [
    ("brightness", 0x10),
    ("contrast", 0x12),
    ("saturation", 0x8a),
    ("sharpness", 0x87),
    ("redGain", 0x16),
    ("greenGain", 0x18),
    ("blueGain", 0x1a),
];

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Profile {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub shortcut: String,
    #[serde(default)]
    pub tone: Tone,
    #[serde(default)]
    pub hardware: BTreeMap<String, u32>,
}
impl Profile {
    pub fn validate(&self) -> Result<(), String> {
        if self.id.is_empty()
            || self.id.len() > 100
            || self.name.trim().is_empty()
            || self.name.chars().count() > 40
        {
            return Err("Invalid preset name or ID".into());
        }
        self.tone.validate()?;
        for (key, value) in &self.hardware {
            if *value > 100 || !FEATURES.iter().any(|(name, _)| name == key) {
                return Err(format!("Invalid monitor setting: {key}"));
            }
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct Settings {
    pub theme: String,
    pub language: String,
    pub start_minimized: bool,
    pub apply_last_on_start: bool,
    pub toggle_shortcut: String,
    pub cycle_shortcut: String,
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            theme: "system".into(),
            language: "zh".into(),
            start_minimized: false,
            apply_last_on_start: false,
            toggle_shortcut: "F9".into(),
            cycle_shortcut: "F10".into(),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Config {
    pub version: u32,
    pub presets: Vec<Profile>,
    pub active_preset: String,
    pub selected_display: Option<String>,
    pub settings: Settings,
}
impl Default for Config {
    fn default() -> Self {
        let desktop = Profile {
            id: "desktop".into(),
            name: "桌面".into(),
            shortcut: "F6".into(),
            tone: Tone::default(),
            hardware: BTreeMap::new(),
        };
        let mut game = desktop.clone();
        game.id = "tarkov".into();
        game.name = "塔科夫".into();
        game.shortcut = "F7".into();
        game.tone.gamma = 1.2;
        game.tone.shadows = 25.0;
        game.tone.contrast = 8.0;
        Self {
            version: 1,
            presets: vec![desktop, game],
            active_preset: "desktop".into(),
            selected_display: None,
            settings: Settings::default(),
        }
    }
}
impl Config {
    pub fn validate(&self) -> Result<(), String> {
        if self.version != 1 {
            return Err("Unsupported configuration version".into());
        }
        if self.presets.is_empty() || self.presets.len() > 50 {
            return Err("Expected 1–50 presets".into());
        }
        let mut ids = HashSet::new();
        for preset in &self.presets {
            preset.validate()?;
            if !ids.insert(&preset.id) {
                return Err("Duplicate preset ID".into());
            }
        }
        if !ids.contains(&self.active_preset) {
            return Err("Active preset not found".into());
        }
        if !["dark", "light", "system"].contains(&self.settings.theme.as_str())
            || !["zh", "en"].contains(&self.settings.language.as_str())
        {
            return Err("Invalid appearance settings".into());
        }
        Ok(())
    }
    pub fn current(&self) -> Profile {
        self.presets
            .iter()
            .find(|p| p.id == self.active_preset)
            .unwrap_or(&self.presets[0])
            .clone()
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeatureInfo {
    pub key: String,
    pub status: String,
    pub value: Option<u32>,
    pub max: u32,
    pub detail: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DisplayInfo {
    pub id: String,
    pub name: String,
    pub device: String,
    pub primary: bool,
    pub hdr: Option<bool>,
    pub gamma_available: bool,
    pub features: Vec<FeatureInfo>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub revision: u64,
    pub config: Config,
    pub draft: Profile,
    pub displays: Vec<DisplayInfo>,
    pub enabled: bool,
    pub comparing: bool,
    pub busy: bool,
    pub error: Option<String>,
    pub warnings: Vec<String>,
    pub shortcut_errors: Vec<String>,
    pub recovery_pending: bool,
    pub reason: String,
}

#[derive(Clone, Deserialize)]
#[serde(tag = "type", content = "payload", rename_all = "camelCase")]
pub enum Operation {
    Refresh,
    SelectDisplay(String),
    SelectPreset(String),
    Preview(Profile),
    SetEnabled(bool),
    Compare(bool),
    CaptureShortcut(bool),
    SavePreset(String),
    CreatePreset(String),
    DeletePreset(String),
    SaveConfig(Config),
    Import { json: String, scope: String },
    Recover,
    Quit,
    ForceQuit,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_imports_that_could_write_out_of_range_values() {
        let mut config = Config::default();
        config.presets[0].hardware.insert("brightness".into(), 101);
        assert!(config.validate().is_err());
        config.presets[0].hardware.clear();
        config.presets[0].tone.gamma = f64::NAN;
        assert!(config.validate().is_err());
    }
    #[test]
    fn rejects_duplicate_ids_and_unknown_schema() {
        let mut config = Config::default();
        config.presets.push(config.presets[0].clone());
        assert!(config.validate().is_err());
        let mut config = Config::default();
        config.version = 99;
        assert!(config.validate().is_err());
    }
}
