// ✅ REEMPLAZA TODO tu index.js por este archivo (ya corregido)
// - Elimina duplicados de /move, /stock-movements, /sales-summary
// - Saca la ruta /decrement que estaba pegada dentro de /stock (en tu versión)
// - Deja filtros por fecha usando occurred_at::date para que el "to" incluya el día completo
// - Mantiene todo lo demás igual

const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
require("dotenv").config();

const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");

const mercadopago = require("mercadopago");

const { sendStoreNotificationEmail } = require("./email");

const app = express();
app.use(cors());
app.use(express.json());

// ===============================
// ✅ ENV / REQUIRED
// ===============================
function requireEnv(name) {
  if (!process.env[name]) {
    console.error(`❌ Falta ${name} en .env / Render env vars`);
    process.exit(1);
  }
}

requireEnv("DATABASE_URL");
requireEnv("ADMIN_EMAIL");
requireEnv("ADMIN_PASSWORD_HASH");
requireEnv("ADMIN_JWT_SECRET");

// ===============================
// ✅ DB POOL
// ===============================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ===============================
// ✅ HELPERS
// ===============================
function makeAdminToken() {
  return jwt.sign(
    { role: "admin", email: process.env.ADMIN_EMAIL },
    process.env.ADMIN_JWT_SECRET,
    { expiresIn: "7d" }
  );
}

function requireAdmin(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ ok: false, error: "missing_token" });

  try {
    const payload = jwt.verify(token, process.env.ADMIN_JWT_SECRET);
    if (payload.role !== "admin") throw new Error("not_admin");
    req.admin = payload;
    return next();
  } catch (e) {
    return res.status(401).json({ ok: false, error: "invalid_token" });
  }
}

// ===============================
// ✅ HEALTH
// ===============================
app.get("/health", (req, res) => res.json({ ok: true }));

// ===============================
// ✅ ADMIN LOGIN
// ===============================
app.post("/admin/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};

    if (!email || !password) {
      return res.status(400).json({ ok: false, error: "missing_credentials" });
    }

    if (email !== process.env.ADMIN_EMAIL) {
      return res.status(401).json({ ok: false, error: "invalid_credentials" });
    }

    const ok = await bcrypt.compare(password, process.env.ADMIN_PASSWORD_HASH);
    if (!ok) {
      return res.status(401).json({ ok: false, error: "invalid_credentials" });
    }

    const token = makeAdminToken();
    return res.json({ ok: true, token });
  } catch (e) {
    console.error("POST /admin/login error:", e);
    return res.status(500).json({ ok: false, error: "login_failed" });
  }
});

// ===============================
// ✅ VARIANTS PUBLIC
// ===============================
app.get("/variants", async (req, res) => {
  const client = await pool.connect();
  try {
    const q = await client.query(
      `
      SELECT
        id,
        sku,
        color,
        size,
        grabado_codigo,
        grabado_nombre,
        price_clp,
        (stock_total - stock_reserved) as stock
      FROM product_variants
      WHERE active = true
      ORDER BY color, grabado_codigo, size;
      `
    );

    return res.json(q.rows);
  } catch (e) {
    console.error("GET /variants error:", e);
    return res.status(500).json({ ok: false, error: "variants_failed" });
  } finally {
    client.release();
  }
});

// ===============================
// ✅ RESERVAS (TTL)
// ===============================
const RES_TTL_MIN = Number(process.env.RESERVATION_TTL_MINUTES || 15);

async function cleanupExpiredReservations() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const exp = await client.query(
      `
      SELECT id, variant_id, quantity
      FROM stock_reservations
      WHERE status = 'active' AND expires_at <= NOW()
      FOR UPDATE;
      `
    );

    for (const r of exp.rows) {
      await client.query(
        `UPDATE product_variants
         SET stock_reserved = GREATEST(stock_reserved - $1, 0)
         WHERE id = $2`,
        [r.quantity, r.variant_id]
      );

      await client.query(
        `UPDATE stock_reservations
         SET status = 'expired'
         WHERE id = $1`,
        [r.id]
      );
    }

    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("cleanupExpiredReservations error:", e);
  } finally {
    client.release();
  }
}

setInterval(() => {
  cleanupExpiredReservations().catch(() => {});
}, 60 * 1000);

