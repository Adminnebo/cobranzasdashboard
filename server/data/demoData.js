/**
 * Datos demo del prototipo. Modelan las DOS fuentes reales:
 *
 *  1) `clientes`  — base con lo que cada cliente debe (Supabase/Postgres).
 *  2) `llamadas`  — resultados de las llamadas del agente de cobranzas IA,
 *                   con el mismo shape del output de VAPI/n8n que mostró el usuario:
 *                   { id, created_at, phone, name, fecha_pago, intencion_pago,
 *                     notas, transcripcion, grabacion }
 *
 * Se unen por `phone`. No todos los clientes fueron contactados -> eso alimenta
 * la "tasa de contacto".
 *
 * intencion_pago (llamadas):
 *   pago_inmediato | fecha_especifica | promesa_vaga | negociacion |
 *   disputa | sin_intencion | no_contesta
 */

const clientes = [
  { id: 1,  phone: '+525581001001', name: 'Camila Reyes',        empresa: 'JHLQ Servicios',       deuda_total: 630,   deuda_vencida: 430,  credito_ofrecido: 1500, dias_mora: 22,  ultimo_pago: '2026-06-08', direccion: 'Calle Benito Monción #21, La Vega' },
  { id: 2,  phone: '+525581001002', name: 'Rodrigo Martínez',    empresa: 'Ferretería El Tornillo', deuda_total: 2450, deuda_vencida: 2450, credito_ofrecido: 3000, dias_mora: 61,  ultimo_pago: '2026-04-15', direccion: 'Av. Duarte #145, Santiago' },
  { id: 3,  phone: '+525581001003', name: 'Valentina Cruz',      empresa: 'Boutique Aurora',      deuda_total: 890,   deuda_vencida: 0,    credito_ofrecido: 2000, dias_mora: 8,   ultimo_pago: '2026-06-25' },
  { id: 4,  phone: '+525581001004', name: 'Diego Hernández',     empresa: 'Taller Hernández',     deuda_total: 5120,  deuda_vencida: 5120, credito_ofrecido: 4000, dias_mora: 95,  ultimo_pago: '2026-03-01', direccion: 'Gaspar Polanco #258, Santo Domingo', referencia: 'Frente al parque' },
  { id: 5,  phone: '+525581001005', name: 'Sofía Ramírez',       empresa: 'Café La Esquina',      deuda_total: 340,   deuda_vencida: 340,  credito_ofrecido: 1000, dias_mora: 35,  ultimo_pago: '2026-05-20' },
  { id: 6,  phone: '+525581001006', name: 'Mateo González',      empresa: 'Distribuidora MG',     deuda_total: 7800,  deuda_vencida: 6200, credito_ofrecido: 8000, dias_mora: 48,  ultimo_pago: '2026-05-05', direccion: 'Calle El Sol #12, Santiago' },
  { id: 7,  phone: '+525581001007', name: 'Isabella Torres',     empresa: 'Farmacia Vida',        deuda_total: 1260,  deuda_vencida: 1260, credito_ofrecido: 2500, dias_mora: 72,  ultimo_pago: '2026-04-08' },
  { id: 8,  phone: '+525581001008', name: 'Sebastián Flores',    empresa: 'Flores Logística',     deuda_total: 3300,  deuda_vencida: 0,    credito_ofrecido: 5000, dias_mora: 12,  ultimo_pago: '2026-06-20' },
  { id: 9,  phone: '+525581001009', name: 'Lucía Morales',       empresa: 'Papelería Central',    deuda_total: 210,   deuda_vencida: 210,  credito_ofrecido: 800,  dias_mora: 41,  ultimo_pago: '2026-05-14' },
  { id: 10, phone: '+525581001010', name: 'Emiliano Vargas',     empresa: 'Vargas Construcción',  deuda_total: 12400, deuda_vencida: 9800, credito_ofrecido: 15000, dias_mora: 118, ultimo_pago: '2026-02-18' },
  { id: 11, phone: '+525581001011', name: 'Renata Jiménez',      empresa: 'Estética Renata',      deuda_total: 560,   deuda_vencida: 560,  credito_ofrecido: 1200, dias_mora: 28,  ultimo_pago: '2026-06-01' },
  { id: 12, phone: '+525581001012', name: 'Gabriel Ruiz',        empresa: 'Ruiz Autopartes',      deuda_total: 4100,  deuda_vencida: 4100, credito_ofrecido: 4000, dias_mora: 83,  ultimo_pago: '2026-03-22' },
  { id: 13, phone: '+525581001013', name: 'Mariana Castro',      empresa: 'Castro Consultoría',   deuda_total: 1980,  deuda_vencida: 0,    credito_ofrecido: 3500, dias_mora: 5,   ultimo_pago: '2026-06-30' },
  { id: 14, phone: '+525581001014', name: 'Alejandro Ortiz',     empresa: 'Ortiz Eventos',        deuda_total: 2760,  deuda_vencida: 2760, credito_ofrecido: 3000, dias_mora: 54,  ultimo_pago: '2026-04-29' },
  { id: 15, phone: '+525581001015', name: 'Daniela Núñez',       empresa: 'Núñez Textiles',       deuda_total: 6350,  deuda_vencida: 5000, credito_ofrecido: 7000, dias_mora: 67,  ultimo_pago: '2026-04-12' },
  { id: 16, phone: '+525581001016', name: 'Tomás Aguilar',       empresa: 'Panadería El Trigo',   deuda_total: 430,   deuda_vencida: 430,  credito_ofrecido: 1000, dias_mora: 19,  ultimo_pago: '2026-06-12' },
  { id: 17, phone: '+525581001017', name: 'Ximena Delgado',      empresa: 'Delgado Import',       deuda_total: 9200,  deuda_vencida: 9200, credito_ofrecido: 10000, dias_mora: 102, ultimo_pago: '2026-02-25' },
  { id: 18, phone: '+525581001018', name: 'Nicolás Peña',        empresa: 'Peña Refacciones',     deuda_total: 1540,  deuda_vencida: 0,    credito_ofrecido: 2000, dias_mora: 9,   ultimo_pago: '2026-06-22' },
  { id: 19, phone: '+525581001019', name: 'Regina Campos',       empresa: 'Campos Floristería',   deuda_total: 780,   deuda_vencida: 780,  credito_ofrecido: 1500, dias_mora: 44,  ultimo_pago: '2026-05-10' },
  { id: 20, phone: '+525581001020', name: 'Andrés Guerrero',     empresa: 'Guerrero Mayoreo',     deuda_total: 15800, deuda_vencida: 12300, credito_ofrecido: 18000, dias_mora: 131, ultimo_pago: '2026-02-01' },
  { id: 21, phone: '+525581001021', name: 'Paula Rincón',        empresa: 'Rincón Belleza',       deuda_total: 320,   deuda_vencida: 0,    credito_ofrecido: 900,  dias_mora: 3,   ultimo_pago: '2026-07-01' },
  { id: 22, phone: '+525581001022', name: 'Fernando Ríos',       empresa: 'Ríos Transportes',     deuda_total: 3980,  deuda_vencida: 3980, credito_ofrecido: 4500, dias_mora: 58,  ultimo_pago: '2026-04-27' },
];

