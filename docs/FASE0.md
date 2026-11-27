# Fase 0 - Base de integracion

La base ya corre de punta a punta: caminas en primera persona por `street.glb` con colisiones, los zombis (capsulas por ahora) patrullan con A*, un disparo los atrae sin que te vean, los puedes matar, y el panel de monitoreo y la capa Rayos X muestran datos reales. A partir de aqui cada frente trabaja solo en sus carpetas (ver `AGENTS.md`).

## Como arrancar

```bash
npm install
npm run dev          # http://localhost:5173
npm test             # 60 tests
npm run build
```

Parametros de URL:

| Parametro | Efecto |
| --- | --- |
| `?map=map_street` | Mapa (por defecto). Tambien `map_small`, `map_medium`, `map_large` (sin GLB: se levantan bloques desde la cuadricula) |
| `?mock=1` | Datos falsos en lugar del motor. Para trabajar render, HUD y Rayos X sin depender de gameplay |
| `?seed=1337` | Semilla de la simulacion |
| `?autostart=1` | Salta el dialogo de inicio |
| `?xray=1` | Arranca con Rayos X encendida |

Controles: WASD mover, Shift correr (ruido), C agacharse (silencio), clic disparar (mucho ruido), R recargar, Q senuelo, E barricada, F linterna, Tab Rayos X, G cuadricula, M panel, P pausa, Esc liberar raton.

En desarrollo, la consola del navegador expone `__game` (`__game.loop.latest()`, `__game.weapon.fire()`, `__game.world.toggleGridOverlay()`...).

## Como fluye todo

1. `PlayerController` mueve la camara en metros, choca contra la cuadricula y envia `moveToCell` cuando cambia de celda o de postura.
2. `WeaponController` lanza un rayo desde el centro de la pantalla y envia `fire { hitAgentId }`. El navegador decide que se golpeo; el motor decide dano, municion y ruido.
3. `GameLoop` avanza la simulacion a ticks fijos (`tickMsForMap`: con celdas de 1 m, 385 ms, para que un zombi que avanza una celda por tick corra a 2,6 m/s) y entrega a cada renderer `previous`, `current` y `alpha` para interpolar.
4. `SimulationEngine` (o `MockWorld` con `?mock=1`) produce un `ExtendedWorldSnapshot` por tick.
5. Cada vista lo dibuja: `WorldStateView` (botin, barricadas, senuelos), `AgentCapsules`, `DebugVisuals`, `GameHud` y `MonitorPanel`.

## Que cambio en el nucleo (contratos v2)

- `contracts.ts`: `AgentState` incluye `attack` y `dead`; `AgentSnapshot.health`; `MaraSnapshot.weapon` (`WeaponSnapshot`); `MaraPosture`; `GameCommand`; `MapDefinition.world` (alineacion con el GLB); `GUNSHOT_SOURCE_ID`.
- `SimulationEngine`: `setMaraCell`, `fire`, `reload`, `applyHit`, `applyCommand`. Los zombis muertos no actuan ni propagan alertas. En modo FPV el botin se recoge a 1 celda de distancia.
- `maraController.applyExternalMaraMove`: el motor sigue calculando ruido y estamina segun la postura.
- `weapons.ts`: pistola de 12 balas, 35 de dano, sonido de radio 20 celdas.
- `AgentBrain`: vida por rol (explorador 70, perseguidor 105).
- Los 42 tests originales siguen pasando sin cambios de comportamiento.

## Por donde empieza cada frente

| Frente | Archivo de partida | Contrato que no debe romper |
| --- | --- | --- |
| A. Mundo y jugador | `src/render/world/WorldBuilder.ts`, `src/render/player/PlayerController.ts`, `scripts/generate-street-map.ts` | La cuadricula de `map_street.json` y `world.asset` deben coincidir con lo que se ve |
| B. Personajes, arma, audio | `src/render/characters/AgentCapsules.ts`, `src/render/weapons/WeaponController.ts`, `src/render/AudioManager.ts` | `AgentView` (`src/game/views.ts`); cada objeto golpeable lleva `userData.agentId`; disparar envia `fire { hitAgentId }` |
| C. Gameplay y agentes | `src/core/gameplay/SimulationEngine.ts`, `weapons.ts`, `src/core/agents/` | `SimulationSource` y los tests de `tests/fase0.test.ts` |
| D. Rayos X, HUD, docs | `src/render/debug/DebugVisuals.ts`, `src/ui/GameHud.ts`, `src/ui/MonitorPanel.ts`, `src/benchmarks/` | `DebugView` (`src/game/views.ts`) |

## Decisiones y limitaciones conocidas

- **Escala de `street.glb`.** El modelo original es pequeno (edificios de 2 m de alto, callejones de 1 m). Con escala 1 casi no hay pasos caminables, asi que el mapa se genera a escala 2 (`npm run map:street`). Resultado: 46 x 56 celdas de 1 m, 284 caminables en un anillo de calles alrededor de la manzana central. Frente A puede cambiar la escala y regenerar.
- **La zona jugable es chica para 5 escenas.** Varios patios estan cerrados por vallas y no se conectan al anillo. Frente A debe ampliar el mundo (otro GLB mas grande o varios tramos de calle) o editar el JSON a mano.
- **Colision por celdas de 1 m.** Es aproximada: el jugador puede quedar a unos centimetros de una pared o no entrar en un paso muy estrecho. Frente A puede cambiarla por colision contra mallas manteniendo `moveToCell`.
- **Ruido y balance.** Los radios de sonido y la vista de los zombis estaban pensados para celdas de 2 m. Con celdas de 1 m todo es la mitad de grande. Frente C ajusta.
- **Ataque cuerpo a cuerpo.** El zombi golpea cuando esta en tu misma celda, cada dos ticks (12 de dano el explorador, 18 el perseguidor). Frente C ajusta.
- **El panel tapa la derecha de la pantalla.** M lo oculta.
- **Assets.** `dev-felipe` ya esta mezclado: armas en `public/assets/weapons/`, su calle como `public/assets/props/street_felipe.glb` (el `street.glb` del mapa sigue siendo el de Diego) y `abandoned_city_street_for_games.glb` en props. Todo comprimido por debajo de 15 MB. Todavia no se cargan en el juego: Frente B reemplaza el arma de caja por uno de estos modelos y Frente A decide si usa otra calle. Falta llenar origen y licencia en `docs/CREDITS.md`. Birkin quedo fuera (ver `docs/CREDITS.md`).

## Herramientas

- `npm run map:street`: regenera `public/maps/map_street.json` desde `street.glb`. Opciones: `--cell 1`, `--scale 2`, `--band 0.35,1.9` (franja de altura que bloquea el paso). `DEBUG_CELL="fila,col"` imprime que mallas bloquean una celda.
- `npm run check:assets`: falla si algun archivo de `public/` supera 15 MB.
