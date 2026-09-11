# Investigación: Especificidad, Postura y Estructura en el Etiquetado Automático de Karakeep

Registro completo de la investigación sobre por qué el etiquetado automático de
Karakeep (vía `ai-proxy`) generaba etiquetas demasiado genéricas y con sesgo
nominal, qué se intentó para corregirlo, qué funcionó, qué no, y por qué.

---

## 1. Conceptos básicos, para entender el resto del documento

### ¿Qué es `ai-proxy`?
Un servidor intermedio (Node/TypeScript) que se para entre Karakeep y los
proveedores de modelos de lenguaje (LLMs). Cuando Karakeep necesita etiquetar
un bookmark nuevo, le manda la solicitud a `ai-proxy` en vez de al proveedor
directamente. `ai-proxy` intercepta esa solicitud, le agrega instrucciones y
contexto extra (la lista de tags canónicos, reglas de formato), la reenvía a
uno de varios proveedores gratuitos/baratos (Groq, Gemini, OpenRouter,
Cloudflare, Ollama local) según cuál tenga cupo disponible en ese momento, y
al recibir la respuesta la "sanitiza" antes de devolvérsela a Karakeep.

### ¿Qué es un LLM y qué es un "prompt"?
Un LLM (modelo de lenguaje grande) es un sistema que predice texto a partir de
un texto de entrada ("prompt"). No "entiende" reglas como un programa
tradicional — las reglas que le escribimos en el prompt son, en el mejor de
los casos, una influencia fuerte sobre qué texto genera, no una garantía.
Cuantas más reglas simultáneas le pedimos cumplir en un mismo prompt, menos
confiable es que las cumpla todas — esto es un fenómeno documentado (ver
sección 6) y es la causa de fondo de gran parte de esta investigación.

### Modelos "chicos" vs. "grandes"
Los proveedores gratuitos/baratos suelen ofrecer versiones más chicas y
rápidas de sus modelos (menos parámetros, menos capacidad de razonamiento) a
cambio de ser gratis o muy baratas. En este proyecto probamos:
- **Groq** sirviendo `openai/gpt-oss-20b` (chico, ~20 mil millones de
  parámetros).
- **Google Gemini**, en varias versiones: `gemini-flash-lite-latest`,
  `gemini-3.1-flash-lite` (chicos/rápidos) y `gemini-3.5-flash` (más grande,
  mejor razonamiento).
- **OpenRouter** sirviendo `nvidia/nemotron-3-super-120b-a12b:free` (grande,
  ~120 mil millones de parámetros, con razonamiento "visible" — ver más
  abajo).

### "Reasoning" / razonamiento visible (chain-of-thought)
Algunos modelos (Nemotron, entre ellos) generan un bloque de texto donde
"piensan en voz alta" antes de dar la respuesta final, y ese bloque queda
disponible en la respuesta de la API. Esto fue clave en esta investigación:
nos permitió ver el proceso interno de decisión del modelo en vez de
adivinarlo a partir del resultado final.

### JSON Schema / `response_format` / "structured output"
Es un mecanismo de las APIs de LLMs (OpenAI, Groq, Gemini, y por extensión
OpenRouter) para **forzar** que la respuesta tenga una forma exacta —por
ejemplo, un objeto con campos de nombre fijo— en vez de pedirlo con una
instrucción de texto ("respondé con estos campos") que el modelo puede
interpretar mal o ignorar. Cuando el proveedor lo soporta de verdad, la
restricción se aplica a nivel de generación de texto token por token
("constrained decoding"), no como una sugerencia. La diferencia entre "pedirlo
en el texto del prompt" y "pedirlo vía `response_format`" terminó siendo el
cambio de arquitectura más importante de toda esta investigación.

### Kebab-case
Formato de texto en minúsculas con guiones en vez de espacios (ej.
`politica-nacional` en vez de "Política Nacional" o "politica nacional"). Es
el formato que exige tu taxonomía de tags.

