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

const { sendStoreNotificationEmail } = require("./email");

const mercadopago = require("mercadopago");

const app = express();
app.use(cors());
app.use(express.json());

// ===============================
// ✅ ENV CHECK
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

// 🔥 Recomendado (siempre que quieras email real sí o sí)
// Si aún quieres que el backend corra aunque falte alguno, comenta estas dos líneas.
requireEnv("RESEND_API_KEY");
requireEnv("STORE_NOTIFY_EMAIL");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // Supabase usa SSL
});

// TTL configurable (minutos). Default 15 si no existe en .env
const RESERVATION_TTL_MINUTES = Number(process.env.RESERVATION_TTL_MINUTES || 15);

// ===============================
// 🔐 ADMIN AUTH (simple JWT)
// ===============================
function signAdminToken() {
  // token válido 7 días
  return jwt.sign({ role: "admin" }, process.env.ADMIN_JWT_SECRET, {
    expiresIn: "7d",
  });
}

function requireAdmin(req, res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;

  if (!token) {
    return res.status(401).json({ ok: false, error: "missing_token" });
  }

  try {
    const payload = jwt.verify(token, process.env.ADMIN_JWT_SECRET);
    if (payload.role !== "admin") {
      return res.status(403).json({ ok: false, error: "not_authorized" });
    }
    next();
  } catch (e) {
    return res.status(401).json({ ok: false, error: "invalid_or_expired_token" });
  }
}

// ===============================
// 🔐 ADMIN LOGIN (ÚNICO)
// ===============================
app.post("/admin/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res
        .status(400)
        .json({ ok: false, error: "email_and_password_required" });
    }

    if (
      String(email).toLowerCase() !==
      String(process.env.ADMIN_EMAIL).toLowerCase()
    ) {
      return res.status(401).json({ ok: false, error: "invalid_credentials" });
    }

    const ok = await bcrypt.compare(
      String(password),
      String(process.env.ADMIN_PASSWORD_HASH)
    );

    if (!ok) {
      return res.status(401).json({ ok: false, error: "invalid_credentials" });
    }

    const token = signAdminToken();
    return res.json({ ok: true, token });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: "login_failed" });
  }
});

// ===============================
// 🔓 CLEANUP STOCK VENCIDO (reusable)
// ===============================
async function cleanupExpiredReservations(client) {
  const q = `
    WITH expired AS (
      SELECT id, variant_id, quantity
      FROM stock_reservations
      WHERE status = 'active'
        AND expires_at <= NOW()
      FOR UPDATE
    ),
    updated_variants AS (
      UPDATE product_variants pv
      SET stock_reserved = GREATEST(pv.stock_reserved - e.quantity, 0)
      FROM expired e
      WHERE pv.id = e.variant_id
      RETURNING pv.id
    )
    UPDATE stock_reservations sr
    SET status = 'expired'
    FROM expired e
    WHERE sr.id = e.id
    RETURNING sr.id, sr.variant_id, sr.quantity;
  `;

  const r = await client.query(q);
  return { expired_count: r.rowCount, expired: r.rows };
}

