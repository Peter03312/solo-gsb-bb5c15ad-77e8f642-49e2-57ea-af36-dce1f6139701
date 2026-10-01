'use strict';

// 演员登记、片段归属与「演员走词单」导出
//
// 约定：
//   - 演员按稿件登记（actors，同一稿件内姓名唯一）；
//   - 归属是分支片段自身的属性（branch_segments.actor_id，可空=未归属）：
//     拆分沿用原演员；相邻片段仅在演员相同时合并沿用，否则清空并提示重新指定；
//     仅改文案/时码（含重剪重排）不改变归属；
//   - 走词单按当前分支实时生成：逐条给出演员、时码、台词与原稿来源序号；
//     存在未归属片段或时间线错误时列出具体片段并拒绝整份导出。

const { validateTimeline, msToSrt } = require('./srt');

class ActorError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.statusCode = status;
    Object.assign(this, extra || {});
  }
}

function normName(v, label = '演员姓名') {
  if (typeof v !== 'string') throw new ActorError(400, `${label}必须为文本`);
  const name = v.trim();
  if (!name) throw new ActorError(400, `${label}不能为空`);
  if (name.length > 50) throw new ActorError(400, `${label}不能超过 50 个字符`);
  if (name.includes('\n') || name.includes('\r')) throw new ActorError(400, `${label}不能包含换行`);
  return name;
}

// ---------------- 名单 ----------------

function listActors(db, scriptId) {
  const counts = db.prepare(`
    SELECT a.id AS actor_id, COUNT(bs.id) AS assigned
    FROM actors a
    LEFT JOIN branches b ON b.script_id = a.script_id
    LEFT JOIN branch_segments bs ON bs.actor_id = a.id AND bs.branch_id = b.id
    WHERE a.script_id = ?
    GROUP BY a.id
  `).all(scriptId);
  const assignedById = new Map(counts.map((r) => [r.actor_id, r.assigned]));
  return db.prepare('SELECT id, name, created_at FROM actors WHERE script_id = ? ORDER BY id')
    .all(scriptId)
    .map((a) => ({ ...a, assigned_count: assignedById.get(a.id) || 0 }));
}

function addActor(db, scriptId, rawName) {
  const name = normName(rawName);
  const dup = db.prepare('SELECT id FROM actors WHERE script_id = ? AND name = ?').get(scriptId, name);
  if (dup) throw new ActorError(409, `稿件中已存在演员「${name}」`);
  const info = db.prepare('INSERT INTO actors (script_id, name) VALUES (?, ?)').run(scriptId, name);
  return { id: Number(info.lastInsertRowid), name };
}

function renameActor(db, scriptId, actorId, rawName) {
  const name = normName(rawName);
  const row = db.prepare('SELECT id FROM actors WHERE id = ? AND script_id = ?').get(actorId, scriptId);
  if (!row) throw new ActorError(404, '演员不存在');
  const dup = db.prepare('SELECT id FROM actors WHERE script_id = ? AND name = ? AND id <> ?').get(scriptId, name, actorId);
  if (dup) throw new ActorError(409, `稿件中已存在演员「${name}」`);
  db.prepare('UPDATE actors SET name = ? WHERE id = ?').run(name, actorId);
  return { id: actorId, name };
}

function deleteActor(db, scriptId, actorId) {
  const row = db.prepare('SELECT id FROM actors WHERE id = ? AND script_id = ?').get(actorId, scriptId);
  if (!row) throw new ActorError(404, '演员不存在');
  // ON DELETE SET NULL 会把引用片段的归属自动清空；显式 UPDATE 以保证跨 SQLite 版本一致
  const info = db.transaction(() => {
    const cleared = db.prepare(`
      UPDATE branch_segments SET actor_id = NULL
      WHERE actor_id = ?
        AND branch_id IN (SELECT id FROM branches WHERE script_id = ?)
    `).run(actorId, scriptId);
    const del = db.prepare('DELETE FROM actors WHERE id = ? AND script_id = ?').run(actorId, scriptId);
    return { cleared: cleared.changes, deleted: del.changes };
  })();
  return { ok: true, cleared_assignments: info.cleared };
}

// ---------------- 归属 ----------------

/**
 * 为分支上的片段指定演员。actorId 为 null 表示清除归属。
 * 仅改归属：不推进 rev，因此不影响质检报告/豁免，也不改变文案与时码。
 */
