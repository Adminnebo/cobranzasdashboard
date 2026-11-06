/**
 * Ficha de cada llamada contestada: lo que el cliente dijo sobre CÓMO y CUÁNDO,
 * leído de la transcripción con IA (FICHAS_MODEL, gpt-4o-mini por defecto) con
 * su propia llave (OPENAI_API_KEY_FICHAS). Cada llamada se lee UNA sola vez; el
 * gasto de cada consulta se registra en ia_consumo y se cobra en Sword (iaCosto).
 *
 *   modalidad      'retiro' (pasan a buscar el pago) | 'transferencia' | 'otro' | null
 *   retiro         { fecha, franja: 'manana'|'tarde'|'hora'|null, desde, hasta, texto }
 *   llamar         { fecha, hora, texto }      pidió que lo llamen a una hora puntual (una vez)
 *   disponibilidad { bloques: [{start,end,dias?}], texto }   horario que se repite
 *
 * Con la disponibilidad, el sistema ajusta solo el horario propio del cliente
 * (nunca pisa uno puesto a mano). Las fichas se guardan en llamada_ficha. Si la
 * IA no respondió (red, error de la API: no hay gasto), la llamada no se marca y
 * se reintenta. Si respondió pero ilegible, ya se pagó: se marca con error y no
 * se vuelve a leer.
 */

const db = require('./supabaseDb');
const schedule = require('./schedule');
const clienteConfig = require('./clienteConfig');
const iaCosto = require('./iaCosto');

const TABLE = 'llamada_ficha';
const MODEL = process.env.FICHAS_MODEL || 'gpt-4o-mini';
const DIAS_ATRAS = parseInt(process.env.FICHA_DIAS || '2', 10); // llamadas de los últimos N días
const LOTE = 8;          // llamadas por consulta a la IA
const MAX_POR_VUELTA = 24;

const HHMM = /^\d{2}:\d{2}$/;
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const DIA_NOMBRE = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const toMins = (s) => { const [h, m] = String(s).split(':').map(Number); return h * 60 + m; };
const aHhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const hhmm = (v) => (HHMM.test(String(v || '')) ? String(v) : null);
const ymd = (v) => (YMD.test(String(v || '')) ? String(v) : null);
const texto = (v) => String(v || '').trim().slice(0, 200) || null;

const llamadaKey = (l) => (l.id != null && l.id !== '' ? `log:${l.id}` : `${l.phone}|${l.created_at}`);

let tablaFalta = false; // sql/008 sin correr: no insistir en cada vuelta
let avisoSinClave = false;

// Llave exclusiva de la lectura de llamadas: su gasto se ve aparte en OpenAI.
function openai() {
  if (!process.env.OPENAI_API_KEY_FICHAS) return null;
  const OpenAI = require('openai');
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY_FICHAS, timeout: 60000 });
}

function prompt(cfg) {
  const m = cfg.retiroManana || schedule.DEFAULT.retiroManana;
  const t = cfg.retiroTarde || schedule.DEFAULT.retiroTarde;
  return 'Lees transcripciones de llamadas de cobranza en español (República Dominicana). "AI" es Camila, la agente; ' +
    '"User" es el cliente. Para cada llamada devuelve SOLO lo que el CLIENTE dijo, sin inventar:\n' +
    '1. modalidad: "retiro" SOLO si el CLIENTE pide claramente que alguien de la empresa vaya o pase a buscar, recoger ' +
    'o retirar el pago (cheque, efectivo) donde está él. NO es retiro: "yo paso a pagar", "lo llevo", "lo dejo en su oficina", ' +
    '"pago en caja", "lo deposito", que solo lo mencione Camila, ni un "sí" a algo que nadie ofreció claro. Si dudas, NO es retiro. ' +
    '"transferencia" si dice que transfiere o deposita; "otro" si dice otra forma; null si no lo dijo.\n' +
    '2. retiro (solo si modalidad es "retiro"): texto = la frase EXACTA del cliente que lo pide, copiada tal cual de la ' +
    'transcripción (obligatoria: si no hay una frase así, la modalidad NO es "retiro"); fecha YYYY-MM-DD en que pueden pasar ' +
    `(usa la fecha de la llamada para resolver "mañana", "el viernes"…; null si no dijo), franja "manana" (${m.desde}–${m.hasta}), "tarde" (${t.desde}–${t.hasta}) ` +
    'u "hora" si dio una hora o un rango concreto (entonces desde/hasta HH:MM 24h; si dio una sola hora, solo desde), ' +
    'null si no dijo.\n' +
    '3. llamar: si pidió que lo llamen UNA VEZ en un día/hora puntual ("llámenme mañana a las 3", "llame el lunes a las 10"): ' +
    'fecha YYYY-MM-DD y hora HH:MM 24h (las 3 de la tarde = 15:00; si no dice am/pm y es entre 1 y 7, es de la tarde); null si no.\n' +
    '4. disponibilidad: si describió un horario que SE REPITE para que lo llamen ("solo puedo en las mañanas", "los martes", ' +
    '"entre 9:50 y 10", "después de las 4", "martes y jueves a las 10"): bloques [{dias:[1-7]|null, desde, hasta}] con ' +
    '1=lunes…7=domingo (null = cualquier día); "mañanas" = 08:00–12:00, "tardes" = 14:00–18:00; "después de las 4" = 16:00–19:00; ' +
    'una sola hora = esa hora + 30 min. NO lo pongas por una llamada de una sola vez (eso es "llamar"). null si no dijo.\n' +
    'Responde SOLO un JSON: {"fichas":[{"id":"<id>","modalidad":...,"retiro":{...}|null,"llamar":{...}|null,' +
    '"disponibilidad":{"bloques":[...],"texto":"..."}|null}]}';
}

