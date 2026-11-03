/* global d3 */
const COLORS = { root: '#555', entity: '#1f77b4', group: '#7f7f7f', field: '#2ca02c', join: '#ff7f0e', relation: '#9467bd', info: '#8c564b', missing: '#d62728' };
const DX = 30;
const COLUMN_GAP = 90;
const DURATION = 300;
const ORIGIN_X = 60;

const status = document.getElementById('status');
const tooltip = document.getElementById('tooltip');
let entities = [];
let byName = new Map();
let root;
let nextId = 0;
let filterKey = 'mfEntityName';
let filterValue = '';
let selectedId = null;

const svg = d3.select('#tree').append('svg').attr('width', '100%').attr('height', '100%');
svg.attr('font-family', 'system-ui, sans-serif').attr('font-size', 12);

// Rotating gradient used as the border of the selected node (styled in index.html)
const grad = svg
  .append('defs')
  .append('linearGradient')
  .attr('id', 'sel-grad')
  .attr('gradientUnits', 'objectBoundingBox');
['#ff0080', '#ff8c00', '#40e0d0', '#7b2ff7', '#ff0080'].forEach((c, i, a) =>
  grad.append('stop').attr('offset', `${(i / (a.length - 1)) * 100}%`).attr('stop-color', c)
);
grad
  .append('animateTransform')
  .attr('attributeName', 'gradientTransform')
  .attr('type', 'rotate')
  .attr('from', '0 0.5 0.5')
  .attr('to', '360 0.5 0.5')
  .attr('dur', '2.5s')
  .attr('repeatCount', 'indefinite');

// Pan by dragging the background, zoom with the wheel; node clicks still work
// because d3.zoom only swallows the click when the pointer actually moved.
const ZOOM_MIN = 0.2;
const ZOOM_MAX = 3;
const zoomSlider = document.getElementById('zoomSlider');
const zoomLabel = document.getElementById('zoomLabel');
zoomSlider.min = ZOOM_MIN * 100;
zoomSlider.max = ZOOM_MAX * 100;
const view = svg.append('g');
const gLink = view.append('g');
const gNode = view.append('g');
const zoom = d3
  .zoom()
  .scaleExtent([ZOOM_MIN, ZOOM_MAX])
  .on('start', () => svg.classed('panning', true))
  .on('zoom', (event) => {
    view.attr('transform', event.transform);
    zoomSlider.value = event.transform.k * 100;
    zoomLabel.textContent = `${Math.round(event.transform.k * 100)}%`;
  })
  .on('end', () => {
    svg.classed('panning', false);
    saveState();
  });
svg.call(zoom).on('dblclick.zoom', null);

function resetView() {
  const { height } = svg.node().getBoundingClientRect();
  svg.call(zoom.transform, d3.zoomIdentity.translate(ORIGIN_X, height / 2));
}

// Slider and +/- zoom around the centre of the canvas
zoomSlider.addEventListener('input', () => svg.call(zoom.scaleTo, zoomSlider.value / 100));
document.getElementById('zoomIn').addEventListener('click', () => svg.transition().duration(200).call(zoom.scaleBy, 1.25));
document.getElementById('zoomOut').addEventListener('click', () => svg.transition().duration(200).call(zoom.scaleBy, 0.8));

// Pill background behind circle + label, sized from the rendered text.
// The width is kept on the datum so links can start at the pill's right edge.
const PILL_LEFT = -12;
function sizePill(g) {
  g.each(function sizeOne(d) {
    const box = this.querySelector('text').getBBox();
    d.w = box.x + box.width + 22;
    d3.select(this)
      .select('rect.bg')
      .attr('x', PILL_LEFT)
      .attr('y', -12)
      .attr('height', 24)
      .attr('width', d.w);
  });
}

// Parent's right edge -> child's left edge
const linkPath = d3.linkHorizontal();
function edgePath(l) {
  return linkPath({
    source: [l.source.y + PILL_LEFT + (l.source.w || 0), l.source.x],
    target: [l.target.y + PILL_LEFT, l.target.x],
  });
}

// entities.json has full-line // comments, which JSON.parse rejects
function parseCatalog(text) {
  const json = text.replace(/^\uFEFF/, '').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  const data = JSON.parse(json);
  if (!Array.isArray(data.entities)) throw new Error('missing "entities" array');
  return data.entities;
}

function leaf(kind, name, sub, tip) {
  return { kind, name, sub, tip };
}

