/**
 * Correos → retiros (logística).
 *
 * Cuando el cliente contesta un correo de cobranza diciendo que tiene el pago o
 * el cheque listo para que lo pasen a buscar (etiqueta 'pago_listo' de
 * correosIa), se hace lo mismo que cuando lo pide en una llamada: una ficha con
 * modalidad 'retiro' y una promesa abierta, las dos con la llave
 * 'correo:<id del mensaje>'. De ahí en adelante es un retiro como cualquiera:
 * sale en 🚚 Retiros, no se le llama, retirosLogistica lo manda a logística y,
 * cuando logística avisa "retirado", el cliente pasa a "dice que pagó".
 * "No es retiro" lo corrige igual que a uno de llamada.
 *
 * Solo respuestas de los últimos CORREOS_RETIRO_DIAS días (7 por defecto), de
 * clientes de la cartera que tienen vencido. Cada respuesta cuenta una vez: si
 * ya tiene ficha, no se vuelve a tocar.
 */
const db = require('./supabaseDb');
const fichas = require('./fichas');
const schedule = require('./schedule');
const clienteConfig = require('./clienteConfig');

const DIAS = parseInt(process.env.CORREOS_RETIRO_DIAS || '7', 10);
const ABIERTAS = ['pendiente', 'en_seguimiento'];
const T_FICHA = 'llamada_ficha';
const T_PROMESA = 'promesa_pago';

const phoneKey = (v) => String(v || '').replace(/\D/g, '').slice(-10);
const correosDe = (v) => (String(v || '').toLowerCase().match(/[^\s<>(),;:"']+@[^\s<>(),;:"']+\.[^\s<>(),;:"']+/g) || []);
/** Llave de la ficha y la promesa (los mismos caracteres que acepta logística). */
const llaveDe = (mensajeId) => `correo:${String(mensajeId).replace(/[^\w.:|+-]/g, '_')}`.slice(0, 200);
const YMD = /^\d{4}-\d{2}-\d{2}$/;

/** Mismo criterio que el panel (client/src/correos.js): teléfono, código o el correo del destinatario. */
function indice(clientes) {
  const porTel = new Map(), porCodigo = new Map(), porCorreo = new Map();
  for (const c of clientes || []) {
    if (c.phone) porTel.set(phoneKey(c.phone), c);
    if (c.codigo) porCodigo.set(String(c.codigo).trim().toLowerCase(), c);
    for (const e of correosDe(c.email)) if (!porCorreo.has(e)) porCorreo.set(e, c);
  }
  return (correo) => {
    const d = correo.datos || {};
    return (d.telefono && porTel.get(phoneKey(d.telefono)))
      || (d.codigo && porCodigo.get(String(d.codigo).trim().toLowerCase()))
      || (correo.para || []).map((e) => porCorreo.get(String(e).toLowerCase())).find(Boolean)
      || null;
  };
}

/**
 * Las respuestas recientes con etiqueta 'pago_listo', con su cliente de la cartera
 * (con vencido): [{ llave, cliente, mensaje, correo }]. Una por mensaje.
 */
function candidatos(correos, clientes, ahora = new Date()) {
  const clienteDe = indice(clientes);
  const desde = ahora.getTime() - DIAS * 86400000;
  const out = [];
  const vistos = new Set();
  for (const c of correos || []) {
    for (const m of c.mensajes || []) {
      if (m.mio || vistos.has(m.id) || !m.etiqueta || m.etiqueta.categoria !== 'pago_listo') continue;
      const t = Date.parse(m.fecha);
      if (!Number.isFinite(t) || t < desde) continue;
      const cliente = clienteDe(c);
      if (!cliente || !cliente.phone || !((cliente.deuda_vencida || 0) > 0)) continue;
      vistos.add(m.id);
      out.push({ llave: llaveDe(m.id), cliente, mensaje: m, correo: c });
    }
  }
  return out;
}

/** La ficha de retiro que deja la respuesta (misma forma que la de una llamada). */
function fichaDe(m, cfg, hoy) {
  const e = m.etiqueta || {};
  const r = e.retiro || {};
  // El día que dijo que pueden pasar; si no dijo o ya pasó, cuanto antes (hoy).
  const fecha = YMD.test(String(e.fecha || '')) && e.fecha >= hoy ? e.fecha : hoy;
  const texto = String(r.frase || e.resumen || 'Tiene el pago listo para que lo pasen a buscar (correo)').slice(0, 200);
  return fichas.normalizarFicha({ modalidad: 'retiro', retiro: { fecha, franja: r.franja, desde: r.desde, hasta: r.hasta, texto } }, cfg);
}

