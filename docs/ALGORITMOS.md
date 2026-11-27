# Algoritmos de Z3R0-FRECUENCY

Documento técnico del frente D: grafo, búsqueda de rutas, heurísticas, alertas recursivas, análisis de complejidad y capa Rayos X. Los números medidos están en [RESULTADOS.md](RESULTADOS.md), que se genera a partir de los CSV del benchmark.

Código fuente:

| Pieza | Archivo |
| --- | --- |
| Grafo ponderado | `src/core/graph/WeightedGraph.ts` |
| Generador de mapas con semilla | `src/core/graph/mapGenerator.ts`, `seededRng.ts` |
| Carga y validación de mapas | `src/core/graph/mapLoader.ts` |
| Montículo binario | `src/core/algorithms/BinaryHeap.ts` |
| Dijkstra y A* (búsqueda común) | `src/core/algorithms/shortestPath.ts`, `dijkstra.ts`, `astar.ts` |
| Heurísticas | `src/core/algorithms/heuristics.ts` |
| Caché de rutas y validez de ruta | `src/core/algorithms/pathCache.ts` |
| Alertas recursivas acotadas | `src/core/algorithms/alertRecursion.ts` |
| Benchmarks | `src/benchmarks/runSuite.ts`, `tickCost.ts`, `report.ts` |
| Rayos X | `src/render/debug/DebugVisuals.ts` |

Todo `src/core/` y `src/benchmarks/` corre en Node sin navegador ni Three.js (regla de `AGENTS.md`), por eso se prueba con `npm test` y se mide con `npm run benchmark`.

## 1. El mundo como grafo

El mapa es una cuadrícula de `width x height` celdas. Cada celda tiene un tipo (`street`, `sidewalk`, `building`, `obstacle`, `barricade`, `pharmacy`, `refuge`, `extraction`), un indicador `walkable` y un costo de paso `cost >= 0`. En el mundo FPV la cuadrícula está alineada con `street.glb`: celdas de 1 m, `col` crece en +X, `row` en +Z (`src/core/world/gridSpace.ts`).

Definición del grafo G = (V, E, w):

- **Vértices V**: las celdas caminables. Se identifican por `id = row * width + col`, lo que permite guardar distancias, padres y visitados en arreglos tipados (`Float64Array`, `Int32Array`, `Uint8Array`) en vez de mapas con claves de texto.
- **Aristas E**: de cada celda caminable a sus vecinas caminables. Con movimiento de 8 direcciones (por defecto) hay hasta 8 vecinas; con 4 direcciones, hasta 4. Se prohíbe "cortar esquinas": un paso diagonal solo existe si las dos celdas ortogonales que rodea también son caminables, para que un zombi no atraviese la esquina de un edificio.
- **Pesos**: w(u, v) = cost(v) * largo del paso, con largo 1 en ortogonal y sqrt(2) en diagonal. Todos los pesos son no negativos (el cargador rechaza costos negativos o infinitos y `setCost` lanza error), que es la condición que exigen Dijkstra y A*.

Representación: lista de adyacencia por vértice. Espacio O(V + E), con E <= 8V en una cuadrícula, o sea O(V).

**Cambios dinámicos.** Una barricada llama a `setBlocked(celda, true)`. Solo se reconstruyen las aristas de la celda y de sus 8 vecinas: O(1) por cambio, sin rehacer todo el grafo. Cada cambio real incrementa `graph.version`; así cualquier planificador sabe si una ruta guardada puede estar vieja.

En `map_street` el grafo tiene 284 vértices y 1540 aristas (anillo de calles); en los mapas generados de 50 x 50, unos 2150 vértices y 13 900 aristas.

## 2. Búsqueda de la ruta más corta

Dijkstra y A* comparten una sola implementación, `bestFirstSearch`, que ordena la frontera por f(n) = g(n) + h(n):

- g(n): costo acumulado desde el origen.
- h(n): estimación del costo restante. Dijkstra usa h = 0; A* usa una heurística admisible.

Pseudocódigo:

```
g[*] = infinito; g[s] = 0
abierta = montículo con (s, h(s))
mientras abierta no esté vacía:
    u = extraer mínimo
    si u ya está cerrado o su prioridad es vieja: continuar      # borrado perezoso
    cerrar u; registrar u como expandido
    si u == meta: reconstruir ruta con padre[] y terminar
    para cada arista (u, v, w):
        si g[u] + w < g[v]:
            g[v] = g[u] + w; padre[v] = u
            insertar (v, g[v] + h(v)) en abierta
```

