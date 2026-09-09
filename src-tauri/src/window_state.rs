//! 窗口状态持久化（大小/位置/最大化）——Rust 侧实现。
//!
//! 前端 window API 调用在当前环境不稳定，改由 Rust 直接操作 tao 窗口：
//! - 启动时（setup）从 settings.json 恢复窗口状态，无记录默认最大化；
//! - 窗口 resize/move 时节流保存，关闭请求时强制保存最终状态；
//! - 只读写 settings.json 中 window_state / window_geometry 两个字段，
//!   与前端管理的其他设置字段互不覆盖。

use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::{Manager, PhysicalPosition, PhysicalSize, Window, WindowEvent};

/// settings.json 路径（与 commands.rs 一致：exe 同目录 settings 文件夹）。
pub(crate) fn settings_path() -> PathBuf {
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("."));
    exe_dir.join("settings").join("settings.json")
}

fn read_settings() -> Value {
    if let Ok(text) = fs::read_to_string(settings_path()) {
        if let Ok(v) = serde_json::from_str(&text) {
            return v;
        }
    }
    Value::Object(Default::default())
}

/// 仅覆盖指定字段写回 settings.json，保留前端管理的其他字段。
fn patch_settings(patch: Value) {
    let mut root = read_settings();
    if let (Value::Object(map), Some(obj)) = (&mut root, patch.as_object()) {
        for (k, v) in obj {
            map.insert(k.clone(), v.clone());
        }
    }
    let path = settings_path();
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(bytes) = serde_json::to_vec_pretty(&root) {
        let _ = fs::write(&path, bytes);
    }
}

/// 启动时恢复窗口状态；无记录或记录无效默认最大化（与原项目 state("zoomed") 一致）。
pub(crate) fn restore<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    let Some(win) = app.get_webview_window("main") else { return };
    let root = read_settings();
    let state = root
        .get("window_state")
        .and_then(|v| v.as_str())
        .unwrap_or("zoomed");

    // 校验 geometry：宽高不小于最小窗口（860×560），坐标不在屏幕外隐藏位
    let valid_geometry = || -> Option<(u32, u32, Option<(i32, i32)>)> {
        let g = root.get("window_geometry").and_then(|v| v.as_object())?;
        let w = g.get("width").and_then(|v| v.as_f64())? as u32;
        let h = g.get("height").and_then(|v| v.as_f64())? as u32;
        if w < 860 || h < 560 {
            return None;
        }
        let pos = match (
            g.get("x").and_then(|v| v.as_f64()),
            g.get("y").and_then(|v| v.as_f64()),
        ) {
            (Some(x), Some(y)) => {
                let (xi, yi) = (x as i32, y as i32);
                if xi < -10000 || yi < -10000 || xi > 100000 || yi > 100000 {
                    None
                } else {
                    Some((xi, yi))
                }
            }
            _ => None,
        };
        Some((w, h, pos))
    };

    if state == "zoomed" {
        let _ = win.maximize();
        return;
    }
    if let Some((w, h, pos)) = valid_geometry() {
        let _ = win.set_size(PhysicalSize::new(w, h));
        if let Some((x, y)) = pos {
            let _ = win.set_position(PhysicalPosition::new(x, y));
        }
    } else {
        // 无有效几何记录：默认最大化（与原项目一致）
        let _ = win.maximize();
    }
}

/// 保存节流：resize/move 事件频繁，300ms 内只写一次磁盘。
static LAST_SAVE: Mutex<Option<Instant>> = Mutex::new(None);

/// 采集当前窗口状态（物理像素）并写入 settings.json。
/// 最小化或几何无效（窗口处于隐藏位）时跳过，保留上次有效状态。
fn save(window: &Window) {
    // 最小化时 Windows 会把窗口置为 237×39@-32000，几何无意义，跳过
    if window.is_minimized().unwrap_or(false) {
        return;
    }
    let Ok(size) = window.outer_size() else { return };
    // 小于窗口最小尺寸（860×560，与 tauri.conf.json 一致）说明采集到无效状态
    if size.width < 860 || size.height < 560 {
        return;
    }
    let pos = window.outer_position().ok();
    if let Some(p) = &pos {
        // 屏幕外隐藏位视为无效（原项目 win_geometry 也不会保存此类状态）
        if p.x < -10000 || p.y < -10000 || p.x > 100000 || p.y > 100000 {
            return;
        }
    }
    let maximized = window.is_maximized().unwrap_or(false);
    let geometry = json!({
        "width": size.width,
        "height": size.height,
        "x": pos.as_ref().map(|p| p.x),
        "y": pos.as_ref().map(|p| p.y),
    });
    patch_settings(json!({
        "window_state": if maximized { "zoomed" } else { "normal" },
        "window_geometry": geometry,
    }));
}

/// 窗口事件处理：resize/move 节流保存，关闭请求时强制保存最终状态。
pub(crate) fn on_event(window: &Window, event: &WindowEvent) {
    match event {
        WindowEvent::Resized(_) | WindowEvent::Moved(_) => {
            let mut last = LAST_SAVE.lock().unwrap();
            let due = last.map_or(true, |t| t.elapsed() >= Duration::from_millis(300));
            if due {
                save(window);
                *last = Some(Instant::now());
            }
        }
        WindowEvent::CloseRequested { .. } => save(window),
        _ => {}
    }
}