function assignActor(db, branch, segId, actorId) {
  if (actorId !== null && !Number.isInteger(actorId)) {
    throw new ActorError(400, 'actor_id 必须为整数，或用 null 清除归属');
  }
  if (actorId !== null) {
    const a = db.prepare('SELECT id, name FROM actors WHERE id = ? AND script_id = ?')
      .get(actorId, branch.script_id);
    if (!a) throw new ActorError(404, '演员不存在或不属于该稿件');
  }
  const seg = db.prepare(
    'SELECT id, actor_id FROM branch_segments WHERE id = ? AND branch_id = ?'
  ).get(segId, branch.id);
  if (!seg) throw new ActorError(404, '片段不存在');

  if (seg.actor_id === actorId) {
    return { ok: true, changed: false, actor_id: actorId };
  }
  db.prepare('UPDATE branch_segments SET actor_id = ? WHERE id = ?').run(actorId, segId);
  return { ok: true, changed: true, actor_id: actorId };
}

/**
 * 合并相邻片段时的归属决策：
 *   - 两条演员相同（含都为空）-> 沿用；
 *   - 两条演员不同（一条有值、一条为空，或分别为不同演员）-> 清空，返回提示。
 * @returns {{actor_id: number|null, carried:boolean, cleared_reason: string|null}}
 */
function mergeActorPolicy(actorIdA, actorIdB) {
  const a = actorIdA ?? null;
  const b = actorIdB ?? null;
  if (a === b) return { actor_id: a, carried: true, cleared_reason: null };
  return {
    actor_id: null,
    carried: false,
    cleared_reason: '相邻片段演员不同（或其一未归属），合并后已清空演员归属，请重新指定'
  };
}

// ---------------- 走词单 ----------------

function tc(ms) {
  return msToSrt(ms);
}

/**
 * 计算走词单数据。
 * @param segments getBranchSegments() 的结果（含 actor_id/actor_name/source_ids）
 */
function buildCueSheet(db, branch, segments, seqMap) {
  const timeline_issues = validateTimeline(segments);

  const unassigned = segments
    .filter((s) => s.actor_id == null)
    .map((s) => ({
      ord: s.ord,
      start_ms: s.start_ms,
      end_ms: s.end_ms,
      timecode: `${tc(s.start_ms)} --> ${tc(s.end_ms)}`,
      text_excerpt: String(s.text || '').slice(0, 40),
      message: `片段 #${s.ord} 尚未归属演员，无法按演员导出走词单`
    }));

  // 按演员分组（演员注册顺序），组内按分支 ord 给出走词顺序
  const actors = listActors(db, branch.script_id);
  const linesByActor = new Map(actors.map((a) => [a.id, []]));
  for (const s of segments) {
    if (s.actor_id == null) continue;
    if (!linesByActor.has(s.actor_id)) {
      // 防御：演员记录缺失（理论上外键/删除逻辑不会出现）
      linesByActor.set(s.actor_id, []);
      actors.push({ id: s.actor_id, name: s.actor_name || `演员#${s.actor_id}` });
    }
    const source_seqs = Array.from(new Set(
      (s.source_ids || []).map((id) => seqMap.get(id)).filter((q) => q != null)
    )).sort((a, b) => a - b);
    linesByActor.get(s.actor_id).push({
      ord: s.ord,
      timecode: `${tc(s.start_ms)} --> ${tc(s.end_ms)}`,
      start_ms: s.start_ms,
      end_ms: s.end_ms,
      text: s.text,
      source_seqs
    });
  }

  const cue_sheet = actors
    .map((a) => ({
      actor_id: a.id,
      actor_name: a.name,
      line_count: linesByActor.get(a.id).length,
      lines: linesByActor.get(a.id)
    }))
    .filter((g) => g.line_count > 0);

  return {
    can_export: unassigned.length === 0 && timeline_issues.length === 0,
    unassigned,
    timeline_issues,
    cue_sheet,
    total_lines: segments.length
  };
}

/**
 * 渲染纯文本走词单（UTF-8，便于打印分发；与 SRT/质检下载并存）。
 */
function renderCueSheetText(scriptName, branchName, sheet) {
  const lines = [];
  lines.push(`演员走词单　${scriptName}　/　${branchName}`);
  lines.push(`生成时间：${new Date().toISOString()}`);
  lines.push(`共 ${sheet.cue_sheet.length} 名演员，${sheet.total_lines} 条台词`);
  lines.push('='.repeat(60));
  for (const g of sheet.cue_sheet) {
    lines.push('');
    lines.push(`【${g.actor_name}】（${g.line_count} 条，按出场顺序）`);
    lines.push('-'.repeat(60));
    g.lines.forEach((ln, i) => {
      const seqLabel = ln.source_seqs.length
        ? `原稿#${ln.source_seqs.join(',#')}`
        : '原稿#-';
      lines.push(`${i + 1}. [片段${ln.ord}] ${ln.timecode}（${seqLabel}）`);
      lines.push(`   ${String(ln.text).replace(/\n/g, '\n   ')}`);
    });
  }
  return lines.join('\n') + '\n';
}

module.exports = {
  ActorError,
  listActors,
  addActor,
  renameActor,
  deleteActor,
  assignActor,
  mergeActorPolicy,
  buildCueSheet,
  renderCueSheetText
};
