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
    pub saturation: f64,
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
            saturation: 100.0,
        }
    }
}
impl Tone {
    pub fn gamma_only(&self) -> Self {
        Self {
            saturation: 100.0,
            ..self.clone()
        }
    }
    pub fn validate(&self) -> Result<(), String> {
        for (name, value, min, max) in [
            ("Saturation", self.saturation, 0.0, 200.0),
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
    #[serde(default = "legacy_hardware_enabled")]
    pub hardware_enabled: bool,
    #[serde(default = "legacy_saved")]
    pub has_saved: bool,
}
fn legacy_hardware_enabled() -> bool {
    true
}
fn legacy_saved() -> bool {
    true
}
impl Profile {
    pub fn preview_tone(&self, saved: &Self, comparing: bool) -> Tone {
        if !comparing {
            self.tone.clone()
        } else if saved.has_saved {
            saved.tone.clone()
        } else {
            Tone::default()
        }
    }
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

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CloseAction {
    #[default]
    Tray,
    Quit,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct Settings {
    pub theme: String,
    pub language: String,
    pub close_action: CloseAction,
    // Accept retired settings in existing files without exporting or applying them.
    #[serde(rename = "startMinimized", skip_serializing)]
    _legacy_start_minimized: bool,
    #[serde(rename = "applyLastOnStart", skip_serializing)]
    _legacy_apply_last_on_start: bool,
    pub toggle_shortcut: String,
    pub cycle_shortcut: String,
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            theme: "system".into(),
            language: "zh".into(),
            close_action: CloseAction::Tray,
            _legacy_start_minimized: false,
            _legacy_apply_last_on_start: false,
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
            hardware_enabled: false,
            has_saved: false,
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
    pub gamma_recovery_pending: bool,
    pub hardware_recovery_pending: bool,
    pub color_recovery_pending: bool,
    pub saturation_error: Option<String>,
    pub reason: String,
}

#[derive(Clone, Deserialize)]
#[serde(tag = "type", content = "payload", rename_all = "camelCase")]
pub enum Operation {
    Refresh,
    RetrySaturation,
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
impl Operation {
    pub fn name(&self) -> &'static str {
        match self {
            Self::RetrySaturation => "retrySaturation",
            Self::Refresh => "refresh",
            Self::SelectDisplay(_) => "selectDisplay",
            Self::SelectPreset(_) => "selectPreset",
            Self::Preview(_) => "preview",
            Self::SetEnabled(_) => "setEnabled",
            Self::Compare(_) => "compare",
            Self::CaptureShortcut(_) => "captureShortcut",
            Self::SavePreset(_) => "savePreset",
            Self::CreatePreset(_) => "createPreset",
            Self::DeletePreset(_) => "deletePreset",
            Self::SaveConfig(_) => "saveConfig",
            Self::Import { .. } => "import",
            Self::Recover => "recover",
            Self::Quit => "quit",
            Self::ForceQuit => "forceQuit",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn comparison_uses_saved_tone_without_mutating_draft() {
        let mut saved = Config::default().current();
        saved.tone.gamma = 1.2;
        saved.tone.saturation = 120.0;
        let mut draft = saved.clone();
        draft.tone.gamma = 1.8;
        draft.tone.saturation = 160.0;
        assert_eq!(draft.preview_tone(&saved, true), Tone::default());
        saved.has_saved = true;
        assert_eq!(draft.preview_tone(&saved, true), saved.tone);
        assert_eq!(draft.preview_tone(&saved, false), draft.tone);
        draft.tone.shadows = 30.0;
        assert_eq!(draft.preview_tone(&saved, true), saved.tone);
        assert_eq!(draft.tone.gamma, 1.8);
    }
    #[test]
    fn old_presets_default_to_neutral_saturation_and_invalid_imports_fail() {
        let old: Tone = serde_json::from_str(r#"{"gamma":1.2}"#).unwrap();
        assert_eq!(old.saturation, 100.0);
        for value in [-1.0, 201.0, f64::NAN] {
            assert!(Tone {
                saturation: value,
                ..Tone::default()
            }
            .validate()
            .is_err());
        }
    }
    #[test]
    fn save_state_survives_roundtrip_and_legacy_presets_are_saved() {
        let mut profile = Config::default().current();
        for saved in [false, true] {
            profile.has_saved = saved;
            let value = serde_json::to_value(&profile).unwrap();
            let loaded: Profile = serde_json::from_value(value).unwrap();
            assert_eq!(loaded.has_saved, saved);
        }
        let mut legacy = serde_json::to_value(&profile).unwrap();
        legacy.as_object_mut().unwrap().remove("hasSaved");
        assert!(serde_json::from_value::<Profile>(legacy).unwrap().has_saved);
    }
    #[test]
    fn retired_launch_options_load_but_are_not_exported() {
        let mut config = serde_json::to_value(Config::default()).unwrap();
        let settings = config["settings"].as_object_mut().unwrap();
        settings.remove("closeAction");
        settings.insert("startMinimized".into(), true.into());
        settings.insert("applyLastOnStart".into(), true.into());
        let loaded: Config = serde_json::from_value(config).unwrap();
        loaded.validate().unwrap();
        assert_eq!(loaded.settings.close_action, CloseAction::Tray);
        let exported = serde_json::to_value(loaded).unwrap();
        assert_eq!(exported["settings"]["closeAction"], "tray");
        assert!(exported["settings"].get("startMinimized").is_none());
        assert!(exported["settings"].get("applyLastOnStart").is_none());
    }
    #[test]
    fn rejects_invalid_close_actions_in_imports() {
        let mut config = serde_json::to_value(Config::default()).unwrap();
        for invalid in [
            serde_json::json!("exit"),
            serde_json::json!(true),
            serde_json::Value::Null,
        ] {
            config["settings"]["closeAction"] = invalid;
            assert!(serde_json::from_value::<Config>(config.clone()).is_err());
        }
    }
    #[test]
    fn legacy_profiles_keep_hardware_and_new_defaults_are_gamma_only() {
        let profile: Profile =
            serde_json::from_str(r#"{"id":"old","name":"Old","hardware":{"brightness":60}}"#)
                .unwrap();
        assert!(profile.hardware_enabled);
        assert!(Config::default()
            .presets
            .iter()
            .all(|p| !p.hardware_enabled));
        let mut disabled = profile;
        disabled.hardware_enabled = false;
        let loaded: Profile =
            serde_json::from_str(&serde_json::to_string(&disabled).unwrap()).unwrap();
        assert!(!loaded.hardware_enabled);
        assert_eq!(loaded.hardware["brightness"], 60);
    }
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
