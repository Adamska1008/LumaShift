use crate::storage::atomic_json;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

pub type Matrix = [[f32; 5]; 5];

pub fn identity() -> Matrix {
    std::array::from_fn(|i| std::array::from_fn(|j| if i == j { 1.0 } else { 0.0 }))
}

pub fn matrix(value: f64) -> Matrix {
    let s = (value / 100.0) as f32;
    let mut result = identity();
    for (i, weight) in [0.2126, 0.7152, 0.0722].into_iter().enumerate() {
        for j in 0..3 {
            result[i][j] = (1.0 - s) * weight + if i == j { s } else { 0.0 };
        }
    }
    result
}

fn compose(original: &Matrix, effect: &Matrix) -> Matrix {
    // MAGCOLOREFFECT uses row vectors. Apply saturation after the existing effect.
    std::array::from_fn(|i| {
        std::array::from_fn(|j| (0..5).map(|k| original[i][k] * effect[k][j]).sum())
    })
}

fn matches(a: &Matrix, b: &Matrix) -> bool {
    a.iter()
        .flatten()
        .zip(b.iter().flatten())
        .all(|(a, b)| (a - b).abs() < 0.0001)
}

pub trait Target {
    fn start(&mut self) -> Result<(), String>;
    fn read(&mut self) -> Result<Matrix, String>;
    fn write(&mut self, matrix: Matrix) -> Result<(), String>;
    fn stop(&mut self) -> Result<(), String>;
}

#[derive(Clone, Serialize, Deserialize)]
struct Record {
    version: u32,
    original: Matrix,
    expected: Matrix,
    previous: Matrix,
}
impl Record {
    fn validate(&self) -> Result<(), String> {
        if self.version != 1
            || [&self.original, &self.expected, &self.previous]
                .iter()
                .any(|m| {
                    m.iter()
                        .flatten()
                        .any(|v| !v.is_finite() || v.abs() > 100.0)
                })
        {
            return Err("Invalid color recovery record".into());
        }
        Ok(())
    }
}

pub struct Control<T: Target> {
    target: T,
    path: PathBuf,
    record: Option<Record>,
    pub recovery_pending: bool,
}
impl<T: Target> Control<T> {
    pub fn new(target: T, path: PathBuf) -> Self {
        Self {
            target,
            recovery_pending: path.exists(),
            path,
            record: None,
        }
    }

    pub fn apply(&mut self, value: f64) -> Result<(), String> {
        if !value.is_finite() || !(0.0..=200.0).contains(&value) {
            return Err("Saturation: expected 0…200".into());
        }
        if value == 100.0 {
            return self.restore();
        }
        if self.recovery_pending {
            self.restore()?;
        }
        self.target.start()?;
        let actual = self.target.read()?;
        let mut record = self.record.clone().unwrap_or(Record {
            version: 1,
            original: actual,
            expected: actual,
            previous: actual,
        });
        if !matches(&actual, &record.expected) {
            return Err("Another application replaced the color effect; saturation paused".into());
        }
        let desired = compose(&record.original, &matrix(value));
        if matches(&desired, &record.expected) {
            return Ok(());
        }
        record.previous = actual;
        record.expected = desired;
        record.validate()?;
        // Write originals and both possible output states before touching the desktop.
        atomic_json(&self.path, &record)?;
        self.record = Some(record);
        self.target.write(desired)?;
        if !matches(&self.target.read()?, &desired) {
            return Err("Windows did not retain the saturation matrix".into());
        }
        Ok(())
    }

    pub fn check(&mut self) -> Result<(), String> {
        if let Some(record) = &self.record {
            if !matches(&self.target.read()?, &record.expected) {
                return Err(
                    "Another application replaced the color effect; saturation paused".into(),
                );
            }
        }
        Ok(())
    }

    pub fn restore(&mut self) -> Result<(), String> {
        let result = self.restore_inner();
        self.recovery_pending = result.is_err();
        result
    }

