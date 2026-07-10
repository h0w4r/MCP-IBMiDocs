# Evaluación y dataset de desarrollo con bancos de preguntas IBM i / AS400

Este proyecto incluye un flujo de **dataset de desarrollo** para validar y, más adelante, preparar pares candidatos para fine-tuning del recuperador semántico del MCP.

## Decisión de diseño: Q/A externo, no inventado

Para preguntas y respuestas usamos **fuentes externas trazables**: bancos comunitarios, PDF aportado para QA, páginas públicas candidatas y la API de Stack Exchange.

No generamos respuestas "ground truth" desde el propio corpus del MCP, porque eso contaminaría la evaluación: si el MCP falla por un hueco documental, no queremos entrenarlo con una respuesta fabricada por nosotros y declarar victoria con confeti barato.

Regla práctica:

- **Q/A evaluable**: debe venir de una fuente externa con pregunta y respuesta.
- **Pares sintéticos**, si se crean más adelante: solo sirven como señales auxiliares de retrieval o hard negatives; no como verdad de respuesta.
- **Fine-tuning**: antes de usar una fuente para entrenamiento distribuible, revisar permiso/licencia y conservar atribución.

## Principios

- Es **solo para desarrollo, QA y experimentación de fine-tuning**.
- No se registra como tool MCP.
- No se instala como recurso runtime para usuarios finales.
- No forma parte del data pack documental que consulta `ibmi_docs_assist`.
- No reemplaza IBM Docs ni el corpus oficial exportado; sirve para encontrar regresiones, huecos y preguntas reales formuladas por humanos.
- Las fuentes sin licencia verificada se mantienen como `devOnly` y solo se extraen con `--include-unverified`.

## Archivos principales

```text
tests/fixtures/question-bank.sources.json          # registry auditable de fuentes
tests/fixtures/dev-question-bank.sample.json       # fixture pequeño versionado para ejemplos
tests/fixtures/dev-question-bank.global.json       # fixture histórico de desarrollo
tests/fixtures/dev-question-bank.ibmiskills-cache.json # cache curado reproducible de IBMiSkills
scripts/extract-question-bank.ts                   # extractor/consolidador
scripts/dev-question-bank-eval.ts                  # harness de evaluación contra el MCP real
data/eval/question-bank/                           # salidas locales ignoradas por Git
data/eval/question-bank/cache/                     # cache local ignorado para APIs externas
```

## Registry de fuentes

El registry `tests/fixtures/question-bank.sources.json` separa tres tipos de fuente:

| kind | Uso | Ejemplo |
| --- | --- | --- |
| `fixture` | Cache local curado y reproducible | `ibmiskills-curated-cache` |
| `pdf` | PDF local aportado para QA | `kupdf-master-question-bank` |
| `web` | Fuente pública candidata | Go4AS400, InterviewBit, Adaface, etc. |
| `allinterview` | Fuente comunitaria con ranking por votos | ALLInterview IBM AS400/RPG/DB400 |
| `stackexchange` | Preguntas reales vía API pública | Stack Overflow tags/search IBM i |

Cada fuente declara:

- `id`
- `kind`
- `sourceKind`
- `licenseStatus`
- `licenseNote`
- `redistributable`
- `devOnly`
- `urls` o `path`
- en `stackexchange`: `site`, `tags`, `searchQueries`, `maxPagesPerTag`, `maxPagesPerQuery`

Las fuentes con `licenseStatus: "unknown"` no se extraen por defecto. Requieren `--include-unverified` y sus resultados deben quedarse en `data/eval/`.

La fuente Stack Exchange queda como `open-license` pero `devOnly`; el extractor conserva URL, `questionId`, `answerId`, autor, tags y nota de licencia en cada caso para que podamos auditar atribución.

Política obligatoria para Stack Overflow / Stack Exchange:

- Se prioriza `accepted_answer_id` / `is_accepted` cuando existe.
- Si no hay respuesta aceptada, se elige la respuesta con mayor score positivo.
- No se aceptan respuestas no aceptadas con score `0` o negativo.
- Las caches antiguas sin metadata `selectionPolicy` se filtran por `accepted=true` o `score>=1`, y deben refrescarse con `--refresh-cache` cuando la API deje de aplicar throttle.
- El extractor escribe `selectionPolicy: "accepted-answer-first-else-top-positive-score"` en nuevas extracciones Stack Exchange.

## Cache local de fuentes API

Las fuentes tipo `stackexchange` usan cache local en:

```text
data/eval/question-bank/cache/<source-id>.cases.json
```

Motivo:

- evita quemar cuota de la API en cada ejecución;
- permite repetir gates locales aunque Stack Exchange esté temporalmente limitado;
- mantiene las salidas pesadas fuera del repo y fuera de npm;
- permite refrescar manualmente cuando queramos renovar la bolsa de preguntas.

Para forzar una actualización desde internet:

```powershell
npm run dataset:question-bank:refresh-cache
```

Si la API responde con cuota agotada o límite temporal, el extractor no debe romper toda la generación si existe cache local; usa cache por defecto salvo que se pida `--refresh-cache`.