/**
 * Una consulta a la IA por lote. Si respondió, su gasto se registra siempre
 * (aunque la respuesta venga ilegible: ya se pagó).
 * @returns null sin llave | { mapa: Map<id, raw>, error?: string }
 */
async function extraerConIA(items, cfg) {
  const client = openai();
  if (!client) return null;
  const resp = await client.chat.completions.create({
    model: MODEL,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: prompt(cfg) },
      { role: 'user', content: JSON.stringify(items.map((i) => ({ id: i.id, fecha_llamada: i.fecha, dia: i.dia, transcripcion: i.transcripcion })), null, 1) },
    ],
  });
  const u = resp.usage || {};
  await iaCosto.registrar({
    origen: 'fichas', modelo: resp.model || MODEL, llamadas: items.length,
    uso: { entrada: u.prompt_tokens || 0, cache: (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) || 0, salida: u.completion_tokens || 0 },
  });
  try {
    const parsed = JSON.parse(resp.choices[0].message.content);
    return { mapa: new Map(((parsed && parsed.fichas) || []).map((f) => [String(f.id), f])) };
  } catch (err) {
    return { mapa: new Map(), error: `respuesta ilegible de la IA: ${err.message}`.slice(0, 200) };
  }
}

// Sin tildes, minúsculas, solo letras y números.
const plano = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9ñ ]+/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * ¿La cita la dijo el cliente? Al menos el 60 % de sus palabras (de 3+ letras)
 * tienen que estar en lo que habló el cliente (líneas "User:"). Frena las citas
 * inventadas o puestas en boca de Camila.
 */
function citaDelCliente(cita, transcripcion) {
  const habla = String(transcripcion || '').split('\n')
    .filter((l) => /^\s*(User|Cliente)\s*:/i.test(l)).join(' ');
  const t = ` ${plano(habla)} `;
  const palabras = plano(cita).split(' ').filter((w) => w.length >= 3);
  if (!palabras.length) return false;
  return palabras.filter((w) => t.includes(` ${w} `)).length / palabras.length >= 0.6;
}

/**
 * Limpia lo que devolvió la IA y lo lleva a la forma que usa el panel.
 * Un retiro sin la frase del cliente (o con una que el cliente no dijo) no cuenta.
 */
function normalizarFicha(raw, cfg, transcripcion = null) {
  const r = raw || {};
  let modalidad = ['retiro', 'transferencia', 'otro'].includes(r.modalidad) ? r.modalidad : null;
  if (modalidad === 'retiro') {
    const cita = texto(r.retiro && r.retiro.texto);
    if (!cita || (transcripcion && !citaDelCliente(cita, transcripcion))) modalidad = null;
  }

  let retiro = null;
  if (modalidad === 'retiro') {
    const x = r.retiro || {};
    const franja = ['manana', 'tarde', 'hora'].includes(x.franja) ? x.franja : null;
    let desde = null; let hasta = null;
    if (franja === 'manana') ({ desde, hasta } = cfg.retiroManana || schedule.DEFAULT.retiroManana);
    else if (franja === 'tarde') ({ desde, hasta } = cfg.retiroTarde || schedule.DEFAULT.retiroTarde);
    else if (franja === 'hora' && hhmm(x.desde)) {
      desde = hhmm(x.desde);
      hasta = hhmm(x.hasta) && toMins(x.hasta) > toMins(desde) ? hhmm(x.hasta) : aHhmm(Math.min(toMins(desde) + 60, 23 * 60 + 59));
    }
    retiro = { fecha: ymd(x.fecha), franja: desde ? franja : null, desde, hasta, texto: texto(x.texto) };
  }

  const l = r.llamar || null;
  const llamar = l && hhmm(l.hora) ? { fecha: ymd(l.fecha), hora: hhmm(l.hora), texto: texto(l.texto) } : null;

  let disponibilidad = null;
  const d = r.disponibilidad;
  if (d && Array.isArray(d.bloques) && d.bloques.length) {
    const bloques = d.bloques
      .filter((b) => b && hhmm(b.desde))
      .map((b) => {
        const start = hhmm(b.desde);
        const end = hhmm(b.hasta) && toMins(b.hasta) > toMins(start) ? hhmm(b.hasta) : aHhmm(Math.min(toMins(start) + 30, 23 * 60 + 59));
        return { start, end, ...(Array.isArray(b.dias) && b.dias.length ? { dias: b.dias } : {}) };
      });
    // Recorta al rango permitido para horarios de cliente (08:00–19:00 por defecto).
    const limpios = schedule.bloquesCliente(cfg, bloques);
    if (limpios) disponibilidad = { bloques: limpios, texto: texto(d.texto) };
  }
  return { modalidad, retiro, llamar, disponibilidad };
}

