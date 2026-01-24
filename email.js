const nodemailer = require("nodemailer");

function env(name, fallback = null) {
  const v = process.env[name];
  return (v === undefined || v === null || v === "") ? fallback : v;
}

function fmtCLP(n) {
  const v = Number(n || 0);
  return v.toLocaleString("es-CL");
}

function safeText(s) {
  return String(s ?? "").replace(/[<>]/g, "");
}

function renderItemsTable(items = []) {
  const rows = (items || []).map((it) => {
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
  }).join("");

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

// Reutiliza conexión (evita crear transporter por request)
let _transporter = null;

function getTransporter() {
  if (_transporter) return _transporter;

  const host = env("SMTP_HOST", "smtp.zoho.com");
  const port = Number(env("SMTP_PORT", 587));
  const secure = String(env("SMTP_SECURE", "false")) === "true"; // con 587 debe ser false
  const user = env("SMTP_USER");
  const pass = env("SMTP_PASS");

  if (!host || !user || !pass) {
    throw new Error("Missing SMTP env vars (SMTP_HOST/SMTP_USER/SMTP_PASS).");
  }

  // FIX: STARTTLS por 587 (soluciona ETIMEDOUT en Render con 465)
  _transporter = nodemailer.createTransport({
    host,
    port,
    secure,              // false en 587
    requireTLS: true,    // fuerza STARTTLS
    auth: { user, pass },

    // timeouts para Render / cold starts
    connectionTimeout: Number(env("SMTP_CONNECTION_TIMEOUT_MS", 20000)),
    greetingTimeout: Number(env("SMTP_GREETING_TIMEOUT_MS", 20000)),
    socketTimeout: Number(env("SMTP_SOCKET_TIMEOUT_MS", 20000)),

    // útil para diagnósticos (si quieres)
    logger: String(env("SMTP_LOGGER", "false")) === "true",
    debug: String(env("SMTP_DEBUG", "false")) === "true",
  });

  return _transporter;
}

async function sendMail({ to, subject, html, text }) {
  const transporter = getTransporter();
  const from = env("FROM_EMAIL", env("SMTP_USER"));
  return transporter.sendMail({ from, to, subject, html, text });
}

async function sendCustomerConfirmationEmail(order) {
  const ref = safeText(order.reference || "");
  const total = fmtCLP(order.total_clp);
  const items = Array.isArray(order.items) ? order.items : [];

  const deliveryMethod = safeText(order.delivery_method || "-");
  const deliveryAddress = order.delivery_address ? safeText(order.delivery_address) : null;

  const html = `
    <div style="font-family:system-ui,Arial;line-height:1.4">
      <h2 style="margin:0 0 8px">✅ Compra confirmada — Poleras Huillinco</h2>
      <p style="margin:0 0 10px">Hola ${safeText(order.buyer_name || "")}, tu pago fue confirmado.</p>

      <p style="margin:0 0 6px"><b>Referencia:</b> ${ref}</p>
      <p style="margin:0 0 6px"><b>Método de entrega:</b> ${deliveryMethod}</p>
      ${deliveryAddress ? `<p style="margin:0 0 10px"><b>Dirección:</b> ${deliveryAddress}</p>` : `<div style="height:8px"></div>`}

      <div style="margin:12px 0">${renderItemsTable(items)}</div>

      <p style="margin:10px 0"><b>Total:</b> $${total} CLP</p>
      <p style="margin:0">Si necesitas ayuda, responde a este correo.</p>
      <p style="margin:10px 0 0">— Cervecería Huillinco</p>
    </div>
  `;

  // FIX: usar buyer_email si no viene order.to
  const to = order.to || order.buyer_email;
  if (!to) throw new Error("Missing customer email (buyer_email).");

  return sendMail({
    to,
    subject: `✅ Compra confirmada — ${ref}`,
    html,
    text: `Compra confirmada. Ref: ${ref}. Total: $${total} CLP.`,
  });
}

async function sendStoreNotificationEmail(order) {
  const ref = safeText(order.reference || "");
  const total = fmtCLP(order.total_clp);
  const items = Array.isArray(order.items) ? order.items : [];

  const deliveryMethod = safeText(order.delivery_method || "-");
  const deliveryAddress = order.delivery_address ? safeText(order.delivery_address) : null;

  const itemsList = (items || []).map((it) => {
    const sku = safeText(it.sku || "");
    const variant = safeText([it.color, it.size].filter(Boolean).join(" "));
    const qty = Number(it.quantity || 0);
    const price = fmtCLP(it.price_clp);
    return `• ${qty}× ${sku} (${variant}) — $${price}`;
  }).join("<br/>");

  const html = `
    <div style="font-family:system-ui,Arial;line-height:1.4">
      <h2 style="margin:0 0 8px">🛒 Nueva venta confirmada</h2>

      <p style="margin:0 0 6px"><b>Referencia:</b> ${ref}</p>
      <p style="margin:0 0 6px"><b>Cliente:</b> ${safeText(order.buyer_name || "-")}</p>
      <p style="margin:0 0 6px"><b>Email:</b> ${safeText(order.buyer_email || "-")}</p>
      <p style="margin:0 0 6px"><b>Teléfono:</b> ${safeText(order.buyer_phone || "-")}</p>
      <p style="margin:0 0 6px"><b>Método de entrega:</b> ${deliveryMethod}</p>
      ${deliveryAddress ? `<p style="margin:0 0 10px"><b>Dirección:</b> ${deliveryAddress}</p>` : `<div style="height:8px"></div>`}

      <p style="margin:0 0 6px"><b>Items:</b><br/>${itemsList || "-"}</p>
      <p style="margin:10px 0 0"><b>Total:</b> $${total} CLP</p>
    </div>
  `;

  // FIX: usar STORE_NOTIFY_EMAIL si no viene order.to
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
