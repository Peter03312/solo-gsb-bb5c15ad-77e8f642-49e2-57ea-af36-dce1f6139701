'use strict';

// 排练交付包（delivery packages）
//
// 在修订分支或合并分支上，按「当前一致状态」一次签发可下载交付包（ZIP），内含：
//   1. 普通 SRT（连续编号）
//   2. 双语 SRT（逐段原文+译文）
//   3. 演员走词单（纯文本，按演员分组）
//   4. 交付清单（稿件/分支、签发时间、质检规则版本、各文件 SHA-256 与一致状态指纹）
//
// 签发闸门（任一不通过即按类别列出片段/规则问题，整包不留存）：
//   - timeline  普通时间线：时间非负、起点早于终点、片段不重叠
//   - bilingual 双语译文：每条译文非空且已复核
//   - actors    演员归属：无未归属片段
//   - qc        现有质检专用导出的实时规则、报告与豁免门槛（复用 qc.checkGate）
//
// 一致状态：整次签发在单个同步事务内完成——读取同一份分支片段快照、跑全部闸门、
// 生成全部文件并落库；签发期间任何改稿/改演员/改质检设置都不可能混入（better-sqlite3
// 的事务是同步序列化的），提交前还会再算一次状态指纹比对。
// 已签发包内容（ZIP 与单文件字节）全部落库、不可变；后续修改不改变其内容，删除稿件级联清理。

const crypto = require('crypto');
const { validateTimeline, toSrt } = require('./srt');
const qc = require('./qc');
const actors = require('./actors');
const i18n = require('./translation');

const DELIVERY_STATE_VERSION = 'delivery-state-v1';

class DeliveryError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.statusCode = status;
    Object.assign(this, extra || {});
  }
}

const GATE_LABELS = {
  timeline: '普通时间线',
  bilingual: '双语译文复核',
  actors: '演员归属',
  qc: '放映质检'
};

const ROLE_MEDIA = {
  srt: 'application/x-subrip; charset=utf-8',
  bilingual_srt: 'application/x-subrip; charset=utf-8',
  cue_sheet: 'text/plain; charset=utf-8',
  manifest: 'text/plain; charset=utf-8'
};

// ---------------- 工具 ----------------

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function getBranchRow(db, branchId) {
  const b = db.prepare('SELECT id, script_id, name, kind FROM branches WHERE id = ?').get(branchId);
  if (!b) throw new DeliveryError(404, '分支不存在');
  return b;
}

// getBranchSegments（merge.js）不带 rev，这里补上片段修订计数
function snapshotSegments(db, branchId, getSegments) {
  const revRows = db.prepare('SELECT id, rev FROM branch_segments WHERE branch_id = ?').all(branchId);
  const revById = new Map(revRows.map((r) => [r.id, r.rev]));
  return getSegments(db, branchId).map((s) => ({ ...s, rev: revById.get(s.id) ?? 1 }));
}

/**
 * 签发一致状态指纹：覆盖片段身份/顺序/时码/文案/来源、演员归属、译文/复核状态与 rev。
 * 任何改稿、拆分/合并、恢复、重排、改演员、改译文都会改变指纹。
 */
function deliveryStateHash(segments) {
  const payload = segments.map((s) => [
    s.id, s.ord, s.start_ms, s.end_ms, s.text,
    (s.source_ids || []).slice().sort((a, b) => a - b),
    s.actor_id ?? null,
    s.translation ?? null,
    s.translation_reviewed ? 1 : 0,
    s.rev ?? 1
  ]);
  return crypto.createHash('sha256')
    .update(`${DELIVERY_STATE_VERSION}|${JSON.stringify(payload)}`)
    .digest('hex');
}

function safeNamePart(v) {
  return String(v == null ? '' : v)
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || '未命名';
}

function sourceSeqMap(db, scriptId) {
  const rows = db.prepare('SELECT id, seq FROM source_segments WHERE script_id = ?').all(scriptId);
  return new Map(rows.map((r) => [r.id, r.seq]));
}

// ---------------- 闸门 ----------------

/**
 * 跑全部签发闸门，全部基于同一份 segments 快照。
 * QC 闸门完全复用「质检专用下载」的实时核验（qc.checkGate）：当前规则、当前豁免、
 * 当前命中与时间线重新核验；未配置规则/未生成报告/有未豁免命中/时间线错误均不通过。
 */
