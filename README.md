# Z3R0-FRECUENCY

Shooter en primera persona por una ciudad nocturna tomada por zombis. Mara tiene un arma, pero cada disparo despierta a la ciudad: los zombis no saben dónde está, solo reaccionan a lo que ven, a lo que oyen y a las alertas que se pasan por radio entre ellos. Detrás de cada movimiento hay un grafo ponderado, Dijkstra o A* y una propagación recursiva de alertas que se puede ver en vivo con la capa Rayos X.

Proyecto académico (sin uso comercial). Peso de la evaluación: 70 % algoritmos y agentes.

## Requisitos

- Node.js 20 o superior (probado con Node 24).
- Un navegador con WebGL 2 (Chrome, Firefox, Edge).

## Instalar y jugar

```bash
npm install
npm run dev        # abre http://localhost:5173
```

Haz clic en "Iniciar partida" y luego en la pantalla para capturar el ratón.

| Tecla | Acción |
| --- | --- |
| WASD | Moverse |
| Shift | Correr (hace ruido) |
| C | Agacharse (silencio) |
| Clic | Disparar (mucho ruido: atrae a la horda) |
| R | Recargar |
| Q | Lanzar señuelo sonoro |
| E | Poner barricada (el grafo se actualiza y los zombis replanifican) |
| F | Linterna |
| Tab | Rayos X: rutas, nodos expandidos, sonidos, alertas, lo que cree cada zombi |
| V / Shift+V | En Rayos X: enfocar el siguiente zombi / ver todos |
| G | Ver la cuadrícula lógica sobre el mundo |
| M | Mostrar u ocultar el panel de monitoreo (libera el ratón) |
| P | Pausa |
| Esc | Liberar el ratón |

Parámetros de URL:

| Parámetro | Efecto |
| --- | --- |
| `?map=map_street` | Mapa (por defecto). También `map_small`, `map_medium`, `map_large` |
| `?seed=1337` | Semilla de la simulación (misma semilla, misma partida) |
| `?xray=1` | Arranca con Rayos X encendida |
| `?autostart=1` | Salta el diálogo de inicio |
| `?mock=1` | Datos falsos en lugar del motor (para trabajar el render sin la IA) |

## Empaquetar para entregar (doble clic)

```bash
npm run package    # genera release/Z3R0-FRECUENCY.zip
```

El .zip trae el juego compilado y un lanzador por sistema: `Jugar-Mac.command` (Apple Silicon e Intel), `Jugar-Windows.exe` y `Jugar-Linux`. El lanzador levanta un servidor local y abre el navegador (abrir `index.html` directo no funciona: el navegador bloquea los mapas y modelos desde `file://`). Las instrucciones para quien lo recibe estan en `packaging/LEEME.txt`. La primera vez descarga Go en `packaging/.cache` para compilar los lanzadores.

## Prueba de aceptación en vivo

1. Abrir `http://localhost:5173/?xray=1` e iniciar la partida.
2. Lanzar un señuelo (Q) lejos de Mara: los zombis que lo oyen cambian de ruta hacia el ruido (líneas de color en Rayos X) sin conocer la posición de Mara.
3. Disparar (clic): el anillo magenta muestra el radio del sonido y los arcos de colores muestran la alerta recursiva entre zombis.
4. Poner una barricada (E) en la ruta de un zombi: la celda queda bloqueada en el grafo, el zombi la marca como bloqueada (X roja) y replanifica.
5. En el panel (M), pulsar "Algoritmo" para cambiar entre Dijkstra y A*: la tabla "Dijkstra vs. A*" compara costo, nodos expandidos y tiempo sobre el mismo grafo y los mismos extremos.

## Pruebas y benchmarks

```bash
npm test                          # tests de grafo, algoritmos, agentes y base de integración
npm run build                     # chequeo de tipos y build de producción en dist/
npm run benchmark                 # Dijkstra vs A*, alertas aisladas vs coordinadas y coste por tick (CSV)
npx tsx src/benchmarks/report.ts  # tablas y gráficas en docs/RESULTADOS.md y docs/figures/
npm run check:assets              # ningún archivo de public/ mayor a 100 MB
```

## Documentación

| Documento | Contenido |
| --- | --- |
| [docs/ALGORITMOS.md](docs/ALGORITMOS.md) | Grafo, Dijkstra y A*, heurísticas admisibles, recursión y pila, complejidad, Rayos X |
| [docs/RESULTADOS.md](docs/RESULTADOS.md) | Resultados experimentales: complejidad teórica contra medida, comparativas y gráficas |
| [docs/FASE0.md](docs/FASE0.md) | Cómo está montada la base de integración (bucle de juego, contratos, mock) |
| [AGENTS.md](AGENTS.md) | Reglas de arquitectura y qué carpetas son de cada frente |
| [docs/CREDITS.md](docs/CREDITS.md) | Origen y licencia de cada asset |

## Arquitectura en una frase

`src/core/` es un núcleo sin navegador (grafo, algoritmos, agentes, gameplay) que produce un `WorldSnapshot` por tick y recibe `GameCommand`; `src/render/` y `src/ui/` solo dibujan ese snapshot con Three.js y el DOM. Por eso la IA se prueba y se mide en Node con `npm test` y `npm run benchmark`.

```
src/
  core/graph/        grafo ponderado, generador de mapas con semilla, cargador de mapas
  core/algorithms/   montículo binario, Dijkstra, A*, heurísticas, caché de rutas, alertas recursivas
  core/agents/       percepción local, memoria, cerebro del agente, dispersión de horda
  core/gameplay/     motor de simulación, escenas, Mara, armas
  core/world/        conversión metros <-> celdas
  game/              bucle de ticks fijos con interpolación
  render/            escena FPV, mundo, jugador, personajes, arma, audio, Rayos X
  ui/                HUD de juego y panel de monitoreo
  benchmarks/        benchmarks headless y generador del reporte
```

## Equipo

| Frente | Responsable |
| --- | --- |
| A. Mundo, escenas y jugador | Diego |
| B. Personajes, arma y audio | Felipe |
| C. Gameplay y agentes | marlon890 |
| D. Algoritmos, Rayos X, HUD y documentación | Physanto |
