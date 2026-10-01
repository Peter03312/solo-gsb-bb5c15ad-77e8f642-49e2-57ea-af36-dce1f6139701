'use strict';

// SRT 解析、校验与序列化
//
// 解析策略：逐条扫描，遇到结构错误时报告位置并重新同步到下一条，
// 以便一次性收集全部错误。最终只要存在任何错误即拒绝整份稿件。

const TIME_RE = /^(\d{1,2}):(\d{2}):(\d{2}),(\d{3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2}),(\d{3})$/;

function pad2(n) { return String(n).padStart(2, '0'); }
function pad3(n) { return String(n).padStart(3, '0'); }

function msToSrt(ms) {
  if (!Number.isInteger(ms) || ms < 0) throw new Error('时间必须为非负整数毫秒');
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const x = ms % 1000;
  return `${pad2(h)}:${pad2(m)}:${pad2(s)},${pad3(x)}`;
}

function parseTime(str) {
  const m = TIME_RE.exec(str);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  const ranges = [[0, 99], [0, 59], [0, 59], [0, 999], [0, 99], [0, 59], [0, 59], [0, 999]];
  for (let i = 0; i < 8; i++) {
    if (parts[i] < ranges[i][0] || parts[i] > ranges[i][1]) return null;
  }
  const start = parts[0] * 3600000 + parts[1] * 60000 + parts[2] * 1000 + parts[3];
  const end = parts[4] * 3600000 + parts[5] * 60000 + parts[6] * 1000 + parts[7];
  return { start, end };
}

/**
 * 解析 SRT 文本。
 * @returns {{cues: Array<{seq:number,start_ms:number,end_ms:number,text:string}>, errors: Array<{line:number,message:string}>}}
 */
function parseSrt(raw) {
  const errors = [];
  let text = raw.replace(/^﻿/, '');
  text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = text.split('\n');

  const cues = [];
  let i = 0;
  let lastEnd = -1;
  let lastSeq = 0;
  // 跳过文件开头空行
  while (i < lines.length && lines[i].trim() === '') i++;

  while (i < lines.length) {
    const indexLine = i + 1;
    const indexStr = lines[i].trim();

    // 序号行必须是数字
    if (!/^\d+$/.test(indexStr)) {
      errors.push({ line: indexLine, message: `此处应为条目序号，实际为「${lines[i].slice(0, 40)}」` });
      // 重新同步：跳到下一个空行之后
      i = resync(lines, i);
      continue;
    }

    // 时间码行
    const timeLineNo = i + 2;
    if (i + 1 >= lines.length) {
      errors.push({ line: indexLine, message: `条目 ${indexStr} 缺少时间码行（格式应为 00:00:00,000 --> 00:00:00,000）` });
      break;
    }
    const timeLine = lines[i + 1].trim();
    const t = parseTime(timeLine);
    if (!t) {
      errors.push({ line: timeLineNo, message: `时间码格式错误：「${lines[i + 1].slice(0, 60)}」，应为 HH:MM:SS,mmm --> HH:MM:SS,mmm` });
      i = resync(lines, i);
      continue;
    }

    // 正文
    const body = [];
    let j = i + 2;
    while (j < lines.length && lines[j].trim() !== '') {
      body.push(lines[j].trimEnd());
      j++;
    }
    const cueText = body.join('\n').trim();
    const textStartLine = i + 3;
    if (cueText === '') {
      errors.push({ line: textStartLine, message: `条目 ${indexStr} 缺少字幕正文` });
    }

    // 序号必须从 1 开始且连续
    const seq = Number(indexStr);
    if (cues.length === 0 && seq !== 1) {
      errors.push({ line: indexLine, message: `首个序号必须为 1，实际为 ${seq}` });
    } else if (cues.length > 0 && seq !== lastSeq + 1) {
      errors.push({ line: indexLine, message: `序号不连续：上一条为 ${lastSeq}，此处为 ${seq}，应为 ${lastSeq + 1}` });
    }

    if (t.start < 0 || t.end < 0) {
      errors.push({ line: timeLineNo, message: `条目 ${indexStr} 时间码不能为负` });
    }
    if (t.start >= t.end) {
      errors.push({ line: timeLineNo, message: `条目 ${indexStr} 起点必须早于终点（${msToSrt(t.start)} --> ${msToSrt(t.end)}）` });
    }
    if (t.start < lastEnd) {
      errors.push({ line: timeLineNo, message: `条目 ${indexStr} 与上一条时间重叠或乱序（本条起点 ${msToSrt(t.start)} 早于上一条终点 ${msToSrt(lastEnd)}）` });
    }

    if (t.start < t.end && t.start >= lastEnd) {
      // 只有时间合法才推进比较链，避免错误条目引发连锁误报
      lastEnd = t.end;
    }
    lastSeq = seq;

    cues.push({ seq, start_ms: t.start, end_ms: t.end, text: cueText });

    // 跳过正文与分隔空行
    i = j;
    while (i < lines.length && lines[i].trim() === '') i++;
  }

  if (cues.length === 0 && errors.length === 0) {
    errors.push({ line: 1, message: '文件为空，未解析到任何字幕条目' });
  }

  return { cues, errors };
}

// 从出错行起找到下一个空行分隔，返回空行之后第一行的下标
function resync(lines, i) {
  let j = i;
  while (j < lines.length && lines[j].trim() !== '') j++;
  while (j < lines.length && lines[j].trim() === '') j++;
  return j;
}

/**
 * 校验一组待导出片段：时间非负、起点早于终点、按顺序不重叠。
 * @returns Array<{ord:number,message:string}>
 */
function validateTimeline(segments) {
  const issues = [];
  if (segments.length === 0) {
    issues.push({ ord: 0, message: '没有可导出的片段' });
    return issues;
  }
  let prevEnd = -1;
  for (const s of segments) {
    const ord = s.ord != null ? s.ord : 0;
    if (!Number.isInteger(s.start_ms) || !Number.isInteger(s.end_ms)) {
      issues.push({ ord, message: '时间值必须为整数毫秒' });
      continue;
    }
    if (s.start_ms < 0 || s.end_ms < 0) {
      issues.push({ ord, message: `时间不能为负（${msToSrt(Math.max(0, s.start_ms || 0))} --> ${msToSrt(Math.max(0, s.end_ms || 0))}）` });
    }
    if (s.start_ms >= s.end_ms) {
      issues.push({ ord, message: `起点必须早于终点（${msToSrt(Math.max(0, s.start_ms))} --> ${msToSrt(Math.max(0, s.end_ms))}）` });
    }
    if (s.start_ms < prevEnd) {
      issues.push({
        ord,
        message: `与上一片段时间重叠（上一片段终点 ${msToSrt(Math.max(0, prevEnd))}，本片段起点 ${msToSrt(Math.max(0, s.start_ms))}）`
      });
    }
    if (s.start_ms < s.end_ms && s.start_ms >= prevEnd) {
      prevEnd = s.end_ms;
    } else if (s.start_ms >= s.end_ms) {
      // 不推进 prevEnd
    } else {
      prevEnd = Math.max(prevEnd, s.end_ms);
    }
  }
  return issues;
}

/**
 * 序列化为序号连续的 SRT（序号从 1 重新编号）。
 */
function toSrt(segments) {
  return segments.map((s, idx) => {
    return `${idx + 1}\n${msToSrt(s.start_ms)} --> ${msToSrt(s.end_ms)}\n${s.text.replace(/\s+$/g, '')}`;
  }).join('\n\n') + '\n';
}

module.exports = { parseSrt, validateTimeline, toSrt, msToSrt, parseTime };