// POST /reserve
app.post("/reserve", async (req, res) => {
  const { items } = req.body || {};

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ ok: false, error: "missing_items" });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const expiresAt = new Date(Date.now() + RES_TTL_MIN * 60 * 1000);

    const out = [];
    for (const it of items) {
      const variant_id = it.variant_id;
      const qty = Number(it.qty);

      if (!variant_id || !Number.isInteger(qty) || qty <= 0) {
        await client.query("ROLLBACK");
        return res.status(400).json({ ok: false, error: "invalid_item" });
      }

      const v = await client.query(
        `
        SELECT id, stock_total, stock_reserved
        FROM product_variants
        WHERE id = $1
        FOR UPDATE
        `,
        [variant_id]
      );

      if (!v.rowCount) {
        await client.query("ROLLBACK");
        return res.status(404).json({ ok: false, error: "variant_not_found" });
      }

      const row = v.rows[0];
      const available = row.stock_total - row.stock_reserved;

      if (available < qty) {
        await client.query("ROLLBACK");
        return res.status(409).json({
          ok: false,
          error: "out_of_stock",
          variant_id,
          available,
          requested: qty,
        });
      }

      await client.query(
        `UPDATE product_variants
         SET stock_reserved = stock_reserved + $1
         WHERE id = $2`,
        [qty, variant_id]
      );

      const r = await client.query(
        `
        INSERT INTO stock_reservations (variant_id, quantity, status, expires_at)
        VALUES ($1, $2, 'active', $3)
        RETURNING id
        `,
        [variant_id, qty, expiresAt]
      );

      out.push({ variant_id, qty, reservation_id: r.rows[0].id });
    }

    await client.query("COMMIT");

    // Ojo: tu frontend probablemente usa un solo reservation_id (si reservas 1 sola variante)
    return res.json({
      ok: true,
      expires_at: expiresAt.toISOString(),
      reservations: out,
      reservation_id: out.length === 1 ? out[0].reservation_id : null,
    });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("POST /reserve error:", e);
    return res.status(500).json({ ok: false, error: "reserve_failed" });
  } finally {
    client.release();
  }
});

// ===============================
// ✅ ORDERS (antes de pagar)
// ===============================
app.post("/orders", async (req, res) => {
  try {
    const {
      reservation_id,
      buyer_name,
      buyer_email,
      buyer_phone,
      delivery_method, // 'retiro' | 'envio_por_pagar'
      delivery_address, // requerido si envio_por_pagar
      items, // [{ sku, quantity, unit_price }]
    } = req.body || {};

    if (!reservation_id) {
      return res.status(400).json({ ok: false, error: "missing_reservation_id" });
    }

    if (!buyer_name || !buyer_email || !buyer_phone) {
      return res.status(400).json({ ok: false, error: "missing_buyer_data" });
    }

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ ok: false, error: "missing_items" });
    }

    if (!delivery_method || !["retiro", "envio_por_pagar"].includes(delivery_method)) {
      return res.status(400).json({ ok: false, error: "invalid_delivery_method" });
    }

    if (delivery_method === "envio_por_pagar" && !delivery_address) {
      return res.status(400).json({ ok: false, error: "missing_delivery_address" });
    }

    const total = items.reduce((acc, it) => {
      const q = Number(it.quantity || 0);
      const p = Number(it.unit_price || 0);
      return acc + q * p;
    }, 0);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const r = await client.query(
        `SELECT id, status, expires_at
         FROM stock_reservations
         WHERE id = $1`,
        [reservation_id]
      );

      if (!r.rowCount) {
        await client.query("ROLLBACK");
        return res.status(404).json({ ok: false, error: "reservation_not_found" });
      }

      const rs = r.rows[0];
      if (rs.status !== "active" || new Date(rs.expires_at) <= new Date()) {
        await client.query("ROLLBACK");
        return res.status(409).json({ ok: false, error: "reservation_expired_or_not_active" });
      }

      const ins = await client.query(
        `INSERT INTO orders
          (reservation_id, status, buyer_name, buyer_email, buyer_phone, delivery_method, delivery_address, items, total_clp)
         VALUES
          ($1, 'pending_payment', $2, $3, $4, $5, $6, $7::jsonb, $8)
         ON CONFLICT (reservation_id)
         DO UPDATE SET
           buyer_name = EXCLUDED.buyer_name,
           buyer_email = EXCLUDED.buyer_email,
           buyer_phone = EXCLUDED.buyer_phone,
           delivery_method = EXCLUDED.delivery_method,
           delivery_address = EXCLUDED.delivery_address,
           items = EXCLUDED.items,
           total_clp = EXCLUDED.total_clp
         RETURNING id, status`,
        [
          reservation_id,
          buyer_name,
          buyer_email,
          buyer_phone,
          delivery_method,
          delivery_address || null,
          JSON.stringify(items),
          total,
        ]
      );

      await client.query("COMMIT");
      return res.json({ ok: true, order_id: ins.rows[0].id, status: ins.rows[0].status });
    } catch (e) {
      await client.query("ROLLBACK");
      console.error("POST /orders tx error:", e);
      return res.status(500).json({ ok: false, error: "orders_create_failed" });
    } finally {
      client.release();
    }
  } catch (e) {
    console.error("POST /orders fatal:", e);
    return res.status(500).json({ ok: false, error: "orders_create_failed" });
  }
});

