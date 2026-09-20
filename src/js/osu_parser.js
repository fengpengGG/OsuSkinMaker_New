// .osu 谱面解析（借鉴 temp\Beatmap_Preview_v-main\index.js 的 parseOsuFileHits）。
// 输出结构化数据供预览对局模式逐帧渲染使用：HitObjects / timing /
// 键数（CircleSize）/ duration / 预览时间 / BPM，以及预计算时间索引、节拍段。

// 长条判定位：type & 128 = LN，endTime 从第 6 列冒号前解析
const LN_BIT = 128;

/**
 * 解析 .osu 谱面文本。
 * @param {string} content .osu 全文
 * @returns {object} { mode, circleSize, previewTime, audioFilename, backgroundFilename,
 *                     title, artist, creator, version,
 *                     bpm, timingPoints, hitObjects, noteCount, lnCount, durationMs,
 *                     beatSects, hitIndex }
 */
export function parseOsuBeatmap(content) {
  const sections = {};
  let section = null;

  for (const line of String(content).split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("//")) continue;
    const m = t.match(/^\[(.+)\]$/);
    if (m) { section = m[1]; continue; }
    if (section) (sections[section] ??= []).push(t);
  }

  // General
  let mode = 0, previewTime = -1, audioFilename = "";
  (sections["General"] || []).forEach((line) => {
    const i = line.indexOf(":");
    if (i < 0) return;
    const k = line.slice(0, i).trim();
    const v = line.slice(i + 1).trim();
    if (k === "Mode") mode = parseInt(v, 10) || 0;
    if (k === "PreviewTime") previewTime = parseInt(v, 10) || -1;
    if (k === "AudioFilename") audioFilename = v;
  });

  // Difficulty
  let cs = 4;
  let drainRate = 5; // DrainRate = 编辑器里的 HP，官方 mania 血量增减按它计算
  (sections["Difficulty"] || []).forEach((line) => {
    const i = line.indexOf(":");
    if (i < 0) return;
    const key = line.slice(0, i).trim();
    if (key === "CircleSize") {
      cs = Math.round(parseFloat(line.slice(i + 1).trim())) || 4;
    } else if (key === "DrainRate") {
      const v = parseFloat(line.slice(i + 1).trim());
      if (Number.isFinite(v)) drainRate = Math.min(10, Math.max(0, v));
    }
  });

  // Events
  // 背景/视频行形如：0,0,"bg.jpg",0,0  /  1,0,"bg.jpg"  /  Video,0,"v.avi"
  let backgroundFilename = "";
  (sections["Events"] || []).forEach((line) => {
    if (backgroundFilename) return;
    const m = line.match(/^(?:0|1|Video)\s*,\s*-?\d+\s*,\s*"([^"]+)"/i);
    if (m) backgroundFilename = m[1];
  });

  // Metadata
  const meta = {};
  (sections["Metadata"] || []).forEach((line) => {
    const i = line.indexOf(":");
    if (i < 0) return;
    meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  });

  // TimingPoints
  const timingPoints = [];
  (sections["TimingPoints"] || []).forEach((line) => {
    const p = line.split(",");
    if (p.length < 2) return;
    timingPoints.push({
      time: +p[0], beatLength: +p[1], meter: +p[2] || 4, inherited: +p[1] < 0,
    });
  });

  // HitObjects
  const hitObjects = [];
  let noteCount = 0, lnCount = 0;
  (sections["HitObjects"] || []).forEach((line) => {
    const p = line.split(",");
    if (p.length < 5) return;
    const x = +p[0];
    const time = +p[2];
    const type = +p[3];
    let endTime = 0;
    if (type & LN_BIT && p.length >= 6) {
      const ci = p[5].indexOf(":");
      endTime = ci > 0 ? +p[5].slice(0, ci) : +p[5];
    }
    hitObjects.push({ x, time, type, endTime });
    if (type & LN_BIT) lnCount++;
    else noteCount++;
  });
  hitObjects.sort((a, b) => a.time - b.time);

  const lastObj = hitObjects.reduce((mx, o) => Math.max(mx, o.time, o.endTime || 0), 0);
  const durationMs = lastObj + 1000;

  // BPM：取第一个非继承 timing point
  const utp = timingPoints.find((tp) => !tp.inherited && tp.beatLength > 0);
  const bpm = utp ? 60000 / utp.beatLength : 0;

  return {
    mode, circleSize: cs, drainRate, previewTime, audioFilename, backgroundFilename,
    title: meta.Title || meta.TitleUnicode || "未命名",
    artist: meta.Artist || meta.ArtistUnicode || "未知",
    creator: meta.Creator || "", version: meta.Version || "",
    bpm, timingPoints, hitObjects, noteCount, lnCount, durationMs,
    beatSects: buildBeatSections(timingPoints, durationMs),
    barLines: buildBarLines(timingPoints, hitObjects, lastObj),
    hitIndex: buildHitIndex(hitObjects),
  };
}