const fechaCorta = (iso) => {
  try { return new Date(iso).toLocaleDateString('es-DO', { day: 'numeric', month: 'short', timeZone: schedule.TZ }); }
  catch { return ''; }
};

/**
 * Ajusta el horario propio con la disponibilidad que dio el cliente. No toca un
 * horario puesto a mano. Devuelve true si lo cambió.
 */
async function aplicarDisponibilidad(phone, ficha, ll, cfg, info) {
  if (!ficha.disponibilidad || cfg.horarioAuto === false) return false;
  const actual = info.get(String(phone));
  if (actual && actual.horario && actual.origen !== 'ia') return false; // puesto a mano: manda la persona
  const detalle = `${ficha.disponibilidad.texto ? `"${ficha.disponibilidad.texto}" · ` : ''}llamada del ${fechaCorta(ll.created_at)}`;
  await clienteConfig.setHorario([String(phone)], ficha.disponibilidad.bloques, 'sistema (lo dijo el cliente)', { origen: 'ia', detalle });
  return true;
}

/**
 * Hora pedida ("llámenme mañana a las 3"): se guarda como cita del cliente y la
 * cola lo llama ese día a esa hora (por encima de su horario y del general).
 * Sin fecha: hoy si esa hora todavía no pasó, si no el siguiente día hábil.
 * Solo dentro del rango permitido para horarios de cliente y en el futuro.
 * @returns {boolean} si la guardó
 */
async function aplicarCita(phone, ficha, ll, cfg, ahora = new Date()) {
  const l = ficha.llamar;
  if (!l || !l.hora) return false;
  const desde = cfg.horarioClienteDesde || schedule.DEFAULT.horarioClienteDesde;
  const hasta = cfg.horarioClienteHasta || schedule.DEFAULT.horarioClienteHasta;
  if (l.hora < desde || l.hora >= hasta) return false;
  const diaLlamada = schedule.ymdInTz(new Date(ll.created_at || ahora));
  let fecha = l.fecha;
  if (!fecha) {
    const horaLlamada = schedule.partsInTz(new Date(ll.created_at || ahora)).mins;
    fecha = toMins(l.hora) > horaLlamada ? diaLlamada : schedule.sumarHabiles(diaLlamada, 1);
  }
  const at = new Date(`${fecha}T${l.hora}:00-04:00`); // RD: UTC−4 todo el año
  if (Number.isNaN(at.getTime()) || at.getTime() <= ahora.getTime()) return false;
  return clienteConfig.setCita(String(phone), at.toISOString(), {
    texto: l.texto || null, origen: 'ia', updatedBy: 'sistema (lo pidió el cliente)',
  });
}

/**
 * Saca la ficha de las llamadas contestadas que todavía no la tienen.
 * @param llamadas  las de la cartera + las de prueba (de getCachedData)
 * @param opts.extraer  para pruebas: (items, cfg) => Map<id, raw>
 */
