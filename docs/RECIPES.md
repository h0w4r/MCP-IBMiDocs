# Recetas de uso

Estas recetas usan el contrato que ve un agente normal: una sola tool, `ibmi_docs_assist`, y una
sola respuesta final. No es necesario elegir categorías, buscar IDs ni encadenar lecturas.

## 1. Diagnosticar un mensaje RNF

```json
{
  "question": "Diagnostica RNF0004 durante la compilación de este fuente RPGLE y dime qué revisar.",
  "language": "RPGLE",
  "code": "...fuente relacionado..."
}
```

El MCP recupera internamente la documentación que considere pertinente. Si no encuentra soporte
suficiente para ese mensaje, lo indica directamente en vez de sustituirlo por otro RNF.

## 2. Compilar RPGLE o SQLRPGLE

```json
{
  "question": "¿Cómo compilo este fuente SQLRPGLE con SQL embebido y /COPY?",
  "language": "SQLRPGLE",
  "version": "7.5",
  "code": "...fuente relacionado..."
}
```

No tienes que llamar primero a search, read o sections. `ibmi_docs_assist` realiza la recuperación y
devuelve la orientación técnica final.

## 3. Consultar RPG moderno

```json
{
  "question": "Explica cómo enviar un mensaje al joblog con SND-MSG, %MSG y %TARGET.",
  "language": "RPGLE",
  "version": "7.6"
}
```

La respuesta pública no incluye scores, IDs de chunks, consultas derivadas ni el recorrido interno
por el corpus.

## 4. Crear DDS

```json
{
  "question": "Diseña un PF DDS con una clave compuesta y explica las keywords relevantes.",
  "language": "DDS",
  "version": "7.4"
}
```

Incluye restricciones o decisiones funcionales en `question`; el MCP no puede inferir reglas de
negocio que no estén presentes en la petición.

## 5. Administración IBM i

```json
{
  "question": "¿Cómo reviso los trabajos activos y luego inspecciono el joblog de uno de ellos?",
  "version": "7.5"
}
```

Los nombres de objetos, programas, bibliotecas o tablas propios del servidor pueden enviarse como
contexto. El motor recupera documentación general aplicable sin exigir que esos nombres existan en
el corpus.

## 6. Datos y Db2 for i

```json
{
  "question": "¿Qué tipo de dato de Db2 for i debo usar para almacenar una hora sin fecha y cómo se representa?",
  "version": "7.5"
}
```

Si la documentación relacionada solo está disponible en otro release del data pack, la respuesta
puede usarla, pero debe identificar el release realmente consultado.

## Uso equivalente desde CLI

```powershell
ibmi-docs assist "What is the command used to invoke RLU?"
ibmi-docs assist "¿Cómo compilo un módulo RPGLE?" --language RPGLE --ibmi-version 7.5
```

La CLI imprime solo la respuesta final. El diagnóstico interno se muestra únicamente cuando un
mantenedor lo solicita explícitamente:

```powershell
ibmi-docs assist "¿Cómo compilo un módulo RPGLE?" --language RPGLE --debug-json
```

## Depuración para mantenedores

Las tools de búsqueda, lectura, ranking, calidad y trazas se reservan a perfiles avanzados. No deben
activarse para el uso diario de agentes:

```powershell
$env:IBMI_DOCS_TOOL_PROFILE = 'full'
ibmi-docs-mcp
```

Para medir el mismo contrato que recibe un usuario final, usa las pruebas MCP por `stdio` y el gate
del banco de preguntas. No uses resultados internos de `CorpusRepository` como sustituto de una
llamada MCP real.
