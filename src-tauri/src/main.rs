#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if std::env::args().any(|arg| arg == "--software-rendering") {
        let existing = std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS").unwrap_or_default();
        std::env::set_var(
            "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
            format!("{existing} --disable-gpu"),
        );
    }
    if std::env::args().any(|arg| arg == "--diagnose") {
        lumashift_lib::diagnose();
    } else {
        lumashift_lib::run();
    }
}
