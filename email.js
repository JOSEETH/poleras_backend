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

function renderItemsTable(items = []) {
  const rows = (items || [])
    .map((it) => {
      const sku = safeText(it.sku || "");
      const variant = safeText([it.color, it.size].filter(Boolean).join(" "));
      const qty = Number(it.quantity || 0);
      const price = fmtCLP(it.price_clp);
      return `
        <tr>
          <td style="padding:8px;border:1px solid #e5e7eb">${sku}</td>
          <td style="padding:8px;border:1px solid #e5e7eb">${variant}</td>
          <td style="padding:8px;border:1px solid #e5e7eb">${qty}</td>
          <td style="padding:8px;border:1px solid #e5e7eb">$${price}</td>
        </tr>
      `;
    })
    .join("");

  return `
    <table style="border-collapse:collapse;width:100%;max-width:720px">
      <thead>
        <tr>
          <th style="padding:8px;border:1px solid #e5e7eb;text-align:left">SKU</th>
          <th style="padding:8px;border:1px solid #e5e7eb;text-align:left">Variante</th>
          <th style="padding:8px;border:1px solid #e5e7eb;text-align:left">Cant.</th>
          <th style="padding:8px;border:1px solid #e5e7eb;text-align:left">Precio</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

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
 * Tu dominio cerveceriahuillinco.cl ya está verificado, así que esto está OK.
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

function buildWhatsAppLink({ reference, deliveryMethod }) {
  const phone = "56966592507";
  const msg = `Hola! Soy ${reference || "cliente"} 🙂. Mi compra fue confirmada. Quiero coordinar ${deliveryMethod || "envío o retiro"}.`;
  const url = `https://wa.me/${phone}?text=${encodeURIComponent(msg)}`;
  return { phone, url };
}

async function sendCustomerConfirmationEmail(order) {
  const ref = safeText(order.reference || "");
  const buyerName = safeText(order.buyer_name || "");
  const deliveryMethodRaw = safeText(order.delivery_method || "");
  const deliveryMethod =
    deliveryMethodRaw.toLowerCase() === "retiro"
      ? "retiro"
      : deliveryMethodRaw.toLowerCase() === "envio" || deliveryMethodRaw.toLowerCase() === "envío"
      ? "envío"
      : deliveryMethodRaw || "envío o retiro";

  const { phone, url } = buildWhatsAppLink({
    reference: ref ? `ref ${ref}` : "cliente",
    deliveryMethod,
  });

  const html = `
    <div style="font-family:system-ui,Arial;line-height:1.4;max-width:720px">
      <h2 style="margin:0 0 8px">✅ Compra confirmada — Poleras Huillinco</h2>
      <p style="margin:0 0 10px">Hola ${buyerName || "👋"}, tu pago fue confirmado.</p>

      ${ref ? `<p style="margin:0 0 12px"><b>Referencia:</b> ${ref}</p>` : ""}

      <p style="margin:0 0 14px">
        <b>Pronto te contactaremos</b> para coordinar tu <b>${deliveryMethod}</b>.
      </p>

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
          margin:6px 0 10px;
        "
      >Hablar por Whatsapp</a>

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
    subject: ref ? `✅ Compra confirmada — ${ref}` : `✅ Compra confirmada — Poleras Huillinco`,
    html,
    text: `Compra confirmada${ref ? ` (Ref: ${ref})` : ""}. Pronto te contactaremos para coordinar tu ${deliveryMethod}. WhatsApp: +${phone} ${url}`,
  });
}

async function sendStoreNotificationEmail(order) {
  const ref = safeText(order.reference || "");
  const total = fmtCLP(order.total_clp);
  const items = Array.isArray(order.items) ? order.items : [];

  const deliveryMethod = safeText(order.delivery_method || "-");
  const deliveryAddress = order.delivery_address
    ? safeText(order.delivery_address)
    : null;

  const itemsList = (items || [])
    .map((it) => {
      const sku = safeText(it.sku || "");
      const variant = safeText([it.color, it.size].filter(Boolean).join(" "));
      const qty = Number(it.quantity || 0);
      const price = fmtCLP(it.price_clp);
      return `• ${qty}× ${sku} (${variant}) — $${price}`;
    })
    .join("<br/>");

  const html = `
    <div style="font-family:system-ui,Arial;line-height:1.4">
      <h2 style="margin:0 0 8px">🛒 Nueva venta confirmada</h2>

      <p style="margin:0 0 6px"><b>Referencia:</b> ${ref}</p>
      <p style="margin:0 0 6px"><b>Cliente:</b> ${safeText(order.buyer_name || "-")}</p>
      <p style="margin:0 0 6px"><b>Email:</b> ${safeText(order.buyer_email || "-")}</p>
      <p style="margin:0 0 6px"><b>Teléfono:</b> ${safeText(order.buyer_phone || "-")}</p>
      <p style="margin:0 0 6px"><b>Método de entrega:</b> ${deliveryMethod}</p>
      ${
        deliveryAddress
          ? `<p style="margin:0 0 10px"><b>Dirección:</b> ${deliveryAddress}</p>`
          : `<div style="height:8px"></div>`
      }

      <p style="margin:0 0 6px"><b>Items:</b><br/>${itemsList || "-"}</p>
      <p style="margin:10px 0 0"><b>Total:</b> $${total} CLP</p>
    </div>
  `;

  const to = order.to || env("STORE_NOTIFY_EMAIL");
  if (!to) throw new Error("Missing store email (STORE_NOTIFY_EMAIL).");

  return sendMail({
    to,
    subject: `🛒 Nueva venta confirmada — ${ref}`,
    html,
    text: `Nueva venta confirmada. Ref: ${ref}. Total: $${total} CLP.`,
  });
}

module.exports = {
  sendMail,
  sendCustomerConfirmationEmail,
  sendStoreNotificationEmail,
};
