'use strict';

// 排练交付包签发
//
// 在修订分支或合并分支上，从「同一次一致状态」固化生成可下载交付包，内含：
//   - 普通 SRT（当前分支时码与文案，序号连续）
//   - 双语 SRT（逐段原文+译文）
//   - 演员走词单（纯文本，按演员分组、组内按出场顺序）
//   - 清单（记录稿件与分支、签发时间、质检规则版本、各文件 SHA-256）
//
// 签发闸门（任一不满足即按类别列出问题，整包不留存）：
//   1. 普通时间线：时间非负、起点早于终点、片段不重叠；
//   2. 双语译文：每片段译文非空且已复核；
//   3. 演员归属：每个片段均已归属演员；
//   4. 放映质检：复用质检专用导出的实时口径——当前规则、当前报告（须存在）、
//      未豁免命中为 0、豁免仍有效；报告失效仅作提示（与质检专用下载一致）。
//
// 一致性：全部读取、闸门核验与文件生成在同一个 better-sqlite3 同步事务内完成；
// Node 单线程 + 同步事务保证签发期间没有任何改稿/改演员/改规则能混入其他版本，
// 失败时事务回滚，不写入任何包或文件记录。
//
// 不可变：整包 ZIP 与每个文件内容均固化在 delivery_packages/delivery_files 中，
// 后续任何修改不影响已签发包；删除稿件时经外键级联清理所属包。

const crypto = require('crypto');
const { toSrt } = require('./srt');
const qc = require('./qc');
const i18n = require('./translation');
const actors = require('./actors');

class DeliveryError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.statusCode = status;
    Object.assign(this, extra || {});
  }
}

const ROLES = [
  { role: 'srt', label: '普通 SRT', media_type: 'application/x-subrip; charset=utf-8' },
  { role: 'bilingual_srt', label: '双语 SRT', media_type: 'application/x-subrip; charset=utf-8' },
  { role: 'cue_sheet', label: '演员走词单', media_type: 'text/plain; charset=utf-8' }
];
const MANIFEST_ROLE = 'manifest';

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * 文件名安全化：替换路径分隔符与各平台保留字符。
 */
function safeName(name) {
  return String(name == null ? '' : name)
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || '未命名';
}

// ---------------- 一致状态指纹 ----------------

/**
 * 签发所用的分支状态指纹：覆盖时码/文案、来源、演员归属、译文与复核状态，
 * 并纳入质检规则指纹。签发期间任一要素变化都会得到不同指纹（同步事务内不可能发生）。
 */
