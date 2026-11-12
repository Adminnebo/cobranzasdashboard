/**
 * Lee con IA lo que contestan los clientes a los correos de cobranza y lo etiqueta:
 *
 *   comprobante   mandó comprobante de pago (adjunto o enlace)
 *   ya_pago       dice que ya pagó, sin comprobante
 *   nota_credito  habla de una nota de crédito (emitida, aplicada o por aplicar)
 *   no_pagara     dice que no va a pagar
 *   promesa       dice que va a pagar (con o sin fecha)
 *   disputa       no está de acuerdo con el saldo o la factura
 *   consulta      pide información, facturas, estado de cuenta, otro contacto…
 *   otro          acuse ("recibido", "gracias"), respuesta automática, nada de lo anterior
 *
 * Corre en segundo plano cuando alguien abre los correos (como mucho una vez cada 2 minutos) y
 * solo sobre las respuestas que aún no tienen etiqueta. El texto, el asunto, los nombres de los
 * adjuntos y las imágenes/PDF (pequeños) van a la IA; la etiqueta se guarda en correo-servicio,
 * junto al mensaje. El gasto se registra en ia_consumo con origen 'correos'.
 */
const iaCosto = require('./iaCosto');

const MODEL = process.env.CORREOS_IA_MODEL || 'gpt-4o-mini';
const CADA_MS = 2 * 60 * 1000;
const POR_VUELTA = 40;
const MAX_IMAGEN = 4 * 1024 * 1024;
const MAX_PDF = 3 * 1024 * 1024;

const CATEGORIAS = ['comprobante', 'ya_pago', 'nota_credito', 'no_pagara', 'promesa', 'disputa', 'consulta', 'otro'];

// Mismo criterio que el panel: los avisos de no entrega no son respuestas.
const REMITENTE_REBOTE = /mailer-daemon|postmaster@|mail delivery (subsystem|system)|microsoftexchange|noreply-dmarc/i;
const ASUNTO_REBOTE = /delivery status notification|undeliverable|undelivered mail|returned mail|delivery (has )?failed|failure notice|mail delivery failed|no se (pudo|puede) entregar|no entregado|entrega fallida|devuelto/i;
const esRebote = (m) => REMITENTE_REBOTE.test(m.de || '') || ASUNTO_REBOTE.test(m.asunto || '');

const SISTEMA =
  'Lees respuestas de clientes a un correo de cobranza de una empresa de República Dominicana (el correo enviado ' +
  'es su estado de cuenta / balance de saldo con el PDF adjunto). Clasifica la respuesta del CLIENTE en UNA categoría:\n' +
  '- "comprobante": envía un comprobante, recibo, captura o constancia de pago, transferencia o depósito (como adjunto, ' +
  'imagen o enlace). Si manda el comprobante, es esta categoría aunque además diga que ya pagó.\n' +
  '- "ya_pago": dice que ya pagó, que está al día o que el pago ya se hizo, SIN adjuntar comprobante.\n' +
  '- "nota_credito": menciona una nota de crédito (que se emitió, se aplicó, falta aplicar o que corresponde) como razón ' +
  'de que el saldo no es ese o no debe pagarlo.\n' +
  '- "no_pagara": dice claramente que no va a pagar.\n' +
  '- "promesa": dice que va a pagar (con fecha o sin ella), que está gestionando el pago o pide plazo.\n' +
  '- "disputa": no está de acuerdo con el saldo, factura o cargo (error, mercancía devuelta, no reconoce la deuda), sin ' +
  'mencionar nota de crédito.\n' +
  '- "consulta": pide información, copia de facturas, detalle del estado de cuenta, o da otro contacto.\n' +
  '- "otro": acuse de recibo ("recibido", "gracias"), respuesta automática (fuera de oficina) o nada de lo anterior.\n' +
  'Mira también las imágenes y PDF adjuntos: si son un comprobante de pago, es "comprobante". No inventes: si dudas entre ' +
  'dos, elige la que el cliente dice más claro y baja la confianza.\n' +
  'Responde SOLO un JSON: {"categoria":"...","resumen":"una frase en español, máx. 140 caracteres, de lo que dice el cliente",' +
  '"monto":"monto que menciona o que muestra el comprobante, tal cual, o null","fecha":"fecha de pago que dice o muestra ' +
  '(YYYY-MM-DD) o null","confianza":0-1}';

function openai() {
  const clave = process.env.OPENAI_API_KEY_CORREOS || process.env.OPENAI_API_KEY;
  if (!clave) return null;
  const OpenAI = require('openai');
  return new OpenAI({ apiKey: clave, timeout: 90000 });
}

const sinHtml = (h) => String(h || '').replace(/<(br|\/p|\/div|\/li|\/tr)[^>]*>/gi, '\n').replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{2,}/g, '\n').trim();

/**
 * @param servicio  (metodo, ruta, cuerpo, op) → JSON de correo-servicio
 * @param bajar     (ruta) → { tipo, buffer } de un adjunto
 */
