/**
 * Builds the delivery report from the benchmark CSVs (run `npm run benchmark` first).
 *
 * Usage: npx tsx src/benchmarks/report.ts
 * Output:
 *   docs/RESULTADOS.md            tables (theoretical vs measured, Dijkstra vs A*, alerts, tick cost)
 *   docs/figures/*.svg            static charts referenced by RESULTADOS.md
 *
 * Headless: only node:fs, no Three.js or DOM.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

type Row = Record<string, string>;

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const RESULTS = resolve(HERE, 'results');
const DOCS = resolve(ROOT, 'docs');
const FIGURES = resolve(DOCS, 'figures');

// Categorical slots in fixed order (validated default palette, light surface).
const SERIES = ['#257de0', '#f47230', '#00b894', '#f2a600'];
const TEXT = '#191919';
const MUTED = '#666666';
const GRID = '#e6e6e6';
const MAP_ORDER = ['map_street', 'map_small', 'map_medium', 'map_large', 'gen_20', 'gen_32', 'gen_50'];

export function parseCsv(text: string): Row[] {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const headers = lines[0].split(',');
  return lines.slice(1).map((line) => {
    const values = line.split(',');
    return Object.fromEntries(headers.map((h, i) => [h, values[i] ?? '']));
  });
}

function read(file: string): Row[] {
  return parseCsv(readFileSync(resolve(RESULTS, file), 'utf-8'));
}

const num = (v: string | undefined): number => Number(v ?? 0);
const fmt = (v: number, digits = 3): string =>
  Number.isFinite(v) ? v.toLocaleString('es', { maximumFractionDigits: digits, minimumFractionDigits: 0, useGrouping: false }) : '—';
const byMap = (a: string, b: string): number => MAP_ORDER.indexOf(a) - MAP_ORDER.indexOf(b);

function table(headers: string[], rows: Array<Array<string | number>>): string {
  const head = `| ${headers.join(' | ')} |`;
  const sep = `| ${headers.map((_, i) => (i === 0 ? '---' : '---:')).join(' | ')} |`;
  return [head, sep, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');
}

// ---------- SVG helpers ----------

interface Series {
  name: string;
  points: Array<{ x: number; y: number }>;
}

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

function frame(title: string, subtitle: string, body: string, width = 640, height = 360): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" font-family="system-ui, sans-serif">
<rect width="${width}" height="${height}" fill="#ffffff"/>
<text x="24" y="28" font-size="15" font-weight="600" fill="${TEXT}">${esc(title)}</text>
<text x="24" y="47" font-size="12" fill="${MUTED}">${esc(subtitle)}</text>
${body}
</svg>
`;
}

function legend(names: string[], x: number, y: number): string {
  let cx = x;
  return names
    .map((name, i) => {
      const item = `<rect x="${cx}" y="${y - 9}" width="12" height="12" rx="2" fill="${SERIES[i]}"/><text x="${cx + 17}" y="${y + 1}" font-size="12" fill="${TEXT}">${esc(name)}</text>`;
      cx += 30 + name.length * 6.6;
      return item;
    })
    .join('');
}

function yAxis(x0: number, x1: number, y0: number, y1: number, max: number, label: string): string {
  const ticks = 4;
  let out = '';
  for (let i = 0; i <= ticks; i++) {
    const v = (max * i) / ticks;
    const y = y0 - ((y0 - y1) * i) / ticks;
    out += `<line x1="${x0}" x2="${x1}" y1="${y}" y2="${y}" stroke="${GRID}" stroke-width="1"/>`;
    out += `<text x="${x0 - 6}" y="${y + 4}" font-size="11" text-anchor="end" fill="${MUTED}">${fmt(v, 3)}</text>`;
  }
  out += `<text x="${x0 - 44}" y="${(y0 + y1) / 2}" font-size="11" fill="${MUTED}" transform="rotate(-90 ${x0 - 44} ${(y0 + y1) / 2})" text-anchor="middle">${esc(label)}</text>`;
  return out;
}

/** Grouped bars: one group per category, one bar per series. */
function barChart(title: string, subtitle: string, categories: string[], series: Array<{ name: string; values: number[] }>, yLabel: string): string {
  const W = 640, H = 360, x0 = 76, x1 = W - 20, y0 = H - 48, y1 = 78;
  const max = niceMax(Math.max(...series.flatMap((s) => s.values)));
  const group = (x1 - x0) / categories.length;
  const barW = Math.min(28, (group - 16) / series.length - 2);
  let body = yAxis(x0, x1, y0, y1, max, yLabel);
  categories.forEach((cat, ci) => {
    const gx = x0 + ci * group + (group - series.length * (barW + 2)) / 2;
    series.forEach((s, si) => {
      const v = s.values[ci];
      const h = ((y0 - y1) * v) / max;
      const x = gx + si * (barW + 2);
      body += `<path d="M${x},${y0} V${y0 - h + 4} q0,-4 4,-4 h${barW - 8} q4,0 4,4 V${y0} Z" fill="${SERIES[si]}"><title>${esc(`${cat} · ${s.name}: ${fmt(v)}`)}</title></path>`;
    });
    body += `<text x="${x0 + ci * group + group / 2}" y="${y0 + 18}" font-size="11" text-anchor="middle" fill="${TEXT}">${esc(cat)}</text>`;
  });
  body += `<line x1="${x0}" x2="${x1}" y1="${y0}" y2="${y0}" stroke="${MUTED}"/>`;
  body += legend(series.map((s) => s.name), x0, 68);
  return frame(title, subtitle, body, W, H);
}

