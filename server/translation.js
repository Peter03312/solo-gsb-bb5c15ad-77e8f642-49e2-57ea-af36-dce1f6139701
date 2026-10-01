'use strict';

// 双语译文：录入、复核与双语 SRT 导出
//
// 约定：
//   - 译文是分支片段自身的属性（branch_segments.translation，NULL=未录入）；
//     复核状态 translation_reviewed：0 待复核 / 1 已复核，空译文不能复核；
//   - 译文与对应原文绑定：原文改动后译文保留供参考但转为待复核；
//     纯时码调整（含重剪重排）不影响复核状态；
//   - 拆分：两条均保留原译文作参考且转为待复核；
//     合并：按原顺序拼接已有译文且转为待复核；
//     恢复原稿 / 整支重置：清空受影响译文；
//   - 译文与复核状态的变化不推进片段 rev（不影响质检报告/豁免）；
//   - 双语 SRT 导出闸门：任何空译文、待复核片段或时间线错误都列出片段并拒绝整份导出。

const { validateTimeline, msToSrt } = require('./srt');

class TranslationError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.statusCode = status;
    Object.assign(this, extra || {});
  }
}

const MAX_TRANSLATION_LEN = 2000;

/**
 * 是否有非空译文（空白视为未录入）。
 */
function hasTranslation(v) {
  return v != null && String(v).trim() !== '';
}

function getSeg(db, branchId, segId) {
  const seg = db.prepare(
    'SELECT id, translation, translation_reviewed FROM branch_segments WHERE id = ? AND branch_id = ?'
  ).get(segId, branchId);
  if (!seg) throw new TranslationError(404, '片段不存在');
  return seg;
}

/**
 * 录入/清除译文。空串（或纯空白）表示清除译文。
 * 译文内容变化时复核状态重置为待复核；不推进 rev，不影响质检报告/豁免。
 */
function setTranslation(db, branch, segId, raw) {
  if (typeof raw !== 'string') {
    throw new TranslationError(400, 'translation 必须为字符串（传空字符串清除译文）');
  }
  if (raw.length > MAX_TRANSLATION_LEN) {
    throw new TranslationError(400, `译文不能超过 ${MAX_TRANSLATION_LEN} 字`);
  }
  const seg = getSeg(db, branch.id, segId);
  const next = raw.trim() === '' ? null : raw;
  const cur = seg.translation ?? null;
  if (next === cur) {
    return {
      ok: true,
      changed: false,
      translation: cur,
      translation_reviewed: seg.translation_reviewed ? 1 : 0
    };
  }
  db.prepare(
    'UPDATE branch_segments SET translation = ?, translation_reviewed = 0 WHERE id = ?'
  ).run(next, segId);
  return { ok: true, changed: true, translation: next, translation_reviewed: 0 };
}

/**
 * 标记/取消复核。空译文不能标记已复核。
 */
function setReviewed(db, branch, segId, reviewed) {
  if (typeof reviewed !== 'boolean') {
    throw new TranslationError(400, 'reviewed 必须为布尔值（true 标记已复核 / false 转为待复核）');
  }
  const seg = getSeg(db, branch.id, segId);
  if (reviewed && !hasTranslation(seg.translation)) {
    throw new TranslationError(400, '空译文不能标记为已复核，请先录入译文');
  }
  const flag = reviewed ? 1 : 0;
  if ((seg.translation_reviewed ? 1 : 0) === flag) {
    return { ok: true, changed: false, translation_reviewed: flag };
  }
  db.prepare('UPDATE branch_segments SET translation_reviewed = ? WHERE id = ?').run(flag, segId);
  return { ok: true, changed: true, translation_reviewed: flag };
}

/**
 * 双语导出阻断项：逐段检查空译文与待复核。
 */
function bilingualIssues(segments) {
  const issues = [];
  for (const s of segments) {
    const timecode = `${msToSrt(s.start_ms)} --> ${msToSrt(s.end_ms)}`;
    if (!hasTranslation(s.translation)) {
      issues.push({
        ord: s.ord,
        timecode,
        issue: 'missing_translation',
        message: `片段 #${s.ord} 缺少译文（空译文不能导出双语字幕）`
      });
    } else if (!s.translation_reviewed) {
      issues.push({
        ord: s.ord,
        timecode,
        issue: 'pending_review',
        message: `片段 #${s.ord} 译文尚未复核（原文或译文变动后需重新复核）`
      });
    }
  }
  return issues;
}

/**
 * 双语导出闸门：空译文 / 待复核 / 时间线错误任一存在即拒绝整份导出。
 */
function bilingualGate(segments) {
  const bilingual_issues = bilingualIssues(segments);
  const timeline_issues = validateTimeline(segments);
  return {
    can_export: bilingual_issues.length === 0 && timeline_issues.length === 0,
    bilingual_issues,
    timeline_issues
  };
}

/**
 * 序列化为双语 SRT：逐段输出原文与译文，沿用当前时码，序号从 1 连续编号。
 */
function toBilingualSrt(segments) {
  return segments.map((s, idx) => {
    const orig = String(s.text).replace(/\s+$/g, '');
    const tr = String(s.translation).replace(/\s+$/g, '');
    return `${idx + 1}\n${msToSrt(s.start_ms)} --> ${msToSrt(s.end_ms)}\n${orig}\n${tr}`;
  }).join('\n\n') + '\n';
}

module.exports = {
  TranslationError,
  hasTranslation,
  setTranslation,
  setReviewed,
  bilingualIssues,
  bilingualGate,
  toBilingualSrt
};
