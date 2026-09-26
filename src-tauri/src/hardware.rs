//! DDC failures are local to a control; this module never reads or writes Gamma.
use crate::{model::DisplayInfo, native::Display};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, Default, Serialize, Deserialize, PartialEq, Debug)]
pub struct Records {
    pub displays: BTreeMap<String, BTreeMap<String, u32>>,
}
pub trait Target {
    fn supported(&self, key: &str) -> bool;
    fn read(&mut self, key: &str) -> Result<(u32, u32), String>;
    fn write(&mut self, key: &str, value: u32) -> Result<(), String>;
}
impl Target for Display {
    fn supported(&self, key: &str) -> bool {
        self.supported(key)
    }
    fn read(&mut self, key: &str) -> Result<(u32, u32), String> {
        self.read_vcp(key)
    }
    fn write(&mut self, key: &str, value: u32) -> Result<(), String> {
        self.write_raw(key, value)
    }
}

pub struct Control {
    pub records: Records,
    blocked: BTreeMap<(String, String), String>,
    last: BTreeMap<(String, String), u32>,
}
impl Control {
    pub fn new(records: Records) -> Self {
        let blocked = records
            .displays
            .iter()
            .flat_map(|(id, values)| {
                values.keys().map(|key| {
                    (
                        (id.clone(), key.clone()),
                        "Original value retained; use Restore to retry this control".into(),
                    )
                })
            })
            .collect();
        Self {
            records,
            blocked,
            last: BTreeMap::new(),
        }
    }
    pub fn pending(&self) -> bool {
        self.records.displays.iter().any(|(id, values)| {
            values
                .keys()
                .any(|key| self.blocked.contains_key(&(id.clone(), key.clone())))
        })
    }
    pub fn decorate(&self, display: &mut DisplayInfo) {
        for feature in &mut display.features {
            if let Some(error) = self.blocked.get(&(display.id.clone(), feature.key.clone())) {
                feature.status = "unavailable".into();
                feature.detail = error.clone();
                feature.value = None;
            }
        }
    }
    pub fn recheck(&mut self) {
        self.blocked.clear();
        self.last.clear();
    }
    fn block(&mut self, id: &str, key: &str, error: String) {
        let pair = (id.to_string(), key.to_string());
        self.last.remove(&pair);
        self.blocked.insert(pair, error);
    }
    pub fn apply(
        &mut self,
        id: &str,
        values: &BTreeMap<String, u32>,
        target: &mut impl Target,
        mut persist: impl FnMut(&Records) -> Result<(), String>,
    ) -> Vec<String> {
        let mut warnings = vec![];
        for (key, percent) in values {
            let pair = (id.to_string(), key.clone());
            if self.blocked.contains_key(&pair) || !target.supported(key) {
                continue;
            }
            if self.last.get(&pair) == Some(percent) {
                continue;
            }
            let result = (|| {
                let (current, max) = target.read(key)?;
                let value = (*percent as f64 / 100.0 * max as f64).round() as u32;
                if current == value {
                    self.last.insert(pair.clone(), *percent);
                    return Ok(());
                }
                let mut next = self.records.clone();
                next.displays
                    .entry(id.into())
                    .or_default()
                    .entry(key.clone())
                    .or_insert(current);
                if next != self.records {
                    persist(&next)?; // Never write a value whose original is not durable.
                    self.records = next;
                }
                target.write(key, value)?;
                self.last.insert(pair.clone(), *percent);
                Ok::<(), String>(())
            })();
            if let Err(error) = result {
                self.block(id, key, error.clone());
                warnings.push(format!(
                    "{key}: hardware control paused; Gamma remains available. {error}"
                ));
            }
        }
        // Missing keys deliberately mean 'leave unchanged', including Gamma-only presets.
        warnings
    }
    pub fn restore(
        &mut self,
        id: &str,
        target: Option<&mut impl Target>,
        retry_blocked: bool,
        mut persist: impl FnMut(&Records) -> Result<(), String>,
    ) -> Vec<String> {
        let Some(values) = self.records.displays.get(id).cloned() else {
            return vec![];
        };
        let mut warnings = vec![];
        let mut target = target;
        for (key, value) in values {
            let pair = (id.to_string(), key.clone());
            if !retry_blocked && self.blocked.contains_key(&pair) {
                continue;
            }
            let restored = match target.as_deref_mut() {
                Some(target) => target.write(&key, value),
                None => Err("Original monitor disconnected; hardware original retained".into()),
            };
            let result = restored.and_then(|()| {
                let mut next = self.records.clone();
                if let Some(values) = next.displays.get_mut(id) {
                    values.remove(&key);
                    if values.is_empty() {
                        next.displays.remove(id);
                    }
                }
                persist(&next)?;
                self.records = next;
                self.blocked.remove(&pair);
                self.last.remove(&pair);
                Ok(())
            });
            if let Err(error) = result {
                self.block(id, &key, error.clone());
                warnings.push(format!("{key}: {error}"));
            }
        }
        warnings
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[derive(Default)]
    struct Fake {
        reads: Vec<String>,
        writes: Vec<(String, u32)>,
        fail_red: bool,
    }
    impl Target for Fake {
        fn supported(&self, key: &str) -> bool {
            key != "saturation"
        }
        fn read(&mut self, key: &str) -> Result<(u32, u32), String> {
            self.reads.push(key.into());
            Ok((50, 100))
        }
        fn write(&mut self, key: &str, value: u32) -> Result<(), String> {
            self.writes.push((key.into(), value));
            if self.fail_red && key == "redGain" {
                Err("DDC offline".into())
            } else {
                Ok(())
            }
        }
    }
    fn values() -> BTreeMap<String, u32> {
        BTreeMap::from([
            ("redGain".into(), 60),
            ("brightness".into(), 70),
            ("saturation".into(), 80),
        ])
    }
    #[test]
    fn failed_control_is_quarantined_and_other_controls_continue() {
        let mut control = Control::new(Records::default());
        let mut display = Fake {
            fail_red: true,
            ..Default::default()
        };
        let mut durable = Records::default();
        let warnings = control.apply("A", &values(), &mut display, |r| {
            durable = r.clone();
            Ok(())
        });
        assert_eq!(warnings.len(), 1);
        assert_eq!(durable.displays["A"]["redGain"], 50);
        assert!(control.pending());
        assert!(!display.reads.contains(&"saturation".into()));
        let before = display.reads.len();
        let mut changed = values();
        changed.insert("brightness".into(), 80);
        control.apply("A", &changed, &mut display, |_| Ok(()));
        assert_eq!(&display.reads[before..], &["brightness"]);
        assert!(display.writes.contains(&("brightness".into(), 80)));
    }
    #[test]
    fn gamma_only_switch_never_writes_or_restores_hardware() {
        let records = Records {
            displays: BTreeMap::from([("A".into(), BTreeMap::from([("redGain".into(), 50)]))]),
        };
        let mut control = Control::new(records.clone());
        let mut display = Fake::default();
        assert!(control
            .apply("A", &BTreeMap::new(), &mut display, |_| panic!(
                "Gamma must not journal DDC"
            ))
            .is_empty());
        control.restore("A", Some(&mut display), false, |_| {
            panic!("blocked controls need explicit retry")
        });
        assert!(display.reads.is_empty() && display.writes.is_empty());
        assert_eq!(control.records, records);
    }
    #[test]
    fn failed_journal_prevents_hardware_write() {
        let mut control = Control::new(Records::default());
        let mut display = Fake::default();
        let warnings = control.apply("A", &values(), &mut display, |_| Err("disk full".into()));
        assert_eq!(warnings.len(), 2);
        assert!(display.writes.is_empty());
        assert!(control.records.displays.is_empty());
    }
    #[test]
    fn explicit_recovery_preserves_other_displays_and_failed_items() {
        let originals = BTreeMap::from([("brightness".into(), 50), ("redGain".into(), 50)]);
        let mut control = Control::new(Records {
            displays: BTreeMap::from([
                ("A".into(), originals.clone()),
                ("B".into(), originals.clone()),
            ]),
        });
        let mut display = Fake {
            fail_red: true,
            ..Default::default()
        };
        let warnings = control.restore("A", Some(&mut display), true, |_| Ok(()));
        assert_eq!(warnings.len(), 1);
        assert_eq!(
            control.records.displays["A"],
            BTreeMap::from([("redGain".into(), 50)])
        );
        assert_eq!(control.records.displays["B"], originals);
        display.fail_red = false;
        control.restore("A", Some(&mut display), true, |_| Ok(()));
        assert!(!control.records.displays.contains_key("A"));
        assert_eq!(control.records.displays["B"], originals);
    }
    #[test]
    fn restore_persistence_failure_retains_original() {
        let originals = Records {
            displays: BTreeMap::from([("A".into(), BTreeMap::from([("redGain".into(), 50)]))]),
        };
        let mut control = Control::new(originals.clone());
        let warnings = control.restore("A", Some(&mut Fake::default()), true, |_| {
            Err("disk full".into())
        });
        assert_eq!(warnings.len(), 1);
        assert_eq!(control.records, originals);
        assert!(control.pending());
    }
}
