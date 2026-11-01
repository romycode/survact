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

Construcción por **planos**: lo que tocas o arrastras queda como fantasma (azul = válido, rojo = no: agua, sin alcance o sin recursos) con el coste acumulado, y se construye con **✓ Construir** (`Enter`) o se descarta con **✗** (`Esc`). Con ratón se construye al soltar.

- `Q` mover (por defecto): un dedo mueve la cámara; tocar un edificio abre su ficha.
- `1` cinta · `2` minero · `3` horno · `4` torreta · `5` muro · `X` quitar (devuelve el 100%).
- Cinta/Muro/Quitar: arrastrar traza una **L limpia** desde donde empezaste (no sigue el temblor del dedo). Las cintas salen con dirección y esquina.
- Torreta/Minero/Horno: tocar = plano; tocar el plano otra vez lo gira (o lo quita si no tiene dirección). Arrastrar mueve la cámara.
- Tocar un edificio lo selecciona (ficha con vida, munición, horno… y Girar / Quitar); tocarlo otra vez lo gira.
- `E` / Girar: gira el seleccionado o el último plano. `C` centra en el núcleo.
- `Espacio` oleada · `F` velocidad · `R` reiniciar tras perder.
- Dos dedos: zoom + mover · rueda + botón central · `WASD`.

## HTML dentro del canvas

La ficha del edificio usa **HTML-in-Canvas** (`<canvas layoutsubtree content="drawable">` + `ctx.drawElementImage()`) cuando el navegador lo soporta: se pinta dentro del canvas y sus botones siguen siendo DOM real con hit testing. En 2026 eso es solo Chrome con origin trial o `chrome://flags/#canvas-draw-element`.

En el resto (Safari, Firefox, Chrome estable) la misma ficha es un overlay anclado al edificio con **CSS anchor positioning** (Baseline desde enero de 2026) y `position-try-fallbacks` para no salirse de la pantalla. Si `drawElementImage` lanza error, se cambia sola al overlay.

## Arquitectura

```
src/
  main.ts            loop de timestep fijo (60 ticks), input → cola de comandos, HUD en DOM
  camera.ts          proyección isométrica, zoom/pan, picking inverso
  input.ts           punteros: tap / línea en L / pan / pinch, sobre planos
  plans.ts           planos fantasma: validez, coste acumulado, commit a comandos
  inspector.ts       ficha del edificio: HTML-in-Canvas o overlay con anchor positioning
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
