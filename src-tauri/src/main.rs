#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if std::env::args().any(|arg| arg == "--diagnose") {
        lumashift_lib::diagnose();
    } else {
        lumashift_lib::run();
    }
}