function crearClasificador({ servicio, bajar, ia = openai }) {
  let corriendo = null, ultima = 0, avisoSinClave = false;

  async function partesDe(hilo, m) {
    const partes = [];
    let imagenes = 0, pdfs = 0;
    for (const a of m.adjuntos || []) {
      if (!a.parte) continue;
      const tipo = String(a.tipo || '');
      const esImg = /^image\/(png|jpe?g|webp|gif)$/.test(tipo) && imagenes < 2 && (!a.bytes || a.bytes <= MAX_IMAGEN);
      const esPdf = tipo === 'application/pdf' && pdfs < 1 && (!a.bytes || a.bytes <= MAX_PDF);
      if (!esImg && !esPdf) continue;
      try {
        const { tipo: t, buffer } = await bajar(`/v1/correos/hilo/${hilo}/adjunto/${m.id}/${a.parte}`);
        const url = `data:${t || tipo};base64,${buffer.toString('base64')}`;
        if (esImg) { partes.push({ type: 'image_url', image_url: { url, detail: 'low' } }); imagenes++; }
        else { partes.push({ type: 'file', file: { filename: a.nombre || 'adjunto.pdf', file_data: url } }); pdfs++; }
      } catch (e) { /* sin el adjunto se clasifica igual con el texto */ }
    }
    return partes;
  }

  async function clasificarUno(client, correo, hilo, m) {
    const texto = (m.texto || sinHtml(m.html) || m.extracto || '').slice(0, 3000);
    const datos = {
      correo_enviado: { asunto: correo.asunto, fecha: correo.fecha },
      respuesta: { de: m.de, fecha: m.fecha, asunto: m.asunto, texto, adjuntos: (m.adjuntos || []).map((a) => `${a.nombre} (${a.tipo || '?'})`) },
    };
    const adjuntos = await partesDe(hilo, m);
    const pedir = (conAdjuntos) => client.chat.completions.create({
      model: MODEL, temperature: 0, response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SISTEMA },
        { role: 'user', content: [{ type: 'text', text: JSON.stringify(datos, null, 1) }, ...(conAdjuntos ? adjuntos : [])] },
      ],
    });
    let resp;
    try { resp = await pedir(true); } catch (e) {
      if (!adjuntos.length || !(e.status === 400)) throw e;
      resp = await pedir(false); // algún adjunto no lo aceptó (PDF raro, imagen dañada): solo el texto
    }
    const u = resp.usage || {};
    await iaCosto.registrar({
      origen: 'correos', modelo: resp.model || MODEL, llamadas: 1,
      uso: { entrada: u.prompt_tokens || 0, cache: (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) || 0, salida: u.completion_tokens || 0 },
    });
    let r = {};
    try { r = JSON.parse(resp.choices[0].message.content) || {}; } catch (_) { r = {}; }
    const categoria = CATEGORIAS.includes(r.categoria) ? r.categoria : 'otro';
    const conf = Number(r.confianza);
    return {
      categoria,
      resumen: String(r.resumen || '').slice(0, 200),
      monto: r.monto ? String(r.monto).slice(0, 40) : null,
      fecha: /^\d{4}-\d{2}-\d{2}$/.test(String(r.fecha || '')) ? r.fecha : null,
      confianza: Number.isFinite(conf) ? Math.max(0, Math.min(1, conf)) : null,
      modelo: resp.model || MODEL,
    };
  }

  async function vuelta() {
    const client = ia();
    if (!client) {
      if (!avisoSinClave) { avisoSinClave = true; console.warn('[correos-ia] sin OPENAI_API_KEY: no se leen las respuestas'); }
      return { leidas: 0 };
    }
    const j = await servicio('GET', '/v1/correos', null, { espera: 30000 });
    if (!j.lectura) return { leidas: 0 };
    // Respuestas sin etiqueta, agrupadas por hilo (cada hilo se abre una vez).
    const porHilo = new Map();
    const vistos = new Set();
    let total = 0;
    for (const c of j.correos || []) {
      if (!c.hilo || !c.mensajes) continue;
      for (const m of c.mensajes) {
        if (m.mio || m.etiqueta || esRebote(m) || vistos.has(m.id) || total >= POR_VUELTA) continue;
        vistos.add(m.id); total++;
        if (!porHilo.has(c.hilo)) porHilo.set(c.hilo, { correo: c, ids: new Set() });
        porHilo.get(c.hilo).ids.add(m.id);
      }
    }
    let leidas = 0;
    for (const [hilo, { correo, ids }] of porHilo) {
      const items = [];
      try {
        const h = await servicio('GET', `/v1/correos/hilo/${hilo}`, null, { espera: 30000 });
        for (const m of h.mensajes || []) {
          if (!ids.has(m.id)) continue;
          items.push({ mensaje: m.id, hilo, etiqueta: await clasificarUno(client, correo, hilo, m) });
        }
      } catch (e) {
        console.error(`[correos-ia] no se pudo leer el hilo ${hilo}:`, e.message);
      }
      if (items.length) {
        await servicio('PUT', '/v1/correos/etiquetas', { items }, { espera: 30000 });
        leidas += items.length;
      }
    }
    if (leidas) console.log(`[correos-ia] ${leidas} respuesta(s) leída(s) con IA`);
    return { leidas };
  }

  // No bloquea: lanza una vuelta si no hay otra y pasaron 2 minutos desde la anterior.
  function disparar() {
    if (corriendo || Date.now() - ultima < CADA_MS) return corriendo;
    ultima = Date.now();
    corriendo = vuelta().catch((e) => { console.error('[correos-ia] falló la vuelta:', e.message); return { leidas: 0 }; })
      .finally(() => { corriendo = null; });
    return corriendo;
  }

  return { disparar, vuelta };
}

module.exports = { crearClasificador, CATEGORIAS, esRebote, sinHtml, SISTEMA };