### Especificidad vs. genericidad en una etiqueta
Una etiqueta "genérica" es una categoría amplia (`politica`, `economia`) que
podría aplicarse a cientos de artículos distintos. Una etiqueta "específica"
identifica el hecho, caso, documento o mecanismo puntual de *esa* nota en
particular, que no se repetiría en la cobertura genérica del mismo tema. El
**test de unicidad** que usamos en todo este proyecto es: *si esta etiqueta
serviría igual para decenas de artículos distintos sobre el mismo tema
general, no es específica.*

### Lista de tags canónicos (`canonical_tags.json`)
Tu taxonomía personal de ~800 etiquetas ya establecidas, para evitar que cada
artículo nuevo genere variantes léxicas sueltas (`marxismo` vs `marxista` vs
`teoria-marxista`). Se le pasa al modelo como contexto en cada request.

---

## 2. El problema original

Dos fallas detectadas en el etiquetado automático de Karakeep:

1. **Sobre-generalización**: las etiquetas resultantes eran categorías
   paraguas (`cultura`, `marxismo`, `economia`) que no decían de qué trataba
   realmente el artículo.
2. **Sesgo nominal / ceguera de postura**: ante un artículo que criticaba un
   concepto (ej. una nota crítica de la filantropía de multimillonarios), el
   modelo etiquetaba con el nombre neutro del concepto (`filantropia`),
   presentándolo implícitamente como neutral o afirmativo, en vez de reflejar
   que el artículo lo cuestionaba.

---

## 3. Cronología de lo intentado

