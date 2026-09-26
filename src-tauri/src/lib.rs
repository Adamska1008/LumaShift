mod engine;
mod model;
mod native;
mod shortcuts;
mod storage;
mod tone;

use engine::Shared;
use model::{Operation, Snapshot};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager,
};
use tauri_plugin_dialog::DialogExt;

#[tauri::command]
fn get_state(state: tauri::State<'_, Shared>) -> Snapshot {
    state.read()
}

#[tauri::command]
async fn dispatch(
    operation: Operation,
    state: tauri::State<'_, Shared>,
) -> Result<Snapshot, String> {
    let reply = state.enqueue(operation)?;
    tauri::async_runtime::spawn_blocking(move || reply.recv().map_err(|e| e.to_string()))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
fn export_data(scope: String, state: tauri::State<'_, Shared>) -> Result<String, String> {
    let snapshot = state.read();
    let value = if scope == "all" {
        serde_json::to_value(snapshot.config)
    } else {
        Ok(serde_json::json!({"version": 1, "presets": snapshot.config.presets}))
    }
    .map_err(|e| e.to_string())?;
    serde_json::to_string_pretty(&value).map_err(|e| e.to_string())
}

#[tauri::command]
async fn save_export(app: tauri::AppHandle, content: String, name: String) -> Result<bool, String> {
    if content.len() > 1_000_000 {
        return Err("Export exceeds 1 MB".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let name = if name == "presets" {
            "lumashift-presets.json"
        } else {
            "lumashift-settings.json"
        };
        let Some(file) = app
            .dialog()
            .file()
            .add_filter("JSON", &["json"])
            .set_file_name(name)
            .blocking_save_file()
        else {
            return Ok(false);
        };
        let path = file.into_path().map_err(|e| e.to_string())?;
        std::fs::write(path, content).map_err(|e| e.to_string())?;
        Ok(true)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn open_logs(state: tauri::State<'_, Shared>) -> Result<(), String> {
    std::process::Command::new("explorer.exe")
        .arg(&state.root)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn diagnose() {
    let info: Vec<_> = native::enumerate()
        .into_iter()
        .map(|d| d.info.clone())
        .collect();
    println!("{}", serde_json::to_string_pretty(&info).unwrap());
}

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            get_state,
            dispatch,
            export_data,
            save_export,
            open_logs
        ])
        .setup(|app| {
            let shared = engine::start(app.handle()).map_err(std::io::Error::other)?;
            let minimized = shared.read().config.settings.start_minimized;
            app.manage(shared.clone());
            let show = MenuItem::with_id(app, "show", "打开 LumaShift / Open", true, None::<&str>)?;
            let toggle = MenuItem::with_id(
                app,
                "toggle",
                "开关效果 / Toggle effects",
                true,
                None::<&str>,
            )?;
            let cycle =
                MenuItem::with_id(app, "cycle", "下一个预设 / Next preset", true, None::<&str>)?;
            let quit = MenuItem::with_id(
                app,
                "quit",
                "恢复并退出 / Restore & quit",
                true,
                None::<&str>,
            )?;
            let menu = Menu::with_items(app, &[&show, &toggle, &cycle, &quit])?;
            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("LumaShift")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| {
                    let state = app.state::<Shared>();
                    match event.id.as_ref() {
                        "show" => {
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.unminimize();
                                let _ = window.set_focus();
                            }
                        }
                        "toggle" => state.send(Operation::SetEnabled(!state.read().enabled)),
                        "cycle" => {
                            let snapshot = state.read();
                            state.send(shortcuts::resolve(
                                shortcuts::Action::Cycle,
                                &snapshot.config,
                                snapshot.enabled,
                            ));
                        }
                        "quit" => state.send(Operation::Quit),
                        _ => {}
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    if matches!(
                        event,
                        TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            ..
                        }
                    ) {
                        if let Some(window) = tray.app_handle().get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.unminimize();
                            let _ = window.set_focus();
                        }
                    }
                })
                .build(app)?;
            if !minimized {
                if let Some(window) = app.get_webview_window("main") {
                    window.show()?;
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                window
                    .state::<Shared>()
                    .send(Operation::CaptureShortcut(false));
                api.prevent_close();
                let _ = window.hide();
            }
            if let tauri::WindowEvent::Focused(false) = event {
                window
                    .state::<Shared>()
                    .send(Operation::CaptureShortcut(false));
            }
        })
        .build(tauri::generate_context!())
        .expect("Failed to start LumaShift");
    app.run(|app, event| {
        if let tauri::RunEvent::ExitRequested { api, .. } = event {
            let state = app.state::<Shared>();
            if !state.exiting.load(std::sync::atomic::Ordering::SeqCst) {
                api.prevent_exit();
                state.send(Operation::Quit);
            }
        }
    });
}