const lista = (vals) => encodeURIComponent(vals.map((v) => `"${String(v).replace(/"/g, '')}"`).join(','));

/**
 * Crea los retiros de las respuestas 'pago_listo' que todavía no tienen ficha.
 * @param correos  la lista de correo-servicio (con las etiquetas de la IA en cada mensaje)
 * @param opts     para pruebas: ahora, datos ({ clientes }), cfg
 */
async function crear(correos, { ahora = new Date(), datos = null, cfg = null } = {}) {
  if (!db.dbEnabled) return { omitida: 'Supabase no configurado' };
  const data = datos || await require('./cache').getCachedData();
  const todos = candidatos(correos, data.clientes || [], ahora);
  if (!todos.length) return { nuevos: 0 };

  const hechas = new Set(((await db.select(T_FICHA, `?select=llamada_key&llamada_key=in.(${lista(todos.map((x) => x.llave))})`)) || [])
    .map((r) => r.llamada_key));
  const nuevos = todos.filter((x) => !hechas.has(x.llave));
  if (!nuevos.length) return { nuevos: 0 };

  const config = cfg || await schedule.get();
  const hoy = schedule.ymdInTz(ahora);
  const cuenta = { nuevos: 0, ya_era_retiro: 0 };
  for (const x of nuevos) {
    const phone = String(x.cliente.phone);
    const ficha = fichaDe(x.mensaje, config, hoy);
    const fecha = ficha.retiro.fecha;
    try {
      const [yaPromesa] = (await db.select(T_PROMESA, `?select=id&llamada_key=eq.${encodeURIComponent(x.llave)}`)) || [];
      if (!yaPromesa) {
        const [abierta] = (await db.select(T_PROMESA, `?select=id,llamada_key&phone=eq.${encodeURIComponent(phone)}&estado=in.(${ABIERTAS.join(',')})&order=created_at.desc&limit=1`)) || [];
        const fxAbierta = abierta && abierta.llamada_key
          ? ((await db.select(T_FICHA, `?select=modalidad&llamada_key=eq.${encodeURIComponent(abierta.llamada_key)}`)) || [])[0]
          : null;
        if (fxAbierta && fxAbierta.modalidad === 'retiro') {
          // Ya hay un retiro abierto (de una llamada o de otro correo): no se duplica.
          cuenta.ya_era_retiro++;
        } else {
          if (abierta) {
            await db.update(T_PROMESA, `?id=eq.${abierta.id}`, {
              estado: 'reprogramada', cerrada_at: new Date().toISOString(), motivo_cierre: 'por correo pidió que pasen a buscar el pago',
            });
          }
          await db.insertReturn(T_PROMESA, {
            phone,
            nombre: x.cliente.name || null,
            llamada_id: null,
            llamada_key: x.llave,
            fecha_llamada: x.mensaje.fecha || null,
            texto_original: ficha.retiro.texto,
            fecha_prometida: fecha,
            monto_al_prometer: x.cliente.deuda_vencida != null ? x.cliente.deuda_vencida : null,
            estado: 'pendiente',
            intento: 1,
            promesa_anterior_id: abierta ? String(abierta.id) : null,
            agente: null,
            origen: 'correo',
          });
          await clienteConfig.entrarEstado(phone, 'promesa', fecha, 'sistema (correo: pago listo para retirar)');
          cuenta.nuevos++;
        }
      }
      // La ficha va al final: si algo de arriba falla, la próxima vuelta lo reintenta.
      await db.upsert(T_FICHA, {
        llamada_key: x.llave,
        phone,
        llamada_at: x.mensaje.fecha || new Date().toISOString(),
        modalidad: 'retiro',
        retiro: ficha.retiro,
        llamar: null,
        disponibilidad: null,
        horario_aplicado: false,
      }, 'llamada_key');
    } catch (err) {
      console.error(`[correos-retiro] ${phone}: no se pudo crear el retiro:`, err.message);
    }
  }
  if (cuenta.nuevos || cuenta.ya_era_retiro) console.log('[correos-retiro]', JSON.stringify(cuenta));
  return cuenta;
}

module.exports = { crear, candidatos, fichaDe, llaveDe };