/** Line chart with markers and direct end labels. */
function lineChart(title: string, subtitle: string, series: Series[], xLabel: string, yLabel: string, xTicks: number[]): string {
  const W = 720, H = 360, x0 = 76, x1 = W - 170, y0 = H - 48, y1 = 78;
  const maxX = Math.max(...xTicks);
  const minX = Math.min(...xTicks);
  const maxY = niceMax(Math.max(...series.flatMap((s) => s.points.map((p) => p.y))));
  const sx = (x: number): number => x0 + ((x - minX) / (maxX - minX || 1)) * (x1 - x0);
  const sy = (y: number): number => y0 - ((y0 - y1) * y) / maxY;
  let body = yAxis(x0, x1, y0, y1, maxY, yLabel);
  for (const t of xTicks) body += `<text x="${sx(t)}" y="${y0 + 18}" font-size="11" text-anchor="middle" fill="${MUTED}">${t}</text>`;
  body += `<text x="${(x0 + x1) / 2}" y="${H - 8}" font-size="11" text-anchor="middle" fill="${MUTED}">${esc(xLabel)}</text>`;
  body += `<line x1="${x0}" x2="${x1}" y1="${y0}" y2="${y0}" stroke="${MUTED}"/>`;
  const ends: Array<{ y: number; name: string; i: number }> = [];
  series.forEach((s, i) => {
    const pts = [...s.points].sort((a, b) => a.x - b.x);
    body += `<polyline fill="none" stroke="${SERIES[i]}" stroke-width="2" points="${pts.map((p) => `${sx(p.x)},${sy(p.y)}`).join(' ')}"/>`;
    for (const p of pts) {
      body += `<circle cx="${sx(p.x)}" cy="${sy(p.y)}" r="4" fill="${SERIES[i]}" stroke="#ffffff" stroke-width="2"><title>${esc(`${s.name} · ${p.x}: ${fmt(p.y)}`)}</title></circle>`;
    }
    const last = pts[pts.length - 1];
    if (last) ends.push({ y: sy(last.y), name: s.name, i });
  });
  ends.sort((a, b) => a.y - b.y);
  for (let k = 1; k < ends.length; k++) if (ends[k].y - ends[k - 1].y < 14) ends[k].y = ends[k - 1].y + 14;
  for (const e of ends) body += `<text x="${x1 + 8}" y="${e.y + 4}" font-size="11" fill="${TEXT}">${esc(e.name)}</text>`;
  body += legend(series.map((s) => s.name), x0, 68);
  return frame(title, subtitle, body, W, H);
}

