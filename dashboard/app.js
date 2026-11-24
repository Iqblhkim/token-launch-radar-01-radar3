'use strict';
/* Token Radar radar-3 dashboard. Renders window.RADAR = {radar, rows}. No network.
   Every number is recomputed from the board rows or read from the radar summary,
   so the page and board.json agree. */
var R = window.RADAR || null;
var radar = R ? R.radar : null;
var rows = R ? R.rows.slice() : [];

function $(s, el) { return (el || document).querySelector(s); }
function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
function money(v) {
  if (v >= 1e9) return '$' + (v / 1e9).toFixed(2) + 'B';
  if (v >= 1e6) return '$' + (v / 1e6).toFixed(1) + 'M';
  if (v >= 1e3) return '$' + (v / 1e3).toFixed(1) + 'K';
  return '$' + Math.round(v);
}
function signed(v) { return (v < 0 ? '-$' : '$') + Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: 0 }); }
function signed2(v) { return (v < 0 ? '-$' : '$') + Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: 2 }); }
function pct1(x) { return (x * 100).toFixed(1) + '%'; }
function miss(x) { return 'x' + x.toFixed(3); }

/* FNV-1a over "rank|slug|implied_value_usd", the same checksum main.ts writes. */
function fnv(rs) {
  var h = 2166136261 >>> 0;
  for (var i = 0; i < rs.length; i++) {
    var s = rs[i].rank + '|' + rs[i].slug + '|' + rs[i].implied_value_usd;
    for (var j = 0; j < s.length; j++) { h ^= s.charCodeAt(j); h = Math.imul(h, 16777619) >>> 0; }
  }
  return h.toString(16).padStart(8, '0');
}

/* Farm economics, the same farmMath as lib/model.ts, run here on the reader's assumptions.
   The airdrop pool is split among active farmers; the farmer count grows with the
   square root of TVL (2500 per sqrt of TVL in $M), and a farmer's weight scales
   with deposit relative to the $1,000 reference. */
function farmFor(row, a) {
  var txs = 6 + a.horizon_weeks;
  var gasCost = txs * row.farm.gas_usd;
  var carry = a.deposit_usd * a.apy * a.horizon_weeks / 52;
  var farmers = 2500 * Math.sqrt(Math.max(1, row.tvl_usd / 1e6));
  var reward = row.token_odds * row.implied_value_usd * a.airdrop_share / farmers * (a.deposit_usd / 1000);
  var net = reward - gasCost - carry;
  var hours = (20 + 10 * a.horizon_weeks + 15) / 60;
  var verdict = net >= Math.max(25, 0.03 * a.deposit_usd) ? 'FARM' : net > 0 ? 'MARGINAL' : 'SKIP';
  return { gas_cost: gasCost, carry: carry, reward: reward, net: net, hours: hours, net_per_hour: net / hours, verdict: verdict };
}

/* ---- state ---- */
var A = radar ? { deposit_usd: radar.assumptions.deposit_usd, horizon_weeks: radar.assumptions.horizon_weeks, airdrop_share: radar.assumptions.airdrop_share, apy: radar.assumptions.apy } : { deposit_usd: 1000, horizon_weeks: 12, airdrop_share: 0.1, apy: 0.045 };
var F = { q: '', cat: '', chain: '', verdict: '', watch: '' };
var sortKey = 'rank';
var sortDir = 1;
var farmCache = {}; /* slug -> farm at current assumptions */

function atDefault() {
  return radar && A.deposit_usd === radar.assumptions.deposit_usd && A.horizon_weeks === radar.assumptions.horizon_weeks && A.airdrop_share === radar.assumptions.airdrop_share && A.apy === radar.assumptions.apy;
}

function recomputeFarm() {
  farmCache = {};
  if (atDefault()) {
    /* At the stated assumptions the board's stored farm values are the model's exact
       output; use them verbatim so the page and board.json agree to the row.
       (Recomputing from the rounded values stored in data.js would flip the one
       row whose net sits exactly on the FARM threshold.) */
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var gasCost = (6 + A.horizon_weeks) * r.farm.gas_usd;
      farmCache[r.slug] = { gas_cost: gasCost, carry: r.farm.cost_usd - gasCost, reward: r.farm.reward_usd, net: r.farm.net_usd, hours: (20 + 10 * A.horizon_weeks + 15) / 60, net_per_hour: r.farm.net_per_hour, verdict: r.farm.verdict };
    }
    return;
  }
  for (var i = 0; i < rows.length; i++) farmCache[rows[i].slug] = farmFor(rows[i], A);
}
function verdictCounts() {
  var c = { FARM: 0, MARGINAL: 0, SKIP: 0 };
  for (var i = 0; i < rows.length; i++) c[farmCache[rows[i].slug].verdict]++;
  return c;
}

