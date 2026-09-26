//! All display handles stay on the display worker thread. No game process access.
use crate::{
    model::{DisplayInfo, FeatureInfo, FEATURES},
    tone::{self, Ramp},
};
use std::{
    collections::{BTreeMap, HashSet},
    mem::size_of,
};
use windows::{
    core::{w, BOOL, PCWSTR},
    Win32::{
        Devices::Display::*,
        Foundation::{HANDLE, LPARAM, RECT},
        Graphics::Gdi::*,
        UI::ColorSystem::{GetDeviceGammaRamp, SetDeviceGammaRamp},
    },
};
const EDD_GET_DEVICE_INTERFACE_NAME: u32 = 0x00000001;

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(Some(0)).collect()
}
fn string(text: &[u16]) -> String {
    String::from_utf16_lossy(&text[..text.iter().position(|c| *c == 0).unwrap_or(text.len())])
}

pub fn vcp_codes(capabilities: &str) -> Option<HashSet<u8>> {
    let lower = capabilities.to_ascii_lowercase();
    let start = lower.find("vcp(")? + 4;
    let mut depth = 1usize;
    let mut token = String::new();
    let mut result = HashSet::new();
    for c in lower[start..].chars() {
        if depth == 1 && c.is_ascii_hexdigit() {
            token.push(c);
            continue;
        }
        if !token.is_empty() {
            if let Ok(code) = u8::from_str_radix(&token, 16) {
                result.insert(code);
            }
            token.clear();
        }
        match c {
            '(' => depth += 1,
            ')' => {
                depth -= 1;
                if depth == 0 {
                    return Some(result);
                }
            }
            _ => {}
        }
    }
    None
}

#[derive(Default)]
struct Route {
    id: String,
    name: String,
    advanced_color: Option<bool>,
}
fn routes() -> BTreeMap<String, Route> {
    let mut result = BTreeMap::new();
    unsafe {
        // The topology can change between buffer sizing and querying; retry boundedly.
        for _ in 0..3 {
            let (mut count, mut mode_count) = (0, 0);
            if GetDisplayConfigBufferSizes(QDC_ONLY_ACTIVE_PATHS, &mut count, &mut mode_count).0
                != 0
            {
                break;
            }
            let mut paths = vec![DISPLAYCONFIG_PATH_INFO::default(); count as usize];
            let mut modes = vec![DISPLAYCONFIG_MODE_INFO::default(); mode_count as usize];
            if QueryDisplayConfig(
                QDC_ONLY_ACTIVE_PATHS,
                &mut count,
                paths.as_mut_ptr(),
                &mut mode_count,
                modes.as_mut_ptr(),
                None,
            )
            .0 != 0
            {
                continue;
            }
            for path in paths.iter().take(count as usize) {
                let mut source = DISPLAYCONFIG_SOURCE_DEVICE_NAME::default();
                source.header = DISPLAYCONFIG_DEVICE_INFO_HEADER {
                    r#type: DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME,
                    size: size_of::<DISPLAYCONFIG_SOURCE_DEVICE_NAME>() as u32,
                    adapterId: path.sourceInfo.adapterId,
                    id: path.sourceInfo.id,
                };
                if DisplayConfigGetDeviceInfo(&mut source.header) != 0 {
                    continue;
                }
                let mut target = DISPLAYCONFIG_TARGET_DEVICE_NAME::default();
                target.header = DISPLAYCONFIG_DEVICE_INFO_HEADER {
                    r#type: DISPLAYCONFIG_DEVICE_INFO_GET_TARGET_NAME,
                    size: size_of::<DISPLAYCONFIG_TARGET_DEVICE_NAME>() as u32,
                    adapterId: path.targetInfo.adapterId,
                    id: path.targetInfo.id,
                };
                if DisplayConfigGetDeviceInfo(&mut target.header) != 0 {
                    continue;
                }
                let mut color = DISPLAYCONFIG_GET_ADVANCED_COLOR_INFO::default();
                color.header = DISPLAYCONFIG_DEVICE_INFO_HEADER {
                    r#type: DISPLAYCONFIG_DEVICE_INFO_GET_ADVANCED_COLOR_INFO,
                    size: size_of::<DISPLAYCONFIG_GET_ADVANCED_COLOR_INFO>() as u32,
                    adapterId: path.targetInfo.adapterId,
                    id: path.targetInfo.id,
                };
                let advanced_color = if DisplayConfigGetDeviceInfo(&mut color.header) == 0 {
                    Some(color.Anonymous.value & 2 != 0)
                } else {
                    None
                };
                let device = string(&source.viewGdiDeviceName);
                // Mirrored outputs share a gamma source: don't claim independent gamma support.
                if let Some(existing) = result.get_mut(&device) {
                    let existing: &mut Route = existing;
                    existing.advanced_color = None;
                } else {
                    result.insert(
                        device,
                        Route {
                            id: string(&target.monitorDevicePath),
                            name: string(&target.monitorFriendlyDeviceName),
                            advanced_color,
                        },
                    );
                }
            }
            break;
        }
    }
    result
}

