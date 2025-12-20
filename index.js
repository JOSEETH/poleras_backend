const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());

if (!process.env.DATABASE_URL) {
  console.error("❌ Falta DATABASE_URL en el .env");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // Supabase usa SSL
});

// TTL configurable (minutos). Default 15 si no existe en .env
const RESERVATION_TTL_MINUTES = Number(process.env.RESERVATION_TTL_MINUTES || 15);

const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");

// ===============================
// 🔐 ADMIN AUTH (simple JWT)
// ===============================
function requireEnv(name) {
  if (!process.env[name]) {
    console.error(`❌ Falta ${name} en .env / Render env vars`);
    process.exit(1);
  }
}

requireEnv("ADMIN_EMAIL");
requireEnv("ADMIN_PASSWORD_HASH");
requireEnv("ADMIN_JWT_SECRET");

function signAdminToken() {
  // token válido 7 días
  return jwt.sign(
    { role: "admin" },
    process.env.ADMIN_JWT_SECRET,
    { expiresIn: "7d" }
  );
}

function requireAdmin(req, res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;

  if (!token) {
    return res.status(401).json({ ok: false, error: "Falta token" });
  }

  try {
    const payload = jwt.verify(token, process.env.ADMIN_JWT_SECRET);
    if (payload.role !== "admin") {
      return res.status(403).json({ ok: false, error: "No autorizado" });
    }
    next();
  } catch (e) {
    return res.status(401).json({ ok: false, error: "Token inválido/expirado" });
  }
}

// Login admin
app.post("/admin/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ ok: false, error: "Email y password requeridos" });
    }

    if (String(email).toLowerCase() !== String(process.env.ADMIN_EMAIL).toLowerCase()) {
      return res.status(401).json({ ok: false, error: "Credenciales inválidas" });
    }

    const ok = await bcrypt.compare(String(password), String(process.env.ADMIN_PASSWORD_HASH));
    if (!ok) {
      return res.status(401).json({ ok: false, error: "Credenciales inválidas" });
    }

    const token = signAdminToken();
    return res.json({ ok: true, token });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// Listar variantes (admin)
app.get("/admin/variants", requireAdmin, async (req, res) => {
  try {
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
    const r = await pool.query(q);
    return res.json({ ok: true, rows: r.rows });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// Editar variante (admin)
app.patch("/admin/variants/:id", requireAdmin, async (req, res) => {
  const id = req.params.id;
  const { price_clp, stock_total, active } = req.body || {};

  // Validación básica
  if (!id) return res.status(400).json({ ok: false, error: "Falta id" });

  const fields = [];
  const values = [];
  let i = 1;

  if (price_clp !== undefined) {
    const p = Number(price_clp);
    if (!Number.isFinite(p) || p < 0) {
      return res.status(400).json({ ok: false, error: "price_clp inválido" });
    }
    fields.push(`price_clp = $${i++}`);
    values.push(p);
  }

  if (stock_total !== undefined) {
    const s = Number(stock_total);
    if (!Number.isFinite(s) || s < 0) {
      return res.status(400).json({ ok: false, error: "stock_total inválido" });
    }
    fields.push(`stock_total = $${i++}`);
    values.push(s);
  }

  if (active !== undefined) {
    const a = Boolean(active);
    fields.push(`active = $${i++}`);
    values.push(a);
  }

  if (fields.length === 0) {
    return res.status(400).json({ ok: false, error: "Nada para actualizar" });
  }

  values.push(id);

  try {
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
    const r = await pool.query(q, values);

    if (r.rows.length === 0) {
      return res.status(404).json({ ok: false, error: "Variante no encontrada" });
    }

    return res.json({ ok: true, row: r.rows[0] });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// ===============================
// 🔐 ADMIN LOGIN
// ===============================
app.post("/admin/login", async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({
      ok: false,
      error: "Email y password requeridos",
    });
  }

  // 1️⃣ Validar email
  if (email !== process.env.ADMIN_EMAIL) {
    return res.status(401).json({
      ok: false,
      error: "Credenciales inválidas",
    });
  }

  // 2️⃣ Comparar password con bcrypt
  const valid = await bcrypt.compare(
    password,
    process.env.ADMIN_PASSWORD_HASH
  );

  if (!valid) {
    return res.status(401).json({
      ok: false,
      error: "Credenciales inválidas",
    });
  }

  // 3️⃣ Emitir token
  const token = jwt.sign(
    { role: "admin" },
    process.env.ADMIN_JWT_SECRET,
    { expiresIn: "7d" }
  );

  return res.json({
    ok: true,
    token,
  });
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

app.get("/health", async (req, res) => {
  try {
    const r = await pool.query("select now() as now");
    res.json({ ok: true, now: r.rows[0].now });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

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
// (Opcional) Endpoint manual/cron externo
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

app.post("/reserve", async (req, res) => {
  const { variant_id, quantity } = req.body;
  const qty = Number(quantity);

  if (!variant_id || !Number.isFinite(qty) || qty <= 0) {
    return res.status(400).json({
      ok: false,
      error: "Datos inválidos",
    });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // 🔓 0) LIMPIA RESERVAS VENCIDAS ANTES DE CALCULAR STOCK
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
      return res.status(404).json({
        ok: false,
        error: "Variante no encontrada",
      });
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
      error: err.message || "Error interno",
    });
  } finally {
    client.release();
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log("✅ API running on http://localhost:" + PORT)
);
