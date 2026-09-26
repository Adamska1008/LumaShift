//! Bounded retries for continuous VCP controls. Tests never touch a monitor.
use std::time::Duration;

pub trait Transport {
    fn read(&mut self) -> Result<(u32, u32), String>;
    fn write(&mut self, value: u32) -> Result<(), String>;
    fn retry_delay(&self) {
        std::thread::sleep(Duration::from_millis(150));
    }
}

pub fn read(bus: &mut impl Transport) -> Result<(u32, u32), String> {
    let mut error = String::new();
    for attempt in 0..3 {
        if attempt > 0 {
            bus.retry_delay();
        }
        match bus.read() {
            Ok((current, max)) if max > 0 && current <= max => return Ok((current, max)),
            Ok(_) => error = "monitor returned an invalid range".into(),
            Err(e) => error = e,
        }
    }
    Err(format!("{error} (3 read attempts)"))
}

pub fn write_verified(bus: &mut impl Transport, value: u32) -> Result<(u32, u32), String> {
    let mut error = String::new();
    for attempt in 0..3 {
        if attempt > 0 {
            bus.retry_delay();
        }
        let (current, maximum) = read(bus)?;
        if value > maximum {
            return Err("value exceeds monitor range".into());
        }
        // Recovery is idempotent: an already restored value needs no write.
        if current == value {
            return Ok((current, maximum));
        }
        let write_error = bus.write(value).err();
        // Even a failed acknowledgement may have applied the value. Verify
        // before retrying a write, and tolerate delayed readback after success.
        for poll in 0..3 {
            if poll > 0 {
                bus.retry_delay();
            }
            match read(bus) {
                Ok((actual, max)) if actual == value => return Ok((actual, max)),
                Ok((actual, _)) => {
                    error = format!("requested {value}, but read back {actual}");
                }
                Err(e) => error = e,
            }
        }
        if let Some(e) = write_error {
            error = format!("{e}; verification failed: {error}");
        }
    }
    Err(format!("{error} (3 write attempts)"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;

    struct Fake {
        reads: VecDeque<Result<(u32, u32), String>>,
        writes: Vec<u32>,
        write_error: bool,
    }
    impl Transport for Fake {
        fn read(&mut self) -> Result<(u32, u32), String> {
            self.reads.pop_front().unwrap_or(Err("offline".into()))
        }
        fn write(&mut self, value: u32) -> Result<(), String> {
            self.writes.push(value);
            if self.write_error {
                Err("acknowledgement lost".into())
            } else {
                Ok(())
            }
        }
        fn retry_delay(&self) {}
    }
    fn fake(reads: Vec<Result<(u32, u32), String>>) -> Fake {
        Fake {
            reads: reads.into(),
            writes: vec![],
            write_error: false,
        }
    }
    #[test]
    fn transient_read_failure_is_retried() {
        let mut bus = fake(vec![Err("busy".into()), Ok((50, 100))]);
        assert_eq!(read(&mut bus).unwrap(), (50, 100));
        assert!(bus.writes.is_empty());
    }
    #[test]
    fn already_restored_value_is_never_written() {
        let mut bus = fake(vec![Ok((50, 100))]);
        assert_eq!(write_verified(&mut bus, 50).unwrap(), (50, 100));
        assert!(bus.writes.is_empty());
    }
    #[test]
    fn lost_write_acknowledgement_is_verified_without_duplicate_write() {
        let mut bus = fake(vec![Ok((40, 100)), Err("busy".into()), Ok((50, 100))]);
        bus.write_error = true;
        assert_eq!(write_verified(&mut bus, 50).unwrap(), (50, 100));
        assert_eq!(bus.writes, vec![50]);
    }
    #[test]
    fn delayed_readback_does_not_cause_another_write() {
        let mut bus = fake(vec![Ok((40, 100)), Ok((40, 100)), Ok((50, 100))]);
        assert_eq!(write_verified(&mut bus, 50).unwrap(), (50, 100));
        assert_eq!(bus.writes, vec![50]);
    }
    #[test]
    fn persistent_failure_and_invalid_targets_do_not_write_blindly() {
        let mut bus = fake(vec![]);
        assert!(write_verified(&mut bus, 50).is_err());
        assert!(bus.writes.is_empty());
        let mut bus = fake(vec![Ok((40, 80))]);
        assert!(write_verified(&mut bus, 90).is_err());
        assert!(bus.writes.is_empty());
    }
    #[test]
    fn persistent_readback_mismatch_is_bounded_and_not_success() {
        let mut bus = fake(vec![Ok((40, 100)); 12]);
        assert!(write_verified(&mut bus, 50).is_err());
        assert_eq!(bus.writes, vec![50; 3]);
    }
}