/* ---- header ---- */
function renderHead() {
  $('#asof').textContent = radar.as_of;
}

/* ---- KPI strip: six cards ---- */
function kpi(label, big, sub) {
  return '<div class="kpi"><div class="k-label">' + label + '</div><div class="k-big">' + big + '</div><div class="k-sub">' + sub + '</div></div>';
}
function renderKpis() {
  var vc = verdictCounts();
  var kept = radar.terms.filter(function (t) { return t.verdict === 'kept'; }).length;
  var tried = radar.terms.length - 1; /* minus the baseline row */
  var html = '';
  html += kpi('Out-of-sample miss', 'LOO ' + miss(radar.miss.loo) + ' &middot; WF ' + miss(radar.miss.wf),
    'Baseline one fixed multiple: LOO ' + miss(radar.miss.baseline_loo) + ' &middot; WF ' + miss(radar.miss.baseline_wf));
  html += kpi('Is the printed range honest?', 'P25&ndash;P75 ' + radar.coverage.p25_p75.toFixed(3) + ' &middot; P10&ndash;P90 ' + radar.coverage.p10_p90.toFixed(3),
    'Should be &asymp;0.50 and &asymp;0.80 if the range is honest');
  html += kpi('Token odds vs base rate', 'Brier ' + radar.odds.rows.filter(function (r) { return r.verdict === 'kept'; })[0].loo_brier.toFixed(4) + ' vs ' + radar.odds.rows[0].loo_brier.toFixed(4),
    radar.odds.n + ' peers &middot; base rate ' + radar.odds.base_rate.toFixed(3) + ' &middot; model &ldquo;' + esc(radar.odds.chosen) + '&rdquo;');
  html += kpi('Terms that survived both tests', kept + ' of ' + tried,
    'Only <b>ln(TVL)</b> kept; growth, age, chains, category tested, not kept');
  html += '<div class="kpi"><div class="k-label">Worth farming, at stated assumptions</div><div class="k-big" id="kpi-farm">FARM ' + vc.FARM + ' &middot; MARG ' + vc.MARGINAL + ' &middot; SKIP ' + vc.SKIP + '</div><div class="k-sub">of ' + rows.length + ' ranked &middot; deposit $' + A.deposit_usd.toLocaleString('en-US') + ', ' + A.horizon_weeks + ' weeks</div></div>';
  html += kpi('Watchlist ranked', radar.watchlist_size + ' / ' + radar.watchlist_size,
    'Every watchlist protocol is on the board; the board holds ' + rows.length + ' rows');
  $('#kpis').innerHTML = html;
}

/* ---- integrity strip: recomputed from the rows, live ---- */
function renderIntegrity() {
  var n = rows.length;
  var inOrder = true, neverRise = true;
  for (var i = 0; i < n; i++) {
    if (rows[i].rank !== i + 1) inOrder = false;
    if (i > 0 && rows[i].implied_value_usd > rows[i - 1].implied_value_usd) neverRise = false;
  }
  var total = 0;
  for (var j = 0; j < n; j++) total += rows[j].implied_value_usd;
  var wl = 0;
  for (var k = 0; k < n; k++) if (rows[k].on_watchlist) wl++;
  var check = fnv(rows);
  var ledger = radar.accounting.ranked + radar.accounting.trades + radar.accounting.token_no_mcap + radar.accounting.set_aside;
  function mark(ok) { return ok ? '<span class="ok">&#10003;</span>' : '<span class="bad">&#10007;</span>'; }
  $('#integrity').innerHTML = '<b>Integrity — recomputed here from board.json:</b> ' +
    mark(n === rows.length) + ' this table = board.json: ' + n + ' of ' + n + ' rows recomputed here &nbsp;' +
    mark(inOrder) + ' ranks 1&ndash;' + n + ' in order &nbsp;' +
    mark(neverRise) + ' values never rise &nbsp;' +
    mark(total === radar.total_implied_usd) + ' totals equal: ' + money(total) + ' &nbsp;' +
    mark(check === radar.checksum) + ' checksum ' + check + ' = main.ts &nbsp;' +
    mark(wl === radar.watchlist_size) + ' watchlist ' + wl + ' of ' + radar.watchlist_size + ' ranked &nbsp;' +
    mark(ledger === radar.accounting.total) + ' ledger ' + ledger + ' of ' + radar.accounting.total + ' protocols';
}