function evaluateGates(db, branch, segments, seqMap) {
  const timelineIssues = validateTimeline(segments);
  const bilingualIssues = i18n.bilingualIssues(segments);
  const cueSheet = actors.buildCueSheet(db, branch, segments, seqMap);

  // 让质检实时核验直接吃本次签发快照，确保它与其它三个闸门/导出文件同源同版本
  let qcOk = false;
  let qcMessage = '';
  let qcUnresolved = [];
  let qcInvalidExemptions = [];
  let qcTimelineIssues = [];
  let qcReportStale = false;
  try {
    const result = qc.checkGate(db, branch.id, () => segments);
    qcOk = true;
    qcReportStale = !!result.reportStale;
  } catch (e) {
    qcMessage = e.message || '质检核验未通过';
    qcUnresolved = e.unresolved_hits || [];
    qcInvalidExemptions = e.invalid_exemptions || [];
    qcTimelineIssues = e.timeline_issues || [];
    qcReportStale = !!e.report_stale;
  }

  const gates = {
    timeline: {
      key: 'timeline',
      label: GATE_LABELS.timeline,
      ok: timelineIssues.length === 0,
      issue_count: timelineIssues.length,
      issues: timelineIssues
    },
    bilingual: {
      key: 'bilingual',
      label: GATE_LABELS.bilingual,
      ok: bilingualIssues.length === 0,
      issue_count: bilingualIssues.length,
      issues: bilingualIssues
    },
    actors: {
      key: 'actors',
      label: GATE_LABELS.actors,
      ok: cueSheet.unassigned.length === 0,
      issue_count: cueSheet.unassigned.length,
      issues: cueSheet.unassigned
    },
    qc: {
      key: 'qc',
      label: GATE_LABELS.qc,
      ok: qcOk,
      issue_count: qcOk ? 0
        : (qcUnresolved.length + qcTimelineIssues.length + (qcMessage ? 1 : 0)),
      message: qcMessage,
      unresolved_hits: qcUnresolved,
      invalid_exemptions: qcInvalidExemptions,
      timeline_issues: qcTimelineIssues,
      report_stale: qcReportStale
    }
  };

  return { ok: Object.values(gates).every((g) => g.ok), gates, cueSheet };
}

// 预检（不落任何数据）：供网页/接口在签发前查看各类别阻断项
function checkDelivery(db, branchId, getSegments) {
  const branch = getBranchRow(db, branchId);
  const script = db.prepare('SELECT id, name FROM scripts WHERE id = ?').get(branch.script_id);
  if (!script) throw new DeliveryError(404, '稿件不存在');
  const segments = snapshotSegments(db, branchId, getSegments);
  const seqMap = sourceSeqMap(db, branch.script_id);
  const result = evaluateGates(db, branch, segments, seqMap);
  return {
    branch: { id: branch.id, name: branch.name, kind: branch.kind },
    script: { id: script.id, name: script.name },
    segment_count: segments.length,
    state_hash: deliveryStateHash(segments),
    ok: result.ok,
    gates: result.gates
  };
}

// ---------------- 清单 ----------------

function renderManifestText(meta, fileEntries) {
  const L = [];
  L.push('排练交付包清单');
  L.push('='.repeat(60));
  L.push(`交付包：${meta.name}`);
  L.push(`稿件：${meta.script.name}（ID ${meta.script.id}）`);
  L.push(`分支：${meta.branch.name}（${meta.branch.kind === 'merged' ? '合并分支' : '修订分支'}，ID ${meta.branch.id}）`);
  L.push(`签发时间（UTC）：${meta.issued_at}`);
  L.push(`片段数量：${meta.segment_count}`);
  L.push(`质检规则版本：${meta.rule_version
    ? `v${meta.rule_version.version_no}（规则版本 ID ${meta.rule_version.id}，归档于 ${meta.rule_version.created_at}）`
    : '未配置质检规则'}`);
  L.push(`分支一致状态指纹（SHA-256）：${meta.state_hash}`);
  L.push('');
  L.push('文件清单（全部文件基于同一次分支一致状态生成，序号均为连续编号）：');
  L.push('-'.repeat(60));
  const roleLabels = { srt: '普通 SRT', bilingual_srt: '双语 SRT', cue_sheet: '演员走词单', manifest: '交付清单' };
  fileEntries.forEach((f, i) => {
    L.push(`${i + 1}. ${f.filename}`);
    L.push(`   类型：${roleLabels[f.role] || f.role}　大小：${f.size_bytes} 字节`);
    L.push(`   SHA-256：${f.sha256}`);
  });
  L.push('');
  L.push('说明：');
  L.push('  · 本交付包在签发时一次生成，所有内容来自同一分支一致状态；签发之后对稿件、');
  L.push('    分支、演员归属或质检设置的任何修改都不会改变本包内容，可随时列出并重新下载。');
  L.push('  · 重新下载得到的 ZIP 与各文件字节与签发时完全一致（SHA-256 相同）。');
  L.push('  · 本清单文件自身的 SHA-256 与整包 SHA-256 记录在服务端交付记录中。');
  return L.join('\n') + '\n';
}