// Values found at a dotted key path ("fields.type"); arrays are walked through.
// An empty path returns every primitive value in the object.
function valuesAt(obj, path) {
  if (obj == null) return [];
  if (Array.isArray(obj)) return obj.flatMap((o) => valuesAt(o, path));
  if (!path.length) return typeof obj === 'object' ? Object.values(obj).flatMap((v) => valuesAt(v, path)) : [obj];
  return valuesAt(obj[path[0]], path.slice(1));
}

function matchesValue(obj, path) {
  const q = filterValue.toLowerCase();
  return valuesAt(obj, path).some((v) => String(v).toLowerCase().includes(q));
}

function collectKeys(list) {
  const keys = new Set();
  const walk = (obj, prefix) => {
    for (const [k, v] of Object.entries(obj)) {
      const path = prefix ? `${prefix}.${k}` : k;
      if (Array.isArray(v) && v.some((x) => x && typeof x === 'object')) v.forEach((x) => x && typeof x === 'object' && walk(x, path));
      else if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, path);
      else keys.add(path);
    }
  };
  list.forEach((e) => walk(e, ''));
  return [...keys].sort((a, b) => a.split('.').length - b.split('.').length || a.localeCompare(b));
}

const alpha = (a, b) => (a.sortKey || a.name).localeCompare(b.sortKey || b.name, undefined, { sensitivity: 'base', numeric: true });

// Entities and the items inside Properties/Fields/Joins/Relations get a copy button.
// It copies the full grey text when there is one (FK arrow dropped), otherwise the
// white label with emoji/markers (🔑, ★) removed.
const COPYABLE = new Set(['entity', 'info', 'field', 'join', 'relation', 'missing']);
const isCopyable = (d) => COPYABLE.has(d.data.kind);
const stripEmoji = (s) => s.replace(/[\p{Extended_Pictographic}\u2605\u2606\uFE0F\u200D]/gu, '').replace(/\s+/g, ' ').trim();
const copyText = (d) => (d.data.sub ? d.data.sub.replace(/^→\s*/, '') : stripEmoji(d.data.name));

// execCommand runs synchronously inside the click, which VS Code's built-in browser
// allows; the async Clipboard API there fails with "Document is not focused".
function copyToClipboard(value) {
  const active = document.activeElement;
  const ta = Object.assign(document.createElement('textarea'), { value, readOnly: true });
  ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  ta.remove();
  active?.focus?.();
  if (ok) return Promise.resolve();
  return navigator.clipboard ? navigator.clipboard.writeText(value) : Promise.reject(new Error('Clipboard unavailable'));
}

// When the filter key points inside fields/joins/relations, the matching group of a
// top-level entity only lists the matching items and opens automatically.
function group(name, key, items, load, applyFilter) {
  const path = filterKey.split('.');
  if (applyFilter && filterValue && path.length > 1 && path[0] === key) {
    const hits = items.filter((it) => matchesValue(it, path.slice(1)));
    return {
      kind: 'group',
      name: `${name} (${hits.length}/${items.length})`,
      open: true,
      load: () => hits.map((it) => ({ ...load(it), match: true })).sort(alpha),
    };
  }
  return { kind: 'group', name: `${name} (${items.length})`, load: () => items.map(load).sort(alpha) };
}

function entityChildren(e, applyFilter = false) {
  // ManyToOne relations name the FK field of this entity; their target owns the PK
  const fkTargets = new Map();
  for (const r of e.relations || []) {
    const target = r.type === 'ManyToOne' && byName.get(r.target.toLowerCase());
    if (target) fkTargets.set(r.foreignKey.toLowerCase(), target);
  }
  const fieldNode = (f) => {
    const tip = [f.desc, `source: ${f.source}`, f.filterable === false ? 'not filterable' : ''].filter(Boolean).join('\n');
    const label = `${f.name} : ${f.type}${f.default ? ' ★' : ''}`;
    const target = fkTargets.get(f.name.toLowerCase());
    if (!target) return { ...leaf('field', label, f.source !== f.name ? f.source : '', tip), sortKey: f.name };
    return {
      kind: 'field',
      fk: true,
      sortKey: f.name,
      name: `🔑 ${label}`,
      sub: `→ ${target.mfEntityName}.${target.primaryKey}`,
      tip: `Foreign key → ${target.mfEntityName} (${target.table}.${target.primaryKey})\n${tip}\nClick to open ${target.mfEntityName}`,
      load: () => entityChildren(target),
    };
  };
  const children = [
    {
      kind: 'group',
      name: 'Properties',
      load: () =>
        [
          ['table', e.table],
          ['primaryKey', e.primaryKey],
          ['name', e.name],
          ['description', e.itemDescription],
          ['baseFilter', e.baseFilter],
        ]
          .filter(([, v]) => v)
          .map(([k, v]) => leaf('info', `${k}: ${v}`)),
    },
  ];
  if (e.fields?.length) {
    children.push(group('Fields', 'fields', e.fields, fieldNode, applyFilter));
  }
  if (e.joins?.length) {
    children.push(
      group('Joins', 'joins', e.joins, (j) => leaf('join', `${j.alias} → ${j.table}`, `${j.joinType || 'LEFT'} ON ${j.on}`, `${j.joinType || 'LEFT'} JOIN ${j.table} ${j.alias}\nON ${j.on}`), applyFilter)
    );
  }
  if (e.relations?.length) {
    children.push(group('Relations', 'relations', e.relations, relationNode, applyFilter));
  }
  return children;
}