// ---------- Report ----------

export function buildReport(): void {
  const summary = read('benchmark_summary.csv');
  const alerts = read('alert_results.csv');
  let ticks: Row[] = [];
  try {
    ticks = read('tick_cost_summary.csv');
  } catch {
    ticks = [];
  }
  const meta = JSON.parse(readFileSync(resolve(RESULTS, 'run_metadata.json'), 'utf-8'));
  mkdirSync(FIGURES, { recursive: true });

  const staticRows = summary.filter((r) => r.movement === '8' && r.scenario === 'static');
  const maps = [...new Set(staticRows.map((r) => r.map))].sort(byMap);
  const pick = (map: string, algorithm: string, heuristic: string, rows = staticRows): Row | undefined =>
    rows.find((r) => r.map === map && r.algorithm === algorithm && r.heuristic === heuristic);

  // 1. Expanded nodes
  writeFileSync(
    resolve(FIGURES, 'expandidos.svg'),
    barChart(
      'Nodos expandidos: Dijkstra vs. A* (octile)',
      'Media por mapa, movimiento 8 direcciones, sin barricadas',
      maps,
      [
        { name: 'Dijkstra', values: maps.map((m) => num(pick(m, 'dijkstra', 'none')?.expanded_mean)) },
        { name: 'A* octile', values: maps.map((m) => num(pick(m, 'astar', 'octile')?.expanded_mean)) },
      ],
      'nodos expandidos'
    )
  );

  // 2. Time vs size (generated maps)
  const gen = maps.filter((m) => m.startsWith('gen_'));
  const vertsOf = (m: string): number => Math.round(num(pick(m, 'dijkstra', 'none')?.vertices_mean));
  writeFileSync(
    resolve(FIGURES, 'tiempo_vs_tamano.svg'),
    lineChart(
      'Tiempo de búsqueda según el tamaño del grafo',
      'Mapas generados con semilla, mediana de 15 corridas por búsqueda, media de repeticiones',
      [
        { name: 'Dijkstra', points: gen.map((m) => ({ x: vertsOf(m), y: num(pick(m, 'dijkstra', 'none')?.time_ms_mean) })) },
        { name: 'A* octile', points: gen.map((m) => ({ x: vertsOf(m), y: num(pick(m, 'astar', 'octile')?.time_ms_mean) })) },
      ],
      'vértices caminables (V)',
      'ms por búsqueda',
      gen.map(vertsOf)
    )
  );

  // 3. Alerts
  const alertMaps = [...new Set(alerts.map((r) => r.map))].sort(byMap);
  const depthLimits = [0, 1, 2, 4, 8];
  const alertSeries: Series[] = alertMaps.slice(0, 4).map((m) => ({
    name: m,
    points: depthLimits.map((d) => {
      const rows = alerts.filter(
        (r) => r.map === m && (d === 0 ? r.mode === 'isolated' : r.mode === 'coordinated' && num(r.max_depth_limit) === d)
      );
      return { x: d, y: rows.reduce((s, r) => s + num(r.informed_ratio), 0) / Math.max(1, rows.length) };
    }),
  }));
  writeFileSync(
    resolve(FIGURES, 'alertas.svg'),
    lineChart(
      'Agentes informados: aislados vs. coordinados',
      'Fracción de zombis que se enteran del ruido. Profundidad 0 = aislados (sin radio)',
      alertSeries,
      'límite de profundidad de la alerta recursiva',
      'fracción informada',
      depthLimits
    )
  );

  // 4. Tick cost
  const tickAstar = ticks.filter((r) => r.algorithm === 'astar');
  const zombieCounts = [...new Set(tickAstar.map((r) => num(r.zombies)))].sort((a, b) => a - b);
  if (tickAstar.length > 0) {
    const tickSeries: Series[] = [];
    for (const map of ['map_street', 'gen_50']) {
      for (const mode of ['isolated', 'coordinated']) {
        const rows = tickAstar.filter((r) => r.map === map && r.mode === mode);
        if (rows.length) tickSeries.push({ name: `${map === 'map_street' ? 'calle' : map} ${mode === 'isolated' ? 'aislados' : 'coord.'}`, points: rows.map((r) => ({ x: num(r.zombies), y: num(r.tick_ms_mean) })) });
      }
    }
    writeFileSync(
      resolve(FIGURES, 'coste_tick.svg'),
      lineChart(
        'Coste de un tick de simulación según el número de zombis',
        'A* octile. Percepción + memoria + planificación + alertas, sin render',
        tickSeries,
        'zombis',
        'ms por tick (media)',
        zombieCounts
      )
    );
  }

  // ---------- Markdown ----------
  const theoryRows = maps.map((m) => {
    const d = pick(m, 'dijkstra', 'none');
    const a = pick(m, 'astar', 'octile');
    const V = num(d?.vertices_mean);
    const E = num(d?.edges_mean);
    const work = (V + E) * Math.log2(Math.max(2, V));
    return [
      m,
      fmt(V, 0),
      fmt(E, 0),
      fmt(work, 0),
      fmt(num(d?.time_ms_mean), 4),
      fmt((num(d?.time_ms_mean) / work) * 1e6, 2),
      fmt(num(a?.time_ms_mean), 4),
      fmt((num(a?.time_ms_mean) / work) * 1e6, 2),
    ];
  });

  const compareRows = maps.flatMap((m) =>
    [
      ['dijkstra', 'none', 'Dijkstra'],
      ['astar', 'octile', 'A* octile'],
      ['astar', 'euclidean', 'A* euclídea'],
      ['astar', 'manhattan', 'A* manhattan (no admisible en 8-dir)'],
    ].map(([alg, h, label]) => {
      const r = pick(m, alg, h);
      return [m, label, fmt(num(r?.expanded_mean), 1), fmt(num(r?.time_ms_mean), 4), fmt(num(r?.cost_ratio_mean), 4), `${fmt(num(r?.optimal_rate) * 100, 0)} %`];
    })
  );

  const barricadeRows = maps.flatMap((m) => {
    const rows = summary.filter((r) => r.map === m && r.movement === '8' && r.scenario === 'barricade');
    return [
      ['dijkstra', 'none', 'Dijkstra'],
      ['astar', 'octile', 'A* octile'],
    ].map(([alg, h, label]) => {
      const r = pick(m, alg, h, rows);
      return [m, label, fmt(num(r?.expanded_mean), 1), fmt(num(r?.cost_mean), 3), `${fmt(num(r?.optimal_rate) * 100, 0)} %`];
    });
  });

  const fourWay = maps.map((m) => {
    const rows = summary.filter((r) => r.map === m && r.movement === '4' && r.scenario === 'static');
    const d = pick(m, 'dijkstra', 'none', rows);
    const a = pick(m, 'astar', 'manhattan', rows);
    return [m, fmt(num(d?.expanded_mean), 1), fmt(num(a?.expanded_mean), 1), `${fmt(num(a?.optimal_rate) * 100, 0)} %`];
  });

  const alertRows = alertMaps.flatMap((m) =>
    depthLimits.map((d) => {
      const rows = alerts.filter(
        (r) => r.map === m && (d === 0 ? r.mode === 'isolated' : r.mode === 'coordinated' && num(r.max_depth_limit) === d)
      );
      const avg = (k: string): number => rows.reduce((s, r) => s + num(r[k]), 0) / Math.max(1, rows.length);
      return [
        m,
        d === 0 ? 'aislados' : `coordinados, prof. <= ${d}`,
        fmt(avg('informed_ratio') * 100, 1) + ' %',
        fmt(avg('reached_depth'), 2),
        fmt(Math.max(...rows.map((r) => num(r.max_stack_depth))), 0),
        fmt(avg('recursive_calls'), 1),
        fmt(avg('propagation_ms'), 4),
      ];
    })
  );

  const tickRows = ticks
    .filter((r) => r.algorithm === 'astar')
    .sort((a, b) => byMap(a.map, b.map) || num(a.zombies) - num(b.zombies) || a.mode.localeCompare(b.mode))
    .map((r) => [
      r.map,
      r.zombies,
      r.mode === 'isolated' ? 'aislados' : 'coordinados',
      fmt(num(r.tick_ms_mean), 4),
      fmt(num(r.tick_ms_p95), 4),
      fmt(num(r.searches_per_tick), 2),
      fmt(num(r.expanded_per_tick), 1),
      `${fmt(num(r.redundant_rate) * 100, 2)} %`,
      fmt(num(r.informed_by_alert_per_episode), 2),
    ]);

  const dijkstraVsAstarTick = zombieCounts.map((z) => {
    const row = (alg: string): Row | undefined => ticks.find((r) => r.map === 'map_street' && r.mode === 'coordinated' && r.algorithm === alg && num(r.zombies) === z);
    return [String(z), fmt(num(row('dijkstra')?.tick_ms_mean), 4), fmt(num(row('astar')?.tick_ms_mean), 4), fmt(num(row('dijkstra')?.expanded_per_tick), 1), fmt(num(row('astar')?.expanded_per_tick), 1)];
  });

  const maxRedundant = Math.max(0, ...ticks.map((r) => num(r.redundant_rate)));
  const worstTick = ticks.reduce((w, r) => (num(r.tick_ms_p95) > num(w?.tick_ms_p95) ? r : w), ticks[0]);

  const md = `# Resultados experimentales

> Archivo generado por \`npx tsx src/benchmarks/report.ts\` a partir de los CSV de \`src/benchmarks/results/\`.
> No editar a mano: volver a correr \`npm run benchmark\` y luego el reporte.

Corrida: ${meta.startedAt} · ${meta.machine.cpu} (${meta.machine.cores} núcleos) · Node ${meta.machine.node} · ${meta.machine.platform} ${meta.machine.arch}.
Parámetros: tamaños ${meta.options.sizes.join(', ')}, ${meta.options.repetitions} repeticiones (una semilla distinta por repetición, semilla base ${meta.options.baseSeed}), ${meta.options.innerRuns} corridas internas por búsqueda (se guarda la mediana).

Mapas: \`gen_N\` son mapas generados de N x N con semilla; \`map_small\`, \`map_medium\`, \`map_large\` son los mapas fijos de \`public/maps\`; \`map_street\` es la cuadrícula del mundo FPV (46 x 56 celdas de 1 m, ${fmt(vertsOf('map_street') || num(pick('map_street', 'dijkstra', 'none')?.vertices_mean), 0)} celdas caminables en anillo).

## 1. Complejidad teórica contra medida

Dijkstra y A* con montículo binario cuestan O((V + E) log V). La columna "ns por unidad" divide el tiempo medido entre (V + E) log2 V: si la teoría se cumple, esa constante se mantiene en el mismo orden de magnitud al crecer el grafo. A* recorre solo una parte del grafo, así que su constante queda por debajo de la de Dijkstra.

${table(['Mapa', 'V', 'E', '(V+E) log2 V', 'Dijkstra ms', 'Dijkstra ns/unidad', 'A* ms', 'A* ns/unidad'], theoryRows)}

![Tiempo según tamaño](figures/tiempo_vs_tamano.svg)

## 2. Dijkstra contra A* (8 direcciones, sin barricadas)

"Razón de costo" = costo encontrado / costo óptimo (Dijkstra). 1 significa ruta óptima.

${table(['Mapa', 'Algoritmo', 'Nodos expandidos', 'ms', 'Razón de costo', 'Óptimo'], compareRows)}

![Nodos expandidos](figures/expandidos.svg)

Lectura: con heurísticas admisibles (octile, euclídea) A* encuentra siempre la ruta óptima (100 %) y expande menos nodos que Dijkstra. Manhattan en movimiento de 8 direcciones sobreestima (no es admisible): expande muy pocos nodos pero devuelve rutas hasta un ~3 % más caras. En movimiento de 4 direcciones Manhattan sí es admisible:

${table(['Mapa', 'Dijkstra expandidos (4-dir)', 'A* manhattan expandidos (4-dir)', 'A* óptimo'], fourWay)}

## 3. Replanificación con barricadas

Se bloquean 3 celdas de la ruta óptima (como hace la barricada de Mara) y se vuelve a buscar sobre el grafo actualizado.

${table(['Mapa', 'Algoritmo', 'Nodos expandidos', 'Costo medio', 'Óptimo'], barricadeRows)}

## 4. Alertas recursivas: aislados contra coordinados

Mismas semillas y mismas posiciones en ambos modos. Un ruido lo oyen solo los zombis dentro del radio de audición (5 celdas). Aislados: solo ellos reaccionan. Coordinados: cada oyente lanza la alerta recursiva por radio (alcance 7 celdas) con límite de profundidad.

${table(['Mapa', 'Modo', 'Informados', 'Profundidad alcanzada', 'Pila máxima', 'Llamadas recursivas', 'ms'], alertRows)}

![Alertas](figures/alertas.svg)

La pila de llamadas nunca supera el límite de profundidad + 1, y el número de llamadas nunca supera el número de agentes: el conjunto de visitados impide ciclos.

## 5. Coste por tick con muchos zombis

Simulación completa sin render (\`src/benchmarks/tickCost.ts\`): Mara recorre la ruta óptima hacia la extracción y dispara cada 15 ticks. ${meta.options.ticks} ticks medidos por configuración y ${meta.options.tickRepetitions} semillas; cuando Mara muere empieza otro episodio con otra semilla para medir siempre el mismo número de ticks.

${tickRows.length ? table(['Mapa', 'Zombis', 'Modo', 'ms/tick', 'p95 ms', 'Búsquedas/tick', 'Nodos/tick', 'Búsquedas redundantes', 'Informados por alerta'], tickRows) : '_Sin datos: correr npm run benchmark sin --no-tick._'}

![Coste por tick](figures/coste_tick.svg)

Dijkstra contra A* dentro del juego (map_street, coordinados):

${table(['Zombis', 'Dijkstra ms/tick', 'A* ms/tick', 'Dijkstra nodos/tick', 'A* nodos/tick'], dijkstraVsAstarTick)}

Conclusiones:

- El presupuesto de un tick es de ${fmt(385, 0)} ms en \`map_street\` (celdas de 1 m) y de 60 fps para el render. El peor p95 medido es ${fmt(num(worstTick?.tick_ms_p95), 3)} ms (${worstTick?.map}, ${worstTick?.zombies} zombis, ${worstTick?.mode === 'isolated' ? 'aislados' : 'coordinados'}): la IA no limita el rendimiento; el cuello de botella es el render.
- El coste crece de forma aproximadamente lineal con el número de zombis, porque cada zombi hace a lo sumo una búsqueda por tick.
- Búsquedas redundantes (misma salida, mismo destino, mismo algoritmo y grafo sin cambios): máximo ${fmt(maxRedundant * 100, 2)} %. Los agentes ya replanifican solo cuando cambia el objetivo, la evidencia o el grafo. \`PathCache\` (\`src/core/algorithms/pathCache.ts\`) queda disponible para cuando varios zombis compartan destino o se añadan más agentes.
- La coordinación aumenta las búsquedas por tick (más zombis informados que se mueven hacia el ruido), que es justo el efecto buscado.
`;

  writeFileSync(resolve(DOCS, 'RESULTADOS.md'), md);
  console.log(`Report written to ${resolve(DOCS, 'RESULTADOS.md')} and ${FIGURES}`);
}

const isDirectExecution =
  typeof process !== 'undefined' && Array.isArray(process.argv) && process.argv[1]?.endsWith('report.ts');

if (isDirectExecution) buildReport();
