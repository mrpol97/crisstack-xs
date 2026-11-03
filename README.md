# CrisStack XS

Herramienta propia de DIT / gestión de medios, escrita desde cero (Electron + Node + ffmpeg).
No contiene ni usa código de ningún otro producto.

## Ejecutar

```bash
npm install
node node_modules/electron/install.js   # descarga el binario de Electron si hace falta
npm start
npm test                                # tests del motor
```

## Instalar el .dmg (Mac)

El `.dmg` lo construye GitHub Actions (`.github/workflows/build-mac.yml`) y queda en la sección **Releases** del repositorio:
`arm64` para Apple Silicon (M1 o posterior) y `x64` para Intel. La app no está firmada con un certificado de Apple,
así que la primera vez:

1. Abre el dmg y arrastra **CrisStack XS** a Aplicaciones.
2. Clic derecho sobre la app → **Abrir** → **Abrir**.
3. Si macOS dice que "está dañada", ejecuta en Terminal: `xattr -cr "/Applications/CrisStack XS.app"`

## Construirla tú en el Mac

En el Mac, con Node 20+ instalado:

```bash
npm install
npm run dist:mac        # genera un .dmg en dist/
```

La primera vez, macOS pedirá abrirla con clic derecho → Abrir (no está firmada).

## Qué hace (v0.1)

- **Offload**: una sola lectura del origen, escritura simultánea en N destinos, hash XXH64 / MD5 / SHA-1 / SHA-256,
  relectura de cada destino para verificar, conserva fechas, cancelable. Ignora `.DS_Store` y similares.
- **Comodines de ruta**: `{project} {day} {camera} {reel} {card} {volume} {date} {yyyy} {mm} {dd} {time} {counter}`.
- **MHL**: escribe listas de hashes (formato MHL v1) y verifica una carpeta contra una lista MHL.
- **Biblioteca**: bins por tarjeta, ffprobe (códec, resolución, fps, timecode, audio), miniaturas, búsqueda,
  flags, estrellas, colores, escena/plano/toma, notas, campos personalizados, edición múltiple,
  carpetas inteligentes, reproductor con JKL y proxy H.264 automático para códecs que Chromium no reproduce.
- **Informes** HTML/PDF: día de rodaje, clips, miniaturas, contact print, volumen/checksums. Export CSV y EDL.
- **Transcodificar**: ProRes Proxy/422/HQ, DNxHR LB/SQ, H.264, H.265; escalado, LUT `.cube`,
  timecode y nombre quemados; puede lanzarse automáticamente tras el offload.

## Novedades v0.3

- **Proyectos con ficha**: nombre, director, dir. de fotografía, ayudantes de cámara, DIT, data manager, sonido, script, productor,
  productora, localización, logo y copyright. Se crean desde el selector de proyecto y se editan siempre desde la Biblioteca.
  La ficha se enlaza con el Offload (nombre de proyecto, DIT en la lista MHL) y con la cabecera de los informes.
- **Biblioteca en árbol de carpetas** (la estructura del offload y de lo importado) con botón **Importar** (carpetas o ficheros, sin copiar).
- **Tres vistas**: lista (columnas configurables y editables, con las que el usuario añada), miniaturas y carpetas (clips, tamaño y tipos por carpeta).
- **Transcodificación robusta**: escribe en un fichero temporal, solo da por bueno un resultado con contenido, registra la salida
  en la carpeta «Transcodes» con su información y muestra el motivo exacto de cualquier error.
- Guía de uso en PDF: [docs/CrisStack-XS-Guia.pdf](docs/CrisStack-XS-Guia.pdf).

## Añadido en v0.2

- **Color**: ASC CDL (slope/offset/power/saturación) y LUT 3D `.cube` en tiempo real (WebGL2), copiar/pegar look,
  biblioteca de looks, import/export `.cdl/.cc/.ccc`. Los looks se aplican también al transcodificar y al exportar stills.
- **Visual controls**: color falso, zebra, clipping, peaking, líneas de encuadre, desqueeze, espejo, rotación, recorte,
  scopes (waveform, histograma, vectorscopio), pantalla completa, miniatura personalizada, still con look.
- **Comparar**: cuadrícula o cortina (wipe) con dos clips sincronizados.
- **Audio**: sincronización por timecode BWF o por forma de onda, y render del clip con el audio externo.
- **Intercambio**: exporta Avid ALE, Premiere/FCP7 XML, FCPXML (FCP X / Resolve), CCC, EDL, CSV; importa CSV/ALE
  (hojas de rodaje) con mapeo de columnas.
- **Archivo**: ASC MHL con generaciones y cadena C4, relink por nombre+tamaño+hash, detección de secuencias de imagen,
  subida a S3 y compatibles (firma SigV4 propia, validada con el vector oficial de AWS).
- **Workflow**: renombrado al copiar, sellado ASC MHL, script de usuario, subida de transcodes, aviso por Slack,
  workflows guardados, proyectos múltiples, exportar/importar biblioteca, atajos de teclado configurables.

## No incluido (depende de hardware o servicios de terceros)

Salida SDI/HDMI de calidad broadcast (requiere tarjeta y SDK del fabricante), LTFS y Sony ODA (unidades físicas),
subidas a Frame.io, Sony Ci, Webgate y COPRA (APIs privadas con cuenta), ShotHub (servicio propio de otra empresa),
Stream Deck, extracción de LTC del audio, corrección de lente ZEISS CP.3 XD.
El formato ASC MHL sigue la especificación pero no está validado contra la herramienta de referencia oficial.

## Autoprueba

`CINESTACK_SELFTEST=<carpeta> npx electron .` genera una tarjeta de prueba, hace un offload real a dos destinos
con informe PDF y transcodes, maneja la interfaz y guarda capturas en esa carpeta.
