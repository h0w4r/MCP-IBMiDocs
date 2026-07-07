# Evaluación de desarrollo con bancos de preguntas IBM i / AS400

Este proyecto incluye un harness pequeño para validar la calidad de recuperación y síntesis contra preguntas/respuestas comunitarias de IBM i / AS400.

## Alcance

- Es **solo para desarrollo y QA**.
- No se registra como tool MCP.
- No se instala como recurso para usuarios finales.
- No forma parte del flujo runtime de `ibmi_docs_assist`.
- No reemplaza la documentación IBM/RDi exportada; solo ayuda a detectar regresiones y huecos.

## Fuentes usadas para fixtures de ejemplo

- `https://ibmiskills.com/interviewquestions-1`
- `C:/Users/azast/Downloads/kupdf.net_master-question-bank-as400-iseries.pdf`

El fixture versionado es deliberadamente pequeño:

```text
tests/fixtures/dev-question-bank.sample.json
```

Para bancos completos o privados usa:

```text
data/eval/
tests/eval/generated/
```

Ambas rutas están ignoradas por Git para evitar que material externo pesado o temporal termine dentro del paquete npm.

## Ejecución

```powershell
npm run eval:question-bank
```

Con fixture personalizado:

```powershell
npx tsx scripts/dev-question-bank-eval.ts `
  --fixture data/eval/as400-question-bank.local.json `
  --pack data/pack `
  --min-pass-rate 0.70 `
  --out data/eval/question-bank-report.json
```

## Qué mide

Cada caso valida:

- que la respuesta de `ibmi_docs_assist` contenga al menos una señal esperada;
- que la evidencia/citas estén relacionadas con el tema;
- que no aparezcan términos prohibidos o claramente tangenciales;
- que la cobertura no sea `thin` y la confianza no sea `baja`, salvo que el fixture se use solo para descubrir huecos.

El harness no compara texto literal del banco de preguntas. Eso sería frágil y, peor aún, incentivaría respuestas memorizadas. La meta es comprobar alineación documental y evitar tangentes.

## Interpretación

Un caso fallido no significa necesariamente bug de runtime:

- puede indicar hueco real del corpus;
- puede indicar que la pregunta comunitaria usa terminología no presente en IBM Docs;
- puede indicar que el planner necesita una expansión semántica nueva;
- puede indicar que el fixture espera una respuesta basada en prácticas comunitarias, no documentadas en IBM.

Si el caso representa conocimiento IBM i que sí debería estar cubierto, agrega primero un test RED específico en `tests/repository.test.ts` o amplía el fixture golden correspondiente.
