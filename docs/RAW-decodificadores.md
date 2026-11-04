# Decodificación RAW nativa en CrisStack XS

Estado a 4 de noviembre de 2026 (v0.7.0). Este documento recoge la arquitectura que ya está en la app, el estado real de cada formato
RAW, el estudio de licencias y los pasos que quedan. **No es asesoramiento legal**: las licencias se leyeron en las páginas oficiales con
herramientas automáticas y cada afirmación lleva su nivel de certeza; antes de distribuir un producto comercial hay que revisar los textos
completos con un abogado.

## 1. Resumen

| | Estado |
|---|---|
| Arquitectura modular (un decodificador por fabricante, detección automática, estado honesto, sin conversión silenciosa) | **Hecha y probada** (v0.7.0) con un decodificador de prueba |
| Decodificadores reales (Blackmagic, RED/Nikon, ARRI, Sony, Canon, Apple) | **No incluidos**: cada uno exige aceptar la licencia del SDK de su fabricante y compilar un «helper» contra él; ver el §5 |
| Reproducción RAW en tiempo real, transcodificación RAW nativa | Pendientes (hace falta primero algún decodificador real) |
| Lo que sí funciona hoy | Detectar el formato, importar y copiar con verificación, ficha del clip, miniatura genérica, proxy vinculado a mano (marcado como proxy), Visor RAW fotograma a fotograma cuando hay decodificador |

Por qué no hay decodificación real todavía: **no se puede descargar ni usar ningún SDK sin que una persona de la empresa acepte su
licencia** (Blackmagic y RED piden registro y aceptación; ARRI pide solicitud; Sony y Canon no tienen acceso público localizado), y el
código nativo contra esos SDK se tiene que compilar y probar en un Mac/Windows con el SDK instalado. Escribirlo «a ciegas» sin poder
compilarlo ni probarlo con ficheros reales daría una falsa sensación de soporte, que es justo lo que se pidió evitar.

## 2. Arquitectura (ya en la app)

```
src/main/engine/rawdec/
  formats.js   catálogo: formato, fabricante, extensiones, SDK, cómo se consigue, redistribución (con certeza)
  detect.js    detección automática por firma de contenido; si no, extensión. Devuelve la certeza (magic / heuristic / extension)
  settings.js  ajustes de decodificación (ISO, Kelvin, tinte, espacio de color, gamma, calidad de debayer, escala, bits, GPU):
               se validan contra lo que declara el decodificador; lo que el SDK no ofrece se declara, no se simula
  helper.js    cliente del protocolo con los «helpers» (un ejecutable por fabricante)
  registry.js  RawRegistry: estado de cada formato, open(), RawClip.frame(); RawUnavailableError sin sustituto silencioso
  frame.js     pinta el fotograma ya decodificado (ffmpeg solo dibuja píxeles, no decodifica RAW)
```

**Un helper por fabricante** (`crisstack-raw-braw`, `-red`, `-arri`, `-sony`, `-canon`, `-apple`), en la carpeta de datos de la app
(`~/Library/Application Support/CrisStack XS/raw-helpers`, botón en Ajustes → Decodificadores RAW), en `Resources/raw` o indicado con
`CRISSTACK_RAW_HELPER_<FABRICANTE>`. Ventajas: las librerías de cada SDK no se mezclan con el código de la app (cada una tiene su
licencia y su aviso), un fallo del SDK no tumba la aplicación, y cada helper se compila, firma y actualiza por separado. RED y Nikon
comparten helper (`red`) porque el SDK de RED incluye N-RAW desde la 9.0.0.

**Política:** si no hay decodificador nativo, la app lo dice y explica por qué. **Nunca** convierte en silencio a otro formato con pérdida.
Un proxy solo se usa si el usuario lo vincula a mano, se etiqueta «PROXY vinculado: no es la decodificación RAW» y no sustituye a la lectura nativa.

**Fidelidad (en la medida que permita cada SDK):** el helper declara en `hello` qué controles admite; el visor muestra solo esos. Cada
fotograma devuelve resolución original, profundidad de bits, GPU/CPU usada, los ajustes aplicados y, aparte, los que se pidieron y el SDK
no aplicó (`notApplied`) o no ofrece (`unsupported`). La ficha del clip guarda metadatos de cámara, información del sensor y ajustes de grabación.

### Protocolo de helpers v1 (stdin/stdout)

Cada mensaje: `[4 bytes big-endian = longitud de la cabecera][cabecera JSON][payload binario]`; la cabecera lleva `payload` (bytes que siguen).

