# Evaluación y dataset de desarrollo con bancos de preguntas IBM i / AS400

Este proyecto incluye un flujo de **dataset de desarrollo** para validar y, más adelante, preparar pares candidatos para fine-tuning del recuperador semántico del MCP.

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
```

## Registry de fuentes

El registry `tests/fixtures/question-bank.sources.json` separa tres tipos de fuente:

| kind | Uso | Ejemplo |
| --- | --- | --- |
| `fixture` | Cache local curado y reproducible | `ibmiskills-curated-cache` |
| `pdf` | PDF local aportado para QA | `kupdf-master-question-bank` |
| `web` | Fuente pública candidata | Go4AS400, InterviewBit, Adaface, etc. |

Cada fuente declara:

- `id`
- `kind`
- `sourceKind`
- `licenseStatus`
- `licenseNote`
- `redistributable`
- `devOnly`
- `urls` o `path`

Las fuentes con `licenseStatus: "unknown"` no se extraen por defecto. Requieren `--include-unverified` y sus resultados deben quedarse en `data/eval/`.

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

Última ejecución local de referencia:

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

## Evaluar el MCP con preguntas reales

El harness llama al flujo real de asistencia documental contra el pack local:

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

Cada caso valida de forma conceptual/semántica asistida por señales, no por comparación literal:

- respuesta relacionada con la intención de la pregunta;
- evidencia documental alineada;
- ausencia de términos claramente tangenciales;
- confianza y cobertura razonables;
- capacidad de responder con documentación IBM i sin inventar.

No buscamos memorizar bancos de entrevista. Buscamos detectar cuándo el MCP se va de paseo turístico por Narnia en vez de recuperar la evidencia correcta.

## Uso futuro para fine-tuning

El dataset consolidado puede alimentar tres líneas de trabajo:

1. **Query pairs**: pregunta comunitaria → documentos/chunks IBM i recuperados correctamente.
2. **Hard negatives**: pregunta → documentos parecidos pero incorrectos, para enseñar al modelo a no confundirse.
3. **Intent labels**: pregunta → intención (`compile_guidance`, `db2_sql`, `dds`, `clle`, `job_management`, etc.).

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