### Fase 1 — Reglas de texto: estructura de 2 niveles
Se reescribió el bloque de reglas (`rulesText`) inyectado por
`tagEnricher.ts`, pidiendo una estructura fija: **2 etiquetas generales**
(de la lista canónica) + **3 específicas** (fuera de la lista, bajando un
peldaño conceptual). Se encontró y corrigió una contradicción: la regla
original ("solo creá una etiqueta nueva si el tema no está cubierto por algo
más amplio en la lista") funcionaba como un mandato implícito de *no*
generar nada específico, porque la lista de 800 tags siempre tiene algo "más
amplio". Se aclaró que esa regla solo exime de inventar una etiqueta general
redundante, nunca de generar las específicas.

### Fase 2 — Regla de neutralidad de postura
Se agregó la instrucción de que la etiqueta debe reflejar lo que el artículo
*argumenta* (crítica o defensa), no el nombre neutro del concepto.

### Fase 3 — Test de unicidad, y el problema de las reglas ad-hoc
Al detectar que nombres de figuras políticas recurrentes (`cristina-fernandez-de-kirchner`,
`javier-milei`) se colaban como "específicos", se discutió si agregar una
regla dedicada a excluir figuras políticas. Se descartó por no ser
generalizable — una regla por cada categoría de excepción haría crecer el
prompt sin límite y sin garantía de cubrir el próximo caso. En su lugar se
formuló el test de unicidad como principio general y *agnóstico de dominio*
(aplica igual a política, papers científicos, o cualquier tema).

### Fase 4 — Costo de tokens: ¿vale la pena mandar el artículo completo?
Se midió el consumo real de una request: sobre un artículo de referencia de
~1.565 palabras, la lista de 800 tags + reglas costaba ~3.700 tokens, y el
cuerpo completo del artículo ~2.476 tokens (40% del total). Se evaluó
truncar el artículo o pre-filtrar la lista de tags dinámicamente
(comparando candidatos por coincidencia léxica contra el texto), pero se
descartó: el filtrado léxico puede perder tags relevantes sin coincidencia
textual literal (ej. un artículo sobre "precarización laboral" puede no usar
esa palabra ni una vez), reintroduciendo el problema de fragmentación de
taxonomía que se había resuelto en una fase anterior del proyecto. Se
priorizó calidad y cobertura por sobre ahorro de tokens.

### Fase 5 — El artículo de referencia y el primer diagnóstico real
Se estableció un artículo de política argentina (Cristina Fernández de
Kirchner reapareciendo con un documento contra la dolarización, impulsando un
frente de gobernadores para recuperar el "fondo sojero") como caso de prueba
fijo, para poder comparar resultados entre modelos de forma consistente. Un
primer test con una nota sobre el FBI y la NRA reveló que el contenedor de
`ai-proxy` corría código viejo (sin los cambios de reglas), lo cual confirmó
que hacía falta una forma de probar cambios de prompt sin pasar por todo el
pipeline de Karakeep + Docker.

### Fase 6 — Investigación de literatura científica
Ver sección 6 más abajo.

### Fase 7 — De reglas de texto a `response_format` (JSON Schema)
Se investigó soporte de "structured output" en Groq y Gemini. Hallazgo clave:
Gemini soporta `minItems`/`maxItems` en arrays dentro de su JSON Schema, pero
Groq (siguiendo el mismo subconjunto restringido que OpenAI) **no** lo
soporta — así que un array con conteo forzado no es portable entre los dos
proveedores principales. Solución: en vez de un array de 5 tags con conteo
restringido, pedir **5 (luego 6) campos con nombre fijo** (`general_1`,
`general_2`, `especifico_1`...), cada uno un string `required` — el conteo
queda garantizado simplemente porque son campos obligatorios, sin depender
de `minItems`/`maxItems`. Esto sí es portable entre Groq y Gemini (con
`strict: true`).

Esto implicó cambios en ida y vuelta:
- **Ida** (`tagEnricher.ts`): agregar `response_format` al body con el
  schema, además del `rulesText` de siempre.
- **Vuelta** (`sanitizeTaggingResponse`): reconocer el shape nuevo de campos
  nombrados y aplanarlo a `{"tags": [...]}`, que es lo único que Karakeep
  sabe leer — sin importar si el proveedor devolvió el shape nuevo o el
  viejo array plano.
- Se determinó que Cloudflare y Ollama no tienen soporte confirmado de
  structured output parejo, así que `forwardRequest.ts` retira
  `response_format` del body cuando el proveedor activo es uno de esos dos,
  dejándolos depender solo del `rulesText`.

### Fase 8 — Herramienta de testeo manual (`manualTagTest.ts`)
Se construyó un script standalone que reusa la lógica real de
`enrichTaggingRequest()` y `sanitizeTaggingResponse()`, pero permite elegir a
mano el proveedor y modelo, sin pasar por Karakeep ni por la selección
automática de proveedor de `ai-proxy` (que rota según cuál tenga cupo). Esto
permitió comparar el mismo artículo contra distintos modelos de forma
controlada.

### Fase 9 — El bug del `tagsPath` (una trampa de depuración)
Varias rondas de testeo dieron resultados confusos (idioma mezclado, conteo
ignorado, formato viejo con \`\`\`json) hasta que se agregó un modo
`--debug` al script que imprime la respuesta HTTP cruda completa. Eso reveló
que **`response_format` nunca se estaba mandando** — el causante era que
`enrichTaggingRequest()` corta temprano y no agrega nada (ni reglas ni
schema) si no encuentra el archivo `canonical_tags.json` en la ruta
esperada, y el script buscaba ese archivo en una ruta relativa por defecto
que no coincidía con la ubicación real (que vive fuera del directorio
`ai-proxy`, en `karakeep/data/ai-proxy/canonical_tags.json`). Se corrigió el
script para resolver la ruta explícitamente y para fallar rápido con un
mensaje claro si el archivo no existe, en vez de enviar una request
silenciosamente sin enriquecer.

### Fase 10 — Primeros resultados reales con `response_format` funcionando
Con el bug resuelto, se obtuvo el primer resultado realmente bueno:
`gemini-3.5-flash` devolvió los 5 campos exactos, en español, con
específicos que incluían el título literal del documento que había
publicado Cristina Fernández de Kirchner y el mecanismo concreto del "fondo
sojero" — la primera vez que un modelo capturó contenido de la segunda mitad
del artículo. OpenRouter/Nemotron, en cambio, mostró en su razonamiento
visible que escaneaba la lista canónica buscando si los nombres propios
estaban presentes, y en cuanto confirmaba que sí, los usaba como
"específicos" sin aplicar el test de unicidad.

### Fase 11 — Intentos sucesivos de arreglar el patrón de "nombre propio como específico"
Se probaron tres correcciones incrementales, cada una fallando de forma
distinta y reveladora:

1. **Regla anti-reutilización simple** ("si el valor podría ir en un campo
   general, no es específico"): Groq la aplicó, pero solo de forma mecánica
   — chequeó si el valor estaba literalmente en la lista y, al no
   encontrarlo (por error de escaneo sobre 804 ítems), lo dio por válido sin
   aplicar el criterio semántico de fondo.
2. **Separación explícita en Criterio A (mecánico: ¿está en la lista?) y
   Criterio B (semántico: ¿es un tema recurrente aunque no esté en la
   lista?), más un paso de auto-verificación obligatoria**: reveló el hallazgo
   más importante de esta fase — en el razonamiento de Nemotron, el modelo
   escribió textualmente que `cristina-fernandez-de-kirchner` **sí estaba**
   en la lista maestra, y la usó como específica de todas formas, con el
   comentario explícito "but that's okay". No fue un error de comprensión:
   el modelo evaluó la regla correctamente y decidió no aplicarla.
3. **Ejemplo resuelto (mal/bien) genérico** ilustrando exactamente ese
   patrón (protagonista recurrente vs. hecho puntual de la nota): mismo
   resultado. Con esto se concluyó que el problema no es de redacción del
   prompt — es un límite de en qué medida este modelo puntual prioriza
   seguir una instrucción explícita por sobre su propio hábito de extracción
   de entidades, y no hay evidencia de que más texto de prompt lo vaya a
   corregir.

### Fase 12 — Mover el Criterio A del prompt al código
En vez de seguir insistiendo en que el modelo verifique correctamente si un
valor está en la lista de 804 tags (una tarea de recuento/búsqueda sobre una
lista larga, poco confiable para un LLM), se implementó la verificación
**en código**, en `sanitizeTaggingResponse()`: como el proxy ya tiene la
lista completa cargada en memory, compara directamente las etiquetas
específicas devueltas contra un `Set` de la lista canónica normalizada, y
loguea un `WARN` si encuentra coincidencia — sin depender de que el modelo
haya razonado bien. Por ahora solo diagnostica (no descarta la etiqueta
automáticamente), a la espera de ver con qué frecuencia ocurre esto en
tráfico real antes de decidir si conviene auto-corregir.

### Fase 13 — Retroceso deliberado y prueba con un cuarto campo específico
Se confirmó, revisando el primer test de OpenRouter contra el primero de
Gemini, que el patrón de usar nombres propios como "específicos" ya
aparecía en OpenRouter **desde antes** de agregar cualquiera de las reglas
extra — es decir, las rondas de ajuste de prompt (Criterio A/B, ejemplo
resuelto) no explicaban la diferencia entre por qué a Gemini le iba bien y a
OpenRouter no; la diferencia está en el modelo, no en el texto. Se revirtió
el schema a la versión que le había dado buen resultado a Gemini, agregando
un cuarto campo específico (`especifico_4`) para la siguiente ronda de
pruebas con OpenRouter.

### Fase 14 — Confirmación final: la validación en código funciona en un caso real
Después de un intento fallido por un 502 transitorio de la infraestructura
de OpenRouter/Nvidia (no relacionado a este proyecto) y de un bug menor
propio (una frase de recordatorio en `rulesText` que no se había actualizado
al agregar `especifico_4`), se obtuvo el resultado definitivo: sobre el
mismo artículo de referencia, `nemotron-3-super-120b` devolvió
`especifico_1: cristina-fernandez-de-kirchner`, `especifico_2:
javier-milei`, `especifico_3: dolarizacion`, `especifico_4: peronismo`. La
validación de Criterio A en código (Fase 12) detectó y logueó correctamente
que **3 de las 4** (`cristina-fernandez-de-kirchner`, `javier-milei`,
`peronismo`) coinciden literalmente con la lista canónica real de 804
tags — con certeza, sin depender de que el modelo lo note. La cuarta
(`dolarizacion`) no está en la lista pero sigue siendo el tema macro
recurrente de toda la cobertura de la era Milei, por lo que tampoco pasaría
el Criterio B si se pudiera verificar automáticamente. Resultado neto: 0 de
4 etiquetas específicas eran realmente específicas en esa corrida, pese a
que la estructura, el conteo y el idioma salieron perfectos.

Este resultado, sumado a que se probaron **cinco variantes de prompt
distintas** (regla simple → Criterio A/B separados → ejemplo resuelto →
reversión al schema que le funcionó a Gemini → agregar un cuarto campo) sin
que el patrón cambiara en ningún caso, cierra la pregunta que motivó la
Fase 11: no es un problema de redacción de instrucciones — es una prioridad
de fondo de este modelo puntual, estable a través de todas las variantes
probadas.

### Fase 15 — Decisiones de producto tras la confirmación
Con el diagnóstico ya cerrado, quedaron tres decisiones pendientes:

1. **¿Pasar el Criterio A de "solo avisar" a "descartar automáticamente"?**
   Se aclaró que el descarte automático solo puede aplicar al Criterio A
   (mecánico, verificable con un `Set.has()` contra la lista canónica) —
   nunca al Criterio B, que depende de un juicio semántico sobre qué tan
   recurrente es un tema, algo que el código no puede determinar sin
   información adicional (por ejemplo, contar cuántos bookmarks ya usan ese
   tag, algo que `ai-proxy` no consulta hoy). Se decidió **aceptar el
   Criterio B como una limitación conocida**, sin resolver por ahora.
   Sobre el descarte del Criterio A quedó pendiente una decisión de diseño:
   si las 4 etiquetas específicas violan el criterio (como pasó en la Fase
   14), el bookmark quedaría con solo las 2 generales. Se aceptó ese
   escenario como válido — es preferible a dejar pasar etiquetas recicladas
   de la lista general — dejando planteada como mejora futura una
   **segunda pasada** del proxy (una llamada adicional, más liviana, que
   solo intente generar reemplazos para los campos descartados) en vez de
   implementarla ahora.
2. **Prioridad de proveedores**: dado que OpenRouter/Nemotron demostró ser
   sistemáticamente el más débil en este eje específico pese a ser el
   modelo más grande de los tres evaluados, se optó por bajarle prioridad o
   desactivarlo en `PROVIDER_ORDER`, a la espera de evaluar también
   Cloudflare Workers AI (todavía no testeado con este esquema al cierre de
   este documento).
3. **Cierre de la investigación de prompt engineering** para este problema
   puntual — no se seguirán probando variantes de texto contra Nemotron; el
   camino que queda abierto es exclusivamente de arquitectura (segunda
   pasada, o descarte automático del Criterio A).

---

## 4. Diagnóstico por modelo (resumen)

| Modelo | Proveedor | Comportamiento observado |
|---|---|---|
| `openai/gpt-oss-20b` | Groq | Ignoró instrucciones de estructura mientras estuvieron solo en prosa (devolvía 14-17 tags en inglés). Con `response_format`, respetó el conteo y el shape correctamente. Aplica reglas de forma mecánica/literal (chequea "¿está en la lista?") pero no siempre el criterio semántico de fondo. |
| `gemini-flash-lite-latest` / `gemini-3.1-flash-lite` | Google | Consistentemente genérico: 7-9 tags en vez de 5, sin estructura, capturando solo contenido del título/primer párrafo. |
| `gemini-3.5-flash` | Google | El mejor resultado de toda la investigación: respetó el shape de 5-6 campos exacto, en español, y capturó contenido específico de la segunda mitad del artículo (título del documento, mecanismos concretos). Sujeto a alta demanda/disponibilidad variable. |
| `nvidia/nemotron-3-super-120b-a12b:free` | OpenRouter | El modelo más grande probado, con razonamiento visible. Reconoce correctamente las reglas en su razonamiento interno, pero de forma repetida decide no aplicarlas cuando se trata del nombre del protagonista de la nota. Confirmado en Fase 14 con validación en código, a través de cinco variantes de prompt distintas — un fallo de "priorización en la decisión final", no de comprensión, y no corregible con más texto de prompt. Recomendación: baja prioridad en la rotación de proveedores para esta tarea. |

---

## 5. Otros hallazgos técnicos relevantes

- **Idioma**: sin una regla explícita de idioma, Groq y OpenRouter
  respondían en inglés aunque el artículo estuviera en español —
  aparentemente porque su "vocabulario de categorización" por defecto es
  inglés, mientras que los valores extraídos textualmente del artículo
  (nombres propios, términos citados) sí salían en español. Se corrigió con
  una regla de idioma explícita, repetida tanto en el texto de reglas como
  en cada campo del schema.
- **Conflicto de instrucciones remanente**: el prompt original de Karakeep
  contiene la instrucción literal "respond in JSON with the key 'tags'".
  Al agregar `response_format` con campos de otro nombre, esa instrucción
  vieja quedó contradiciendo al schema nuevo. Se agregó una línea explícita
  pidiéndole al modelo que ignore esa instrucción vieja.
- **Bug de orden de ejecución en `manualTagTest.ts`**: el script cargaba
  variables de entorno (`.env`) *después* de que el `import` estático de
  `tagEnricher.ts` ya había fijado en memoria su valor por defecto para la
  ruta del archivo de tags — un problema clásico de módulos ES/CommonJS
  donde los `import` se resuelven antes que cualquier código del archivo
  que importa. Se corrigió resolviendo la ruta explícitamente en el script
  en vez de depender del default interno.

---

## 6. Investigación científica relacionada

Tres líneas de literatura académica conectan con los problemas encontrados
en este proyecto:

**Sesgo político / clasificación de postura en LLMs.** Un estudio de
Carnegie Mellon evaluó si los LLMs clasifican con distinta precisión según
la carga política del enunciado, usando siete modelos y cuatro esquemas de
prompting sobre tres datasets con enunciados políticamente cargados,
encontrando que el rendimiento varía de forma significativa según el tema
tratado, y que empeora cuando el objetivo de la postura está formulado de
forma ambigua — relevante para entender por qué "filantropía" (ambiguo entre
neutro y afirmativo) es más difícil de clasificar correctamente que un
enunciado con postura explícita.
(https://arxiv.org/abs/2407.17688)

Otro trabajo (BERTPOL) propone un clasificador de ideología para medir sesgo
político en respuestas de LLMs sobre temas controvertidos, encontrando una
tendencia mayormente progresista en varios modelos evaluados — un
recordatorio de que el sesgo existe y es medible en cualquier dirección, no
necesariamente en la que uno esperaría de antemano.
(https://link.springer.com/10.1007/978-981-95-4969-6_22)

**Sistemas de etiquetado automático con LLMs contra una taxonomía
controlada.** Un paper de 2025 (LLM4Tag) describe un sistema de etiquetado
con un problema estructuralmente idéntico al de este proyecto: cómo generar
tags precisos cuando existe un repositorio masivo de tags candidatos,
usando un módulo de recall basado en grafos para filtrar candidatos
relevantes antes de generar — la misma idea de pre-filtrado dinámico que se
evaluó y descartó en la Fase 4, pero acá formalizada con un mecanismo más
sofisticado que el matching léxico simple.
(https://arxiv.org/html/2502.13481v2)

Un estudio comparando construcción de taxonomías jerárquicas con LLMs
(fine-tuning vs. prompt engineering) encontró que el prompt engineering
genera bien categorías granulares/específicas con keywords enfocadas, pero
pierde precisión en los niveles más abstractos — el mismo problema de 2
niveles (general/específico) que se trabajó en este proyecto, documentado
de forma independiente.
(https://www.mdpi.com/2673-4117/6/11/283)

**Degradación del cumplimiento de instrucciones con restricciones
múltiples.** Directamente relevante a por qué modelos chicos como
`gpt-oss-20b` y `gemini-flash-lite` cumplieron peor un prompt con 6-7 reglas
simultáneas que un modelo grande: un paper de 2025 (RECAST) muestra que el
cumplimiento de reglas se degrada de forma consistente en todos los modelos
a medida que aumenta la cantidad de restricciones simultáneas en el prompt.
(https://arxiv.org/html/2505.19030)

Otro estudio (XIFBench), evaluando instrucciones multilingües, encontró que
los modelos de capacidad media/baja no solo rinden peor con instrucciones
complejas en general, sino que se degradan de forma más abrupta a medida
que se suman restricciones — coherente con el patrón observado entre Groq
(chico) y Gemini 3.5 (grande) en este proyecto.
(https://arxiv.org/pdf/2503.07539)

Ninguno de estos trabajos aborda exactamente el caso de este proyecto
(bookmarking personal en español, con una taxonomía propia de 800 tags),
pero en conjunto ayudan a explicar por qué cada síntoma apareció donde
apareció: el sesgo nominal tiene precedente documentado, el problema de
"lista larga + generar candidatos específicos" tiene una solución conocida
en la literatura (aunque distinta a la que se optó por implementar acá), y
la degradación con modelos chicos frente a prompts complejos es un patrón
medido y esperable, no una particularidad de este proyecto.

---

## 7. Estado al cierre de este documento

- El pipeline de `response_format` + campos nombrados funciona técnicamente
  en Groq, Gemini y OpenRouter — el conteo y el shape se respetan de forma
  confiable en los tres.
- La calidad del *contenido* específico varía fuertemente por modelo:
  `gemini-3.5-flash` es hoy el más confiable; `gpt-oss-20b` (Groq) es
  aceptable pero con fallas puntuales; Nemotron es el más problemático
  específicamente en el patrón de "nombre propio como específico", pese a
  ser el modelo más grande de los tres — confirmado con evidencia de código
  en tráfico real (Fase 14), no solo con sospecha.
- Ese patrón puntual se investigó a fondo (cinco intentos de prompt
  distintos) y se concluyó, con evidencia suficiente, que no es un problema
  de redacción — es un límite de priorización del modelo que no se resuelve
  agregando más texto. Se cerró esa línea de investigación.
- La validación de Criterio A se movió del prompt (poco confiable) al
  código (determinístico), como principio general: todo lo que se pueda
  verificar con certeza en código no debería depender de que el LLM lo haga
  bien. Hoy solo diagnostica (`WARN` en el log); el Criterio B queda
  aceptado como limitación conocida, sin verificación automática posible
  con la información que el proxy tiene disponible hoy.
- **Pendientes para una próxima iteración**, en orden de lo decidido:
  1. Evaluar Cloudflare Workers AI con el mismo esquema (todavía no
     testeado).
  2. Bajar la prioridad de OpenRouter/Nemotron en `PROVIDER_ORDER`, o
     desactivarlo, dado el patrón confirmado.
  3. Decidir si el Criterio A pasa de "avisar" a "descartar
     automáticamente" — y si se implementa, definir qué hacer con un
     bookmark que se queda sin ninguna etiqueta específica (se aceptó que
     puede pasar, en vez de dejar pasar una etiqueta reciclada).
  4. Eventualmente, una **segunda pasada** del proxy que intente regenerar
     solo los campos descartados, en vez de resignarse a perderlos —
     quedó explícitamente pospuesta, no descartada.
