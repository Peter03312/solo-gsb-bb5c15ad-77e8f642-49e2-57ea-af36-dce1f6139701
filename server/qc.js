'use strict';

// 放映质检（QC）核心：规则校验、命中评估、报告生成与豁免判定
//
// 设计约定：
//   - 规则每份稿件一份，实质变化时归档为新版本（qc_rule_versions）；
//   - 豁免绑定「分支 + 规则版本 + 片段id + 片段rev + 命中指纹(hit_key)」，
//     片段文案/时码一经改动 rev 即 +1（拆分/合并/恢复同理），豁免随之失效；
//   - 报告为生成时刻的快照；分支片段变化后 state_hash 不一致即标记失效，
//     拆分/合并/编辑后必须重新生成报告，不沿用旧结果；
//   - 质检导出闸门永远按当前片段、当前规则、当前豁免实时核验。

const crypto = require('crypto');
const { validateTimeline, msToSrt } = require('./srt');

class QcError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.statusCode = status;
    Object.assign(this, extra || {});
  }
}

// ---------------- 基础计算 ----------------

/**
 * 可见字符数：空白不计字符，其余每个码位（含中文与标点）各算一字。
 */
function visibleLength(text) {
  if (text == null) return 0;
  let n = 0;
  for (const ch of String(text)) {
    if (!/\s/.test(ch)) n += 1;
  }
  return n;
}

function sec2(ms) {
  return (ms / 1000).toFixed(2);
}

// ---------------- 规则校验 ----------------

/**
 * 校验并规范化规则输入。
 * 输入：{min_duration, max_duration, max_cps, min_gap, banned_words}
 *   - 时长/间隔为秒（数字或数字字符串）；cps 为每秒字符数；
 *   - banned_words 为字符串（换行/逗号分隔）或数组。
 * 输出：{values:{min_duration_ms,max_duration_ms,max_cps,min_gap_ms,banned_words}, errors}
 */
function normalizeRuleInput(body) {
  const errors = [];
  const values = {
    min_duration_ms: null,
    max_duration_ms: null,
    max_cps: null,
    min_gap_ms: null,
    banned_words: []
  };

  function readPositiveSeconds(key, label) {
    const raw = body[key];
    if (raw === undefined || raw === null || raw === '') return null;
    if (typeof raw === 'boolean') {
      errors.push({ field: key, message: `${label}必须是数字（秒）` });
      return null;
    }
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) {
      errors.push({ field: key, message: `${label}必须为大于 0 的数字（秒）` });
      return null;
    }
    return Math.round(n * 1000);
  }

  function readGap(key, label) {
    const raw = body[key];
    if (raw === undefined || raw === null || raw === '') return null;
    if (typeof raw === 'boolean') {
      errors.push({ field: key, message: `${label}必须是数字（秒）` });
      return null;
    }
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) {
      errors.push({ field: key, message: `${label}必须为不小于 0 的数字（秒）` });
      return null;
    }
    return Math.round(n * 1000);
  }

  function readCps(key, label) {
    const raw = body[key];
    if (raw === undefined || raw === null || raw === '') return null;
    if (typeof raw === 'boolean') {
      errors.push({ field: key, message: `${label}必须是数字` });
      return null;
    }
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) {
      errors.push({ field: key, message: `${label}必须为大于 0 的数字（字符/秒）` });
      return null;
    }
    return n;
  }

  values.min_duration_ms = readPositiveSeconds('min_duration', '单条显示时长下限');
  values.max_duration_ms = readPositiveSeconds('max_duration', '单条显示时长上限');
  values.max_cps = readCps('max_cps', '每秒可见字符数上限');
  values.min_gap_ms = readGap('min_gap', '相邻片段最小间隔');

  if (
    values.min_duration_ms != null && values.max_duration_ms != null &&
    values.min_duration_ms > values.max_duration_ms
  ) {
    errors.push({
      field: 'min_duration',
      message: `单条显示时长下限（${sec2(values.min_duration_ms)} 秒）不能大于上限（${sec2(values.max_duration_ms)} 秒）`
    });
  }

  // 禁用词：接受字符串（按行/英文逗号/中文逗号拆分）或数组
  const bw = body.banned_words;
  let words = [];
  if (bw === undefined || bw === null) {
    words = [];
  } else if (Array.isArray(bw)) {
    words = bw.slice();
  } else if (typeof bw === 'string') {
    words = bw.trim() === '' ? [] : bw.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split(/[\n,，]/);
  } else {
    errors.push({ field: 'banned_words', message: '禁用词必须为文本或数组' });
  }
  if (!errors.some((e) => e.field === 'banned_words')) {
    const trimmed = words.map((w) => (typeof w === 'string' ? w.trim() : String(w).trim()));
    for (const w of trimmed) {
      if (w === '') {
        errors.push({ field: 'banned_words', message: '禁用词不能为空词（请勿留空行或多余分隔符）' });
        break;
      }
    }
    const seen = new Set();
    for (const w of trimmed) {
      if (w === '') continue;
      if (seen.has(w)) {
        errors.push({ field: 'banned_words', message: `禁用词重复：「${w}」` });
        break;
      }
      seen.add(w);
    }
    values.banned_words = trimmed.filter((w) => w !== '');
  }

  return { values, errors };
}

