const { Resend } = require("resend");

function env(name, fallback = null) {
  const v = process.env[name];
  return v === undefined || v === null || v === "" ? fallback : v;
}

function fmtCLP(n) {
  const v = Number(n || 0);
  return v.toLocaleString("es-CL");
}

function safeText(s) {
  return String(s ?? "").replace(/[<>]/g, "");
}

// ===============================
// ✅ NORMALIZACIÓN / FORMATO
// ===============================
function normalizeDeliveryMethodLabel(raw) {
  const s = String(raw || "").toLowerCase().trim();

  if (["retiro", "pickup", "retiro_en_tienda", "retira", "retirar"].includes(s)) {
    return "retiro";
  }

  // en tu sistema llega como envio_por_pagar
  if (
    ["envio_por_pagar", "envío_por_pagar", "envio", "envío", "despacho", "delivery", "shipping"].includes(s)
  ) {
    return "envío";
  }

  return raw ? String(raw) : "envío o retiro";
}

/**
 * Formato solicitado:
 * 01 Polera En el Techo — Negra XL
 */
function formatItemsPretty(items = []) {
  const arr = Array.isArray(items) ? items : [];

  return arr
    .map((it) => {
      const qty = Number(it.quantity ?? it.qty ?? 0) || 0;
      const qtyLabel = String(qty || 1).padStart(2, "0");

      const name =
        it.design ||
        it.grabado_nombre ||
        it.name ||
        "Polera";

      const variant = [it.color, it.size].filter(Boolean).join(" ").trim();

      return `• ${qtyLabel} ${safeText(name)}${variant ? ` — ${safeText(variant)}` : ""}`;
    })
    .join("<br/>");
}

function renderItemsBlock(items = []) {
  const list = formatItemsPretty(items);

  return `
    <div style="margin:14px 0 0">
      <div style="font-weight:700;margin-bottom:6px">Items</div>
      <div style="color:#111827">${list || "-"}</div>
    </div>
  `;
}

// ===============================
// ✅ RESEND
// ===============================
let _resend = null;

function getResend() {
  if (_resend) return _resend;

  const apiKey = env("RESEND_API_KEY");
  if (!apiKey) throw new Error("Missing RESEND_API_KEY env var.");

  _resend = new Resend(apiKey);
  return _resend;
}

/**
 * Resend requiere "from" tipo: "Nombre <correo@dominio>"
 */
function getFrom() {
  return (
    env("FROM_EMAIL") ||
    "Poleras Cervecería Huillinco <contacto@cerveceriahuillinco.cl>"
  );
}

async function sendMail({ to, subject, html, text }) {
  const resend = getResend();
  const from = getFrom();

  const { error } = await resend.emails.send({
    from,
    to: Array.isArray(to) ? to : [to],
    subject,
    html,
    text,
  });

  if (error) {
    throw new Error(
      `Resend send failed: ${error.message || JSON.stringify(error)}`
    );
  }

  return { ok: true };
}

// ===============================
// ✅ WHATSAPP
// ===============================
function buildWhatsAppLink({ buyerName, reference, deliveryMethodLabel, items }) {
  // Puedes definirlo en Render como WHATSAPP_NUMBER (ej: 56966592507)
  const phone = env("WHATSAPP_NUMBER", "56966592507");

  const name = String(buyerName || "").trim();
  const who = name ? name : (reference ? `ref ${reference}` : "cliente");

  // Armar resumen de productos (sin SKU) para el mensaje
  const arr = Array.isArray(items) ? items : [];
  const lines = arr
    .filter(Boolean)
    .map((it) => {
      const qty = Number(it.quantity ?? it.qty ?? 1) || 1;
      const qtyLabel = String(qty).padStart(2, "0");
      const productName = it.design || it.grabado_nombre || it.name || "Polera";
      const variant = [it.color, it.size].filter(Boolean).join(" ").trim();
      return `${qtyLabel} ${productName}${variant ? ` — ${variant}` : ""}`;
    });

  const maxItems = 3;
  const shown = lines.slice(0, maxItems);
  const more = lines.length > maxItems ? ` +${lines.length - maxItems} más` : "";

  const productsLine = shown.length ? `Producto: ${shown.join("; ")}${more}.` : "";

  const dm = deliveryMethodLabel || "envío o retiro";
  const refLine = reference ? ` (${reference}).` : ".";
  const msg = `Hola! Soy ${who} 🙂. Mi compra fue confirmada${refLine} ${productsLine} Quiero coordinar ${dm}.`
    .replace(/\s+/g, " ")
    .trim();

  const url = `https://wa.me/${phone}?text=${encodeURIComponent(msg)}`;
  return { phone, url };
}

