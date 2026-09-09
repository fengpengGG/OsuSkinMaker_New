//! 后端命令实现。

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use encoding_rs::Encoding;
use serde::Serialize;
use tauri::Manager;

const IMAGE_EXTS: [&str; 4] = [".png", ".gif", ".jpg", ".jpeg"];

// ---------------------------------------------------------------------------
// 图片遍历
// ---------------------------------------------------------------------------

/// 递归列出皮肤文件夹内的图片文件，返回绝对路径列表。
#[tauri::command]
pub fn list_images(folder: String) -> Vec<String> {
    let mut out = Vec::new();
    let root = PathBuf::from(&folder);
    if !root.is_dir() {
        return out;
    }
    collect_images(&root, &mut out);
    out
}

fn collect_images(dir: &Path, out: &mut Vec<String>) {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_images(&path, out);
        } else if path.is_file() {
            if let Some(ext) = path.extension().and_then(|s| s.to_str()) {
                let l = format!(".{}", ext.to_lowercase());
                if IMAGE_EXTS.contains(&l.as_str()) {
                    out.push(path.to_string_lossy().into_owned());
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// 编码检测与读写
// ---------------------------------------------------------------------------

/// 检测文本编码并返回解码后的文本、编码名、是否带 BOM。
/// 规则与 Python 版 utilities.detect_encoding 一致：UTF-8(含BOM) → GBK → latin-1 兜底。
fn detect_and_decode(bytes: &[u8]) -> (String, String) {
    // 1) UTF-8 BOM
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        let body = &bytes[3..];
        return (String::from_utf8_lossy(body).into_owned(), "utf-8-sig".to_string());
    }
    // 2) UTF-8（无 BOM）
    match std::str::from_utf8(bytes) {
        Ok(s) => return (s.to_string(), "utf-8".to_string()),
        Err(_) => {}
    }
    // 3) GBK
    let (cow, _, _) = GBK.decode(bytes);
    if !cow.clone().contains("\u{FFFD}") {
        return (cow.clone().into_owned(), "gbk".to_string());
    }
    // 4) latin-1 兜底（每字节 → 同码位字符，永远可解）
    let s: String = bytes.iter().map(|&b| b as char).collect();
    (s, "latin-1".to_string())
}

const GBK: &'static Encoding = encoding_rs::GBK;

#[derive(Serialize)]
pub struct ReadTextResult {
    pub text: String,
    pub encoding: String,
}

#[derive(Serialize)]
pub struct WriteResult {
    pub ok: bool,
}

/// 读取文本文件并检测编码。
#[tauri::command]
pub fn read_text(path: String) -> Result<ReadTextResult, String> {
    let bytes = fs::read(&path).map_err(|e| e.to_string())?;
    let (text, encoding) = detect_and_decode(&bytes);
    Ok(ReadTextResult { text, encoding })
}

/// 读取图片文件的原始字节（走 Tauri 原始字节 IPC，前端转 Blob URL）。
/// 素材若是 TIFF 等浏览器不支持的格式（常见于伪装成 .png 的 holdbody 等），
/// 会先转码为真 PNG，确保预览可显示。
#[tauri::command]
pub fn read_file_bytes(path: String) -> Result<tauri::ipc::Response, String> {
    let bytes = fs::read(&path).map_err(|e| e.to_string())?;
    Ok(tauri::ipc::Response::new(ensure_web_image(&bytes)))
}

/// 浏览器能直接显示的图片魔数嗅探（PNG/JPEG/GIF/WebP/BMP/HEIF）。
fn is_web_image(b: &[u8]) -> bool {
    if b.len() >= 8 && b[..8] == [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A] {
        return true; // PNG
    }
    if b.len() >= 3 && b[..3] == [0xFF, 0xD8, 0xFF] {
        return true; // JPEG
    }
    if b.len() >= 6 && (b[..6] == *b"GIF87a" || b[..6] == *b"GIF89a") {
        return true; // GIF
    }
    if b.len() >= 12 && b[..4] == *b"RIFF" && b[8..12] == *b"WEBP" {
        return true; // WebP
    }
    if b.len() >= 2 && b[..2] == [0x42, 0x4D] {
        return true; // BMP
    }
    if b.len() >= 12 && b[4..8] == *b"ftyp" {
        return true; // HEIF/AVIF
    }
    false
}

/// Web 格式原样返回；其余（TIFF 等）尝试解码后转码为 PNG；转码失败则原样返回。
fn ensure_web_image(bytes: &[u8]) -> Vec<u8> {
    if is_web_image(bytes) {
        return bytes.to_vec();
    }
    match image::load_from_memory(bytes) {
        Ok(img) => {
            let mut out = Vec::new();
            if img
                .write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png)
                .is_ok()
            {
                return out;
            }
            bytes.to_vec()
        }
        Err(_) => bytes.to_vec(),
    }
}

/// 将文本按指定编码写成字节。
fn encode_text(text: &str, encoding: &str) -> Vec<u8> {
    match encoding {
        "utf-8-sig" => {
            let mut v = Vec::new();
            v.extend_from_slice(&[0xEF, 0xBB, 0xBF]);
            v.extend_from_slice(text.as_bytes());
            v
        }
        "gbk" => {
            let (cow, _, _) = GBK.encode(text);
            cow.into_owned()
        }
        _ => text.as_bytes().to_vec(),
    }
}

/// 原子写入：先写临时文件再替换，失败时原文件保持完好。
#[tauri::command]
pub fn write_text_atomic(path: String, text: String, encoding: String) -> Result<(), String> {
    // 无 BOM 的 UTF-8 升级为带 BOM（与 Python 版一致）
    let enc = match encoding.as_str() {
        "utf-8" | "latin-1" => "utf-8-sig".to_string(),
        other => other.to_string(),
    };
    let bytes = encode_text(&text, &enc);
    let p = Path::new(&path);
    let tmp = p.with_extension("ini.tmp");
    {
        let mut f = fs::File::create(&tmp).map_err(|e| e.to_string())?;
        f.write_all(&bytes).map_err(|e| e.to_string())?;
        f.flush().map_err(|e| e.to_string())?;
    }
    fs::rename(&tmp, p).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        e.to_string()
    })?;
    Ok(())
}