// ===============================
// ✅ ADMIN: LISTAR VARIANTES
// ===============================
app.get("/admin/variants", requireAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    const q = await client.query(
      `
      SELECT
        id,
        sku,
        color,
        size,
        grabado_codigo,
        grabado_nombre,
        price_clp,
        stock_total,
        stock_reserved,
        (stock_total - stock_reserved) as stock_available,
        active
      FROM product_variants
      ORDER BY color, grabado_codigo, size;
      `
    );

    return res.json({ ok: true, variants: q.rows });
  } catch (e) {
    console.error("GET /admin/variants error:", e);
    return res.status(500).json({ ok: false, error: "admin_variants_failed" });
  } finally {
    client.release();
  }
});

// ===============================
// ✅ ADMIN: UPDATE VARIANT (precio/stock_total)
// ===============================
app.patch("/admin/variants/:id", requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { price_clp, stock_total, active } = req.body || {};

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const v = await client.query(
      `SELECT id, stock_total, stock_reserved
       FROM product_variants
       WHERE id = $1
       FOR UPDATE`,
      [id]
    );

    if (!v.rowCount) {
      await client.query("ROLLBACK");
      return res.status(404).json({ ok: false, error: "variant_not_found" });
    }

    const row = v.rows[0];
    const newTotal =
      stock_total !== undefined && stock_total !== null ? Number(stock_total) : row.stock_total;

    if (!Number.isFinite(newTotal) || newTotal < 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ ok: false, error: "invalid_stock_total" });
    }

    if (newTotal < row.stock_reserved) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        ok: false,
        error: "cannot_set_stock_below_reserved",
        stock_reserved: row.stock_reserved,
      });
    }

    const newPrice =
      price_clp !== undefined && price_clp !== null ? Number(price_clp) : undefined;

    if (newPrice !== undefined && (!Number.isFinite(newPrice) || newPrice < 0)) {
      await client.query("ROLLBACK");
      return res.status(400).json({ ok: false, error: "invalid_price" });
    }

    const newActive =
      active !== undefined && active !== null ? Boolean(active) : undefined;

    const upd = await client.query(
      `
      UPDATE product_variants
      SET
        price_clp = COALESCE($2, price_clp),
        stock_total = $3,
        active = COALESCE($4, active)
      WHERE id = $1
      RETURNING id, price_clp, stock_total, stock_reserved, active
      `,
      [id, newPrice ?? null, newTotal, newActive ?? null]
    );

    await client.query("COMMIT");
    return res.json({ ok: true, variant: upd.rows[0] });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("PATCH /admin/variants/:id error:", e);
    return res.status(500).json({ ok: false, error: "admin_variant_update_failed" });
  } finally {
    client.release();
  }
});

