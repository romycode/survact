# survact

Factory + tower defense por oleadas. HTML canvas + TypeScript, sin motor.

Las torretas solo disparan con munición que les llega por cinta: minero sobre mineral → cintas → torreta.
La fábrica solo corre durante la oleada; la fase de construcción está en pausa.

```bash
npm i
npm run dev
npm run build:artifact   # dist/survact.html, un único HTML autocontenido
```

## Controles

- `3` cinta · `4` minero · `2` torreta · `1` muro · `X` quitar (o clic derecho) · `E` girar.
- Arrastrar pinta muros y cintas; las cintas toman la dirección del arrastre y hacen esquinas solas.
- Tocar una cinta o minero existente lo gira (con cualquier herramienta) y lo selecciona.
- `E` / Girar gira la pieza seleccionada (marco amarillo); también durante la oleada.
- `Espacio` empieza la oleada. `R` reinicia tras perder.
- `F` velocidad x1/x2/x3 · `WASD` mover cámara · rueda: zoom.
- Móvil: tap = construir · arrastrar con Cinta/Muro/Quitar = pintar · dos dedos = zoom y mover.
  En vertical el mapa se traspone (enemigos arriba, núcleo abajo).

## Arquitectura

```
src/
  main.ts            loop de timestep fijo (60 ticks), input → cola de comandos, resize HiDPI
  camera.ts          zoom/pan y trasposición del grid en vertical
  input.ts           punteros: tap vs arrastre vs pinch
  render.ts          solo lectura del mundo, interpolación entre ticks
  sim/               simulación pura: sin DOM ni reloj
    world.ts         estado, fases (build/wave/lost), apply(cmd), tick()
    grid.ts          grid struct-of-arrays (tipo de edificio + hp por tile)
    flowfield.ts     Dijkstra desde el núcleo; los edificios cuestan, no bloquean
    defs.ts          datos de balance
    rng.ts           PRNG con seed (mulberry32)
```

Reglas que hay que mantener:

- `sim/` no importa nada del DOM. Se puede ejecutar headless en Node para tests y benchmarks.
- El mundo solo cambia por `apply(cmd)` o `tick()`. Con la seed y el log de comandos se reproduce una partida.
- El render no muta estado.
- `globalThis.__survact` expone `world`, `cam` y `ui` para depurar desde la consola.
