// Catalogo de formatos RAW de cine: quien los decodifica, como se obtiene el SDK y que se sabe de su licencia.
// Los datos de acceso y licencia salen de una investigacion hecha en nov 2026 (ver docs/RAW-decodificadores.md): estan marcados con su
// nivel de certeza y NO sustituyen una revision legal. Nada de aqui decodifica: solo describe y sirve para detectar y explicar.

/** access: como se consigue el SDK. clickthrough = registro + aceptar licencia; application = solicitud a la empresa; system = lo trae el sistema operativo; unknown = no se ha podido determinar. */
const FORMATS = {
  braw: {
    id: 'braw', name: 'Blackmagic RAW', vendor: 'Blackmagic Design', extensions: ['.braw'], helper: 'braw',
    sdk: { name: 'Blackmagic RAW SDK', version: '6.0 (14 sep 2026)', access: 'clickthrough', gpu: ['metal', 'cuda', 'opencl', 'cpu'], platforms: ['macOS', 'Windows x64', 'Windows ARM64', 'Linux'],
      url: 'https://www.blackmagicdesign.com/developer/products/braw/sdk-and-software',
      redistribution: 'permitida (certeza media): la licencia de desarrollador (cláusula 1.1(d)) permite distribuir las librerías de la API en código objeto dentro de tu aplicación, sin royalties; sin cabeceras ni documentación; sin ingeniería inversa; registro obligatorio para descargar.' },
  },
  r3d: {
    id: 'r3d', name: 'REDCODE RAW (R3D)', vendor: 'RED Digital Cinema', extensions: ['.r3d'], helper: 'red',
    sdk: { name: 'RED R3D SDK', version: '9.2.1 (15 jun 2026)', access: 'clickthrough', gpu: ['cuda', 'opencl', 'metal', 'cpu'], platforms: ['macOS (Apple Silicon)', 'Windows x64', 'Windows ARM64', 'Linux'],
      url: 'https://www.reddigitalcinema.com/download/r3d-sdk',
      redistribution: 'permitida con condiciones (certeza media): solo las librerías dinámicas «tal cual», dentro de tu aplicación y en un directorio privado; hace falta tu propio EULA con las cláusulas de RED, tu aviso de copyright y asumir tú el soporte; no se pueden distribuir cabeceras, documentación ni código de ejemplo; no usar el nombre de RED en marketing sin permiso.' },
  },
  nraw: {
    id: 'nraw', name: 'Nikon N-RAW', vendor: 'Nikon', extensions: ['.nev'], helper: 'red',
    sdk: { name: 'RED R3D SDK (desde la v9.0.0 incluye N-RAW)', version: '9.2.1', access: 'clickthrough', gpu: ['cuda', 'opencl', 'metal', 'cpu'], platforms: ['macOS (Apple Silicon)', 'Windows x64', 'Linux'],
      url: 'https://www.reddigitalcinema.com/download/r3d-sdk',
      redistribution: 'por confirmar: las notas de versión del SDK de RED indican soporte de N-RAW desde la 9.0.0, pero el texto de la licencia no menciona N-RAW ni a Nikon. Hay que preguntar a RED/Nikon si la licencia de distribución cubre N-RAW. No se encontró un SDK público de Nikon.' },
  },
  arriraw: {
    id: 'arriraw', name: 'ARRIRAW / ARRIRAW HDE', vendor: 'ARRI', extensions: ['.ari', '.arx'], helper: 'arri',
    sdk: { name: 'ARRI Image SDK', version: 'sin determinar', access: 'application', gpu: [], platforms: ['sin determinar'],
      url: 'https://www.arri.com/en/company/the-arri-philosophy/arri-partner-program',
      redistribution: 'sin determinar: el acceso es por el ARRI Partner Program (solicitud; la membresía es gratuita y dura dos años, algunas funciones pueden tener coste). No se vio si el SDK cubre ARRIRAW HDE ni sus términos de redistribución. El «ARRIRAW HDE Transcoder» es una herramienta aparte y su EULA no concede redistribución.' },
  },
  xocn: {
    id: 'xocn', name: 'Sony X-OCN / Sony RAW', vendor: 'Sony', extensions: ['.mxf'], helper: 'sony',
    sdk: { name: 'Sony RAW SDK', version: 'sin determinar', access: 'unknown', gpu: [], platforms: ['sin determinar'],
      url: 'https://pro.sony/s3/2023/09/21144038/Sony_X-OCN_White_Paper_v1.1.pdf',
      redistribution: 'sin determinar: los white papers de X-OCN citan un «Sony RAW SDK» y soporte de terceros (Premiere, Resolve, Baselight), pero no se pudo leer cómo se solicita ni bajo qué licencia. Hay que pedirlo a Sony.' },
  },
  proresraw: {
    id: 'proresraw', name: 'Apple ProRes RAW', vendor: 'Apple', extensions: ['.mov'], helper: 'apple',
    sdk: { name: 'VideoToolbox / AVFoundation (sistema macOS)', version: 'del sistema', access: 'system', gpu: ['metal', 'afterburner'], platforms: ['macOS'],
      url: 'https://developer.apple.com/videos/play/wwdc2020/10090/',
      redistribution: 'no hay nada que redistribuir: lo aporta macOS. Ojo: según la sesión WWDC20 10090, AVAssetReader entrega fotogramas ya procesados (RGBA half-float), no datos Bayer; no se pudo confirmar qué control de ISO / balance de blancos / debayer expone Apple. Solo macOS.' },
  },
  crm: {
    id: 'crm', name: 'Canon Cinema RAW Light', vendor: 'Canon', extensions: ['.crm'], helper: 'canon',
    sdk: { name: 'Canon (SDK sin localizar)', version: 'sin determinar', access: 'unknown', gpu: [], platforms: ['sin determinar'],
      url: 'https://developercommunity.usa.canon.com/',
      redistribution: 'sin determinar: no se encontró un SDK público de Canon para decodificar CRM. Canon ofrece «Cinema RAW Development» (aplicación gratuita) cuyas condiciones de descarga prohíben redistribuir el contenido. Hay que preguntar a Canon.' },
  },
};

module.exports = { FORMATS };
