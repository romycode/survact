# Survact

Colony sim (Frostpunk + Rimworld + Factorio + ...) — Godot 4.7 + C# / .NET 10.

## Requisitos

- **Godot 4.7.1 .NET** (la build "Mono/.NET", no la estándar).
- **.NET 10 SDK**.
- Si cambias de versión de Godot, iguala `Godot.NET.Sdk/x.y.z` en `game/Survact.Game.csproj`.
  Si el editor se queja de `net10.0`, prueba `net9.0`; la simulación no depende de ello.

## Ejecutar

```bash
# Tests headless (determinismo, save/load, soak de 10 días, presupuesto de rendimiento)
dotnet run -c Release --project tests/Survact.Sim.Tests
dotnet run -c Release --project tests/Survact.Sim.Tests -- perf   # filtrar por nombre

# Juego: abre game/project.godot en el editor y pulsa F5
```

Controles: WASD/flechas · rueda zoom · botón central arrastra · ESPACIO pausa · 1/2/3 velocidad x1/x3/x10 · F5 guardar · F9 cargar · N mundo nuevo.

## Estructura

```
src/Survact.Sim/          C# puro. Sin Godot, sin paquetes NuGet. TODO el estado del juego vive aquí.
  Simulation.cs          Step() a 30 Hz fijo. Orden de sistemas = contrato.
  SimBalance.cs          Todos los números de balance.
  World/                 TileMap (arrays planos + versión por chunk), WorldGen (ruido determinista).
  Entities/Colonists.cs  Struct-of-arrays. Borrado swap-remove (índices NO estables).
  Systems/               Climate, Heater, Needs, Think, Movement, Work, Death.
  Pathfinding/           A*/Dijkstra sin allocs, Regions (alcanzabilidad O(1)), FlowField (destinos compartidos).
  Persistence/           SaveGame (volcado binario) + StateHasher (hash de todo el estado).
tests/Survact.Sim.Tests/  Runner de consola. Sale con código 1 si algo falla: listo para CI.
game/                    Proyecto Godot. Solo presentación: lee el estado del sim y lo dibuja.
```

## Reglas de arquitectura (no romper)

1. **El sim no conoce Godot.** Si `Survact.Sim` necesita `using Godot;`, el diseño está mal.
2. **Determinismo.** Solo `Pcg32` del sim, nada de `System.Random`, `DateTime` ni iterar `Dictionary`/`HashSet` para decidir.
   El test de determinismo lo vigila.
3. **Nunca un Node por entidad.** MultiMesh para entidades, textura por chunk para terreno.
4. **Datos en arrays, lógica en sistemas.** Cada sistema es un bucle sobre arrays planos.
5. **Coste de IA acotado por presupuesto**, nunca por población: nodos de búsqueda por tick, round-robin.
6. **Destinos compartidos = flow field**, no un A* por colono.
7. **Todo estado nuevo entra en SaveGame y StateHasher.** Si no, el test de save/load lo detecta.
8. **El test de rendimiento es parte del build.** Si un cambio rompe el presupuesto, se ve el mismo día.

## Medido (sandbox Linux x64, Release)

| Escenario | Resultado |
|---|---|
| 2000 colonos, mapa 512×512 | 0.16 ms/tick medio, p99 4.6 ms, 0 bytes asignados en régimen estable |
| 200 colonos, 10 días de juego (72 000 ticks) | 1.8 s, sin NaN ni reservas huérfanas |

## Siguientes pasos

- Balance real (ahora hay madera de sobra; los números de `SimBalance` son provisionales).
- Comandos del jugador (designar zonas de tala/recolección, construir) como cola de comandos aplicada en `Step()`.
- Edificios y cadenas de producción → sistema nuevo + capa de datos en `TileMap`.
- Sim en hilo propio con doble buffer de snapshot cuando el render y el sim compitan por el frame.
- Rendering: escribir `MultiMesh.Buffer` de una vez en lugar de setters por instancia.
- Tileset pixel art + fuente pixel en un `Theme` para cerrar el estilo retro.