function rulesFingerprint(values) {
  const payload = JSON.stringify({
    min_duration_ms: values.min_duration_ms ?? null,
    max_duration_ms: values.max_duration_ms ?? null,
    max_cps: values.max_cps ?? null,
    min_gap_ms: values.min_gap_ms ?? null,
    banned_words: values.banned_words
  });
  return crypto.createHash('sha256').update(payload).digest('hex');
}

// ---------------- 命中评估 ----------------

const RULE_LABELS = {
  duration: '显示时长',
  cps: '字符速度',
  gap: '片段间隔',
  banned: '禁用词'
};

/**
 * 按当前规则评估当前分支片段。
 * @param segments 带 id/ord/rev/start_ms/end_ms/text 的片段（按 ord 有序）
 * @param rules qc_rule_versions 行（含 banned_words 解析）
 * @param sourceSeqById Map<source_id, seq>
 * @returns 命中数组（字段与实时核验/报告快照共用）
 */
function evaluate(segments, rules, sourceSeqById) {
  const hits = [];
  const words = JSON.parse(rules.banned_words_json || '[]');

  for (const seg of segments) {
    const dur = seg.end_ms - seg.start_ms;
    const chars = visibleLength(seg.text);
    const srcSeqs = sourceSeqsOf(seg, sourceSeqById);

    if (rules.min_duration_ms != null && dur < rules.min_duration_ms) {
      const actual = dur < 0 ? '时间异常（终点早于起点）' : `${sec2(dur)} 秒`;
      hits.push(mkHit({
        type: 'duration', seg, srcSeqs,
        hitKey: `${seg.id}@${seg.rev}:duration<${rules.min_duration_ms}`,
        message: `显示时长 ${actual}，低于下限 ${sec2(rules.min_duration_ms)} 秒`,
        detail: { metric: 'duration_ms', actual_ms: dur, limit_ms: rules.min_duration_ms, bound: 'min' }
      }));
    }
    if (rules.max_duration_ms != null && dur > rules.max_duration_ms) {
      const actual = dur < 0 ? '时间异常（终点早于起点）' : `${sec2(dur)} 秒`;
      hits.push(mkHit({
        type: 'duration', seg, srcSeqs,
        hitKey: `${seg.id}@${seg.rev}:duration>${rules.max_duration_ms}`,
        message: `显示时长 ${actual}，超过上限 ${sec2(rules.max_duration_ms)} 秒`,
        detail: { metric: 'duration_ms', actual_ms: dur, limit_ms: rules.max_duration_ms, bound: 'max' }
      }));
    }
    if (rules.max_cps != null && dur > 0) {
      const cps = chars / (dur / 1000);
      if (cps > rules.max_cps) {
        hits.push(mkHit({
          type: 'cps', seg, srcSeqs,
          hitKey: `${seg.id}@${seg.rev}:cps<${cpsKey(rules.max_cps)}`,
          message: `每秒可见字符数 ${cps.toFixed(2)}（${chars} 字 / ${sec2(dur)} 秒），超过上限 ${rules.max_cps}`,
          detail: { metric: 'cps', actual_cps: round4(cps), chars, duration_ms: dur, limit_cps: rules.max_cps }
        }));
      }
    }
    if (words.length) {
      for (const word of words) {
        const idx = seg.text.indexOf(word);
        if (idx >= 0) {
          const preview = excerptAround(seg.text, idx, word.length);
          hits.push(mkHit({
            type: 'banned', seg, srcSeqs,
            hitKey: `${seg.id}@${seg.rev}:banned:${sha(word)}`,
            message: `包含禁用词「${word}」（上下文：${preview}）`,
            excerpt: seg.text,
            detail: { metric: 'banned', word }
          }));
        }
      }
    }
  }

  // 相邻片段最小间隔：后一条起点 - 前一条终点
  if (rules.min_gap_ms != null && rules.min_gap_ms > 0) {
    for (let i = 1; i < segments.length; i++) {
      const prev = segments[i - 1];
      const seg = segments[i];
      const gap = seg.start_ms - prev.end_ms;
      if (gap < rules.min_gap_ms) {
        const gapText = gap < 0
          ? `时间重叠 ${sec2(-gap)} 秒`
          : `仅间隔 ${sec2(gap)} 秒`;
        const srcSeqs = Array.from(new Set([
          ...sourceSeqsOf(prev, sourceSeqById),
          ...sourceSeqsOf(seg, sourceSeqById)
        ])).sort((a, b) => a - b);
        hits.push({
          rule_type: 'gap',
          ord: seg.ord,
          start_segment_id: seg.id,
          start_seg_rev: seg.rev,
          end_segment_id: prev.id,
          end_seg_rev: prev.rev,
          source_seqs: srcSeqs,
          hit_key: `${seg.id}@${seg.rev}|${prev.id}@${prev.rev}:gap>=${rules.min_gap_ms}`,
          message: `与上一片段 #${prev.ord} ${gapText}（${msToSrt(prev.end_ms)} → ${msToSrt(seg.start_ms)}），不足最小间隔 ${sec2(rules.min_gap_ms)} 秒`,
          start_ms: seg.start_ms,
          end_ms: seg.end_ms,
          text_excerpt: seg.text,
          detail: {
            metric: 'gap_ms', actual_ms: gap, limit_ms: rules.min_gap_ms,
            prev_ord: prev.ord, prev_end_ms: prev.end_ms, next_start_ms: seg.start_ms
          }
        });
      }
    }
  }

  hits.sort((a, b) => (a.ord - b.ord) || a.rule_type.localeCompare(b.rule_type) || a.hit_key.localeCompare(b.hit_key));
  return hits;
}

