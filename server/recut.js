'use strict';

// 重剪重排（视频重剪后的时码重排）
//
// 编辑在任一修订/合并分支上选择「连续的原稿来源序号区间」[lo, hi]，并给出该区间
// 在新版视频中的起止时码 [newStart, newEnd]：
//   - 区间之前的片段：时码不动；
//   - 区间内的完整片段：保持原有相对位置等比重排（线性映射到新区间）；
//   - 区间之后的片段：整体平移，平移量 = 新区间终点 - 原区间终点。
// 结构性约束（违反直接拒绝，不产生预览）：
//   - 来源区间必须有效且该区间的每个来源序号都出现在分支上；
//   - 同一来源拆出的片段必须一起处理（都在区间内或都在区间外）；
//   - 跨越选择边界的合并片段（来源集合同时含区间内、外序号）一律拒绝。
// 换算/时间线问题（无效区间、非正时长、负时码、换算后零时长、片段重叠）在预览中
// 列明并禁止提交；提交为单事务，整体成功或不改动。
//
// 预览令牌（token）= f(分支片段状态指纹, 输入参数)。预览后分支一旦被编辑、拆分、
// 合并或重置，状态指纹即变，提交时令牌校验失败（409），必须重新预览。
// 只有换算后时码确实变化的片段才推进 rev，从而使对应旧豁免/旧报告失效；时码未变
// 的片段 rev 不动，不会被误判为改动。

const crypto = require('crypto');
const { validateTimeline, msToSrt } = require('./srt');

class RecutError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.statusCode = status;
    Object.assign(this, extra || {});
  }
}

const TC_RE = /^(\d{1,2}):([0-5]\d):([0-5]\d)[,.](\d{3})$/;

function fmtSigned(ms) {
  const sign = ms < 0 ? '-' : '';
  return sign + msToSrt(Math.abs(ms));
}

function tcRange(startMs, endMs) {
  return `${fmtSigned(startMs)} --> ${fmtSigned(endMs)}`;
}

/**
 * 解析时码输入：非负整数毫秒，或 HH:MM:SS,mmm 字符串（小数点也接受）。
 */
function parseTimeInput(v, field) {
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || !Number.isInteger(v) || v < 0) {
      throw new RecutError(400, `${field} 必须为非负整数毫秒，或 HH:MM:SS,mmm 格式的非负时码`);
    }
    return v;
  }
  if (typeof v === 'string') {
    if (/^\d+$/.test(v.trim())) return Number(v.trim()); // 纯数字字符串按毫秒
    const m = TC_RE.exec(v.trim());
    if (!m) {
      throw new RecutError(400, `${field} 时间码格式错误：「${v.slice(0, 40)}」，应为 HH:MM:SS,mmm 或非负整数毫秒`);
    }
    return (+m[1]) * 3600000 + (+m[2]) * 60000 + (+m[3]) * 1000 + (+m[4]);
  }
  throw new RecutError(400, `${field} 必须为非负整数毫秒或 HH:MM:SS,mmm 时码字符串`);
}

function parseSeqInput(v, field) {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isInteger(n) || n < 1) {
    throw new RecutError(400, `${field} 必须为不小于 1 的整数（原稿来源序号）`);
  }
  return n;
}

/**
 * 分支片段状态指纹：覆盖身份/顺序/时码/文案/来源、演员归属与译文/复核状态，并纳入 rev，
 * 使任何编辑、拆分、合并、重置（片段 id 变化）、重新指定演员或改动译文都使预览令牌失效。
 * （归属/译文变化不推进 rev，但指纹直接纳入这些字段，令牌同样过期，需重新预览。）
 */
