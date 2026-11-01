# survact

Factory + tower defense por oleadas. HTML canvas + TypeScript, sin motor.

```bash
npm i
npm run dev
```

## Controles

- `1` muro · `2` torreta · `X` quitar (o clic derecho). Arrastra para pintar.
- `Espacio` empieza la oleada. `R` reinicia tras perder.

## Arquitectura

```
src/
  main.ts            loop de timestep fijo (60 ticks), input → cola de comandos, resize HiDPI
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
