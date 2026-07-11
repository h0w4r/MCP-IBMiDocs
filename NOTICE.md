# NOTICE

## Proyecto independiente

MCP IBM i Docs es un proyecto comunitario e independiente. No está afiliado, patrocinado, aprobado ni mantenido por IBM.

## Marcas comerciales

IBM, IBM i, AS/400, Rational Developer for i, RDi, Db2 y otros nombres de productos o servicios de IBM mencionados en este repositorio pueden ser marcas comerciales o marcas registradas de International Business Machines Corporation en Estados Unidos y/o en otros países.

El uso de esos nombres es estrictamente nominativo y descriptivo: se usan para identificar tecnologías, documentación técnica y compatibilidad. Este proyecto no usa logotipos de IBM ni elementos de identidad visual de IBM.

Referencia oficial de IBM sobre copyright y marcas:

- https://www.ibm.com/legal/copyright-trademark

## Contenido documental de IBM y terceros

La licencia ISC del repositorio aplica únicamente al código original, scripts, configuración y documentación original creada para este proyecto. No aplica a documentación, publicaciones, ejemplos, páginas, textos, marcas, nombres comerciales ni otros materiales de IBM o de terceros.

Cualquier contenido proveniente de IBM Documentation, IBM Docs, ayuda de IBM Rational Developer for i u otras fuentes de IBM conserva la titularidad y condiciones aplicables de IBM. Este proyecto conserva metadatos de fuente, versión, URL canónica, hashes y manifiestos de cobertura para trazabilidad técnica.

Referencias oficiales relevantes:

- https://www.ibm.com/legal/terms
- https://www.ibm.com/docs
- https://www.ibm.com/legal/copyright-trademark

## Sin respaldo oficial

La publicación de este proyecto, sus índices, data packs o herramientas MCP no implica revisión, aprobación, respaldo ni certificación por parte de IBM.

## Modelo semántico derivado

El modelo local `ibmi-docs/multilingual-e5-base-ibmi-v1` es una adaptación de
[`intfloat/multilingual-e5-base`](https://huggingface.co/intfloat/multilingual-e5-base),
publicado con licencia MIT. La copia de esa licencia viaja junto al modelo en
`models/ibmi-e5-base-finetuned-v1/LICENSE-MIT.txt`. La cabeza neuronal
`ibmi-docs/e5-query-to-corpus-head-v1` transforma embeddings de ese modelo y fue
entrenada contra vectores del data pack IBM i; sus pesos y la misma licencia MIT
viajan en `models/ibmi-neural-query-head-v1/`.

El reranker local deriva de
[`cross-encoder/mmarco-mMiniLMv2-L12-H384-v1`](https://huggingface.co/cross-encoder/mmarco-mMiniLMv2-L12-H384-v1).
Este modelo base se distribuye bajo Apache License 2.0; la copia de la licencia
viaja en `models/ibmi-reranker-finetuned-v1/LICENSE-APACHE-2.0.txt`.
Los datasets externos usados durante el ajuste no se incluyen en el paquete npm ni forman parte del
corpus runtime.

## Solicitudes de corrección o retirada

Si un titular de derechos considera que algún material del repositorio debe corregirse, atribuirse de otra forma o retirarse, puede abrir un issue en el repositorio con los detalles necesarios para revisarlo.