    fn restore_inner(&mut self) -> Result<(), String> {
        if self.record.is_none() && self.path.exists() {
            let record: Record =
                serde_json::from_slice(&std::fs::read(&self.path).map_err(|e| e.to_string())?)
                    .map_err(|e| e.to_string())?;
            record.validate()?;
            self.record = Some(record);
        }
        if let Some(record) = &self.record {
            self.target.start()?;
            let actual = self.target.read()?;
            // Respect a newer effect from another app (or Windows' reset after a crash).
            if !matches(&actual, &record.original)
                && (matches(&actual, &record.expected) || matches(&actual, &record.previous))
            {
                self.target.write(record.original)?;
                if !matches(&self.target.read()?, &record.original) {
                    return Err("Color effect restoration could not be verified".into());
                }
            }
        }
        self.target.stop()?;
        match std::fs::remove_file(&self.path) {
            Ok(()) => (),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
            Err(e) => return Err(e.to_string()),
        }
        self.record = None;
        Ok(())
    }
}

pub struct WindowsTarget {
    app: tauri::AppHandle,
    initialized: bool,
}
impl WindowsTarget {
    pub fn new(app: tauri::AppHandle) -> Self {
        Self {
            app,
            initialized: false,
        }
    }
    fn call<R: Send + 'static>(
        &self,
        f: impl FnOnce() -> Result<R, String> + Send + 'static,
    ) -> Result<R, String> {
        // Keep the runtime on Tauri's UI thread, which owns the Windows message loop.
        // Called only from the display worker; dispatch itself is asynchronous.
        let (tx, rx) = std::sync::mpsc::channel();
        self.app
            .run_on_main_thread(move || {
                let _ = tx.send(f());
            })
            .map_err(|e| e.to_string())?;
        rx.recv().map_err(|e| e.to_string())?
    }
}
#[cfg(windows)]
impl Target for WindowsTarget {
    fn start(&mut self) -> Result<(), String> {
        if !self.initialized {
            self.call(|| unsafe {
                windows::Win32::UI::Magnification::MagInitialize()
                    .ok()
                    .map_err(|e| format!("MagInitialize: {e}"))
            })?;
            self.initialized = true;
        }
        Ok(())
    }
    fn read(&mut self) -> Result<Matrix, String> {
        self.call(|| unsafe {
            use windows::Win32::UI::Magnification::*;
            let mut effect = MAGCOLOREFFECT::default();
            MagGetFullscreenColorEffect(&mut effect)
                .ok()
                .map_err(|e| format!("MagGetFullscreenColorEffect: {e}"))?;
            Ok(std::array::from_fn(|i| {
                std::array::from_fn(|j| effect.transform[i * 5 + j])
            }))
        })
    }
    fn write(&mut self, matrix: Matrix) -> Result<(), String> {
        self.call(move || unsafe {
            use windows::Win32::UI::Magnification::*;
            let effect = MAGCOLOREFFECT {
                transform: std::array::from_fn(|i| matrix[i / 5][i % 5]),
            };
            MagSetFullscreenColorEffect(&effect)
                .ok()
                .map_err(|e| format!("MagSetFullscreenColorEffect: {e}"))
        })
    }
    fn stop(&mut self) -> Result<(), String> {
        if self.initialized {
            self.call(|| unsafe {
                windows::Win32::UI::Magnification::MagUninitialize()
                    .ok()
                    .map_err(|e| format!("MagUninitialize: {e}"))
            })?;
            self.initialized = false;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    static NEXT: AtomicUsize = AtomicUsize::new(0);

    struct Mock {
        actual: Matrix,
        starts: usize,
        writes: usize,
        fail_write: bool,
        journal: PathBuf,
    }
    impl Target for Mock {
        fn start(&mut self) -> Result<(), String> {
            self.starts += 1;
            Ok(())
        }
        fn read(&mut self) -> Result<Matrix, String> {
            Ok(self.actual)
        }
        fn write(&mut self, matrix: Matrix) -> Result<(), String> {
            assert!(
                self.journal.exists(),
                "Every write needs a recovery journal"
            );
            self.writes += 1;
            if self.fail_write {
                return Err("write failed".into());
            }
            self.actual = matrix;
            Ok(())
        }
        fn stop(&mut self) -> Result<(), String> {
            Ok(())
        }
    }
    struct Temp(PathBuf);
    impl Drop for Temp {
        fn drop(&mut self) {
            for file in ["color.json", "color.json.tmp"] {
                let _ = std::fs::remove_file(self.0.join(file));
            }
            let _ = std::fs::remove_dir(&self.0);
        }
    }
    fn setup(original: Matrix) -> (Control<Mock>, Temp) {
        let dir = std::env::temp_dir().join(format!(
            "lumashift-color-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("color.json");
        (
            Control::new(
                Mock {
                    actual: original,
                    starts: 0,
                    writes: 0,
                    fail_write: false,
                    journal: path.clone(),
                },
                path,
            ),
            Temp(dir),
        )
    }
    fn transform(rgb: [f32; 3], m: Matrix) -> [f32; 3] {
        std::array::from_fn(|j| (0..3).map(|i| rgb[i] * m[i][j]).sum::<f32>() + m[4][j])
    }
    #[test]
    fn neutral_black_white_gray_and_saturation_extremes() {
        assert_eq!(matrix(100.0), identity());
        let gray = transform([1.0, 0.0, 0.0], matrix(0.0));
        assert!(gray.iter().all(|v| (*v - 0.2126).abs() < 0.00001));
        for value in [0.0, 50.0, 100.0, 200.0] {
            for level in [0.0, 0.5, 1.0] {
                assert!(transform([level; 3], matrix(value))
                    .iter()
                    .all(|v| (*v - level).abs() < 0.00001));
            }
        }
        assert!(transform([0.6, 0.4, 0.4], matrix(200.0))[0] > 0.6);
    }
    #[test]
    fn default_never_starts_runtime_and_invalid_values_never_write() {
        let (mut c, _temp) = setup(identity());
        c.apply(100.0).unwrap();
        for invalid in [-1.0, 201.0, f64::NAN, f64::INFINITY] {
            assert!(c.apply(invalid).is_err());
        }
        assert_eq!(c.target.starts, 0);
        assert_eq!(c.target.writes, 0);
    }
    #[test]
    fn repeated_updates_do_not_compound_and_restore_original_matrix() {
        let mut original = identity();
        original[0][0] = 0.9;
        original[4][2] = 0.01;
        let (mut c, _temp) = setup(original);
        c.apply(120.0).unwrap();
        c.apply(120.0).unwrap();
        assert_eq!(c.target.writes, 1);
        c.apply(160.0).unwrap();
        assert!(matches(
            &c.target.actual,
            &compose(&original, &matrix(160.0))
        ));
        c.apply(100.0).unwrap();
        assert_eq!(c.target.actual, original);
        assert!(!c.path.exists());
    }
    #[test]
    fn failed_write_restores_previous_effect_and_failed_restore_keeps_journal() {
        let (mut c, _temp) = setup(identity());
        c.apply(120.0).unwrap();
        c.target.fail_write = true;
        assert!(c.apply(150.0).is_err());
        assert!(c.restore().is_err());
        assert!(c.recovery_pending && c.path.exists());
        c.target.fail_write = false;
        c.restore().unwrap();
        assert_eq!(c.target.actual, identity());
        assert!(!c.recovery_pending);
    }
    #[test]
    fn crash_recovery_restores_original_but_respects_external_changes() {
        let (mut c, _temp) = setup(identity());
        c.apply(140.0).unwrap();
        let path = c.path.clone();
        let mut restarted = Control::new(c.target, path);
        assert!(restarted.recovery_pending);
        restarted.restore().unwrap();
        assert_eq!(restarted.target.actual, identity());
        restarted.apply(130.0).unwrap();
        let external = matrix(80.0);
        restarted.target.actual = external;
        assert!(restarted.check().is_err());
        assert!(restarted.apply(150.0).is_err());
        restarted.restore().unwrap();
        assert_eq!(restarted.target.actual, external);
    }
    #[test]
    fn failed_journal_or_invalid_recovery_never_writes() {
        let (mut c, temp) = setup(identity());
        c.path = temp.0.join("missing").join("color.json");
        assert!(c.apply(120.0).is_err());
        assert_eq!(c.target.writes, 0);
        c.path = temp.0.join("color.json");
        std::fs::write(&c.path, "{}").unwrap();
        assert!(c.restore().is_err());
        assert!(c.recovery_pending);
        assert_eq!(c.target.writes, 0);
    }
}

#[cfg(not(windows))]
impl Target for WindowsTarget {
    fn start(&mut self) -> Result<(), String> {
        Err("Saturation requires Windows".into())
    }
    fn read(&mut self) -> Result<Matrix, String> {
        Err("Saturation requires Windows".into())
    }
    fn write(&mut self, _: Matrix) -> Result<(), String> {
        Err("Saturation requires Windows".into())
    }
    fn stop(&mut self) -> Result<(), String> {
        Ok(())
    }
}
