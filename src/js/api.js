// Tauri 后端调用薄封装。
// 生产环境由 WebView2 注入 window.__TAURI__（withGlobalTauri=true）。
// 浏览器开发模式（dev-server 无后端）下 invoke 会抛错，便于前端并发优化时兜底。

let _core = null;

function core() {
  if (_core) return _core;
  if (window.__TAURI__ && window.__TAURI__.core) {
    _core = window.__TAURI__.core;
    return _core;
  }
  return null;
}

/** 后端命令是否可用（非浏览器环境）。 */
export function backendAvailable() {
  return !!core();
}

/** 调用后端命令。 */
export async function invoke(cmd, args = {}) {
  const c = core();
  if (!c) throw new Error(`无法调用后端命令 ${cmd}（当前为非 Tauri 环境）`);
  return c.invoke(cmd, args);
}

// ---------------------------------------------------------------------------
// 窗口控制（窗口状态由 Rust 侧保存，前端仅负责关闭前兜底保存）
// ---------------------------------------------------------------------------

function winApi() {
  return (window.__TAURI__ && window.__TAURI__.window) ? window.__TAURI__.window : null;
}

/** 直接销毁窗口（绕过关闭请求流程，用于关闭前保存完成后真正退出）。 */
export async function destroyWindow() {
  const w = winApi();
  if (!w) return;
  try {
    await w.getCurrentWindow().destroy();
  } catch (e) {
    console.warn("销毁窗口失败", e);
  }
}

/**
 * 监听窗口关闭请求（回调内 preventDefault 后可执行异步保存，再 destroy）。
 * 返回取消函数。
 * @param {(event:{preventDefault:()=>void})=>void|Promise<void>} fn
 */
export async function onWindowCloseRequested(fn) {
  const w = winApi();
  if (!w) return () => {};
  try {
    return await w.getCurrentWindow().onCloseRequested(fn);
  } catch (err) {
    console.warn("监听窗口关闭失败", err);
    return () => {};
  }
}

/** 将本地绝对路径转成 tauri:// 可加载的 URL（用于 <img src> 预览）。 */
export function assetUrl(path) {
  const c = core();
  if (c && path) return c.convertFileSrc(path);
  // 浏览器调试环境：允许页面注入 URL 覆盖（dev-server 下的相对皮肤图路径）
  if (window.__assetUrlOverride) return window.__assetUrlOverride(path);
  return "";
}

/**
 * 加载皮肤图片的可用 src：优先走后端原始字节（Blob URL，无 base64 体积膨胀、
 * 不受 data URL 长度限制，超大 holdbody 也能加载），后端不可用时退回 assetUrl。
 */
export async function loadImageSrc(path) {
  const c = core();
  if (c && path) {
    try {
      const bytes = await c.invoke("read_file_bytes", { path });
      if (bytes && bytes.byteLength) {
        return URL.createObjectURL(new Blob([bytes]));
      }
      return "";
    } catch (e) {
      return c.convertFileSrc(path);
    }
  }
  if (window.__assetUrlOverride) return window.__assetUrlOverride(path);
  return "";
}