# AGENTS.md

## Orquestación obligatoria por defecto

Para toda tarea sustantiva, el agente principal DEBE actuar como coordinador y delegar al menos una subtarea concreta a un agente Codex más pequeño. La orquestación es el modo normal de trabajo de este proyecto y no depende de que el agente considere previamente que la tarea es suficientemente pesada o pequeña.

Esto incluye tareas de análisis, diagnóstico, implementación, corrección, investigación, pruebas, revisión, documentación, despliegue u operación. Incluso cuando el alcance sea reducido, se debe delegar un frente útil —por ejemplo, inspección inicial, búsqueda de referencias, ejecución de pruebas o revisión independiente— mientras el agente principal conserva la coordinación y avanza con el trabajo principal.

La única actividad no sustantiva es una respuesta puramente conversacional que pueda contestarse sin usar herramientas, consultar fuentes, leer o modificar archivos, ejecutar comandos, operar sistemas ni verificar resultados. Una edición localizada, una consulta remota breve o un diagnóstico corto siguen siendo tareas sustantivas y se deben orquestar.

En tareas especialmente pesadas, se deben delegar varios frentes independientes en paralelo. Se considera especialmente pesado cuando se cumple al menos una de estas condiciones:

- requiere explorar varios módulos, servicios o repositorios;
- incluye implementación, pruebas y documentación en frentes separables;
- probablemente demandará más de 10 minutos de trabajo activo;
- exige comparar múltiples alternativas, rastrear muchos archivos o procesar gran cantidad de información;
- contiene dos o más subtareas independientes que pueden ejecutarse sin bloquearse entre sí.

## Estrategia de delegación

1. El agente principal inspecciona primero el alcance, identifica dependencias y define un plan breve de orquestación.
2. Crea o vincula un Run de Orca, registra cada subtarea y la asigna mediante un Dispatch verificable. No describas como orquestado un trabajo ejecutado fuera de la capa de orquestación de Orca.
3. Delega únicamente tareas acotadas, útiles y con un resultado verificable. La delegación no puede ser ornamental: el resultado del agente debe reducir incertidumbre, producir una parte reutilizable o aportar una validación independiente.
4. Prefiere modelos Codex más pequeños para:
   - descubrimiento de código y relevamiento;
   - búsqueda de referencias y documentación;
   - ejecución o análisis de pruebas;
   - implementación mecánica y localizada;
   - revisión de una parte específica del cambio.
5. Reserva el modelo principal para:
   - arquitectura y decisiones ambiguas;
   - integración entre resultados de agentes;
   - manejo de credenciales o datos sensibles;
   - acciones externas, destructivas, irreversibles o con impacto productivo;
   - revisión y validación final.
6. Usa como máximo la concurrencia disponible y evita que dos agentes editen los mismos archivos. Asigna explícitamente propiedad de archivos o áreas cuando haya escrituras paralelas.
7. Entrega a cada agente el contexto mínimo suficiente: objetivo, alcance, archivos permitidos, restricciones, evidencia esperada y criterio de finalización.
8. El agente principal continúa con trabajo útil mientras los agentes delegados avanzan; no debe quedar esperando si existen tareas locales pendientes.
9. Espera el `worker_done` de cada Dispatch, integra sus resultados y libera o reutiliza explícitamente cada worker antes de cerrar la tarea.

## Selección de modelo

- Solicita explícitamente un modelo Codex pequeño o económico para tareas mecánicas, búsquedas, pruebas y cambios localizados de bajo riesgo.
- Usa un modelo intermedio cuando la subtarea requiera razonamiento técnico moderado o cambios en varios archivos bien delimitados.
- Conserva el modelo más capaz para coordinación, decisiones transversales, diagnóstico difícil y validación de alto riesgo.
- No reduzcas el modelo si la subtarea involucra autenticación, secretos, facturación, producción, eliminación de datos o consecuencias legales o financieras.
- Comprueba en el recibo de lanzamiento tanto el modelo solicitado como el modelo efectivo. No afirmes que se usó un modelo pequeño si Orca aplicó otro.
- Si el modelo pequeño solicitado no está disponible, intenta otro modelo Codex económico reconocido por el runtime. Si ninguno puede iniciarse, registra el error exacto, libera cualquier recurso residual y aplica la excepción de infraestructura sin bloquear el trabajo principal.

## Contrato de cada subtarea

Toda delegación debe indicar:

- qué resultado producir;
- qué puede y qué no puede modificar;
- cómo verificarlo;
- qué evidencia devolver;
- cuándo escalar una duda en lugar de asumir.

Los agentes delegados no deben ampliar el alcance, desplegar, publicar, emitir comprobantes, enviar mensajes, usar credenciales ni realizar acciones irreversibles salvo autorización explícita del usuario y asignación expresa del coordinador.

## Integración y control de calidad

El agente principal es responsable de:

- revisar los hallazgos y diffs de cada agente;
- resolver contradicciones entre resultados;
- ejecutar o confirmar las verificaciones relevantes;
- comprobar el estado real después de cualquier mutación autorizada;
- informar al usuario qué se delegó, qué quedó verificado y cualquier límite de evidencia.

La respuesta de un agente delegado nunca constituye por sí sola la aceptación final del trabajo.

## Excepciones limitadas

Sólo se puede omitir la orquestación cuando:

- la interacción es puramente conversacional según la definición anterior;
- el usuario ordena explícitamente no delegar o trabajar con un único agente;
- la infraestructura de orquestación no está disponible después de verificarlo;
- no existe ninguna subtarea segura que pueda delegarse sin exponer secretos o realizar una acción sensible.

Una tarea corta, una edición localizada o el costo de coordinación no son por sí solos motivos válidos para omitirla. Si no hay dos implementaciones paralelizables, delega inspección, pruebas o revisión independiente. Si se aplica una excepción, el agente principal debe informarla brevemente, explicar el motivo concreto y continuar con el trabajo seguro que todavía pueda realizar.

## Bucles caros y comunicación

- Si un mismo enfoque caro falla dos veces seguidas, detente antes del tercer intento y busca una vía de iteración más rápida.
- No acumules más de 10 minutos de trabajo sin un reporte intermedio al usuario: qué se intentó, qué falló, qué sigue y una estimación.
- Antes de volver a consultar recursos remotos, confirma que todavía existen y que sus identificadores siguen vigentes.

## Descubrimiento de código

Cuando el proyecto disponga de codebase-memory-mcp, prioriza sus herramientas de grafo para descubrir código:

1. `search_graph`
2. `trace_path`
3. `get_code_snippet`
4. `query_graph`
5. `get_architecture`

Usa búsqueda textual como respaldo para literales, errores, configuración, archivos no indexados o resultados insuficientes del grafo.
