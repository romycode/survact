# survact

Factory + tower defense en tiempo continuo, en un mundo infinito. TypeScript sin motor, render Canvas 2D. Vista 3/4 alineada con el grid: filas horizontales, cámara inclinada para dar volumen (se ve la tapa y la cara frontal de cada edificio).

- **Sin dinero.** Todo se paga con recursos que tienen que llegar al núcleo por cinta.
- **Hierro** → minero → cinta → **horno** → **placas**. Torretas cuestan placas; el resto, hierro.
- **Vetas grandes, finitas y espaciadas.** Una por celda de 30×30 (75%), radio 3–7, más grandes y ricas cuanto más lejos del núcleo (30–60k de hierro). Cerca del núcleo solo hay una veta pequeña de arranque; las buenas están a 25–45 tiles. Los mineros las agotan (la ficha muestra lo que queda).
- **Transporte mejorable.** Cinta (2 tiles/s) y **cinta rápida** (5 tiles/s, 2 Fe + 1 placa). Una cinta lleva un item por tile, así que velocidad = caudal: 4 mineros saturan una cinta normal. La rápida se pone encima de la normal y la mejora en el sitio (cobra la diferencia, mantiene dirección y carga).
- Las torretas disparan munición que les llega por cinta: hierro (4 disparos) o placas (10).
- **Agua** bloquea construcción y enemigos.
- **Estilo cartoon steampunk industrial.** Latón, cobre, hierro remachado y madera aceitada sobre un suelo de musgo con guijarros y algún engranaje perdido; agua verdosa con orillas de tierra. Contornos de tinta sepia. Núcleo = caldera de cobre con cúpula de latón, manómetro y un cristal de éter flotante · muro = baluarte de hierro remachado con remate de latón · minero = torre de perforación con arriostrado y engranaje que gira al trabajar · horno = caldera de cobre con chimenea de hierro y humo · torreta = cúpula de latón con cañón de cobre · enemigos = bichos de cuerda con su llave de latón. UI: placas de hierro con marco de latón y remaches, botones-válvula de latón, rótulos en Alfa Slab One.
- Solo puedes construir a 6 tiles de algo tuyo (zona clara). Los enemigos aparecen más allá de tu edificio más lejano; durante la construcción se ven el punto de spawn y la ruta prevista.
- **Día y noche.** Ciclo de 4 min (≈90 s de noche). De noche los enemigos van un 30% más rápidos y solo se ve lo iluminado: núcleo, torretas con munición, hornos encendidos y mineros. De día las sombras giran con el sol. El ciclo sale del tick de la simulación: la pausa lo para.
- **Tiempo continuo.** La fábrica produce siempre y se construye en cualquier momento. Las oleadas llegan con cuenta atrás (60 s la primera, 40 s desde que sale el último enemigo de la anterior); si vas lento, se solapan. "Llamar ya" adelanta la siguiente. `P` pausa.

```bash
npm i
npm run dev
npm run build:artifact   # dist/survact.html, un único HTML autocontenido (después de vite build)
```

## Controles

El mapa ocupa toda la pantalla; la interfaz flota encima:

- **Arriba:** hierro, placas, vida del núcleo · reloj día/noche · oleada con cuenta atrás y **Llamar**.
- **Dock (abajo):** iconos dibujados con el propio render del juego, con nombre y coste (en rojo si no llega). Tocar la herramienta activa la suelta y vuelves a mover la cámara.
- **Tira de contexto** sobre el dock: qué hace la herramienta y su coste, **Girar** con la flecha actual, y cuando hay planos **✕ / Construir** con el resumen.
- **Botones flotantes** (derecha, anclados al dock con CSS anchor positioning): pausa, velocidad, centrar, quitar.

Construcción por **planos**: lo que tocas o arrastras queda como fantasma (azul = válido, rojo = no: agua, sin alcance o sin recursos) y se construye con **Construir** (`Enter`) o se descarta con **✕** (`Esc`). Con ratón se construye al soltar.

