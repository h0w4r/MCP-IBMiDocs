# Contribuir a MCP IBM i Docs

Gracias por colaborar. Este proyecto busca ofrecer un MCP útil para desarrolladores IBM i/AS400 sin depender de RDi, Eclipse Help ni endpoints locales.

## Flujo recomendado

1. Crea una rama desde `main`.
2. Ejecuta instalación limpia:
   ```powershell
   npm ci
   npm run build
   npm test
   npm run smoke
   ```
3. Si cambias ranking o recuperación, actualiza `tests/fixtures/golden-queries.json` y agrega tests.
4. Si cambias ingestión o corpus, reconstruye:
   ```powershell
   npm run build:pack
   npm run pack:validate
   ```
5. No agregues secretos, endpoints locales ni dependencias runtime a RDi.

## Reglas de corpus

- `data/rdi-export` es bootstrap interno de desarrollo.
- `data/pack` puede vivir en el repositorio como snapshot inicial, pero el paquete npm no lo incluye.
- Los data packs de distribución deben publicarse como release assets `.tgz`.
- Mantén URL canónica, fuente, versión, categoría y hash por documento.

## Calidad de búsqueda

Toda mejora al ranking debe proteger consultas golden como:

- `CRTRPGMOD`
- `RNF0004`
- `CLLE`
- `DDS PF physical file`
- `DDS UNIQUE physical logical file`
- `SQLRPGLE embedded SQL /COPY /INCLUDE`

## Aviso legal

No uses logos de IBM ni sugieras respaldo oficial. Mantén `NOTICE.md` actualizado si agregas nuevas fuentes o data packs.