function mkHit({ type, seg, srcSeqs, hitKey, message, detail, excerpt }) {
  return {
    rule_type: type,
    ord: seg.ord,
    start_segment_id: seg.id,
    start_seg_rev: seg.rev,
    end_segment_id: null,
    end_seg_rev: null,
    source_seqs: srcSeqs,
    hit_key: hitKey,
    message,
    start_ms: seg.start_ms,
    end_ms: seg.end_ms,
    text_excerpt: excerpt != null ? excerpt : seg.text,
    detail
  };
}

function sourceSeqsOf(seg, sourceSeqById) {
  const ids = seg.source_ids || [];
  return Array.from(new Set(ids.map((id) => sourceSeqById.get(id)).filter((s) => s != null)))
    .sort((a, b) => a - b);
}

function cpsKey(n) { return String(round4(n)); }
function round4(n) { return Math.round(n * 10000) / 10000; }
function sha(s) { return crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 16); }

function excerptAround(text, idx, len) {
  const lo = Math.max(0, idx - 6);
  const hi = Math.min(text.length, idx + len + 6);
  return (lo > 0 ? '…' : '') + text.slice(lo, hi).replace(/\s+/g, ' ') + (hi < text.length ? '…' : '');
}

// ---------------- 状态指纹 ----------------

