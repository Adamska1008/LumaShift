use super::*;
use std::{cell::RefCell, rc::Rc};

#[derive(Default)]
struct JournalState {
    record: Option<Recovery>,
    fail_save: bool,
    fail_clear: bool,
    fail_load: bool,
    events: Vec<&'static str>,
}
#[derive(Clone, Default)]
struct MemoryJournal(Rc<RefCell<JournalState>>);
impl Journal for MemoryJournal {
    fn load(&self) -> Result<Option<Recovery>, String> {
        let state = self.0.borrow();
        if state.fail_load {
            Err("read failed".into())
        } else {
            Ok(state.record.clone())
        }
    }
    fn save(&self, record: &Recovery) -> Result<(), String> {
        let mut state = self.0.borrow_mut();
        if state.fail_save {
            return Err("journal failed".into());
        }
        state.record = Some(record.clone());
        state.events.push("journal");
        Ok(())
    }
    fn clear(&self) -> Result<(), String> {
        let mut state = self.0.borrow_mut();
        if state.fail_clear {
            return Err("clear failed".into());
        }
        state.record = None;
        state.events.push("clear");
        Ok(())
    }
    fn log(&self, _: &str) {}
}
struct Display {
    info: DisplayInfo,
    actual: Ramp,
    fail_read: bool,
    fail_write: bool,
    journal: MemoryJournal,
    durable_path: Option<std::path::PathBuf>,
}
impl Display {
    fn new(id: &str, journal: MemoryJournal) -> Self {
        Self {
            info: DisplayInfo {
                id: id.into(),
                name: id.into(),
                device: id.into(),
                primary: true,
                hdr: Some(false),
                gamma_available: true,
                features: vec![],
            },
            actual: tone::identity(),
            fail_read: false,
            fail_write: false,
            journal,
            durable_path: None,
        }
    }
}
impl recovery::Target for Display {
    fn restore_gamma(&mut self, ramp: &Ramp) -> Result<(), String> {
        if !self.info.gamma_available {
            return Err("Gamma restoration requires the original SDR display mode".into());
        }
        self.write(ramp)
    }
    fn restore_hardware(&mut self, _: &str, _: u32) -> Result<(), String> {
        Ok(())
    }
}
impl Target for Display {
    fn info(&self) -> &DisplayInfo {
        &self.info
    }
    fn read(&mut self) -> Result<Ramp, String> {
        if self.fail_read {
            Err("read failed".into())
        } else {
            Ok(self.actual)
        }
    }
    fn write(&mut self, ramp: &Ramp) -> Result<(), String> {
        if let Some(path) = &self.durable_path {
            let record: Recovery =
                serde_json::from_slice(&std::fs::read(path).map_err(|e| e.to_string())?)
                    .map_err(|e| e.to_string())?;
            record.ramp()?;
        }
        self.journal.0.borrow_mut().events.push("write");
        if self.fail_write {
            return Err("write failed".into());
        }
        self.actual = *ramp;
        Ok(())
    }
}
fn boosted() -> Tone {
    Tone {
        gamma: 2.0,
        ..Tone::default()
    }
}