function entityNode(e, applyFilter = false) {
  return {
    kind: 'entity',
    name: e.mfEntityName,
    sub: e.table,
    tip: `${e.mfEntityName} (${e.name})\ntable: ${e.table}\nPK: ${e.primaryKey}\n${e.itemDescription || ''}${e.baseFilter ? `\nbaseFilter: ${e.baseFilter}` : ''}`,
    load: () => entityChildren(e, applyFilter),
  };
}

function relationNode(r) {
  const target = byName.get(r.target.toLowerCase());
  const tip = `${r.type} → ${r.target}\nforeignKey: ${r.foreignKey}${r.desc ? `\n${r.desc}` : ''}`;
  if (!target) return leaf('missing', `${r.name} → ${r.target} (not found)`, r.type, tip);
  return {
    kind: 'relation',
    name: `${r.name} → ${target.mfEntityName}`,
    sub: `${r.type} · ${r.foreignKey}`,
    tip: `${tip}\nClick to open ${target.mfEntityName}`,
    load: () => entityChildren(target),
  };
}

function makeNode(data, parent) {
  const node = d3.hierarchy(data, () => null);
  node.id = ++nextId;
  node.parent = parent;
  node.depth = parent ? parent.depth + 1 : 0;
  return node;
}

function expand(d) {
  if (d.children) return;
  if (d._children) {
    d.children = d._children;
    d._children = null;
  } else if (d.data.load) {
    const kids = d.data.load().map((c) => makeNode(c, d));
    d.children = kids.length ? kids : null;
  }
}

function collapse(d) {
  if (d.children) {
    d._children = d.children;
    d.children = null;
  }
}

// Persisted graph state: nodes are identified by their name path from the root,
// because node ids are regenerated on every load.
const STATE_KEY = 'entity-tree-state';
const nodePath = (d) => d.ancestors().reverse().slice(1).map((n) => n.data.name).join('\u241f');

function saveState() {
  if (!root) return;
  const expanded = [];
  let selected = null;
  root.each((d) => {
    if (d !== root && d.children) expanded.push(nodePath(d));
    if (d.id === selectedId) selected = nodePath(d);
  });
  const { x, y, k } = d3.zoomTransform(svg.node());
  localStorage.setItem(STATE_KEY, JSON.stringify({ filterKey, filterValue, expanded, selected, view: { x, y, k } }));
}

function loadState() {
  try {
    return JSON.parse(localStorage.getItem(STATE_KEY)) || null;
  } catch {
    return null;
  }
}

function buildRoot(saved = null) {
  const path = filterKey ? filterKey.split('.') : [];
  const list = (filterValue ? entities.filter((e) => matchesValue(e, path)) : [...entities]).sort((a, b) =>
    a.mfEntityName.localeCompare(b.mfEntityName, undefined, { sensitivity: 'base', numeric: true })
  );
  root = makeNode({ kind: 'root', name: `Entities (${list.length}/${entities.length})` }, null);
  root.children = list.length ? list.map((e) => makeNode(entityNode(e, true), root)) : null;
  if (saved) {
    const open = new Set(saved.expanded || []);
    const reopen = (n) =>
      (n.children || []).forEach((c) => {
        if (open.has(nodePath(c))) {
          expand(c);
          reopen(c);
        }
      });
    reopen(root);
    selectedId = null;
    root.each((d) => {
      if (saved.selected && nodePath(d) === saved.selected) selectedId = d.id;
    });
  } else if (filterValue && path.length > 1) {
    // Show matching fields/joins/relations right away
    (root.children || []).forEach((ent) => {
      expand(ent);
      (ent.children || []).filter((g) => g.data.open).forEach(expand);
    });
  }
  root.x0 = 0;
  root.y0 = 0;
  // New tree on every filter change: drop old nodes instead of animating them out
  gNode.selectAll('*').interrupt().remove();
  gLink.selectAll('*').interrupt().remove();
  const v = saved?.view;
  if (v && [v.x, v.y, v.k].every(Number.isFinite)) svg.call(zoom.transform, d3.zoomIdentity.translate(v.x, v.y).scale(v.k));
  else resetView();
  update(root);
}