/**
 * 分支片段整体指纹：用于判断报告生成后分支是否发生过任何变化。
 */
function branchStateHash(segments) {
  const payload = segments.map((s) => [
    s.ord, s.start_ms, s.end_ms, s.text,
    (s.source_ids || []).slice().sort((a, b) => a - b)
  ]);
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

// ---------------- 数据访问 ----------------

function getCurrentRulesRow(db, scriptId) {
  const cur = db.prepare('SELECT current_version_id FROM qc_rules WHERE script_id = ?').get(scriptId);
  if (!cur) return null;
  return db.prepare('SELECT * FROM qc_rule_versions WHERE id = ?').get(cur.current_version_id);
}

function rulesRowToApi(row) {
  return {
    version_id: row.id,
    version_no: row.version_no,
    min_duration_ms: row.min_duration_ms,
    max_duration_ms: row.max_duration_ms,
    max_cps: row.max_cps,
    min_gap_ms: row.min_gap_ms,
    banned_words: JSON.parse(row.banned_words_json || '[]'),
    created_at: row.created_at
  };
}

/**
 * 保存规则：内容与当前版本一致则不新增版本（豁免继续有效）；否则归档为新版本。
 * @returns {{version_id:number, version_no:number, changed:boolean}}
 */
function saveRules(db, scriptId, values) {
  const fp = rulesFingerprint(values);
  const current = getCurrentRulesRow(db, scriptId);
  if (current && rulesFingerprint({
    min_duration_ms: current.min_duration_ms,
    max_duration_ms: current.max_duration_ms,
    max_cps: current.max_cps,
    min_gap_ms: current.min_gap_ms,
    banned_words: JSON.parse(current.banned_words_json || '[]')
  }) === fp) {
    return { version_id: current.id, version_no: current.version_no, changed: false };
  }

  return db.transaction(() => {
    const nextNo = current ? current.version_no + 1 : 1;
    const info = db.prepare(`
      INSERT INTO qc_rule_versions
        (script_id, version_no, min_duration_ms, max_duration_ms, max_cps, min_gap_ms, banned_words_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      scriptId, nextNo,
      values.min_duration_ms, values.max_duration_ms, values.max_cps, values.min_gap_ms,
      JSON.stringify(values.banned_words)
    );
    db.prepare(`
      INSERT INTO qc_rules (script_id, current_version_id, updated_at)
      VALUES (?, ?, datetime('now'))
      ON CONFLICT(script_id) DO UPDATE SET current_version_id = excluded.current_version_id,
                                          updated_at = datetime('now')
    `).run(scriptId, info.lastInsertRowid);
    return { version_id: Number(info.lastInsertRowid), version_no: nextNo, changed: true };
  })();
}

function getBranchWithScript(db, branchId) {
  const b = db.prepare('SELECT id, script_id, name, kind FROM branches WHERE id = ?').get(branchId);
  if (!b) throw new QcError(404, '分支不存在');
  return b;
}

function sourceSeqMap(db, scriptId) {
  const rows = db.prepare('SELECT id, seq FROM source_segments WHERE script_id = ?').all(scriptId);
  return new Map(rows.map((r) => [r.id, r.seq]));
}

// ---------------- 报告 ----------------

const HIT_COLS = `
  id, report_id, rule_type, ord, source_seqs_json, hit_key, message,
  start_ms, end_ms, text_excerpt, detail_json
`;

function hitFromRow(row) {
  return {
    id: row.id,
    rule_type: row.rule_type,
    rule_label: RULE_LABELS[row.rule_type] || row.rule_type,
    ord: row.ord,
    source_seqs: JSON.parse(row.source_seqs_json || '[]'),
    hit_key: row.hit_key,
    message: row.message,
    start_ms: row.start_ms,
    end_ms: row.end_ms,
    timecode: row.start_ms != null && row.end_ms != null
      ? `${msToSrt(row.start_ms)} --> ${msToSrt(row.end_ms)}` : null,
    text_excerpt: row.text_excerpt,
    detail: JSON.parse(row.detail_json || '{}')
  };
}

/**
 * 生成报告快照并返回 API 形态（含当前豁免状态）。
 * @param {object} getSegments(branchId) 返回带 source_ids 的片段（merge.js 实现）
 */
function generateReport(db, branchId, getSegments) {
  const branch = getBranchWithScript(db, branchId);
  const rules = getCurrentRulesRow(db, branch.script_id);
  if (!rules) throw new QcError(409, '尚未配置质检规则，请先为该稿件配置质检规则');

  const segments = getSegments(db, branchId).map(withRev(db, branchId));
  const seqMap = sourceSeqMap(db, branch.script_id);
  const hits = evaluate(segments, rules, seqMap);
  const timelineIssues = validateTimeline(segments);
  const hash = branchStateHash(segments);

  const reportId = db.transaction(() => {
    const info = db.prepare(`
      INSERT INTO qc_reports (branch_id, rule_version_id, state_hash, timeline_issues_json)
      VALUES (?, ?, ?, ?)
    `).run(branchId, rules.id, hash, JSON.stringify(timelineIssues));
    const ins = db.prepare(`
      INSERT INTO qc_hits
        (report_id, rule_type, ord, source_seqs_json, hit_key, message,
         start_ms, end_ms, text_excerpt, detail_json)
      VALUES (@report_id, @rule_type, @ord, @source_seqs_json, @hit_key, @message,
              @start_ms, @end_ms, @text_excerpt, @detail_json)
    `);
    for (const h of hits) {
      ins.run({
        report_id: info.lastInsertRowid,
        rule_type: h.rule_type,
        ord: h.ord,
        source_seqs_json: JSON.stringify(h.source_seqs),
        hit_key: h.hit_key,
        message: h.message,
        start_ms: h.start_ms,
        end_ms: h.end_ms,
        text_excerpt: h.text_excerpt,
        detail_json: JSON.stringify(h.detail || {})
      });
    }
    return Number(info.lastInsertRowid);
  })();

  return getReport(db, reportId, getSegments);
}

function withRev(db, branchId) {
  const revById = new Map(
    db.prepare('SELECT id, rev FROM branch_segments WHERE branch_id = ?')
      .all(branchId)
      .map((r) => [r.id, r.rev])
  );
  return (seg) => ({ ...seg, rev: revById.get(seg.id) ?? 1 });
}

/**
 * 读取报告：按当前片段指纹判断是否失效；新鲜时实时匹配豁免状态。
 */
function getReport(db, reportId, getSegments) {
  const row = db.prepare('SELECT * FROM qc_reports WHERE id = ?').get(reportId);
  if (!row) throw new QcError(404, '质检报告不存在');
  const branch = getBranchWithScript(db, row.branch_id);
  const rules = db.prepare('SELECT * FROM qc_rule_versions WHERE id = ?').get(row.rule_version_id);
  const hitRows = db.prepare(
    `SELECT ${HIT_COLS} FROM qc_hits WHERE report_id = ? ORDER BY ord, id`
  ).all(reportId);
  const storedIssues = JSON.parse(row.timeline_issues_json || '[]');

  const base = {
    id: row.id,
    branch_id: row.branch_id,
    branch_name: branch.name,
    created_at: row.created_at,
    rule_version: { id: rules.id, version_no: rules.version_no, created_at: rules.created_at },
    rules: rulesRowToApi(rules),
    timeline_issues: storedIssues,
    hit_count: hitRows.length
  };

  const segments = getSegments(db, row.branch_id).map(withRev(db, row.branch_id));
  const hash = branchStateHash(segments);
  if (hash !== row.state_hash) {
    // 拆分/合并/编辑后旧结果不得沿用：快照仅作留档
    return {
      ...base,
      stale: true,
      state_changed: true,
      hits: hitRows.map((r) => ({ ...hitFromRow(r), exemption: null, active: false }))
    };
  }

  // 规则版本是否仍是当前版本
  const current = getCurrentRulesRow(db, branch.script_id);
  const rulesCurrent = current && current.id === row.rule_version_id;

  // 实时核验豁免有效性
  const segById = new Map(segments.map((s) => [s.id, s]));
  const exemptions = db.prepare(`
    SELECT * FROM qc_exemptions
    WHERE branch_id = ? AND rule_version_id = ? AND revoked_at IS NULL
  `).all(row.branch_id, row.rule_version_id);
  const exByKey = new Map();
  const invalidExemptions = [];
  for (const ex of exemptions) {
    const verdict = checkExemption(ex, segById);
    if (verdict.ok) {
      if (!exByKey.has(ex.hit_key)) exByKey.set(ex.hit_key, ex);
    } else {
      invalidExemptions.push(exemptionApi(ex, verdict.reason));
    }
  }

  const hits = hitRows.map((r) => {
    const h = hitFromRow(r);
    const ex = exByKey.get(r.hit_key);
    h.exemption = ex ? exemptionApi(ex, null) : null;
    h.active = !ex;
    return h;
  });

  const unresolved = hits.filter((h) => !h.exemption).length;
  return {
    ...base,
    stale: !rulesCurrent,
    state_changed: false,
    rules_current: !!rulesCurrent,
    hits,
    invalid_exemptions: invalidExemptions,
    unresolved_count: unresolved,
    exempted_count: hits.length - unresolved,
    timeline_ok: storedIssues.length === 0,
    passed: unresolved === 0 && storedIssues.length === 0 && rulesCurrent
  };
}

function getLatestReport(db, branchId, getSegments) {
  const row = db.prepare(
    'SELECT id FROM qc_reports WHERE branch_id = ? ORDER BY id DESC LIMIT 1'
  ).get(branchId);
  if (!row) return null;
  return getReport(db, row.id, getSegments);
}

/**
 * 豁免有效性判定：
 *   规则版本一致；命中涉及的片段仍存在且 rev 未变；命中指纹仍出现在当前命中中。
 */
function checkExemption(ex, segById) {
  const s1 = segById.get(ex.start_segment_id);
  if (!s1) return { ok: false, reason: '所针对的片段已不存在（可能已被合并或删除）' };
  if (s1.rev !== ex.start_seg_rev) {
    return { ok: false, reason: '片段文案或时码在豁免后发生过变化' };
  }
  if (ex.end_segment_id != null) {
    const s2 = segById.get(ex.end_segment_id);
    if (!s2) return { ok: false, reason: '所针对的相邻片段已不存在（可能已被合并或删除）' };
    if (s2.rev !== ex.end_seg_rev) {
      return { ok: false, reason: '相邻片段文案或时码在豁免后发生过变化' };
    }
  }
  return { ok: true };
}

function exemptionApi(ex, invalidReason) {
  return {
    id: ex.id,
    branch_id: ex.branch_id,
    rule_version_id: ex.rule_version_id,
    hit_key: ex.hit_key,
    rule_type: ex.rule_type,
    rule_label: RULE_LABELS[ex.rule_type] || ex.rule_type,
    ord: ex.ord_at_creation,
    source_seqs: JSON.parse(ex.source_seqs_json || '[]'),
    hit_message: ex.hit_message,
    reason: ex.reason,
    created_at: ex.created_at,
    revoked: !!ex.revoked_at,
    invalid_reason: invalidReason
  };
}

// ---------------- 豁免操作 ----------------

/**
 * 对某条命中填写豁免理由。必须针对最新报告中当前仍存在、未豁免的命中。
 */
function grantExemption(db, branchId, hitId, reason, getSegments) {
  const reasonText = typeof reason === 'string' ? reason.trim() : '';
  if (!reasonText) throw new QcError(400, '请填写豁免理由');
  if (reasonText.length > 500) throw new QcError(400, '豁免理由不能超过 500 字');

  const branch = getBranchWithScript(db, branchId);
  const latest = db.prepare(
    'SELECT id FROM qc_reports WHERE branch_id = ? ORDER BY id DESC LIMIT 1'
  ).get(branchId);
  if (!latest) throw new QcError(409, '请先生成质检报告');

  const hit = db.prepare('SELECT * FROM qc_hits WHERE id = ? AND report_id = ?').get(hitId, latest.id);
  if (!hit) throw new QcError(404, '命中不存在或属于旧报告；拆分、合并或编辑后请重新生成报告');

  // 报告必须仍反映当前片段与当前规则
  const report = getReport(db, latest.id, getSegments);
  if (report.state_changed) {
    throw new QcError(409, '报告已因片段变化失效（拆分/合并/编辑后旧结果不可沿用），请重新生成报告');
  }
  if (report.stale) {
    throw new QcError(409, '规则已更新，请按新规则重新生成报告后再豁免');
  }
  const liveHit = report.hits.find((h) => h.hit_key === hit.hit_key && h.id === hit.id);
  if (!liveHit) throw new QcError(409, '该命中在当前内容上已不存在，请重新生成报告');
  if (liveHit.exemption) throw new QcError(409, '该命中已被豁免');

  const detail = JSON.parse(hit.detail_json || '{}');
  const seg = db.prepare('SELECT id, rev FROM branch_segments WHERE id = ?').get(
    keyFirstSegId(hit.hit_key)
  );
  if (!seg) throw new QcError(409, '所针对的片段已不存在，请重新生成报告');

  let endSegId = null;
  let endSegRev = null;
  if (hit.rule_type === 'gap') {
    endSegId = detail.prev_ord != null
      ? segIdByOrd(db, branchId, detail.prev_ord)
      : keySecondSegId(hit.hit_key);
    const e2 = db.prepare('SELECT id, rev FROM branch_segments WHERE id = ?').get(endSegId);
    if (!e2) throw new QcError(409, '所针对的相邻片段已不存在，请重新生成报告');
    endSegId = e2.id;
    endSegRev = e2.rev;
  }

  const info = db.prepare(`
    INSERT INTO qc_exemptions
      (branch_id, rule_version_id, hit_key, rule_type,
       start_segment_id, start_seg_rev, end_segment_id, end_seg_rev,
       ord_at_creation, source_seqs_json, hit_message, reason)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    branchId, report.rule_version.id, hit.hit_key, hit.rule_type,
    seg.id, seg.rev, endSegId, endSegRev,
    hit.ord, hit.source_seqs_json, hit.message, reasonText
  );
  return getReport(db, latest.id, getSegments);
}

function keyFirstSegId(hitKey) {
  const m = /^(\d+)@/.exec(hitKey);
  return m ? Number(m[1]) : null;
}
function keySecondSegId(hitKey) {
  const m = /^\d+@\d+\|(\d+)@/.exec(hitKey);
  return m ? Number(m[1]) : null;
}
function segIdByOrd(db, branchId, ord) {
  const r = db.prepare('SELECT id FROM branch_segments WHERE branch_id = ? AND ord = ?').get(branchId, ord);
  return r ? r.id : null;
}

function revokeExemption(db, branchId, exemptionId, getSegments) {
  const ex = db.prepare(
    'SELECT id FROM qc_exemptions WHERE id = ? AND branch_id = ? AND revoked_at IS NULL'
  ).get(exemptionId, branchId);
  if (!ex) throw new QcError(404, '豁免不存在或已撤销');
  db.prepare("UPDATE qc_exemptions SET revoked_at = datetime('now') WHERE id = ?").run(exemptionId);
  const latest = db.prepare(
    'SELECT id FROM qc_reports WHERE branch_id = ? ORDER BY id DESC LIMIT 1'
  ).get(branchId);
  return latest ? getReport(db, latest.id, getSegments) : null;
}

// ---------------- 导出闸门 ----------------

/**
 * 质检专用下载的实时核验：重新核验分支、规则、豁免与当前时间线。
 * 仍有未豁免命中或时间线错误时抛出 409（携带具体问题）；否则返回片段。
 */
function checkGate(db, branchId, getSegments) {
  const branch = getBranchWithScript(db, branchId);
  const rules = getCurrentRulesRow(db, branch.script_id);
  if (!rules) {
    throw new QcError(409, '尚未配置质检规则，无法进行质检导出，请先配置规则并生成质检报告');
  }

  const latest = db.prepare(
    'SELECT id FROM qc_reports WHERE branch_id = ? ORDER BY id DESC LIMIT 1'
  ).get(branchId);
  if (!latest) throw new QcError(409, '尚未生成质检报告，请先运行放映质检');

  const segments = getSegments(db, branchId).map(withRev(db, branchId));
  const timelineIssues = validateTimeline(segments);
  const seqMap = sourceSeqMap(db, branch.script_id);
  const hits = evaluate(segments, rules, seqMap);

  const segById = new Map(segments.map((s) => [s.id, s]));
  const exemptions = db.prepare(`
    SELECT * FROM qc_exemptions
    WHERE branch_id = ? AND rule_version_id = ? AND revoked_at IS NULL
  `).all(branchId, rules.id);
  const activeKeys = new Set();
  const invalidExemptions = [];
  for (const ex of exemptions) {
    const verdict = checkExemption(ex, segById);
    if (verdict.ok) activeKeys.add(ex.hit_key);
    else invalidExemptions.push(exemptionApi(ex, verdict.reason));
  }

  const unresolvedHits = hits.filter((h) => !activeKeys.has(h.hit_key));

  // 最新报告是否仍有效（仅作提示：硬判定一律以实时核验的命中与时间线为准）
  const reportState = getReport(db, latest.id, getSegments);
  const reportStale = reportState.state_changed || reportState.stale;

  if (unresolvedHits.length || timelineIssues.length) {
    throw new QcError(409, `质检核验未通过，未生成 SRT（未豁免命中 ${unresolvedHits.length} 条，时间线问题 ${timelineIssues.length} 处${reportStale ? '；另：报告已失效，建议重新生成' : ''}）`, {
      timeline_issues: timelineIssues,
      unresolved_hits: unresolvedHits.map((h) => ({
        rule_type: h.rule_type,
        rule_label: RULE_LABELS[h.rule_type] || h.rule_type,
        ord: h.ord,
        source_seqs: h.source_seqs,
        message: h.message,
        detail: h.detail
      })),
      invalid_exemptions: invalidExemptions,
      report_stale: reportStale
    });
  }

  return { branch, segments, reportStale };
}

module.exports = {
  QcError,
  visibleLength,
  normalizeRuleInput,
  rulesFingerprint,
  evaluate,
  branchStateHash,
  getCurrentRulesRow,
  rulesRowToApi,
  saveRules,
  generateReport,
  getReport,
  getLatestReport,
  grantExemption,
  revokeExemption,
  checkGate,
  RULE_LABELS
};
