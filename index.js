const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
require("dotenv").config();

const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");

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

const mercadopago = require("mercadopago");

// Configuración MP (solo se usa si el token es real)
if (
  process.env.MP_ACCESS_TOKEN &&
  process.env.MP_ACCESS_TOKEN !== "PENDIENTE_CLIENTE"
) {
  mercadopago.configure({
    access_token: process.env.MP_ACCESS_TOKEN,
  });
}


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
  // Limpia reservas vencidas:
  // - resta quantity desde product_variants.stock_reserved
  // - marca stock_reservations.status='expired'
  // NOTA: no toca stock_total
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
// ✅ ADMIN: LISTAR VARIANTES
// (devuelve { ok:true, variants:[...] } para compatibilidad con admin.html)
// ===============================
app.get("/admin/variants", requireAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    // opcional: limpiar expiradas antes de mostrar
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

    // no permitir stock_total < stock_reserved
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
    return res
      .status(500)
      .json({ ok: false, error: "admin_update_stock_failed" });
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
    return res
      .status(500)
      .json({ ok: false, error: "admin_update_price_failed" });
  } finally {
    client.release();
  }
});

// ===============================
// ✅ ADMIN: PATCH opcional (active + price/stock seguro)
// Si lo usas, es para updates “rápidos”.
// ===============================
app.patch("/admin/variants/:id", requireAdmin, async (req, res) => {
  const id = req.params.id;
  const { price_clp, stock_total, active } = req.body || {};

  if (!id) return res.status(400).json({ ok: false, error: "missing_id" });

  const fields = [];
  const values = [];
  let i = 1;

  // price
  if (price_clp !== undefined) {
    const p = Number(price_clp);
    if (!Number.isFinite(p) || p < 0 || !Number.isInteger(p)) {
      return res.status(400).json({ ok: false, error: "invalid_price_clp" });
    }
    fields.push(`price_clp = $${i++}`);
    values.push(p);
  }

  // stock_total (se valida contra reserved dentro de transacción)
  const wantsStock = stock_total !== undefined;
  let stockToSet = null;
  if (wantsStock) {
    const s = Number(stock_total);
    if (!Number.isFinite(s) || s < 0 || !Number.isInteger(s)) {
      return res.status(400).json({ ok: false, error: "invalid_stock_total" });
    }
    stockToSet = s;
    fields.push(`stock_total = $${i++}`);
    values.push(s);
  }

  // active
  if (active !== undefined) {
    const a = Boolean(active);
    fields.push(`active = $${i++}`);
    values.push(a);
  }

  if (fields.length === 0) {
    return res.status(400).json({ ok: false, error: "nothing_to_update" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // si toca stock, valida stock_total >= reserved
    if (wantsStock) {
      await cleanupExpiredReservations(client);

      const cur = await client.query(
        `SELECT stock_reserved FROM product_variants WHERE id=$1 FOR UPDATE`,
        [id]
      );
      if (!cur.rowCount) {
        await client.query("ROLLBACK");
        return res.status(404).json({ ok: false, error: "variant_not_found" });
      }

      const reserved = Number(cur.rows[0].stock_reserved || 0);
      if (stockToSet < reserved) {
        await client.query("ROLLBACK");
        return res.status(409).json({
          ok: false,
          error: "stock_total_below_reserved",
          reserved,
          requested: stockToSet,
        });
      }
    }

    values.push(id);

    const q = `
      update product_variants
      set ${fields.join(", ")}
      where id = $${i}
      returning
        id, sku, color, size, grabado_codigo, grabado_nombre,
        price_clp, stock_total, stock_reserved,
        (stock_total - stock_reserved) as stock_available,
        active;
    `;

    const r = await client.query(q, values);

    if (!r.rowCount) {
      await client.query("ROLLBACK");
      return res.status(404).json({ ok: false, error: "variant_not_found" });
    }

    await client.query("COMMIT");
    return res.json({ ok: true, variant: r.rows[0] });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error(e);
    return res.status(500).json({ ok: false, error: "admin_patch_failed" });
  } finally {
    client.release();
  }
});

// ===============================
// ✅ MERCADO PAGO — STUB
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

  // 🟢 MP REAL
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
      metadata: { reservation_id },
      back_urls: {
        success: "https://TU-SITIO.cl/success",
        failure: "https://TU-SITIO.cl/failure",
        pending: "https://TU-SITIO.cl/pending",
      },
      auto_return: "approved",
      notification_url:
        "https://poleras-backend.onrender.com/mp/webhook",
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


app.post("/mp/webhook", async (req, res) => {
  // STUB: cuando MP esté real, validar firma + confirmar compra
  console.log("MP webhook (stub):", req.body);
  res.status(200).send("ok");
});

// ===============================
// ✅ START
// ===============================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("✅ API running on port " + PORT));