/* ---- evidence: three tables ---- */
function tag(v) {
  if (v === 'kept') return '<span class="tag kept">kept</span>';
  if (v === 'baseline') return '<span class="tag base">baseline</span>';
  return '<span class="tag tested">tested, not kept</span>';
}
function renderEvidence() {
  var h = '<h2>Out-of-sample evidence</h2><div class="evidence">';
  /* (a) value miss per term */
  var shortTerm = { 'one fixed multiple of TVL': 'fixed multiple', 'TVL, fitted exponent': 'TVL fitted' };
  h += '<div class="ev"><h3>Value if a token launches</h3><p class="note">Median miss of ln(market cap), held out. A term is kept only if it lowers the miss on both tests.</p><table class="mini"><thead><tr><th>Term</th><th class="num">LOO</th><th class="num">WF</th><th></th></tr></thead><tbody>';
  for (var i = 0; i < radar.terms.length; i++) {
    var t = radar.terms[i];
    h += '<tr><td>' + esc(shortTerm[t.term] || t.term) + '</td><td class="num">' + miss(t.loo) + '</td><td class="num">' + miss(t.wf) + '</td><td>' + tag(t.verdict) + '</td></tr>';
  }
  h += '</tbody></table></div>';
  /* (b) token odds Brier */
  h += '<div class="ev"><h3>Token odds, Brier score</h3><p class="note">Lower is better. Odds from the peers&rsquo; record: ' + radar.odds.n + ' peers, ' + Math.round(radar.odds.base_rate * radar.odds.n) + ' already record a token.</p><table class="mini"><thead><tr><th>Model</th><th class="num">LOO</th><th class="num">WF</th><th></th></tr></thead><tbody>';
  for (var j = 0; j < radar.odds.rows.length; j++) {
    var o = radar.odds.rows[j];
    h += '<tr><td>' + esc(o.model) + '</td><td class="num">' + o.loo_brier.toFixed(4) + '</td><td class="num">' + o.wf_brier.toFixed(4) + '</td><td>' + tag(o.verdict) + '</td></tr>';
  }
  h += '</tbody></table></div>';
  /* (c) interval honesty */
  h += '<div class="ev"><h3>Is the printed range honest?</h3><p class="note">Share of held-out residuals inside the printed interval. An honest range covers about what it claims.</p><table class="mini"><thead><tr><th>Interval</th><th class="num">Observed</th><th class="num">Should be</th></tr></thead><tbody>' +
    '<tr><td>P25&ndash;P75</td><td class="num">' + radar.coverage.p25_p75.toFixed(3) + '</td><td class="num">&asymp;0.50</td></tr>' +
    '<tr><td>P10&ndash;P90</td><td class="num">' + radar.coverage.p10_p90.toFixed(3) + '</td><td class="num">&asymp;0.80</td></tr>' +
    '</tbody></table><p class="note" style="margin-top:8px">Coefficients: intercept ' + radar.coefficients.intercept + ', ln(TVL) ' + radar.coefficients.ln_tvl + '. Fitted on ' + radar.n_fit + ' traded protocols.</p></div>';
  h += '</div>';
  $('#evidence').innerHTML = h;
}