// ===============================
// ✅ ADMIN: MOVE STOCK (sale_offline | adjust_out | adjust_in)
// ===============================
app.post("/admin/variants/:id/move", requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { movement_type, qty, price_clp, note } = req.body || {};

  const q = Number(qty);

  if (!movement_type || !["sale_offline", "adjust_out", "adjust_in"].includes(movement_type)) {
    return res.status(400).json({ ok: false, error: "invalid_movement_type" });
  }

  if (!Number.isInteger(q) || q <= 0) {
    return res.status(400).json({ ok: false, error: "invalid_qty" });
  }

  const price = price_clp !== undefined && price_clp !== null ? Number(price_clp) : null;

  if (movement_type === "sale_offline" && (!Number.isFinite(price) || price <= 0)) {
    return res.status(400).json({ ok: false, error: "invalid_price_for_sale_offline" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const v = await client.query(
      `SELECT id, sku, stock_total, stock_reserved
       FROM product_variants
       WHERE id = $1
       FOR UPDATE`,
      [id]
    );

    if (!v.rowCount) {
      await client.query("ROLLBACK");
      return res.status(404).json({ ok: false, error: "variant_not_found" });
    }

    const row = v.rows[0];
    let newTotal = row.stock_total;

    if (movement_type === "adjust_in") {
      newTotal = row.stock_total + q;
    } else {
      newTotal = row.stock_total - q;

      if (newTotal < 0) {
        await client.query("ROLLBACK");
        return res.status(409).json({ ok: false, error: "cannot_go_negative" });
      }

      if (newTotal < row.stock_reserved) {
        await client.query("ROLLBACK");
        return res.status(409).json({
          ok: false,
          error: "cannot_reduce_below_reserved",
          stock_reserved: row.stock_reserved,
        });
      }
    }

    await client.query(
      `UPDATE product_variants
       SET stock_total = $2
       WHERE id = $1`,
      [id, newTotal]
    );

    const movementQty = movement_type === "adjust_in" ? q : -q;

    await client.query(
      `
      INSERT INTO stock_movements
        (variant_id, sku, movement_type, qty, price_clp, note)
      VALUES
        ($1, $2, $3, $4, $5, $6)
      `,
      [id, row.sku, movement_type, movementQty, price, note || null]
    );

    await client.query("COMMIT");

    return res.json({
      ok: true,
      variant_id: id,
      sku: row.sku,
      stock_total: newTotal,
      stock_reserved: row.stock_reserved,
      stock_available: newTotal - row.stock_reserved,
    });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("POST /admin/variants/:id/move error:", e);
    return res.status(500).json({ ok: false, error: "move_failed" });
  } finally {
    client.release();
  }
});

// ===============================
// ✅ ADMIN: STOCK MOVEMENTS (detalle)
// ===============================
app.get("/admin/stock-movements", requireAdmin, async (req, res) => {
  const { from, to } = req.query || {};
  const client = await pool.connect();

  try {
    const params = [];
    const where = [];

    if (from) {
      params.push(from);
      where.push(
        `(sm.occurred_at AT TIME ZONE 'America/Santiago')::date >= $${params.length}::date`
      );
    }

    if (to) {
      params.push(to);
      where.push(
        `(sm.occurred_at AT TIME ZONE 'America/Santiago')::date <= $${params.length}::date`
      );
    }

    const sql =
      `
      SELECT
        sm.id,
        sm.occurred_at,
        sm.variant_id,
        sm.sku,
        pv.color,
        pv.size,
        pv.grabado_codigo,
        pv.grabado_nombre,
        sm.movement_type,
        sm.qty,
        sm.price_clp,
        sm.note
      FROM stock_movements sm
      LEFT JOIN product_variants pv ON pv.id = sm.variant_id
      ` +
      (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
      `
      ORDER BY sm.occurred_at DESC
      LIMIT 2000;
      `;

    const q = await client.query(sql, params);

    return res.json({ ok: true, movements: q.rows });
  } catch (e) {
    console.error("GET /admin/stock-movements error:", e);
    return res.status(500).json({ ok: false, error: "stock_movements_failed" });
  } finally {
    client.release();
  }
});

// ===============================
// ✅ ADMIN: SALES SUMMARY (KPIs)
// ===============================
app.get("/admin/sales-summary", requireAdmin, async (req, res) => {
  const { from, to } = req.query || {};
  const client = await pool.connect();

  try {
    const params = [];
    const where = [`sm.movement_type = 'sale_offline'`];

    if (from) {
      params.push(from);
      where.push(
        `(sm.occurred_at AT TIME ZONE 'America/Santiago')::date >= $${params.length}::date`
      );
    }

    if (to) {
      params.push(to);
      where.push(
        `(sm.occurred_at AT TIME ZONE 'America/Santiago')::date <= $${params.length}::date`
      );
    }

    const sql =
      `
      SELECT
        COALESCE(SUM(ABS(sm.qty)), 0)::int AS units_sold,
        COALESCE(SUM(ABS(sm.qty) * COALESCE(sm.price_clp, 0)), 0)::bigint AS total_clp
      FROM stock_movements sm
      ` +
      (where.length ? ` WHERE ${where.join(" AND ")}` : "");

    const q = await client.query(sql, params);
    return res.json({ ok: true, summary: q.rows[0] });
  } catch (e) {
    console.error("GET /admin/sales-summary error:", e);
    return res.status(500).json({ ok: false, error: "sales_summary_failed" });
  } finally {
    client.release();
  }
});


// ========================
// ✅ PAGO GENÉRICO (Getnet / MP / STUB)
// - El Frontend SOLO llama a este endpoint y redirige a payment_url
// - El backend decide la pasarela vía PAY_PROVIDER
//   PAY_PROVIDER=getnet | mp | stub
// ========================
const https = require("https");

function httpsJsonRequest(url, { method = "POST", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const payload = body ? JSON.stringify(body) : null;

    const req = https.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (u.protocol === "https:" ? 443 : 80),
        path: u.pathname + (u.search || ""),
        method,
        headers: {
          "Content-Type": "application/json",
          ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}),
          ...headers,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          let json;
          try {
            json = data ? JSON.parse(data) : null;
          } catch {
            json = { raw: data };
          }
          resolve({ status: res.statusCode, headers: res.headers, json });
        });
      }
    );

    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function getOrderForPayment(client, { order_id, reservation_id }) {
  if (order_id) {
    const q = await client.query(
      `SELECT id, reservation_id, status, buyer_name, buyer_email, buyer_phone,
              delivery_method, delivery_address, items, total_clp, created_at
         FROM orders
        WHERE id = $1`,
      [order_id]
    );
    return q.rowCount ? q.rows[0] : null;
  }

  const q = await client.query(
    `SELECT id, reservation_id, status, buyer_name, buyer_email, buyer_phone,
            delivery_method, delivery_address, items, total_clp, created_at
       FROM orders
      WHERE reservation_id = $1`,
    [reservation_id]
  );
  return q.rowCount ? q.rows[0] : null;
}