function deliveryStateHash(segments, ruleFingerprint) {
  const payload = {
    segments: segments.map((s) => [
      s.ord, s.start_ms, s.end_ms, s.text,
      s.actor_id ?? null,
      s.translation ?? null,
      s.translation_reviewed ? 1 : 0,
      (s.source_ids || []).slice().sort((a, b) => a - b)
    ]),
    rule_fingerprint: ruleFingerprint ?? null
  };
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

// ---------------- 闸门（按类别收集，不通过不签发） ----------------

/**
 * 对同一份片段快照运行全部签发闸门，按类别返回问题。
 * @returns {{can_issue:boolean, categories:object, segments:object[], qcGate:object, sheet:object}}
 */
function evaluateGates(db, branch, segments, seqMap, getSegments) {
  // 1+4. 普通时间线 + 放映质检实时核验（与 /api/branches/:id/qc/export 同一口径）
  const qcGate = qc.inspectGate(db, branch.id, getSegments, { branch, segments });
  // 2. 双语译文（空译文/待复核；时间线问题统一归入「普通时间线」类别）
  const bilingualIssues = i18n.bilingualIssues(segments);
  // 3. 演员归属
  const sheet = actors.buildCueSheet(db, branch, segments, seqMap);

  const timeline = qcGate.timelineIssues;
  const categories = {
    timeline: {
      label: '普通时间线',
      ok: timeline.length === 0,
      issues: timeline
    },
    bilingual: {
      label: '双语译文复核',
      ok: bilingualIssues.length === 0,
      issues: bilingualIssues
    },
    actors: {
      label: '演员归属',
      ok: sheet.unassigned.length === 0,
      issues: sheet.unassigned.map((u) => ({
        ord: u.ord,
        timecode: u.timecode,
        text_excerpt: u.text_excerpt,
        message: u.message
      }))
    },
    qc: {
      label: '放映质检',
      ok: qcGate.precondition.length === 0 && qcGate.unresolvedHits.length === 0,
      precondition: qcGate.precondition,
      unresolved_hits: qcGate.unresolvedHits.map((h) => ({
        rule_type: h.rule_type,
        rule_label: qc.RULE_LABELS[h.rule_type] || h.rule_type,
        ord: h.ord,
        source_seqs: h.source_seqs,
        message: h.message,
        detail: h.detail
      })),
      invalid_exemptions: qcGate.invalidExemptions,
      report_stale: qcGate.reportStale
    }
  };

  const canIssue = Object.values(categories).every((c) => c.ok);
  return { canIssue, categories, segments: qcGate.segments, qcGate, sheet };
}

function summarizeFailures(categories) {
  const parts = [];
  if (!categories.timeline.ok) parts.push(`时间线问题 ${categories.timeline.issues.length} 处`);
  if (!categories.bilingual.ok) parts.push(`双语问题 ${categories.bilingual.issues.length} 条`);
  if (!categories.actors.ok) parts.push(`未归属片段 ${categories.actors.issues.length} 条`);
  if (!categories.qc.ok) {
    parts.push(
      `质检未达标（前置条件 ${categories.qc.precondition.length} 项，未豁免命中 ${categories.qc.unresolved_hits.length} 条）`
    );
  }
  return parts.join('，');
}

// ---------------- 签发时间 ----------------

function pad(n, w = 2) { return String(n).padStart(w, '0'); }

function issuedTimestamp(d) {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} UTC`;
}

// ---------------- 极简 ZIP（STORE，不压缩；UTF-8 文件名） ----------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/**
 * 由条目构建 ZIP（仅 STORE）。时间统一取签发时刻，保证同一签发只产生同一字节串。
 * @param entries Array<{name:string, data:Buffer}>
 */
function buildZip(entries, date) {
  const dosTime = (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | (date.getUTCSeconds() >> 1);
  const dosDate = ((date.getUTCFullYear() - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate();

  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const crc = crc32(e.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // 本地文件头签名
    local.writeUInt16LE(20, 4);         // 解压所需版本
    local.writeUInt16LE(0x0800, 6);     // 标志位：bit 11 = UTF-8 文件名
    local.writeUInt16LE(0, 8);          // 压缩方式：STORE
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(e.data.length, 18); // 压缩后大小
    local.writeUInt32LE(e.data.length, 22); // 原始大小
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);            // 无扩展字段
    localParts.push(local, nameBuf, e.data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); // 中央目录签名
    central.writeUInt16LE(20, 4);         // 打包版本
    central.writeUInt16LE(20, 6);         // 解压所需版本
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(e.data.length, 20);
    central.writeUInt32LE(e.data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // 扩展字段长度
    central.writeUInt16LE(0, 32); // 注释长度
    central.writeUInt16LE(0, 34); // 磁盘号
    central.writeUInt16LE(0, 36); // 内部属性
    central.writeUInt32LE(0, 38); // 外部属性
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBuf);

    offset += local.length + nameBuf.length + e.data.length;
  }

  const centralBuf = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // EOCD 签名
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralBuf, eocd]);
}

// ---------------- 清单 ----------------

function renderManifestText(ctx) {
  const L = [];
  L.push('排练交付包清单');
  L.push('='.repeat(60));
  L.push(`交付包编号：#${ctx.packageId}`);
  L.push(`签发时间：${ctx.issuedAt}`);
  L.push(`稿件：${ctx.scriptName}（稿件 id ${ctx.scriptId}）`);
  L.push(`分支：${ctx.branchName}（${ctx.branchKind === 'merged' ? '合并分支' : '修订分支'}，分支 id ${ctx.branchId}）`);
  L.push(`片段数量：${ctx.segmentCount}`);
  L.push(`一致状态指纹（SHA-256）：${ctx.stateHash}`);
  if (ctx.ruleVersionNo != null) {
    L.push(`质检规则版本：v${ctx.ruleVersionNo}（版本 id ${ctx.ruleVersionId}）`);
    L.push(`质检规则指纹（SHA-256）：${ctx.ruleFingerprint}`);
  } else {
    L.push('质检规则版本：未配置');
  }
  L.push(`签发时质检报告状态：${ctx.reportStale ? '报告已失效（与当前内容/规则不一致，仅提示）' : '与当前内容一致'}`);
  L.push('');
  L.push('文件清单（包内路径 / 大小 / SHA-256）');
  L.push('-'.repeat(60));
  ctx.files.forEach((f, i) => {
    L.push(`${i + 1}. [${f.label}] ${f.entryName}`);
    L.push(`   大小：${f.sizeBytes} 字节`);
    L.push(`   SHA-256：${f.sha256}`);
  });
  L.push('');
  L.push('-'.repeat(60));
  L.push('说明：本包所有文件均基于签发时同一次一致状态生成；后续改稿、改演员归属');
  L.push('或修改质检规则均不改变本包内容。本清单文件与整包 ZIP 的 SHA-256 记录于');
  L.push('签发记录，可在「排练交付」面板或交付接口返回中查看。');
  return L.join('\n') + '\n';
}

