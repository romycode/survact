# Survact

Colony survival en frío extremo (Frostpunk + Rimworld + Factorio + ...). Godot 4.7 + C# / .NET 10.

## Requisitos

- **Godot 4.7.1 .NET** (la build ".NET", no la estándar). En Mac: `mono_macos.universal.zip`.
- **.NET 10 SDK**.
- Si cambias de versión de Godot, iguala `Godot.NET.Sdk/x.y.z` en `game/Survact.Game.csproj`.

## Ejecutar

```bash
# Tests headless: datos, determinismo, comandos/replay, save/load, soak de 10 días, rendimiento
dotnet run -c Release --project tests/Survact.Sim.Tests
dotnet run -c Release --project tests/Survact.Sim.Tests -- replay   # filtrar por nombre

# Juego: abre game/project.godot en el editor y pulsa F5
```

## Controles por defecto

| Acción | Tecla |
|---|---|
| Mover cámara | WASD / flechas · botón central arrastra |
| Zoom | rueda · `=` / `-` |
| Pausa · velocidad x1/x3/x10 | Espacio · 1 / 2 / 3 |
| Guardar · cargar | F5 · F9 |
| Mundo nuevo | Ctrl+N |
| Consola de desarrollo | tecla a la izquierda del 1 (`º` en teclado español) o F1 |
| Overlay de debug | F3 |

Son **acciones del Input Map** con **teclas físicas** (`src/Controls/`): funcionan igual en QWERTY, AZERTY o teclado español, y lo configurado en *Project Settings → Input Map* tiene prioridad sobre los defaults del código. La ayuda del HUD se genera desde los bindings reales.

## Estructura

```
src/Survact.Sim/            Simulación. C# puro: sin Godot, sin paquetes NuGet.
  Simulation.cs             Step() a 30 Hz fijo. Aplica comandos y luego sistemas, en orden fijo.
  Data/                     Carga y validación de game/data/*.json → Balance "horneado" por tick.
  Commands/                 Command (entrada única al sim), CommandProcessor (validación), Replay.
  World/                    TileMap (+ TileTable desde datos), WorldGen determinista.
  Entities/Colonists.cs     Struct-of-arrays. Borrado swap-remove (índices NO estables).
  Systems/                  Climate, Heater, Needs, Think, Movement, Work, Death.
  Pathfinding/              A*/Dijkstra sin allocs, Regions (alcanzabilidad O(1)), FlowField.
  Persistence/              SaveGame (binario versionado) + StateHasher.
tests/Survact.Sim.Tests/    Runner de consola contra los datos reales del juego. Código 1 si falla.
game/                       Proyecto Godot. Solo presentación.
  data/balance.json         TODO el balance y las propiedades de terreno. Editable sin recompilar.
  scenes/                   Main.tscn compone World + UI + Debug. ui/Hud.tscn, debug/*.tscn.
  ui/theme.tres             Theme global (Project Settings → GUI → Theme).
  i18n/strings.csv          Textos del jugador (es, en). Godot lo importa como traducciones.
  src/Core/                 GameController (dueño del sim, timestep), carga de datos.
  src/Controls/             Acciones de input y bindings por defecto.
  src/World/                Renderers: terreno por chunk, colonos con MultiMesh, overlay, cámara.
  src/UI/                   HUD.
  src/Debug/                Consola, comandos de desarrollo, overlay F3.
tools/gen_buildings.py      Generador procedural de sprites (arte de prototipo).
ideas.md                    Backlog de ideas de diseño.
```

## Convenciones (no romper)

1. **El sim no conoce Godot.** Si `Survact.Sim` necesita `using Godot;`, el diseño está mal.
2. **Ningún número de diseño en código.** Balance y propiedades de terreno en `game/data/balance.json`, en unidades humanas (segundos, días). El cargador valida estrictamente: un campo mal escrito, que falte o con valor inválido **impide arrancar** con un error que dice cuál.
3. **Todo cambio al mundo es un `Command`.** Input del jugador, UI, cheats de consola: se encolan con `Simulation.Enqueue`, se validan y aplican al inicio del siguiente tick y quedan en `CommandLog`. Seed + log reproduce la sesión exacta (`Replay.Run`): replays, reportes de bugs, multijugador lockstep.
4. **Determinismo.** Solo `Pcg32` del sim, nada de `System.Random`, `DateTime` ni iterar `Dictionary`/`HashSet` para decidir. Lo vigilan los tests de determinismo y replay.
5. **Godot: "call down, signal up".** Un nodo llama métodos de sus hijos; los hijos avisan con señales, conectadas en la escena. Nodos accedidos con nombres únicos (`%Nombre`), no rutas.
6. **Layout y estilo en escenas y Theme**, no en código. Los scripts de UI solo rellenan datos.
7. **Textos del jugador con `Tr("CLAVE")`** y la clave en `i18n/strings.csv`. Nunca strings literales en la UI. (La consola de desarrollo es en inglés y no se traduce.)
8. **Nunca un Node por entidad.** MultiMesh para entidades, textura por chunk para terreno.
9. **Datos en arrays, lógica en sistemas.** IA con presupuesto por tick, nunca proporcional a la población.
10. **Todo estado nuevo entra en SaveGame y StateHasher** y sube `SaveGame.Version` si cambia el formato.

## Consola de desarrollo

`help` lista todo. Los comandos que tocan el mundo pasan por la cola de comandos (quedan en el log de replay):

| Comando | Qué hace |
|---|---|
| `spawn <n> [x y]` | crea colonos (por defecto en el almacén) |
| `give wood\|food <n>` | añade o quita stock |
| `cold <grados>` | desplaza la curva de temperatura |
| `speed 1\|3\|10` · `pause` · `step [ticks]` | control del tiempo; `step` avanza en pausa |
| `goto x y` | centra la cámara |
| `hash` | hash del estado completo: compara máquinas o replays |
| `log` | log de comandos de la sesión |
| `seed` · `new [seed]` · `save` · `load` · `overlay` · `clear` | |

El **overlay F3** muestra el coste por sistema, estadísticas de pathfinding y todo lo que el sim sabe del tile bajo el ratón (tipo, cantidad, reserva, región, distancia al almacén).

## Exportar

En el preset de exportación, añade `*.json` en *Filters to export non-resource files* (los datos se leen con `FileAccess` desde `res://`).

## Medido (Linux x64, Release)

| Escenario | Resultado |
|---|---|
| 2000 colonos, mapa 512×512 | ~0.15 ms/tick medio, p99 ~4 ms, 0 bytes asignados en régimen estable |
| 200 colonos, 10 días de juego (72 000 ticks) | ~1.9 s, sin NaN ni reservas huérfanas |