// 🟡 STUB universal (sirve para probar el flujo sin pasarela)
function buildStubPaymentUrl(orderId) {
  const base = process.env.STUB_PAY_URL || "https://example.com/pay-stub";
  return `${base}?order_id=${encodeURIComponent(orderId)}`;
}

// 🟢 Getnet (skeleton): aquí se enchufa la API real cuando te entreguen API Key
async function createGetnetPayment({ order }) {
  const hasKey =
    !!process.env.GETNET_API_KEY && process.env.GETNET_API_KEY !== "PENDIENTE_CLIENTE";

  if (!hasKey) {
    return { ok: true, provider: "getnet_stub", payment_url: buildStubPaymentUrl(order.id) };
  }

  const base = process.env.GETNET_API_BASE;
  const path = process.env.GETNET_CREATE_PATH;

  if (!base || !path) {
    return {
      ok: true,
      provider: "getnet_stub_missing_base",
      payment_url: buildStubPaymentUrl(order.id),
      warning: "Faltan GETNET_API_BASE / GETNET_CREATE_PATH",
    };
  }

  const payload = {
    commerce_code: process.env.GETNET_COMMERCE_CODE,
    order_id: String(order.id),
    amount: Number(order.total_clp || 0),
    currency: "CLP",
    customer: {
      name: order.buyer_name || "",
      email: order.buyer_email || "",
      phone: order.buyer_phone || "",
    },
    return_url: process.env.GETNET_RETURN_URL,
    notify_url: process.env.GETNET_NOTIFY_URL,
  };

  const url = base.replace(/\/$/, "") + path;
  const resp = await httpsJsonRequest(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.GETNET_API_KEY}`,
    },
    body: payload,
  });

  if (resp.status >= 200 && resp.status < 300) {
    const paymentUrl =
      resp.json?.payment_url || resp.json?.redirect_url || resp.json?.url || null;

    if (!paymentUrl) {
      return {
        ok: false,
        provider: "getnet",
        error: "getnet_missing_payment_url_in_response",
        raw: resp.json,
      };
    }
    return { ok: true, provider: "getnet", payment_url: paymentUrl, raw: resp.json };
  }

  return {
    ok: false,
    provider: "getnet",
    error: "getnet_create_failed",
    status: resp.status,
    raw: resp.json,
  };
}

// 🟢 MP (opcional): si quieres mantener Mercado Pago como fallback
async function createMpPayment({ order }) {
  if (!process.env.MP_ACCESS_TOKEN || process.env.MP_ACCESS_TOKEN === "PENDIENTE_CLIENTE") {
    return { ok: true, provider: "mp_stub", payment_url: buildStubPaymentUrl(order.id) };
  }

  mercadopago.configure({ access_token: process.env.MP_ACCESS_TOKEN });

  const items = Array.isArray(order.items) ? order.items : [];
  const mpItems = items.map((it) => ({
    title: it.sku || "Producto",
    quantity: Number(it.quantity || 1),
    unit_price: Number(it.unit_price || 0),
    currency_id: "CLP",
  }));

  const preference = {
    items: mpItems.length
      ? mpItems
      : [{ title: "Orden", quantity: 1, unit_price: Number(order.total_clp || 0), currency_id: "CLP" }],
    external_reference: String(order.id),
  };

  const mpRes = await mercadopago.preferences.create(preference);
  const initPoint = mpRes?.body?.init_point;

  if (!initPoint) {
    return { ok: false, provider: "mp", error: "mp_missing_init_point", raw: mpRes?.body };
  }
  return { ok: true, provider: "mp", payment_url: initPoint, raw: mpRes?.body };
}

app.post("/pay/create", async (req, res) => {
  const { order_id, reservation_id } = req.body || {};

  if (!order_id && !reservation_id) {
    return res.status(400).json({ ok: false, error: "missing_order_id_or_reservation_id" });
  }

  const client = await pool.connect();
  try {
    const order = await getOrderForPayment(client, { order_id, reservation_id });

    if (!order) {
      return res.status(404).json({ ok: false, error: "order_not_found", hint: "Primero crea la orden con POST /orders usando el reservation_id. Luego llama POST /pay/create con order_id." });
    }

    if (order.status !== "pending_payment") {
      return res.status(409).json({
        ok: false,
        error: "order_not_pending_payment",
        status: order.status,
      });
    }

    const provider = (process.env.PAY_PROVIDER || "").toLowerCase() || "getnet";

    let result;
    if (provider === "getnet") result = await createGetnetPayment({ order });
    else if (provider === "mp") result = await createMpPayment({ order });
    else result = { ok: true, provider: "stub", payment_url: buildStubPaymentUrl(order.id) };

    if (!result.ok) {
      return res.status(502).json(result);
    }

    return res.json({
      ok: true,
      provider: result.provider,
      payment_url: result.payment_url,
    });
  } catch (e) {
    console.error("POST /pay/create error:", e);
    return res.status(500).json({ ok: false, error: "pay_create_failed" });
  } finally {
    client.release();
  }
});

// ========================
// ✅ MERCADO PAGO (modo actual / stub)
// ========================
app.post("/mp/create-preference", async (req, res) => {
  const { reservation_id } = req.body || {};
  if (!reservation_id) {
    return res.status(400).json({ ok: false, error: "missing_reservation_id" });
  }

  // 🟡 STUB si no hay token real
  if (
    !process.env.MP_ACCESS_TOKEN ||
    process.env.MP_ACCESS_TOKEN === "PENDIENTE_CLIENTE"
  ) {
    return res.json({
      ok: true,
      stub: true,
      init_point:
        "https://example.com/mp-stub?reservation_id=" +
        encodeURIComponent(reservation_id),
    });
  }

  try {
    mercadopago.configure({ access_token: process.env.MP_ACCESS_TOKEN });

    const mpRes = await mercadopago.preferences.create({
      items: [{ title: "Polera Huillinco", quantity: 1, unit_price: 15990 }],
      external_reference: reservation_id,
    });

    return res.json({
      ok: true,
      init_point: mpRes.body.init_point,
      mp_preference_id: mpRes.body.id,
    });
  } catch (e) {
    console.error("MP create preference error:", e);
    return res.status(500).json({
      ok: false,
      error: "mp_create_preference_failed",
    });
  }
});

app.post("/mp/webhook", async (req, res) => {
  // Mantén tu lógica actual (stub/real) según tu implementación previa
  try {
    // ... tu lógica existente
    return res.status(200).send("ok");
  } catch (e) {
    console.error("MP webhook error:", e);
    return res.status(500).send("error");
  }
});

// ===============================
// ✅ START
// ===============================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("✅ API running on port " + PORT));
