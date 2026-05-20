# Flujo de contribución de corpus

Este proyecto acepta mejoras de corpus siempre que sean trazables, redistribuibles y útiles para desarrollo IBM i/AS400. No envíes endpoints locales, credenciales, dumps privados ni material cuya redistribución no puedas justificar.

## Estructura esperada

Una contribución documental debe incluir:

```text
manifest.json
raw/
normalized/
```

Cada documento del manifest debe traer, como mínimo:

- `id`
- `title`
- `sourceKind`
- `canonicalUrl`
- `category`
- `version`
- `rawHtmlPath`
- `normalizedTextPath`
- `sha256`

## Validación local

```powershell
node dist/src/cli.js pack lint-contribution --input .\mi-corpus
node dist/src/cli.js build-pack --input data --out data/pack
node dist/src/cli.js pack verify --pack data/pack
npm run bench:golden
```

## Reglas prácticas

- No incluir `127.0.0.1`, `localhost`, `52070` ni rutas de RDi/Eclipse Help como requisitos runtime.
- Mantener categorías existentes cuando sea posible: `ile-rpg`, `cl-clle`, `dds`, `sql-db2-for-i`, `mensajes-rnf`, `ile-cobol`, `ile-c-cpp`.
- Preferir texto normalizado completo, no solo índice o TOC.
- Conservar URL canónica pública cuando exista.
- Si el documento es una redirección o página índice muy corta, marcarlo en notas o evitar que se vuelva evidencia principal.

## Qué revisar antes del PR

1. `npm run build`
2. `npm test`
3. `npm run smoke`
4. `npm run pack:validate`
5. `npm run bench:golden`

Si el benchmark cae, incluye la explicación y las queries afectadas. Los agentes odian las regresiones silenciosas; y nosotros también, solo que con café.