/* ---- accounting ---- */
function renderAccounting() {
  var a = radar.accounting;
  var total = a.total;
  function w(n) { return (n / total * 100).toFixed(1) + '%'; }
  var reasons = Object.keys(radar.set_aside).map(function (k) { return esc(k) + ' ' + radar.set_aside[k]; }).join(' &middot; ');
  $('#accounting').innerHTML = '<h2>Protocol accounting</h2>' +
    '<div class="bar"><span class="seg-ranked" style="width:' + w(a.ranked) + '"></span><span class="seg-trades" style="width:' + w(a.trades) + '"></span><span class="seg-noncap" style="width:' + w(a.token_no_mcap) + '"></span><span class="seg-aside" style="width:' + w(a.set_aside) + '"></span></div>' +
    '<div class="legend">' +
    '<span><span class="swatch" style="background:var(--accent)"></span><b>' + a.ranked + '</b> ranked pre-token</span>' +
    '<span><span class="swatch" style="background:#7fae9c"></span><b>' + a.trades + '</b> token already trades</span>' +
    '<span><span class="swatch" style="background:#c3d2c9"></span><b>' + a.token_no_mcap + '</b> token, no market cap</span>' +
    '<span><span class="swatch" style="background:#e3e8e4"></span><b>' + a.set_aside + '</b> set aside</span>' +
    '<span><b>' + total + '</b> protocols in exactly one group</span></div>' +
    '<p class="reasons">Set aside: ' + reasons + '. A wrapped or staked product of a token that already trades is not a protocol still waiting on a launch of its own.</p>';
}

/* ---- assumptions ---- */
function renderAssumptions() {
  $('#assumptions').innerHTML = '<h2>Farm assumptions — change them and the verdicts move</h2>' +
    '<div class="controls">' +
    '<div><label for="in-deposit">Deposit (USD)</label><input id="in-deposit" type="number" min="10" step="10" value="' + A.deposit_usd + '"></div>' +
    '<div><label for="in-horizon">Horizon (weeks)</label><input id="in-horizon" type="number" min="1" max="52" step="1" value="' + A.horizon_weeks + '"></div>' +
    '<div><label for="in-share">Airdrop share</label><input id="in-share" type="number" min="0.01" max="1" step="0.01" value="' + A.airdrop_share + '"></div>' +
    '<div><label for="in-apy">APY (lost interest)</label><input id="in-apy" type="number" min="0" max="1" step="0.005" value="' + A.apy + '"></div>' +
    '</div>' +
    '<p class="assump-note">Stated assumptions: deposit <b>$<span id="assump-deposit">' + A.deposit_usd.toLocaleString('en-US') + '</span></b> on the cheapest chain, horizon <b><span id="assump-horizon">' + A.horizon_weeks + '</span> weeks</b>, airdrop share <b><span id="assump-share">' + A.airdrop_share + '</span></b> of the implied value, lost interest <b><span id="assump-apy">' + (A.apy * 100).toFixed(1) + '%</span></b> a year. Reward: the airdrop pool (odds &times; implied value &times; share) is split among active farmers &mdash; the farmer count grows with the square root of TVL, 2500 farmers per sqrt of TVL in $M &mdash; and a farmer&rsquo;s weight scales with deposit relative to the $1,000 reference; cost = gas for ' +
    '(6 + horizon) transactions + lost interest. Verdict <b>FARM</b> when net &ge; max($25, 3% of deposit), <b>MARGINAL</b> when net &gt; 0, else <b>SKIP</b>.</p>';
  $('#in-deposit').addEventListener('input', onAssump);
  $('#in-horizon').addEventListener('input', onAssump);
  $('#in-share').addEventListener('input', onAssump);
  $('#in-apy').addEventListener('input', onAssump);
}
function onAssump() {
  var d = parseFloat($('#in-deposit').value), h = parseFloat($('#in-horizon').value),
      s = parseFloat($('#in-share').value), y = parseFloat($('#in-apy').value);
  if (isFinite(d) && d > 0) A.deposit_usd = d;
  if (isFinite(h) && h >= 1 && h <= 52) A.horizon_weeks = Math.round(h);
  if (isFinite(s) && s > 0 && s <= 1) A.airdrop_share = s;
  if (isFinite(y) && y >= 0 && y <= 1) A.apy = y;
  $('#assump-deposit').textContent = A.deposit_usd.toLocaleString('en-US');
  $('#assump-horizon').textContent = String(A.horizon_weeks);
  $('#assump-share').textContent = String(A.airdrop_share);
  $('#assump-apy').textContent = (A.apy * 100).toFixed(1) + '%';
  recomputeFarm();
  renderKpis();
  renderTable();
}

