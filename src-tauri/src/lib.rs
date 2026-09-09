//! Tauri 命令：文件系统 IO / 编码检测 / 原子写入。
//!
//! WebView2 沙箱下前端无法直接读写任意皮肤文件夹，这些操作统一放后端。
//! 纯业务逻辑（skin.ini 解析、元素分类、文件名校验等）保留在前端 JS。

mod commands;
mod window_state;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        // NOTE: 新增后端命令时，需同时在 src/js/api.js 提供前端 invoke 封装，
        // 保持后端注册与前端调用一一对应（如 path_exists）。
        .invoke_handler(tauri::generate_handler![
        commands::list_images,
            commands::read_text,
            commands::read_file_bytes,
            commands::write_text_atomic,
            commands::copy_file,
            commands::path_exists,
            commands::delete_file,
            commands::create_folder,
            commands::open_in_explorer,
            commands::open_with_default_app,
            commands::pick_folder,
            commands::pick_files,
            commands::load_settings,
            commands::save_settings,
        ])
        .setup(|app| {
            // 启动时恢复窗口状态（大小/位置/最大化）；无记录默认最大化
            window_state::restore(app.handle());
            Ok(())
        })
        .on_window_event(|window, event| {
            // 窗口 resize/move/关闭时持久化状态（仅主窗口）
            if window.label() == "main" {
                window_state::on_event(window, event);
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}