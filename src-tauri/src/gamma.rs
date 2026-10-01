use crate::{
    model::{DisplayInfo, Tone},
    native, recovery,
    storage::{Recovery, Storage},
    tone::{self, Ramp},
};
use std::collections::BTreeMap;

#[cfg(test)]
mod tests;

pub trait Target: recovery::Target {
    fn info(&self) -> &DisplayInfo;
    fn read(&mut self) -> Result<Ramp, String>;
    fn write(&mut self, ramp: &Ramp) -> Result<(), String>;
}
impl Target for native::Display {
    fn info(&self) -> &DisplayInfo {
        &self.info
    }
    fn read(&mut self) -> Result<Ramp, String> {
        self.read_gamma()
    }
    fn write(&mut self, ramp: &Ramp) -> Result<(), String> {
        self.write_gamma(ramp)
    }
}

pub trait Journal {
    fn load(&self) -> Result<Option<Recovery>, String>;
    fn save(&self, record: &Recovery) -> Result<(), String>;
    fn clear(&self) -> Result<(), String>;
    fn log(&self, message: &str);
}
impl Journal for Storage {
    fn load(&self) -> Result<Option<Recovery>, String> {
        self.recovery()
    }
    fn save(&self, record: &Recovery) -> Result<(), String> {
        self.journal(record)
    }
    fn clear(&self) -> Result<(), String> {
        self.clear_recovery()
    }
    fn log(&self, message: &str) {
        Storage::log(self, message);
    }
}

#[derive(Debug, PartialEq)]
pub enum RecoveryError {
    Read(String),
    Restore(String),
}

pub struct GammaSession<J: Journal> {
    journal: J,
    record: Option<Recovery>,
    expected: Option<Ramp>,
    pending: bool,
}
impl<J: Journal> GammaSession<J> {
    pub fn new(journal: J, pending: bool) -> Self {
        Self {
            journal,
            record: None,
            expected: None,
            pending,
        }
    }
    pub fn pending(&self) -> bool {
        self.pending
    }
    pub fn active(&self) -> bool {
        self.record.is_some()
    }

    pub fn prepare(&mut self, targets: &mut [impl Target]) -> Result<(), String> {
        if self.pending {
            let record = self
                .journal
                .load()?
                .ok_or("Gamma recovery record missing")?;
            self.restore_record(&record, targets)?;
            self.reset();
        }
        Ok(())
    }

    pub fn apply(&mut self, target: &mut impl Target, tone: &Tone) -> Result<(), String> {
        let available = target.info().gamma_available;
        if self.record.is_none() {
            let original = if available {
                target.read()?
            } else {
                tone::identity()
            };
            self.record = Some(Recovery {
                version: 1,
                display_id: target.info().id.clone(),
                device: target.info().device.clone(),
                gamma: original.into_iter().flatten().collect(),
                gamma_changed: false,
                hardware: BTreeMap::new(),
            });
        }
        let mut baseline = self.record.clone().unwrap();
        let desired = if available {
            Some(tone::build(&baseline.ramp()?, tone))
        } else {
            None
        };
        let original = baseline.ramp()?;
        let dirty = desired
            .as_ref()
            .is_some_and(|ramp| self.expected.as_ref().unwrap_or(&original) != ramp);
        if dirty {
            baseline.gamma_changed = true;
        }
        self.journal.save(&baseline)?;
        self.record = Some(baseline);
        if dirty {
            self.journal.log("Gamma apply: write begin");
            target.write(desired.as_ref().unwrap())?;
            self.journal.log("Gamma apply: write verified");
            self.expected = desired;
        }
        Ok(())
    }

    pub fn interrupted(&self, target: &mut impl Target) -> bool {
        self.expected.as_ref().is_some_and(|expected| {
            target
                .read()
                .is_ok_and(|actual| !tone::matches(expected, &actual))
        })
    }

    pub fn restore(&mut self, targets: &mut [impl Target]) -> Result<(), String> {
        let record = if self.record.is_some() {
            self.record.clone()
        } else if self.pending {
            self.journal.load()?
        } else {
            None
        };
        if let Some(record) = record {
            self.restore_record(&record, targets)?;
            self.reset();
        }
        Ok(())
    }

    pub fn recover(&mut self, targets: &mut [impl Target]) -> Result<(), RecoveryError> {
        let persisted = self.journal.load().map_err(RecoveryError::Read)?;
        if let Some(record) = self.record.clone().or(persisted) {
            self.restore_record(&record, targets)
                .map_err(RecoveryError::Restore)?;
        }
        self.reset();
        Ok(())
    }

    fn reset(&mut self) {
        self.record = None;
        self.expected = None;
        self.pending = false;
    }
    fn restore_record(
        &mut self,
        record: &Recovery,
        targets: &mut [impl Target],
    ) -> Result<(), String> {
        self.journal.log(&format!(
            "Gamma recovery begin; gamma_changed={}",
            record.gamma_changed
        ));
        let target = targets
            .iter_mut()
            .find(|target| target.info().id == record.display_id);
        let (remaining, mut errors) = recovery::remaining(record, target);
        self.journal
            .log(&format!("Gamma recovery result: {errors:?}"));
        if errors.is_empty() {
            match self.journal.clear() {
                Ok(()) => return Ok(()),
                Err(error) => errors.push(format!("Could not clear recovery record: {error}")),
            }
        }
        self.record = Some(match self.journal.save(&remaining) {
            Ok(()) => remaining,
            Err(error) => {
                errors.push(format!("Could not save recovery progress: {error}"));
                record.clone()
            }
        });
        self.pending = true;
        self.expected = None;
        Err(errors.join("; "))
    }
}