// ===============================
// ✅ EMAIL: CLIENTE
// ===============================
async function sendCustomerConfirmationEmail(order) {
  const ref = safeText(order.reference || "");
  const buyerName = safeText(order.buyer_name || "");
  const deliveryMethodLabel = normalizeDeliveryMethodLabel(order.delivery_method);

  // items pueden venir como array o como string JSON
  let items = [];
  try {
    items = Array.isArray(order.items) ? order.items : JSON.parse(order.items || "[]");
  } catch {
    items = [];
  }

  const total = fmtCLP(order.total_clp);

  const { phone, url } = buildWhatsAppLink({
    buyerName: order.buyer_name,
    reference: ref,
    deliveryMethodLabel,
    items,
  });

  const html = `
    <div style="font-family:system-ui,Arial;line-height:1.4;max-width:720px">
      <h2 style="margin:0 0 8px">✅ Compra confirmada — Poleras Huillinco</h2>
      <p style="margin:0 0 10px">Hola ${buyerName || "👋"}, tu pago fue confirmado.</p>

      ${ref ? `<p style="margin:0 0 12px"><b>Referencia:</b> ${ref}</p>` : ""}

      <p style="margin:0 0 14px">
        <b>Pronto te contactaremos</b> para coordinar tu <b>${safeText(deliveryMethodLabel)}</b>.
      </p>

      ${renderItemsBlock(items)}

      <p style="margin:10px 0 0"><b>Total:</b> $${total} CLP</p>

      <a
        href="${url}"
        style="
          display:inline-block;
          background:#25D366;
          color:#ffffff !important;
          text-decoration:none;
          padding:12px 16px;
          border-radius:10px;
          font-weight:700;
          margin:14px 0 10px;
        "
      >Hablar por WhatsApp</a>

      <p style="margin:0 0 8px;color:#374151;font-size:13px">
        Si el botón no aparece, abre este enlace: <br/>
        <a href="${url}" style="color:#2563eb">${safeText(url)}</a>
      </p>

      <p style="margin:14px 0 0;color:#374151">
        — Cervecería Huillinco<br/>
        WhatsApp: +${phone}
      </p>
    </div>
  `;

  const to = order.to || order.buyer_email;
  if (!to) throw new Error("Missing customer email (buyer_email).");

  return sendMail({
    to,
    subject: ref
      ? `✅ Compra confirmada — ${ref}`
      : `✅ Compra confirmada — Poleras Huillinco`,
    html,
    text: `Compra confirmada${ref ? ` (Ref: ${ref})` : ""}. Items: ${formatItemsPretty(items).replace(/<br\/>/g, " | ").replace(/• /g, "")}. Total: $${total} CLP. Pronto te contactaremos para coordinar tu ${deliveryMethodLabel}. WhatsApp: +${phone} ${url}`,
  });
}

// ===============================
// ✅ EMAIL: TIENDA (SIN SKU)
// ===============================
async function sendStoreNotificationEmail(order) {
  const ref = safeText(order.reference || "");

  // items pueden venir como array o como string JSON
  let items = [];
  try {
    items = Array.isArray(order.items) ? order.items : JSON.parse(order.items || "[]");
  } catch {
    items = [];
  }

  const total = fmtCLP(order.total_clp);

  const deliveryMethodLabel = normalizeDeliveryMethodLabel(order.delivery_method);

  const deliveryAddress = order.delivery_address
    ? safeText(order.delivery_address)
    : null;

  const html = `
    <div style="font-family:system-ui,Arial;line-height:1.4;max-width:720px">
      <h2 style="margin:0 0 8px">🛒 Nueva venta confirmada</h2>

      <p style="margin:0 0 6px"><b>Referencia:</b> ${ref}</p>
      <p style="margin:0 0 6px"><b>Cliente:</b> ${safeText(order.buyer_name || "-")}</p>
      <p style="margin:0 0 6px"><b>Email:</b> ${safeText(order.buyer_email || "-")}</p>
      <p style="margin:0 0 6px"><b>Teléfono:</b> ${safeText(order.buyer_phone || "-")}</p>
      <p style="margin:0 0 6px"><b>Método de entrega:</b> ${safeText(deliveryMethodLabel)}</p>
      ${
        deliveryAddress
          ? `<p style="margin:0 0 10px"><b>Dirección:</b> ${deliveryAddress}</p>`
          : `<div style="height:8px"></div>`
      }

      ${renderItemsBlock(items)}

      <p style="margin:10px 0 0"><b>Total:</b> $${total} CLP</p>
    </div>
  `;

  const to = order.to || env("STORE_NOTIFY_EMAIL");
  if (!to) throw new Error("Missing store email (STORE_NOTIFY_EMAIL).");

  return sendMail({
    to,
    subject: `🛒 Nueva venta confirmada — ${ref}`,
    html,
    text: `Nueva venta confirmada. Ref: ${ref}. Items: ${formatItemsPretty(items).replace(/<br\/>/g, " | ").replace(/• /g, "")}. Total: $${total} CLP.`,
  });
}

module.exports = {
  sendMail,
  sendCustomerConfirmationEmail,
  sendStoreNotificationEmail,
};