**Montículo binario** (`BinaryHeap`): `push` y `pop` en O(log n), `peek` en O(1). Los empates se rompen por orden de inserción para que los resultados sean deterministas (misma semilla, misma ruta). En lugar de la operación "disminuir clave" se inserta una entrada nueva y se descarta la vieja al sacarla (borrado perezoso); el montículo puede tener hasta E entradas, lo que no cambia la cota asintótica porque log E <= log(8V) = O(log V).

**Complejidad.** Cada vértice se cierra una vez y cada arista provoca a lo sumo una inserción:

| | Tiempo | Espacio |
| --- | --- | --- |
| Dijkstra | O((V + E) log V) | O(V + E) |
| A* con heurística consistente | O((V + E) log V) en el peor caso; en la práctica expande solo los nodos con f < costo óptimo | O(V + E) |
| Reconstrucción de la ruta | O(L), L = largo de la ruta | O(L) |

En una cuadrícula E = O(V), así que ambos quedan en O(V log V). La tabla 1 de [RESULTADOS.md](RESULTADOS.md) divide el tiempo medido entre (V + E) log2 V: la constante resultante se mantiene en el mismo orden (unos pocos nanosegundos por unidad) al pasar de 300 a 2150 vértices, que es lo que predice la teoría.

**Optimalidad.** Dijkstra es óptimo con pesos no negativos. A* es óptimo si h es admisible (nunca sobreestima). Si además h es consistente, ningún nodo cerrado necesita reabrirse; el código cuenta las reaperturas (`reopenedCount`) y los benchmarks verifican que con octile y euclídea son 0 y que el costo coincide con el de Dijkstra en el 100 % de los casos.

## 3. Heurísticas y por qué son admisibles

Sea c_min el menor costo de celda caminable del grafo (`graph.minCellCost`). Cualquier paso cuesta al menos c_min por su largo geométrico, así que el costo real restante es al menos c_min por la distancia de cuadrícula bajo el mismo modelo de movimiento. Por eso cada heurística se multiplica por c_min:

| Heurística | Fórmula (dr, dc = diferencias de fila y columna) | 4 direcciones | 8 direcciones |
| --- | --- | --- | --- |
| Manhattan | c_min (dr + dc) | admisible y consistente (es exacta sin obstáculos) | **no admisible**: un paso diagonal avanza 2 unidades de Manhattan por solo sqrt(2) de costo |
| Octile | c_min (max(dr, dc) + (sqrt(2) - 1) min(dr, dc)) | admisible (menor o igual que Manhattan) | admisible y consistente; es la distancia exacta sin obstáculos, la más informada |
| Euclídea | c_min sqrt(dr^2 + dc^2) | admisible y consistente | admisible y consistente, pero menos informada que octile |

**Consistencia** (h(u) <= w(u, v) + h(v)): cada distancia base cumple la desigualdad triangular y w(u, v) >= c_min * largo(u, v), así que h(u) - h(v) <= c_min * dist(u, v) <= w(u, v).

**Comprobación experimental** (tabla 2 de RESULTADOS): octile y euclídea dan ruta óptima en el 100 % de las búsquedas; Manhattan con 8 direcciones expande muchos menos nodos pero devuelve rutas hasta un 3 % más caras y deja de ser óptima en la mayoría de los mapas. Con 4 direcciones Manhattan vuelve a ser óptima. El juego usa A* con octile por defecto; el panel permite cambiar a Dijkstra en vivo para comparar.

## 4. Replanificación

Los agentes (`src/core/agents/AgentBrain.ts`, frente C) llaman a `findPath` solo cuando:

- cambia su objetivo (nueva evidencia de Mara, señuelo, alerta recibida),
- cambian el algoritmo o la heurística desde el panel,
- el siguiente paso de su ruta quedó bloqueado (por ejemplo por una barricada), caso en que además guardan esa celda en su memoria de celdas bloqueadas, o
- su ruta ya no empieza en su posición.

