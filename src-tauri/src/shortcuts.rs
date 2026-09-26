use crate::{
    engine::Request,
    model::{Config, Operation},
};
use std::{collections::HashSet, str::FromStr, sync::mpsc::Sender};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Shortcut, ShortcutState};

#[derive(Clone)]
pub enum Action {
    Preset(String),
    Toggle,
    Cycle,
}
pub fn bindings(config: &Config) -> Result<Vec<(Shortcut, Action, String)>, String> {
    let mut result = Vec::new();
    let mut used = HashSet::new();
    let items = config
        .presets
        .iter()
        .map(|p| (p.shortcut.clone(), Action::Preset(p.id.clone())))
        .chain([
            (config.settings.toggle_shortcut.clone(), Action::Toggle),
            (config.settings.cycle_shortcut.clone(), Action::Cycle),
        ]);
    for (value, action) in items {
        if value.is_empty() {
            continue;
        }
        let shortcut =
            Shortcut::from_str(&value).map_err(|_| format!("Invalid shortcut: {value}"))?;
        if shortcut.key == Code::F12 {
            return Err("F12 is reserved by Windows".into());
        }
        if !used.insert(shortcut.id()) {
            return Err(format!("Shortcut already assigned: {value}"));
        }
        result.push((shortcut, action, value));
    }
    Ok(result)
}
pub fn register(app: &tauri::AppHandle, config: &Config, tx: &Sender<Request>) -> Vec<String> {
    let Ok(items) = bindings(config) else {
        return vec!["Invalid shortcut configuration".into()];
    };
    let mut errors = Vec::new();
    for (shortcut, action, text) in items {
        let sender = tx.clone();
        if let Err(error) = app
            .global_shortcut()
            .on_shortcut(shortcut, move |_, _, event| {
                if event.state() == ShortcutState::Pressed {
                    let _ = sender.send(Request::hotkey(action.clone()));
                }
            })
        {
            errors.push(format!("{text}: {error}"));
        }
    }
    errors
}
pub fn replace(
    app: &tauri::AppHandle,
    old: &Config,
    new: &Config,
    tx: &Sender<Request>,
) -> Result<(), String> {
    bindings(new)?;
    app.global_shortcut()
        .unregister_all()
        .map_err(|e| e.to_string())?;
    let errors = register(app, new, tx);
    if errors.is_empty() {
        return Ok(());
    }
    let _ = app.global_shortcut().unregister_all();
    let rollback_errors = register(app, old, tx);
    Err(errors
        .into_iter()
        .chain(rollback_errors)
        .collect::<Vec<_>>()
        .join("\n"))
}
pub fn resolve(action: Action, config: &Config, enabled: bool) -> Operation {
    match action {
        Action::Preset(id) => Operation::SelectPreset(id),
        Action::Toggle => Operation::SetEnabled(!enabled),
        Action::Cycle => {
            let index = config
                .presets
                .iter()
                .position(|p| p.id == config.active_preset)
                .unwrap_or(0);
            Operation::SelectPreset(
                config.presets[(index + 1) % config.presets.len()]
                    .id
                    .clone(),
            )
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_shortcuts_across_presets_and_global_actions() {
        let mut config = Config::default();
        assert!(bindings(&config).is_ok());
        config.settings.toggle_shortcut = "F6".into();
        assert!(bindings(&config).is_err());
        config.settings.toggle_shortcut = "F12".into();
        assert!(bindings(&config).is_err());
        config.settings.toggle_shortcut = "Control+Shift+KeyL".into();
        assert!(bindings(&config).is_ok());
    }
}