// ---------------- 签发 ----------------

/**
 * 签发交付包。所有读取、闸门与固化写库均在单个同步事务内；失败抛出 DeliveryError(409)
 * 并按类别携带问题，事务回滚不留存任何内容。
 */
function issuePackage(db, branchId, getSegments) {
  return db.transaction(() => {
    const branch = db.prepare(`
      SELECT b.id, b.script_id, b.name, b.kind, s.name AS script_name
      FROM branches b JOIN scripts s ON s.id = b.script_id
      WHERE b.id = ?
    `).get(branchId);
    if (!branch) throw new DeliveryError(404, '分支不存在');

    const segments = getSegments(db, branchId);
    const seqRows = db.prepare('SELECT id, seq FROM source_segments WHERE script_id = ?').all(branch.script_id);
    const seqMap = new Map(seqRows.map((r) => [r.id, r.seq]));

    const gates = evaluateGates(db, branch, segments, seqMap, getSegments);
    if (!gates.canIssue) {
      throw new DeliveryError(
        409,
        `交付包签发被拒绝（${summarizeFailures(gates.categories)}），请按类别处理后重新签发；本次未留存任何包内容`,
        { delivery_issues: gates.categories }
      );
    }

    const finalSegments = gates.segments;
    const qcGate = gates.qcGate;
    const issuedDate = new Date();
    const issuedAt = issuedTimestamp(issuedDate);

    const ruleFingerprint = qcGate.rules ? qc.rulesFingerprint({
      min_duration_ms: qcGate.rules.min_duration_ms,
      max_duration_ms: qcGate.rules.max_duration_ms,
      max_cps: qcGate.rules.max_cps,
      min_gap_ms: qcGate.rules.min_gap_ms,
      banned_words: JSON.parse(qcGate.rules.banned_words_json || '[]')
    }) : null;
    const stateHash = deliveryStateHash(finalSegments, ruleFingerprint);

    // 1) 先创建包头取得 package id（清单与目录命名需要它）
    const pkgInfo = db.prepare(`
      INSERT INTO delivery_packages
        (script_id, branch_id, issued_at, segment_count, state_hash,
         rule_version_id, rule_version_no, rule_fingerprint, zip_filename)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, '')
    `).run(
      branch.script_id, branch.id, issuedAt, finalSegments.length, stateHash,
      qcGate.rules ? qcGate.rules.id : null,
      qcGate.rules ? qcGate.rules.version_no : null,
      ruleFingerprint
    );
    const packageId = Number(pkgInfo.lastInsertRowid);

    const scriptSafe = safeName(branch.script_name);
    const branchSafe = safeName(branch.name);
    const folder = `交付包${packageId}`;

    // 2) 三份交付物全部来自同一份 finalSegments 快照
    const artifacts = [
      {
        role: 'srt', label: '普通 SRT', media_type: 'application/x-subrip; charset=utf-8',
        filename: `${scriptSafe}-${branchSafe}.srt`,
        data: Buffer.from(toSrt(finalSegments), 'utf8')
      },
      {
        role: 'bilingual_srt', label: '双语 SRT', media_type: 'application/x-subrip; charset=utf-8',
        filename: `${scriptSafe}-${branchSafe}-双语.srt`,
        data: Buffer.from(i18n.toBilingualSrt(finalSegments), 'utf8')
      },
      {
        role: 'cue_sheet', label: '演员走词单', media_type: 'text/plain; charset=utf-8',
        filename: `${scriptSafe}-${branchSafe}-演员走词单.txt`,
        data: Buffer.from(actors.renderCueSheetText(branch.script_name, branch.name, gates.sheet), 'utf8')
      }
    ].map((f) => ({ ...f, sizeBytes: f.data.length, sha: sha256(f.data) }));

    const manifestFilename = `清单-交付包${packageId}.txt`;
    const manifestText = renderManifestText({
      packageId,
      issuedAt,
      scriptId: branch.script_id,
      scriptName: branch.script_name,
      branchId: branch.id,
      branchName: branch.name,
      branchKind: branch.kind,
      segmentCount: finalSegments.length,
      stateHash,
      ruleVersionId: qcGate.rules ? qcGate.rules.id : null,
      ruleVersionNo: qcGate.rules ? qcGate.rules.version_no : null,
      ruleFingerprint,
      reportStale: qcGate.reportStale,
      files: artifacts.map((f) => ({
        label: f.label,
        entryName: `${folder}/${f.filename}`,
        sizeBytes: f.sizeBytes,
        sha256: f.sha
      }))
    });
    const manifestData = Buffer.from(manifestText, 'utf8');
    const manifestSha = sha256(manifestData);
    const manifest = {
      role: MANIFEST_ROLE,
      label: '交付清单',
      media_type: 'text/plain; charset=utf-8',
      filename: manifestFilename,
      data: manifestData,
      sizeBytes: manifestData.length,
      sha: manifestSha
    };

    // 3) 组装 ZIP（清单位于最后），整包哈希
    const zipEntries = [...artifacts, manifest].map((f) => ({
      name: `${folder}/${f.filename}`,
      data: f.data
    }));
    const zipData = buildZip(zipEntries, issuedDate);
    const zipSha = sha256(zipData);
    const zipFilename = `${scriptSafe}-${branchSafe}-交付包${packageId}.zip`;

    // 4) 固化文件记录
    const insFile = db.prepare(`
      INSERT INTO delivery_files (package_id, ord, role, filename, media_type, content, size_bytes, sha256)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const allFiles = [...artifacts, manifest];
    allFiles.forEach((f, idx) => {
      insFile.run(packageId, idx + 1, f.role, f.filename, f.media_type, f.data, f.sizeBytes, f.sha);
    });

    const manifestJson = JSON.stringify({
      package: {
        id: packageId,
        issued_at: issuedAt,
        segment_count: finalSegments.length,
        state_hash: stateHash,
        zip_filename: zipFilename,
        zip_size: zipData.length,
        zip_sha256: zipSha
      },
      script: { id: branch.script_id, name: branch.script_name },
      branch: { id: branch.id, name: branch.name, kind: branch.kind },
      qc: qcGate.rules ? {
        rule_version_id: qcGate.rules.id,
        version_no: qcGate.rules.version_no,
        rule_fingerprint: ruleFingerprint,
        report_stale: qcGate.reportStale
      } : null,
      files: allFiles.map((f, idx) => ({
        ord: idx + 1,
        role: f.role,
        label: f.label,
        filename: f.filename,
        entry_name: `${folder}/${f.filename}`,
        media_type: f.media_type,
        size_bytes: f.sizeBytes,
        sha256: f.sha
      }))
    }, null, 2);

    db.prepare(`
      UPDATE delivery_packages
      SET zip_filename = ?, zip_blob = ?, zip_size = ?, zip_sha256 = ?, manifest_json = ?
      WHERE id = ?
    `).run(zipFilename, zipData, zipData.length, zipSha, manifestJson, packageId);

    return getPackage(db, packageId);
  })();
}

// ---------------- 查询与下载 ----------------

const PKG_SELECT = `
  SELECT p.*, s.name AS script_name, b.name AS branch_name, b.kind AS branch_kind
  FROM delivery_packages p
  JOIN scripts s ON s.id = p.script_id
  JOIN branches b ON b.id = p.branch_id
`;

function packageRowOr404(db, packageId) {
  const row = db.prepare(`${PKG_SELECT} WHERE p.id = ?`).get(packageId);
  if (!row) throw new DeliveryError(404, '交付包不存在');
  return row;
}

function fileMeta(row) {
  return {
    id: row.id,
    ord: row.ord,
    role: row.role,
    filename: row.filename,
    media_type: row.media_type,
    size_bytes: row.size_bytes,
    sha256: row.sha256
  };
}

function packageToApi(db, row) {
  const files = db.prepare(
    'SELECT * FROM delivery_files WHERE package_id = ? ORDER BY ord'
  ).all(row.id).map(fileMeta);
  return {
    id: row.id,
    script_id: row.script_id,
    script_name: row.script_name,
    branch_id: row.branch_id,
    branch_name: row.branch_name,
    branch_kind: row.branch_kind,
    issued_at: row.issued_at,
    segment_count: row.segment_count,
    state_hash: row.state_hash,
    rule_version_id: row.rule_version_id,
    rule_version_no: row.rule_version_no,
    rule_fingerprint: row.rule_fingerprint,
    zip_filename: row.zip_filename,
    zip_size: row.zip_size,
    zip_sha256: row.zip_sha256,
    manifest: JSON.parse(row.manifest_json || '{}'),
    files
  };
}

function getPackage(db, packageId) {
  return packageToApi(db, packageRowOr404(db, packageId));
}

function listPackagesForScript(db, scriptId) {
  const script = db.prepare('SELECT id FROM scripts WHERE id = ?').get(scriptId);
  if (!script) throw new DeliveryError(404, '稿件不存在');
  return db.prepare(`${PKG_SELECT} WHERE p.script_id = ? ORDER BY p.id DESC`).all(scriptId)
    .map((row) => packageToApi(db, row));
}

function listPackagesForBranch(db, branchId) {
  const branch = db.prepare('SELECT id FROM branches WHERE id = ?').get(branchId);
  if (!branch) throw new DeliveryError(404, '分支不存在');
  return db.prepare(`${PKG_SELECT} WHERE p.branch_id = ? ORDER BY p.id DESC`).all(branchId)
    .map((row) => packageToApi(db, row));
}

function getZip(db, packageId) {
  const row = packageRowOr404(db, packageId);
  if (!row.zip_blob) throw new DeliveryError(404, '交付包内容缺失');
  return {
    filename: row.zip_filename,
    data: Buffer.from(row.zip_blob),
    media_type: 'application/zip'
  };
}

function getPackageFile(db, packageId, role) {
  const row = packageRowOr404(db, packageId);
  const file = db.prepare(
    'SELECT * FROM delivery_files WHERE package_id = ? AND role = ? ORDER BY ord'
  ).get(packageId, role);
  if (!file) throw new DeliveryError(404, '交付包中不存在该文件');
  return {
    package: row,
    filename: file.filename,
    media_type: file.media_type,
    data: Buffer.from(file.content)
  };
}

module.exports = {
  DeliveryError,
  ROLES: ROLES.map((r) => r.role).concat(MANIFEST_ROLE),
  issuePackage,
  getPackage,
  listPackagesForScript,
  listPackagesForBranch,
  getZip,
  getPackageFile
};