/**
 * 生成小节线，对齐官方 BarLineGenerator<TBarLine>：
 * 只有非继承 timing point 参与；小节长 = beatLength × meter；
 * 起点 = timingPoint.Time（若早于 Math.Min(0, 首个物件时间) 则按小节对齐后取整）；
 * 终点 = 下一个非继承 timing point 时间，最后一段 = 1 + 最后物件时间 + 一小节；
 * Major = 小节内的拍序 % meter === 0。
 * @param {Array} timingPoints 解析结果（含 {time, beatLength, meter, inherited}）
 * @param {Array} hitObjects 已按时间升序排序的物件
 * @param {number} lastObjectTime 最后物件的结束时间
 * @returns {Array<{t:number, major:boolean}>}
 */
export function buildBarLines(timingPoints, hitObjects, lastObjectTime) {
  const out = [];
  const utps = timingPoints.filter((tp) => !tp.inherited && tp.beatLength > 0);
  if (!utps.length || !hitObjects.length) return out;
  const EPS = 1e-3; // 官方 Precision.DOUBLE_EPSILON
  const generationStartTime = Math.min(0, hitObjects[0].time);
  const lastHitTime = 1 + lastObjectTime;
  for (let i = 0; i < utps.length; i++) {
    const tp = utps[i];
    const numerator = tp.meter > 0 ? tp.meter : 4;
    const barLength = tp.beatLength * numerator;
    const endTime = i < utps.length - 1 ? utps[i + 1].time : lastHitTime + barLength;
    const startTime = tp.time > generationStartTime
      ? tp.time
      : tp.time + Math.ceil((generationStartTime - tp.time) / barLength) * barLength;

    let beat = 0;
    for (let t = startTime; t <= endTime + EPS; t += barLength, beat++) {
      // 浮点误差导致 t 略小于整数时对齐取整（官方 AlmostEquals 处理）
      const rounded = Math.round(t);
      if (Math.abs(t - rounded) < EPS) t = rounded;
      out.push({ t, major: beat % numerator === 0 });
    }
  }
  return out;
}

/** 无继承 timing point -> [[起, 拍长, 止], ...]，画节拍网格用。 */
function buildBeatSections(timingPoints, totalMs) {
  const utps = timingPoints.filter((tp) => !tp.inherited && tp.beatLength > 0);
  if (!utps.length) return [[0, 500, totalMs + 1]];
  const srt = utps.slice().sort((a, b) => a.time - b.time);
  return srt.map((tp, i) => [
    tp.time, tp.beatLength, i + 1 < srt.length ? srt[i + 1].time : totalMs + 1,
  ]);
}

/** 音符时间索引：按时间升序，供二分定位可视窗口。 */
function buildHitIndex(hitObjects) {
  const starts = [], ends = [], lnEnds = [];
  for (let i = 0; i < hitObjects.length; i++) {
    const o = hitObjects[i];
    starts.push({ t: o.time, x: o.x, type: o.type, endTime: o.endTime, idx: i });
    if (o.type & LN_BIT && o.endTime) {
      ends.push(o.endTime);
      lnEnds.push({ t: o.time, end: o.endTime, x: o.x, idx: i });
    }
  }
  starts.sort((a, b) => a.t - b.t);
  ends.sort((a, b) => a - b);
  lnEnds.sort((a, b) => a.t - b.t);
  return { starts, ends, lnEnds };
}

/** 二分查找：返回首个 >= t 的索引。 */
export function bisectLeft(arr, t, key) {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((key ? arr[mid][key] : arr[mid]) < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}