#[test]
fn actual_storage_journal_survives_restart_and_is_removed_only_after_restore() {
    let directory = std::env::temp_dir().join(format!(
        "lumashift-gamma-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let store = Storage::new(directory.clone()).unwrap();
    let mut session = GammaSession::new(store.clone(), false);
    let mut targets = [Display::new("A", MemoryJournal::default())];
    targets[0].durable_path = Some(directory.join("recovery.json"));
    session.apply(&mut targets[0], &boosted()).unwrap();
    assert_eq!(targets[0].actual[0][128], 46431);
    let stored = store.recovery().unwrap().unwrap();
    assert_eq!(stored.gamma[128], 32896);
    assert!(stored.gamma_changed);
    drop(session);
    let mut restarted = GammaSession::new(store.clone(), true);
    restarted.prepare(&mut targets).unwrap();
    assert_eq!(targets[0].actual[0][128], 32896);
    assert!(store.recovery().unwrap().is_none());
    assert!(!restarted.pending());
    std::fs::remove_dir_all(directory).unwrap();
}
#[test]
fn failed_apply_keeps_a_durable_original_for_restore_and_retry() {
    let journal = MemoryJournal::default();
    let mut session = GammaSession::new(journal.clone(), false);
    let mut targets = [Display::new("A", journal.clone())];
    targets[0].fail_write = true;
    assert_eq!(
        session.apply(&mut targets[0], &boosted()),
        Err("write failed".into())
    );
    assert_eq!(targets[0].actual[0][128], 32896);
    assert!(journal.0.borrow().record.as_ref().unwrap().gamma_changed);
    assert_eq!(
        journal.0.borrow().record.as_ref().unwrap().gamma[128],
        32896
    );
    targets[0].fail_write = false;
    session.restore(&mut targets).unwrap();
    assert_eq!(targets[0].actual[0][128], 32896);
    assert!(!session.active());
    session.apply(&mut targets[0], &boosted()).unwrap();
    assert_eq!(targets[0].actual[0][128], 46431);
}
#[test]
fn neutral_preserves_existing_calibration_and_restore_returns_to_that_calibration() {
    let journal = MemoryJournal::default();
    let mut session = GammaSession::new(journal.clone(), false);
    let mut targets = [Display::new("A", journal.clone())];
    for value in &mut targets[0].actual[2] {
        *value /= 2;
    }
    session.apply(&mut targets[0], &Tone::default()).unwrap();
    assert_eq!(targets[0].actual[2][128], 16448);
    assert_eq!(journal.0.borrow().events, vec!["journal"]);
    session.apply(&mut targets[0], &boosted()).unwrap();
    assert_eq!(targets[0].actual[0][128], 46431);
    session.restore(&mut targets).unwrap();
    assert_eq!(targets[0].actual[0][128], 32896);
    assert_eq!(targets[0].actual[2][128], 16448);
}
#[test]
fn journals_originals_before_writing_and_restores_them_exactly() {
    let journal = MemoryJournal::default();
    let mut session = GammaSession::new(journal.clone(), false);
    let mut targets = [Display::new("A", journal.clone())];
    assert_eq!(session.apply(&mut targets[0], &boosted()), Ok(()));
    assert_eq!(targets[0].actual[0][128], 46431);
    assert_eq!(journal.0.borrow().events, vec!["journal", "write"]);
    let record = journal.0.borrow().record.clone().unwrap();
    assert_eq!(record.gamma[128], 32896);
    assert!(record.gamma_changed);
    session.restore(&mut targets).unwrap();
    assert_eq!(targets[0].actual[0][128], 32896);
    assert_eq!(
        journal.0.borrow().events,
        vec!["journal", "write", "write", "clear"]
    );
    assert!(!session.active());
    assert!(!session.pending());
}
#[test]
fn journal_failure_never_changes_the_display() {
    let journal = MemoryJournal::default();
    journal.0.borrow_mut().fail_save = true;
    let mut session = GammaSession::new(journal.clone(), false);
    let mut target = Display::new("A", journal.clone());
    assert_eq!(
        session.apply(&mut target, &boosted()),
        Err("journal failed".into())
    );
    assert_eq!(target.actual[0][128], 32896);
    assert!(journal.0.borrow().events.is_empty());
    journal.0.borrow_mut().fail_save = false;
    session.apply(&mut target, &boosted()).unwrap();
    assert_eq!(target.actual[0][128], 46431);
}
#[test]
fn updates_use_original_calibration_instead_of_compounding() {
    let journal = MemoryJournal::default();
    let mut session = GammaSession::new(journal.clone(), false);
    let mut target = Display::new("A", journal.clone());
    session.apply(&mut target, &boosted()).unwrap();
    session.apply(&mut target, &boosted()).unwrap();
    assert_eq!(target.actual[0][128], 46431);
    assert_eq!(
        journal.0.borrow().events,
        vec!["journal", "write", "journal"]
    );
    session.apply(&mut target, &Tone::default()).unwrap();
    assert_eq!(target.actual[0][128], 32896);
    assert!(journal.0.borrow().record.as_ref().unwrap().gamma_changed);
}
#[test]
fn failed_restore_keeps_originals_and_can_retry() {
    let journal = MemoryJournal::default();
    let mut session = GammaSession::new(journal.clone(), false);
    let mut targets = [Display::new("A", journal.clone())];
    session.apply(&mut targets[0], &boosted()).unwrap();
    targets[0].fail_write = true;
    assert_eq!(session.restore(&mut targets), Err("write failed".into()));
    assert!(session.pending());
    assert_eq!(targets[0].actual[0][128], 46431);
    assert_eq!(
        journal.0.borrow().record.as_ref().unwrap().gamma[128],
        32896
    );
    assert!(!session.interrupted(&mut targets[0]));
    targets[0].fail_write = false;
    session.restore(&mut targets).unwrap();
    assert_eq!(targets[0].actual[0][128], 32896);
    assert!(!session.pending());
}
#[test]
fn failed_progress_persistence_retains_full_record_in_memory_and_on_disk() {
    let journal = MemoryJournal::default();
    let mut session = GammaSession::new(journal.clone(), false);
    let mut targets = [Display::new("A", journal.clone())];
    session.apply(&mut targets[0], &boosted()).unwrap();
    journal.0.borrow_mut().fail_clear = true;
    journal.0.borrow_mut().fail_save = true;
    assert_eq!(session.restore(&mut targets), Err("Could not clear recovery record: clear failed; Could not save recovery progress: journal failed".into()));
    assert_eq!(targets[0].actual[0][128], 32896);
    assert!(journal.0.borrow().record.as_ref().unwrap().gamma_changed);
    assert!(session.pending());
    journal.0.borrow_mut().fail_clear = false;
    journal.0.borrow_mut().fail_save = false;
    session.restore(&mut targets).unwrap();
    assert_eq!(targets[0].actual[0][128], 32896);
    assert!(!session.active());
}
#[test]
fn failed_clear_persists_verified_progress_and_retry_does_not_rewrite() {
    let journal = MemoryJournal::default();
    let mut session = GammaSession::new(journal.clone(), false);
    let mut targets = [Display::new("A", journal.clone())];
    session.apply(&mut targets[0], &boosted()).unwrap();
    journal.0.borrow_mut().fail_clear = true;
    assert!(session.restore(&mut targets).is_err());
    assert_eq!(targets[0].actual[0][128], 32896);
    assert!(!journal.0.borrow().record.as_ref().unwrap().gamma_changed);
    journal.0.borrow_mut().fail_clear = false;
    session.restore(&mut targets).unwrap();
    assert_eq!(
        journal.0.borrow().events,
        vec!["journal", "write", "write", "journal", "clear"]
    );
}
#[test]
fn restart_recovery_requires_original_display_and_preserves_disconnected_work() {
    let journal = MemoryJournal::default();
    let mut first = GammaSession::new(journal.clone(), false);
    let mut targets = [Display::new("A", journal.clone())];
    first.apply(&mut targets[0], &boosted()).unwrap();
    let mut restarted = GammaSession::new(journal.clone(), true);
    assert_eq!(
        restarted.prepare(&mut [] as &mut [Display]),
        Err("Original display is disconnected; recovery record retained".into())
    );
    assert!(restarted.pending());
    assert_eq!(
        journal.0.borrow().record.as_ref().unwrap().gamma[128],
        32896
    );
    restarted.prepare(&mut targets).unwrap();
    assert_eq!(targets[0].actual[0][128], 32896);
    assert!(!restarted.pending());
    restarted.apply(&mut targets[0], &boosted()).unwrap();
    assert_eq!(targets[0].actual[0][128], 46431);
    assert_eq!(
        journal.0.borrow().record.as_ref().unwrap().gamma[128],
        32896
    );
}
#[test]
fn unavailable_gamma_records_no_changes_and_does_not_read_or_write() {
    let journal = MemoryJournal::default();
    let mut session = GammaSession::new(journal.clone(), false);
    let mut targets = [Display::new("A", journal.clone())];
    targets[0].info.gamma_available = false;
    targets[0].fail_read = true;
    assert_eq!(session.apply(&mut targets[0], &boosted()), Ok(()));
    assert_eq!(journal.0.borrow().events, vec!["journal"]);
    assert!(!journal.0.borrow().record.as_ref().unwrap().gamma_changed);
    session.restore(&mut targets).unwrap();
    assert_eq!(targets[0].actual[0][128], 32896);
    assert!(!session.active());
}
#[test]
fn interruption_checks_ignore_read_failures_but_detect_external_changes() {
    let journal = MemoryJournal::default();
    let mut session = GammaSession::new(journal.clone(), false);
    let mut target = Display::new("A", journal);
    session.apply(&mut target, &boosted()).unwrap();
    assert!(!session.interrupted(&mut target));
    target.actual[0][128] = 1000;
    assert!(session.interrupted(&mut target));
    target.fail_read = true;
    assert!(!session.interrupted(&mut target));
}
#[test]
fn explicit_recovery_distinguishes_read_failure_and_missing_startup_record() {
    let journal = MemoryJournal::default();
    let mut session = GammaSession::new(journal.clone(), true);
    let mut targets = [Display::new("A", journal.clone())];
    assert_eq!(
        session.prepare(&mut targets),
        Err("Gamma recovery record missing".into())
    );
    assert!(session.pending());
    journal.0.borrow_mut().fail_load = true;
    assert_eq!(
        session.recover(&mut targets),
        Err(RecoveryError::Read("read failed".into()))
    );
    assert_eq!(targets[0].actual[0][128], 32896);
    journal.0.borrow_mut().fail_load = false;
    session.recover(&mut targets).unwrap();
    assert!(!session.pending());
    session.apply(&mut targets[0], &boosted()).unwrap();
    journal.0.borrow_mut().fail_load = true;
    assert_eq!(
        session.recover(&mut targets),
        Err(RecoveryError::Read("read failed".into()))
    );
    assert_eq!(targets[0].actual[0][128], 46431);
    journal.0.borrow_mut().fail_load = false;
    session.restore(&mut targets).unwrap();
    assert_eq!(targets[0].actual[0][128], 32896);
}