function recutStateHash(segments, revById) {
  const payload = segments.map((s) => [
    s.id, s.ord, s.start_ms, s.end_ms, s.text,
    (s.source_ids || []).slice().sort((a, b) => a - b),
    s.actor_id ?? null,
    s.translation ?? null,
    s.translation_reviewed ? 1 : 0,
    revById.get(s.id) ?? 1
  ]);
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function makeToken(branchId, stateHash, p) {
  const body = JSON.stringify({
    lo: p.source_start, hi: p.source_end,
    ns: p.new_start_ms, ne: p.new_end_ms
  });
  return crypto
    .createHash('sha256')
    .update(`recut-preview-v1|${branchId}|${stateHash}|${body}`)
    .digest('hex');
}

/**
 * 读取并校验重排输入参数。
 */
function readParams(body) {
  const b = body || {};
  const lo = parseSeqInput(b.source_start, 'source_start（来源起始序号）');
  const hi = parseSeqInput(b.source_end, 'source_end（来源结束序号）');
  if (lo > hi) {
    throw new RecutError(400, `无效区间：来源起始序号 ${lo} 大于结束序号 ${hi}`);
  }
  const newStart = parseTimeInput(b.new_start, 'new_start（新区间起点）');
  const newEnd = parseTimeInput(b.new_end, 'new_end（新区间终点）');
  if (newEnd <= newStart) {
    throw new RecutError(
      400,
      `新区间时长非正：起点 ${msToSrt(newStart)} 必须严格早于终点 ${msToSrt(newEnd)}，已拒绝`
    );
  }
  return { source_start: lo, source_end: hi, new_start_ms: newStart, new_end_ms: newEnd };
}

/**
 * 计算重排方案（不写库）。结构性问题抛 RecutError(400)；
 * 换算/时间线问题收集在返回值的 errors / timeline_issues 中，can_apply=false。
 */
function buildPlan(segments, revById, seqMap, params) {
  const { source_start: lo, source_end: hi, new_start_ms: newStart, new_end_ms: newEnd } = params;
  const structural = [];

  if (!segments.length) structural.push({ ord: 0, message: '分支上没有可重排的片段' });

  // 为每个片段计算来源序号集合（已排序去重）
  const annotated = segments.map((seg) => {
    const seqs = Array.from(new Set(
      (seg.source_ids || []).map((id) => seqMap.get(id)).filter((q) => q != null)
    )).sort((a, b) => a - b);
    return { seg, seqs };
  });

  for (const { seg, seqs } of annotated) {
    if (!seqs.length) {
      structural.push({
        ord: seg.ord,
        message: `片段 #${seg.ord} 没有原稿来源关联，无法按来源序号区间重排，已拒绝`
      });
    }
  }

  // 分类：inside（完整落入区间）/ before / after / straddle（跨越边界，拒绝）
  let firstInsideIdx = -1;
  let lastInsideIdx = -1;
  const covered = new Set();
  annotated.forEach((a, idx) => {
    const [s0, s1] = [a.seqs[0], a.seqs[a.seqs.length - 1]];
    if (s0 == null) { a.role = 'error'; return; }
    if (s0 >= lo && s1 <= hi) {
      a.role = 'inside';
      if (firstInsideIdx === -1) firstInsideIdx = idx;
      lastInsideIdx = idx;
      a.seqs.forEach((q) => covered.add(q));
    } else if (s1 < lo) {
      a.role = 'before';
    } else if (s0 > hi) {
      a.role = 'after';
    } else {
      a.role = 'straddle';
      structural.push({
        ord: a.seg.ord,
        message: `片段 #${a.seg.ord}（原稿来源 #${s0}${s1 === s0 ? '' : `–#${s1}`}）跨越所选区间边界 #${lo}–#${hi}，拒绝（同一来源拆分出的片段须整体在内/外，请先拆分跨界合并片段或调整区间）`
      });
    }
  });

  // 区间内每个来源序号都必须在分支片段中出现（同一来源拆出的多条也都在区间内）
  for (let q = lo; q <= hi; q++) {
    if (!covered.has(q)) {
      structural.push({
        ord: 0,
        message: `来源区间 #${lo}–#${hi} 中的原稿片段 #${q} 在当前分支上找不到对应片段，区间无效，已拒绝`
      });
    }
  }
  if (firstInsideIdx === -1 && !structural.some((e) => e.ord === 0)) {
    structural.push({ ord: 0, message: `来源区间 #${lo}–#${hi} 在当前分支上没有可重排的片段，区间无效` });
  }

  if (structural.length) {
    throw new RecutError(400, `重排区间校验失败，共 ${structural.length} 处问题，已拒绝（未改动任何片段）`, {
      recut_errors: structural
    });
  }

  const insideItems = annotated.slice(firstInsideIdx, lastInsideIdx + 1).filter((a) => a.role === 'inside');
  // 防御：inside 片段在 ord 上必须连续（之间不得夹杂 before/after 片段）
  for (let i = firstInsideIdx; i <= lastInsideIdx; i++) {
    if (annotated[i].role !== 'inside') {
      throw new RecutError(400, '所选来源区间在分支上不是连续的片段块（同一来源拆分/合并的结构不允许跨边界），已拒绝', {
        recut_errors: [{ ord: annotated[i].seg.ord, message: `片段 #${annotated[i].seg.ord} 夹在区间片段之间但来源不在 #${lo}–#${hi} 内` }]
      });
    }
  }

  const oldStart = insideItems[0].seg.start_ms;
  const oldEnd = insideItems[insideItems.length - 1].seg.end_ms;
  const oldSpan = oldEnd - oldStart;
  if (!(oldSpan > 0)) {
    throw new RecutError(400, `所选来源区间在当前分支上的原时长非正（${tcRange(oldStart, oldEnd)}），无法等比重排`, {
      recut_errors: [{ ord: 0, message: '原区间终点必须严格晚于原起点（请先修复分支时间线）' }]
    });
  }

  const newSpan = newEnd - newStart;
  const ratio = newSpan / oldSpan;
  const shift = newEnd - oldEnd;

  // 等比映射：同一物理边界（拆分切点）经缓存只舍入一次，保证切点不错开
  const boundaryCache = new Map();
  function mapBoundary(x) {
    if (x === oldStart) return newStart;
    if (x === oldEnd) return newEnd;
    if (!boundaryCache.has(x)) {
      boundaryCache.set(x, Math.round(newStart + (x - oldStart) * ratio));
    }
    return boundaryCache.get(x);
  }

  // 逐片段换算
  const errors = [];
  const seenMsg = new Set();
  function pushError(ord, message) {
    const key = `${ord}:${message}`;
    if (!seenMsg.has(key)) { seenMsg.add(key); errors.push({ ord, message }); }
  }

  const finalSegments = annotated.map(({ seg, role }) => {
    if (role === 'before') return { ...seg };
    if (role === 'inside') {
      return { ...seg, start_ms: mapBoundary(seg.start_ms), end_ms: mapBoundary(seg.end_ms) };
    }
    return { ...seg, start_ms: seg.start_ms + shift, end_ms: seg.end_ms + shift };
  });

  // 换算后专项检查：负时码、等比重算后零时长（finalSegments 与 annotated 一一对应）
  finalSegments.forEach((s, idx) => {
    const role = annotated[idx].role;
    if (s.start_ms < 0 || s.end_ms < 0) {
      pushError(s.ord, `片段 #${s.ord} 换算后时码为负（${tcRange(s.start_ms, s.end_ms)}），拒绝`);
    }
    if (role === 'inside' && s.end_ms === s.start_ms) {
      pushError(s.ord, `片段 #${s.ord} 等比重算后时长为 0（${fmtSigned(s.start_ms)}），拒绝（请增大新区间时长）`);
    }
  });

  // 完整时间线校验：起点早于终点、按序不重叠等
  const timelineIssues = validateTimeline(finalSegments);

  // 受影响片段：区间内 + 区间之后（区间之前不动，不列入）
  const affected = [];
  let changedCount = 0;
  annotated.forEach(({ seg, role }, idx) => {
    if (role === 'before') return;
    const ns = finalSegments[idx].start_ms;
    const ne = finalSegments[idx].end_ms;
    const timeChanged = ns !== seg.start_ms || ne !== seg.end_ms;
    if (timeChanged) changedCount += 1;
    affected.push({
      ord: seg.ord,
      segment_id: seg.id,
      role: role === 'inside' ? 'inside' : 'after',
      source_seqs: annotated[idx].seqs,
      old_start_ms: seg.start_ms,
      old_end_ms: seg.end_ms,
      old_timecode: tcRange(seg.start_ms, seg.end_ms),
      new_start_ms: ns,
      new_end_ms: ne,
      new_timecode: tcRange(ns, ne),
      time_changed: timeChanged
    });
  });

  const beforeCount = annotated.filter((a) => a.role === 'before').length;
  const afterCount = annotated.filter((a) => a.role === 'after').length;

  return {
    params,
    old_range: { start_ms: oldStart, end_ms: oldEnd, timecode: tcRange(oldStart, oldEnd) },
    new_range: { start_ms: newStart, end_ms: newEnd, timecode: tcRange(newStart, newEnd) },
    shift_ms: shift,
    scale_ratio: Math.round(ratio * 1e6) / 1e6,
    counts: {
      before: beforeCount,
      inside: insideItems.length,
      after: afterCount,
      changed: changedCount
    },
    affected,
    errors,
    timeline_issues: timelineIssues,
    can_apply: errors.length === 0 && timelineIssues.length === 0,
    state_hash: recutStateHash(segments, revById)
  };
}

function loadContext(db, getSegments, branchId) {
  const branch = db.prepare('SELECT id, script_id, name, kind FROM branches WHERE id = ?').get(branchId);
  if (!branch) throw new RecutError(404, '分支不存在');
  const segments = getSegments(db, branchId);
  const revById = new Map(
    db.prepare('SELECT id, rev FROM branch_segments WHERE branch_id = ?').all(branchId)
      .map((r) => [r.id, r.rev])
  );
  const seqRows = db.prepare('SELECT id, seq FROM source_segments WHERE script_id = ?').all(branch.script_id);
  const seqMap = new Map(seqRows.map((r) => [r.id, r.seq]));
  return { branch, segments, revById, seqMap };
}

/**
 * 预览重排：返回每条受影响片段的新旧时码、换算问题与时间线问题，以及一次性预览令牌。
 */
function previewRecut(db, branchId, body, getSegments) {
  const params = readParams(body);
  const { branch, segments, revById, seqMap } = loadContext(db, getSegments, branchId);
  const plan = buildPlan(segments, revById, seqMap, params);
  return {
    branch: { id: branch.id, name: branch.name, kind: branch.kind },
    source_start: params.source_start,
    source_end: params.source_end,
    old_range: plan.old_range,
    new_range: plan.new_range,
    shift_ms: plan.shift_ms,
    scale_ratio: plan.scale_ratio,
    counts: plan.counts,
    affected: plan.affected,
    errors: plan.errors,
    timeline_issues: plan.timeline_issues,
    can_apply: plan.can_apply,
    token: makeToken(branchId, plan.state_hash, params)
  };
}

/**
 * 提交重排：校验预览令牌（过期/分支已变 → 409），单事务写库，
 * 仅给时码实际变化的片段推进 rev。整体成功或不改动。
 */
function applyRecut(db, branchId, body, getSegments) {
  const token = typeof body.token === 'string' ? body.token.trim() : '';
  if (!token) throw new RecutError(400, '缺少预览令牌 token，请先预览再确认');

  const params = readParams(body);
  const { branch, segments, revById, seqMap } = loadContext(db, getSegments, branchId);
  const liveHash = recutStateHash(segments, revById);
  if (token !== makeToken(branchId, liveHash, params)) {
    throw new RecutError(
      409,
      '预览已过期：预览后该分支已被编辑、拆分、合并或重置（或参数被修改），请重新预览后再提交',
      { preview_stale: true }
    );
  }

  const plan = buildPlan(segments, revById, seqMap, params);
  if (!plan.can_apply) {
    throw new RecutError(
      400,
      `重排换算未通过校验（${plan.errors.length} 处换算问题，${plan.timeline_issues.length} 处时间线问题），未改动任何片段`,
      { recut_errors: plan.errors, timeline_issues: plan.timeline_issues }
    );
  }

  const updates = plan.affected.filter((a) => a.time_changed);
  db.transaction(() => {
    const stmt = db.prepare(
      'UPDATE branch_segments SET start_ms = ?, end_ms = ?, rev = rev + 1 WHERE id = ? AND branch_id = ?'
    );
    for (const a of updates) stmt.run(a.new_start_ms, a.new_end_ms, a.segment_id, branchId);
  })();

  return {
    ok: true,
    branch: { id: branch.id, name: branch.name, kind: branch.kind },
    source_start: params.source_start,
    source_end: params.source_end,
    old_range: plan.old_range,
    new_range: plan.new_range,
    shift_ms: plan.shift_ms,
    scale_ratio: plan.scale_ratio,
    counts: plan.counts,
    affected: plan.affected
  };
}

module.exports = { previewRecut, applyRecut, RecutError };