| Petición | Respuesta |
|---|---|
| `{op:'hello'}` | `{protocol:1, helper, sdk:{name,version}, formats:[ids], gpu:[…], capabilities:{iso:{min,max}, kelvin:{min,max}, tint:{min,max}, colorSpaces:[], gammas:[], quality:[], scale:[], bitDepths:[], gpu:[]}}` |
| `{op:'open', path}` | `{clip:{width,height,frames,fps,duration,timecode,bitDepth,sensor:{…},camera:{…},asShot:{iso,kelvin,tint,colorSpace,gamma}}}` |
| `{op:'frame', index, settings}` | `{width,height,layout:'rgb48le'｜'rgba64le'｜'rgb24'｜'rgbaf16le', bitDepth, settingsApplied:{…}, gpuUsed}` + payload de píxeles |
| `{op:'close'}` | `{ok:true}` |

Un decodificador de prueba completo está en `test/fixtures/fake-raw-helper.js` y los tests en `test/engine7.test.js`.

## 3. Evaluación de las tecnologías pedidas

### MDK (wang-bin/mdk-sdk) y plugins mdk-braw / mdk-r3d — **no recomendado como vía RAW**
- Es un SDK de reproducción (C++/C, bindings Swift, Flutter, C#, OpenHarmony; **sin binding para Node/Electron**). Última versión vista: v0.40.0 (4 nov 2026).
- **Licencia:** el uso comercial exige una **clave** (gratuita para proyectos de código abierto o colaboradores; de pago para el resto; sin precio ni condiciones de redistribución publicados en el README). No se vio un fichero LICENSE en la raíz del repositorio. Hay que pedir la clave y los términos al autor.
- **mdk-braw y mdk-r3d:** MIT, solo **código fuente** (sin releases ni binarios), y **requieren que aportes los runtimes oficiales de Blackmagic y RED** (la licencia de cada SDK sigue aplicando íntegra).
- **Control de ajustes:** el TODO del README de mdk-braw lista «control de atributos de clip y fotograma» como pendiente; el de mdk-r3d habla de «decompress + debayer OpenCL/CUDA» sin marcar como terminado. Es decir, **no ofrece de forma documentada ISO, balance de blancos, espacio de color ni calidad de debayer**, que es lo que se pide.
- Soporta ProRes RAW en plataformas Apple a través del decodificador VideoToolbox del sistema.
- Conclusión: añade un coste de licencia, un binding nativo que no existe y no da el control de ajustes buscado. Usar directamente los SDK oficiales (§5) da más control y menos dependencias. MDK podría valorarse más adelante solo como motor de reproducción.

### FFmpeg
- La versión empaquetada (6.1.1 de ffmpeg-static) **no tiene decodificadores** de BRAW, R3D, ARRIRAW, X-OCN, Canon RAW Light, N-RAW ni ProRes RAW (comprobado con `ffmpeg -decoders`). Sí decodifica ProRes, DNxHR, H.264/HEVC (XAVC, XAVC S), XDCAM, CineForm, JPEG 2000, EXR/DPX.
- **Riesgo de licencia a estudiar ya:** ese binario se compila con `--enable-gpl --enable-version3` (incluye x264, x265, xvid…) y el paquete `ffmpeg-static` declara GPL-3.0-or-later. Distribuirlo dentro de un editor comercial de código cerrado obliga, como mínimo, a cumplir la GPL para ese ejecutable (texto de la licencia, oferta de código fuente, no mezclar en el mismo programa) y puede ser incompatible con el modelo comercial. Opciones: un ffmpeg compilado **LGPL** (sin x264/x265; usar VideoToolbox/Media Foundation para H.264/HEVC), una licencia comercial de x264/x265, o cumplir la GPL con asesoría legal.

## 4. Estudio de licencias de distribución (resumen por SDK)

| SDK | Cómo se consigue | ¿Se puede redistribuir en una app comercial? | Certeza |
|---|---|---|---|
| Blackmagic RAW SDK 6.0 (14 sep 2026) | Registro (nombre, email, teléfono, dirección, uso previsto) y aceptación | Sí: la licencia de desarrollador permite sublicenciar y distribuir **las librerías de la API en código objeto** dentro de tu software, sin royalties, revocable. No cabeceras ni documentación; no ingeniería inversa; uso de marca limitado a «compatible con…»; responsabilidad máxima de la licenciante 100 USD; California | Media (lectura de la cláusula 1.1(d)) |
| RED R3D SDK 9.2.1 (15 jun 2026) | Clic de aceptación en la página de descarga | Sí, con condiciones: solo las librerías dinámicas «tal cual», dentro de tu aplicación y en un directorio privado; **tu propio EULA** con las cláusulas de RED (sin sublicenciar, sin ingeniería inversa…), tu aviso de copyright, soporte a tu cargo, indemnización a RED; no distribuir cabeceras/documentación/ejemplos/librería estática; no usar el nombre de RED sin permiso; confidencialidad; límite de 50 USD | Media |
| Nikon N-RAW | A través del SDK de RED (soporte desde la 9.0.0) | **Por confirmar**: la licencia de RED no menciona N-RAW ni a Nikon; no se localizó un SDK público de Nikon | Baja |
| ARRI Image SDK | Solicitud al ARRI Partner Program (membresía gratuita de 2 años; algunas funciones pueden tener coste) | **Sin determinar**; tampoco se vio si cubre ARRIRAW HDE. El «ARRIRAW HDE Transcoder» es una herramienta aparte (macOS/Windows, solo ALEXA 35 «nuevo estilo») cuyo EULA no concede redistribución | Baja |
| Sony RAW SDK (X-OCN) | Citado en los white papers de X-OCN; **no se pudo leer** cómo se solicita ni la licencia | **Sin determinar** → pedirlo a Sony | Sin datos |
| Canon Cinema RAW Light | **No se localizó** un SDK público; Canon ofrece «Cinema RAW Development» (app gratuita) con condiciones que prohíben redistribuir el contenido | **Sin determinar** → preguntar a Canon (programa de desarrolladores) | Sin datos |
| Apple ProRes RAW | VideoToolbox / AVFoundation, parte de macOS | Nada que redistribuir; solo macOS. Según WWDC20 10090, AVAssetReader entrega RGBA half-float ya procesado, **no Bayer**; no se confirmó qué control de ISO/balance de blancos/debayer expone Apple (hay que leer las cabeceras de CoreMedia/VideoToolbox en Xcode). Existe `VTRegisterProfessionalVideoWorkflowVideoDecoders()` para cargar los decodificadores profesionales | Media / control de ajustes sin confirmar |

**Puntos comunes a vigilar antes de lanzar:** (1) la aceptación de cada licencia la hace la empresa, no un desarrollador a título personal;
(2) cada SDK impone su propio EULA, avisos y límites de uso de marca; (3) los términos incluyen terminación unilateral y sin obligación de
soporte, así que hay que poder degradar con elegancia (el diseño de helpers lo permite: si un helper desaparece, el formato pasa a «sin
decodificador»); (4) controles de exportación; (5) los helpers y sus librerías van **fuera** del código de la app y de su repositorio;
(6) revisar la licencia del ffmpeg que se distribuye (§3).

## 5. Qué hay que hacer para tener decodificación real (por orden recomendado)

1. **Blackmagic RAW** (el más accesible): registrar la empresa y descargar el SDK 6.0; compilar `crisstack-raw-braw` (C++, Metal/CUDA/OpenCL) implementando el protocolo v1: `hello` con los controles que ofrece el SDK (ISO, balance de blancos, espacio de color y gamma, calidad de decodificación, escala), `open` con metadatos de clip, `frame` en 16 bits. Probar con clips reales de BRAW.
2. **RED R3D + Nikon N-RAW**: aceptar el EULA del SDK 9.2.1, compilar `crisstack-raw-red` (CUDA/OpenCL/Metal), y **consultar con RED/Nikon** la cobertura de N-RAW en la licencia de distribución.
3. **Apple ProRes RAW**: helper en Objective-C/Swift con AVAssetReader/VTDecompressionSession; confirmar en las cabeceras qué controles de RAW existen y si hay acceso a datos sin procesar.
4. **ARRI**: solicitar el acceso al ARRI Partner Program y preguntar por ARRIRAW HDE, plataformas y redistribución.
5. **Sony y Canon**: contactar con cada fabricante para obtener el SDK y su licencia.
6. Después, con al menos un decodificador real: reproducción en tiempo real (subir los fotogramas a una textura de GPU), color management del RAW, transcodificación RAW nativa y stills desde RAW.

**Para que yo pueda avanzar con (1) y (2) hace falta que la persona responsable de la empresa acepte las licencias y descargue los SDK
(o me indique una carpeta donde estén instalados), y un Mac para probar con clips reales.** Las firmas de detección de `detect.js` también
están por validar con ficheros reales de cada cámara (marcadas como «heurística» o «extensión» cuando no hay firma confirmada).

## 6. Fuentes consultadas (nov 2026)

- MDK: https://github.com/wang-bin/mdk-sdk · https://github.com/wang-bin/mdk-braw · https://github.com/wang-bin/mdk-r3d
- Blackmagic RAW SDK: https://www.blackmagicdesign.com/developer/products/braw/sdk-and-software
- RED R3D SDK y licencia: https://www.reddigitalcinema.com/download/r3d-sdk · https://www.reddigitalcinema.com/legal/red-r3d-sdk-license-agreement
- ARRI Partner Program: https://www.arri.com/en/company/the-arri-philosophy/arri-partner-program · HDE Transcoder: https://www.arri.com/en/learn-help/learn-help-camera-system/tools/arriraw-hde-transcoder
- Sony X-OCN: https://pro.sony/s3/2023/09/21144038/Sony_X-OCN_White_Paper_v1.1.pdf (el PDF v3.0 no se pudo leer como texto)
- Canon: https://developercommunity.usa.canon.com/ (sin contenido legible) · https://in.canon/en/support/0200649602 (Cinema RAW Development)
- Apple: https://developer.apple.com/videos/play/wwdc2020/10090/ · https://developer.apple.com/documentation/videotoolbox (documentación dinámica, no legible automáticamente)