// Resultados de llamadas (mismo shape del output VAPI/n8n). Solo un subconjunto
// de clientes fue contactado.
const llamadas = [
  {
    id: 1, created_at: '2026-07-06T18:04:52.628638+00:00', phone: '+525581001001', name: 'Camila Reyes',
    fecha_pago: 'el próximo 15', intencion_pago: 'fecha_especifica',
    notas: 'Se contactó con la persona encargada de cuentas por pagar de JHLQ, se le recordó el saldo pendiente y confirmó que el pago se realizará el próximo 15.',
    transcripcion: 'AI: Saludos. Le habla Camila Reyes de JHLQ. Le contacto de manera breve para recordarle un compromiso pendiente y ayudarle a mantener su cuenta al día. ¿Me permite un minuto?\nUser: Sí, sí, sí.\nAI: Perfecto. Antes de continuar, usted es la persona encargada del área de cuentas por pagar de KFC.\nUser: Sí.\nAI: Excelente. En sistema veo que su empresa registra un balance total de 200 pesos y un balance vencido de 430 pesos. ¿Me confirma si el pago se estará realizando hoy o en el próximo corte?\nUser: El próximo 15 puede.\nAI: Adiós.',
    grabacion: 'https://app.swordaisolutions.com/api/recordings/public/019f1e86-2f71-7000-bdb3-107d191ccb0e',
  },
  {
    id: 2, created_at: '2026-07-06T17:41:10+00:00', phone: '+525581001002', name: 'Rodrigo Martínez',
    fecha_pago: '', intencion_pago: 'negociacion',
    notas: 'Cliente reconoce el adeudo de 2,450 pero pide diferir a dos pagos por flujo bajo. Solicita plan quincenal.',
    transcripcion: 'AI: Buenas tardes, le llamo por el saldo vencido de su cuenta.\nUser: Sí, lo sé, pero ahorita está difícil. ¿Puedo pagar en dos partes?\nAI: Podemos revisar un plan. ¿Le parece quincenal?\nUser: Sí, eso me ayudaría.',
    grabacion: 'https://app.swordaisolutions.com/api/recordings/public/demo-0002',
  },
  {
    id: 3, created_at: '2026-07-06T17:15:33+00:00', phone: '+525581001004', name: 'Diego Hernández',
    fecha_pago: '', intencion_pago: 'disputa',
    notas: 'Cliente disputa el monto, dice que ya pagó una parte en marzo y no está reflejada. Requiere aclaración de cuenta antes de pagar.',
    transcripcion: 'AI: Le contacto por un saldo vencido de 5,120 pesos.\nUser: Eso no puede ser, yo pagué en marzo. Revisen bien.\nAI: Entiendo, escalaré su caso para aclaración.\nUser: Hasta que no lo aclaren no pago nada.',
    grabacion: 'https://app.swordaisolutions.com/api/recordings/public/demo-0003',
  },
  {
    id: 4, created_at: '2026-07-06T16:58:02+00:00', phone: '+525581001005', name: 'Sofía Ramírez',
    fecha_pago: 'hoy', intencion_pago: 'pago_inmediato',
    notas: 'Cliente accede a pagar los 340 pesos el mismo día por transferencia. Muy colaborativa.',
    transcripcion: 'AI: Le recuerdo su saldo de 340 pesos.\nUser: Ah sí, deja lo hago ahorita mismo por transferencia.\nAI: Perfecto, muchas gracias.',
    grabacion: 'https://app.swordaisolutions.com/api/recordings/public/demo-0004',
  },
  {
    id: 5, created_at: '2026-07-06T16:30:44+00:00', phone: '+525581001006', name: 'Mateo González',
    fecha_pago: 'fin de mes', intencion_pago: 'fecha_especifica',
    notas: 'Encargado confirma pago del vencido (6,200) para el 31. Pide factura actualizada.',
    transcripcion: 'AI: Su cuenta registra 6,200 vencidos.\nUser: Correcto, lo liquidamos a fin de mes, el 31. Mándeme la factura.\nAI: Con gusto.',
    grabacion: 'https://app.swordaisolutions.com/api/recordings/public/demo-0005',
  },
  {
    id: 6, created_at: '2026-07-06T16:05:19+00:00', phone: '+525581001007', name: 'Isabella Torres',
    fecha_pago: '', intencion_pago: 'promesa_vaga',
    notas: 'Cliente dice que "pronto" pagará pero no da fecha. Historial de mora recurrente.',
    transcripcion: 'AI: Tiene 1,260 pesos vencidos.\nUser: Sí, en cuanto pueda le deposito, ando corto.\nAI: ¿Podría darme una fecha estimada?\nUser: No sé, pronto.',
    grabacion: 'https://app.swordaisolutions.com/api/recordings/public/demo-0006',
  },
  {
    id: 7, created_at: '2026-07-06T15:44:07+00:00', phone: '+525581001010', name: 'Emiliano Vargas',
    fecha_pago: '', intencion_pago: 'sin_intencion',
    notas: 'Cliente molesto, dice que la obra se canceló y no tiene con qué pagar los 9,800 vencidos. Riesgo alto de incobrable.',
    transcripcion: 'AI: Le llamo por 9,800 pesos vencidos.\nUser: Mire, la obra se cayó, no tengo de dónde. No me llamen más.\nAI: Lamento la situación, registraré su caso.',
    grabacion: 'https://app.swordaisolutions.com/api/recordings/public/demo-0007',
  },
  {
    id: 8, created_at: '2026-07-06T15:20:55+00:00', phone: '+525581001011', name: 'Renata Jiménez',
    fecha_pago: 'el viernes', intencion_pago: 'fecha_especifica',
    notas: 'Confirma pago de 560 el viernes. Cliente amable, primera mora.',
    transcripcion: 'AI: Su saldo es de 560 pesos.\nUser: Ay sí, se me pasó. El viernes lo pago sin falta.\nAI: Gracias, quedo al pendiente.',
    grabacion: 'https://app.swordaisolutions.com/api/recordings/public/demo-0008',
  },
  {
    id: 9, created_at: '2026-07-06T14:59:31+00:00', phone: '+525581001012', name: 'Gabriel Ruiz',
    fecha_pago: '', intencion_pago: 'negociacion',
    notas: 'Solicita quita del 15% para liquidar los 4,100 de contado. Pide autorización.',
    transcripcion: 'AI: Debe 4,100 pesos vencidos.\nUser: Si me hacen un descuento del 15% lo pago de una vez.\nAI: Lo consulto con el área correspondiente.',
    grabacion: 'https://app.swordaisolutions.com/api/recordings/public/demo-0009',
  },
  {
    id: 10, created_at: '2026-07-06T14:33:12+00:00', phone: '+525581001014', name: 'Alejandro Ortiz',
    fecha_pago: 'el 20', intencion_pago: 'fecha_especifica',
    notas: 'Confirma pago de 2,760 el día 20 tras cobrar un evento grande.',
    transcripcion: 'AI: Su vencido es de 2,760.\nUser: Cobro un evento el 18, el 20 le pago todo.\nAI: Perfecto, anotado.',
    grabacion: 'https://app.swordaisolutions.com/api/recordings/public/demo-0010',
  },
  {
    id: 11, created_at: '2026-07-06T14:10:48+00:00', phone: '+525581001015', name: 'Daniela Núñez',
    fecha_pago: '', intencion_pago: 'promesa_vaga',
    notas: 'Dice que espera un pago de un cliente para poder abonar los 5,000. Sin fecha firme.',
    transcripcion: 'AI: Registra 5,000 vencidos.\nUser: En cuanto me paguen a mí les pago, pero no sé cuándo.\nAI: Entiendo, ¿le marco la próxima semana?\nUser: Va.',
    grabacion: 'https://app.swordaisolutions.com/api/recordings/public/demo-0011',
  },
  {
    id: 12, created_at: '2026-07-06T13:47:26+00:00', phone: '+525581001016', name: 'Tomás Aguilar',
    fecha_pago: 'mañana', intencion_pago: 'pago_inmediato',
    notas: 'Acepta pagar los 430 al día siguiente en efectivo en sucursal.',
    transcripcion: 'AI: Su saldo es de 430 pesos.\nUser: Mañana paso a pagarlo en la sucursal.\nAI: Excelente, gracias.',
    grabacion: 'https://app.swordaisolutions.com/api/recordings/public/demo-0012',
  },
  {
    id: 13, created_at: '2026-07-06T13:22:09+00:00', phone: '+525581001017', name: 'Ximena Delgado',
    fecha_pago: '', intencion_pago: 'disputa',
    notas: 'Cliente afirma que la mercancía llegó incompleta y retiene el pago de 9,200 hasta nota de crédito.',
    transcripcion: 'AI: Tiene 9,200 vencidos.\nUser: No pago hasta que me den la nota de crédito por lo que faltó.\nAI: Escalaré el tema a facturación.',
    grabacion: 'https://app.swordaisolutions.com/api/recordings/public/demo-0013',
  },
  {
    id: 14, created_at: '2026-07-06T12:58:40+00:00', phone: '+525581001019', name: 'Regina Campos',
    fecha_pago: 'el próximo lunes', intencion_pago: 'fecha_especifica',
    notas: 'Confirma pago de 780 el lunes. Cliente colaborativa.',
    transcripcion: 'AI: Su saldo vencido es 780 pesos.\nUser: Claro, el próximo lunes lo deposito.\nAI: Muchas gracias.',
    grabacion: 'https://app.swordaisolutions.com/api/recordings/public/demo-0014',
  },
  {
    id: 15, created_at: '2026-07-06T12:31:15+00:00', phone: '+525581001020', name: 'Andrés Guerrero',
    fecha_pago: '', intencion_pago: 'no_contesta',
    notas: 'No contestó, entró a buzón. Segundo intento sin éxito. Deuda muy alta (12,300 vencidos).',
    transcripcion: 'AI: (buzón de voz) Le llamamos respecto a su cuenta, por favor comuníquese...',
    grabacion: 'https://app.swordaisolutions.com/api/recordings/public/demo-0015',
  },
  {
    id: 16, created_at: '2026-07-06T12:05:58+00:00', phone: '+525581001022', name: 'Fernando Ríos',
    fecha_pago: 'quincena', intencion_pago: 'promesa_vaga',
    notas: 'Dice que en la quincena "ve qué puede" abonar de los 3,980. No compromete monto.',
    transcripcion: 'AI: Su vencido es 3,980 pesos.\nUser: En la quincena veo qué le abono.\nAI: ¿Un monto aproximado?\nUser: No le sé decir todavía.',
    grabacion: 'https://app.swordaisolutions.com/api/recordings/public/demo-0016',
  },
  // Follow up: Camila Reyes prometió "el próximo 15" (llamada 1) y no pagó.
  {
    id: 17, created_at: '2026-07-15T14:20:11+00:00', phone: '+525581001001', name: 'Camila Reyes',
    fecha_pago: 'el viernes', intencion_pago: 'fecha_especifica',
    notas: 'No pudo pagar el 15 porque no le llegó el cheque. Se compromete a pagar el viernes.',
    transcripcion: 'AI: Le llamo porque quedó en pagar el 15 y todavía vemos el balance vencido.\nUser: Sí, no me llegó el cheque. El viernes sin falta.\nAI: Perfecto, lo dejo anotado para el viernes.',
    grabacion: 'https://app.swordaisolutions.com/api/recordings/public/demo-0017',
    agente_id: 'cmrksxyke000bf69lt9nw4322', agente_nombre: 'JH Cobranzas (Follow Up)',
    duracion_seg: 48.2, resultado: 'answered', motivo_fin: 'assistant-ended-call', etapa: 'Con intencion de pagar',
  },
];

module.exports = { clientes, llamadas };
