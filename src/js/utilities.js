// 通用纯函数：颜色解析、数值解析（与 Python 版 utilities.py 逻辑一致）

export function rgb_to_hex(rgb) {
  const [r, g, b] = rgb;
  return "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");
}

// 数值
export function _num(s, def = 0.0) {
  const v = parseFloat(s);
  return Number.isNaN(v) ? def : v;
}

// choice 字段值转数值：兼容 '0=拉伸' 标签文本与纯 '0' 枚举值
export function _choice(s, def) {
  const str = String(s).split("=", 1)[0].trim();
  const v = parseFloat(str);
  return Number.isNaN(v) ? def : v;
}

// 解析逗号分隔的数值列表，缺失用默认值补齐到 count
export function _num_list(s, def, count) {
  const parts = s ? String(s).split(",").map((p) => p.trim()) : [];
  return Array.from({ length: count }, (_, i) =>
    i < parts.length && parts[i] !== "" ? _num(parts[i], def) : def,
  );
}