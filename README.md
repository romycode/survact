# Survact

Colony survival en frío extremo (Frostpunk + Rimworld + Factorio + ...). Godot 4.7 + C# / .NET 10.
Vista 3D low-poly limpia (resolución nativa, MSAA, caras planas, sombras) con cámara en perspectiva; vista oblicua tipo Factorio disponible.

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
| Rotar cámara | Q / E (en vista oblicua: giros de 90°) |
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
  scenes/                   Main.tscn: RetroView (SubViewport 3D, nativa por defecto) + UI + Debug.
                            world/Heater.tscn, ui/Hud.tscn, debug/*.tscn.
  shaders/lowpoly.gdshader  Material único del mundo: nieve/hielo según el uniform global survact_frost.
  shaders/retro.gdshader    Filtro opcional (apagado): posterizado + dithering Bayer.
  ui/theme.tres             Theme global (Project Settings → GUI → Theme).
  i18n/                     gettext: strings.pot (plantilla generada) + un .po por idioma (es).
  src/Core/                 GameController (dueño del sim, timestep), carga de datos.
  src/World/                Vistas 3D: terreno por chunk, vegetación y colonos con MultiMesh,
                            generador, luz día/noche (LightingRig), cámara orbital (CameraRig).
  src/World/Geometry/       Mallas low-poly en C# puro (sin Godot): terreno con alturas por esquina
                            (rampas + acantilados), pinos, arbustos, peñascos, colonos.
  src/Controls/             Acciones de input y bindings por defecto.
  src/UI/                   HUD.
  src/Debug/                Consola, comandos de desarrollo, overlay F3.
tools/i18n.py               Extrae textos de C# y escenas → .pot, actualiza los .po, comprueba traducciones.
ideas.md                    Backlog de ideas de diseño.
```

## Terreno

Terrazas de altura entera (0–10) generadas con ruido: cordilleras con crestas y nieve perpetua en las
cumbres, mesetas con escarpes y rampas naturales, colinas suaves y lagos en los valles. En el render,
los escalones de un nivel (caminables) se dibujan como **rampas/laderas** y los de 2+ niveles como
**paredes de roca verticales**: lo que parece transitable lo es. Moverse un nivel arriba o abajo
cuesta extra (`terrain.climb_*_cost`); **dos niveles o más es un acantilado infranqueable**, y lo
respetan el A*, las regiones y el flow field (hay test). Hace más frío arriba:
`terrain.lapse_rate_per_level` grados por nivel sobre la temperatura del valle.

## Convenciones (no romper)

1. **El sim no conoce Godot.** Si `Survact.Sim` necesita `using Godot;`, el diseño está mal.
2. **Ningún número de diseño en código.** Balance y propiedades de terreno en `game/data/balance.json`, en unidades humanas (segundos, días). El cargador valida estrictamente: un campo mal escrito, que falte o con valor inválido **impide arrancar** con un error que dice cuál.
3. **Todo cambio al mundo es un `Command`.** Input del jugador, UI, cheats de consola: se encolan con `Simulation.Enqueue`, se validan y aplican al inicio del siguiente tick y quedan en `CommandLog`. Seed + log reproduce la sesión exacta (`Replay.Run`): replays, reportes de bugs, multijugador lockstep.
4. **Determinismo.** Solo `Pcg32` del sim, nada de `System.Random`, `DateTime` ni iterar `Dictionary`/`HashSet` para decidir. Lo vigilan los tests de determinismo y replay.
5. **Godot: "call down, signal up".** Un nodo llama métodos de sus hijos; los hijos avisan con señales, conectadas en la escena. Nodos accedidos con nombres únicos (`%Nombre`), no rutas.
6. **Layout y estilo en escenas y Theme**, no en código. Los scripts de UI solo rellenan datos.
7. **Textos del jugador con `Tr("English text")` / `TrN("singular", "plural", n)`, siempre con literales**: la clave es el texto en inglés y el extractor solo ve literales (`Tr(variable)` no se puede traducir). Nota para traductores con `// TRANSLATORS: ...` en la línea anterior. Labels cuyo texto pone el código: `auto_translate_mode = 2` en la escena. La consola de desarrollo es en inglés y no se traduce.
8. **Nunca un Node por entidad.** MultiMesh para colonos y vegetación, una malla por chunk para el terreno. Los cambios visuales globales (nieve) van por uniform global del shader, no regenerando mallas.
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
| `camera perspective\|oblique` · `pitch <20-85>` | perspectiva (por defecto) u oblicua ortográfica tipo Factorio · inclinación de la vista oblicua |
| `pixel <1-6>` · `retro [on\|off]` | escala de render 3D (1 = nativa, por defecto) · filtro posterizado (apagado por defecto) |
| `seed` · `new [seed]` · `save` · `load` · `overlay` · `clear` | |

El **overlay F3** muestra el coste por sistema, estadísticas de pathfinding y todo lo que el sim sabe del tile bajo el ratón (tipo, cantidad, reserva, región, distancia al almacén).

## Traducciones (gettext)

```bash
python3 tools/i18n.py update      # tras tocar textos: regenera strings.pot y fusiona en cada .po
python3 tools/i18n.py check       # falla (exit 1) si hay textos sin traducir o fuzzy
python3 tools/i18n.py init fr     # nuevo idioma → game/i18n/fr.po; añádelo en Project Settings → Localization
```

Los `.po` se editan con cualquier herramienta estándar (Poedit, Weblate, Crowdin…). Lo que falte por traducir se muestra en inglés.

## Exportar

En el preset de exportación, añade `*.json` en *Filters to export non-resource files* (los datos se leen con `FileAccess` desde `res://`).

## Medido (Linux x64, Release)

| Escenario | Resultado |
|---|---|
| 2000 colonos, mapa 512×512 | ~0.15 ms/tick medio, p99 ~4 ms, 0 bytes asignados en régimen estable |
| 200 colonos, 10 días de juego (72 000 ticks) | ~1.9 s, sin NaN ni reservas huérfanas |