async function procesar(llamadas, cfg, { extraer = extraerConIA } = {}) {
  if (tablaFalta || !db.dbEnabled) return { omitida: true };
  const desde = Date.now() - DIAS_ATRAS * 86400000;
  const candidatas = (llamadas || []).filter((l) => l.phone && l.created_at && Date.parse(l.created_at) >= desde
    && l.resultado !== 'no_answer' && l.intencion_pago !== 'no_contesta'
    && /(^|\n)\s*(User|Cliente)\s*:/i.test(l.transcripcion || '') && (l.transcripcion || '').length > 60)
    // De la más vieja a la más nueva: si el cliente cambió de horario, queda lo último que dijo.
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  if (!candidatas.length) return { nuevas: 0 };

  let hechas;
  try {
    const keys = candidatas.map(llamadaKey);
    hechas = new Set();
    for (let i = 0; i < keys.length; i += 100) {
      const lote = keys.slice(i, i + 100).map((k) => `"${k.replace(/"/g, '')}"`).join(',');
      const rows = await db.select(TABLE, `?select=llamada_key&llamada_key=in.(${encodeURIComponent(lote)})`);
      for (const r of rows || []) hechas.add(r.llamada_key);
    }
  } catch (err) {
    if (/llamada_ficha|does not exist|42P01|PGRST205/i.test(err.message)) {
      tablaFalta = true;
      console.warn('[fichas] falta la tabla llamada_ficha (sql/008): no se leen las fichas');
      return { omitida: true };
    }
    throw err;
  }
  const nuevas = candidatas.filter((l) => !hechas.has(llamadaKey(l))).slice(0, MAX_POR_VUELTA);
  if (!nuevas.length) return { nuevas: 0 };

  const info = await clienteConfig.getHorarioInfoMap();
  const cuenta = { nuevas: 0, retiros: 0, llamar: 0, horarios: 0, citas: 0 };
  for (let i = 0; i < nuevas.length; i += LOTE) {
    const lote = nuevas.slice(i, i + LOTE);
    const items = lote.map((l) => {
      const d = new Date(l.created_at);
      return { id: llamadaKey(l), fecha: schedule.ymdInTz(d), dia: DIA_NOMBRE[new Date(schedule.ymdInTz(d) + 'T12:00:00Z').getUTCDay()], transcripcion: String(l.transcripcion).slice(0, 4000) };
    });
    let res;
    try { res = await extraer(items, cfg); }
    catch (err) { console.error('[fichas] la IA no respondió, se reintenta luego:', err.message); continue; }
    if (!res) {
      if (!avisoSinClave) { avisoSinClave = true; console.warn('[fichas] falta OPENAI_API_KEY_FICHAS: la lectura de llamadas está en pausa'); }
      return cuenta;
    }
    avisoSinClave = false;
    const crudas = res instanceof Map ? res : res.mapa;
    const error = res instanceof Map ? null : res.error || null;
    if (error) console.error('[fichas]', error, '(esas llamadas quedan marcadas y no se vuelven a pagar)');

    for (const ll of lote) {
      const key = llamadaKey(ll);
      const ficha = normalizarFicha(crudas.get(key), cfg, ll.transcripcion);
      let horarioAplicado = false;
      try { horarioAplicado = await aplicarDisponibilidad(ll.phone, ficha, ll, cfg, info); }
      catch (err) { console.error(`[fichas] ${ll.phone}: no se pudo ajustar el horario:`, err.message); }
      try { if (await aplicarCita(ll.phone, ficha, ll, cfg)) cuenta.citas++; }
      catch (err) { console.error(`[fichas] ${ll.phone}: no se pudo guardar la hora pedida:`, err.message); }
      await db.upsert(TABLE, {
        llamada_key: key,
        phone: String(ll.phone),
        llamada_at: ll.created_at,
        modalidad: ficha.modalidad,
        retiro: ficha.retiro,
        llamar: ficha.llamar,
        disponibilidad: ficha.disponibilidad,
        horario_aplicado: horarioAplicado,
        ...(error ? { error } : {}),
      }, 'llamada_key');
      cuenta.nuevas++;
      if (ficha.modalidad === 'retiro') cuenta.retiros++;
      if (ficha.llamar) cuenta.llamar++;
      if (horarioAplicado) cuenta.horarios++;
    }
  }
  if (cuenta.nuevas) console.log('[fichas]', JSON.stringify(cuenta));
  return cuenta;
}

/** Corrección a mano: "no es retiro". La ficha queda como 'no_retiro' y sale de la lista. */
async function marcarNoRetiro(llamadaKeyValor, por) {
  const k = String(llamadaKeyValor || '');
  if (!k) throw Object.assign(new Error('Falta la llamada'), { status: 400 });
  const [f] = (await db.select(TABLE, `?select=llamada_key,modalidad&llamada_key=eq.${encodeURIComponent(k)}`)) || [];
  if (!f) throw Object.assign(new Error('Esa llamada no tiene ficha'), { status: 404 });
  await db.update(TABLE, `?llamada_key=eq.${encodeURIComponent(k)}`, { modalidad: 'no_retiro', corregida_por: por || null });
  return true;
}

/** Fichas con algo que mostrar de los últimos N días, por llamada_key. */
async function mapaReciente(dias = 45) {
  if (tablaFalta) return new Map();
  try {
    const desde = new Date(Date.now() - dias * 86400000).toISOString();
    const rows = await db.select(TABLE, `?select=*&llamada_at=gte.${desde}`);
    return new Map((rows || []).filter((r) => r.modalidad || r.llamar || r.disponibilidad).map((r) => [r.llamada_key, r]));
  } catch (err) { return new Map(); }
}

module.exports = { aplicarCita, procesar, normalizarFicha, citaDelCliente, marcarNoRetiro, mapaReciente, llamadaKey, TABLE };
