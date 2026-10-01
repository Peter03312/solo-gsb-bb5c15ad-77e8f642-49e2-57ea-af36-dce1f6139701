'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  scripts: [],
  script: null,        // 稿件详情
  actors: [],          // 当前稿件演员名单
  cue: null,           // 当前分支走词单数据
  branchId: null,
  branch: null,        // 当前分支数据
  sourceBySeq: new Map()
};

// ---------------- 工具 ----------------

async function api(url, options = {}) {
  const opts = { headers: {}, ...options };
  if (opts.body && !(opts.body instanceof FormData)) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(opts.body);
  }
  const resp = await fetch(url, opts);
  const ct = resp.headers.get('content-type') || '';
  const data = ct.includes('application/json') ? await resp.json() : await resp.text();
  if (!resp.ok) {
    const err = new Error((data && data.error) || `请求失败 (${resp.status})`);
    err.data = data;
    err.status = resp.status;
    throw err;
  }
  return data;
}

let toastTimer;
function toast(msg, kind = '') {
  const el = $('#toast');
  el.textContent = msg;
  el.className = kind;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function msToTc(ms) {
  const h = String(Math.floor(ms / 3600000)).padStart(2, '0');
  const m = String(Math.floor((ms % 3600000) / 60000)).padStart(2, '0');
  const s = String(Math.floor((ms % 60000) / 1000)).padStart(2, '0');
  const x = String(ms % 1000).padStart(3, '0');
  return `${h}:${m}:${s},${x}`;
}

function tcToMs(tc) {
  const m = /^(\d{1,2}):([0-5]\d):([0-5]\d)[,.](\d{3})$/.exec(tc.trim());
  if (!m) return NaN;
  return (+m[1]) * 3600000 + (+m[2]) * 60000 + (+m[3]) * 1000 + (+m[4]);
}

// ---------------- 稿件列表 ----------------

async function loadScripts(selectId) {
  state.scripts = await api('/api/scripts');
  const ul = $('#scriptList');
  ul.innerHTML = '';
  if (!state.scripts.length) {
    ul.innerHTML = '<li class="s-meta" style="cursor:default">暂无稿件</li>';
  }
  for (const s of state.scripts) {
    const li = document.createElement('li');
    li.dataset.id = s.id;
    li.innerHTML = `<div class="s-name">${esc(s.name)}</div>
      <div class="s-meta">${s.segment_count} 片段 · ${s.branch_count} 分支</div>`;
    li.onclick = () => openScript(s.id);
    ul.appendChild(li);
  }
  if (selectId) highlightScript(selectId);
}

function highlightScript(id) {
  $$('#scriptList li').forEach((li) => li.classList.toggle('active', String(li.dataset.id) === String(id)));
}

async function openScript(id) {
  state.script = await api(`/api/scripts/${id}`);
  state.sourceBySeq = new Map(state.script.sources.map((s) => [s.seq, s]));
  await loadActors(id);
  $('#emptyHint').hidden = true;
  $('#workspace').hidden = false;
  $('#scriptTitle').textContent = state.script.name;
  $('#scriptMeta').textContent = `创建于 ${state.script.created_at} · ${state.script.sources.length} 个来源片段`;
  $('#btnDownloadOriginal').href = `/api/scripts/${id}/original.srt`;
  highlightScript(id);
  renderTabs();
  const first = state.script.branches[0];
  if (first) await selectBranch(first.id);
}

// ---------------- 分支 Tabs ----------------

function renderTabs() {
  const tabs = $('#branchTabs');
  tabs.innerHTML = '';
  state.script.branches.forEach((b) => {
    const btn = document.createElement('button');
    btn.dataset.id = b.id;
    btn.innerHTML = `${esc(b.name)}<span class="kind-tag">${b.kind === 'merged' ? '合并结果' : '修订'}</span>`;
    btn.onclick = () => selectBranch(b.id);
    tabs.appendChild(btn);
  });
  $$('#branchTabs button').forEach((b) =>
    b.classList.toggle('active', String(b.dataset.id) === String(state.branchId)));
}

async function selectBranch(id) {
  state.branchId = id;
  state.branch = await api(`/api/branches/${id}`);
  renderTabs();
  renderEditor();
  await refreshCuePanel();
  await refreshQcPanel();
}

// ---------------- 编辑器 ----------------

function isChanged(seg) {
  const seqs = seg.source_ids.map((sid) => sourceSeqOfId(sid)).filter((x) => x != null);
  if (!seqs.length) return true;
  if (seqs.length > 1) return true; // 合并产生
  const src = state.sourceBySeq.get(seqs[0]);
  if (!src) return true;
  if (seg.source_ids.length > 1) return true;
  return seg.start_ms !== src.start_ms || seg.end_ms !== src.end_ms || seg.text !== src.text;
}

function sourceSeqOfId(sourceId) {
  for (const [seq, s] of state.sourceBySeq) if (s.id === sourceId) return seq;
  return null;
}

function renderEditor() {
  const editor = $('#editor');
  const b = state.branch;
  let html = `
    <div class="branch-toolbar">
      <input type="text" id="branchName" value="${esc(b.name)}" style="width:200px">
      <button id="btnRename">重命名</button>
      <span class="spacer"></span>
      <button id="btnValidate">导出前检查</button>
      <button id="btnBiCheck">双语导出检查</button>
      <button id="btnRecut">重剪重排</button>
      <button id="btnResetAll">整条重置为原稿</button>
      <a class="btn" id="btnCueExport" href="/api/branches/${b.id}/cue-sheet/export" download>下载演员走词单</a>
      <a class="btn" id="btnExport" href="/api/branches/${b.id}/export" download>导出 SRT</a>
      <a class="btn" id="btnBiExport" href="/api/branches/${b.id}/export-bilingual" download>导出双语 SRT</a>
    </div>
    <div id="validateResult"></div>
    <table class="seg-table">
      <thead><tr>
        <th class="col-ord">#</th><th class="col-src">来源片段</th><th class="col-actor">演员</th><th>文案</th><th class="col-tr">译文（供海外演员）</th><th class="col-time">起止时间</th><th class="col-ops">操作</th>
      </tr></thead>
      <tbody>`;

  b.segments.forEach((seg, idx) => {
    const seqs = seg.source_ids.map(sourceSeqOfId).filter((x) => x != null).sort((a, c) => a - c);
    const tags = seqs.length
      ? seqs.map((q) => `<span class="src-tag">原稿 #${q}</span>`).join('')
      : '<span class="src-tag">无来源</span>';
    const changed = isChanged(seg) ? '<span class="changed-dot">● 已改</span>' : '';
    const unassigned = seg.actor_id == null;
    const actorOptions = ['<option value="">— 未归属 —</option>']
      .concat(state.actors.map((a) =>
        `<option value="${a.id}" ${a.id === seg.actor_id ? 'selected' : ''}>${esc(a.name)}</option>`))
      .join('');
    const trText = seg.translation || '';
    const hasTr = trText.trim() !== '';
    const reviewed = !!seg.translation_reviewed;
    const trBadge = !hasTr
      ? '<span class="tr-badge tr-none">未翻译</span>'
      : reviewed
        ? '<span class="tr-badge tr-reviewed">已复核</span>'
        : '<span class="tr-badge tr-pending">待复核</span>';
    html += `
      <tr data-id="${seg.id}" class="${unassigned ? 'row-unassigned' : ''}">
        <td class="col-ord">${seg.ord}</td>
        <td class="col-src">${tags}${changed}</td>
        <td class="col-actor">
          <select data-field="actor" class="${unassigned ? 'actor-missing' : ''}">${actorOptions}</select>
          ${unassigned ? '<div class="actor-warn">未归属</div>' : ''}
        </td>
        <td><textarea rows="2" data-field="text">${esc(seg.text)}</textarea></td>
        <td class="col-tr">
          <textarea rows="2" data-field="translation" placeholder="录入译文…">${esc(trText)}</textarea>
          <div class="tr-row">
            ${trBadge}
            <button data-act="save-tr" title="保存译文；内容变化将转为待复核">存译文</button>
            <button data-act="review" ${hasTr ? '' : 'disabled'} title="${reviewed ? '取消复核标记' : '确认译文无误，标记已复核'}">${reviewed ? '取消复核' : '标记已复核'}</button>
          </div>
        </td>
        <td class="col-time">
          <div class="time-row">
            <input type="text" data-field="start_ms" value="${msToTc(seg.start_ms)}">
            <span class="arrow">→</span>
            <input type="text" data-field="end_ms" value="${msToTc(seg.end_ms)}">
          </div>
        </td>
        <td class="col-ops">
          <button data-act="save">保存</button>
          <button data-act="split">拆分</button>
          <button data-act="merge">与下条合并</button>
          <button data-act="reset" title="恢复为原稿">恢复原稿</button>
        </td>
      </tr>`;
  });
  html += '</tbody></table>';
  editor.innerHTML = html;

  $('#btnRename').onclick = renameBranch;
  $('#btnValidate').onclick = runValidate;
  $('#btnBiCheck').onclick = runBilingualCheck;
  $('#btnRecut').onclick = openRecutDialog;
  $('#btnResetAll').onclick = resetAll;
  $('#btnCueExport').onclick = (e) => { e.preventDefault(); cueExport(); };
  $('#btnExport').onclick = (e) => {
    // 导出失败时服务器返回 409 JSON，阻止浏览器直接打开错误页
    e.preventDefault();
    exportSrt();
  };
  $('#btnBiExport').onclick = (e) => {
    e.preventDefault();
    exportBilingual();
  };

  $$('#editor tbody tr').forEach((tr) => {
    const id = Number(tr.dataset.id);
    tr.querySelector('[data-act=save]').onclick = () => saveSegment(tr, id);
    tr.querySelector('[data-act=split]').onclick = () => splitSegment(id);
    tr.querySelector('[data-act=merge]').onclick = () => mergeWithNext(id);
    tr.querySelector('[data-act=reset]').onclick = () => resetSegment(id);
    tr.querySelector('[data-act=save-tr]').onclick = () => saveTranslation(tr, id);
    tr.querySelector('[data-act=review]').onclick = () => toggleReview(id);
    tr.querySelector('[data-field=actor]').onchange = (ev) => assignActor(id, ev.target.value === '' ? null : Number(ev.target.value), ev.target);
  });
}

async function renameBranch() {
  const name = $('#branchName').value.trim();
  if (!name) return toast('分支名称不能为空', 'error');
  await api(`/api/branches/${state.branchId}`, { method: 'PATCH', body: { name } });
  toast('已重命名', 'ok');
  await loadScripts(state.script.id);
  state.script = await api(`/api/scripts/${state.script.id}`);
  renderTabs();
}

async function saveSegment(tr, id) {
  const start = tcToMs(tr.querySelector('[data-field=start_ms]').value);
  const end = tcToMs(tr.querySelector('[data-field=end_ms]').value);
  const text = tr.querySelector('[data-field=text]').value;
  if (Number.isNaN(start) || Number.isNaN(end)) {
    return toast('时间码格式应为 HH:MM:SS,mmm', 'error');
  }
  if (start < 0 || end < 0) return toast('时间不能为负', 'error');
  if (start >= end) return toast('起点必须早于终点', 'error');
  try {
    const r = await api(`/api/branches/${state.branchId}/segments/${id}`, {
      method: 'PATCH', body: { start_ms: start, end_ms: end, text }
    });
    toast(r.translation_stale
      ? '片段已保存；原文已改动，译文保留为参考并转为待复核'
      : '片段已保存', 'ok');
    await selectBranch(state.branchId);
  } catch (e) { toast(e.message, 'error'); }
}

async function splitSegment(id) {
  const seg = state.branch.segments.find((s) => s.id === id);
  const input = prompt(
    `在何处拆分？输入切点时间码（严格位于 ${msToTc(seg.start_ms)} 与 ${msToTc(seg.end_ms)} 之间）`,
    msToTc(Math.floor((seg.start_ms + seg.end_ms) / 2))
  );
  if (input === null) return;
  const cut = tcToMs(input);
  if (Number.isNaN(cut)) return toast('时间码格式应为 HH:MM:SS,mmm', 'error');
  try {
    const r = await api(`/api/branches/${state.branchId}/segments/${id}/split`, {
      method: 'POST', body: { cut_ms: cut }
    });
    toast(r.translation_carried
      ? '已拆分：两条均保留原译文作参考并转为待复核'
      : '已拆分', 'ok');
    await selectBranch(state.branchId);
  } catch (e) { toast(e.message, 'error'); }
}

async function mergeWithNext(id) {
  if (!confirm('确定与下一片段合并？时间取外边界，文案用空格连接（之后可再编辑）。演员仅在两条相同时沿用，否则会清空并需重新指定；已有译文按原顺序拼接并转为待复核。')) return;
  try {
    const r = await api(`/api/branches/${state.branchId}/segments/${id}/merge-with-next`, {
      method: 'POST', body: {}
    });
    let msg = r.notice || '已合并';
    if (r.translation_carried) msg += '；译文已按原顺序拼接并转为待复核';
    toast(msg, r.notice ? 'error' : 'ok');
    await selectBranch(state.branchId);
  } catch (e) { toast(e.message, 'error'); }
}

async function assignActor(id, actorId, selectEl) {
  try {
    const r = await api(`/api/branches/${state.branchId}/segments/${id}/actor`, {
      method: 'PUT', body: { actor_id: actorId }
    });
    toast(actorId == null ? '已清除演员归属' : '已指定演员', 'ok');
    // 归属变化不影响文案/时码，但走词单与行内高亮需要刷新；仅刷新走词单面板与该行高亮
    await refreshCuePanel();
    await loadActors(state.script.id);
    const tr = selectEl.closest('tr');
    tr.classList.toggle('row-unassigned', r.actor_id == null);
    const warn = tr.querySelector('.actor-warn');
    if (r.actor_id == null && !warn) {
      const td = tr.querySelector('.col-actor');
      const d = document.createElement('div');
      d.className = 'actor-warn';
      d.textContent = '未归属';
      td.appendChild(d);
    } else if (r.actor_id != null && warn) {
      warn.remove();
    }
    selectEl.classList.toggle('actor-missing', r.actor_id == null);
  } catch (e) {
    toast(e.message, 'error');
    await selectBranch(state.branchId);
  }
}

async function resetSegment(id) {
  if (!confirm('将该片段恢复为原稿内容与时间？该片段的译文将被清空。')) return;
  try {
    const r = await api(`/api/branches/${state.branchId}/segments/${id}/reset`, { method: 'POST' });
    toast(r.translation_cleared ? '已恢复原稿，译文已清空' : '已恢复原稿', 'ok');
    await selectBranch(state.branchId);
  } catch (e) { toast(e.message, 'error'); }
}

async function resetAll() {
  if (state.branch.kind === 'merged') return toast('合并结果分支不可整体重置', 'error');
  if (!confirm('整条分支重置回原稿？当前分支的全部修改与全部译文将丢失。')) return;
  const r = await api(`/api/branches/${state.branchId}/reset-all`, { method: 'POST' });
  toast(r.translations_cleared ? `已重置为原稿，清空 ${r.translations_cleared} 条译文` : '已重置为原稿', 'ok');
  await selectBranch(state.branchId);
}

// ---------------- 译文（双语字幕） ----------------

async function saveTranslation(rowEl, id) {
  const translation = rowEl.querySelector('[data-field=translation]').value;
  try {
    const r = await api(`/api/branches/${state.branchId}/segments/${id}/translation`, {
      method: 'PUT', body: { translation }
    });
    if (!r.changed) toast('译文未变化', 'ok');
    else if (r.translation == null) toast('译文已清空', 'ok');
    else toast('译文已保存（待复核，确认无误后请点「标记已复核」）', 'ok');
    await selectBranch(state.branchId);
  } catch (e) { toast(e.message, 'error'); }
}

async function toggleReview(id) {
  const seg = state.branch.segments.find((s) => s.id === id);
  if (!seg) return;
  const reviewed = !seg.translation_reviewed;
  try {
    await api(`/api/branches/${state.branchId}/segments/${id}/translation/review`, {
      method: 'PUT', body: { reviewed }
    });
    toast(reviewed ? '已标记为已复核' : '已转为待复核', 'ok');
    await selectBranch(state.branchId);
  } catch (e) { toast(e.message, 'error'); }
}

// ---------------- 导出检查 ----------------

async function runValidate() {
  const result = await api(`/api/branches/${state.branchId}/validate`);
  const box = $('#validateResult');
  if (result.ok) {
    box.innerHTML = '<div class="validate-ok">✓ 检查通过：时间非负、起点均早于终点、片段互不重叠，可以导出。</div>';
  } else {
    box.innerHTML = `<div class="validate-bad">✗ 发现 ${result.issues.length} 处问题（修复前无法导出）：</div>
      <ul class="issue-list">${result.issues.map((i) =>
        `<li>${i.ord ? `片段 #${i.ord}：` : ''}${esc(i.message)}</li>`).join('')}</ul>`;
  }
}

async function exportSrt() {
  try {
    const resp = await fetch(`/api/branches/${state.branchId}/export`);
    if (!resp.ok) {
      const data = await resp.json();
      const list = (data.issues || []).map((i) => `${i.ord ? `片段 #${i.ord}：` : ''}${i.message}`).join('\n');
      return toast(`导出被阻止：${data.error}${list ? '\n' + list : ''}`, 'error');
    }
    const blob = await resp.blob();
    const cd = resp.headers.get('Content-Disposition') || '';
    const m = /filename\*=UTF-8''(.+)$/.exec(cd);
    const fname = m ? decodeURIComponent(m[1]) : 'export.srt';
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = fname;
    a.click();
    URL.revokeObjectURL(a.href);
    toast('已导出 SRT', 'ok');
  } catch (e) {
    toast(e.message, 'error');
  }
}

// ---------------- 双语导出 ----------------

function renderBilingualResult(box, data) {
  const bi = data.bilingual_issues || [];
  const tl = data.timeline_issues || [];
  if (!bi.length && !tl.length) {
    box.innerHTML = `<div class="validate-ok">✓ 双语导出检查通过：${data.segment_count ?? ''} 条片段均有已复核译文，时间线无误，可导出双语 SRT。</div>`;
    return;
  }
  const items = [
    ...bi.map((i) => `<li>片段 #${i.ord}（${i.timecode}）：${i.issue === 'missing_translation' ? '空译文，请录入译文' : '译文待复核，请复核后标记'}</li>`),
    ...tl.map((i) => `<li>${i.ord ? `时间线 片段 #${i.ord}：` : '时间线：'}${esc(i.message)}</li>`)
  ];
  box.innerHTML = `<div class="validate-bad">✗ 双语导出被阻止（空译文/待复核 ${bi.length} 条，时间线问题 ${tl.length} 处），整份导出已被拒绝：</div>
    <ul class="issue-list">${items.join('')}</ul>`;
}

async function runBilingualCheck() {
  try {
    const result = await api(`/api/branches/${state.branchId}/bilingual/validate`);
    renderBilingualResult($('#validateResult'), result);
  } catch (e) { toast(e.message, 'error'); }
}

async function exportBilingual() {
  try {
    const resp = await fetch(`/api/branches/${state.branchId}/export-bilingual`);
    if (!resp.ok) {
      const data = await resp.json();
      renderBilingualResult($('#validateResult'), data);
      return toast(`双语导出被阻止：${data.error}`, 'error');
    }
    const blob = await resp.blob();
    const cd = resp.headers.get('Content-Disposition') || '';
    const m = /filename\*=UTF-8''(.+)$/.exec(cd);
    const fname = m ? decodeURIComponent(m[1]) : 'bilingual.srt';
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = fname;
    a.click();
    URL.revokeObjectURL(a.href);
    toast('已导出双语 SRT', 'ok');
  } catch (e) {
    toast(e.message, 'error');
  }
}

// ---------------- 导入 ----------------

$('#btnImport').onclick = () => {
  $('#formImport').reset();
  $('#importErrors').hidden = true;
  $('#dlgImport').showModal();
};
$('#importCancel').onclick = () => $('#dlgImport').close();

$('#importSubmit').onclick = async () => {
  const fileInput = $('#importFile');
  if (!fileInput.files.length) return toast('请选择 .srt 文件', 'error');
  const fd = new FormData();
  fd.append('file', fileInput.files[0]);
  if ($('#importName').value.trim()) fd.append('name', $('#importName').value.trim());
  try {
    const created = await api('/api/scripts', { method: 'POST', body: fd });
    $('#dlgImport').close();
    toast(`导入成功：${created.segment_count} 个片段，已建立两条修订分支`, 'ok');
    await loadScripts(created.id);
    await openScript(created.id);
  } catch (e) {
    const box = $('#importErrors');
    const errs = (e.data && e.data.errors) || [];
    box.innerHTML = `<div><b>${esc(e.message)}</b></div>` +
      (errs.length ? `<ul class="issue-list">${errs.map((x) =>
        `<li><span class="e-line">第 ${x.line} 行</span>：${esc(x.message)}</li>`).join('')}</ul>` : '');
    box.hidden = false;
  }
};

// ---------------- 原稿查看 ----------------

$('#btnViewOriginal').onclick = async () => {
  const text = await api(`/api/scripts/${state.script.id}/original`);
  $('#originalText').textContent = text;
  $('#dlgOriginal').showModal();
};
$('#originalClose').onclick = () => $('#dlgOriginal').close();

// ---------------- 删除稿件 ----------------

$('#btnDeleteScript').onclick = async () => {
  if (!confirm(`确定删除稿件「${state.script.name}」及其所有分支？此操作不可恢复。`)) return;
  await api(`/api/scripts/${state.script.id}`, { method: 'DELETE' });
  state.script = null;
  state.branch = null;
  $('#workspace').hidden = true;
  $('#emptyHint').hidden = false;
  await loadScripts();
  toast('已删除', 'ok');
};

// ---------------- 合并 ----------------

let mergeState = null; // { entries, choices: Map }

$('#btnMerge').onclick = async () => {
  const revisions = state.script.branches;
  if (revisions.length < 2) return toast('至少需要两条分支', 'error');
  const aId = revisions[0].id;
  const bId = revisions[1].id;
  try {
    const preview = await api('/api/merge/preview', {
      method: 'POST', body: { branch_a_id: aId, branch_b_id: bId }
    });
    mergeState = preview;
    renderMergeDialog();
    $('#dlgMerge').showModal();
  } catch (e) { toast(e.message, 'error'); }
};
$('#mergeCancel').onclick = () => $('#dlgMerge').close();

function renderMergeDialog() {
  const p = mergeState;
  const conflicts = p.entries.filter((e) => e.type === 'conflict');
  p.choices = new Map();

  $('#mergeSummary').innerHTML = `合并 <b>${esc(p.branch_a.name)}</b> 与 <b>${esc(p.branch_b.name)}</b>：
    共 ${p.entries.length} 组来源区间，其中
    <span style="color:var(--conflict)">${p.conflictCount} 处冲突</span>
    需要你逐处选择，其余改动自动保留。`;

  const wrap = $('#mergeEntries');
  wrap.innerHTML = '';
  p.entries.forEach((e) => wrap.appendChild(renderMergeEntry(e)));
  updateMergeSubmit();
}

function renderSegMini(seg) {
  const actor = seg.actor_name
    ? `<span class="cue-actor-tag">🎭 ${esc(seg.actor_name)}</span>`
    : '<span class="cue-actor-tag none">未归属</span>';
  const hasTr = !!(seg.translation && String(seg.translation).trim());
  const trBadge = !hasTr
    ? '<span class="tr-badge tr-none">无译文</span>'
    : seg.translation_reviewed
      ? '<span class="tr-badge tr-reviewed">译文已复核</span>'
      : '<span class="tr-badge tr-pending">译文待复核</span>';
  const trLine = hasTr
    ? `<div class="cc-tr">译：${esc(seg.translation).replace(/\n/g, '<br>')}</div>`
    : '';
  return `<div class="cc-seg">
    <div class="t">${msToTc(seg.start_ms)} → ${msToTc(seg.end_ms)} ${actor} ${trBadge}</div>
    <div>${esc(seg.text).replace(/\n/g, '<br>')}</div>
    ${trLine}
  </div>`;
}

function renderMergeEntry(e) {
  const div = document.createElement('div');
  const srcLabel = e.source_start === e.source_end
    ? `来源片段 #${e.source_start}`
    : `来源片段 #${e.source_start}–#${e.source_end}`;

  if (e.type === 'conflict') {
    div.className = 'merge-entry conflict';
    div.innerHTML = `
      <div class="me-head"><span>${srcLabel}</span><span class="badge conflict">冲突：双方都修改，必须选择</span></div>
      <div class="me-body">
        <div class="conflict-choice">
          <div class="choice-card" data-side="A">
            <div class="cc-title">采用 A：${esc(e.side_a.branch_name)}（${e.side_a.segments.length} 片段）</div>
            ${e.side_a.segments.map(renderSegMini).join('')}
          </div>
          <div class="choice-card" data-side="B">
            <div class="cc-title">采用 B：${esc(e.side_b.branch_name)}（${e.side_b.segments.length} 片段）</div>
            ${e.side_b.segments.map(renderSegMini).join('')}
          </div>
        </div>
      </div>`;
    div.querySelectorAll('.choice-card').forEach((card) => {
      card.onclick = () => {
        mergeState.choices.set(e.conflict_index, card.dataset.side);
        div.querySelectorAll('.choice-card').forEach((c) =>
          c.classList.toggle('selected', c === card));
        updateMergeSubmit();
      };
    });
  } else {
    const map = {
      unchanged: ['未改动，保留原稿', 'keep'],
      a_only: [`仅 A 修改，自动保留（${esc(mergeState.branch_a.name)}）`, 'a'],
      b_only: [`仅 B 修改，自动保留（${esc(mergeState.branch_b.name)}）`, 'b'],
      both_same: ['双方改动一致（含演员归属与译文），自动保留', 'keep']
    };
    const [label, cls] = map[e.type];
    div.className = 'merge-entry';
    div.innerHTML = `
      <div class="me-head"><span>${srcLabel}</span><span class="badge ${cls}">${label}</span></div>
      <div class="me-body">${e.segments.map(renderSegMini).join('')}</div>`;
  }
  return div;
}

function updateMergeSubmit() {
  const total = mergeState.conflictCount;
  const chosen = mergeState.choices.size;
  const btn = $('#mergeSubmit');
  btn.disabled = chosen !== total;
  btn.textContent = total === 0
    ? '无冲突，生成合并分支'
    : `已选择 ${chosen}/${total} 处冲突，生成合并分支`;
}

$('#mergeSubmit').onclick = async () => {
  const resolutions = {};
  for (const [k, v] of mergeState.choices) resolutions[k] = v;
  try {
    const result = await api('/api/merge/apply', {
      method: 'POST',
      body: {
        branch_a_id: mergeState.branch_a.id,
        branch_b_id: mergeState.branch_b.id,
        resolutions,
        merged_name: `合并（${mergeState.branch_a.name} × ${mergeState.branch_b.name}）`
      }
    });
    $('#dlgMerge').close();
    toast(`合并分支「${result.name}」已生成`, 'ok');
    await loadScripts(state.script.id);
    await openScript(state.script.id);
    await selectBranch(result.id);
  } catch (e) { toast(e.message, 'error'); }
};

// ---------------- 重剪重排 ----------------

const recutState = { preview: null };

function openRecutDialog() {
  recutState.preview = null;
  $('#rcLo').value = '';
  $('#rcHi').value = '';
  $('#rcStart').value = '';
  $('#rcEnd').value = '';
  $('#recutErrors').hidden = true;
  $('#recutErrors').innerHTML = '';
  $('#recutResult').innerHTML = '';
  $('#recutHint').textContent = '';
  $('#recutSubmit').disabled = true;
  $('#dlgRecut').showModal();
}
$('#recutCancel').onclick = () => $('#dlgRecut').close();

function showRecutErrors(err) {
  const box = $('#recutErrors');
  const errs = (err.data && (err.data.recut_errors || err.data.errors)) || [];
  box.innerHTML = `<div><b>${esc(err.message)}</b></div>` +
    (errs.length ? `<ul class="issue-list">${errs.map((x) =>
      `<li>${x.ord ? `<span class="e-line">片段 #${x.ord}：</span>` : ''}${esc(x.message)}</li>`).join('')}</ul>` : '');
  box.hidden = false;
}

$('#recutPreview').onclick = async () => {
  const body = {
    source_start: $('#rcLo').value.trim(),
    source_end: $('#rcHi').value.trim(),
    new_start: $('#rcStart').value.trim(),
    new_end: $('#rcEnd').value.trim()
  };
  $('#recutErrors').hidden = true;
  try {
    const p = await api(`/api/branches/${state.branchId}/recut/preview`, { method: 'POST', body });
    recutState.preview = p;
    renderRecutPreview(p);
  } catch (e) {
    recutState.preview = null;
    $('#recutResult').innerHTML = '';
    $('#recutSubmit').disabled = true;
    showRecutErrors(e);
  }
};

function renderRecutPreview(p) {
  $('#recutErrors').hidden = true;
  const shiftText = `${p.shift_ms >= 0 ? '+' : '−'}${(Math.abs(p.shift_ms) / 1000).toFixed(3)} 秒`;
  let html = `
    <div class="recut-summary">
      来源区间 <b>#${p.source_start}–#${p.source_end}</b>：
      原时间 ${p.old_range.timecode} → 新时间 <b>${p.new_range.timecode}</b>；
      等比系数 ${p.scale_ratio}，区间后整体平移 <b>${shiftText}</b>。
      受影响片段共 <b>${p.affected.length}</b> 条（区间内 ${p.counts.inside}、区间后 ${p.counts.after}），
      其中时码实际变化 <b>${p.counts.changed}</b> 条；区间前 ${p.counts.before} 条不动。
    </div>`;

  if (!p.can_apply) {
    const allErr = [
      ...p.errors.map((x) => ({ kind: '换算问题', x })),
      ...p.timeline_issues.map((x) => ({ kind: '时间线问题', x }))
    ];
    html += `<div class="qc-banner bad">✗ 存在 ${allErr.length} 处问题，确认按钮已禁用（提交会被整体拒绝）：
      <ul class="issue-list">${allErr.map(({ kind, x }) =>
        `<li><span class="e-line">${kind}${x.ord ? ` #${x.ord}` : ''}：</span>${esc(x.message)}</li>`).join('')}</ul></div>`;
  } else {
    html += '<div class="qc-banner ok">✓ 换算与时间线校验通过，可以确认。确认前请核对下方每条受影响片段的新旧时码。</div>';
  }

  const rows = p.affected.map((a) => `
    <tr class="${a.time_changed ? '' : 'unchanged'}">
      <td class="col-ord">${a.ord}</td>
      <td>
        ${(a.source_seqs || []).map((q) => `<span class="src-tag">原稿 #${q}</span>`).join('')}
        <div class="meta">${a.role === 'inside' ? '区间内（等比重排）' : '区间后（整体平移）'}</div>
      </td>
      <td class="tc-cell">${a.old_timecode}</td>
      <td class="tc-cell ${a.time_changed ? 'tc-new' : ''}">${a.new_timecode}</td>
      <td>${a.time_changed ? '<span class="changed-dot">时码变化</span>' : '<span class="meta">实际未变</span>'}</td>
    </tr>`).join('');
  html += `<table class="qc-table"><thead><tr>
      <th class="col-ord">片段#</th><th>来源 / 角色</th><th>旧时码</th><th>新时码</th><th>状态</th>
    </tr></thead><tbody>${rows}</tbody></table>
    <div class="meta">预览后若该分支被编辑、拆分、合并或重置，提交将被拒绝并要求重新预览。</div>`;

  $('#recutResult').innerHTML = html;
  $('#recutHint').textContent = p.can_apply ? '预览已生成且校验通过' : '预览已生成，但存在问题';
  $('#recutSubmit').disabled = !p.can_apply;
}

$('#recutSubmit').onclick = async () => {
  const p = recutState.preview;
  if (!p || !p.can_apply) return;
  try {
    const result = await api(`/api/branches/${state.branchId}/recut/apply`, {
      method: 'POST',
      body: {
        source_start: p.source_start,
        source_end: p.source_end,
        new_start: p.new_range.start_ms,
        new_end: p.new_range.end_ms,
        token: p.token
      }
    });
    $('#dlgRecut').close();
    toast(`重排已提交：${result.counts.changed} 条片段时码更新（受影响 ${result.affected.length} 条）`, 'ok');
    await selectBranch(state.branchId);
  } catch (e) {
    recutState.preview = null;
    $('#recutSubmit').disabled = true;
    $('#recutResult').innerHTML = '';
    showRecutErrors(e);
    if (e.data && e.data.preview_stale) toast('请重新预览后再提交', 'error');
  }
};

// ---------------- 演员名单 ----------------

async function loadActors(scriptId) {
  const data = await api(`/api/scripts/${scriptId}/actors`);
  state.actors = data.actors || [];
}

$('#btnActors').onclick = async () => {
  await loadActors(state.script.id);
  renderActorDialog();
  $('#actorErrors').hidden = true;
  $('#dlgActors').showModal();
  $('#actorNameInput').focus();
};
$('#actorsClose').onclick = () => $('#dlgActors').close();

function renderActorDialog() {
  const ul = $('#actorList');
  ul.innerHTML = '';
  if (!state.actors.length) {
    ul.innerHTML = '<li class="s-meta" style="cursor:default">尚未登记演员</li>';
    return;
  }
  state.actors.forEach((a) => {
    const li = document.createElement('li');
    li.innerHTML = `
      <span class="act-name"></span>
      <span class="s-meta">${a.assigned_count} 条归属（全部分支）</span>
      <span class="act-ops">
        <button type="button" data-op="rename">重命名</button>
        <button type="button" data-op="del" class="danger-text">删除</button>
      </span>`;
    li.querySelector('.act-name').textContent = a.name;
    li.querySelector('[data-op=rename]').onclick = async () => {
      const name = prompt('重命名演员（同步显示于所有分支）', a.name);
      if (name === null) return;
      try {
        await api(`/api/scripts/${state.script.id}/actors/${a.id}`, {
          method: 'PATCH', body: { name }
        });
        toast('已重命名', 'ok');
        await loadActors(state.script.id);
        renderActorDialog();
        await selectBranch(state.branchId);
      } catch (e) { toast(e.message, 'error'); }
    };
    li.querySelector('[data-op=del]').onclick = async () => {
      const extra = a.assigned_count
        ? `该演员当前有 ${a.assigned_count} 条片段归属，删除后这些片段将变为「未归属」。`
        : '';
      if (!confirm(`确定删除演员「${a.name}」？${extra}`)) return;
      try {
        const r = await api(`/api/scripts/${state.script.id}/actors/${a.id}`, { method: 'DELETE' });
        toast(`已删除${r.cleared_assignments ? `，清空 ${r.cleared_assignments} 条归属` : ''}`, 'ok');
        await loadActors(state.script.id);
        renderActorDialog();
        await selectBranch(state.branchId);
      } catch (e) { toast(e.message, 'error'); }
    };
    ul.appendChild(li);
  });
}

async function submitNewActor() {
  const input = $('#actorNameInput');
  const name = input.value.trim();
  if (!name) return toast('演员姓名不能为空', 'error');
  try {
    await api(`/api/scripts/${state.script.id}/actors`, { method: 'POST', body: { name } });
    input.value = '';
    $('#actorErrors').hidden = true;
    await loadActors(state.script.id);
    renderActorDialog();
    await selectBranch(state.branchId);
    toast(`已登记演员「${name}」`, 'ok');
  } catch (e) {
    const box = $('#actorErrors');
    box.textContent = e.message;
    box.hidden = false;
  }
}
$('#actorAddBtn').onclick = submitNewActor;
$('#actorNameInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); submitNewActor(); }
});

// ---------------- 演员走词单 ----------------

async function refreshCuePanel() {
  if (!state.branchId) { $('#cuePanel').innerHTML = ''; return; }
  try {
    state.cue = await api(`/api/branches/${state.branchId}/cue-sheet`);
    renderCuePanel();
  } catch (e) {
    $('#cuePanel').innerHTML = '';
  }
}

function renderCuePanel() {
  const panel = $('#cuePanel');
  const c = state.cue;
  if (!c) { panel.innerHTML = ''; return; }

  let html = `
    <div class="qc-head">
      <div class="qc-title">演员走词单
        <span class="src-tag">${c.cue_sheet.length} 名演员</span>
        <span class="src-tag">${c.total_lines} 条片段</span>
      </div>
      <div class="qc-actions">
        <button id="btnCueRefresh">刷新</button>
        <button id="btnCueDl" class="primary">下载走词单</button>
      </div>
    </div>`;

  if (!c.can_export) {
    const items = [];
    c.unassigned.forEach((u) => items.push(
      `<li>片段 #${u.ord}（${u.timecode}）${u.text_excerpt ? `：${esc(u.text_excerpt)}` : ''}</li>`));
    c.timeline_issues.forEach((i) => items.push(
      `<li>${i.ord ? `时间线 片段 #${i.ord}：` : '时间线：'}${esc(i.message)}</li>`));
    html += `<div class="qc-banner bad">✗ 存在 ${c.unassigned.length} 条未归属片段、${c.timeline_issues.length} 处时间线问题，<b>整份走词单导出被拒绝</b>：
      <ul class="issue-list">${items.join('')}</ul></div>`;
  } else {
    html += '<div class="qc-banner ok">✓ 全部片段已归属且时间线无误，可以导出走词单。下方按演员列出走词顺序。</div>';
  }

  if (!c.cue_sheet.length) {
    html += '<div class="qc-banner">还没有任何归属。请先在「演员名单」登记演员，并在片段表格的「演员」列逐条指定。</div>';
  } else {
    html += c.cue_sheet.map((g) => `
      <div class="cue-group">
        <h4>${esc(g.actor_name)}<span class="s-meta">（${g.line_count} 条）</span></h4>
        <table class="qc-table"><thead><tr>
          <th class="col-ord">顺序</th><th class="col-cue-tc">时码</th><th>台词</th><th class="col-cue-src">原稿来源</th>
        </tr></thead><tbody>
        ${g.lines.map((ln, i) => `
          <tr>
            <td class="col-ord">${i + 1}</td>
            <td class="tc-cell">${ln.timecode}</td>
            <td>${esc(ln.text).replace(/\n/g, '<br>')}</td>
            <td>${ln.source_seqs.length ? ln.source_seqs.map((q) => `#${q}`).join(', ') : '—'}</td>
          </tr>`).join('')}
        </tbody></table>
      </div>`).join('');
  }

  panel.innerHTML = html;
  $('#btnCueRefresh').onclick = refreshCuePanel;
  $('#btnCueDl').onclick = cueExport;
}

async function cueExport() {
  try {
    const resp = await fetch(`/api/branches/${state.branchId}/cue-sheet/export`);
    if (!resp.ok) {
      const data = await resp.json();
      const lines = [data.error];
      (data.unassigned || []).forEach((u) =>
        lines.push(`· 未归属 片段 #${u.ord}（${u.timecode}）${u.text_excerpt ? '：' + u.text_excerpt : ''}`));
      (data.timeline_issues || []).forEach((i) =>
        lines.push(`· 时间线${i.ord ? ` #${i.ord}` : ''}：${i.message}`));
      return toast(lines.join('\n'), 'error');
    }
    const blob = await resp.blob();
    const cd = resp.headers.get('Content-Disposition') || '';
    const m = /filename\*=UTF-8''(.+)$/.exec(cd);
    const fname = m ? decodeURIComponent(m[1]) : 'cue-sheet.txt';
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = fname;
    a.click();
    URL.revokeObjectURL(a.href);
    toast('已导出演员走词单', 'ok');
  } catch (e) {
    toast(e.message, 'error');
  }
}

// ---------------- 放映质检 ----------------

const qcState = {
  rulesConfigured: false,
  rules: null,
  report: null
};

function secFromMs(ms) { return ms == null ? '' : (ms / 1000).toString(); }

async function loadQcRules() {
  const data = await api(`/api/scripts/${state.script.id}/qc-rules`);
  qcState.rulesConfigured = data.configured;
  qcState.rules = data.rules;
}

// 质检规则对话框
$('#btnQcRules').onclick = async () => {
  try {
    await loadQcRules();
  } catch (e) { return toast(e.message, 'error'); }
  const r = qcState.rules;
  $('#qcMinDur').value = r ? secFromMs(r.min_duration_ms) : '';
  $('#qcMaxDur').value = r ? secFromMs(r.max_duration_ms) : '';
  $('#qcMaxCps').value = r && r.max_cps != null ? String(r.max_cps) : '';
  $('#qcMinGap').value = r ? secFromMs(r.min_gap_ms) : '';
  $('#qcBanned').value = r ? r.banned_words.join('\n') : '';
  $('#qcRuleMeta').textContent = r
    ? `当前为规则版本 v${r.version_no}（保存于 ${r.created_at}）。规则内容实质变化会生成新版本，既有豁免将按旧版本保留但不再适用于新报告。`
    : '该稿件尚未配置质检规则。';
  $('#qcRuleErrors').hidden = true;
  $('#dlgQcRules').showModal();
};
$('#qcRulesCancel').onclick = () => $('#dlgQcRules').close();

$('#qcRulesSave').onclick = async () => {
  const body = {
    min_duration: $('#qcMinDur').value.trim(),
    max_duration: $('#qcMaxDur').value.trim(),
    max_cps: $('#qcMaxCps').value.trim(),
    min_gap: $('#qcMinGap').value.trim(),
    banned_words: $('#qcBanned').value
  };
  try {
    const result = await api(`/api/scripts/${state.script.id}/qc-rules`, {
      method: 'PUT', body
    });
    qcState.rules = result.rules;
    qcState.rulesConfigured = true;
    $('#dlgQcRules').close();
    toast(result.changed ? `质检规则已保存（新版本 v${result.rules.version_no}），请重新生成报告` : '规则内容未变化，仍为当前版本', result.changed ? 'ok' : '');
    await refreshQcPanel();
  } catch (e) {
    const box = $('#qcRuleErrors');
    const errs = (e.data && e.data.qc_errors) || [];
    box.innerHTML = `<div><b>${esc(e.message)}</b></div>` +
      (errs.length ? `<ul class="issue-list">${errs.map((x) =>
        `<li><span class="e-line">${esc(x.field || '')}</span>：${esc(x.message)}</li>`).join('')}</ul>` : '');
    box.hidden = false;
  }
};

// 面板渲染与报告刷新
async function refreshQcPanel() {
  try {
    await loadQcRules();
  } catch (e) { /* 列表场景忽略 */ }
  const data = await api(`/api/branches/${state.branchId}/qc/reports/latest`);
  qcState.report = data.exists ? data.report : null;
  renderQcPanel();
}

function renderQcPanel() {
  const panel = $('#qcPanel');
  const r = qcState.report;

  let html = `
    <div class="qc-head">
      <div class="qc-title">放映质检
        ${qcState.rules ? `<span class="src-tag">规则 v${qcState.rules.version_no}</span>` : '<span class="src-tag">未配置规则</span>'}
      </div>
      <div class="qc-actions">
        <button id="btnQcRun" class="primary">${r ? '重新生成质检报告' : '生成质检报告'}</button>
        <button id="btnQcDownload">质检专用下载</button>
      </div>
    </div>`;

  if (!qcState.rulesConfigured) {
    html += '<div class="qc-banner warn">尚未为该稿件配置质检规则。请先点右上角「质检规则」配置后再生成报告。</div>';
  }

  if (!r) {
    html += '<div class="qc-banner">尚未生成质检报告。生成后可在此查看命中规则、片段序号、原稿来源及原因，并对具体命中填写豁免。</div>';
  } else {
    const changed = r.state_changed;
    const rulesChanged = !r.rules_current;
    if (changed) {
      html += '<div class="qc-banner bad">⚠ 分支内容已在报告生成后发生变化（编辑/拆分/合并）。旧结果不得沿用，请重新生成质检报告。</div>';
    } else if (rulesChanged) {
      html += `<div class="qc-banner bad">⚠ 质检规则已更新到新版本，本报告基于规则 v${r.rule_version.version_no}，请重新生成质检报告。</div>`;
    } else {
      const cls = r.passed ? 'ok' : (r.unresolved_count ? 'bad' : 'warn');
      const summary = r.passed
        ? `✓ 质检通过：${r.hit_count} 条命中均已豁免，时间线无问题，可以质检专用下载。`
        : `共 ${r.hit_count} 条命中：<b>${r.unresolved_count}</b> 条未豁免，${r.exempted_count} 条已豁免；时间线问题 ${r.timeline_issues.length} 处。`;
      html += `<div class="qc-banner ${cls}">${summary}
        <span class="meta">报告生成于 ${r.created_at}</span></div>`;
    }

    html += renderQcTimeline(r);
    html += renderQcHits(r);
    if (r.invalid_exemptions && r.invalid_exemptions.length) {
      html += `<div class="qc-section">
        <h4>已自动失效的豁免（${r.invalid_exemptions.length}）</h4>
        <ul class="issue-list">${r.invalid_exemptions.map((x) =>
          `<li>片段 #${x.ord} · ${esc(x.rule_label)}：${esc(x.hit_message)} —— <span class="e-line">${esc(x.invalid_reason)}</span>（原理由：${esc(x.reason)}）</li>`
        ).join('')}</ul></div>`;
    }
  }

  panel.innerHTML = html;

  $('#btnQcRun').onclick = runQcReport;
  $('#btnQcDownload').onclick = qcExport;

  if (r && !r.state_changed && r.rules_current) {
    $$('#qcPanel [data-exempt]').forEach((btn) => {
      btn.onclick = () => exemptHit(Number(btn.dataset.hitId));
    });
    $$('#qcPanel [data-revoke]').forEach((btn) => {
      btn.onclick = () => revokeExemption(Number(btn.dataset.revoke));
    });
  }
}

function renderQcTimeline(r) {
  if (!r.timeline_issues.length) {
    return '<div class="qc-section"><h4 class="qc-ok">时间线：无问题</h4></div>';
  }
  return `<div class="qc-section">
    <h4 class="qc-bad-text">时间线问题（${r.timeline_issues.length}）——存在时间线错误时不生成 SRT</h4>
    <ul class="issue-list">${r.timeline_issues.map((i) =>
      `<li>${i.ord ? `片段 #${i.ord}：` : ''}${esc(i.message)}</li>`).join('')}</ul>
  </div>`;
}

function renderQcHits(r) {
  if (!r.hits.length) return '<div class="qc-section"><h4 class="qc-ok">规则命中：无</h4></div>';
  const stale = r.state_changed || !r.rules_current;
  const rows = r.hits.map((h) => {
    const srcs = h.source_seqs.length
      ? h.source_seqs.map((q) => `<span class="src-tag">原稿 #${q}</span>`).join('')
      : '<span class="src-tag">无来源</span>';
    const exempt = h.exemption;
    const statusCls = exempt ? 'exempt' : 'open';
    return `
      <tr class="qc-hit ${statusCls}">
        <td class="col-ord">${h.ord}</td>
        <td class="col-rule">${esc(h.rule_label)}${srcs ? `<div>${srcs}</div>` : ''}</td>
        <td>
          <div>${esc(h.message)}</div>
          ${h.timecode ? `<div class="meta">${h.timecode}</div>` : ''}
          ${stale
            ? '<div class="meta">（旧报告留档，不提供操作）</div>'
            : exempt
              ? `<div class="exempt-box">已豁免（${exempt.created_at}）：${esc(exempt.reason)}
                   <button data-revoke="${exempt.id}" class="link-btn">撤销豁免</button></div>`
              : `<div class="exempt-ops"><button data-exempt="${h.id}">填写豁免理由</button></div>`}
        </td>
      </tr>`;
  }).join('');
  return `<div class="qc-section">
    <h4>规则命中（${r.hits.length}）</h4>
    <table class="qc-table"><thead><tr>
      <th class="col-ord">片段#</th><th class="col-rule">命中规则 / 原稿来源</th><th>原因与豁免</th>
    </tr></thead><tbody>${rows}</tbody></table>
  </div>`;
}

async function runQcReport() {
  try {
    const report = await api(`/api/branches/${state.branchId}/qc/reports`, { method: 'POST' });
    qcState.report = report;
    renderQcPanel();
    toast(`质检报告已生成：${report.hit_count} 条命中`, 'ok');
  } catch (e) { toast(e.message, 'error'); }
}

async function exemptHit(hitId) {
  const reason = prompt('请填写该命中的豁免理由（仅对此分支当前片段内容、时码与规则版本有效；之后任一变化即失效）');
  if (reason === null) return;
  if (!reason.trim()) return toast('豁免理由不能为空', 'error');
  try {
    const data = await api(`/api/branches/${state.branchId}/qc/hits/${hitId}/exempt`, {
      method: 'POST', body: { reason }
    });
    qcState.report = data.report;
    renderQcPanel();
    toast('已豁免该命中', 'ok');
  } catch (e) { toast(e.message, 'error'); }
}

async function revokeExemption(eid) {
  if (!confirm('撤销该豁免？撤销后该命中将重新计入未豁免项。')) return;
  try {
    const data = await api(`/api/branches/${state.branchId}/qc/exemptions/${eid}`, {
      method: 'DELETE'
    });
    if (data.report) qcState.report = data.report;
    renderQcPanel();
    toast('已撤销豁免', 'ok');
  } catch (e) { toast(e.message, 'error'); }
}

async function qcExport() {
  try {
    const resp = await fetch(`/api/branches/${state.branchId}/qc/export`);
    if (!resp.ok) {
      const data = await resp.json();
      const lines = [data.error];
      (data.timeline_issues || []).forEach((i) =>
        lines.push(`· 时间线${i.ord ? ` #${i.ord}` : ''}：${i.message}`));
      (data.unresolved_hits || []).forEach((h) =>
        lines.push(`· 片段 #${h.ord} [${h.rule_label}]：${h.message}`));
      (data.invalid_exemptions || []).forEach((x) =>
        lines.push(`· 已失效豁免（片段 #${x.ord}）：${x.invalid_reason}`));
      if (data.report_stale) lines.push('· 报告已失效，请重新生成质检报告');
      return toast(lines.join('\n'), 'error');
    }
    const blob = await resp.blob();
    const cd = resp.headers.get('Content-Disposition') || '';
    const m = /filename\*=UTF-8''(.+)$/.exec(cd);
    const fname = m ? decodeURIComponent(m[1]) : 'qc-export.srt';
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = fname;
    a.click();
    URL.revokeObjectURL(a.href);
    toast('质检核验通过，已导出 SRT', 'ok');
  } catch (e) {
    toast(e.message, 'error');
  }
}

// ---------------- 启动 ----------------

loadScripts();
