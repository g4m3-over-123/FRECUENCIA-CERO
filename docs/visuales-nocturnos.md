# Visuales nocturnos

La rama `feat/night-street-visuals` incluye el modelo mejorado y los efectos de render.

## Descargar y ejecutar

Desde un clon limpio del repositorio:

```bash
git fetch origin
git switch feat/night-street-visuals
git pull --ff-only origin feat/night-street-visuals
npm ci
npm run dev
```

Abre la direccion que imprime Vite con `?map=map_street`. El puerto habitual es `http://localhost:5173/?map=map_street`. Pulsa F para encender la linterna.

## Assets y rutas

- `public/maps/map_street.json` apunta a `/assets/props/street_enhanced.glb`.
- `public/assets/props/street_enhanced.glb` incluye las texturas embebidas.
- `public/assets/props/street.glb` es la fuente original para regenerar las texturas.
- `public/maps/map_street.collision.json` contiene las colisiones del mapa.
- La vista previa y el mapa resuelven los assets locales con la ruta base de Vite.

Blender se usa para regenerar el asset. El GLB mejorado ya esta versionado y el juego lo carga directamente.

## Verificacion

```bash
npm test
npm run build
npm run check:assets
```

Para regenerar el modelo desde la raiz del repositorio, con Blender instalado y disponible en PATH:

```bash
blender --background --python-exit-code 1 --python scripts/enhance_street_textures.py
```

El script resuelve las rutas desde su ubicacion y exporta `street_enhanced.glb`.
