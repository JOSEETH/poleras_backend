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
const crypto = require("crypto");

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

function normalizeDeliveryMethod(v) {
  if (!v) return null;
  const s = String(v).toLowerCase().trim();

  // Retiro en tienda / pickup
  if (["retiro", "pickup", "pick_up", "retira", "retirar", "retiro_en_tienda"].includes(s)) {
    return "retiro";
  }

  // Envío (por pagar / despacho)
  if ([
    "envio_por_pagar",
    "envio",
    "despacho",
    "shipping",
    "delivery",
    "envio por pagar",
    "envío",
    "envío por pagar",
  ].includes(s)) {
    return "envio_por_pagar";
  }

  return null;
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
      const qty = Number(it.qty ?? it.quantity);

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

    const normalized_delivery_method = normalizeDeliveryMethod(delivery_method);

    if (!normalized_delivery_method) {
      return res.status(400).json({ ok: false, error: "invalid_delivery_method" });
    }

    if (normalized_delivery_method === "envio_por_pagar" && !delivery_address) {
      return res.status(400).json({ ok: false, error: "missing_delivery_address" });
    }

    const total = (items || []).reduce((acc, it) => {
      const q = Number(it.quantity ?? 0);
      const p = Number(
        it.unit_price ??
          it.unit_price_clp ??
          it.price_clp ??
          it.price ??
          0
      );
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
          normalized_delivery_method,
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

// Si no existe orden aún (flujo del formulario actual), la creamos a partir de la reserva.
// - Bloquea la reserva y la variante para consistencia.
// - Calcula items y total_clp desde product_variants.
async function getOrCreateOrderForPayment(client, {
  order_id,
  reservation_id,
  buyer_name,
  buyer_email,
  buyer_phone,
  delivery_method,
  delivery_address,
  notes,
}) {
  const existing = await getOrderForPayment(client, { order_id, reservation_id });
  if (existing) return existing;

  if (!reservation_id) return null;

  // 1) Bloquear reserva
  const rq = await client.query(
    `SELECT id, variant_id, quantity, status, expires_at
       FROM stock_reservations
      WHERE id = $1
      FOR UPDATE`,
    [reservation_id]
  );
  if (!rq.rowCount) return null;
  const r = rq.rows[0];

  if (r.status !== "active") {
    throw Object.assign(new Error("reservation_not_active"), { http: 409, code: "reservation_not_active", status: r.status });
  }
  if (r.expires_at && new Date(r.expires_at) <= new Date()) {
    throw Object.assign(new Error("reservation_expired"), { http: 409, code: "reservation_expired" });
  }

  const qty = Number(r.quantity);
  if (!Number.isInteger(qty) || qty <= 0) {
    throw Object.assign(new Error("invalid_reservation_quantity"), { http: 500, code: "invalid_reservation_quantity" });
  }

  // 2) Bloquear variante y calcular total
  const vq = await client.query(
    `SELECT id, sku, color, size, grabado_codigo, grabado_nombre, price_clp, stock_total, stock_reserved
       FROM product_variants
      WHERE id = $1
      FOR UPDATE`,
    [r.variant_id]
  );
  if (!vq.rowCount) {
    throw Object.assign(new Error("variant_not_found"), { http: 404, code: "variant_not_found" });
  }
  const v = vq.rows[0];

  // Este flujo asume que /reserve ya incrementó stock_reserved.
  if (Number(v.stock_reserved) < qty) {
    throw Object.assign(new Error("reserved_stock_insufficient"), { http: 409, code: "reserved_stock_insufficient", stock_reserved: v.stock_reserved, qty });
  }

  const unit = Number(v.price_clp) || 0;
  const total = unit * qty;
  const items = [
    {
      variant_id: v.id,
      sku: v.sku,
      color: v.color,
      size: v.size,
      grabado_codigo: v.grabado_codigo,
      grabado_nombre: v.grabado_nombre,
      unit_price_clp: unit,
      quantity: qty,
      line_total_clp: total,
    },
  ];

  // 3) Crear orden
  let oq;
  try {
    oq = await client.query(
      `INSERT INTO orders (reservation_id, status, buyer_name, buyer_email, buyer_phone, delivery_method, delivery_address, notes, items, total_clp)
       VALUES ($1, 'pending_payment', $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
       RETURNING id, reservation_id, status, buyer_name, buyer_email, buyer_phone, delivery_method, delivery_address, items, total_clp, created_at`,
      [
        reservation_id,
        buyer_name || null,
        buyer_email || null,
        buyer_phone || null,
        delivery_method || null,
        delivery_address || null,
        notes || null,
        JSON.stringify(items),
        total,
      ]
    );
  } catch (e) {
    // Si la tabla orders no tiene columna notes (error 42703), reintenta sin notes
    if (e && (e.code === '42703' || String(e.message || '').includes('column \"notes\"'))) {
      oq = await client.query(
        `INSERT INTO orders (reservation_id, status, buyer_name, buyer_email, buyer_phone, delivery_method, delivery_address, items, total_clp)
         VALUES ($1, 'pending_payment', $2, $3, $4, $5, $6, $7::jsonb, $8)
         RETURNING id, reservation_id, status, buyer_name, buyer_email, buyer_phone, delivery_method, delivery_address, items, total_clp, created_at`,
        [
          reservation_id,
          buyer_name || null,
          buyer_email || null,
          buyer_phone || null,
          delivery_method || null,
          delivery_address || null,
          JSON.stringify(items),
          total,
        ]
      );
    } else {
      throw e;
    }
  }

  return oq.rows[0];
}

// 🟡 STUB universal (sirve para probar el flujo sin pasarela)
function buildStubPaymentUrl(orderId) {
  const base = process.env.STUB_PAY_URL || "https://example.com/pay-stub";
  return `${base}?order_id=${encodeURIComponent(orderId)}`;
}

// 🟢 Getnet (skeleton): aquí se enchufa la API real cuando te entreguen API Key
async function createGetnetPayment({ order, req }) {
  // Getnet Web Checkout TEST/PROD usa auth con login/secretKey (tranKey) + nonce + seed.
  // Manual: tranKey = Base64(SHA-256(nonce + seed + secretKey))
  const baseUrl = (process.env.GETNET_BASE_URL || process.env.GETNET_API_BASE || '').replace(/\/$/, '');
  const login = process.env.GETNET_LOGIN;
  const secretKey = process.env.GETNET_SECRETKEY;

  if (!baseUrl || !login || !secretKey) {
    // Si no están configuradas las credenciales TEST/PROD, devolvemos stub (para no romper el sitio)
    return {
      ok: true,
      provider: "getnet_stub",
      payment_url: buildStubPaymentUrl(order.id),
      warning: "Faltan GETNET_BASE_URL/GETNET_LOGIN/GETNET_SECRETKEY en variables de entorno",
    };
  }

  const now = new Date();
  // Seed en ISO8601 con zona (Node lo entrega con Z, es válido)
  const seed = now.toISOString();

  const nonceRaw = crypto.randomBytes(16);
  const nonceB64 = nonceRaw.toString('base64');

  // sha256(nonce + seed + secretKey) donde nonce es RAW (no base64) según manual
  const sha = crypto
    .createHash('sha256')
    .update(Buffer.concat([nonceRaw, Buffer.from(seed, 'utf8'), Buffer.from(secretKey, 'utf8')]))
    .digest();
  const tranKey = sha.toString('base64');

  const auth = {
    login,
    tranKey,
    nonce: nonceB64,
    seed,
  };

  // Datos requeridos por CreateRequest
  const ipAddress =
    (req?.headers?.['x-forwarded-for'] || '').split(',')[0].trim() ||
    req?.socket?.remoteAddress ||
    req?.ip ||
    "127.0.0.1";

  const userAgent = req?.headers?.['user-agent'] || "Mozilla/5.0";

  // Importante: Getnet exige referencia ÚNICA por transacción.
  // Usamos order.id + timestamp para evitar colisiones por reintentos.
  const reference = `ORD-${order.id}-${Date.now()}`;

  const total = Number(order.total_clp || 0);
  if (!Number.isFinite(total) || total <= 0) {
    return { ok: false, provider: "getnet", error: "invalid_total" };
  }

  // Getnet exige items[] con { name, price, quantity } (sin SKU/metadata extra)
  const orderItems = Array.isArray(order.items) ? order.items : [];
  const getnetItems = orderItems.length
    ? orderItems.map((it) => ({
        name: (it.name || (it.sku ? `Polera Huillinco (${it.sku})` : "Polera Huillinco")).toString(),
        price: Number(it.unit_price_clp ?? it.unit_price ?? it.price_clp ?? it.price ?? 0),
        quantity: Number(it.quantity ?? it.qty ?? 1),
      }))
    : [{ name: "Polera Huillinco", price: total, quantity: 1 }];

  const computedTotal = getnetItems.reduce((s, i) => s + (Number(i.price) || 0) * (Number(i.quantity) || 0), 0);

  const returnUrl = process.env.GETNET_RETURN_URL || process.env.GETNET_RETURN || process.env.RETURN_URL;
  if (!returnUrl) {
    return {
      ok: false,
      provider: "getnet",
      error: "missing_return_url",
      hint: "Configura GETNET_RETURN_URL (ej: https://cerveceriahuillinco.cl/pago)",
    };
  }

  // Expiración: recomendamos 15 min desde ahora (o usa variable)
  const ttlMin = Number(process.env.GETNET_SESSION_TTL_MINUTES || 15);
  const expiration = new Date(Date.now() + ttlMin * 60 * 1000).toISOString();

  // Buyer (opcional). El manual usa document/docType, acá mandamos lo mínimo.
  const buyer = {
    name: (order.buyer_name || "").split(" ")[0] || order.buyer_name || "",
    surname: (order.buyer_name || "").split(" ").slice(1).join(" ") || "",
    email: order.buyer_email || "",
    mobile: order.buyer_phone || "",
  };

  const payload = {
    auth,
    locale: "es_CL",
    buyer,
    payment: {
      reference,
      description: `Compra Polera Huillinco (orden ${order.id})`,
      amount: {
        currency: "CLP",
        total: computedTotal,
      },
      items: getnetItems,

    },
    expiration,
    ipAddress,
    returnUrl,
    userAgent,
    // Opcionales útiles:
    // skipResult: true,
    // noBuyerFill: false,
  };

  const url = `${baseUrl}/api/session/`;

  const resp = await httpsJsonRequest(url, {
    method: "POST",
    body: payload,
  });

  // Respuesta esperada: { status: { status: 'OK' }, requestId, processUrl }
  if (resp.status >= 200 && resp.status < 300) {
    const processUrl = resp.json?.processUrl || resp.json?.process_url || null;
    const status = resp.json?.status?.status || resp.json?.status?.[0]?.status || null;

    if (!processUrl) {
      return { ok: false, provider: "getnet", error: "missing_processUrl", raw: resp.json };
    }

    // Si viene status y no es OK, lo tratamos como error
    if (status && String(status).toUpperCase() !== 'OK') {
      const msg = resp.json?.status?.message || resp.json?.status?.[0]?.message || 'getnet_status_not_ok';
      return { ok: false, provider: "getnet", error: "getnet_status_not_ok", message: msg, raw: resp.json };
    }

    return { ok: true, provider: "getnet", payment_url: processUrl, raw: resp.json };
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
    unit_price: Number(it.unit_price ?? it.unit_price_clp ?? it.price_clp ?? it.price ?? 0),
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


// Helpers Getnet (WebCheckout v2.3 - WSSE UsernameToken)
function b64(buf) {
  return Buffer.from(buf).toString("base64");
}

function sha256(data) {
  return crypto.createHash("sha256").update(data).digest();
}

/**
 * PasswordDigest = Base64( SHA-256( nonce + seed + secretkey ) )
 * nonce: bytes aleatorios (se envía base64)
 * seed: ISO datetime string
 */
function buildGetnetAuth() {
  const nonceBytes = crypto.randomBytes(16);
  const seed = new Date().toISOString();
  const secret = process.env.GETNET_SECRETKEY;

  if (!process.env.GETNET_LOGIN || !secret) {
    throw new Error("missing_getnet_credentials");
  }

  const digest = sha256(Buffer.concat([nonceBytes, Buffer.from(seed), Buffer.from(secret)]));
  return {
    login: process.env.GETNET_LOGIN,
    tranKey: b64(digest),
    nonce: b64(nonceBytes),
    seed,
  };
}

app.post("/pay/create", async (req, res) => {
  try {
    const { order_id } = req.body;
    if (!order_id) {
      return res.status(400).json({ error: "missing_order_id" });
    }

    // 1️⃣ Obtener orden
    const oq = await pool.query(
      `SELECT id, total_clp, buyer_name, buyer_email, buyer_phone,
              delivery_method, delivery_address, notes, items
       FROM orders
       WHERE id = $1`,
      [order_id]
    );

    if (oq.rowCount === 0) {
      return res.status(404).json({ error: "order_not_found" });
    }

    const order = oq.rows[0];

    // 2️⃣ Parsear items (jsonb)
    let items = [];
    try {
      items = Array.isArray(order.items)
        ? order.items
        : JSON.parse(order.items || "[]");
    } catch {
      items = [];
    }

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        error: "order_items_invalid",
        detail: "La orden no tiene items válidos",
      });
    }

    // 3️⃣ Calcular TOTAL REAL (desde items)
    let total = Number(order.total_clp || 0);
    if (!total || total <= 0) {
      total = items.reduce((acc, it) => {
        const qty = Number(it.quantity || 0);
        const price = Number(it.unit_price_clp || it.price_clp || 0);
        return acc + qty * price;
      }, 0);
    }
    if (!total || total <= 0) {
      return res.status(400).json({
        error: "order_total_invalid",
        detail: { total },
      });
    }

    // 4️⃣ Obtener IP IPv4 pública del cliente (OBLIGATORIO)
    function getClientIPv4(req) {
      let ip =
        req.headers["x-forwarded-for"] ||
        req.headers["x-real-ip"] ||
        "";

      if (Array.isArray(ip)) ip = ip[0];
      if (typeof ip === "string") ip = ip.split(",")[0].trim();

      // quitar ::ffff:
      if (ip && ip.startsWith("::ffff:")) {
        ip = ip.replace("::ffff:", "");
      }
      return ip || null;
    }

    const clientIp = getClientIPv4(req);
    console.log("📡 IP capturada cliente:", clientIp);

    if (!clientIp) {
      return res.status(400).json({
        error: "client_ip_missing",
        detail: "No se pudo obtener IP pública del cliente",
      });
    }

    // 5️⃣ userAgent (OBLIGATORIO)
    const userAgent = String(req.headers["user-agent"] || "").trim();
    if (!userAgent) {
      return res.status(400).json({
        error: "missing_user_agent",
      });
    }

    // 6️⃣ expiration (ISO8601, +15 minutos) (OBLIGATORIO)
    const expiration = new Date(Date.now() + 15 * 60 * 1000).toISOString();

    // 7️⃣ reference válida (≤32 chars, sin UUID)
    const reference = `HUIL-${order.id.slice(0, 8).toUpperCase()}`;

    // 8️⃣ Auth Getnet (helper existente)
    const auth = buildGetnetAuth();

    const returnUrl = process.env.GETNET_RETURN_URL;
    const cancelUrl = process.env.GETNET_CANCEL_URL || returnUrl;
    if (!returnUrl) {
      return res.status(500).json({ error: "missing_return_url" });
    }

    // 9️⃣ Datos comprador
    const buyerEmail = (order.buyer_email || "").trim();
    const buyerName = (order.buyer_name || "").trim() || "Cliente";
    const buyerPhone = (order.buyer_phone || "").trim();

    // 🔟 Payload OFICIAL Getnet v2.3 (CLAVE)
    const getnetPayload = {
      auth,
      locale: "es_CL",
      ipAddress: clientIp,          // 👈 OBLIGATORIO (en raíz)
      userAgent,                    // 👈 OBLIGATORIO
      expiration,                   // 👈 OBLIGATORIO
      payment: {
        reference,                  // ≤32 chars
        description: `Compra Polera Huillinco (${reference})`,
        amount: {
          currency: "CLP",
          total: Math.round(total),
        },
        allowPartial: false,
        items: items.map((it) => ({
          sku: String(it.sku || it.variant_id || ""),
          name: String(it.design || it.name || "Producto"),
          quantity: Number(it.quantity) || 1,
          price: Number(it.unit_price_clp || it.price_clp || 0),
        })),
      },
      payer: {
        name: buyerName,
        email: buyerEmail,
        mobile: buyerPhone,
        address: order.delivery_address
          ? { street: String(order.delivery_address) }
          : undefined,
      },
      returnUrl,
      cancelUrl,
    };

    const base = process.env.GETNET_BASE_URL;
    if (!base) {
      return res.status(500).json({ error: "missing_getnet_base_url" });
    }

    const url = `${base.replace(/\/$/, "")}/api/session`;

    // 1️⃣1️⃣ Llamada a Getnet
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(getnetPayload),
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      console.error("❌ Getnet error:", response.status, data);
      return res.status(400).json({
        error: "pay_create_failed",
        detail: data,
      });
    }

    const requestId = data.requestId ? String(data.requestId) : null;
    const processUrl = data.processUrl || null;

  console.log('[getnet webhook] parsed:', { reference, status, requestId });

    if (!requestId || !processUrl) {
      console.error("❌ Getnet response incompleta:", data);
      return res.status(400).json({
        error: "pay_create_failed",
        detail: data,
      });
    }

    // 1️⃣2️⃣ Guardar referencia Getnet (requestId) y reference (HUIL-xxxx)
// Nota: reference es la que Getnet reenvía en el webhook; la guardamos para poder encontrar la orden.
await pool.query(
  `UPDATE orders
      SET payment_ref = $1,
          reference   = COALESCE(reference, $2),
          updated_at  = NOW()
    WHERE id = $3`,
  [String(requestId), reference, order.id]
);

    // 1️⃣3️⃣ OK → redirección
    return res.json({
      request_id: requestId,
      redirect_url: processUrl,
    });

  } catch (err) {
    console.error("❌ pay/create exception:", err);
    return res.status(500).json({ error: "internal_error" });
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
// Getnet Web Checkout - URL de notificación
// Usa esta URL en el formulario de validación.
// Ej: https://poleras-backend.onrender.com/webhooks/getnet
// ===============================
app.post(["/webhooks/getnet", "/getnet/webhook"], async (req, res) => {
  // Siempre responde 200 rápido para evitar reintentos infinitos del proveedor.
  const payload = req.body || {};
  res.status(200).json({ ok: true });

  // Getnet normalmente envía "reference" (ej: HUIL-XXXX) y un "status".
  const reference =
    payload.reference ||
    (payload.data && payload.data.reference) ||
    payload.buyOrder ||
    payload.buy_order ||
    null;

// Getnet puede enviar status como string o como objeto { status, reason, message }
const statusRaw =
  (payload.status && typeof payload.status === "object" ? payload.status.status : payload.status) ||
  (payload.data && payload.data.status && typeof payload.data.status === "object"
    ? payload.data.status.status
    : payload.data && payload.data.status) ||
  (payload.notifyData && payload.notifyData.status && typeof payload.notifyData.status === "object"
    ? payload.notifyData.status.status
    : payload.notifyData && payload.notifyData.status) ||
  null;

const status = String(statusRaw || "").toUpperCase();

  const requestId =
    payload.requestId ||
    payload.request_id ||
    (payload.data && (payload.data.requestId || payload.data.request_id)) ||
    null;

  // Sin reference no podemos reconciliar.
  if (!reference) {
    console.log("[getnet webhook] HIT (missing reference)");
    return;
  }

  // Solo confirmamos pago si viene APPROVED.
  if (status && status !== "APPROVED") {
    console.log("[getnet webhook] ignored (status not approved):", { reference, status });
    return;
  }

  console.log("[getnet webhook] HIT:", { reference, status: status || "APPROVED", requestId });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // 1) Buscar la orden por reference (NO por id)
    const oq = await client.query(
      `SELECT id, reservation_id, status
         FROM orders
        WHERE reference = $1
        FOR UPDATE`,
      [reference]
    );

    if (!oq.rowCount) {
      await client.query("ROLLBACK");
      console.log("[getnet webhook] order not found for reference:", reference);
      return;
    }

    const order = oq.rows[0];

    // Idempotencia: si ya está pagada, listo.
    if (order.status === "paid") {
      await client.query("COMMIT");
      return;
    }

    // Solo desde pending_payment marcamos pagada.
    if (order.status !== "pending_payment") {
      await client.query("ROLLBACK");
      console.log("[getnet webhook] order not pending_payment:", order.id, order.status);
      return;
    }

    if (!order.reservation_id) {
      await client.query("ROLLBACK");
      console.log("[getnet webhook] missing reservation_id in order:", order.id);
      return;
    }

    // 2) Bloquear la reserva
    const rq = await client.query(
      `SELECT id, variant_id, quantity, status, expires_at
         FROM stock_reservations
        WHERE id = $1
        FOR UPDATE`,
      [order.reservation_id]
    );

    if (!rq.rowCount) {
      await client.query("ROLLBACK");
      console.log("[getnet webhook] reservation not found:", order.reservation_id);
      return;
    }

    const r = rq.rows[0];

    // Si ya está consumida, igual dejamos la orden como paid (idempotencia)
    if (r.status !== "active") {
      await client.query(
        `UPDATE orders
            SET status = 'paid',
                paid_at = NOW(),
                payment_ref = COALESCE(payment_ref, $2),
                updated_at = NOW()
          WHERE id = $1`,
        [order.id, requestId ? String(requestId) : null]
      );
      await client.query("COMMIT");
      return;
    }

    if (r.expires_at && new Date(r.expires_at) <= new Date()) {
      await client.query("ROLLBACK");
      console.log("[getnet webhook] reservation expired:", r.id);
      return;
    }

    const qty = Number(r.quantity);
    if (!Number.isFinite(qty) || qty <= 0) {
      await client.query("ROLLBACK");
      console.log("[getnet webhook] invalid reservation qty:", r.id, r.quantity);
      return;
    }

    // 3) Bloquear variante y consumir stock
    const pv = await client.query(
      `SELECT id, stock_total, stock_reserved
         FROM product_variants
        WHERE id = $1
        FOR UPDATE`,
      [r.variant_id]
    );

    if (!pv.rowCount) {
      await client.query("ROLLBACK");
      console.log("[getnet webhook] variant not found:", r.variant_id);
      return;
    }

    const row = pv.rows[0];
    if (Number(row.stock_reserved) < qty || Number(row.stock_total) < qty) {
      await client.query("ROLLBACK");
      console.log("[getnet webhook] stock insufficient:", r.variant_id, { row, qty });
      return;
    }

    await client.query(
      `UPDATE product_variants
          SET stock_total = stock_total - $1,
              stock_reserved = stock_reserved - $1
        WHERE id = $2`,
      [qty, r.variant_id]
    );

    await client.query(
      `UPDATE stock_reservations
          SET status = 'consumed'
        WHERE id = $1`,
      [r.id]
    );

    // 4) Marcar orden pagada + guardar requestId si vino
    await client.query(
      `UPDATE orders
          SET status = 'paid',
              paid_at = NOW(),
              payment_ref = COALESCE(payment_ref, $2),
              updated_at = NOW()
        WHERE id = $1`,
      [order.id, requestId ? String(requestId) : null]
    );

    await client.query("COMMIT");
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {}
    console.error("[getnet webhook] error:", e);
  } finally {
    client.release();
  }
});

// ===============================
// ✅ START
// ===============================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("✅ API running on port " + PORT));