unsafe extern "system" fn monitor_callback(
    hmonitor: HMONITOR,
    _: HDC,
    _: *mut RECT,
    data: LPARAM,
) -> BOOL {
    let monitors = &mut *(data.0 as *mut Vec<(HMONITOR, MONITORINFOEXW)>);
    let mut info = MONITORINFOEXW::default();
    info.monitorInfo.cbSize = size_of::<MONITORINFOEXW>() as u32;
    if GetMonitorInfoW(hmonitor, &mut info.monitorInfo).as_bool() {
        monitors.push((hmonitor, info));
    }
    BOOL(1)
}
fn logical_monitors() -> Vec<(HMONITOR, MONITORINFOEXW)> {
    let mut monitors = Vec::new();
    unsafe {
        let _ = EnumDisplayMonitors(
            None,
            None,
            Some(monitor_callback),
            LPARAM(&mut monitors as *mut _ as isize),
        );
    }
    monitors
}
pub fn topology_signature() -> Vec<String> {
    let mapping = routes();
    logical_monitors()
        .iter()
        .map(|(_, info)| {
            let device = string(&info.szDevice);
            let rect = info.monitorInfo.rcMonitor;
            format!(
                "{device}:{}:{}:{:?}:{:?}",
                rect.right - rect.left,
                rect.bottom - rect.top,
                mapping.get(&device).map(|r| &r.id),
                mapping.get(&device).and_then(|r| r.advanced_color)
            )
        })
        .collect()
}

pub struct Display {
    pub info: DisplayInfo,
    dc: HDC,
    physical: Vec<PHYSICAL_MONITOR>,
}
impl Drop for Display {
    fn drop(&mut self) {
        unsafe {
            for monitor in &self.physical {
                let _ = DestroyPhysicalMonitor(monitor.hPhysicalMonitor);
            }
            if !self.dc.0.is_null() {
                let _ = DeleteDC(self.dc);
            }
        }
    }
}
impl Display {
    fn handle(&self) -> Result<HANDLE, String> {
        if self.physical.len() != 1 {
            return Err("DDC/CI requires one physical monitor for this output".into());
        }
        Ok(self.physical[0].hPhysicalMonitor)
    }
    pub fn read_gamma(&self) -> Result<Ramp, String> {
        let mut ramp = tone::identity();
        if self.dc.0.is_null()
            || !unsafe { GetDeviceGammaRamp(self.dc, ramp.as_mut_ptr().cast()) }.as_bool()
        {
            return Err("Gamma ramp could not be read".into());
        }
        Ok(ramp)
    }
    pub fn write_gamma(&self, ramp: &Ramp) -> Result<(), String> {
        if !unsafe { SetDeviceGammaRamp(self.dc, ramp.as_ptr().cast()) }.as_bool() {
            return Err("The display driver rejected the gamma ramp".into());
        }
        let readback = self.read_gamma()?;
        if !tone::matches(ramp, &readback) {
            return Err("Gamma readback differs from the requested curve".into());
        }
        Ok(())
    }
    pub fn read_vcp(&self, key: &str) -> Result<(u32, u32), String> {
        let code = FEATURES
            .iter()
            .find(|(name, _)| *name == key)
            .ok_or("Unknown monitor control")?
            .1;
        let (mut current, mut maximum) = (0, 0);
        if unsafe {
            GetVCPFeatureAndVCPFeatureReply(
                self.handle()?,
                code,
                None,
                &mut current,
                Some(&mut maximum),
            )
        } == 0
        {
            return Err(format!("{key}: DDC/CI read failed"));
        }
        if maximum == 0 || current > maximum {
            return Err(format!("{key}: monitor returned an invalid range"));
        }
        Ok((current, maximum))
    }
    pub fn write_raw(&mut self, key: &str, value: u32) -> Result<(), String> {
        let code = FEATURES
            .iter()
            .find(|(name, _)| *name == key)
            .ok_or("Unknown monitor control")?
            .1;
        let (_, maximum) = self.read_vcp(key)?;
        if value > maximum {
            return Err(format!("{key}: value exceeds monitor range"));
        }
        if unsafe { SetVCPFeature(self.handle()?, code, value) } == 0 {
            return Err(format!("{key}: DDC/CI write failed"));
        }
        let (actual, max) = self.read_vcp(key)?;
        if actual != value {
            return Err(format!("{key}: monitor did not apply the requested value"));
        }
        if let Some(feature) = self.info.features.iter_mut().find(|f| f.key == key) {
            feature.value = Some(((actual as f64 / max as f64) * 100.0).round() as u32);
        }
        Ok(())
    }
    pub fn supported(&self, key: &str) -> bool {
        self.info
            .features
            .iter()
            .any(|f| f.key == key && f.status == "available")
    }
}