// ===============================
// ✅ HEALTH
// ===============================
app.get("/health", async (req, res) => {
  try {
    const r = await pool.query("select now() as now");
    res.json({ ok: true, now: r.rows[0].now });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ===============================
// ✅ TEST EMAIL (manual)
// ===============================
app.get("/test-email", async (req, res) => {
  try {
    const to = process.env.STORE_NOTIFY_EMAIL;
    if (!to) {
      return res.status(500).json({ ok: false, error: "STORE_NOTIFY_EMAIL not set" });
    }

    await sendStoreNotificationEmail({
      to,
      subject: "✅ Test email — Poleras Huillinco",
      html: `
        <div style="font-family:Arial,sans-serif">
          <h2>Test OK</h2>
          <p>Si te llegó este correo, Resend está funcionando correctamente.</p>
          <p><b>Fecha:</b> ${new Date().toISOString()}</p>
        </div>
      `,
    });

    return res.json({ ok: true, sent_to: to });
  } catch (err) {
    console.error("❌ Error sending test email:", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ===============================
// ✅ PUBLIC: VARIANTS (para formulario)
// ===============================
app.get("/variants", async (req, res) => {
  try {
    const q = `
      select
        id, sku, color, size, grabado_codigo, grabado_nombre,
        price_clp,
        (stock_total - stock_reserved) as stock
      from product_variants
      where active = true
      order by color, grabado_codigo, size;
    `;
    const r = await pool.query(q);
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// =====================================
// ✅ Endpoint manual/cron externo cleanup
// =====================================
app.post("/cleanup-reservations", async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const cleaned = await cleanupExpiredReservations(client);
    await client.query("COMMIT");

    return res.json({
      ok: true,
      ...cleaned,
    });
  } catch (e) {
    await client.query("ROLLBACK");
    return res.status(500).json({ ok: false, error: e.message });
  } finally {
    client.release();
  }
});

// ===============================
// ✅ RESERVE (stock con TTL)
// ===============================
app.post("/reserve", async (req, res) => {
  const { variant_id, quantity } = req.body || {};
  const qty = Number(quantity);

  if (!variant_id || !Number.isFinite(qty) || qty <= 0) {
    return res.status(400).json({ ok: false, error: "invalid_body" });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // 0) limpia vencidas antes de calcular
    await cleanupExpiredReservations(client);

    // 1) Bloquear fila y leer stock real
    const stockResult = await client.query(
      `
      SELECT id, stock_total, stock_reserved
      FROM product_variants
      WHERE id = $1 AND active = true
      FOR UPDATE
      `,
      [variant_id]
    );

    if (stockResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ ok: false, error: "variant_not_found" });
    }

    const stock_total = Number(stockResult.rows[0].stock_total);
    const stock_reserved = Number(stockResult.rows[0].stock_reserved);
    const availableStock = stock_total - stock_reserved;

    // 2) Sin stock
    if (availableStock <= 0) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        ok: false,
        reason: "out_of_stock",
        available: 0,
        message: "Esta combinación se agotó",
      });
    }

    // 3) Stock insuficiente
    if (availableStock < qty) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        ok: false,
        reason: "partial",
        available: availableStock,
        message: `Solo quedan ${availableStock} unidades disponibles`,
      });
    }

    // 4) Crear reserva con TTL configurable y status active
    const reservation = await client.query(
      `
      INSERT INTO stock_reservations (
        variant_id,
        quantity,
        expires_at,
        status
      )
      VALUES (
        $1,
        $2,
        NOW() + ($3 || ' minutes')::interval,
        'active'
      )
      RETURNING id, expires_at
      `,
      [variant_id, qty, RESERVATION_TTL_MINUTES]
    );

    // 5) Reservar stock (sube stock_reserved)
    await client.query(
      `
      UPDATE product_variants
      SET stock_reserved = stock_reserved + $1
      WHERE id = $2
      `,
      [qty, variant_id]
    );

    await client.query("COMMIT");

    return res.json({
      ok: true,
      reservation_id: reservation.rows[0].id,
      expires_at: reservation.rows[0].expires_at,
      reserved: qty,
      available_after: availableStock - qty,
      message: "Stock reservado correctamente",
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    return res.status(500).json({
      ok: false,
      error: err.message || "internal_error",
    });
  } finally {
    client.release();
  }
});

// ===============================
// ✅ ORDERS (crear orden antes de pagar)
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
    if (!buyer_name) {
      return res.status(400).json({ ok: false, error: "missing_buyer_name" });
    }
    if (!delivery_method || !["retiro", "envio_por_pagar"].includes(delivery_method)) {
      return res.status(400).json({ ok: false, error: "invalid_delivery_method" });
    }
    if (delivery_method === "envio_por_pagar" && !delivery_address) {
      return res.status(400).json({ ok: false, error: "missing_delivery_address" });
    }
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ ok: false, error: "missing_items" });
    }

    const total_clp = items.reduce((acc, it) => {
      const q = Number(it.quantity || 0);
      const p = Number(it.unit_price || 0);
      return acc + q * p;
    }, 0);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // Validar que la reserva exista y esté activa
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
         RETURNING id, reservation_id, status, total_clp, created_at, updated_at`,
        [
          reservation_id,
          buyer_name,
          buyer_email || null,
          buyer_phone || null,
          delivery_method,
          delivery_address || null,
          JSON.stringify(items),
          total_clp,
        ]
      );

      await client.query("COMMIT");
      return res.json({ ok: true, order: ins.rows[0] });
    } catch (e) {
      await client.query("ROLLBACK");
      console.error("POST /orders error:", e);
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
    await cleanupExpiredReservations(client);

    const q = `
      select
        id, sku, color, size, grabado_codigo, grabado_nombre,
        price_clp,
        stock_total,
        stock_reserved,
        (stock_total - stock_reserved) as stock_available,
        active,
        created_at
      from product_variants
      order by color, grabado_codigo, size;
    `;
    const r = await client.query(q);
    return res.json({ ok: true, variants: r.rows });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: "admin_variants_failed" });
  } finally {
    client.release();
  }
});

// ===============================
// ✅ ADMIN: STOCK MOVEMENTS (venta física / ajustes)
// POST /admin/variants/:id/move
// body: { movement_type, quantity, unit_price_clp, note, occurred_at? }
// - sale_offline: descuenta stock_total + registra movimiento (requiere precio)
// - adjust_out: descuenta stock_total + registra movimiento
// - adjust_in: aumenta stock_total + registra movimiento
// ===============================
app.post("/admin/variants/:id/move", requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { movement_type, quantity, unit_price_clp, note, occurred_at } = req.body || {};

  const qty = Number(quantity);

  if (!id) return res.status(400).json({ ok: false, error: "missing_id" });
  if (!["sale_offline", "adjust_out", "adjust_in"].includes(movement_type)) {
    return res.status(400).json({ ok: false, error: "invalid_movement_type" });
  }
  if (!Number.isInteger(qty) || qty <= 0) {
    return res.status(400).json({ ok: false, error: "invalid_quantity" });
  }

  // precio requerido solo para ventas físicas
  const price =
    unit_price_clp === undefined || unit_price_clp === null ? null : Number(unit_price_clp);

  if (movement_type === "sale_offline") {
    if (!Number.isInteger(price) || price < 0) {
      return res.status(400).json({ ok: false, error: "invalid_unit_price_clp" });
    }
  }

  const when = occurred_at ? new Date(occurred_at) : new Date();
  if (Number.isNaN(when.getTime())) {
    return res.status(400).json({ ok: false, error: "invalid_occurred_at" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await cleanupExpiredReservations(client);

    // bloquea variante
    const cur = await client.query(
      `SELECT id, sku, stock_total, stock_reserved
       FROM product_variants
       WHERE id=$1
       FOR UPDATE`,
      [id]
    );

    if (!cur.rowCount) {
      await client.query("ROLLBACK");
      return res.status(404).json({ ok: false, error: "variant_not_found" });
    }

    const v = cur.rows[0];
    const stockTotal = Number(v.stock_total || 0);
    const reserved = Number(v.stock_reserved || 0);

    // calcula nuevo stock_total según tipo
    let newTotal = stockTotal;
    if (movement_type === "adjust_in") newTotal = stockTotal + qty;
    else newTotal = stockTotal - qty;

    if (newTotal < 0) {
      await client.query("ROLLBACK");
      return res.status(409).json({ ok: false, error: "stock_total_negative" });
    }
    if (newTotal < reserved) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        ok: false,
        error: "stock_total_below_reserved",
        reserved,
        current_total: stockTotal,
        requested_new_total: newTotal,
      });
    }

    // update stock_total
    const upd = await client.query(
      `UPDATE product_variants
       SET stock_total = $2
       WHERE id = $1
       RETURNING id, sku, stock_total, stock_reserved, (stock_total - stock_reserved) as stock_available`,
      [id, newTotal]
    );

    // insert movimiento
    const mov = await client.query(
      `INSERT INTO stock_movements
        (variant_id, movement_type, quantity, unit_price_clp, note, occurred_at)
       VALUES
        ($1, $2, $3, $4, $5, $6)
       RETURNING id, variant_id, movement_type, quantity, unit_price_clp, note, occurred_at`,
      [
        id,
        movement_type,
        qty,
        movement_type === "sale_offline" ? price : null,
        note || null,
        when.toISOString(),
      ]
    );

    await client.query("COMMIT");
    return res.json({ ok: true, variant: upd.rows[0], movement: mov.rows[0] });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("POST /admin/variants/:id/move error:", e);
    return res.status(500).json({ ok: false, error: "move_failed" });
  } finally {
    client.release();
  }
});

// ===============================
// ✅ ADMIN: LISTAR MOVIMIENTOS
// GET /admin/stock-movements?from=YYYY-MM-DD&to=YYYY-MM-DD&sku=...&type=...&variant_id=...
// (usa ::date para que "to" incluya el día completo)
// ===============================
app.get("/admin/stock-movements", requireAdmin, async (req, res) => {
  try {
    const { from, to, sku, type, variant_id } = req.query || {};

    const where = [];
    const values = [];
    let i = 1;

    if (variant_id) { where.push(`sm.variant_id = $${i++}`); values.push(String(variant_id)); }
    if (type)       { where.push(`sm.movement_type = $${i++}`); values.push(String(type)); }

    if (from) { where.push(`sm.occurred_at >= $${i++}::date`); values.push(from); }
    if (to)   { where.push(`sm.occurred_at < ($${i++}::date + INTERVAL '1 day')`); values.push(to); }

    if (sku)  { where.push(`pv.sku ILIKE $${i++}`); values.push(`%${String(sku)}%`); }

    const q = `
      SELECT
        sm.id, sm.occurred_at, sm.movement_type, sm.quantity, sm.unit_price_clp, sm.note,
        sm.variant_id,
        pv.sku, pv.color, pv.size, pv.grabado_nombre
      FROM stock_movements sm
      JOIN product_variants pv ON pv.id = sm.variant_id
      ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY sm.occurred_at DESC
      LIMIT 500;
    `;

    const r = await pool.query(q, values);
    return res.json({ ok: true, movements: r.rows });
  } catch (e) {
    console.error("GET /admin/stock-movements error:", e);
    return res.status(500).json({ ok: false, error: "stock_movements_list_failed" });
  }
});


// ===============================
// ✅ ADMIN: RESUMEN DE VENTAS (físicas)
// GET /admin/sales-summary?from=YYYY-MM-DD&to=YYYY-MM-DD
// (usa ::date para incluir el día completo)
// ===============================
app.get("/admin/sales-summary", requireAdmin, async (req, res) => {
  try {
    const { from, to } = req.query || {};

    const where = [`sm.movement_type = 'sale_offline'`];
    const values = [];
    let i = 1;

    // from: >= from 00:00 (como date)
    if (from) {
      where.push(`sm.occurred_at >= $${i++}::date`);
      values.push(from);
    }

    // to: < (to + 1 día) para incluir todo el día "to"
    if (to) {
      where.push(`sm.occurred_at < ($${i++}::date + INTERVAL '1 day')`);
      values.push(to);
    }

    const q = `
      SELECT
        COALESCE(SUM(sm.quantity),0)::int as units_sold,
        COALESCE(SUM(sm.quantity * COALESCE(sm.unit_price_clp,0)),0)::bigint as total_clp
      FROM stock_movements sm
      WHERE ${where.join(" AND ")};
    `;

    const r = await pool.query(q, values);
    return res.json({ ok: true, ...r.rows[0] });
  } catch (e) {
    console.error("GET /admin/sales-summary error:", e);
    return res.status(500).json({ ok: false, error: "sales_summary_failed" });
  }
});


// ===============================
// ✅ ADMIN: UPDATE STOCK_TOTAL
// ===============================
app.put("/admin/variants/:id/stock", requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { stock_total } = req.body || {};

  if (!id) return res.status(400).json({ ok: false, error: "missing_id" });
  if (!Number.isInteger(stock_total) || stock_total < 0) {
    return res.status(400).json({ ok: false, error: "invalid_stock_total" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await cleanupExpiredReservations(client);

    const current = await client.query(
      `SELECT stock_reserved FROM product_variants WHERE id=$1 FOR UPDATE`,
      [id]
    );

    if (current.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ ok: false, error: "variant_not_found" });
    }

    const reserved = Number(current.rows[0].stock_reserved || 0);

    if (stock_total < reserved) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        ok: false,
        error: "stock_total_below_reserved",
        reserved,
        requested: stock_total,
      });
    }

    const updated = await client.query(
      `
      UPDATE product_variants
      SET stock_total=$2
      WHERE id=$1
      RETURNING id, stock_total, stock_reserved, (stock_total - stock_reserved) AS stock_available
      `,
      [id, stock_total]
    );

    await client.query("COMMIT");
    return res.json({ ok: true, variant: updated.rows[0] });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error(e);
    return res.status(500).json({ ok: false, error: "admin_update_stock_failed" });
  } finally {
    client.release();
  }
});

// ===============================
// ✅ ADMIN: UPDATE PRICE_CLP
// ===============================
app.put("/admin/variants/:id/price", requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { price_clp } = req.body || {};

  if (!id) return res.status(400).json({ ok: false, error: "missing_id" });
  if (!Number.isInteger(price_clp) || price_clp < 0) {
    return res.status(400).json({ ok: false, error: "invalid_price_clp" });
  }

  const client = await pool.connect();
  try {
    const r = await client.query(
      `
      UPDATE product_variants
      SET price_clp=$2
      WHERE id=$1
      RETURNING id, price_clp
      `,
      [id, price_clp]
    );

    if (!r.rowCount) {
      return res.status(404).json({ ok: false, error: "variant_not_found" });
    }

    return res.json({ ok: true, variant: r.rows[0] });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: "admin_update_price_failed" });
  } finally {
    client.release();
  }
});

// ===============================
// ✅ Configuración MP (solo se usa si el token es real)
// ===============================
if (
  process.env.MP_ACCESS_TOKEN &&
  process.env.MP_ACCESS_TOKEN !== "PENDIENTE_CLIENTE"
) {
  mercadopago.configure({
    access_token: process.env.MP_ACCESS_TOKEN,
  });
}

// ===============================
// ✅ MERCADO PAGO — create preference
// ===============================
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
    const r = await pool.query(
      `
      SELECT sr.id, sr.quantity, pv.price_clp, pv.sku
      FROM stock_reservations sr
      JOIN product_variants pv ON pv.id = sr.variant_id
      WHERE sr.id = $1 AND sr.status = 'active'
      `,
      [reservation_id]
    );

    if (!r.rowCount) {
      return res.status(404).json({
        ok: false,
        error: "reservation_not_found_or_expired",
      });
    }

    const item = r.rows[0];

    const preference = {
      items: [
        {
          id: item.sku,
          title: "Polera Huillinco",
          quantity: item.quantity,
          currency_id: "CLP",
          unit_price: Number(item.price_clp),
        },
      ],
      external_reference: reservation_id,
      metadata: { reservation_id },
      back_urls: {
        success: "https://TU-SITIO.cl/success",
        failure: "https://TU-SITIO.cl/failure",
        pending: "https://TU-SITIO.cl/pending",
      },
      auto_return: "approved",
      notification_url: "https://poleras-backend.onrender.com/mp/webhook",
    };

    const mpRes = await mercadopago.preferences.create(preference);

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

// ===============================
// ✅ MP – Confirmación de reserva (helpers)
// ===============================
async function confirmReservation_holdReserved(client, reservation_id) {
  const q = `
    UPDATE stock_reservations
    SET status = 'confirmed'
    WHERE id = $1
      AND status = 'active'
      AND expires_at > NOW()
    RETURNING id, variant_id, quantity, expires_at, status;
  `;
  const r = await client.query(q, [reservation_id]);
  return r.rows[0] || null;
}

// ===============================
// ✅ MP WEBHOOK (pago aprobado -> confirma + email)
// ===============================
app.post("/mp/webhook", async (req, res) => {
  try {
    // Responder rápido siempre
    res.status(200).send("ok");

    const event = req.body;
    console.log("MP webhook recibido:", event);

    if (
      !process.env.MP_ACCESS_TOKEN ||
      process.env.MP_ACCESS_TOKEN === "PENDIENTE_CLIENTE"
    ) {
      console.log("MP webhook: MP_ACCESS_TOKEN pendiente, ignorando.");
      return;
    }

    const paymentId = event?.data?.id;
    if (!paymentId) {
      console.log("MP webhook: no paymentId en event.data.id");
      return;
    }

    const payment = await mercadopago.payment.findById(paymentId);
    const status = payment?.body?.status;

    if (status !== "approved") {
      console.log("MP webhook: pago no aprobado:", status);
      return;
    }

    const reservation_id =
      payment?.body?.metadata?.reservation_id ||
      payment?.body?.external_reference;

    if (!reservation_id) {
      console.log("MP webhook: falta reservation_id en payment");
      return;
    }

    // Confirmar reserva (Opción A)
    const client = await pool.connect();
    let confirmed = null;

    try {
      await client.query("BEGIN");
      confirmed = await confirmReservation_holdReserved(client, reservation_id);

      if (!confirmed) {
        await client.query("ROLLBACK");
        console.log("MP webhook: reserva no confirmada (ya confirmada o expirada)", reservation_id);
        return;
      }

      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      console.error("MP webhook: error DB:", e);
      return;
    } finally {
      client.release();
    }

    // Buscar order para armar email completo
    const orderRes = await pool.query(
      `SELECT reservation_id, buyer_name, buyer_email, buyer_phone, delivery_method, delivery_address, items, total_clp
       FROM orders
       WHERE reservation_id = $1
       LIMIT 1`,
      [reservation_id]
    );

    const to = process.env.STORE_NOTIFY_EMAIL;
    if (!to) {
      console.log("MP webhook: falta STORE_NOTIFY_EMAIL");
      return;
    }

    if (!orderRes.rowCount) {
      // Email mínimo si no hay order guardada
      await sendStoreNotificationEmail({
        to,
        subject: "✅ Pago aprobado — Poleras Huillinco",
        html: `
          <div style="font-family:Arial,sans-serif">
            <h2>✅ Pago aprobado</h2>
            <p><b>Reserva:</b> ${reservation_id}</p>
            <p><b>Payment ID:</b> ${paymentId}</p>
            <p><i>No se encontró una order asociada (orders) para esta reserva.</i></p>
          </div>
        `,
      });

      console.log("MP webhook: confirmado + email mínimo enviado", reservation_id);
      return;
    }

    const o = orderRes.rows[0];
    const items = Array.isArray(o.items) ? o.items : (o.items || []);

    const itemsHtml = items
      .map((it) => {
        const sku = it.sku || "-";
        const q = Number(it.quantity || 0);
        const p = Number(it.unit_price || 0);
        const sub = q * p;
        return `<tr>
          <td style="padding:6px;border-bottom:1px solid #eee">${sku}</td>
          <td style="padding:6px;border-bottom:1px solid #eee;text-align:center">${q}</td>
          <td style="padding:6px;border-bottom:1px solid #eee;text-align:right">$${p.toLocaleString("es-CL")}</td>
          <td style="padding:6px;border-bottom:1px solid #eee;text-align:right">$${sub.toLocaleString("es-CL")}</td>
        </tr>`;
      })
      .join("");

    const delivery =
      o.delivery_method === "retiro"
        ? `<b>Retiro en Huillinco</b>`
        : `<b>Envío por pagar</b><br/><b>Dirección:</b> ${o.delivery_address || "-"}`;

    await sendStoreNotificationEmail({
      to,
      subject: "✅ Pago aprobado — Poleras Huillinco (Pedido listo)",
      html: `
        <div style="font-family:Arial,sans-serif">
          <h2>✅ Pago aprobado — Pedido confirmado</h2>

          <p><b>Reserva:</b> ${o.reservation_id}</p>
          <p><b>Payment ID:</b> ${paymentId}</p>

          <h3>Cliente</h3>
          <p>
            <b>Nombre:</b> ${o.buyer_name}<br/>
            <b>Email:</b> ${o.buyer_email || "-"}<br/>
            <b>Teléfono:</b> ${o.buyer_phone || "-"}
          </p>

          <h3>Entrega</h3>
          <p>${delivery}</p>

          <h3>Detalle</h3>
          <table style="border-collapse:collapse;width:100%;max-width:640px">
            <thead>
              <tr>
                <th style="text-align:left;padding:6px;border-bottom:2px solid #ddd">SKU</th>
                <th style="text-align:center;padding:6px;border-bottom:2px solid #ddd">Cant</th>
                <th style="text-align:right;padding:6px;border-bottom:2px solid #ddd">Precio</th>
                <th style="text-align:right;padding:6px;border-bottom:2px solid #ddd">Subtotal</th>
              </tr>
            </thead>
            <tbody>
              ${itemsHtml}
            </tbody>
          </table>

          <p style="margin-top:12px">
            <b>Total:</b> $${Number(o.total_clp || 0).toLocaleString("es-CL")}
          </p>

          <p style="margin-top:14px">
            Siguiente paso: contactar al cliente por WhatsApp para coordinar retiro/envío por pagar.
          </p>
        </div>
      `,
    });

    console.log("MP webhook: confirmado + email completo enviado", reservation_id);
  } catch (e) {
    console.error("MP webhook error:", e);
  }
});

// ===============================
// ✅ START
// ===============================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("✅ API running on port " + PORT));
