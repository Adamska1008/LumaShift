use crate::model::Tone;
pub type Ramp = [[u16; 256]; 3];

pub fn identity() -> Ramp {
    std::array::from_fn(|_| std::array::from_fn(|i| (i as u16) * 257))
}
pub fn matches(requested: &Ramp, actual: &Ramp) -> bool {
    requested
        .iter()
        .flatten()
        .zip(actual.iter().flatten())
        .all(|(a, b)| a.abs_diff(*b) <= 128)
}

pub fn build(original: &Ramp, tone: &Tone) -> Ramp {
    // The neutral profile preserves the user's calibration bit for bit.
    if *tone == Tone::default() {
        return *original;
    }
    std::array::from_fn(|channel| {
        let mut previous = 0;
        std::array::from_fn(|index| {
            let x = original[channel][index] as f64 / 65535.0;
            let mut y = x.powf(1.0 / tone.gamma);
            y += tone.shadows / 100.0 * 0.8 * y.powf(0.65) * (1.0 - y).powi(2);
            y += tone.highlights / 100.0 * 1.5 * y.powi(3) * (1.0 - y);
            y = (y - 0.5) * (1.0 + tone.contrast / 100.0) + 0.5;
            y = y * 2f64.powf(tone.exposure);
            y = tone.black_point / 100.0 + y * (1.0 - tone.black_point / 100.0);
            let temp = tone.temperature / 500.0;
            let gain = match channel {
                0 => 1.0 + temp.min(0.0),
                2 => 1.0 - temp.max(0.0),
                _ => 1.0,
            };
            let value = (y.clamp(0.0, 1.0) * gain * 65535.0).round() as u16;
            previous = previous.max(value);
            previous
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn neutral_preserves_existing_non_identity_calibration() {
        let mut baseline = identity();
        for n in &mut baseline[2] {
            *n = (*n as f64 * 0.92) as u16;
        }
        assert_eq!(build(&baseline, &Tone::default()), baseline);
    }
    #[test]
    fn supported_extremes_remain_monotonic() {
        for gamma in [0.6, 1.0, 2.2] {
            for contrast in [-40.0, 0.0, 40.0] {
                for exposure in [-0.5, 0.5] {
                    let profile = Tone {
                        gamma,
                        contrast,
                        exposure,
                        shadows: 60.0,
                        highlights: -40.0,
                        temperature: 50.0,
                        black_point: 8.0,
                    };
                    for channel in build(&identity(), &profile) {
                        assert!(channel.windows(2).all(|w| w[0] <= w[1]));
                    }
                }
            }
        }
    }
    #[test]
    fn shadows_raise_dark_values_without_moving_endpoints() {
        let result = build(
            &identity(),
            &Tone {
                shadows: 40.0,
                ..Tone::default()
            },
        );
        assert!(result[0][32] > identity()[0][32]);
        assert_eq!(result[0][0], 0);
        assert_eq!(result[0][255], 65535);
    }
}