- Sin herramienta: un dedo mueve la cámara; tocar un edificio abre su ficha (tocarlo otra vez lo gira).
- Cinta/Rápida/Muro/Quitar: arrastrar traza una **L limpia** desde donde empezaste; las cintas salen con dirección y esquina.
- Minero/Horno/Torreta: tocar = plano; tocar el plano otra vez lo gira (o lo quita si no tiene dirección).
- Teclado: `1`–`6` herramientas · `X` quitar · `Q` soltar · `E` girar · `C` centrar · `Espacio` llamar oleada · `P` pausa · `F` velocidad · `WASD` cámara.
- Dos dedos: zoom y mover. Ratón: rueda = zoom, botón central = mover, derecho = quitar.

## HTML dentro del canvas

La ficha del edificio usa **HTML-in-Canvas** (`<canvas layoutsubtree content="drawable">` + `ctx.drawElementImage()`) cuando el navegador lo soporta: se pinta dentro del canvas y sus botones siguen siendo DOM real con hit testing. En 2026 eso es solo Chrome con origin trial o `chrome://flags/#canvas-draw-element`.

En el resto (Safari, Firefox, Chrome estable) la misma ficha es un overlay anclado al edificio con **CSS anchor positioning** (Baseline desde enero de 2026) y `position-try-fallbacks` para no salirse de la pantalla. Si `drawElementImage` lanza error, se cambia sola al overlay.

## Arquitectura

```
src/
  main.ts            loop de timestep fijo (60 ticks), teclado/botones → cola de comandos
  hud.ts             HUD en DOM: chips, oleada, dock, tira de contexto, fin de partida
  camera.ts          proyección 3/4 alineada al grid (DEPTH/RISE), zoom/pan, picking inverso
  input.ts           punteros: tap / línea en L / pan / pinch, sobre planos
  plans.ts           planos fantasma: validez, coste acumulado, commit a comandos
  inspector.ts       ficha del edificio: HTML-in-Canvas o overlay con anchor positioning
  render.ts          el dibujo y el renderer Canvas 2D
  terrainLayer.ts    terreno estático pintado por chunks 8×8 en bitmaps (caché LRU)
  sim/               simulación pura: sin DOM ni reloj
    world.ts         estado, cuenta atrás de oleadas, apply(cmd), tick(), economía, spawns
    grid.ts          grid infinito disperso (Map por key empaquetada)
    terrain.ts       terreno procedural por seed: vetas por celdas (cantidad finita), agua
    flowfield.ts     Dijkstra desde el núcleo sobre un rect acotado; agua infranqueable
    defs.ts          datos de balance
    rng.ts           PRNG con seed (mulberry32)
```

Reglas que hay que mantener:

- `sim/` no importa nada del DOM. Se puede ejecutar headless en Node para tests y benchmarks.
- El mundo solo cambia por `apply(cmd)` o `tick()`. Con la seed y el log de comandos se reproduce una partida.
- El render no muta estado.
- `globalThis.__survact` expone `world`, `cam` y `ui` para depurar desde la consola; `__survact.benchRender(n)` da ms/frame y el desglose por fase.

## Vista

`sx = ox + x·s`, `sy = oy + y·s·0.72 − z·s·0.68`. Sin rotación: el suelo es un rectángulo aplastado, cada edificio enseña tapa y cara sur, y se dibuja de norte a sur. Se probó una cámara isométrica giratoria con WebGL2 (está en el historial de git) y en móvil iba peor.

## Rendimiento

El render no repinta lo que no cambia:

- **Terreno** (césped, flores, agua, orillas, vetas, rejilla): se pinta una vez por chunk de 8×8 en un bitmap (`ImageBitmap`, subido a GPU una sola vez) y cada frame es un `drawImage` por chunk. En reposo se pinta al zoom exacto y se copia 1:1 en píxeles enteros; mientras haces zoom se reutiliza escalado y se repinta al soltar (máx. 6 chunks/frame). Las vetas se repintan solo cuando cambia su aspecto (nº de pepitas o agotada). Memoria acotada a ~3 pantallas (LRU).
- **Edificios**: sprite por (tipo, orientación, estado, zoom) — la torreta con 16 ángulos de cañón. Solo el núcleo (gema animada) y el humo del horno se dibujan en vivo.
- **Noche**: máscara de oscuridad a media resolución y halos de luz como sprite precalculado.
- **Sombras**: hexágono analítico por edificio en un único path (antes, envolvente convexa por edificio y frame).

Medido con 676 edificios, 60 enemigos, CPU ×4 más lenta, pantalla de móvil a 3× (Chrome headless con canvas acelerado): de 94–226 ms/frame a 17–26 ms/frame.
