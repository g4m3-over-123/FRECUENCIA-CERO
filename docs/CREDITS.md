# Creditos de assets

Proyecto academico, sin uso comercial. Se anota de donde viene cada asset para citarlo en la entrega.

| Archivo | Origen (URL) | Autor | Licencia | Agregado por |
| --- | --- | --- | --- | --- |
| `public/assets/props/street.glb` | pendiente | pendiente | pendiente | Diego |
| `public/assets/props/street_felipe.glb` | pendiente | pendiente | pendiente | Felipe |
| `public/assets/props/abandoned_city_street_for_games.glb` | pendiente | pendiente | pendiente | Felipe |
| `public/assets/weapons/dual_mac10_smg_-_animated.glb` | pendiente | pendiente | pendiente | Felipe |
| `public/assets/weapons/fps_character_animation_pack_saps-12.glb` | pendiente | pendiente | pendiente | Felipe |
| `public/assets/weapons/m4_-_fps_weapon_animations_pack_v.1.glb` | pendiente | pendiente | pendiente | Felipe |
| `public/assets/weapons/persuader_animated.glb` | pendiente | pendiente | pendiente | Felipe |
| `public/assets/weapons/sawnoff_animated.glb` | pendiente | pendiente | pendiente | Felipe |
| `public/assets/weapons/sawnoffs_animated.glb` | pendiente | pendiente | pendiente | Felipe |
| `public/assets/characters/william_birkin_stage.glb` | pendiente | pendiente | pendiente | Felipe |
| `public/assets/audio/*.wav` | pendiente | pendiente | pendiente | Physanto |

## Notas

- Los GLB de Felipe se comprimieron al mezclarlos: texturas a 2048 px como maximo y en WebP (`EXT_texture_webp`, Three.js lo carga sin configurar nada). Mallas, esqueletos y animaciones no cambiaron.
- `m4_-_fps_weapon_animations_pack_v.1.glb` usaba `KHR_materials_pbrSpecularGlossiness`, que Three.js ya no soporta. Se convirtio a metal/rugosidad (`gltf-transform metalrough`); mallas y animaciones no cambiaron.
- `william_birkin_stage.glb` pasaba de 44 MB a 14 MB: texturas repetidas eliminadas, animacion remuestreada y texturas en WebP. Mallas, esqueleto y animacion no cambiaron.