function update(source) {
  // Only the vertical layout comes from d3.tree; columns are set after measuring pills
  d3.tree().nodeSize([DX, 1])(root);

  // Not bound to the svg, so a pan/zoom interrupt can't cancel node animations
  const t = d3.transition().duration(DURATION);

  const nodes = root.descendants();
  const links = root.links();
  const canOpen = (d) => !!(d.children || d._children || (d.data.load && !d.children));

  const node = gNode.selectAll('g.node').data(nodes, (d) => d.id);

  const nodeEnter = node
    .enter()
    .append('g')
    .attr('class', 'node')
    .attr('transform', `translate(${source.y0},${source.x0})`)
    .attr('fill-opacity', 0)
    .on('click', (event, d) => {
      selectedId = d.id;
      if (d.children) collapse(d);
      else expand(d);
      update(d);
    })
    .on('mousemove', (event, d) => {
      if (!d.data.tip) return;
      tooltip.textContent = d.data.tip;
      tooltip.style.display = 'block';
      tooltip.style.left = `${event.clientX + 14}px`;
      tooltip.style.top = `${event.clientY + 14}px`;
    })
    .on('mouseleave', () => {
      tooltip.style.display = 'none';
    });

  nodeEnter
    .append('rect')
    .attr('class', 'bg')
    .attr('rx', 12)
    .attr('stroke', (d) => COLORS[d.data.kind])
    .style('fill', (d) => `color-mix(in srgb, ${COLORS[d.data.kind]} 14%, var(--node-bg))`);

  nodeEnter.append('circle').attr('r', 4.5).attr('stroke', (d) => COLORS[d.data.kind]);

  nodeEnter.filter(isCopyable).each(function addCopy(d) {
    const btn = d3
      .select(this)
      .append('g')
      .attr('class', 'copy')
      .attr('transform', 'translate(9,-7)')
      .on('click', (event) => {
        event.stopPropagation();
        copyToClipboard(copyText(d))
          .then(() => {
            tooltip.textContent = `Copied: ${copyText(d)}`;
            btn.classed('copied', true);
            setTimeout(() => btn.classed('copied', false), 1200);
          })
          .catch((err) => {
            tooltip.textContent = `Copy failed: ${err.message}`;
            tooltip.style.display = 'block';
          });
      })
      .on('mousemove', (event) => {
        event.stopPropagation();
        tooltip.textContent = `Copy: ${copyText(d)}`;
        tooltip.style.display = 'block';
        tooltip.style.left = `${event.clientX + 14}px`;
        tooltip.style.top = `${event.clientY + 14}px`;
      });
    btn.append('rect').attr('width', 14).attr('height', 14).attr('fill', 'transparent');
    btn.node().appendChild(lucide.createElement(lucide.Copy, { width: 14, height: 14, class: 'ic-copy' }));
    btn.node().appendChild(lucide.createElement(lucide.Check, { width: 14, height: 14, class: 'ic-check' }));
  });

  const text = nodeEnter
    .append('text')
    .attr('dy', '0.32em')
    .attr('x', (d) => (isCopyable(d) ? 28 : 8));
  text.append('tspan').text((d) => d.data.name);
  text
    .append('tspan')
    .attr('class', 'sub')
    .attr('dx', 6)
    .text((d) => (d.data.sub ? (d.data.sub.length > 50 ? `${d.data.sub.slice(0, 47)}…` : d.data.sub) : ''));

  const nodeUpdate = node.merge(nodeEnter);
  nodeUpdate
    .classed('match', (d) => !!d.data.match || (!!filterValue && d.depth === 1))
    .classed('fk', (d) => !!d.data.fk)
    .classed('selected', (d) => d.id === selectedId)
    .call(sizePill);

  // Columns sized from the widest visible pill of the previous depth, so long
  // labels never run into (or squeeze) the next level.
  const colWidth = [];
  root.each((d) => {
    colWidth[d.depth] = Math.max(colWidth[d.depth] || 0, d.w || 0);
  });
  const colY = [0];
  for (let i = 1; i < colWidth.length; i++) colY[i] = colY[i - 1] + colWidth[i - 1] + COLUMN_GAP;
  root.each((d) => {
    d.y = colY[d.depth];
  });

  nodeUpdate
    .transition(t)
    .attr('transform', (d) => `translate(${d.y},${d.x})`)
    .attr('fill-opacity', 1);
  nodeUpdate
    .select('circle')
    .style('fill', (d) => (canOpen(d) && !d.children ? COLORS[d.data.kind] : 'var(--node-bg)'));

  node
    .exit()
    .transition(t)
    .remove()
    .attr('transform', `translate(${source.y},${source.x})`)
    .attr('fill-opacity', 0);

  const link = gLink.selectAll('path.link').data(links, (d) => d.target.id);
  // Collapsed links start and end at the right edge of the source pill
  const collapsed = (x, y) => {
    const p = [y + PILL_LEFT + (source.w || 0), x];
    return linkPath({ source: p, target: p });
  };
  const linkEnter = link
    .enter()
    .append('path')
    .attr('class', 'link')
    .attr('d', () => collapsed(source.x0, source.y0));
  link.merge(linkEnter).transition(t).attr('d', edgePath);
  link
    .exit()
    .transition(t)
    .remove()
    .attr('d', () => collapsed(source.x, source.y));

  root.eachBefore((d) => {
    d.x0 = d.x;
    d.y0 = d.y;
  });
  saveState();
}