## Reconstruir dataset confiable

Usa solo fuentes confirmadas o caches curados ya aceptados para desarrollo:

```powershell
npm run dataset:question-bank:trusted
```

Salida local esperada:

```text
data/eval/question-bank/dev-question-bank.trusted.json
data/eval/question-bank/trusted-report.json
```

Ejecución local de referencia antes de ampliar Stack Exchange:

```text
total: 1626
evaluationEligible: 787
bySourceKind:
  ibmiskills-web: 295
  pdf: 1331
```

## Reconstruir dataset extendido local

Incluye fuentes públicas candidatas con licencia todavía no verificada:

```powershell
npm run dataset:question-bank
```

Salida local esperada:

```text
data/eval/question-bank/dev-question-bank.full-local.json
data/eval/question-bank/full-local-report.json
```

Última ejecución local de referencia:

```text
total: 2210
evaluationEligible: 1165
bySourceKind:
  pdf: 1331
  ibmiskills-web: 295
  go4as400-web: 140
  adaface-web: 109
  as400error-blogspot-web: 102
  multisoftvirtualacademy-web: 79
  interviewbit-web: 43
  mytectra-web: 41
  utkrusht-web: 40
  finalroundai-web: 17
  multisoft-web: 11
  nick-litten-web: 2
```

> Nota: algunas fuentes candidatas pueden fallar por TLS, protección anti-bot o cambios de HTML. El extractor no debe romper el flujo completo por una fuente caída; registra el fallo y continúa con las demás.

Última ejecución local de referencia tras ampliar fuentes externas y cache de Stack Exchange:

```text
total: 10416
evaluationEligible: 8612
bySourceKind:
  stackoverflow-api: 2571
  allinterview-web: 2426
  pdfcoffee-web: 2066
  pdf: 1338
  crowdforgeeks-web: 391
  as400error-blogspot-web: 330
  ibmiskills-web: 295
  go4as400-web: 262
  aired-web: 170
  adaface-web: 155
  multisoftvirtualacademy-web: 114
  mytectra-web: 61
  interviewbit-web: 58
  nick-litten-web: 46
  finalroundai-web: 46
  utkrusht-web: 44
  multisoft-web: 43
```

Detalle local por fuente de la misma ejecución:

```text
allinterview-ibm-as400-family-broad   total=2426  eligible=2426
stackoverflow-ibmi-api                total=2571  eligible=2172
pdfcoffee-as400-question-previews     total=2066  eligible=1774
kupdf-master-question-bank            total=1338  eligible=566
crowdforgeeks-as400-family            total=391   eligible=382
as400error-blogspot-series            total=330   eligible=302
ibmiskills-curated-cache              total=295   eligible=295
aired-as400-series                    total=170   eligible=167
adaface-ibm-rpg                       total=155   eligible=125
go4as400-faq                          total=262   eligible=92
```

Última ejecución histórica antes de la expansión amplia:

```text
total: 5055
evaluationEligible: 3330
bySourceKind:
  stackoverflow-api: 2824
  pdf: 1331
  ibmiskills-web: 295
  go4as400-web: 140
  adaface-web: 109
  as400error-blogspot-web: 102
  multisoftvirtualacademy-web: 79
  interviewbit-web: 44
  mytectra-web: 41
  utkrusht-web: 40
  finalroundai-web: 20
  nick-litten-web: 12
  aired-web: 7
  multisoft-web: 11
```

Lectura honesta del número:

- Ya se supera el mínimo de **8K casos elegibles** para QA/fine-tuning experimental local.
- También se supera la meta de **10K casos totales trazables**.
- No se debe rellenar el faltante con respuestas generadas.
- Si una fuente pública queda caída, expirada o protegida, se conserva como candidata pero se reporta la brecha.

## Reconstruir dataset externo sin PDF

Cuando queramos medir únicamente preguntas extraídas desde internet, sin el PDF local:

```powershell
npm run dataset:question-bank:external
```

Salida local:

```text
data/eval/question-bank/dev-question-bank.external-local.json
data/eval/question-bank/external-local-report.json
```

Variante con solo fuentes externas confirmadas/abiertas, sin candidatas `unknown`:

```powershell
npm run dataset:question-bank:trusted-external
```

## Meta de expansión 5K/10K

La meta operativa queda así:

1. **Mínimo útil**: 5K casos Q/A reales o trazables.
2. **Meta preferida**: 10K casos Q/A reales o casi reales.
3. **Criterio de calidad**: no sacrificar trazabilidad por volumen.
4. **Si no llegamos a 5K con respuestas externas confiables**, se reporta como brecha de fuentes, no se rellena con respuestas generadas.
5. **Rotación de gates**: los tests de 100 preguntas deben tomar muestras cambiantes desde la bolsa global de casos externos.

Fuentes externas actuales ampliadas:

- IBMiSkills.
- PDF local aportado para QA.
- Go4AS400.
- AS400 and SQL Tricks, serie ampliada, actualmente puede fallar por disponibilidad/certificado/dominio.
- Stack Overflow vía Stack Exchange API (`ibm-midrange`, `rpgle`, `db2-400` + búsquedas IBM i), con política accepted/top-positive.
- ALLInterview IBM AS400/RPG400/COBOL400/DB400/COOLPLEX como candidato no verificado y devOnly, ordenado por feedback comunitario.
- CrowdforGeeks AS400/IBM AS400/IBM RPG/RPGLE/CL400 como candidato no verificado, usando HTTP plano porque HTTPS falla por certificado.
- Nick Litten AS400/CL como candidato no verificado.
- PDFCoffee previews públicos como candidato no verificado.
- InterviewBit, Multisoft, Adaface, AS400Error Blogspot, Aired, Utkrusht, FinalRoundAI y otros candidatos ya registrados.

## Evaluar el MCP con preguntas reales

El harness levanta el servidor compilado por `stdio` y llama la tool pública
`ibmi_docs_assist`, exactamente como un cliente MCP de usuario:

```powershell
npm run eval:question-bank
```

Con dataset extendido local:

```powershell
npx tsx scripts/dev-question-bank-eval.ts `
  --fixture data/eval/question-bank/dev-question-bank.full-local.json `
  --pack data/pack `
  --sample-size 100 `
  --random-sample `
  --min-pass-rate 0.9 `
  --out data/eval/question-bank/eval-report.json
```

## Qué mide el harness

La automatización comprueba primero el contrato observable:

- exactamente un bloque público de texto;
- ausencia de `structuredContent`, scores, IDs, planes o etiquetas internas;
- respuesta no vacía y ausencia de términos tangenciales conocidos por el fixture;
- presencia de señales esperadas como ayuda de regresión, nunca como juez semántico definitivo.

El umbral automatizado por caso es `0.85` y el gate agregado recomendado exige al menos `90%` de
casos aprobados. Esos números no convierten una comparación textual en razonamiento: después de cada
lote amplio, el mantenedor debe revisar conceptualmente los fallos y una muestra de los aprobados,
comparando el significado de la respuesta pública contra el ground truth.

El reporte se guarda en `data/eval/` y no se publica. No se permite medir una API privada de
`CorpusRepository` y declarar que el MCP de usuario funciona: sería aprobar al doble de riesgo y
mandar al titular a producción. Una pequeña obra de teatro, pero no una prueba.

No buscamos memorizar bancos de entrevista. Buscamos detectar cuándo el MCP se va de paseo turístico por Narnia en vez de recuperar la evidencia correcta.

## Adaptador neuronal y fine-tuning ligero

El runtime incluye una cabeza MLP residual en `models/semantic-query-adapter.*`. Se entrenó sobre
embeddings E5 congelados: no memoriza un diccionario de comandos ni distribuye las preguntas. El
fixture global completo se excluye del entrenamiento; 200 casos sirven para validación y 557 quedan
reservados para prueba final.

Resultado de la prueba retenida usada por el artefacto actual:

- MRR: `0.4853` → `0.6760`;
- top-1: `37.16%` → `55.30%`;
- top-5: `61.40%` → `82.23%`;
- top-10: `69.30%` → `88.33%`.

Para reproducir el entrenamiento en desarrollo:

```powershell
npm run train:query-adapter:embeddings
python -m venv .tmp/train-venv
.\.tmp\train-venv\Scripts\python.exe -m pip install numpy torch `
  --index-url https://download.pytorch.org/whl/cpu
.\.tmp\train-venv\Scripts\python.exe scripts/train-query-adapter.py
```

Los artefactos candidatos quedan en `.tmp/query-adapter-training/`. Solo se copian a `models/`
después de superar el modelo base en el conjunto de prueba retenido y pasar el gate MCP end-to-end.

## Líneas futuras de fine-tuning

El dataset consolidado puede alimentar estas líneas de trabajo:

1. **Query pairs**: pregunta comunitaria → documentos/chunks IBM i recuperados correctamente.
2. **Hard negatives**: pregunta → documentos parecidos pero incorrectos, para enseñar al modelo a no confundirse.
3. **Reranking contrastivo**: pregunta → pasaje directo frente a pasajes temáticamente cercanos pero insuficientes.

No se mantienen clases de intención, diccionarios de anclas ni reglas por comando en runtime. El
entrenamiento futuro debe mejorar el espacio semántico y el reranking sin reintroducir matching
literal disfrazado de inteligencia.

Antes de usar cualquier fuente para fine-tuning distribuible:

- confirmar licencia o permiso;
- guardar evidencia del permiso;
- marcar `redistributable: true` solo cuando corresponda;
- evitar subir contenido completo de fuentes `unknown` al repo o npm.

## Política de commits

Sí se versiona:

- registry de fuentes;
- fixtures pequeños/curados ya existentes;
- scripts de extracción/evaluación;
- documentación del flujo.

No se versiona:

- `data/eval/`;
- reportes locales generados;
- dumps completos de fuentes sin permiso;
- PDFs externos;
- credenciales, cookies o bypasses anti-bot.
