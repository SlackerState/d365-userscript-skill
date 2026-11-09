// ==UserScript==
// @name         TODO 单据 → 动作 批量处理
// @namespace    local.d365.userscript
// @version      0.1.0
// @description  TODO 一句话说明读什么、做什么
// @match        https://*.dynamics.com/*
// @noframes
// @grant        none
// @run-at       document-idle
// ==/UserScript==

// 模板约定：搜索 TODO，替换实体、字段和规则。实体集名、字段名、选项值都要从元数据查实。
// 只读脚本：删掉 precheck 之后的写入部分和 btnApply。
(function () {
  'use strict';

  const TITLE = 'TODO 批量处理';
  const FAB_BOTTOM = 124;                 // 悬浮按钮离底部的距离，避开其他脚本的按钮
  const API = '/api/data/v9.2/';
  const SET = 'new_orders';        // TODO 实体集名
  const ENTITY = 'new_order';      // TODO 实体逻辑名
  const ID = 'new_orderid';        // TODO 主键
  const NAME = 'new_ordernumber';         // TODO 单号字段
  const STATUS = 'new_orderstatus';       // TODO 状态字段
  const STATUS_READY = 110;               // TODO 可处理的状态值
  const STATUS_TARGET = 120;              // TODO 写入后的状态值
  const SELECT = [ID, NAME, STATUS, 'statecode', '_ownerid_value'].join(',');
  const VERIFIED_KEY = 'TODO-verified';   // 这台电脑实测成功过才允许批量；低风险操作可去掉
  const CONCURRENCY = 4;
  const FMT = '@OData.Community.Display.V1.FormattedValue';

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const fmt = (o, f) => (o && o[f + FMT]) || '';

  // ---------- Web API ----------
  const HEADERS = { Accept: 'application/json', 'OData-MaxVersion': '4.0', 'OData-Version': '4.0' };

  async function request(method, path, body, extra = {}, retry = 3) {
    const res = await fetch(API + path, {
      method,
      credentials: 'include',
      headers: Object.assign({}, HEADERS, body ? { 'Content-Type': 'application/json; charset=utf-8' } : {}, extra),
      body: body ? JSON.stringify(body) : undefined,
    });
    if ((res.status === 429 || res.status === 503) && retry > 0) {
      await sleep((parseInt(res.headers.get('Retry-After'), 10) || 2) * 1000);
      return request(method, path, body, extra, retry - 1);
    }
    if (!res.ok) {
      let msg = res.status + ' ' + res.statusText;
      try {
        const j = await res.json();
        if (j.error && j.error.message) msg += '：' + j.error.message;
      } catch (e) { /* 没有 JSON 错误内容 */ }
      throw new Error(msg);
    }
    // 写接口成功时常返回空内容，不能直接 res.json()
    const text = await res.text();
    return text ? JSON.parse(text) : {};
  }
  const api = (path) => request('GET', path, null, { Prefer: 'odata.include-annotations="*"' });

  async function apiAll(path) {
    let j = await api(path);
    const out = j.value.slice();
    while (j['@odata.nextLink']) {
      j = await api(j['@odata.nextLink'].slice(j['@odata.nextLink'].indexOf(API) + API.length));
      out.push(...j.value);
    }
    return out;
  }

  async function fetchXmlAll(setName, xmlOfPage) {
    const out = [];
    for (let page = 1; ; page++) {
      const j = await api(`${setName}?fetchXml=${encodeURIComponent(xmlOfPage(page))}`);
      out.push(...j.value);
      if (!j['@Microsoft.Dynamics.CRM.morerecords']) break;
    }
    return out;
  }

  // 并发处理队列，stopped 为真时不再取新任务
  async function runPool(list, worker) {
    const queue = list.slice();
    await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
      while (queue.length && !stopped) await worker(queue.shift());
    }));
  }

  // ---------- 读取 ----------
  // TODO 过滤条件沿用系统视图的 fetchxml（savedqueries）
  const loadRecords = () => fetchXmlAll(SET, (page) =>
    `<fetch count="5000" page="${page}"><entity name="${ENTITY}">` +
    SELECT.split(',').map((a) => `<attribute name="${a.replace(/^_(.*)_value$/, '$1')}"/>`).join('') +
    '<filter type="and"><condition attribute="statecode" operator="eq" value="0"/>' +
    '<condition attribute="owningbusinessunit" operator="eq-businessid"/></filter>' +
    '</entity></fetch>');

  // ---------- 分类 ----------
  // kind：todo 可处理 / skip 跳过 / done 已完成。group 是表格里的分组标题
  function classify(r) {
    // TODO 业务规则
    if (r[STATUS] === STATUS_READY) return { kind: 'todo', group: '待处理' };
    if (r[STATUS] === STATUS_TARGET) return { kind: 'done', group: '已处理（不处理）' };
    return { kind: 'skip', group: `跳过：${fmt(r, STATUS) || '状态未知'}` };
  }

  // ---------- 预检查 ----------
  // 校验逐条对应页面按钮的逻辑：blockers 拦住，warnings 只提醒。原因写具体
  async function precheck(id) {
    const r = await api(`${SET}(${id})?$select=${SELECT}`);
    const blockers = [], warnings = [];
    if (r.statecode !== 0) blockers.push('单据已停用');
    if (r[STATUS] !== STATUS_READY) blockers.push(`状态是「${fmt(r, STATUS)}」，不能处理`);
    // TODO 其他页面校验
    return { record: r, blockers, warnings, ok: !blockers.length };
  }

  // ---------- 写入 ----------
  // 写之前重新检查，带 ETag 防止覆盖别人的修改，写完读回确认
  async function applyOne(it) {
    const id = it.record[ID];
    const chk = await precheck(id);
    it.check = chk;
    if (!chk.ok) throw new Error('重新检查不通过：' + chk.blockers.join('；'));
    await request('PATCH', `${SET}(${id})`, { [STATUS]: STATUS_TARGET }, { 'If-Match': chk.record['@odata.etag'] }); // TODO 与按钮相同的写入
    await sleep(1000);
    const after = await api(`${SET}(${id})?$select=${SELECT}`);
    if (after[STATUS] !== STATUS_TARGET) throw new Error(`写入后状态是「${fmt(after, STATUS)}」，请打开单据确认`);
    return after;
  }

  // ---------- UI ----------
  function el(tag, css, props = {}, children = []) {
    const e = document.createElement(tag);
    if (css) e.style.cssText = css;
    Object.assign(e, props);
    children.forEach((c) => e.append(c));
    return e;
  }
  const appId = () => new URLSearchParams(location.search).get('appid') || '';
  const recordUrl = (etn, id) => `/main.aspx?appid=${appId()}&pagetype=entityrecord&etn=${etn}&id=${id}`;
  const link = (text, etn, id) => el('a', 'color:#0f6cbd;', { textContent: text, href: recordUrl(etn, id), target: '_blank', title: '在新标签页打开' });

  const btnCss = 'padding:5px 12px;border:1px solid #0f6cbd;border-radius:4px;background:#0f6cbd;color:#fff;cursor:pointer;font-size:13px;';
  const btn2Css = btnCss + 'background:#fff;color:#0f6cbd;';
  const cellCss = 'padding:3px 6px;border-bottom:1px solid #eee;white-space:nowrap;vertical-align:top;';

  const fab = el('button', `position:fixed;right:20px;bottom:${FAB_BOTTOM}px;z-index:2147483646;padding:8px 14px;border:none;border-radius:20px;` +
    'background:#5c2d91;color:#fff;font-size:13px;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.3);', { textContent: TITLE });
  const btnLoad = el('button', btnCss, { textContent: '读取' });
  const btnStop = el('button', btn2Css, { textContent: '停止', disabled: true });
  const btnApply = el('button', btnCss + 'background:#c4314b;border-color:#c4314b;', { textContent: '处理所选', disabled: true });
  const btnCopy = el('button', btn2Css, { textContent: '复制表格' });
  const btnClose = el('button', 'border:none;background:none;font-size:18px;cursor:pointer;color:#666;', { textContent: '×' });
  const status = el('div', 'color:#555;font-size:12px;min-height:18px;white-space:pre-line;');

  const COLS = ['', '单号', '状态', '负责人', '检查 / 结果']; // TODO 列
  const tbody = el('tbody');
  const thead = el('thead', '', {}, [el('tr', 'background:#f3f6fa;position:sticky;top:0;z-index:1;', {},
    COLS.map((t) => el('th', cellCss + 'text-align:left;', { textContent: t })))]);
  const tableBox = el('div', 'flex:1;min-height:80px;overflow:auto;border:1px solid #eee;border-radius:4px;', {},
    [el('table', 'border-collapse:collapse;width:100%;font-size:12px;', {}, [thead, tbody])]);
  const panel = el('div', `position:fixed;right:20px;bottom:${FAB_BOTTOM + 44}px;width:1100px;max-width:calc(100vw - 40px);height:70vh;display:none;` +
    'flex-direction:column;gap:8px;z-index:2147483647;background:#fff;border:1px solid #ccc;border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.25);' +
    'padding:12px;box-sizing:border-box;font:13px/1.5 "Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;color:#222;', {}, [
    el('div', 'display:flex;justify-content:space-between;align-items:center;', {}, [el('b', 'font-size:14px;', { textContent: TITLE }), btnClose]),
    el('div', 'display:flex;gap:6px;flex-wrap:wrap;align-items:center;', {}, [btnLoad, btnStop, btnApply, btnCopy]),
    status, tableBox,
  ]);
  document.body.append(fab, panel);
  fab.onclick = () => { panel.style.display = panel.style.display === 'none' ? 'flex' : 'none'; };
  btnClose.onclick = () => { panel.style.display = 'none'; };

  // ---------- 状态与渲染 ----------
  let items = [];   // { record, kind, group, check, result, error, checked, tr }
  let stopped = false, busy = false;
  const collapsed = new Set(['已处理（不处理）']);
  const canApply = (it) => it.kind === 'todo' && it.check && it.check.ok;
  const groupOrder = (g) => (g.startsWith('待') ? 0 : g.startsWith('跳过') ? 1 : 2);

  function checkText(it) {
    if (it.result) return it.result;
    if (it.kind !== 'todo') return '';
    const c = it.check;
    if (!c) return '检查中…';
    return (c.ok ? '可处理' : c.blockers.join('\n')) + (c.warnings.length ? '\n提醒：' + c.warnings.join('；') : '');
  }
  function checkColor(it) {
    if (it.result) return it.error ? '#c00' : '#107c10';
    if (it.kind !== 'todo') return '#888';
    return !it.check ? '#888' : !it.check.ok ? '#c4314b' : it.check.warnings.length ? '#b26a00' : '#107c10';
  }
  function rowCells(it) {
    const r = it.record;
    const cb = el('input', '', { type: 'checkbox', checked: !!it.checked, disabled: busy || !canApply(it) });
    cb.onchange = () => { it.checked = cb.checked; refreshButtons(); };
    return [
      el('td', cellCss, {}, [cb]),
      el('td', cellCss, {}, [link(r[NAME] || '', ENTITY, r[ID])]),
      el('td', cellCss, { textContent: fmt(r, STATUS) }),
      el('td', cellCss, { textContent: fmt(r, '_ownerid_value') }),
      el('td', cellCss + `color:${checkColor(it)};white-space:pre-line;min-width:240px;`, { textContent: checkText(it) }),
    ];
  }
  function updateRow(it) {
    if (!it.tr) return;
    it.tr.textContent = '';
    rowCells(it).forEach((td) => it.tr.append(td));
  }
  function render() {
    tbody.textContent = '';
    const groups = new Map();
    items.forEach((it) => (groups.get(it.group) || groups.set(it.group, []).get(it.group)).push(it));
    [...groups.keys()].sort((a, b) => groupOrder(a) - groupOrder(b) || groups.get(b).length - groups.get(a).length).forEach((g) => {
      const list = groups.get(g);
      const sel = list.filter(canApply);
      const isCollapsed = collapsed.has(g);
      const gcb = el('input', 'margin-right:6px;', { type: 'checkbox', disabled: busy || !sel.length, title: '勾选 / 取消本类全部' });
      gcb.checked = sel.length > 0 && sel.every((it) => it.checked);
      gcb.onclick = (e) => e.stopPropagation();
      gcb.onchange = () => { sel.forEach((it) => { it.checked = gcb.checked; }); render(); };
      const head = el('td', 'padding:6px;background:#eef2f8;font-weight:bold;cursor:pointer;', { colSpan: COLS.length },
        [gcb, document.createTextNode(`${isCollapsed ? '▸' : '▾'} ${g}（${list.length}）`)]);
      head.onclick = () => { if (isCollapsed) collapsed.delete(g); else collapsed.add(g); render(); };
      tbody.append(el('tr', '', {}, [head]));
      if (isCollapsed) { list.forEach((it) => { it.tr = null; }); return; }
      list.forEach((it) => {
        it.tr = el('tr');
        rowCells(it).forEach((td) => it.tr.append(td));
        tbody.append(it.tr);
      });
    });
    refreshButtons();
  }
  function refreshButtons() {
    const n = items.filter((it) => it.checked && canApply(it)).length;
    btnApply.textContent = `处理所选${n ? `（${n}）` : ''}`;
    btnApply.disabled = busy || !n;
    btnLoad.disabled = busy;
    btnStop.disabled = !busy;
  }
  function setBusy(b) {
    busy = b;
    if (b) stopped = false;
    render();
  }

  // ---------- 按钮 ----------
  btnStop.onclick = () => { stopped = true; status.textContent += '\n正在停止，当前这张处理完就停…'; };

  btnLoad.onclick = async () => {
    setBusy(true);
    items = [];
    render();
    try {
      status.textContent = '正在读取…';
      const records = await loadRecords();
      items = records.map((record) => Object.assign({ record, checked: false }, classify(record)));
      render();
      const toCheck = items.filter((it) => it.kind === 'todo');
      status.textContent = `读到 ${items.length} 张，正在检查 ${toCheck.length} 张…`;
      await runPool(toCheck, async (it) => {
        try {
          it.check = await precheck(it.record[ID]);
          it.record = it.check.record;
        } catch (e) {
          it.check = { ok: false, blockers: ['检查出错：' + e.message], warnings: [] };
        }
        updateRow(it);
      });
      status.textContent = `读到 ${items.length} 张：可处理 ${items.filter(canApply).length}，跳过 ${items.filter((it) => it.kind === 'skip').length}，已处理 ${items.filter((it) => it.kind === 'done').length}。`;
    } catch (e) {
      status.textContent = '读取失败：' + e.message;
    } finally {
      setBusy(false);
    }
  };

  btnApply.onclick = async () => {
    let list = items.filter((it) => it.checked && canApply(it));
    if (!list.length) return;
    let verified = false;
    try { verified = !!localStorage.getItem(VERIFIED_KEY); } catch (e) { /* 读不到按没验证过 */ }
    const total = list.length;
    if (!verified) list = list.slice(0, 1);
    const msg = `将处理下面 ${list.length} 张（TODO 写清楚会发生什么）：\n\n` +
      list.slice(0, 30).map((it) => `${it.record[NAME]}  ${fmt(it.record, STATUS)}` + (it.check.warnings.length ? `  ⚠ ${it.check.warnings.join('；')}` : '')).join('\n') +
      (list.length > 30 ? `\n…… 共 ${list.length} 张` : '') +
      (!verified ? `\n\n这台电脑第一次使用，这次只处理第 1 张（共勾选 ${total} 张）。成功并打开核对后，再次点击才能批量。` : '') +
      '\n\n确定处理？';
    if (!window.confirm(msg)) return;

    setBusy(true);
    let done = 0, ok = 0, failed = 0;
    const report = () => { status.textContent = `进度 ${done} / ${list.length}：成功 ${ok}${failed ? `，失败 ${failed}` : ''}${stopped ? '（已停止）' : ''}`; };
    report();
    for (const it of list) {
      if (stopped) break;
      it.result = '处理中…';
      it.error = false;
      updateRow(it);
      try {
        it.record = await applyOne(it);
        it.kind = 'done';
        it.checked = false;
        it.result = `已处理：${fmt(it.record, STATUS)}`;
        ok++;
        try { localStorage.setItem(VERIFIED_KEY, '1'); } catch (e) { /* 存不了下次还是只处理一张 */ }
      } catch (e) {
        failed++;
        it.result = '失败：' + e.message;
        it.error = true;
        stopped = true; // 出错就停，先人工看原因
      }
      updateRow(it);
      done++;
      report();
    }
    setBusy(false);
    status.textContent = `完成：成功 ${ok}${failed ? `，失败 ${failed}（看「检查 / 结果」列，出错会自动停下）` : ''}` +
      `${done < list.length ? `，剩下 ${list.length - done} 张没有处理` : ''}。`;
  };

  btnCopy.onclick = async () => {
    if (!items.length) return;
    const text = [COLS.slice(1).join('\t')].concat(items.map((it) => [it.record[NAME], fmt(it.record, STATUS), fmt(it.record, '_ownerid_value'), checkText(it).replace(/\n/g, '；')]
      .map((v) => String(v ?? '').replace(/\t/g, ' ')).join('\t'))).join('\n');
    try {
      await navigator.clipboard.writeText(text);
    } catch (e) {
      const t = el('textarea', 'position:fixed;left:-9999px;', { value: text });
      document.body.append(t);
      t.select();
      document.execCommand('copy');
      t.remove();
    }
    status.textContent = `已复制 ${items.length} 行，可直接粘到 Excel`;
  };
})();
