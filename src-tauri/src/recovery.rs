//! Track verified restoration progress without losing any unresolved originals.
use crate::{native::Display, storage::Recovery, tone::Ramp};

pub trait Target {
    fn restore_gamma(&mut self, ramp: &Ramp) -> Result<(), String>;
    fn restore_hardware(&mut self, key: &str, value: u32) -> Result<(), String>;
}
impl Target for Display {
    fn restore_gamma(&mut self, ramp: &Ramp) -> Result<(), String> {
        if !self.info.gamma_available {
            return Err("Gamma restoration requires the original SDR display mode".into());
        }
        self.write_gamma(ramp)
    }
    fn restore_hardware(&mut self, key: &str, value: u32) -> Result<(), String> {
        self.write_raw(key, value)
    }
}

pub fn remaining(record: &Recovery, target: Option<&mut impl Target>) -> (Recovery, Vec<String>) {
    let mut pending = record.clone();
    let mut errors = vec![];
    let ramp = match record.ramp() {
        Ok(ramp) => ramp,
        Err(error) => return (pending, vec![error]),
    };
    if !record.gamma_changed && record.hardware.is_empty() {
        return (pending, errors);
    }
    let Some(target) = target else {
        return (
            pending,
            vec!["Original display is disconnected; recovery record retained".into()],
        );
    };
    if record.gamma_changed {
        match target.restore_gamma(&ramp) {
            Ok(()) => pending.gamma_changed = false,
            Err(error) => errors.push(error),
        }
    }
    for (key, value) in &record.hardware {
        match target.restore_hardware(key, *value) {
            Ok(()) => {
                pending.hardware.remove(key);
            }
            Err(error) => errors.push(error),
        }
    }
    (pending, errors)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    #[derive(Default)]
    struct Fake {
        fail_red: bool,
        gamma_calls: usize,
        hardware_calls: Vec<String>,
    }
    impl Target for Fake {
        fn restore_gamma(&mut self, _: &Ramp) -> Result<(), String> {
            self.gamma_calls += 1;
            Ok(())
        }
        fn restore_hardware(&mut self, key: &str, _: u32) -> Result<(), String> {
            self.hardware_calls.push(key.into());
            if self.fail_red && key == "redGain" {
                Err("redGain: offline".into())
            } else {
                Ok(())
            }
        }
    }
    fn record() -> Recovery {
        Recovery {
            version: 1,
            display_id: "test".into(),
            device: "test".into(),
            gamma: crate::tone::identity().into_iter().flatten().collect(),
            gamma_changed: true,
            hardware: BTreeMap::from([("contrast".into(), 55), ("redGain".into(), 50)]),
        }
    }
    #[test]
    fn partial_restore_and_restart_retry_only_unresolved_controls() {
        let mut display = Fake {
            fail_red: true,
            ..Default::default()
        };
        let (pending, errors) = remaining(&record(), Some(&mut display));
        assert_eq!(errors, vec!["redGain: offline"]);
        assert!(!pending.gamma_changed);
        assert_eq!(pending.hardware, BTreeMap::from([("redGain".into(), 50)]));
        let persisted = serde_json::to_string(&pending).unwrap();
        let reloaded = serde_json::from_str(&persisted).unwrap();
        let mut reconnected = Fake::default();
        let (done, errors) = remaining(&reloaded, Some(&mut reconnected));
        assert!(errors.is_empty());
        assert!(!done.gamma_changed && done.hardware.is_empty());
        assert_eq!(reconnected.gamma_calls, 0);
        assert_eq!(reconnected.hardware_calls, vec!["redGain"]);
    }
    #[test]
    fn disconnected_display_keeps_every_original() {
        let original = record();
        let (pending, errors) = remaining(&original, None::<&mut Fake>);
        assert!(!errors.is_empty());
        assert!(pending.gamma_changed);
        assert_eq!(pending.hardware, original.hardware);
    }
    #[test]
    fn invalid_record_does_not_touch_display() {
        let mut invalid = record();
        invalid.gamma.pop();
        let mut display = Fake::default();
        let (_, errors) = remaining(&invalid, Some(&mut display));
        assert!(!errors.is_empty());
        assert_eq!(display.gamma_calls, 0);
        assert!(display.hardware_calls.is_empty());
    }
}