pub fn enumerate() -> Vec<Display> {
    let mapping = routes();
    let mut result = Vec::new();
    for (hmonitor, monitor) in logical_monitors() {
        let device = string(&monitor.szDevice);
        let device_wide = wide(&device);
        let route = mapping.get(&device);
        let mut fallback = DISPLAY_DEVICEW::default();
        fallback.cb = size_of::<DISPLAY_DEVICEW>() as u32;
        unsafe {
            let _ = EnumDisplayDevicesW(
                PCWSTR(device_wide.as_ptr()),
                0,
                &mut fallback,
                EDD_GET_DEVICE_INTERFACE_NAME,
            );
        }
        let id = route
            .map(|r| r.id.clone())
            .filter(|v| !v.is_empty())
            .unwrap_or_else(|| string(&fallback.DeviceID));
        let id = if id.is_empty() { device.clone() } else { id };
        let mut physical = Vec::new();
        let mut count = 0;
        unsafe {
            if GetNumberOfPhysicalMonitorsFromHMONITOR(hmonitor, &mut count).is_ok()
                && (1..=16).contains(&count)
            {
                physical.resize(count as usize, PHYSICAL_MONITOR::default());
                if GetPhysicalMonitorsFromHMONITOR(hmonitor, &mut physical).is_err() {
                    physical.clear();
                }
            }
        }
        let name = route
            .map(|r| r.name.clone())
            .filter(|v| !v.is_empty())
            .or_else(|| {
                physical.first().map(|p| {
                    let description = p.szPhysicalMonitorDescription;
                    string(&description)
                })
            })
            .unwrap_or_else(|| device.clone());
        let dc = unsafe {
            CreateDCW(
                w!("DISPLAY"),
                PCWSTR(device_wide.as_ptr()),
                PCWSTR::null(),
                None,
            )
        };
        let hdr = route.and_then(|r| r.advanced_color);
        let mut display = Display {
            info: DisplayInfo {
                id,
                name,
                device,
                primary: monitor.monitorInfo.dwFlags & 1 != 0,
                hdr,
                gamma_available: false,
                features: vec![],
            },
            dc,
            physical,
        };
        display.info.gamma_available = hdr == Some(false) && display.read_gamma().is_ok();
        let mut caps = None;
        if let Ok(handle) = display.handle() {
            unsafe {
                let mut length = 0;
                if GetCapabilitiesStringLength(handle, &mut length) != 0
                    && (1..=32768).contains(&length)
                {
                    let mut bytes = vec![0u8; length as usize];
                    if CapabilitiesRequestAndCapabilitiesReply(handle, &mut bytes) != 0 {
                        caps = vcp_codes(&String::from_utf8_lossy(&bytes));
                    }
                }
            }
        }
        for (key, code) in FEATURES {
            let missing = caps.as_ref().is_some_and(|values| !values.contains(&code));
            let item = if missing {
                FeatureInfo {
                    key: key.into(),
                    status: "unsupported".into(),
                    value: None,
                    max: 0,
                    detail: "Not exposed in monitor capabilities".into(),
                }
            } else {
                match display.read_vcp(key) {
                    Ok((current, max)) => FeatureInfo {
                        key: key.into(),
                        status: "available".into(),
                        value: Some((current as f64 / max as f64 * 100.0).round() as u32),
                        max,
                        detail: String::new(),
                    },
                    Err(detail) => FeatureInfo {
                        key: key.into(),
                        status: if caps.is_some() {
                            "unavailable"
                        } else {
                            "unknown"
                        }
                        .into(),
                        value: None,
                        max: 0,
                        detail,
                    },
                }
            };
            display.info.features.push(item);
        }
        result.push(display);
    }
    result.sort_by_key(|d| !d.info.primary);
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_codes_without_confusing_nested_values_for_features() {
        let codes = vcp_codes("(prot(monitor)vcp(10 12 60(01 03 8A) 8a 16))").unwrap();
        assert!(codes.contains(&0x8a));
        assert!(codes.contains(&0x60));
        assert!(!codes.contains(&0x03));
        assert!(!vcp_codes("vcp(10 60(8a))").unwrap().contains(&0x8a));
    }
    #[test]
    fn distinguishes_missing_capabilities_from_empty_support_list() {
        assert!(vcp_codes("model(screen)").is_none());
        assert!(vcp_codes("vcp()").unwrap().is_empty());
        assert!(vcp_codes("vcp(10").is_none());
    }
}
