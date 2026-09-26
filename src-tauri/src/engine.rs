use crate::{
    model::*,
    native,
    shortcuts::{self, Action},
    storage::{Recovery, Storage},
    tone,
};
use std::{
    collections::{BTreeMap, HashMap},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, Sender},
        Arc, Mutex,
    },
    time::Duration,
};
use tauri::{Emitter, Manager};
use tauri_plugin_global_shortcut::GlobalShortcutExt;

pub struct Request {
    pub operation: Option<Operation>,
    hotkey: Option<Action>,
    pub reply: Option<Sender<Snapshot>>,
}
impl Request {
    pub fn command(operation: Operation, reply: Option<Sender<Snapshot>>) -> Self {
        Self {
            operation: Some(operation),
            hotkey: None,
            reply,
        }
    }
    pub fn hotkey(action: Action) -> Self {
        Self {
            operation: None,
            hotkey: Some(action),
            reply: None,
        }
    }
    fn is_preview(&self) -> bool {
        matches!(self.operation, Some(Operation::Preview(_)))
    }
}
fn coalesce_previews(
    mut request: Request,
    rx: &Receiver<Request>,
) -> (Request, Vec<Sender<Snapshot>>, Option<Request>) {
    let mut replies = Vec::new();
    if request.is_preview() {
        while let Ok(next) = rx.try_recv() {
            // Off, restore, hotkeys and display/preset switches must stay ordered.
            if !next.is_preview() {
                return (request, replies, Some(next));
            }
            if let Some(reply) = request.reply.take() {
                replies.push(reply);
            }
            request = next;
        }
    }
    (request, replies, None)
}
#[derive(Clone)]
pub struct Shared {
    pub tx: Sender<Request>,
    pub snapshot: Arc<Mutex<Snapshot>>,
    pub exiting: Arc<AtomicBool>,
    pub root: PathBuf,
}
impl Shared {
    pub fn read(&self) -> Snapshot {
        self.snapshot
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }
    pub fn send(&self, operation: Operation) {
        let _ = self.tx.send(Request::command(operation, None));
    }
    pub fn enqueue(&self, operation: Operation) -> Result<Receiver<Snapshot>, String> {
        let (tx, rx) = mpsc::channel();
        self.tx
            .send(Request::command(operation, Some(tx)))
            .map_err(|e| e.to_string())?;
        Ok(rx)
    }
}
struct Engine {
    capturing_shortcut: bool,
    app: tauri::AppHandle,
    shared: Shared,
    store: Storage,
    state: Snapshot,
    displays: Vec<native::Display>,
    session: Option<Recovery>,
    expected_gamma: Option<tone::Ramp>,
    last_hardware: BTreeMap<String, u32>,
    drafts: HashMap<String, Profile>,
}

pub fn start(app: &tauri::AppHandle) -> Result<Shared, String> {
    let root = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let store = Storage::new(root.clone())?;
    let (config, error) = match store.load() {
        Ok(config) => (config, None),
        Err(e) => {
            let stamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs();
            let _ = std::fs::copy(
                root.join("config.json"),
                root.join(format!("config.backup-{stamp}.json")),
            );
            (
                Config::default(),
                Some(format!(
                    "Configuration could not be loaded; original backed up. {e}"
                )),
            )
        }
    };
    let state = Snapshot {
        revision: 0,
        draft: config.current(),
        config,
        displays: vec![],
        enabled: false,
        comparing: false,
        busy: true,
        error,
        warnings: vec![],
        shortcut_errors: vec![],
        recovery_pending: root.join("recovery.json").exists(),
        reason: "startup".into(),
    };
    let (tx, rx) = mpsc::channel();
    let shared = Shared {
        tx,
        snapshot: Arc::new(Mutex::new(state.clone())),
        exiting: Arc::new(AtomicBool::new(false)),
        root,
    };
    let worker_shared = shared.clone();
    let handle = app.clone();
    std::thread::Builder::new()
        .name("display-control".into())
        .spawn(move || {
            let mut engine = Engine {
                capturing_shortcut: false,
                app: handle,
                shared: worker_shared,
                store,
                state,
                displays: vec![],
                session: None,
                expected_gamma: None,
                last_hardware: BTreeMap::new(),
                drafts: HashMap::new(),
            };
            engine.displays = native::enumerate();
            engine.ensure_display();
            engine.state.shortcut_errors =
                shortcuts::register(&engine.app, &engine.state.config, &engine.shared.tx);
            engine
                .store
                .log("Display worker ready; capabilities read without applying effects");
            let apply = engine.state.config.settings.apply_last_on_start
                && !engine.state.recovery_pending
                && std::env::var_os("LUMASHIFT_SAFE_START").is_none();
            if apply {
                if let Err(e) = engine.handle(Operation::SetEnabled(true)) {
                    engine.state.error = Some(e);
                }
            }
            engine.state.busy = false;
            engine.publish("ready");
            engine.run(rx);
        })
        .map_err(|e| e.to_string())?;
    Ok(shared)
}

