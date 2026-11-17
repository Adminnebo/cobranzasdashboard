/**
 * Retiro creado a mano (super admins, menú ⋯ del cliente → 🚚 Crear retiro).
 *
 * Hace lo mismo que cuando el cliente lo pide en una llamada o por correo: una
 * ficha con modalidad 'retiro' y una promesa abierta (origen 'manual'), las dos
 * con la llave 'manual:<…>'. De ahí es un retiro como cualquiera: sale en
 * 🚚 Retiros, no se le llama, retirosLogistica lo manda a logística con el
 * monto indicado y el aviso "retirado" pasa al cliente a "dice que pagó".
 *
 * Diferencia: como lo decidió una persona, su promesa no se cierra como
 * "cumplida" porque el cliente no tenga vencido (sirve para probar con un
 * cliente real al día). Se cierra cuando logística lo retira, con "No es
 * retiro" o si el cliente sale de la cartera.
 */
const crypto = require('crypto');
const db = require('./supabaseDb');
const fichas = require('./fichas');
const schedule = require('./schedule');
const clienteConfig = require('./clienteConfig');

const ABIERTAS = ['pendiente', 'en_seguimiento'];
const T_FICHA = 'llamada_ficha';
const T_PROMESA = 'promesa_pago';
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const ORIGEN = 'manual';

const errStatus = (status, msg) => Object.assign(new Error(msg), { status });
const phoneKey = (v) => String(v || '').replace(/\D/g, '').slice(-10);

/**
 * @param {{ phone, monto, fecha?, nota? }} b   monto en pesos; fecha YYYY-MM-DD (hoy si falta)
 * @param {string|null} por  email de quien lo crea
 * @param opts  para pruebas: datos ({ clientes }), cfg, ahora
 */
async function crear(b, por = null, { datos = null, cfg = null, ahora = new Date() } = {}) {
  if (!db.dbEnabled) throw errStatus(503, 'Supabase no configurado');
  const { phone, monto, fecha, nota } = b || {};
  const tel = phoneKey(phone);
  if (tel.length !== 10) throw errStatus(400, 'Teléfono inválido');
  const pesos = Number(monto);
  if (!Number.isFinite(pesos) || pesos <= 0 || pesos > 1e9) throw errStatus(400, 'Escribe un monto mayor que 0');
  const hoy = schedule.ymdInTz(ahora);
  const dia = fecha == null || fecha === '' ? hoy : String(fecha);
  if (!YMD.test(dia) || dia < hoy) throw errStatus(400, 'La fecha tiene que ser hoy o después (AAAA-MM-DD)');
  const texto = String(nota || '').trim().slice(0, 200) || `Retiro creado a mano en el panel${por ? ` por ${por}` : ''}`;

  const data = datos || await require('./cache').getCachedData();
  const cliente = (data.clientes || []).find((c) => phoneKey(c.phone) === tel);
  if (!cliente) throw errStatus(404, 'Ese cliente no está en la cartera');
  if (!cliente.codigo) throw errStatus(409, 'El cliente no tiene código en la cartera: logística no lo puede recibir');
  const ph = String(cliente.phone);

  const [abierta] = (await db.select(T_PROMESA, `?select=id,llamada_key&phone=eq.${encodeURIComponent(ph)}&estado=in.(${ABIERTAS.join(',')})&order=created_at.desc&limit=1`)) || [];
  if (abierta && abierta.llamada_key) {
    const [fx] = (await db.select(T_FICHA, `?select=modalidad&llamada_key=eq.${encodeURIComponent(abierta.llamada_key)}`)) || [];
    if (fx && fx.modalidad === 'retiro') throw errStatus(409, 'Ese cliente ya tiene un retiro abierto (está en 🚚 Retiros)');
  }
  const config = cfg || await schedule.get();
  const llave = `manual:${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const ficha = fichas.normalizarFicha({ modalidad: 'retiro', retiro: { fecha: dia, texto } }, config);
  const at = ahora.toISOString();

  if (abierta) {
    await db.update(T_PROMESA, `?id=eq.${abierta.id}`, {
      estado: 'reprogramada', cerrada_at: at, motivo_cierre: 'se creó un retiro a mano en el panel',
    });
  }
  const [p] = (await db.insertReturn(T_PROMESA, {
    phone: ph,
    nombre: cliente.name || null,
    llamada_id: null,
    llamada_key: llave,
    fecha_llamada: at,
    texto_original: texto,
    fecha_prometida: dia,
    monto_al_prometer: Math.round(pesos * 100) / 100,
    estado: 'pendiente',
    intento: 1,
    promesa_anterior_id: abierta ? String(abierta.id) : null,
    agente: null,
    origen: ORIGEN,
  })) || [];
  await clienteConfig.entrarEstado(ph, 'promesa', dia, `${por || 'panel'} (retiro a mano)`);
  await db.upsert(T_FICHA, {
    llamada_key: llave,
    phone: ph,
    llamada_at: at,
    modalidad: 'retiro',
    retiro: ficha.retiro,
    llamar: null,
    disponibilidad: null,
    horario_aplicado: false,
  }, 'llamada_key');
  console.log(`[retiro-manual] ${ph}: retiro de RD$ ${pesos} para ${dia}${por ? ` (${por})` : ''}`);
  return { llave, promesaId: p ? p.id : null, fecha: dia, monto: pesos, cliente: cliente.name || ph };
}

/**
 * "No es retiro" sobre un retiro creado a mano: como no hubo llamada ni correo
 * detrás, su promesa se cierra (cancelada) y el cliente vuelve a la normalidad.
 * Logística lo cancela sola en la próxima vuelta del motor (ficha 'no_retiro').
 */
async function deshacer(llave, por = null) {
  const k = String(llave || '');
  if (!esManual(k)) return false;
  const [p] = (await db.select(T_PROMESA, `?select=id,phone,estado&llamada_key=eq.${encodeURIComponent(k)}&estado=in.(${ABIERTAS.join(',')})&limit=1`)) || [];
  if (!p) return false;
  await db.update(T_PROMESA, `?id=eq.${p.id}`, {
    estado: 'cancelada', cerrada_at: new Date().toISOString(), motivo_cierre: `retiro a mano deshecho${por ? ` por ${por}` : ''}`,
  });
  await clienteConfig.salirEstado(String(p.phone));
  console.log(`[retiro-manual] ${p.phone}: retiro a mano deshecho (promesa ${p.id})${por ? ` por ${por}` : ''}`);
  return true;
}

const esManual = (k) => /^manual:/.test(String(k || ''));

module.exports = { crear, deshacer, esManual, ORIGEN };