/* ---- filters ---- */
function uniq(list) { var seen = {}, out = []; for (var i = 0; i < list.length; i++) if (!seen[list[i]]) { seen[list[i]] = 1; out.push(list[i]); } return out.sort(); }
function renderFilters() {
  var cats = uniq(rows.map(function (r) { return r.category || '—'; }));
  var chains = uniq(rows.reduce(function (acc, r) { return acc.concat(r.chains); }, []));
  var vc = verdictCounts();
  $('#filters').innerHTML =
    '<input type="search" id="f-q" placeholder="Search name or slug&hellip;" value="' + esc(F.q) + '" aria-label="Search">' +
    '<select id="f-cat" aria-label="Category"><option value="">All categories</option>' + cats.map(function (c) { return '<option value="' + esc(c) + '"' + (F.cat === c ? ' selected' : '') + '>' + esc(c) + '</option>'; }).join('') + '</select>' +
    '<select id="f-chain" aria-label="Chain"><option value="">All chains</option>' + chains.map(function (c) { return '<option value="' + esc(c) + '"' + (F.chain === c ? ' selected' : '') + '>' + esc(c) + '</option>'; }).join('') + '</select>' +
    '<select id="f-verdict" aria-label="Verdict"><option value="">All verdicts</option>' +
    '<option value="FARM"' + (F.verdict === 'FARM' ? ' selected' : '') + '>FARM (' + vc.FARM + ')</option>' +
    '<option value="MARGINAL"' + (F.verdict === 'MARGINAL' ? ' selected' : '') + '>MARGINAL (' + vc.MARGINAL + ')</option>' +
    '<option value="SKIP"' + (F.verdict === 'SKIP' ? ' selected' : '') + '>SKIP (' + vc.SKIP + ')</option></select>' +
    '<select id="f-watch" aria-label="Watchlist"><option value="">All rows</option><option value="w"' + (F.watch === 'w' ? ' selected' : '') + '>Watchlist only</option><option value="o"' + (F.watch === 'o' ? ' selected' : '') + '>Off-list only</option></select>' +
    '<span class="vcount" id="vcount"></span>';
  $('#f-q').addEventListener('input', function (e) { F.q = e.target.value; renderTable(); });
  $('#f-cat').addEventListener('change', function (e) { F.cat = e.target.value; renderTable(); });
  $('#f-chain').addEventListener('change', function (e) { F.chain = e.target.value; renderTable(); });
  $('#f-verdict').addEventListener('change', function (e) { F.verdict = e.target.value; renderTable(); });
  $('#f-watch').addEventListener('change', function (e) { F.watch = e.target.value; renderTable(); });
}

