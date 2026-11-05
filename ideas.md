# Ideas

Backlog de ideas para tener en cuenta. Sin compromiso ni orden: cuando una pase a desarrollo, se mueve al plan de hitos.

## Clima y tiempo

- **Ciclo día y noche.** Hoy solo es visual (tinte del mundo) y una oscilación de temperatura diaria. Falta que tenga peso en el juego: más frío de noche, colonos que necesitan dormir, trabajo nocturno más lento o peligroso.
- **Estaciones.** Mejoran o empeoran la temperatura. Encaja como capa por encima de la curva de clima actual (`climate` en `balance.json`): cada estación desplaza la temperatura base y quizá la duración del día.

## Comida

- **Caza de animales.** Fuente de comida alternativa a la recolección. Implica animales como entidades (movimiento, huida, reproducción) y un trabajo nuevo de cazador.
- **Invernaderos.** Cultivar comida aunque fuera haga frío. Probablemente consumen calor o combustible, lo que los ata a la economía del calefactor.

## Recursos

- **Minas.** Extracción de minerales (hierro, carbón, piedra…). Abre la puerta a cadenas de producción.
- **Agua.** Opciones a valorar:
  - procesar nieve para obtener agua;
  - pozos;
  - ríos que se congelan (con el frío dejan de dar agua, o se vuelven transitables).

## Gestión

- **Asignación de trabajadores.** Fijar cuántos colonos van a cada tarea (leñadores, recolectores, cazadores, mineros…) en lugar de que todo sea autónomo. Encaja con el sistema de decisión actual: la asignación sería una restricción sobre qué trabajos puede elegir cada colono.