impl Engine {
    fn publish(&mut self, reason: &str) {
        self.state.displays = self.displays.iter().map(|d| d.info.clone()).collect();
        self.state.revision += 1;
        self.state.reason = reason.into();
        *self
            .shared
            .snapshot
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = self.state.clone();
        let _ = self.app.emit("state-changed", &self.state);
    }
    fn ensure_display(&mut self) {
        if !self
            .displays
            .iter()
            .any(|d| Some(&d.info.id) == self.state.config.selected_display.as_ref())
        {
            self.state.config.selected_display = self.displays.first().map(|d| d.info.id.clone());
        }
    }
    fn index(&self) -> Result<usize, String> {
        self.displays
            .iter()
            .position(|d| Some(&d.info.id) == self.state.config.selected_display.as_ref())
            .ok_or_else(|| "No connected display selected".into())
    }
    fn run(&mut self, rx: Receiver<Request>) {
        let mut pending = None;
        let mut topology = native::topology_signature();
        loop {
            let request = if let Some(item) = pending.take() {
                item
            } else {
                match rx.recv_timeout(Duration::from_secs(4)) {
                    Ok(item) => item,
                    Err(mpsc::RecvTimeoutError::Disconnected) => {
                        let _ = self.restore(true);
                        break;
                    }
                    Err(mpsc::RecvTimeoutError::Timeout) => {
                        let now = native::topology_signature();
                        if now != topology {
                            topology = now;
                            self.state.busy = true;
                            self.publish("busy");
                            self.displays = native::enumerate();
                            if let Err(e) = self.restore(true) {
                                self.state.error = Some(e);
                                self.state.recovery_pending = true;
                            }
                            self.state.enabled = false;
                            self.state.comparing = false;
                            self.ensure_display();
                            self.state.warnings =
                                vec!["Display configuration changed; effects paused".into()];
                            self.state.busy = false;
                            self.publish("topology");
                        } else if self.state.enabled && !self.state.comparing {
                            if let (Some(expected), Ok(index)) =
                                (self.expected_gamma.as_ref(), self.index())
                            {
                                if self.displays[index]
                                    .read_gamma()
                                    .is_ok_and(|actual| !tone::matches(expected, &actual))
                                {
                                    self.state.enabled = false;
                                    if let Err(e) = self.restore(true) {
                                        self.state.error = Some(e);
                                        self.state.recovery_pending = true;
                                    }
                                    self.state.warnings = vec!["Another application or the display driver replaced the Gamma curve; effects paused".into()];
                                    self.publish("interrupted");
                                }
                            }
                        }
                        continue;
                    }
                }
            };
            let (request, superseded, next) = coalesce_previews(request, &rx);
            pending = next;
            let from_hotkey = request.hotkey.is_some();
            let operation = request.operation.unwrap_or_else(|| {
                shortcuts::resolve(
                    request.hotkey.unwrap(),
                    &self.state.config,
                    self.state.enabled,
                )
            });
            if matches!(operation, Operation::CaptureShortcut(false)) && !self.capturing_shortcut {
                if let Some(reply) = request.reply {
                    let _ = reply.send(self.state.clone());
                }
                continue;
            }
            let reason = match &operation {
                Operation::SelectPreset(_)
                | Operation::CreatePreset(_)
                | Operation::DeletePreset(_)
                | Operation::Import { .. } => "profile",
                Operation::Preview(_) => "preview",
                Operation::SavePreset(_) => "saved",
                _ => "updated",
            };
            self.state.busy = true;
            self.state.error = None;
            self.state.warnings.clear();
            self.publish("busy");
            if let Err(error) = self.handle(operation) {
                self.store.log(&error);
                self.state.error = Some(error);
                if from_hotkey {
                    if let Some(window) = self.app.get_webview_window("main") {
                        let _ = window.show();
                    }
                }
            }
            self.state.busy = false;
            self.publish(reason);
            if let Some(reply) = request.reply {
                let _ = reply.send(self.state.clone());
            }
            for reply in superseded {
                let _ = reply.send(self.state.clone());
            }
            if self.shared.exiting.load(Ordering::SeqCst) {
                self.app.exit(0);
                break;
            }
        }
    }
    fn apply(&mut self) -> Result<(), String> {
        if !self.state.enabled || self.state.comparing {
            return Ok(());
        }
        if let Err(error) = self.apply_inner() {
            self.state.enabled = false;
            self.state.comparing = false;
            let had_session = self.session.is_some();
            return match self.restore(true) {
                Ok(()) if had_session => Err(format!("{error}. Original settings restored.")),
                Ok(()) => Err(error),
                Err(restore) => {
                    self.state.recovery_pending = true;
                    Err(format!("{error}. Restore incomplete: {restore}"))
                }
            };
        }
        Ok(())
    }
    fn apply_inner(&mut self) -> Result<(), String> {
        self.state.draft.validate()?;
        if self.state.recovery_pending {
            return Err("Restore the previous display session before applying new effects".into());
        }
        let index = self.index()?;
        if self.session.is_none() {
            let original = if self.displays[index].info.gamma_available {
                self.displays[index].read_gamma()?
            } else {
                tone::identity()
            };
            self.session = Some(Recovery {
                version: 1,
                display_id: self.displays[index].info.id.clone(),
                device: self.displays[index].info.device.clone(),
                gamma: original.into_iter().flatten().collect(),
                gamma_changed: false,
                hardware: BTreeMap::new(),
            });
        }
        let mut baseline = self.session.clone().unwrap();
        let desired_gamma = if self.displays[index].info.gamma_available {
            Some(tone::build(&baseline.ramp()?, &self.state.draft.tone))
        } else {
            if self.state.draft.tone != Tone::default() {
                self.state.warnings.push("Gamma unavailable: HDR/advanced color, unknown color mode, or driver limitation".into());
            }
            None
        };
        let original_ramp = baseline.ramp()?;
        let gamma_dirty = desired_gamma
            .as_ref()
            .is_some_and(|r| self.expected_gamma.as_ref().unwrap_or(&original_ramp) != r);
        if gamma_dirty {
            baseline.gamma_changed = true;
        }
        let mut targets = BTreeMap::new();
        for (key, percent) in &self.state.draft.hardware {
            if !self.displays[index].supported(key) {
                self.state
                    .warnings
                    .push(format!("{key}: unavailable on this display; skipped"));
                continue;
            }
            if !baseline.hardware.contains_key(key) {
                match self.displays[index].read_vcp(key) {
                    Ok((current, _)) => {
                        baseline.hardware.insert(key.clone(), current);
                        self.last_hardware.insert(key.clone(), current);
                    }
                    Err(e) => {
                        self.state.warnings.push(e);
                        continue;
                    }
                }
            }
            let max = self.displays[index]
                .info
                .features
                .iter()
                .find(|f| f.key == *key)
                .unwrap()
                .max;
            targets.insert(
                key.clone(),
                (*percent as f64 / 100.0 * max as f64).round() as u32,
            );
        }
        for (key, original) in &baseline.hardware {
            targets.entry(key.clone()).or_insert(*original);
        }
        self.store.journal(&baseline)?; // Persist originals BEFORE any write can occur.
        self.session = Some(baseline);
        if gamma_dirty {
            self.displays[index].write_gamma(desired_gamma.as_ref().unwrap())?;
            self.expected_gamma = desired_gamma;
        }
        for (key, value) in targets {
            if self.last_hardware.get(&key) == Some(&value) {
                continue;
            }
            self.displays[index].write_raw(&key, value)?;
            self.last_hardware.insert(key, value);
        }
        Ok(())
    }
    fn restore_record(&mut self, record: &Recovery) -> Result<(), String> {
        if !record.gamma_changed && record.hardware.is_empty() {
            return Ok(());
        }
        let index = self
            .displays
            .iter()
            .position(|d| d.info.id == record.display_id)
            .ok_or("Original display is disconnected; recovery record retained")?;
        let mut errors = Vec::new();
        if record.gamma_changed {
            if !self.displays[index].info.gamma_available {
                errors.push("Gamma restoration requires the original SDR display mode".into());
            } else if let Err(e) = self.displays[index].write_gamma(&record.ramp()?) {
                errors.push(e);
            }
        }
        for (key, value) in &record.hardware {
            if let Err(e) = self.displays[index].write_raw(key, *value) {
                errors.push(e);
            }
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors.join("; "))
        }
    }
    fn restore(&mut self, clear: bool) -> Result<(), String> {
        if let Some(record) = self.session.clone() {
            self.restore_record(&record)?;
            self.store.clear_recovery()?;
            self.expected_gamma = None;
            self.last_hardware.clear();
            if clear {
                self.session = None;
                self.state.recovery_pending = false;
            }
        }
        Ok(())
    }
    fn save_config(&mut self, config: Config) -> Result<(), String> {
        config.validate()?;
        shortcuts::bindings(&config)?;
        if !self.capturing_shortcut {
            shortcuts::replace(&self.app, &self.state.config, &config, &self.shared.tx)?;
        }
        if let Err(error) = self.store.save(&config) {
            if !self.capturing_shortcut {
                let _ = shortcuts::replace(&self.app, &config, &self.state.config, &self.shared.tx);
            }
            return Err(error);
        }
        self.state.shortcut_errors.clear();
        self.state.config = config;
        Ok(())
    }
    fn handle(&mut self, operation: Operation) -> Result<(), String> {
        match operation {
            Operation::CaptureShortcut(capturing) => {
                if capturing && !self.capturing_shortcut {
                    self.app
                        .global_shortcut()
                        .unregister_all()
                        .map_err(|e| e.to_string())?;
                    self.capturing_shortcut = true;
                } else if !capturing && self.capturing_shortcut {
                    self.capturing_shortcut = false;
                    self.state.shortcut_errors =
                        shortcuts::register(&self.app, &self.state.config, &self.shared.tx);
                }
            }
            Operation::Preview(profile) => {
                profile.validate()?;
                if profile.id != self.state.config.active_preset {
                    return Ok(());
                }
                self.state.draft = profile;
                self.state.draft.shortcut = self.state.config.current().shortcut;
                self.apply()?;
            }
            Operation::SetEnabled(enabled) => {
                if !enabled {
                    self.restore(true)?;
                }
                self.state.enabled = enabled;
                self.state.comparing = false;
                if let Err(e) = self.apply() {
                    self.state.enabled = false;
                    return Err(e);
                }
            }
            Operation::Compare(original) => {
                if original {
                    self.restore(false)?;
                }
                self.state.comparing = original;
                self.apply()?;
            }
            Operation::SelectPreset(id) => {
                let preset = self
                    .state
                    .config
                    .presets
                    .iter()
                    .find(|p| p.id == id)
                    .cloned()
                    .ok_or("Preset not found")?;
                self.drafts
                    .insert(self.state.draft.id.clone(), self.state.draft.clone());
                self.state.draft = self
                    .drafts
                    .get(&id)
                    .cloned()
                    .unwrap_or_else(|| preset.clone());
                self.state.draft.shortcut = preset.shortcut;
                self.state.config.active_preset = id;
                self.store.save(&self.state.config)?;
                self.state.enabled = true;
                self.state.comparing = false;
                if let Err(e) = self.apply() {
                    self.state.enabled = false;
                    return Err(e);
                }
            }
            Operation::SelectDisplay(id) => {
                if !self.displays.iter().any(|d| d.info.id == id) {
                    return Err("Display not found".into());
                }
                self.restore(true)?;
                self.state.enabled = false;
                self.state.comparing = false;
                self.state.config.selected_display = Some(id);
                self.store.save(&self.state.config)?;
            }
            Operation::Refresh => {
                self.restore(true)?;
                self.state.enabled = false;
                self.state.comparing = false;
                self.displays = native::enumerate();
                self.ensure_display();
            }
            Operation::SavePreset(name) => {
                let mut profile = self.state.draft.clone();
                profile.name = name.trim().into();
                profile.shortcut = self.state.config.current().shortcut;
                profile.validate()?;
                let mut config = self.state.config.clone();
                *config
                    .presets
                    .iter_mut()
                    .find(|p| p.id == profile.id)
                    .ok_or("Preset not found")? = profile.clone();
                self.save_config(config)?;
                self.drafts.remove(&profile.id);
                self.state.draft = profile;
            }
            Operation::CreatePreset(name) => {
                let mut profile = self.state.draft.clone();
                profile.id = new_id();
                profile.name = name.trim().into();
                profile.shortcut.clear();
                profile.validate()?;
                let mut config = self.state.config.clone();
                config.active_preset = profile.id.clone();
                config.presets.push(profile.clone());
                self.save_config(config)?;
                self.drafts
                    .insert(self.state.draft.id.clone(), self.state.draft.clone());
                self.state.draft = profile;
            }
            Operation::DeletePreset(id) => {
                let mut config = self.state.config.clone();
                if config.presets.len() <= 1 {
                    return Err("Keep at least one preset".into());
                }
                if id == config.active_preset {
                    self.restore(true)?;
                    self.state.enabled = false;
                }
                config.presets.retain(|p| p.id != id);
                if config.active_preset == id {
                    config.active_preset = config.presets[0].id.clone();
                }
                self.save_config(config)?;
                self.drafts.remove(&id);
                if self.state.draft.id == id {
                    self.state.draft = self
                        .drafts
                        .get(&self.state.config.active_preset)
                        .cloned()
                        .unwrap_or_else(|| self.state.config.current());
                    self.state.draft.shortcut = self.state.config.current().shortcut;
                    self.state.comparing = false;
                }
            }
            Operation::SaveConfig(mut config) => {
                // Settings/shortcut edits cannot silently switch the actual display or preset.
                config.active_preset = self.state.config.active_preset.clone();
                config.selected_display = self.state.config.selected_display.clone();
                self.save_config(config)?;
                self.state.draft.shortcut = self.state.config.current().shortcut;
            }
            Operation::Import { json, scope } => {
                if json.len() > 1_000_000 {
                    return Err("Import exceeds 1 MB".into());
                }
                let mut config = if scope == "all" {
                    serde_json::from_str::<Config>(&json).map_err(|e| e.to_string())?
                } else {
                    #[derive(serde::Deserialize)]
                    struct Presets {
                        version: u32,
                        presets: Vec<Profile>,
                    }
                    let imported: Presets =
                        serde_json::from_str(&json).map_err(|e| e.to_string())?;
                    if imported.version != 1 {
                        return Err("Unsupported preset format".into());
                    }
                    let mut config = self.state.config.clone();
                    for mut preset in imported.presets {
                        preset.validate()?;
                        preset.id = new_id();
                        preset.shortcut.clear();
                        config.presets.push(preset);
                    }
                    config
                };
                config.validate()?;
                shortcuts::bindings(&config)?;
                self.restore(true)?;
                self.state.enabled = false;
                self.state.comparing = false;
                if !self
                    .displays
                    .iter()
                    .any(|d| Some(&d.info.id) == config.selected_display.as_ref())
                {
                    config.selected_display = self.state.config.selected_display.clone();
                }
                self.save_config(config)?;
                self.drafts.clear();
                self.state.draft = self.state.config.current();
            }
            Operation::Recover => {
                let record = self.store.recovery()?.ok_or("No recovery record found")?;
                self.restore_record(&record)?;
                self.store.clear_recovery()?;
                self.session = None;
                self.expected_gamma = None;
                self.last_hardware.clear();
                self.state.recovery_pending = false;
                self.state.enabled = false;
                self.state.comparing = false;
            }
            Operation::Quit => {
                if self.state.recovery_pending && self.session.is_none() {
                    self.handle(Operation::Recover)?;
                }
                if let Err(e) = self.restore(true) {
                    self.state.recovery_pending = true;
                    if let Some(window) = self.app.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                    return Err(format!("Could not restore before exit: {e}"));
                }
                self.shared.exiting.store(true, Ordering::SeqCst);
            }
            Operation::ForceQuit => {
                self.store
                    .log("Explicit exit with recovery record retained");
                self.shared.exiting.store(true, Ordering::SeqCst);
            }
        }
        Ok(())
    }
}
fn new_id() -> String {
    format!(
        "preset-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    fn preview(gamma: f64) -> Request {
        let mut profile = Config::default().current();
        profile.tone.gamma = gamma;
        Request::command(Operation::Preview(profile), None)
    }
    #[test]
    fn newer_previews_never_cross_an_off_barrier() {
        let (tx, rx) = mpsc::channel();
        tx.send(preview(1.2)).unwrap();
        tx.send(Request::command(Operation::SetEnabled(false), None))
            .unwrap();
        tx.send(preview(1.5)).unwrap();
        let (latest, _, barrier) = coalesce_previews(preview(1.1), &rx);
        assert!(matches!(latest.operation, Some(Operation::Preview(p)) if p.tone.gamma == 1.2));
        assert!(matches!(
            barrier.unwrap().operation,
            Some(Operation::SetEnabled(false))
        ));
        assert!(
            matches!(rx.try_recv().unwrap().operation, Some(Operation::Preview(p)) if p.tone.gamma == 1.5)
        );
    }
    #[test]
    fn hotkeys_are_barriers_and_superseded_callers_keep_a_reply() {
        let (tx, rx) = mpsc::channel();
        let (reply, _response) = mpsc::channel();
        let mut first = preview(1.1);
        first.reply = Some(reply);
        tx.send(preview(1.2)).unwrap();
        tx.send(Request::hotkey(Action::Cycle)).unwrap();
        let (_, replies, barrier) = coalesce_previews(first, &rx);
        assert_eq!(replies.len(), 1);
        assert!(barrier.unwrap().hotkey.is_some());
    }
}