/* ---- table ---- */
var COLS = [
  { key: 'rank', label: '#', cls: 'num' },
  { key: 'name', label: 'Protocol', cls: '' },
  { key: 'tvl_usd', label: 'TVL', cls: 'num' },
  { key: 'change_7d', label: '7D', cls: 'num' },
  { key: 'age_days', label: 'Age', cls: 'num' },
  { key: 'token_odds', label: 'Token odds', cls: 'num' },
  { key: 'implied_value_usd', label: 'Implied value', cls: 'num' },
  { key: 'net', label: 'Verdict · Net of fees', cls: 'num' }
];
function valOf(r, key) {
  if (key === 'net') return farmCache[r.slug].net;
  if (key === 'name') return r.name.toLowerCase();
  if (key === 'age_days') return r.age_days === null ? -1 : r.age_days;
  if (key === 'change_7d') return r.change_7d === null ? -999 : r.change_7d;
  return r[key];
}
function filtered() {
  var q = F.q.trim().toLowerCase();
  var out = rows.filter(function (r) {
    if (q && r.name.toLowerCase().indexOf(q) < 0 && r.slug.toLowerCase().indexOf(q) < 0) return false;
    if (F.cat && (r.category || '—') !== F.cat) return false;
    if (F.chain && r.chains.indexOf(F.chain) < 0) return false;
    if (F.verdict && farmCache[r.slug].verdict !== F.verdict) return false;
    if (F.watch === 'w' && !r.on_watchlist) return false;
    if (F.watch === 'o' && r.on_watchlist) return false;
    return true;
  });
  out.sort(function (a, b) {
    var va = valOf(a, sortKey), vb = valOf(b, sortKey);
    if (va < vb) return -1 * sortDir;
    if (va > vb) return 1 * sortDir;
    return (a.rank - b.rank) * 1;
  });
  return out;
}
function renderTable() {
  var h = '';
  for (var i = 0; i < COLS.length; i++) {
    var c = COLS[i];
    var arrow = sortKey === c.key ? (sortDir === 1 ? ' ▲' : ' ▼') : '';
    h += '<th data-key="' + c.key + '" class="' + c.cls + '">' + c.label + (arrow ? '<span class="arrow">' + arrow + '</span>' : '') + '</th>';
  }
  $('#thead').innerHTML = '<tr>' + h + '</tr>';
  var list = filtered();
  var b = '';
  for (var j = 0; j < list.length; j++) {
    var r = list[j], f = farmCache[r.slug];
    var terms = Object.keys(r.model.terms).map(function (k) { return k + ' ' + (r.model.terms[k] >= 0 ? '+' : '') + r.model.terms[k]; }).join(', ');
    var age = r.age_days === null ? '&mdash;' : r.age_days + 'd';
    var chg = r.change_7d === null ? '&mdash;' : (r.change_7d >= 0 ? '+' : '') + r.change_7d.toFixed(1) + '%';
    b += '<tr data-slug="' + esc(r.slug) + '" title="ln(value) = ' + r.model.predicted_ln + ' from ' + esc(terms) + '">' +
      '<td class="num">' + r.rank + '</td>' +
      '<td><span class="name">' + esc(r.name) + '</span><span class="badge ' + (r.on_watchlist ? 'w' : 'off') + '">' + (r.on_watchlist ? 'W' : 'off-list') + '</span><div class="slug">' + esc(r.slug) + ' &middot; ' + esc(r.category || '—') + '</div></td>' +
      '<td class="num">' + money(r.tvl_usd) + '</td>' +
      '<td class="num">' + chg + '</td>' +
      '<td class="num">' + age + '</td>' +
      '<td class="num">' + pct1(r.token_odds) + '</td>' +
      '<td class="num"><b>' + money(r.implied_value_usd) + '</b><div class="range">' + money(r.implied_low_usd) + ' &ndash; ' + money(r.implied_high_usd) + '</div></td>' +
      '<td class="num"><span class="verdict ' + f.verdict + '">' + f.verdict + '</span><div class="net ' + (f.net >= 0 ? 'pos' : 'neg') + '">' + signed(f.net) + '</div><div class="perhour">' + signed2(f.net_per_hour) + '/h</div></td>' +
      '</tr>';
  }
  $('#tbody').innerHTML = b;
  var vc = verdictCounts();
  $('#vcount').innerHTML = 'FARM <b>' + vc.FARM + '</b> &middot; MARGINAL <b>' + vc.MARGINAL + '</b> &middot; SKIP <b>' + vc.SKIP + '</b>';
  $('#count').textContent = 'Showing ' + list.length + ' of ' + rows.length + ' ranked protocols' + (list.length !== rows.length ? ' — clear the filters to see the whole board' : '') + '. Click a row for its detail and farm plan; click a column header to sort.';
  var ths = $('#thead').querySelectorAll('th');
  for (var k = 0; k < ths.length; k++) {
    ths[k].addEventListener('click', function (e) {
      var key = e.currentTarget.getAttribute('data-key');
      if (sortKey === key) sortDir = -sortDir; else { sortKey = key; sortDir = key === 'rank' ? 1 : -1; }
      renderTable();
    });
  }
  var trs = $('#tbody').querySelectorAll('tr');
  for (var m = 0; m < trs.length; m++) {
    trs[m].addEventListener('click', function (e) { openDetail(e.currentTarget.getAttribute('data-slug')); });
  }
}

