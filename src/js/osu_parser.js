// .osu 谱面解析（借鉴 temp\Beatmap_Preview_v-main\index.js 的 parseOsuFileHits）。
// 输出结构化数据供预览对局模式逐帧渲染使用：HitObjects / timing /
// 键数（CircleSize）/ duration / 预览时间 / BPM，以及预计算时间索引、节拍段。

// 长条判定位：type & 128 = LN，endTime 从第 6 列冒号前解析
const LN_BIT = 128;

/**
 * 解析 .osu 谱面文本。
 * @param {string} content .osu 全文
 * @returns {object} { mode, circleSize, previewTime, title, artist, creator, version,
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
  (sections["Difficulty"] || []).forEach((line) => {
    const i = line.indexOf(":");
    if (i < 0) return;
    if (line.slice(0, i).trim() === "CircleSize") {
      cs = Math.round(parseFloat(line.slice(i + 1).trim())) || 4;
    }
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
    mode, circleSize: cs, previewTime, audioFilename,
    title: meta.Title || meta.TitleUnicode || "未命名",
    artist: meta.Artist || meta.ArtistUnicode || "未知",
    creator: meta.Creator || "", version: meta.Version || "",
    bpm, timingPoints, hitObjects, noteCount, lnCount, durationMs,
    beatSects: buildBeatSections(timingPoints, durationMs),
    hitIndex: buildHitIndex(hitObjects),
  };
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