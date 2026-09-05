const $ = (selector) => document.querySelector(selector);
const nf = new Intl.NumberFormat('ko-KR');
const dtf = new Intl.DateTimeFormat('ko-KR', { dateStyle: 'short', timeStyle: 'medium' });

function number(value) {
  return Number.isFinite(Number(value)) ? nf.format(Number(value)) : '—';
}

function percent(value) {
  if (!Number.isFinite(Number(value))) return '—';
  return `${(Number(value) * 100).toFixed(1)}%`;
}

function date(value) {
  if (!Number.isFinite(Number(value)) || Number(value) <= 0) return '—';
  return dtf.format(new Date(Number(value)));
}

function statusTone(status) {
  const value = String(status ?? '').toLowerCase();
  if (['complete', 'success', 'collecting', 'ready'].includes(value)) return 'good';
  if (['attention', 'partial_failure', 'blocked_data'].includes(value)) return 'warn';
  if (['failed', 'safety_block'].includes(value)) return 'bad';
  return 'neutral';
}

function setPill(element, label, tone) {
  element.textContent = label;
  element.className = `pill ${tone}`;
}

function renderCycles(cycles = []) {
  const target = $('#cycle-list');
  target.replaceChildren();
  for (const cycle of cycles) {
    const row = document.createElement('div');
    row.className = 'cycle-row';
    const title = document.createElement('div');
    const name = document.createElement('strong');
    name.textContent = cycle.profile;
    const meta = document.createElement('span');
    meta.textContent = cycle.present ? `${date(cycle.generatedAt)} · 동시실행 ${cycle.concurrency || 0}` : '아직 실행 기록 없음';
    title.append(name, meta);

    const stats = document.createElement('div');
    stats.className = 'cycle-stats';
    const status = document.createElement('span');
    status.className = `pill ${statusTone(cycle.status)}`;
    status.textContent = cycle.status;
    const counts = document.createElement('span');
    counts.textContent = `${cycle.successCount || 0} 성공 · ${cycle.blockedDataCount || 0} 데이터차단 · ${cycle.failedCount || 0} 실패`;
    stats.append(status, counts);
    row.append(title, stats);
    target.append(row);
  }
}

function renderPaper(paper) {
  const runtime = paper?.runtime ?? {};
  const ledger = paper?.ledger ?? {};
  $('#paper-settled').textContent = number(ledger.settlementCount);
  $('#paper-positions').textContent = number(ledger.positionCount);
  $('#paper-cycles').textContent = number(ledger.cycleCount);
  $('#paper-settlements').textContent = number(ledger.settlementCount);
  $('#paper-schedule').textContent = runtime.scheduleActive ? 'ACTIVE' : 'INACTIVE';
  $('#paper-providers').textContent = runtime.allProvidersReady ? 'READY' : 'CHECK';
  setPill($('#paper-status'), runtime.status || 'not_started', statusTone(runtime.status));

  const lanes = $('#paper-lanes');
  lanes.replaceChildren();
  for (const lane of runtime.lanes ?? []) {
    const chip = document.createElement('span');
    chip.className = `chip ${statusTone(lane.status)}`;
    chip.textContent = `${lane.market}: ${lane.status}`;
    lanes.append(chip);
  }
}

function renderShadow(shadow) {
  const records = shadow?.records ?? {};
  $('#shadow-settled').textContent = number(records.settledRecords);
  $('#shadow-total').textContent = `전체 ${number(records.totalRecords)} · Settled ${number(records.settledRecords)} · Pending ${number(records.pendingRecords)}`;

  const body = $('#shadow-table');
  const empty = $('#shadow-empty');
  body.replaceChildren();
  const groups = shadow?.groups ?? [];
  empty.hidden = groups.length > 0;
  $('#shadow-table-wrap').hidden = groups.length === 0;
  for (const group of groups) {
    const tr = document.createElement('tr');
    const cells = [
      group.name,
      number(group.total),
      number(group.settled),
      number(group.pending),
      percent(group.macroF1),
      percent(group.balancedAccuracy),
      group.collapsed === null ? '—' : group.collapsed ? 'YES' : 'NO',
    ];
    for (const value of cells) {
      const td = document.createElement('td');
      td.textContent = value;
      tr.append(td);
    }
    body.append(tr);
  }
}

function render(data) {
  const safety = data.safety ?? {};
  const systemTone = safety.forbiddenAuthorityObserved ? 'bad' : statusTone(data.research?.status);
  const systemLabel = safety.forbiddenAuthorityObserved ? 'SAFETY BLOCK' : String(data.research?.status ?? 'unknown').toUpperCase();
  setPill($('#system-pill'), systemLabel, systemTone);
  $('#live-trading').textContent = safety.liveTrading ? 'ON' : 'OFF';
  $('#private-api').textContent = safety.privateApi ? 'ON' : 'OFF';
  $('#order-authority').textContent = safety.orderAuthority ? 'ON' : 'OFF';
  $('#failed-tasks').textContent = number(data.research?.failedTasks);
  $('#last-cycle').textContent = `최근 ${date(data.state?.latestCycleAt)}`;
  $('#updated-at').textContent = `업데이트 ${date(data.generatedAt)}`;
  $('#profitability-state').textContent = data.profitability?.proven ? 'PROVEN' : 'EVIDENCE COLLECTION';
  renderCycles(data.research?.cycles);
  renderPaper(data.paper);
  renderShadow(data.shadow);
}

async function refresh() {
  const button = $('#refresh-button');
  button.disabled = true;
  button.textContent = '갱신 중';
  try {
    const response = await fetch('/api/research/overview', { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    render(await response.json());
  } catch (error) {
    setPill($('#system-pill'), '연결 오류', 'bad');
    $('#updated-at').textContent = `오류 ${String(error?.message ?? error)}`;
  } finally {
    button.disabled = false;
    button.textContent = '새로고침';
  }
}

$('#refresh-button').addEventListener('click', refresh);
refresh();
setInterval(refresh, 30_000);

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}