/* ---- detail modal ---- */
function openDetail(slug) {
  var r = null;
  for (var i = 0; i < rows.length; i++) if (rows[i].slug === slug) r = rows[i];
  if (!r) return;
  var f = farmCache[r.slug];
  var termText = Object.keys(r.model.terms).map(function (k) { return k + ' ' + (r.model.terms[k] >= 0 ? '+' : '') + r.model.terms[k]; }).join(', ');
  var keptOdds = null;
  for (var j = 0; j < radar.odds.rows.length; j++) if (radar.odds.rows[j].verdict === 'kept') keptOdds = radar.odds.rows[j];
  var steps = r.farm_steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('');
  $('#modal-body').innerHTML =
    '<h2 id="modal-title">#' + r.rank + ' ' + esc(r.name) + '</h2>' +
    '<p class="d-sub">' + esc(r.slug) + ' &middot; ' + esc(r.category || '—') + ' &middot; ' + (r.on_watchlist ? 'on the watchlist' : 'off-list') + ' &middot; listed ' + (r.listed_at || 'unknown') + '</p>' +
    '<h3>Protocol</h3><div class="facts">' +
    '<div class="fact"><div class="fl">TVL</div><div class="fv">' + money(r.tvl_usd) + '</div></div>' +
    '<div class="fact"><div class="fl">7-day change</div><div class="fv">' + (r.change_7d === null ? '—' : (r.change_7d >= 0 ? '+' : '') + r.change_7d.toFixed(1) + '%') + '</div></div>' +
    '<div class="fact"><div class="fl">Age without a token</div><div class="fv">' + (r.age_days === null ? '—' : r.age_days + ' days') + '</div></div>' +
    '<div class="fact"><div class="fl">Chains</div><div class="fv">' + r.chains.length + '</div></div></div>' +
    '<p class="d-note">Chains: ' + r.chains.map(esc).join(', ') + '.</p>' +
    '<h3>Implied value — the fitted model</h3><div class="facts">' +
    '<div class="fact"><div class="fl">Implied value</div><div class="fv">' + money(r.implied_value_usd) + '</div></div>' +
    '<div class="fact"><div class="fl">P25–P75 range</div><div class="fv">' + money(r.implied_low_usd) + ' – ' + money(r.implied_high_usd) + '</div></div>' +
    '<div class="fact"><div class="fl">Token odds</div><div class="fv">' + pct1(r.token_odds) + '</div></div>' +
    '<div class="fact"><div class="fl">ln(value)</div><div class="fv">' + r.model.predicted_ln + '</div></div></div>' +
    '<p class="d-note">Contributions to ln(value): ' + termText + '. Coefficients fitted on ' + radar.n_fit + ' traded protocols (intercept ' + radar.coefficients.intercept + ', ln(TVL) ' + radar.coefficients.ln_tvl + '). Token odds from the peers&rsquo; record — model &ldquo;' + esc(radar.odds.chosen) + '&rdquo;, Brier ' + (keptOdds ? keptOdds.loo_brier.toFixed(4) : '—') + ' vs base rate ' + radar.odds.rows[0].loo_brier.toFixed(4) + '.' + (r.age_days === null ? ' This protocol has no listing date, so its odds are the peers&rsquo; base rate.' : '') + '</p>' +
    '<h3>Farm economics — at the current assumptions</h3><div class="econ">' +
    '<div class="fact"><div class="fl">Chain (cheapest)</div><div class="fv">' + esc(r.farm.chain) + '</div></div>' +
    '<div class="fact"><div class="fl">Expected reward</div><div class="fv">' + signed(f.reward) + '</div></div>' +
    '<div class="fact"><div class="fl">Cost (gas + interest)</div><div class="fv">' + signed(f.gas_cost + f.carry) + '</div></div>' +
    '<div class="fact"><div class="fl">Net</div><div class="fv">' + signed(f.net) + ' &middot; ' + signed2(f.net_per_hour) + '/h</div></div></div>' +
    '<p class="d-note">Verdict: <span class="verdict ' + f.verdict + '">' + f.verdict + '</span> at deposit $' + A.deposit_usd.toLocaleString('en-US') + ', ' + A.horizon_weeks + ' weeks, share ' + A.airdrop_share + ', APY ' + (A.apy * 100).toFixed(1) + '%.</p>' +
    '<h3>Farm plan</h3><ol class="steps">' + steps + '</ol>' +
    '<p class="steps-note">Steps priced at the default assumptions (deposit $1,000, 12 weeks). The verdict and net above follow the controls; change them and the economics move.</p>';
  $('#modal').hidden = false;
}
function closeDetail() { $('#modal').hidden = true; }

/* ---- init ---- */
function init() {
  if (!R || !radar || !rows.length) {
    document.getElementById('app').innerHTML = '<p style="padding:24px">Token Radar needs its data: data.js was not loaded.</p>';
    return;
  }
  recomputeFarm();
  renderHead();
  renderKpis();
  renderIntegrity();
  renderEvidence();
  renderAccounting();
  renderAssumptions();
  renderFilters();
  renderTable();
  $('#modal-close').addEventListener('click', closeDetail);
  $('#modal').addEventListener('click', function (e) { if (e.target === e.currentTarget) closeDetail(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeDetail(); });
}
init();