let restored = false;
function load(text, from) {
  try {
    entities = parseCatalog(text);
  } catch (err) {
    status.textContent = `Invalid ${from}: ${err.message}`;
    return;
  }
  byName = new Map(entities.map((e) => [e.mfEntityName.toLowerCase(), e]));
  const relations = entities.reduce((n, e) => n + (e.relations?.length || 0), 0);
  const joins = entities.reduce((n, e) => n + (e.joins?.length || 0), 0);
  status.textContent = `${from}: ${entities.length} entities, ${joins} joins, ${relations} relations`;
  const keys = collectKeys(entities);
  if (!keys.includes(filterKey)) filterKey = keys.includes('mfEntityName') ? 'mfEntityName' : '';
  d3.select('#filterKey')
    .selectAll('option')
    .data(['', ...keys])
    .join('option')
    .attr('value', (k) => k)
    .text((k) => k || '(any key)');
  // Restore the previous session's graph only on the first load of the page
  const saved = restored ? null : loadState();
  restored = true;
  if (saved && (saved.filterKey === '' || keys.includes(saved.filterKey))) {
    filterKey = saved.filterKey;
    filterValue = saved.filterValue || '';
    document.getElementById('search').value = filterValue;
  }
  keySelect.value = filterKey;
  buildRoot(saved);
}

const keySelect = document.getElementById('filterKey');
keySelect.addEventListener('change', (e) => {
  filterKey = e.target.value;
  if (entities.length && filterValue) buildRoot();
});

document.getElementById('search').addEventListener('input', (e) => {
  filterValue = e.target.value.trim();
  if (entities.length) buildRoot();
});

document.getElementById('expand').addEventListener('click', () => {
  if (!root) return;
  (root.children || []).forEach(expand);
  update(root);
});

document.getElementById('collapse').addEventListener('click', () => {
  if (!root) return;
  (root.children || []).forEach(collapse);
  update(root);
});

document.getElementById('reset').addEventListener('click', resetView);

document.getElementById('loadFile').addEventListener('click', () => document.getElementById('file').click());
document.getElementById('file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (file) load(await file.text(), file.name);
});

// Theme button cycles System -> Light -> Dark; its icon shows the current mode
const THEMES = { system: ['monitor', 'System'], light: ['sun', 'Light'], dark: ['moon', 'Dark'] };
const themeBtn = document.getElementById('theme');
let theme = 'system';
function applyTheme(next) {
  theme = THEMES[next] ? next : 'system';
  if (theme === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', theme);
  const [icon, label] = THEMES[theme];
  themeBtn.innerHTML = `<i data-lucide="${icon}"></i>`;
  themeBtn.title = `Theme: ${label} (click to switch)`;
  themeBtn.setAttribute('aria-label', themeBtn.title);
  lucide.createIcons({ root: themeBtn });
  localStorage.setItem('entity-tree-theme', theme);
}
themeBtn.addEventListener('click', () => {
  const order = Object.keys(THEMES);
  applyTheme(order[(order.indexOf(theme) + 1) % order.length]);
});
lucide.createIcons();
applyTheme(localStorage.getItem('entity-tree-theme') || 'system');

fetch('entities.json')
  .then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.text();
  })
  .then((text) => load(text, 'entities.json'))
  .catch((err) => {
    status.textContent = `Could not fetch entities.json (${err.message}). Use "Load file" or run "npm start".`;
  });
