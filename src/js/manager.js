// 皮肤文件夹扫描与校验（与 Python 版 manager.py 逻辑一致）。
// scan 输入为后端返回的图片绝对路径列表；其余算法保持 Python 版一致。

import { ELEMENTS } from "./catalog.js";

export const IMAGE_EXTS = [".png", ".gif", ".jpg", ".jpeg"];

const hdRe = /@2x$/i;

export function strip_hd(stem) {
  // 去高清后缀（@2x / 历史遗留 2x），保留帧号等其余部分
  const low = stem.toLowerCase();
  if (low.endsWith("@2x")) return stem.slice(0, -3);
  if (low.endsWith("2x")) return stem.slice(0, -2);
  return stem;
}

// 解析文件名主干，返回 [base, isHd, frameOrNull]
export function parse_stem(stem) {
  let low = stem.toLowerCase();
  let isHd = false;
  if (low.endsWith("@2x")) {
    isHd = true;
    stem = stem.slice(0, -3);
  } else if (low.endsWith("2x")) {
    isHd = true;
    stem = stem.slice(0, -2);
  }
  let frame = null;
  let base = stem;
  if (stem.includes("-")) {
    const idx = stem.lastIndexOf("-");
    const num = stem.slice(idx + 1);
    if (/^\d+$/.test(num)) {
      base = stem.slice(0, idx);
      frame = parseInt(num, 10);
    }
  }
  // 滑条球是唯一例外：sliderb0 / sliderb1（无横杠）
  const m = base.match(/^(sliderb)(\d+)$/i);
  if (m) return [m[1], isHd, parseInt(m[2], 10)];
  return [base, isHd, frame];
}

function _norm(base) {
  // 归一化路径键：\ 转 /，并大小写折叠（osu! 路径不区分大小写）
  return String(base).replace(/\\/g, "/").toLowerCase();
}

class ElementStatus {
  constructor(element) {
    this.element = element;
    this.exists = false;
    this.hasHd = false;
    this.frames = 0; // 动画帧数量（不含 @2x）
    this.files = [];
  }
}

export class SkinManager {
  constructor(folder) {
    this.folder = folder;
    this._baseFiles = {}; // base -> {paths, hd, frames:Set}
    this._stemFiles = {}; // 相对主干 -> [path]
    this._stemPlain = {}; // 纯主干 -> [path]
  }

  scan(images) {
    // images: 绝对路径列表（来自后端 list_images）
    this._baseFiles = {};
    this._stemFiles = {};
    this._stemPlain = {};
    for (const p of images || []) {
      const ext = "." + p.split(".").pop().toLowerCase();
      if (!IMAGE_EXTS.includes(ext)) continue;
      const stem = p.split(/[\\/]/).pop();
      const dot = stem.lastIndexOf(".");
      const name = dot > 0 ? stem.slice(0, dot) : stem;
      const [baseName, isHd, frame] = parse_stem(name);
      // 保留相对子目录（\ 转 /）
      const relDir = p.slice(this.folder.length).replace(/^[\\/]/, "").split(/[\\/]/).slice(0, -1).join("/");
      const base = relDir ? `${relDir}/${baseName}` : baseName;
      const key = _norm(base);
      let info = this._baseFiles[key];
      if (!info) {
        info = { paths: [], hd: false, frames: new Set() };
        this._baseFiles[key] = info;
      }
      info.paths.push(p);
      if (isHd) info.hd = true;
      if (frame !== null) info.frames.add(frame);

      const stemKey = strip_hd(name);
      const fullStem = relDir ? `${relDir}/${stemKey}` : stemKey;
      (this._stemFiles[_norm(fullStem)] = this._stemFiles[_norm(fullStem)] || []).push(p);
      (this._stemPlain[_norm(strip_hd(name))] = this._stemPlain[_norm(strip_hd(name))] || []).push(p);
    }
  }

  static isHdPath(path) {
    const stem = String(path).split(/[\\/]/).pop();
    const dot = stem.lastIndexOf(".");
    const name = dot > 0 ? stem.slice(0, dot) : stem;
    return hdRe.test(name.toLowerCase());
  }

  static _hasFrame0(path) {
    const stem = String(path).split(/[\\/]/).pop();
    const dot = stem.lastIndexOf(".");
    const name = dot > 0 ? stem.slice(0, dot) : stem;
    const [, , frame] = parse_stem(name);
    return frame === 0;
  }

  // 返回最佳文件路径：@2x 帧0 > 帧0 > @2x > 遗留2x > 首个
  static _firstHd(paths) {
    if (!paths || !paths.length) return null;
    const frame0at2 = paths.find((p) => SkinManager._hasFrame0(p) && SkinManager.isHdPath(p) && /@2x/i.test(p));
    if (frame0at2) return frame0at2;
    const frame0 = paths.find((p) => SkinManager._hasFrame0(p) && !SkinManager.isHdPath(p));
    if (frame0) return frame0;
    const at2 = paths.find((p) => /@2x/i.test(p));
    if (at2) return at2;
    const legacy2 = paths.find((p) => SkinManager.isHdPath(p));
    if (legacy2) return legacy2;
    return paths[0];
  }

  hasBase(base) {
    // 与 Python 版 has_base 一致：仅命中根目录同名文件（_base_files/_stem_files 的
    // 不带目录 key）或 skin.ini 指定的相对路径。不做纯文件名兜底，
    // 避免子目录中无关的同名文件被误判为元素存在。
    return _norm(base) in this._baseFiles || _norm(base) in this._stemFiles;
  }

  pathFor(base) {
    const info = this._baseFiles[_norm(base)];
    if (info && info.paths.length) return SkinManager._firstHd(info.paths);
    return this.pathForStem(base);
  }

  pathForExact(base) {
    // 仅查精确索引，不回退到 stem 模糊匹配（skin.ini 指定路径用）
    const info = this._baseFiles[_norm(base)];
    if (info && info.paths.length) return SkinManager._firstHd(info.paths);
    return null;
  }

  pathForStem(stem) {
    // 按相对路径精确匹配（含子目录），不做纯文件名模糊兜底；
    // 前缀是"路径+文件名"，不能在整皮肤内无视目录搜索（官方语义）。
    const paths = this._stemFiles[_norm(stem)];
    return SkinManager._firstHd(paths);
  }

  status(element) {
    const info = this._baseFiles[_norm(element.filename)];
    const st = new ElementStatus(element);
    if (info) {
      st.exists = true;
      st.hasHd = info.hd;
      st.frames = info.frames.size;
      st.files = info.paths;
    } else {
      // 数字等精确 stem 命中（如 score-3、score-percent）：
      // 与 Python 版一致，仅标记存在/Hd/文件，不统计帧数（数字 -N 是数位，不是动画帧）
      const paths = this._stemFiles[_norm(element.filename)];
      if (paths) {
        st.exists = true;
        st.hasHd = paths.some((p) => SkinManager.isHdPath(p));
        st.files = paths;
      }
    }
    return st;
  }

  missing() {
    return ELEMENTS.filter((e) => !this.hasBase(e.filename));
  }

  present() {
    return ELEMENTS.filter((e) => this.hasBase(e.filename));
  }

  summary() {
    const present = this.present();
    return { total: ELEMENTS.length, present: present.length, missing: ELEMENTS.length - present.length };
  }
}