El benchmark de coste por tick mide cuántas búsquedas son redundantes (mismo origen, destino, algoritmo y versión del grafo que la búsqueda anterior del mismo agente): menos del 0,1 % en todas las configuraciones. Es decir, ya se replanifica solo cuando cambia el objetivo o el grafo.

Para escenarios con más agentes queda disponible `PathCache` (`src/core/algorithms/pathCache.ts`):

- Memoriza resultados por (algoritmo, heurística, origen, destino) con política LRU acotada.
- Se invalida completo cuando cambia `graph.version`, por lo que un acierto devuelve exactamente lo que daría una búsqueda nueva (las búsquedas son deterministas).
- `isPathStillValid(graph, ruta)` comprueba en O(L) si una ruta sigue siendo transitable tras un cambio del grafo; si la barricada cayó lejos, el agente puede conservar su plan.

Uso sugerido en `AgentBrain` (cambio de una línea, a coordinar con el frente C):

```ts
// antes
const search = findPath(graph, algorithm, runtime.position, resolvedTarget, heuristic);
// después (pathCache compartido por el motor)
const search = pathCache.find(graph, algorithm, runtime.position, resolvedTarget, heuristic);
```

## 5. Alertas recursivas acotadas

Cuando un zombi detecta a Mara o un ruido fuerte, avisa por "radio" a los zombis cercanos, que a su vez avisan a los suyos (`propagateAlertRecursive`).

Grafo de comunicación: dos agentes están conectados si su distancia euclídea en celdas es <= `maxRadius` (7 por defecto).

```
propagar(agente, profundidad, señal):
    llamadas++ ; actualizar pila máxima
    si profundidad >= maxDepth o señal < minSignal o agente no puede retransmitir:
        return                                           # casos base
    vecinos = agentes no visitados a distancia <= maxRadius, ordenados por distancia
    si no hay vecinos: return                            # caso base
    para cada vecino v:
        fuerza = señal * decay * (1 - atenuación * distancia / maxRadius)
        si fuerza >= minSignal: marcar v como visitado; registrar salto
    para cada vecino marcado v:
        propagar(v, profundidad + 1, fuerza)             # llamada recursiva
```

**Terminación.** Cada llamada recursiva se hace sobre un agente recién marcado como visitado, y ningún agente se marca dos veces. Por tanto hay como mucho N llamadas para N agentes, y no puede haber ciclos aunque el grafo de comunicación los tenga. Además la profundidad está acotada por `maxDepth` y la señal decrece estrictamente en cada salto (decay < 1), así que hay tres garantías independientes de parada.

**Pila.** La profundidad de la pila de llamadas es como mucho min(N, maxDepth) + 1. Con `maxDepth = 3` (valor del juego) la pila nunca pasa de 4 marcos, sin riesgo de desbordamiento. El resultado expone `maxStackDepth` y `recursiveCalls`, que se ven en el registro del panel y en `alert_results.csv`.

Marcar a todos los vecinos antes de bajar en la recursión hace que la profundidad de cada salto se parezca a la de un recorrido en anchura (BFS): el aviso llega por el camino más corto en saltos y no por cadenas largas.

**Complejidad.** Tiempo O(N^2): cada una de las a lo sumo N llamadas recorre los N agentes para buscar vecinos. Espacio O(N) para el conjunto de visitados y los saltos, más O(min(N, maxDepth)) de pila. Con los 4 a 64 zombis del juego esto cuesta microsegundos (columna `propagation_ms`).

**Aislados contra coordinados.** Con la misma semilla y las mismas posiciones, en modo aislado solo reaccionan los zombis que oyeron el ruido; en modo coordinado se suman los que reciben la alerta. La tabla 4 de RESULTADOS muestra cómo crece la fracción de zombis informados con el límite de profundidad (por ejemplo, en mapas de 32 x 32 pasa de ~12 % aislados a ~33 % con profundidad 8). En `map_street` la diferencia es pequeña porque el anillo es estrecho: casi todos los zombis cercanos al ruido ya lo oyen directamente.

**Percepción local.** Ningún agente lee la posición global de Mara. Solo reaccionan a lo que ven (línea de visión dentro de su alcance), a los `SoundEvent` que oyen (pasos, disparos, puerta, señuelos) y a las alertas recibidas. Las alertas transmiten la posición del ruido o del avistamiento original, nunca la de Mara.