// ---------------------------------------------------------------------------
// 系统对话框（原生文件夹/文件选择）
// ---------------------------------------------------------------------------

/// 选择文件夹，返回绝对路径；取消返回 None。
#[tauri::command]
pub async fn pick_folder(app: tauri::AppHandle) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    app.dialog()
        .file()
        .blocking_pick_folder()
        .and_then(|p| p.into_path().ok())
        .map(|pb| pb.display().to_string())
}

/// 选择多个文件（导入素材用），返回绝对路径列表；取消返回空数组。
#[tauri::command]
pub async fn pick_files(app: tauri::AppHandle) -> Vec<String> {
    use tauri_plugin_dialog::DialogExt;
    let picked = app.dialog().file().blocking_pick_files();
    picked
        .map(|files| {
            files
                .into_iter()
                .filter_map(|p| p.into_path().ok().map(|pb| pb.display().to_string()))
                .collect()
        })
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// 文件操作
// ---------------------------------------------------------------------------

/// 复制文件（覆盖时先删再拷，行为等同 shutil.copy2 的覆盖）。
#[tauri::command]
pub fn copy_file(src: String, dest: String) -> Result<(), String> {
    let dest_path = Path::new(&dest);
    if dest_path.exists() {
        fs::remove_file(dest_path).map_err(|e| e.to_string())?;
    }
    if let Some(parent) = dest_path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::copy(&src, &dest).map_err(|e| e.to_string())?;
    Ok(())
}

/// 判断路径（文件或目录）是否存在。用于复制前是否真正需要覆盖确认。
#[tauri::command]
pub fn path_exists(path: String) -> bool {
    Path::new(&path).exists()
}

/// 删除文件。
#[tauri::command]
pub fn delete_file(path: String) -> Result<(), String> {
    fs::remove_file(&path).map_err(|e| e.to_string())
}

/// 递归创建文件夹（不覆盖已存在）。用于新建皮肤、复制素材目标目录。
#[tauri::command]
pub fn create_folder(path: String) -> Result<(), String> {
    fs::create_dir_all(&path).map_err(|e| e.to_string())
}

/// 在资源管理器中打开路径：
/// - 目录：直接进入该目录（打开文件夹按钮 → 进入皮肤根目录）
/// - 文件：在资源管理器中选中该文件（元素定位）
#[tauri::command]
pub fn open_in_explorer(path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    // 规范化为原生分隔符（反斜杠）：前端新建皮肤生成的是 / 路径，
    // Windows 下 explorer 对正斜杠路径打开不流畅，导致"打不开，重新打开皮肤才能开"。
    let native = p.to_string_lossy().to_string();
    let mut cmd = std::process::Command::new("explorer");
    if p.is_dir() {
        cmd.arg(&native);
    } else {
        cmd.arg("/select,").arg(&native);
    }
    cmd.spawn().map_err(|e| e.to_string())?;
    Ok(())
}

/// 用系统默认关联程序打开文件（打开 skin.ini 等）：Windows 下 explorer 即 shell 关联。
#[tauri::command]
pub fn open_with_default_app(path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    std::process::Command::new("explorer")
        .arg(p.to_string_lossy().to_string())
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ---------------------------------------------------------------------------
// 设置持久化（settings.json）
// ---------------------------------------------------------------------------

fn settings_path(_app: &tauri::AppHandle) -> PathBuf {
    // 存到 exe 同目录的 settings 文件夹，便于用户随真身携带/备份
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("."));
    exe_dir.join("settings").join("settings.json")
}

#[tauri::command]
pub fn load_settings(_app: tauri::AppHandle) -> serde_json::Value {
    let path = settings_path(&_app);
    if let Ok(text) = fs::read_to_string(&path) {
        if let Ok(v) = serde_json::from_str(&text) {
            return v;
        }
    }
    serde_json::Value::Object(Default::default())
}

#[tauri::command]
pub fn save_settings(_app: tauri::AppHandle, data: serde_json::Value) -> Result<(), String> {
    let path = settings_path(&_app);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let bytes = serde_json::to_vec_pretty(&data).map_err(|e| e.to_string())?;
    fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(())
}