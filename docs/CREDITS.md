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
| Otros WAV en `public/assets/audio/` | pendiente | pendiente | pendiente | Physanto |
| `public/assets/audio/growl.wav` | https://opengameart.org/content/zombies-sound-pack | artisticdude | CC0 1.0 (Public Domain) | marlon890 |
| `public/assets/audio/zombie_growl_2.wav` | https://opengameart.org/content/zombies-sound-pack | artisticdude | CC0 1.0 (Public Domain) | marlon890 |
| `public/assets/audio/zombie_alert.wav` | https://opengameart.org/content/zombies-sound-pack | artisticdude | CC0 1.0 (Public Domain) | marlon890 |
| `public/assets/audio/zombie_attack.wav` | https://opengameart.org/content/zombies-sound-pack | artisticdude | CC0 1.0 (Public Domain) | marlon890 |
| `public/assets/audio/zombie_hurt.wav` | https://opengameart.org/content/zombies-sound-pack | artisticdude | CC0 1.0 (Public Domain) | marlon890 |
| `public/assets/audio/zombie_death.wav` | https://opengameart.org/content/zombies-sound-pack | artisticdude | CC0 1.0 (Public Domain) | marlon890 |
| `public/assets/audio/zombie_idle.wav` | https://opengameart.org/content/zombies-sound-pack | artisticdude | CC0 1.0 (Public Domain) | marlon890 |
| `public/assets/audio/step.wav` | https://opengameart.org/content/sound-effects-pack | OwlishMedia | CC0 1.0 (Public Domain) | marlon890 |
| `public/assets/audio/ambient.wav` | https://opengameart.org/content/ambient-horror | techiew | CC0 1.0 (Public Domain) | marlon890 |
| `public/assets/props/concrete_road_barrier.glb` | https://polyhaven.com/a/concrete_road_barrier | Amal Kumar | CC0 1.0 | Felipe |
| `public/assets/props/rubble_heap_small.glb` | https://tevy.dev/models/rubble-heap-small | Tevy | CC0 1.0 | Felipe |
| `public/assets/props/wooden_crate_02.glb` | https://polyhaven.com/a/wooden_crate_02 | James Ray Cock y Jurita Burger | CC0 1.0 | Felipe |
| `public/assets/props/metal_trash_can.glb` | https://polyhaven.com/a/metal_trash_can | GurJas Studios | CC0 1.0 | Felipe |
| `public/assets/props/portable_generator.glb` | https://polyhaven.com/a/portable_generator | James Ray Cock | CC0 1.0 | Felipe |
| `public/assets/props/wrecked_ambulance.glb` | https://tevy.dev/models/wrecked-ambulance | Tevy | CC0 1.0 | Felipe |
| `public/assets/props/tyre_and_pallet_barricade.glb` | https://tevy.dev/models/tyre-and-pallet-barricade | Tevy | CC0 1.0 | Felipe |
| `public/assets/props/modular_chainlink_fence.glb` | https://polyhaven.com/a/modular_chainlink_fence | James Ray Cock y Amal Kumar | CC0 1.0 | Felipe |
| `public/assets/props/rollershutter_door.glb` | https://polyhaven.com/a/rollershutter_door | MP | CC0 1.0 | Felipe |
| `public/assets/props/security_light.glb` | https://polyhaven.com/a/security_light | Maximilian Schuster | CC0 1.0 | Felipe |

## Notas

- Los GLB de Felipe se comprimieron al mezclarlos: texturas a 2048 px como maximo y en WebP (`EXT_texture_webp`, Three.js lo carga sin configurar nada). Mallas, esqueletos y animaciones no cambiaron.
- `m4_-_fps_weapon_animations_pack_v.1.glb` usaba `KHR_materials_pbrSpecularGlossiness`, que Three.js ya no soporta. Se convirtio a metal/rugosidad (`gltf-transform metalrough`); mallas y animaciones no cambiaron.
- `william_birkin_stage.glb` pasaba de 44 MB a 14 MB: texturas repetidas eliminadas, animacion remuestreada y texturas en WebP. Mallas, esqueleto y animacion no cambiaron.
- Los siete WAV de Zombies Sound Pack se convirtieron de PCM estéreo de 24 bits a PCM mono de 16 bits. Se mantuvo la frecuencia de 44,1 kHz y se normalizaron los picos a aproximadamente −1 dBFS para la reproducción espacial con Web Audio.
- `step.wav` proviene de `Footsteps/hard-footstep1.wav` (Sound Effects Pack, OwlishMedia, CC0): recortado en silencios extremos con fundidos cortos y normalizado a -1.4 dBFS en PCM mono de 16 bits a 44.1 kHz para reproduccion espacial. `ambient.wav` proviene de `ambient_horror.wav` (Ambient horror, techiew, CC0): procesado con crossfade de potencia constante de 0.75 s para bucle continuo sin cortes y normalizado a -1.9 dBFS en PCM estereo de 16 bits a 48 kHz.
- La barrera, la caja, el bote y el generador usan el glTF de Poly Haven con texturas 1K, empaquetado en GLB. Los escombros usan el LOD1 de Tevy con geometría sin compresión Meshopt y texturas PNG.
- La valla, la persiana y la lámpara usan texturas de 1K de Poly Haven empaquetadas en GLB. La ambulancia y la barricada usan el LOD1 de Tevy con geometría sin compresión Meshopt y texturas PNG.