// ---------------- 签发 ----------------

/**
 * 签发交付包：单个同步事务内完成 闸门核验 → 同快照生成 4 个文件 → 计算哈希/打包 → 落库。
 * 任一闸门失败抛 409（携带各类别问题），事务回滚，整包不留存。
 */
function issueDelivery(db, branchId, getSegments) {
  const branch = getBranchRow(db, branchId);
  const script = db.prepare('SELECT id, name FROM scripts WHERE id = ?').get(branch.script_id);
  if (!script) throw new DeliveryError(404, '稿件不存在');

  return db.transaction(() => {
    // 1) 读取同一份分支快照并计算一致状态指纹
    const segments = snapshotSegments(db, branchId, getSegments);
    const seqMap = sourceSeqMap(db, branch.script_id);
    const stateHashBefore = deliveryStateHash(segments);

    // 2) 同一快照跑全部签发闸门（含质检专用导出的实时核验）
    const gateResult = evaluateGates(db, branch, segments, seqMap);
    if (!gateResult.ok) {
      throw new DeliveryError(409, buildGateErrorMessage(gateResult.gates), { gates: gateResult.gates });
    }

    // 3) 提交前再取一次快照比对：签发期间内容若变化则整包放弃（同步流程下双保险）
    const reSegments = snapshotSegments(db, branchId, getSegments);
    if (deliveryStateHash(reSegments) !== stateHashBefore) {
      throw new DeliveryError(
        409,
        '签发期间分支内容发生变化（改稿/改演员/改译文等），已放弃本次签发，请重新签发',
        { state_changed: true, gates: gateResult.gates }
      );
    }

    const rulesRow = qc.getCurrentRulesRow(db, script.id);

    // 4) 所有文件均基于同一份 segments 快照生成
    const issuedAt = new Date().toISOString();
    const base = `${safeNamePart(script.name)}-${safeNamePart(branch.name)}`;
    const srtBuf = Buffer.from(toSrt(segments), 'utf8');
    const bilingualBuf = Buffer.from(i18n.toBilingualSrt(segments), 'utf8');
    const cueBuf = Buffer.from(actors.renderCueSheetText(script.name, branch.name, gateResult.cueSheet), 'utf8');

    const info = db.prepare(`
      INSERT INTO deliveries
        (script_id, branch_id, name, issued_at, segment_count, state_hash,
         rule_version_id, rule_version_no, zip_size, zip_sha256, zip_bytes, manifest_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, '', x'', '')
    `).run(
      script.id, branch.id, '排练交付 #pending', issuedAt, segments.length, stateHashBefore,
      rulesRow ? rulesRow.id : null, rulesRow ? rulesRow.version_no : null
    );
    const deliveryId = Number(info.lastInsertRowid);
    const pkgName = `排练交付 #${deliveryId}`;
    const zipFilename = `${base}-交付包-${deliveryId}.zip`;

    const ruleVersionInfo = rulesRow
      ? { id: rulesRow.id, version_no: rulesRow.version_no, created_at: rulesRow.created_at }
      : null;

    let fileEntries = [
      { role: 'srt', filename: `${base}.srt`, content: srtBuf },
      { role: 'bilingual_srt', filename: `${base}-双语.srt`, content: bilingualBuf },
      { role: 'cue_sheet', filename: `${base}-演员走词单.txt`, content: cueBuf }
    ].map((f) => ({
      ...f,
      media_type: ROLE_MEDIA[f.role],
      size_bytes: f.content.length,
      sha256: sha256(f.content)
    }));

    const manifestMeta = {
      name: pkgName,
      script: { id: script.id, name: script.name },
      branch: { id: branch.id, name: branch.name, kind: branch.kind },
      issued_at: issuedAt,
      segment_count: segments.length,
      rule_version: ruleVersionInfo,
      state_hash: stateHashBefore
    };
    const manifestBuf = Buffer.from(renderManifestText(manifestMeta, fileEntries), 'utf8');
    fileEntries.push({
      role: 'manifest',
      filename: '交付清单.txt',
      content: manifestBuf,
      media_type: ROLE_MEDIA.manifest,
      size_bytes: manifestBuf.length,
      sha256: sha256(manifestBuf)
    });

    // 5) 打包（STORE 不压缩）并计算整包哈希；整包字节落库，保证重下载字节一致
    const zipBuf = buildZip(fileEntries.map((f) => ({ filename: f.filename, content: f.content })), issuedAt);
    const zipSha = sha256(zipBuf);

    const manifestJson = JSON.stringify({
      package: { id: deliveryId, name: pkgName, issued_at: issuedAt },
      script: manifestMeta.script,
      branch: manifestMeta.branch,
      issued_at: issuedAt,
      segment_count: segments.length,
      qc: {
        rule_configured: !!rulesRow,
        rule_version: ruleVersionInfo
      },
      state_hash: stateHashBefore,
      files: fileEntries.map((f) => ({
        role: f.role, filename: f.filename, media_type: f.media_type,
        size_bytes: f.size_bytes, sha256: f.sha256
      })),
      zip: { filename: zipFilename, size_bytes: zipBuf.length, sha256: zipSha }
    }, null, 2);

    db.prepare(`
      UPDATE deliveries
      SET name = ?, zip_bytes = ?, zip_size = ?, zip_sha256 = ?, manifest_json = ?
      WHERE id = ?
    `).run(pkgName, zipBuf, zipBuf.length, zipSha, manifestJson, deliveryId);

    const insFile = db.prepare(`
      INSERT INTO delivery_files (delivery_id, ord, role, filename, media_type, size_bytes, sha256, content)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    fileEntries.forEach((f, idx) => {
      insFile.run(deliveryId, idx + 1, f.role, f.filename, f.media_type, f.size_bytes, f.sha256, f.content);
    });

    return getDelivery(db, deliveryId);
  })();
}

function buildGateErrorMessage(gates) {
  const parts = [];
  for (const g of Object.values(gates)) {
    if (!g.ok) parts.push(`${g.label} ${g.issue_count} 项`);
  }
  return `交付签发被拒绝（${parts.join('、')}），请按类别处理后再签发；本次未留存任何交付包数据`;
}

// ---------------- 查询 / 下载 ----------------

const DELIVERY_SELECT = `
  SELECT d.id, d.script_id, d.branch_id, d.name, d.issued_at, d.segment_count,
         d.state_hash, d.rule_version_id, d.rule_version_no, d.zip_size, d.zip_sha256,
         d.manifest_json, d.zip_bytes,
         b.name AS branch_name, b.kind AS branch_kind, s.name AS script_name
  FROM deliveries d
  JOIN branches b ON b.id = d.branch_id
  JOIN scripts s ON s.id = d.script_id
`;

function rowToApi(db, row) {
  const fileRows = db.prepare(
    'SELECT ord, role, filename, media_type, size_bytes, sha256 FROM delivery_files WHERE delivery_id = ? ORDER BY ord'
  ).all(row.id);
  let manifest = null;
  try { manifest = JSON.parse(row.manifest_json || '{}'); } catch { manifest = null; }
  return {
    id: row.id,
    script_id: row.script_id,
    script_name: row.script_name,
    branch_id: row.branch_id,
    branch_name: row.branch_name,
    branch_kind: row.branch_kind,
    name: row.name,
    issued_at: row.issued_at,
    segment_count: row.segment_count,
    state_hash: row.state_hash,
    rule_version_id: row.rule_version_id,
    rule_version_no: row.rule_version_no,
    zip_size: row.zip_size,
    zip_sha256: row.zip_sha256,
    zip_filename: manifest && manifest.zip ? manifest.zip.filename
      : `${safeNamePart(row.script_name)}-${safeNamePart(row.branch_name)}-交付包-${row.id}.zip`,
    files: fileRows,
    manifest
  };
}

function getDelivery(db, deliveryId) {
  const row = db.prepare(`${DELIVERY_SELECT} WHERE d.id = ?`).get(deliveryId);
  if (!row) throw new DeliveryError(404, '交付包不存在或已随稿件删除');
  return rowToApi(db, row);
}

function listForScript(db, scriptId) {
  const script = db.prepare('SELECT id FROM scripts WHERE id = ?').get(scriptId);
  if (!script) throw new DeliveryError(404, '稿件不存在');
  const rows = db.prepare(`${DELIVERY_SELECT} WHERE d.script_id = ? ORDER BY d.id DESC`).all(scriptId);
  return { script_id: scriptId, package_count: rows.length, packages: rows.map((r) => rowToApi(db, r)) };
}

function listForBranch(db, branchId) {
  const branch = getBranchRow(db, branchId);
  const rows = db.prepare(`${DELIVERY_SELECT} WHERE d.branch_id = ? ORDER BY d.id DESC`).all(branchId);
  return {
    script_id: branch.script_id,
    branch: { id: branch.id, name: branch.name, kind: branch.kind },
    package_count: rows.length,
    packages: rows.map((r) => rowToApi(db, r))
  };
}

// 下载整包：返回 API 元信息 + 签发时落库的 ZIP 字节（不可变）
function getZip(db, deliveryId) {
  const row = db.prepare(`${DELIVERY_SELECT} WHERE d.id = ?`).get(deliveryId);
  if (!row) throw new DeliveryError(404, '交付包不存在或已随稿件删除');
  return { api: rowToApi(db, row), buffer: row.zip_bytes };
}

// 下载包内单个文件（普通 SRT / 双语 SRT / 走词单 / 清单）
function getFile(db, deliveryId, fileIdOrRole) {
  const row = db.prepare(`${DELIVERY_SELECT} WHERE d.id = ?`).get(deliveryId);
  if (!row) throw new DeliveryError(404, '交付包不存在或已随稿件删除');
  let file;
  if (Number.isInteger(fileIdOrRole)) {
    file = db.prepare('SELECT * FROM delivery_files WHERE id = ? AND delivery_id = ?')
      .get(fileIdOrRole, deliveryId);
  } else {
    file = db.prepare('SELECT * FROM delivery_files WHERE role = ? AND delivery_id = ?')
      .get(fileIdOrRole, deliveryId);
  }
  if (!file) throw new DeliveryError(404, '包内文件不存在');
  return { api: rowToApi(db, row), file };
}

// ---------------- ZIP（STORE / 不压缩，纯标准库实现） ----------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(iso) {
  const dt = new Date(iso);
  const year = Math.max(1980, dt.getUTCFullYear());
  const dosTime = (dt.getUTCHours() << 11) | (dt.getUTCMinutes() << 5) | Math.floor(dt.getUTCSeconds() / 2);
  const dosDate = ((year - 1980) << 9) | ((dt.getUTCMonth() + 1) << 5) | dt.getUTCDate();
  return { dosTime: dosTime & 0xffff, dosDate: dosDate & 0xffff };
}

/**
 * 构建不压缩 ZIP（method=0 STORE）。entries: [{filename, content:Buffer}]
 * 文件名按 UTF-8 写入并置语言标志位（general purpose bit 11）。
 */
function buildZip(entries, issuedAt) {
  const { dosTime, dosDate } = dosDateTime(issuedAt);
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const e of entries) {
    const nameBuf = Buffer.from(e.filename, 'utf8');
    const crc = crc32(e.content);
    const size = e.content.length;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);        // bit 11: UTF-8 文件名
    local.writeUInt16LE(0, 8);             // method = store
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(size, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, e.content);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(size, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(0, 42);
    central.writeUInt32LE(offset, 46 - 4); // 本地头偏移
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + size;
  }

  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralBuf, end]);
}

module.exports = {
  DeliveryError,
  GATE_LABELS,
  checkDelivery,
  issueDelivery,
  getDelivery,
  listForScript,
  listForBranch,
  getZip,
  getFile,
  buildZip,
  deliveryStateHash
};