## 6. Coste por tick

`src/benchmarks/tickCost.ts` ejecuta el motor completo (percepción, memoria, planificación, alertas, combate) sin render y mide el tiempo de cada `step()` con 4, 8, 16, 32 y 64 zombis, en modo aislado y coordinado, con Dijkstra y con A*.

Resultados principales (detalle en la sección 5 de RESULTADOS):

- El coste crece casi linealmente con el número de zombis: cada zombi hace a lo sumo una búsqueda por tick, y cada búsqueda en `map_street` cuesta decenas de microsegundos.
- Con 64 zombis y A* el tick medio queda por debajo de 0,5 ms, y el peor p95 de todas las configuraciones (incluido Dijkstra) por debajo de 4 ms, frente a un presupuesto de 385 ms por tick. La IA no limita el rendimiento; el límite es el render.
- A* expande alrededor de la mitad de nodos por tick que Dijkstra dentro del juego.
- El modo coordinado hace más búsquedas por tick porque hay más zombis informados en movimiento: es el comportamiento buscado, no un coste extra del algoritmo de alertas.

## 7. Capa Rayos X

Tab activa la capa (o `?xray=1` en la URL). Se dibuja sobre las paredes y muestra:

| Elemento | Qué representa |
| --- | --- |
| Línea verde / roja / azul | Ruta actual de cada explorador / perseguidor / superviviente |
| Rombo | Destino al que se dirige el agente |
| Cuadros celestes | Nodos expandidos por la última búsqueda de cada agente; más claros donde se solapan varias búsquedas |
| X roja | Celdas que el zombi **cree** bloqueadas (su memoria, no la cuadrícula real) |
| Anillo blanco / magenta / amarillo y línea al agente | Dónde cree el zombi que está Mara: lo vio / lo oyó / se lo dijo una alerta. Más opaco = más confianza |
| Anillo magenta que se expande | Sonido emitido, con su radio real |
| Arcos amarillo, naranja, rojo, violeta | Saltos de la alerta recursiva por profundidad 1, 2, 3, 4+ |

La leyenda aparece arriba a la izquierda con contadores en vivo (agentes, rutas, nodos, bloqueos creídos, saltos y el tiempo que tarda en reconstruirse la capa). **V** enfoca un agente (solo se dibujan su ruta, sus nodos, sus bloqueos y su memoria); **Shift+V** vuelve a todos.

Rendimiento: cada capa usa un único búfer prealocado (`LineSegments` con colores por vértice) o un `InstancedMesh`, y los anillos de sonido salen de un grupo reutilizable de 32 mallas. Reconstruir la capa no crea geometrías ni materiales nuevos; medido en Node con 64 zombis tarda menos de 1 ms por tick. La capa solo se reconstruye cuando está activa y una vez por tick.

El panel de monitoreo (M) complementa la capa: mapa táctico en vivo con Mara, zombis, barricadas y la ruta del agente seleccionado; inspección por agente (estado, objetivo, percepción, heurística, costo, nodos expandidos, tiempo, replanificaciones, celdas que cree bloqueadas) y la comparación en vivo de Dijkstra contra A* sobre el mismo grafo y los mismos extremos.

## 8. Cómo reproducir

```bash
npm test                                   # incluye tests de grafo, búsqueda, heurísticas, caché, alertas y benchmark
npm run benchmark                          # escribe los CSV en src/benchmarks/results/
npm run benchmark -- --reps=10 --ticks=400 # más repeticiones
npm run benchmark -- --no-tick             # solo búsqueda y alertas (rápido)
npx tsx src/benchmarks/report.ts           # regenera docs/RESULTADOS.md y docs/figures/*.svg
```

Archivos de salida:

| Archivo | Contenido |
| --- | --- |
| `benchmark_results.csv` | Una fila por (mapa, repetición, par origen-destino, movimiento, escenario, algoritmo) |
| `benchmark_summary.csv` | Medias y desviaciones por mapa, escenario y algoritmo |
| `alert_results.csv` | Aislados contra coordinados por mapa, semilla y límite de profundidad |
| `tick_cost.csv` / `tick_cost_summary.csv` | Coste por tick según número de zombis, modo y algoritmo |
| `run_metadata.json` | Máquina, versión de Node, semillas y parámetros |
