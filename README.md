# survact

Factory + tower defense por oleadas en un mundo infinito. HTML canvas + TypeScript, sin motor. Vista isométrica.

- **Sin dinero.** Todo se paga con recursos que tienen que llegar al núcleo por cinta.
- **Hierro** (vetas marrones) → minero → cinta → **horno** → **placas**. Torretas cuestan placas; el resto, hierro.
- Las torretas disparan munición que les llega por cinta: hierro (4 disparos) o placas (10).
- **Agua** bloquea construcción y enemigos.
- Solo puedes construir a 6 tiles de algo tuyo (zona clara). Los enemigos aparecen más allá de tu edificio más lejano; durante la construcción se ven el punto de spawn y la ruta prevista.
- La fábrica solo corre durante la oleada; la fase de construcción está en pausa.

```bash
npm i
npm run dev
npm run build:artifact   # dist/survact.html, un único HTML autocontenido (después de vite build)
```

## Controles

- `1` cinta · `2` minero · `3` horno · `4` torreta · `5` muro · `X` quitar (devuelve el 100%) · `E` girar · `C` centrar.
- Arrastrar pinta cintas, muros o quitar; las cintas toman la dirección del arrastre y hacen esquinas solas.
- Tocar una cinta/minero/horno lo gira y lo selecciona; `E` / Girar gira el seleccionado (también en oleada).
- `Espacio` oleada · `F` velocidad x1/x2/x3 · `R` reiniciar tras perder.
- Cámara: dos dedos (zoom + mover) · rueda + botón central · `WASD`.

## Arquitectura

```
src/
  main.ts            loop de timestep fijo (60 ticks), input → cola de comandos, HUD en DOM
  camera.ts          proyección isométrica, zoom/pan, picking inverso
  input.ts           punteros: tap vs arrastre vs pinch
  render.ts          suelo con transform afín + prismas proyectados ordenados por profundidad
  sim/               simulación pura: sin DOM ni reloj
    world.ts         estado, fases, apply(cmd), tick(), economía, spawns
    grid.ts          grid infinito disperso (Map por key empaquetada)
    terrain.ts       terreno procedural por seed (hierro, agua)
    flowfield.ts     Dijkstra desde el núcleo sobre un rect acotado; agua infranqueable
    defs.ts          datos de balance
    rng.ts           PRNG con seed (mulberry32)
```

Reglas que hay que mantener:

- `sim/` no importa nada del DOM. Se puede ejecutar headless en Node para tests y benchmarks.
- El mundo solo cambia por `apply(cmd)` o `tick()`. Con la seed y el log de comandos se reproduce una partida.
- El render no muta estado.
- `globalThis.__survact` expone `world`, `cam` y `ui` para depurar desde la consola.
