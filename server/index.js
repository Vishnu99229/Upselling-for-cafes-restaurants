const path = require("path");
// Override because OPENAI_API_KEY might be stale in shell env
require("dotenv").config({ path: path.join(__dirname, ".env"), override: true });

if (!process.env.OPENAI_API_KEY) {
    console.error("CRITICAL ERROR: OPENAI_API_KEY is missing from environment variables.");
    process.exit(1);
}

// Log loaded key (masked) for debugging
console.log("Loaded API Key:", process.env.OPENAI_API_KEY.substring(0, 15) + "..." + process.env.OPENAI_API_KEY.slice(-4));

const express = require("express");
const OpenAI = require("openai");

const { Pool } = require("pg");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const JWT_SECRET = process.env.JWT_SECRET || "fallback_secret_for_dev";

// --- PostgreSQL Pool ---
console.log("DATABASE_URL exists:", !!process.env.DATABASE_URL);
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});

// --- DB Startup: Health Check + Migrations ---
(async () => {
    try {
        const test = await pool.query("SELECT NOW()");
        console.log("✅ DB Connected:", test.rows[0]);

        // Idempotent schema migrations
        await pool.query(`
            CREATE TABLE IF NOT EXISTS restaurants (
                id SERIAL PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                slug VARCHAR(255) UNIQUE NOT NULL,
                domain VARCHAR(255) UNIQUE NOT NULL,
                whatsapp_number VARCHAR(20),
                max_tables INTEGER DEFAULT 10,
                config JSONB DEFAULT '{}',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_name VARCHAR(255)`);
        await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_phone VARCHAR(20)`);
        await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'pending'`);
        await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP`);
        await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS table_number VARCHAR(20)`);
        await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS upsell_value INTEGER DEFAULT 0`);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS admins (
                id SERIAL PRIMARY KEY,
                restaurant_id INTEGER REFERENCES restaurants(id) ON DELETE CASCADE,
                email VARCHAR(255) UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS menus (
                id SERIAL PRIMARY KEY,
                restaurant_id INTEGER REFERENCES restaurants(id) ON DELETE CASCADE,
                name VARCHAR(255) NOT NULL,
                description TEXT,
                price NUMERIC(10,2) NOT NULL,
                category VARCHAR(100),
                sub_category VARCHAR(100),
                tags TEXT[] DEFAULT '{}',
                image_url TEXT,
                is_available BOOLEAN DEFAULT true,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Additive migration for existing tables
        await pool.query(`ALTER TABLE menus ADD COLUMN IF NOT EXISTS sub_category VARCHAR(100)`);
        await pool.query(`ALTER TABLE menus ADD COLUMN IF NOT EXISTS tags TEXT[] DEFAULT '{}'`);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS upsell_events (
                id SERIAL PRIMARY KEY,
                restaurant_slug TEXT,
                table_number TEXT,
                item_id INTEGER,
                cart_value INTEGER,
                upsell_value INTEGER,
                event_type TEXT CHECK (event_type IN ('shown','accepted','rejected')),
                gpt_word_count INTEGER,
                upsell_reason TEXT,
                created_at TIMESTAMP DEFAULT NOW()
            )
        `);
        // Add candidate_pool_size to upsell_events
        await pool.query(`ALTER TABLE upsell_events ADD COLUMN IF NOT EXISTS candidate_pool_size INTEGER`);

        // Customers table for phone auth
        await pool.query(`
            CREATE TABLE IF NOT EXISTS customers (
                id SERIAL PRIMARY KEY,
                phone_number VARCHAR(20) UNIQUE NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                last_verified_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        await pool.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);
        await pool.query(`
            CREATE TABLE IF NOT EXISTS ingredients (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                cafe_slug VARCHAR(255) NOT NULL,
                name VARCHAR(255) NOT NULL,
                category VARCHAR(100),
                unit VARCHAR(50) NOT NULL,
                cost_per_unit NUMERIC(10,2) NOT NULL,
                shelf_life_hours INTEGER,
                storage_type VARCHAR(50),
                supplier_name VARCHAR(255),
                min_order_quantity NUMERIC(10,2),
                is_active BOOLEAN DEFAULT true,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE (cafe_slug, name)
            )
        `);
        await pool.query(`
            CREATE TABLE IF NOT EXISTS recipe_ingredients (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                menu_item_id INTEGER NOT NULL REFERENCES menus(id) ON DELETE CASCADE,
                ingredient_id UUID NOT NULL REFERENCES ingredients(id) ON DELETE CASCADE,
                quantity_used NUMERIC(10,2) NOT NULL,
                unit VARCHAR(50) NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE (menu_item_id, ingredient_id)
            )
        `);
        await pool.query(`
            CREATE TABLE IF NOT EXISTS order_items (
                id SERIAL PRIMARY KEY,
                order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
                menu_item_id INTEGER REFERENCES menus(id) ON DELETE SET NULL,
                item_name VARCHAR(255) NOT NULL,
                quantity INTEGER NOT NULL DEFAULT 1,
                unit_price NUMERIC(10,2) NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_order_items_order_id ON order_items(order_id)`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_order_items_menu_item_id ON order_items(menu_item_id)`);
        await pool.query(`
            CREATE TABLE IF NOT EXISTS waste_log (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                cafe_slug VARCHAR(255) NOT NULL,
                ingredient_id UUID NOT NULL REFERENCES ingredients(id) ON DELETE CASCADE,
                quantity_wasted NUMERIC(10,2) NOT NULL,
                reason VARCHAR(50) NOT NULL CHECK (reason IN ('expired', 'spoiled', 'overprepped', 'dropped', 'plate_waste', 'other')),
                cost_value NUMERIC(10,2) NOT NULL,
                notes TEXT,
                logged_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                logged_by VARCHAR(255)
            )
        `);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_waste_log_slug_logged_at ON waste_log(cafe_slug, logged_at)`);
        await pool.query(`
            CREATE TABLE IF NOT EXISTS demand_forecasts (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                cafe_slug VARCHAR(255) NOT NULL,
                menu_item_id INTEGER REFERENCES menus(id) ON DELETE CASCADE,
                forecast_date DATE NOT NULL,
                predicted_quantity NUMERIC(10,2) NOT NULL,
                actual_quantity NUMERIC(10,2),
                confidence_score NUMERIC(5,4),
                model_version VARCHAR(50),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_demand_forecasts_slug_date ON demand_forecasts(cafe_slug, forecast_date)`);
        await pool.query(`
            CREATE TABLE IF NOT EXISTS purchase_recommendations (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                cafe_slug VARCHAR(255) NOT NULL,
                ingredient_id UUID REFERENCES ingredients(id) ON DELETE CASCADE,
                recommendation_date DATE NOT NULL,
                recommended_quantity NUMERIC(10,2) NOT NULL,
                estimated_cost NUMERIC(10,2) NOT NULL,
                reason TEXT,
                status VARCHAR(50) DEFAULT 'pending',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_purchase_recs_slug_date ON purchase_recommendations(cafe_slug, recommendation_date)`);
        await pool.query(`
            CREATE TABLE IF NOT EXISTS daily_weather (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                cafe_slug VARCHAR(255) NOT NULL,
                weather_date DATE NOT NULL,
                temperature_high NUMERIC(5,2),
                temperature_low NUMERIC(5,2),
                is_rain BOOLEAN DEFAULT false,
                humidity INTEGER,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(cafe_slug, weather_date)
            )
        `);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_daily_weather_slug_date ON daily_weather(cafe_slug, weather_date)`);
        await pool.query(`
            CREATE TABLE IF NOT EXISTS inventory_alerts (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                cafe_slug VARCHAR(255) NOT NULL,
                ingredient_id UUID REFERENCES ingredients(id) ON DELETE CASCADE,
                alert_type VARCHAR(50) NOT NULL,
                alert_date DATE NOT NULL,
                message TEXT,
                menu_items_to_push INTEGER[],
                resolved BOOLEAN DEFAULT false,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_inventory_alerts_slug_date ON inventory_alerts(cafe_slug, alert_date)`);

        const existingOrderItemsResult = await pool.query("SELECT COUNT(*)::int AS count FROM order_items");
        const existingOrderItemsCount = existingOrderItemsResult.rows[0]?.count || 0;
        if (existingOrderItemsCount === 0) {
            const ordersResult = await pool.query("SELECT id, restaurant_id, items FROM orders ORDER BY id ASC");
            for (const order of ordersResult.rows) {
                if (!order.items) continue;

                let parsedItems;
                try {
                    if (Array.isArray(order.items)) {
                        parsedItems = order.items;
                    } else if (typeof order.items === "string") {
                        parsedItems = JSON.parse(order.items);
                    } else {
                        console.warn(`[order_items backfill] Unsupported items shape for order ${order.id}`);
                        continue;
                    }
                } catch (err) {
                    console.warn(`[order_items backfill] Failed to parse items JSON for order ${order.id}`);
                    continue;
                }

                if (!Array.isArray(parsedItems) || parsedItems.length === 0) continue;

                for (const item of parsedItems) {
                    const itemName = typeof item?.name === "string" ? item.name.trim() : "";
                    if (!itemName) {
                        console.warn(`[order_items backfill] Skipping unnamed item for order ${order.id}`);
                        continue;
                    }

                    let menuItemId = Number.isInteger(item?.menu_item_id) ? item.menu_item_id : null;
                    if (!menuItemId && Number.isInteger(item?.id)) {
                        menuItemId = item.id;
                    }
                    if (!menuItemId) {
                        const menuLookupResult = await pool.query(
                            `SELECT id FROM menus
                             WHERE restaurant_id = $1 AND LOWER(name) = LOWER($2)
                             LIMIT 1`,
                            [order.restaurant_id, itemName]
                        );
                        if (menuLookupResult.rows.length > 0) {
                            menuItemId = menuLookupResult.rows[0].id;
                        } else {
                            console.warn(`[order_items backfill] No menu match for order ${order.id}: "${itemName}"`);
                        }
                    }

                    const quantityRaw = Number(item?.quantity ?? item?.qty ?? 1);
                    const quantity = Number.isFinite(quantityRaw) && quantityRaw > 0 ? Math.round(quantityRaw) : 1;
                    const unitPriceRaw = typeof item?.price === "number"
                        ? item.price
                        : Number(String(item?.price ?? "").replace(/[^\d.]/g, ""));
                    const unitPrice = Number.isFinite(unitPriceRaw) ? unitPriceRaw : 0;

                    await pool.query(
                        `INSERT INTO order_items (order_id, menu_item_id, item_name, quantity, unit_price)
                         VALUES ($1, $2, $3, $4, $5)`,
                        [order.id, menuItemId, itemName, quantity, unitPrice]
                    );
                }
            }
            console.log("✅ order_items backfill completed");
        } else {
            console.log("ℹ️ order_items backfill skipped (table already has rows)");
        }
        console.log("✅ DB Migrations applied (restaurants, admins, orders, menus, upsell_events, customers)");

        // --- Local Database Seeding ---
        if (
            process.env.NODE_ENV !== "production"
        ) {
            // 1. Ensure a test restaurant exists
            let restRes = await pool.query(`SELECT id FROM restaurants WHERE domain = 'demo-cafe' LIMIT 1`);
            let restaurantId;
            if (restRes.rows.length === 0) {
                console.log("🌱 Seeding test restaurant...");
                const insertRes = await pool.query(
                    `INSERT INTO restaurants (name, slug, domain, whatsapp_number, max_tables, config) 
                     VALUES ('Demo Cafe', 'demo-cafe', 'demo-cafe', '', 20, '{}') RETURNING id`
                );
                restaurantId = insertRes.rows[0].id;
            } else {
                restaurantId = restRes.rows[0].id;
            }

            // 2. Ensure a test admin exists
            const adminRes = await pool.query("SELECT id FROM admins WHERE email = 'admin@demo.cafe'");
            if (adminRes.rows.length === 0) {
                const devPassword = process.env.DEV_ADMIN_PASSWORD || "admin123";
                const hashedPassword = await bcrypt.hash(devPassword, 10);
                await pool.query(
                    "INSERT INTO admins (restaurant_id, email, password_hash) VALUES ($1, $2, $3)",
                    [restaurantId, "admin@demo.cafe", hashedPassword]
                );
                console.log(`🌱 Local Dev: Admin user seeded (admin@demo.cafe / ${process.env.DEV_ADMIN_PASSWORD ? "***" : "admin123"})`);
            }

            const menuCountRes = await pool.query("SELECT COUNT(*) FROM menus");
            if (parseInt(menuCountRes.rows[0].count, 10) === 0) {
                console.log("🌱 Local Dev: menus table is empty. Seeding test data...");
                const seedItems = [
                    { name: 'Cold Coffee', price: 180, category: 'Beverages', sub_category: 'coffee', tags: ['coffee', 'cold', 'drink'], img: 'https://images.unsplash.com/photo-1578314675249-a6910f80cc4e?w=800' },
                    { name: 'Cappuccino', price: 200, category: 'Beverages', sub_category: 'coffee', tags: ['coffee', 'hot', 'drink'], img: 'https://images.unsplash.com/photo-1572442388796-11668a67e53d?w=800' },
                    { name: 'Croissant', price: 150, category: 'Food', sub_category: 'pastry', tags: ['bakery', 'pastry', 'breakfast'], img: 'https://images.unsplash.com/photo-1555507036-ab1f4038808a?w=800' },
                    { name: 'Choco Muffin', price: 120, category: 'Dessert', sub_category: 'bakery', tags: ['chocolate', 'bakery', 'sweet'], img: 'https://images.unsplash.com/photo-1606890737304-57a1ca8a5b62?w=800' },
                    { name: 'Chocolate Brownie', price: 160, category: 'Dessert', sub_category: 'bakery', tags: ['chocolate', 'bakery', 'sweet'], img: 'https://images.unsplash.com/photo-1607920591413-4ec007e70023?w=800' },
                    { name: 'Vanilla Ice Cream', price: 140, category: 'Dessert', sub_category: 'ice-cream', tags: ['frozen', 'sweet', 'vanilla'], img: 'https://images.unsplash.com/photo-1570197571499-166b36435e9f?w=800' },
                    { name: 'Paneer Tikka Wrap', price: 220, category: 'Food', sub_category: 'main', tags: ['main', 'savory', 'wrap'], img: 'https://images.unsplash.com/photo-1626700051175-6818013e1d4f?w=800' },
                    { name: 'French Fries', price: 100, category: 'Food', sub_category: 'side', tags: ['side', 'snack', 'fried'], img: 'https://images.unsplash.com/photo-1573080496219-bb080dd4f877?w=800' }
                ];

                for (const item of seedItems) {
                    await pool.query(
                        `INSERT INTO menus (restaurant_id, name, description, price, category, sub_category, tags, image_url, is_available)
                         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true)`,
                        [restaurantId, item.name, `Delicious ${item.name}`, item.price, item.category, item.sub_category, item.tags, item.img]
                    );
                }
                console.log("✅ Local Dev: Test menus seeded successfully.");
            }
        }
    } catch (err) {
        console.error("❌ DB Startup Failed:", err);
    }
})();

const app = express();
const PORT = process.env.PORT || 3001;

// --- Middleware ---
const authenticateAdmin = async (req, res, next) => {
    try {
        const token = req.headers.authorization?.split(" ")[1];
        if (!token) return res.status(401).json({ error: "Access denied" });

        const decoded = jwt.verify(token, JWT_SECRET);
        req.admin = decoded;
        next();
    } catch (err) {
        res.status(401).json({ error: "Invalid token" });
    }
};

// --- CORS Configuration ---
const ALLOWED_ORIGINS = [
    "https://orlena.talk",
    "https://app.orlena.talk",
    "https://admin.orlena.talk",
    "https://api.orlena.talk",
    "https://qr-menu-upsell.vercel.app",
    "http://localhost:5173",
    "http://localhost:5174",
];

app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (ALLOWED_ORIGINS.includes(origin) || process.env.NODE_ENV !== "production") {
        res.setHeader("Access-Control-Allow-Origin", origin || "*");
    }
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.setHeader("Access-Control-Allow-Credentials", "true");

    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
});

app.use(express.json());

// --- Admin Auth ---
app.post("/api/admin/login", async (req, res) => {
    const { email, password } = req.body;
    console.log(`[AdminLogin] Attempt for: ${email}`);
    try {
        const result = await pool.query(
            "SELECT a.*, r.domain as slug FROM admins a JOIN restaurants r ON a.restaurant_id = r.id WHERE a.email = $1",
            [email]
        );
        
        if (result.rows.length === 0) {
            console.log(`[AdminLogin] FAILED: No admin/restaurant record for ${email}`);
            return res.status(401).json({ error: "Invalid credentials" });
        }

        const admin = result.rows[0];
        const valid = await bcrypt.compare(password, admin.password_hash);
        if (!valid) {
            console.log(`[AdminLogin] FAILED: Password mismatch for ${email}`);
            return res.status(401).json({ error: "Invalid credentials" });
        }

        console.log(`[AdminLogin] SUCCESS: ${email} logged in for slug: ${admin.slug}`);
        const token = jwt.sign({ id: admin.id, restaurant_id: admin.restaurant_id, slug: admin.slug }, JWT_SECRET, { expiresIn: "24h" });
        res.json({ token, admin: { email: admin.email, slug: admin.slug } });
    } catch (err) {
        console.error(`[AdminLogin] Error: ${err.message}`);
        res.status(500).json({ error: "Login failed" });
    }
});

// --- Admin Analytics ---
app.get("/api/admin/:slug/analytics", authenticateAdmin, async (req, res) => {
    const { slug } = req.params;
    if (req.admin.slug !== slug) return res.status(403).json({ error: "Forbidden" });

    try {
        const restaurant_id = req.admin.restaurant_id;

        const orderStats = await pool.query(
            "SELECT COUNT(*) as total_orders, COALESCE(SUM(total), 0) as total_revenue FROM orders WHERE restaurant_id = $1",
            [restaurant_id]
        );

        const upsellShown = await pool.query(
            "SELECT COUNT(*) as count FROM upsell_events WHERE restaurant_slug = $1 AND event_type = 'shown'",
            [slug]
        );
        const upsellAccepted = await pool.query(
            "SELECT COUNT(*) as count, COALESCE(SUM(upsell_value), 0) as revenue FROM upsell_events WHERE restaurant_slug = $1 AND event_type = 'accepted'",
            [slug]
        );

        const topUpsells = await pool.query(
            `SELECT m.name, COUNT(*) as count, SUM(u.upsell_value) as revenue 
             FROM upsell_events u 
             JOIN menus m ON u.item_id = m.id 
             WHERE u.restaurant_slug = $1 AND u.event_type = 'accepted'
             GROUP BY m.name ORDER BY count DESC LIMIT 5`,
            [slug]
        );

        const stats = orderStats.rows[0];
        const shownCount = parseInt(upsellShown.rows[0].count);
        const acceptedCount = parseInt(upsellAccepted.rows[0].count);
        const upsellRevenue = parseFloat(upsellAccepted.rows[0].revenue);
        const totalRevenue = parseFloat(stats.total_revenue);
        const totalOrders = parseInt(stats.total_orders);

        // Ground-truth upsell revenue from orders table (upsell_value stored at order time)
        const confirmedResult = await pool.query(
            "SELECT COALESCE(SUM(upsell_value), 0) as confirmed_revenue FROM orders WHERE restaurant_id = $1 AND pairing_accepted = true AND upsell_value > 0",
            [restaurant_id]
        );
        const confirmedUpsellRevenue = parseFloat(confirmedResult.rows[0].confirmed_revenue);

        res.json({
            totalRevenue,
            totalOrders,
            aov: totalOrders > 0 ? totalRevenue / totalOrders : 0,
            upsellConversionRate: shownCount > 0 ? (acceptedCount / shownCount) * 100 : 0,
            upsellRevenue,
            confirmedUpsellRevenue,
            revenueIncreasePercent: totalRevenue > 0 ? (upsellRevenue / (totalRevenue - upsellRevenue)) * 100 : 0,
            topUpsellItems: topUpsells.rows,
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to fetch analytics" });
    }
});

const cortexRateLimits = {};
const CORTEX_CATEGORY_EMPTY_REPLIES = {
    PURCHASING: "I don't have purchase recommendations yet. Ask the Orlena team to generate today's recommendations for your cafe.",
    WASTE: "I don't see any waste logged in the last 7 days. Log waste as it happens so I can spot patterns for you.",
    FORECAST: "I don't have forecast data yet. The prediction engine needs to run first. Ask the Orlena team to generate forecasts for your cafe.",
    FOOD_COST: "I don't have enough recipe and menu data to calculate food cost yet. Add recipe mappings for your menu items first.",
    SALES: "I don't see any sales in the last 7 days. Once orders come in, I can show top items and revenue.",
    INVENTORY: "I don't have recent stock take data yet. Record a stock take so I can answer inventory questions.",
    VARIANCE: "I don't see any positive inventory variance in the last 7 days. That usually means no overuse is visible from the current stock data."
};

app.post("/api/admin/:slug/cortex/chat", authenticateAdmin, async (req, res) => {
    const { slug } = req.params;
    if (req.admin.slug !== slug) return res.status(403).json({ error: "Forbidden" });

    const message = typeof req.body?.message === "string" ? req.body.message.trim() : "";
    const rawHistory = Array.isArray(req.body?.history) ? req.body.history : [];
    if (!message) return res.status(400).json({ error: "Message is required" });

    if (isCortexRateLimited(slug)) {
        return res.status(429).json({ reply: "I'm getting too many questions right now. Try again in a minute." });
    }

    try {
        const category = classifyCortexMessage(message);
        const cafeData = await buildCortexCafeData(category, slug, req.admin.restaurant_id);

        if (!hasCortexData(category, cafeData)) {
            return res.json({ reply: CORTEX_CATEGORY_EMPTY_REPLIES[category] || "I don't have enough cafe data to answer that yet. Try asking about sales, inventory, waste, or food cost." });
        }

        const safeHistory = rawHistory
            .filter((entry) => entry && (entry.role === "user" || entry.role === "assistant") && typeof entry.content === "string")
            .map((entry) => ({
                role: entry.role,
                content: entry.content.trim().slice(0, 800)
            }))
            .filter((entry) => entry.content.length > 0)
            .slice(-10);

        const systemPrompt = `You are Orlena Cortex, the AI operations assistant for a cafe. You help cafe owners understand their business by answering questions about sales, inventory, waste, demand forecasts, and purchasing.

RULES:
- Answer ONLY using the data provided below. Do not make up numbers.
- Be specific with quantities, rupee amounts, and dates.
- Keep answers short and actionable. Max 3-4 sentences unless the owner asks for detail.
- Use INR symbol for all money amounts.
- If the data doesn't contain the answer, say so honestly and suggest what the owner can do.
- Never mention "database", "SQL", "API", "model", "LSTM", "Q-Learning", or any technical terms.
- Speak like a knowledgeable operations manager, not a robot.
- Use the owner's language style. If they're casual, be casual. If they're formal, be formal.
- Round all numbers with Math.round().

CAFE DATA:
${JSON.stringify(roundCortexNumbers(cafeData), null, 2)}`;

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);
        let completion;
        try {
            completion = await openai.chat.completions.create({
                model: "gpt-4o-mini",
                max_tokens: 220,
                temperature: 0.4,
                messages: [
                    { role: "system", content: systemPrompt },
                    ...safeHistory,
                    { role: "user", content: message }
                ]
            }, { signal: controller.signal });
        } finally {
            clearTimeout(timeout);
        }

        const reply = completion.choices?.[0]?.message?.content?.trim();
        if (!reply) throw new Error("Empty Cortex response");
        return res.json({ reply });
    } catch (err) {
        console.error("[cortex-chat] Error:", err.message);
        return res.json({ reply: "I'm having trouble thinking right now. Try again in a moment." });
    }
});

function isCortexRateLimited(slug) {
    const now = Date.now();
    const windowMs = 60 * 1000;
    const current = cortexRateLimits[slug];
    if (!current || current.resetAt <= now) {
        cortexRateLimits[slug] = { count: 1, resetAt: now + windowMs };
        return false;
    }
    current.count += 1;
    return current.count > 20;
}

function classifyCortexMessage(message) {
    const normalized = String(message || "").toLowerCase();
    const checks = [
        ["PURCHASING", ["what should i order", "order", "buy", "purchase"]],
        ["WASTE", ["waste", "expiring", "throw", "spoil"]],
        ["FORECAST", ["forecast", "predict", "sell", "tomorrow", "how many"]],
        ["FOOD_COST", ["food cost", "cost", "margin", "profit"]],
        ["SALES", ["sales", "revenue", "top", "best selling", "popular"]],
        ["INVENTORY", ["inventory", "stock", "how much", "left", "remaining"]],
        ["VARIANCE", ["variance", "gap", "leak", "overuse"]]
    ];

    for (const [category, keywords] of checks) {
        if (keywords.some((keyword) => normalized.includes(keyword))) return category;
    }
    return "GENERAL";
}

async function buildCortexCafeData(category, slug, restaurantId) {
    if (category === "PURCHASING") {
        const [recommendations, alerts] = await Promise.all([
            pool.query(
                `SELECT pr.*, i.name as ingredient_name, i.unit
                 FROM purchase_recommendations pr
                 JOIN ingredients i ON i.id = pr.ingredient_id
                 WHERE pr.cafe_slug = $1
                 AND pr.recommendation_date = CURRENT_DATE
                 ORDER BY pr.status, pr.estimated_cost DESC`,
                [slug]
            ),
            pool.query(
                `SELECT ia.*, i.name as ingredient_name
                 FROM inventory_alerts ia
                 JOIN ingredients i ON i.id = ia.ingredient_id
                 WHERE ia.cafe_slug = $1
                 AND ia.alert_date = CURRENT_DATE
                 AND ia.resolved = false`,
                [slug]
            )
        ]);
        return { category, purchase_recommendations: recommendations.rows, inventory_alerts: alerts.rows };
    }

    if (category === "WASTE") {
        const [logs, summary] = await Promise.all([
            pool.query(
                `SELECT wl.*, i.name as ingredient_name
                 FROM waste_log wl
                 JOIN ingredients i ON i.id = wl.ingredient_id
                 WHERE wl.cafe_slug = $1
                 AND wl.logged_at >= NOW() - INTERVAL '7 days'
                 ORDER BY wl.cost_value DESC
                 LIMIT 20`,
                [slug]
            ),
            pool.query(
                `SELECT
                  SUM(cost_value) as total_waste_cost,
                  reason,
                  SUM(cost_value) as reason_cost
                 FROM waste_log
                 WHERE cafe_slug = $1 AND logged_at >= NOW() - INTERVAL '7 days'
                 GROUP BY reason
                 ORDER BY reason_cost DESC`,
                [slug]
            )
        ]);
        return { category, recent_waste: logs.rows, waste_summary: summary.rows };
    }

    if (category === "FORECAST") {
        const result = await pool.query(
            `SELECT df.*, m.name as item_name
             FROM demand_forecasts df
             JOIN menus m ON m.id = df.menu_item_id
             WHERE df.cafe_slug = $1
             AND df.forecast_date >= CURRENT_DATE
             AND df.forecast_date <= CURRENT_DATE + INTERVAL '7 days'
             ORDER BY df.forecast_date, df.predicted_quantity DESC`,
            [slug]
        );
        return { category, demand_forecasts: result.rows };
    }

    if (category === "FOOD_COST") {
        const result = await pool.query(
            `SELECT
              m.name,
              m.price as selling_price,
              COALESCE(SUM(ri.quantity_used * i.cost_per_unit), 0) as food_cost
             FROM menus m
             LEFT JOIN recipe_ingredients ri ON ri.menu_item_id = m.id
             LEFT JOIN ingredients i ON i.id = ri.ingredient_id
             WHERE m.restaurant_id = $1
             GROUP BY m.id, m.name, m.price
             ORDER BY (COALESCE(SUM(ri.quantity_used * i.cost_per_unit), 0) / NULLIF(m.price, 0)) DESC`,
            [restaurantId]
        );
        return { category, food_costs: result.rows };
    }

    if (category === "SALES") {
        const result = await pool.query(
            `SELECT
              oi.item_name,
              COUNT(*) as times_ordered,
              SUM(oi.quantity) as total_quantity,
              SUM(oi.unit_price * oi.quantity) as total_revenue
             FROM order_items oi
             JOIN orders o ON o.id = oi.order_id
             WHERE o.restaurant_id = $1
             AND o.created_at >= NOW() - INTERVAL '7 days'
             GROUP BY oi.item_name
             ORDER BY total_quantity DESC
             LIMIT 15`,
            [restaurantId]
        );
        return { category, sales: result.rows };
    }

    if (category === "INVENTORY") {
        const result = await pool.query(
            `SELECT i.name, i.unit, i.shelf_life_hours, i.cost_per_unit,
              inv.quantity_on_hand, inv.recorded_at
             FROM ingredients i
             JOIN LATERAL (
              SELECT quantity_on_hand, recorded_at
              FROM inventory_snapshots
              WHERE ingredient_id = i.id AND cafe_slug = $1
              ORDER BY recorded_at DESC LIMIT 1
             ) inv ON true
             WHERE i.cafe_slug = $1 AND i.is_active = true
             ORDER BY i.name`,
            [slug]
        );
        return { category, inventory: result.rows };
    }

    if (category === "VARIANCE") {
        const variance = await buildInventoryVariance(restaurantId, slug, 7);
        return { category, ...variance };
    }

    const [ordersToday, pendingPurchases, activeAlerts] = await Promise.all([
        pool.query(
            `SELECT COUNT(*)::int as total_orders, COALESCE(SUM(total), 0) as total_revenue
             FROM orders
             WHERE restaurant_id = $1 AND created_at >= CURRENT_DATE`,
            [restaurantId]
        ),
        pool.query(
            `SELECT COUNT(*)::int as pending_purchase_recommendations
             FROM purchase_recommendations
             WHERE cafe_slug = $1 AND recommendation_date = CURRENT_DATE AND status = 'pending'`,
            [slug]
        ),
        pool.query(
            `SELECT COUNT(*)::int as active_waste_alerts
             FROM inventory_alerts
             WHERE cafe_slug = $1 AND alert_date = CURRENT_DATE AND resolved = false`,
            [slug]
        )
    ]);

    return {
        category,
        today: ordersToday.rows[0],
        pending_purchase_recommendations: pendingPurchases.rows[0]?.pending_purchase_recommendations || 0,
        active_waste_alerts: activeAlerts.rows[0]?.active_waste_alerts || 0
    };
}

function hasCortexData(category, data) {
    if (category === "GENERAL") return true;
    if (category === "PURCHASING") return data.purchase_recommendations.length > 0 || data.inventory_alerts.length > 0;
    if (category === "WASTE") return data.recent_waste.length > 0 || data.waste_summary.length > 0;
    if (category === "FORECAST") return data.demand_forecasts.length > 0;
    if (category === "FOOD_COST") return data.food_costs.length > 0;
    if (category === "SALES") return data.sales.length > 0;
    if (category === "INVENTORY") return data.inventory.length > 0;
    if (category === "VARIANCE") return data.items.length > 0;
    return true;
}

function roundCortexNumbers(value) {
    if (Array.isArray(value)) return value.map(roundCortexNumbers);
    if (value && typeof value === "object") {
        return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, roundCortexNumbers(entry)]));
    }
    if (typeof value === "number") return Math.round(value);
    if (typeof value === "string" && value.trim() !== "" && /^-?\d+(\.\d+)?$/.test(value.trim())) {
        return Math.round(Number(value));
    }
    return value;
}

// --- Admin Orders ---
app.get("/api/admin/:slug/orders", authenticateAdmin, async (req, res) => {
    const { slug } = req.params;
    if (req.admin.slug !== slug) return res.status(403).json({ error: "Forbidden" });

    try {
        const result = await pool.query(
            "SELECT * FROM orders WHERE restaurant_id = $1 ORDER BY created_at DESC",
            [req.admin.restaurant_id]
        );
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: "Failed to fetch orders" });
    }
});

app.put("/api/admin/:slug/orders/:id/status", authenticateAdmin, async (req, res) => {
    const { status } = req.body;
    try {
        await pool.query(
            "UPDATE orders SET status = $1 WHERE id = $2 AND restaurant_id = $3",
            [status, req.params.id, req.admin.restaurant_id]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: "Failed to update order status" });
    }
});

// --- Admin Menu Management ---
app.post("/api/admin/:slug/menu", authenticateAdmin, async (req, res) => {
    const { name, description, price, category, image_url } = req.body;
    try {
        const result = await pool.query(
            "INSERT INTO menus (restaurant_id, name, description, price, category, image_url) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *",
            [req.admin.restaurant_id, name, description, price, category, image_url]
        );
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: "Failed to add menu item" });
    }
});

app.put("/api/admin/:slug/menu/:id", authenticateAdmin, async (req, res) => {
    const { name, description, price, category, image_url } = req.body;
    const is_available = req.body.is_available !== undefined ? req.body.is_available : true;
    try {
        console.log(`[admin] Updating menu item ${req.params.id} for slug ${req.params.slug}:`, {
            name: req.body.name,
            price: req.body.price,
            category: req.body.category,
            restaurant_id_in_body: req.body.restaurant_id || "NOT SENT (correct)"
        });
        const result = await pool.query(
            `UPDATE menus SET name=$1, description=$2, price=$3, category=$4, image_url=$5, is_available=$6 
             WHERE id=$7 AND restaurant_id=$8 RETURNING *`,
            [name, description, price, category, image_url, is_available, req.params.id, req.admin.restaurant_id]
        );
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: "Failed to update menu item" });
    }
});

app.delete("/api/admin/:slug/menu/:id", authenticateAdmin, async (req, res) => {
    try {
        console.log(`[admin] Deleting menu item ${req.params.id} for slug ${req.params.slug}`);
        await pool.query("DELETE FROM menus WHERE id=$1 AND restaurant_id=$2", [req.params.id, req.admin.restaurant_id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: "Failed to delete menu item" });
    }
});

// --- Admin Ingredients ---
app.get("/api/admin/:slug/ingredients", authenticateAdmin, async (req, res) => {
    const { slug } = req.params;
    if (req.admin.slug !== slug) return res.status(403).json({ error: "Forbidden" });
    try {
        const result = await pool.query(
            `SELECT * FROM ingredients
             WHERE cafe_slug = $1 AND is_active = true
             ORDER BY name ASC`,
            [slug]
        );
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: "Failed to fetch ingredients" });
    }
});

app.post("/api/admin/:slug/ingredients", authenticateAdmin, async (req, res) => {
    const { slug } = req.params;
    if (req.admin.slug !== slug) return res.status(403).json({ error: "Forbidden" });
    const {
        name,
        category,
        unit,
        cost_per_unit,
        shelf_life_hours,
        storage_type,
        supplier_name,
        min_order_quantity
    } = req.body;
    try {
        const result = await pool.query(
            `INSERT INTO ingredients (
                cafe_slug, name, category, unit, cost_per_unit, shelf_life_hours, storage_type, supplier_name, min_order_quantity
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
            [
                slug,
                name,
                category || null,
                unit,
                cost_per_unit,
                shelf_life_hours || null,
                storage_type || null,
                supplier_name || null,
                min_order_quantity || null
            ]
        );
        res.json(result.rows[0]);
    } catch (err) {
        if (err.code === "23505") {
            return res.status(409).json({ error: "Ingredient with this name already exists" });
        }
        res.status(500).json({ error: "Failed to create ingredient" });
    }
});

app.put("/api/admin/:slug/ingredients/:id", authenticateAdmin, async (req, res) => {
    const { slug, id } = req.params;
    if (req.admin.slug !== slug) return res.status(403).json({ error: "Forbidden" });
    const {
        name,
        category,
        unit,
        cost_per_unit,
        shelf_life_hours,
        storage_type,
        supplier_name,
        min_order_quantity,
        is_active
    } = req.body;
    try {
        const result = await pool.query(
            `UPDATE ingredients SET
                name = $1,
                category = $2,
                unit = $3,
                cost_per_unit = $4,
                shelf_life_hours = $5,
                storage_type = $6,
                supplier_name = $7,
                min_order_quantity = $8,
                is_active = COALESCE($9, is_active),
                updated_at = CURRENT_TIMESTAMP
             WHERE id = $10 AND cafe_slug = $11
             RETURNING *`,
            [
                name,
                category || null,
                unit,
                cost_per_unit,
                shelf_life_hours || null,
                storage_type || null,
                supplier_name || null,
                min_order_quantity || null,
                is_active,
                id,
                slug
            ]
        );
        if (result.rows.length === 0) return res.status(404).json({ error: "Ingredient not found" });
        res.json(result.rows[0]);
    } catch (err) {
        if (err.code === "23505") {
            return res.status(409).json({ error: "Ingredient with this name already exists" });
        }
        res.status(500).json({ error: "Failed to update ingredient" });
    }
});

app.delete("/api/admin/:slug/ingredients/:id", authenticateAdmin, async (req, res) => {
    const { slug, id } = req.params;
    if (req.admin.slug !== slug) return res.status(403).json({ error: "Forbidden" });
    try {
        await pool.query(
            `UPDATE ingredients SET is_active = false, updated_at = CURRENT_TIMESTAMP
             WHERE id = $1 AND cafe_slug = $2`,
            [id, slug]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: "Failed to delete ingredient" });
    }
});

// --- Admin Recipe Mapping ---
app.get("/api/admin/:slug/menu-items/:menuItemId/recipe", authenticateAdmin, async (req, res) => {
    const { slug, menuItemId } = req.params;
    if (req.admin.slug !== slug) return res.status(403).json({ error: "Forbidden" });
    try {
        const menuItemResult = await pool.query(
            "SELECT id, name, price FROM menus WHERE id = $1 AND restaurant_id = $2",
            [menuItemId, req.admin.restaurant_id]
        );
        if (menuItemResult.rows.length === 0) return res.status(404).json({ error: "Menu item not found" });

        const recipeResult = await pool.query(
            `SELECT
                ri.id,
                ri.menu_item_id,
                ri.ingredient_id,
                ri.quantity_used,
                ri.unit,
                ri.created_at,
                i.name AS ingredient_name,
                i.category AS ingredient_category,
                i.cost_per_unit
             FROM recipe_ingredients ri
             JOIN ingredients i ON i.id = ri.ingredient_id
             WHERE ri.menu_item_id = $1 AND i.cafe_slug = $2 AND i.is_active = true
             ORDER BY i.name ASC`,
            [menuItemId, slug]
        );
        res.json({
            menu_item: menuItemResult.rows[0],
            recipe: recipeResult.rows
        });
    } catch (err) {
        res.status(500).json({ error: "Failed to fetch recipe" });
    }
});

app.post("/api/admin/:slug/menu-items/:menuItemId/recipe", authenticateAdmin, async (req, res) => {
    const { slug, menuItemId } = req.params;
    if (req.admin.slug !== slug) return res.status(403).json({ error: "Forbidden" });
    const { ingredient_id, quantity_used, unit } = req.body;
    try {
        const ingredientResult = await pool.query(
            "SELECT id FROM ingredients WHERE id = $1 AND cafe_slug = $2 AND is_active = true",
            [ingredient_id, slug]
        );
        if (ingredientResult.rows.length === 0) return res.status(404).json({ error: "Ingredient not found" });

        const menuItemResult = await pool.query(
            "SELECT id FROM menus WHERE id = $1 AND restaurant_id = $2",
            [menuItemId, req.admin.restaurant_id]
        );
        if (menuItemResult.rows.length === 0) return res.status(404).json({ error: "Menu item not found" });

        const result = await pool.query(
            `INSERT INTO recipe_ingredients (menu_item_id, ingredient_id, quantity_used, unit)
             VALUES ($1, $2, $3, $4)
             RETURNING *`,
            [menuItemId, ingredient_id, quantity_used, unit]
        );
        res.json(result.rows[0]);
    } catch (err) {
        if (err.code === "23505") {
            return res.status(409).json({ error: "Ingredient already mapped to this menu item" });
        }
        res.status(500).json({ error: "Failed to add recipe ingredient" });
    }
});

app.put("/api/admin/:slug/recipe-ingredients/:id", authenticateAdmin, async (req, res) => {
    const { slug, id } = req.params;
    if (req.admin.slug !== slug) return res.status(403).json({ error: "Forbidden" });
    const { quantity_used, unit } = req.body;
    try {
        const result = await pool.query(
            `UPDATE recipe_ingredients ri
             SET quantity_used = $1, unit = $2
             FROM ingredients i, menus m
             WHERE ri.id = $3
               AND i.id = ri.ingredient_id
               AND i.cafe_slug = $4
               AND m.id = ri.menu_item_id
               AND m.restaurant_id = $5
             RETURNING ri.*`,
            [quantity_used, unit, id, slug, req.admin.restaurant_id]
        );
        if (result.rows.length === 0) return res.status(404).json({ error: "Recipe ingredient not found" });
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: "Failed to update recipe ingredient" });
    }
});

app.delete("/api/admin/:slug/recipe-ingredients/:id", authenticateAdmin, async (req, res) => {
    const { slug, id } = req.params;
    if (req.admin.slug !== slug) return res.status(403).json({ error: "Forbidden" });
    try {
        await pool.query(
            `DELETE FROM recipe_ingredients ri
             USING ingredients i, menus m
             WHERE ri.id = $1
               AND i.id = ri.ingredient_id
               AND i.cafe_slug = $2
               AND m.id = ri.menu_item_id
               AND m.restaurant_id = $3`,
            [id, slug, req.admin.restaurant_id]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: "Failed to remove recipe ingredient" });
    }
});

app.get("/api/admin/:slug/menu-items/food-cost", authenticateAdmin, async (req, res) => {
    const { slug } = req.params;
    if (req.admin.slug !== slug) return res.status(403).json({ error: "Forbidden" });
    try {
        const result = await pool.query(
            `SELECT
                m.id,
                m.name,
                m.price,
                COALESCE(SUM(i.cost_per_unit * ri.quantity_used), 0) AS food_cost
             FROM menus m
             LEFT JOIN recipe_ingredients ri ON ri.menu_item_id = m.id
             LEFT JOIN ingredients i ON i.id = ri.ingredient_id AND i.is_active = true AND i.cafe_slug = $1
             WHERE m.restaurant_id = $2
             GROUP BY m.id, m.name, m.price
             ORDER BY m.name ASC`,
            [slug, req.admin.restaurant_id]
        );

        const rows = result.rows.map((row) => {
            const sellingPrice = Number(row.price) || 0;
            const foodCost = Number(row.food_cost) || 0;
            const foodCostPercentage = sellingPrice > 0 ? (foodCost / sellingPrice) * 100 : 0;
            return {
                id: row.id,
                name: row.name,
                selling_price: Math.round(sellingPrice),
                food_cost: Math.round(foodCost),
                food_cost_percentage: Math.round(foodCostPercentage)
            };
        });
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: "Failed to fetch food cost" });
    }
});

app.get("/api/admin/:slug/inventory", authenticateAdmin, async (req, res) => {
    const { slug } = req.params;
    if (req.admin.slug !== slug) return res.status(403).json({ error: "Forbidden" });
    try {
        const result = await pool.query(
            `SELECT
                i.id AS ingredient_id,
                i.name AS ingredient_name,
                i.category,
                i.unit,
                latest.quantity_on_hand,
                latest.recorded_at,
                latest.recorded_by
             FROM ingredients i
             LEFT JOIN LATERAL (
                SELECT s.quantity_on_hand, s.recorded_at, s.recorded_by
                FROM inventory_snapshots s
                WHERE s.ingredient_id = i.id AND s.cafe_slug = $1
                ORDER BY s.recorded_at DESC
                LIMIT 1
             ) latest ON true
             WHERE i.cafe_slug = $1 AND i.is_active = true
             ORDER BY i.name ASC`,
            [slug]
        );
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: "Failed to fetch inventory snapshots" });
    }
});

app.get("/api/admin/:slug/inventory/history", authenticateAdmin, async (req, res) => {
    const { slug } = req.params;
    if (req.admin.slug !== slug) return res.status(403).json({ error: "Forbidden" });
    const { ingredient_id } = req.query;
    const daysRaw = Number(req.query.days);
    const days = Number.isFinite(daysRaw) && daysRaw > 0 ? Math.round(daysRaw) : 7;
    if (!ingredient_id || typeof ingredient_id !== "string") {
        return res.status(400).json({ error: "ingredient_id is required" });
    }
    try {
        const result = await pool.query(
            `SELECT id, ingredient_id, quantity_on_hand, recorded_at, recorded_by
             FROM inventory_snapshots
             WHERE cafe_slug = $1
               AND ingredient_id = $2
               AND recorded_at >= NOW() - (($3::text || ' days')::interval)
             ORDER BY recorded_at DESC`,
            [slug, ingredient_id, days]
        );
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: "Failed to fetch inventory history" });
    }
});

app.post("/api/admin/:slug/inventory", authenticateAdmin, async (req, res) => {
    const { slug } = req.params;
    if (req.admin.slug !== slug) return res.status(403).json({ error: "Forbidden" });
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    const recordedBy = req.body?.recorded_by || null;
    if (items.length === 0) return res.status(400).json({ error: "items are required" });
    try {
        await pool.query("BEGIN");
        for (const item of items) {
            const ingredientId = item?.ingredient_id;
            const quantityOnHand = Number(item?.quantity_on_hand);
            if (!ingredientId || !Number.isFinite(quantityOnHand)) continue;
            await pool.query(
                `INSERT INTO inventory_snapshots (cafe_slug, ingredient_id, quantity_on_hand, recorded_by)
                 VALUES ($1, $2, $3, $4)`,
                [slug, ingredientId, quantityOnHand, recordedBy]
            );
        }
        await pool.query("COMMIT");
        res.json({ success: true });
    } catch (err) {
        await pool.query("ROLLBACK");
        res.status(500).json({ error: "Failed to record inventory stock take" });
    }
});

app.get("/api/admin/:slug/waste", authenticateAdmin, async (req, res) => {
    const { slug } = req.params;
    if (req.admin.slug !== slug) return res.status(403).json({ error: "Forbidden" });
    const daysRaw = Number(req.query.days);
    const days = Number.isFinite(daysRaw) && daysRaw > 0 ? Math.round(daysRaw) : 7;
    try {
        const result = await pool.query(
            `SELECT
                w.id,
                w.ingredient_id,
                i.name AS ingredient_name,
                w.quantity_wasted,
                w.reason,
                w.cost_value,
                w.notes,
                w.logged_at,
                w.logged_by
             FROM waste_log w
             JOIN ingredients i ON i.id = w.ingredient_id
             WHERE w.cafe_slug = $1
               AND w.logged_at >= NOW() - (($2::text || ' days')::interval)
             ORDER BY w.logged_at DESC`,
            [slug, days]
        );
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: "Failed to fetch waste logs" });
    }
});

app.post("/api/admin/:slug/waste", authenticateAdmin, async (req, res) => {
    const { slug } = req.params;
    if (req.admin.slug !== slug) return res.status(403).json({ error: "Forbidden" });
    const { ingredient_id, quantity_wasted, reason, notes, logged_by } = req.body;
    const validReasons = new Set(["expired", "spoiled", "overprepped", "dropped", "plate_waste", "other"]);
    if (!validReasons.has(reason)) return res.status(400).json({ error: "Invalid reason" });
    try {
        const ingredientResult = await pool.query(
            `SELECT cost_per_unit FROM ingredients
             WHERE id = $1 AND cafe_slug = $2 AND is_active = true`,
            [ingredient_id, slug]
        );
        if (ingredientResult.rows.length === 0) return res.status(404).json({ error: "Ingredient not found" });
        const quantityWasted = Number(quantity_wasted);
        if (!Number.isFinite(quantityWasted) || quantityWasted <= 0) {
            return res.status(400).json({ error: "quantity_wasted must be positive" });
        }
        const costPerUnit = Number(ingredientResult.rows[0].cost_per_unit) || 0;
        const costValue = Math.round(quantityWasted * costPerUnit);
        const result = await pool.query(
            `INSERT INTO waste_log (
                cafe_slug, ingredient_id, quantity_wasted, reason, cost_value, notes, logged_by
             ) VALUES ($1, $2, $3, $4, $5, $6, $7)
             RETURNING *`,
            [slug, ingredient_id, quantityWasted, reason, costValue, notes || null, logged_by || null]
        );
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: "Failed to log waste event" });
    }
});

app.get("/api/admin/:slug/waste/summary", authenticateAdmin, async (req, res) => {
    const { slug } = req.params;
    if (req.admin.slug !== slug) return res.status(403).json({ error: "Forbidden" });
    const daysRaw = Number(req.query.days);
    const days = Number.isFinite(daysRaw) && daysRaw > 0 ? Math.round(daysRaw) : 7;
    try {
        const totalsResult = await pool.query(
            `SELECT COALESCE(SUM(cost_value), 0) AS total_waste_cost
             FROM waste_log
             WHERE cafe_slug = $1
               AND logged_at >= NOW() - (($2::text || ' days')::interval)`,
            [slug, days]
        );
        const totalWasteCost = Math.round(Number(totalsResult.rows[0].total_waste_cost) || 0);

        const byReasonResult = await pool.query(
            `SELECT reason, COALESCE(SUM(cost_value), 0) AS total_cost
             FROM waste_log
             WHERE cafe_slug = $1
               AND logged_at >= NOW() - (($2::text || ' days')::interval)
             GROUP BY reason
             ORDER BY total_cost DESC`,
            [slug, days]
        );

        const topIngredientsResult = await pool.query(
            `SELECT
                i.name AS ingredient_name,
                COALESCE(SUM(w.quantity_wasted), 0) AS total_quantity,
                COALESCE(SUM(w.cost_value), 0) AS total_cost
             FROM waste_log w
             JOIN ingredients i ON i.id = w.ingredient_id
             WHERE w.cafe_slug = $1
               AND w.logged_at >= NOW() - (($2::text || ' days')::interval)
             GROUP BY i.name
             ORDER BY total_cost DESC
             LIMIT 5`,
            [slug, days]
        );

        const wasteByReason = byReasonResult.rows.map((row) => {
            const totalCost = Math.round(Number(row.total_cost) || 0);
            return {
                reason: row.reason,
                total_cost: totalCost,
                percentage_of_total: totalWasteCost > 0 ? Math.round((totalCost / totalWasteCost) * 100) : 0
            };
        });

        const topWastedIngredients = topIngredientsResult.rows.map((row) => ({
            ingredient_name: row.ingredient_name,
            total_quantity: Math.round(Number(row.total_quantity) || 0),
            total_cost: Math.round(Number(row.total_cost) || 0)
        }));

        res.json({
            total_waste_cost: totalWasteCost,
            waste_by_reason: wasteByReason,
            top_wasted_ingredients: topWastedIngredients
        });
    } catch (err) {
        res.status(500).json({ error: "Failed to fetch waste summary" });
    }
});

async function buildInventoryVariance(restaurantId, slug, days) {
    const inventoryTableCheck = await pool.query(`SELECT to_regclass('public.inventory_snapshots') AS table_name`);
    if (!inventoryTableCheck.rows[0]?.table_name) {
        return { days, total_variance_cost: 0, items: [] };
    }

    const varianceResult = await pool.query(
        `WITH theoretical_usage AS (
            SELECT
                ri.ingredient_id,
                COALESCE(SUM(ri.quantity_used * oi.quantity), 0) AS theoretical_usage
            FROM order_items oi
            JOIN orders o ON o.id = oi.order_id
            JOIN recipe_ingredients ri ON ri.menu_item_id = oi.menu_item_id
            WHERE o.restaurant_id = $1
              AND o.created_at >= NOW() - (($2::text || ' days')::interval)
            GROUP BY ri.ingredient_id
        ),
        snapshots_in_window AS (
            SELECT
                s.ingredient_id,
                s.quantity_on_hand,
                s.recorded_at,
                ROW_NUMBER() OVER (PARTITION BY s.ingredient_id ORDER BY s.recorded_at ASC) AS first_rank,
                ROW_NUMBER() OVER (PARTITION BY s.ingredient_id ORDER BY s.recorded_at DESC) AS last_rank
            FROM inventory_snapshots s
            WHERE s.cafe_slug = $3
              AND s.recorded_at >= NOW() - (($2::text || ' days')::interval)
        ),
        snapshot_delta AS (
            SELECT
                f.ingredient_id,
                (f.quantity_on_hand - l.quantity_on_hand) AS actual_usage
            FROM snapshots_in_window f
            JOIN snapshots_in_window l
              ON l.ingredient_id = f.ingredient_id
            WHERE f.first_rank = 1 AND l.last_rank = 1
        )
        SELECT
            i.id AS ingredient_id,
            i.name AS ingredient_name,
            COALESCE(t.theoretical_usage, 0) AS theoretical_usage,
            COALESCE(s.actual_usage, 0) AS actual_usage,
            (COALESCE(s.actual_usage, 0) - COALESCE(t.theoretical_usage, 0)) AS variance,
            i.cost_per_unit
        FROM ingredients i
        LEFT JOIN theoretical_usage t ON t.ingredient_id = i.id
        LEFT JOIN snapshot_delta s ON s.ingredient_id = i.id
        WHERE i.cafe_slug = $3
          AND i.is_active = true`,
        [restaurantId, days, slug]
    );

    const items = varianceResult.rows
        .map((row) => {
            const theoreticalUsage = Number(row.theoretical_usage) || 0;
            const actualUsage = Number(row.actual_usage) || 0;
            const variance = actualUsage - theoreticalUsage;
            const varianceCost = Math.round(variance * (Number(row.cost_per_unit) || 0));
            return {
                ingredient_id: row.ingredient_id,
                ingredient_name: row.ingredient_name,
                theoretical_usage: Math.round(theoreticalUsage),
                actual_usage: Math.round(actualUsage),
                variance: Math.round(variance),
                variance_cost: varianceCost
            };
        })
        .filter((row) => row.variance > 0);

    const totalVarianceCost = Math.round(items.reduce((sum, row) => sum + row.variance_cost, 0));
    return { days, total_variance_cost: totalVarianceCost, items };
}

app.get("/api/admin/:slug/inventory/variance", authenticateAdmin, async (req, res) => {
    const { slug } = req.params;
    if (req.admin.slug !== slug) return res.status(403).json({ error: "Forbidden" });
    const daysRaw = Number(req.query.days);
    const days = Number.isFinite(daysRaw) && daysRaw > 0 ? Math.round(daysRaw) : 7;

    try {
        const variance = await buildInventoryVariance(req.admin.restaurant_id, slug, days);
        res.json(variance);
    } catch (err) {
        res.status(500).json({ error: "Failed to fetch inventory variance" });
    }
});

// --- OpenAI Client ---
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const { generateUpsell } = require("./aiUpsellEngine");

// --- Verified Customer Cache (24 hours in-memory) ---
const verifiedCustomerCache = {}; // { [phone_number]: { verified: true, expires_at: timestamp } }

// Cleanup expired cache entries periodically (every 30 minutes)
setInterval(() => {
    const now = Date.now();
    for (const phone in verifiedCustomerCache) {
        if (verifiedCustomerCache[phone].expires_at < now) {
            delete verifiedCustomerCache[phone];
        }
    }
}, 30 * 60 * 1000);

// --- POST /api/customer-login ---
// Called after successful Firebase phone verification on the frontend.
// Upserts the customer in Postgres and returns a session token.
app.post("/api/customer-login", async (req, res) => {
    try {
        const { phone_number } = req.body;
        if (!phone_number) {
            return res.status(400).json({ success: false, error: "Phone number is required" });
        }

        // Validate phone number format (must start with + and have at least 10 digits)
        const digitsOnly = phone_number.replace(/\D/g, "");
        if (!phone_number.startsWith("+") || digitsOnly.length < 10) {
            return res.status(400).json({ success: false, error: "Invalid phone number format" });
        }

        // Check in-memory cache — skip DB write if recently verified
        const cached = verifiedCustomerCache[phone_number];
        if (cached && cached.expires_at > Date.now()) {
            console.log(`[customer-login] Cache hit for ${phone_number}`);
            const token = jwt.sign({ phone: phone_number }, JWT_SECRET, { expiresIn: "24h" });
            return res.json({
                success: true,
                token,
                expires_in: 86400,
                cached: true,
            });
        }

        // Upsert customer in Postgres
        await pool.query(
            `INSERT INTO customers (phone_number, last_verified_at)
             VALUES ($1, NOW())
             ON CONFLICT (phone_number)
             DO UPDATE SET last_verified_at = NOW()`,
            [phone_number]
        );

        // Update cache
        verifiedCustomerCache[phone_number] = {
            verified: true,
            expires_at: Date.now() + 24 * 60 * 60 * 1000, // 24 hours
        };

        const token = jwt.sign({ phone: phone_number }, JWT_SECRET, { expiresIn: "24h" });
        console.log(`[customer-login] Verified and cached ${phone_number}`);

        res.json({
            success: true,
            token,
            expires_in: 86400,
        });
    } catch (err) {
        console.error("[customer-login] Error:", err.message);
        res.status(500).json({ success: false, error: "Login failed" });
    }
});

// --- Standard Client Routes ---
app.get("/api/restaurant/:id", async (req, res) => {
    try {
        const result = await pool.query("SELECT name FROM restaurants WHERE domain = $1", [req.params.id]);
        if (result.rows.length === 0) return res.status(404).json({ error: "Restaurant not found" });
        // max_tables column may not exist in production; default to 20
        res.json({ name: result.rows[0].name, max_tables: 20 });
    } catch (err) {
        console.error("[restaurant/:id] Error:", err.message);
        res.status(500).json({ error: "Failed to fetch restaurant" });
    }
});

app.get("/api/:slug/menu", async (req, res) => {
    try {
        const resResult = await pool.query("SELECT id FROM restaurants WHERE domain = $1", [req.params.slug]);
        if (resResult.rows.length === 0) return res.status(404).json({ error: "Restaurant not found" });
        const menuResult = await pool.query(
            "SELECT id, name, description, price, category, sub_category, tags, image_url FROM menus WHERE restaurant_id = $1 AND is_available = true ORDER BY category, name",
            [resResult.rows[0].id]
        );
        res.json(menuResult.rows);
    } catch (err) {
        res.status(500).json({ error: "Menu fetch failed" });
    }
});

app.post("/api/menu/:slug/chat", async (req, res) => {
    try {
        const slug = req.params.slug;
        const message = typeof req.body?.message === "string" ? req.body.message.trim() : "";
        const rawHistory = Array.isArray(req.body?.history) ? req.body.history : [];

        if (!message) {
            return res.status(400).json({ error: "Message is required" });
        }

        const restaurantResult = await pool.query(
            "SELECT id, name FROM restaurants WHERE domain = $1 LIMIT 1",
            [slug]
        );

        if (restaurantResult.rows.length === 0) {
            return res.status(404).json({ error: "Restaurant not found" });
        }

        const restaurant = restaurantResult.rows[0];
        const menuResult = await pool.query(
            "SELECT id, name, description, price, category, sub_category, tags, image_url, is_available FROM menus WHERE restaurant_id = $1 ORDER BY category, name",
            [restaurant.id]
        );

        const safeHistory = rawHistory
            .filter((entry) => entry && (entry.role === "user" || entry.role === "assistant") && typeof entry.content === "string")
            .map((entry) => ({
                role: entry.role,
                content: entry.content.trim().slice(0, 500)
            }))
            .filter((entry) => entry.content.length > 0)
            .slice(-12);

        const personality = slug === "cafe-mizuru"
            ? "You are calm, minimal, and poetic. Inspired by Japanese simplicity. You say less and mean more. You never oversell. You describe food the way a haiku describes weather."
            : "You are warm, friendly, and enthusiastic. You love good food and it shows. You talk like someone who has tried everything on the menu and has a genuine favourite.";

        const systemPrompt = `You are the AI menu assistant for ${restaurant.name}.

You know every dish on this menu. You speak like a close friend who happens to know the kitchen inside out. You are warm, opinionated, and specific.

THE FULL MENU:
${JSON.stringify(menuResult.rows)}

RULES:
1. Every response must be 1-2 sentences maximum. Never more.
2. Never list more than 2 items in a single response. Pick the best ones, not all of them.
3. When the customer shows interest in a dish or orders something, suggest exactly ONE complementary item as a natural aside. Example: "That's a great pick. The hojicha latte goes surprisingly well with it." Do NOT frame it as an upsell. Frame it as insider knowledge.
4. Sound like a sharp friend who works at the cafe, never like a chatbot. No bullet points. No lists. No "Here are some options:". Be direct, casual, and specific. Say "the pesto pasta is legit" not "the pesto pasta is a delicious option."
5. Never say "I'm an AI", "as an AI assistant", or anything that breaks the illusion. You are the menu assistant.
6. Never invent dishes that are not on the menu.
7. If asked about allergens or dietary info, answer based only on what the menu data contains. If unsure, say "Let me check with the kitchen -- best to ask your server about that one."
8. If asked something unrelated to food, menu, or the cafe, keep it light and steer back naturally. Example: "Hm, that's above my pay grade! But I can definitely help with what to eat. What sounds good?"
9. Use the customer's language. If they text casually, be casual. If they ask formally, match it.
10. Never repeat the same phrase twice in a conversation. If you already said "great choice" once, use something different next time. Vary your language naturally.

ORDER PLACEMENT:
- You CAN help customers place orders. This is a core part of your job.
- When a customer asks to order something, confirm the items and ask "Shall I place that order for you?"
- When the customer confirms (says yes, sure, go ahead, bring it on, place it, do it, order it, etc.), include this EXACT tag at the END of your response:
  [ORDER_CONFIRMED]{"items":[{"name":"EXACT_MENU_ITEM_NAME","qty":1},{"name":"EXACT_MENU_ITEM_NAME_2","qty":1}]}[/ORDER_CONFIRMED]
- The item names inside the tag MUST match the menu item names EXACTLY as they appear in the menu. Do not abbreviate or paraphrase item names.
- The tag must be the very last thing in your response, after your friendly confirmation message.
- Example response when customer confirms: "Your order is on its way! I've placed 1x Iced Pomegranate Coffee and 1x Chocolate Chip Cookie for you. The kitchen has been notified. Anything else you'd like? [ORDER_CONFIRMED]{"items":[{"name":"Iced Pomegranate Coffee","qty":1},{"name":"Chocolate Chip Cookie","qty":1}]}[/ORDER_CONFIRMED]"
- If the customer has NOT confirmed yet, do NOT include the tag. Ask for confirmation first.
- When listing items for confirmation, always show the price next to each item.
- Never include the tag if you are just suggesting items or asking questions.

PERSONALITY:
${personality}

Remember: you are the reason this customer discovers something they love. Be memorable.`;

        const completion = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            max_tokens: 180,
            temperature: 0.8,
            messages: [
                {
                    role: "system",
                    content: systemPrompt
                },
                ...safeHistory,
                {
                    role: "user",
                    content: message
                }
            ]
        });

        const reply = completion.choices?.[0]?.message?.content?.trim();
        if (!reply) {
            return res.status(502).json({ error: "Empty model response" });
        }

        return res.json({ reply });
    } catch (err) {
        console.error("[menu-chat] Error:", err.message);
        return res.status(500).json({ error: "Chat failed" });
    }
});

// --- POST /api/upsell-event ---
app.post("/api/upsell-event", async (req, res) => {
    try {
        const { restaurant_slug, table_number, item_id, cart_value, upsell_value, event_type, gpt_word_count, upsell_reason, candidate_pool_size } = req.body;

        await pool.query(
            "INSERT INTO upsell_events (restaurant_slug, table_number, item_id, cart_value, upsell_value, event_type, gpt_word_count, upsell_reason, candidate_pool_size) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
            [restaurant_slug, table_number, item_id, cart_value, upsell_value, event_type, gpt_word_count, upsell_reason, candidate_pool_size || null]
        );
        res.json({ success: true });
    } catch (err) {
        console.error("[upsell-event] Error:", err.message);
        res.status(500).json({ error: "Failed to log upsell event" });
    }
});

// --- POST /api/upsell-shown ---
// Tracks when an upsell recommendation is displayed to the customer.
// The frontend calls this as a fire-and-forget POST (may have empty body).
app.post("/api/upsell-shown", async (req, res) => {
    try {
        const {
            restaurant_slug = null,
            table_number = null,
            item_id = null,
            cart_value = null,
            upsell_value = null,
            event_type = "shown",
            upsell_reason = null,
            candidate_pool_size = null
        } = req.body || {};

        await pool.query(
            "INSERT INTO upsell_events (restaurant_slug, table_number, item_id, cart_value, upsell_value, event_type, gpt_word_count, upsell_reason, candidate_pool_size) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
            [restaurant_slug, table_number, item_id, cart_value, upsell_value, event_type, 0, upsell_reason, candidate_pool_size]
        );
        console.log("[upsell-shown] Event logged successfully");
        res.json({ success: true });
    } catch (err) {
        console.error("[upsell-shown] Error:", err.message);
        res.status(500).json({ error: "Failed to log upsell-shown event" });
    }
});

app.post("/api/:slug/order-complete", async (req, res) => {
    try {
        const resResult = await pool.query("SELECT id FROM restaurants WHERE domain = $1", [req.params.slug]);
        if (resResult.rows.length === 0) return res.status(404).json({ error: "Restaurant not found" });

        const { items, total, customer_name, customer_phone, upsellAccepted, upsellValue, tableNumber } = req.body;
        const result = await pool.query(
            "INSERT INTO orders (restaurant_id, items, total, customer_name, customer_phone, pairing_accepted, table_number, upsell_value) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id",
            [resResult.rows[0].id, JSON.stringify(items), total, customer_name, customer_phone, upsellAccepted, tableNumber || null, Math.round(Number(upsellValue) || 0)]
        );

        const orderId = result.rows[0].id;
        const safeItems = Array.isArray(items) ? items : [];
        for (const item of safeItems) {
            const itemName = typeof item?.name === "string" ? item.name.trim() : "";
            if (!itemName) continue;
            const menuItemId = Number.isInteger(item?.menu_item_id) ? item.menu_item_id : (Number.isInteger(item?.id) ? item.id : null);
            const quantityRaw = Number(item?.quantity ?? item?.qty ?? 1);
            const quantity = Number.isFinite(quantityRaw) && quantityRaw > 0 ? Math.round(quantityRaw) : 1;
            const unitPriceRaw = typeof item?.price === "number"
                ? item.price
                : Number(String(item?.price ?? "").replace(/[^\d.]/g, ""));
            const unitPrice = Number.isFinite(unitPriceRaw) ? unitPriceRaw : 0;

            await pool.query(
                `INSERT INTO order_items (order_id, menu_item_id, item_name, quantity, unit_price)
                 VALUES ($1, $2, $3, $4, $5)`,
                [orderId, menuItemId, itemName, quantity, unitPrice]
            );
        }

        res.json({ success: true, orderId });
    } catch (err) {
        console.error("[order-complete] Error:", err.message);
        res.status(500).json({ success: false });
    }
});

// =============================================================================
// AI-DRIVEN UPSELL PAIRING ENGINE
// =============================================================================

// --- POST /api/rank-upsell ---
// AI-driven upsell pairing engine with GPT selection and fallback.
// Input:  { candidates: Item[], cartItems: Item[] }
// Output: { item: Item, reason: string }
app.post("/api/rank-upsell", async (req, res) => {
    try {
        const { candidates, cartItems } = req.body;

        if (!candidates || candidates.length === 0) {
            console.log("[rank-upsell] No candidates provided");
            return res.status(400).json({ error: "No candidates" });
        }

        const safeCartItems = Array.isArray(cartItems) ? cartItems : [];
        console.log(`[rank-upsell] Scoring ${candidates.length} candidates against ${safeCartItems.length} cart items`);

        // --- Enrich candidates with DB metadata if available ---
        let enrichedCandidates = candidates;
        try {
            const ids = candidates.map(c => c.id).filter(Boolean);
            if (ids.length > 0) {
                const dbResult = await pool.query(
                    "SELECT id, category, sub_category, tags FROM menus WHERE id = ANY($1)",
                    [ids]
                );
                const dbMap = {};
                for (const row of dbResult.rows) {
                    dbMap[row.id] = row;
                }
                enrichedCandidates = candidates.map(c => ({
                    ...c,
                    category: c.category || dbMap[c.id]?.category || null,
                    sub_category: c.sub_category || dbMap[c.id]?.sub_category || null,
                    tags: c.tags || dbMap[c.id]?.tags || []
                }));
            }
        } catch (dbErr) {
            console.warn("[rank-upsell] DB enrichment failed, using raw candidates:", dbErr.message);
        }

        // --- Enrich cart items with DB metadata if available ---
        let enrichedCartItems = safeCartItems;
        try {
            const cartIds = safeCartItems.map(c => c.id).filter(Boolean);
            if (cartIds.length > 0) {
                const dbResult = await pool.query(
                    "SELECT id, category, sub_category, tags FROM menus WHERE id = ANY($1)",
                    [cartIds]
                );
                const dbMap = {};
                for (const row of dbResult.rows) {
                    dbMap[row.id] = row;
                }
                enrichedCartItems = safeCartItems.map(c => ({
                    ...c,
                    category: c.category || dbMap[c.id]?.category || null,
                    sub_category: c.sub_category || dbMap[c.id]?.sub_category || null,
                    tags: c.tags || dbMap[c.id]?.tags || []
                }));
            }
        } catch (dbErr) {
            console.warn("[rank-upsell] Cart DB enrichment failed:", dbErr.message);
        }

        // --- Candidate Generation (minimal deterministic algorithm) ---
        // Only two rules: exclude primary item & exclude items already in cart
        const primaryItem = enrichedCartItems[0] || {};
        const cartItemIds = new Set(enrichedCartItems.map(i => i.id));

        let candidatePool = enrichedCandidates.filter(item => {
            if (cartItemIds.has(item.id)) return false;
            return true;
        });

        if (candidatePool.length === 0) {
            console.log("[rank-upsell] No valid candidates after filtering");
            return res.status(400).json({ error: "No valid candidates" });
        }

        // --- Scalable Keyword-Based Category Bucketing ---
        // Works for ANY restaurant without code changes.
        // New categories are auto-classified by keyword matching.
        // Default bucket is FOOD (safest, since most menu items are food).

        function getCategoryBucket(category) {
            if (!category) return "FOOD";
            const c = category.toLowerCase().trim();

            // DRINK: any category containing drink-related keywords
            const DRINK_KEYWORDS = [
                "beverage", "drink", "juice", "coffee", "tea", "chai",
                "shake", "smoothie", "mocktail", "cocktail", "lassi",
                "chaas", "buttermilk", "soda", "lemonade", "lemon",
                "water", "beer", "wine", "spirits", "cooler", "squash",
                "toddy", "kombucha", "milkshake", "frappe", "cold brew",
                "hot drink", "cold drink", "nimbu", "jaljeera", "aam panna",
                "sharbat", "thandai",
                "brewmaster", "kaapi", "mocha", "cappuccino", "latte",
                "espresso", "americano", "hot chocolate"
            ];

            // DESSERT: any category containing sweet/dessert-related keywords
            const DESSERT_KEYWORDS = [
                "dessert", "sweet", "ice cream", "icecream", "gelato",
                "cake", "pastry", "mithai", "gulab jamun", "rasgulla",
                "halwa", "kheer", "pudding", "brownie", "cookie",
                "waffle", "pancake", "sundae", "kulfi", "falooda",
                "payasam", "ladoo", "barfi", "jalebi", "rabri",
                "mousse", "tiramisu", "cheesecake", "pie", "tart"
            ];

            for (const keyword of DRINK_KEYWORDS) {
                if (c.includes(keyword)) return "DRINK";
            }

            for (const keyword of DESSERT_KEYWORDS) {
                if (c.includes(keyword)) return "DESSERT";
            }

            // Everything else is FOOD (burger, pizza, pasta, rice, biryani,
            // starters, mains, soup, salad, sides, appetizers, tandoor, etc.)
            return "FOOD";
        }

        // Also classify by item tags as a second signal (if category is ambiguous)
        function getCategoryBucketWithTags(category, tags) {
            const bucketFromCategory = getCategoryBucket(category);

            // If category gave us a clear DRINK or DESSERT, trust it
            if (bucketFromCategory !== "FOOD") return bucketFromCategory;

            // If category defaulted to FOOD, check tags for drink/dessert signals
            if (tags && Array.isArray(tags) && tags.length > 0) {
                const tagStr = tags.join(" ").toLowerCase();

                const DRINK_TAG_SIGNALS = ["drink", "beverage", "coffee", "tea", "juice", "smoothie", "shake", "cold", "hot drink"];
                const DESSERT_TAG_SIGNALS = ["dessert", "sweet", "frozen", "ice cream", "cake", "pastry", "chocolate"];

                for (const signal of DRINK_TAG_SIGNALS) {
                    if (tagStr.includes(signal)) return "DRINK";
                }
                for (const signal of DESSERT_TAG_SIGNALS) {
                    if (tagStr.includes(signal)) return "DESSERT";
                }
            }

            return "FOOD";
        }

        // --- Apply Complementary Filter ---
        const primaryBucket = getCategoryBucketWithTags(
            primaryItem.category,
            primaryItem.tags
        );
        console.log(`[rank-upsell] Primary: "${primaryItem.name}" | category: "${primaryItem.category}" | bucket: "${primaryBucket}"`);

        const BUCKET_COMPLEMENTS = {
            "FOOD": ["DRINK", "DESSERT"],
            "DRINK": ["FOOD"],
            "DESSERT": ["DRINK"]
        };

        const allowedBuckets = BUCKET_COMPLEMENTS[primaryBucket];

        if (allowedBuckets && allowedBuckets.length > 0) {
            const complementaryPool = candidatePool.filter(item => {
                const itemBucket = getCategoryBucketWithTags(item.category, item.tags);
                return allowedBuckets.includes(itemBucket);
            });
            console.log(`[rank-upsell] Complementary filter: ${candidatePool.length} -> ${complementaryPool.length} candidates`);
            console.log(`[rank-upsell] Filtered candidates: ${JSON.stringify(complementaryPool.map(c => ({ name: c.name, category: c.category, bucket: getCategoryBucketWithTags(c.category, c.tags) })))}`);

            if (complementaryPool.length > 0) {
                candidatePool = complementaryPool;
            } else {
                console.warn("[rank-upsell] No complementary candidates found, keeping full pool");
            }
        } else {
            console.warn(`[rank-upsell] No bucket match for "${primaryBucket}", keeping full pool`);
        }

        // --- Price Cap Filter ---
        // The paired item should feel like a small addition, not a bigger purchase.
        // Rule: paired item price should be at most 70% of primary item price,
        // with a minimum floor of ₹150 (so cheap primary items still get valid pairings).
        const parsePrice = (val) => {
            if (typeof val === "number") return val;
            if (typeof val === "string") return Number(val.replace(/[^\d.]/g, "")) || 0;
            return 0;
        };
        const primaryPrice = parsePrice(primaryItem.price);
        console.log(`[rank-upsell] Primary price parsed: ${primaryPrice} (raw: ${JSON.stringify(primaryItem.price)})`);
        if (primaryPrice > 0) {
            const priceCap = Math.max(primaryPrice * 0.7, 150);
            const beforeCount = candidatePool.length;
            const pricedPool = candidatePool.filter(item => {
                const itemPrice = parsePrice(item.price);
                return itemPrice > 0 && itemPrice <= priceCap;
            });
            console.log(`[rank-upsell] Price cap filter (≤ ₹${Math.round(priceCap)}): ${beforeCount} -> ${pricedPool.length} candidates`);
            if (pricedPool.length > 0) {
                candidatePool = pricedPool;
            } else {
                console.warn("[rank-upsell] No candidates under price cap, keeping full complementary pool");
            }
        } else {
            console.warn(`[rank-upsell] Skipping price cap: primaryPrice is 0 (raw value: ${JSON.stringify(primaryItem.price)})`);
        }

        // Shuffle the entire pool before slicing
        candidatePool = candidatePool
            .map(x => ({ x, r: Math.random() }))
            .sort((a, b) => a.r - b.r)
            .map(x => x.x);

        // Slice to max 10
        const finalCandidates = candidatePool.slice(0, 10);

        const primaryItemForLog = enrichedCartItems[0] || {};
        console.log(`[rank-upsell] primary item: ${primaryItemForLog.name || 'Unknown'}`);
        console.log(`[rank-upsell] candidate pool size: ${finalCandidates.length}`);
        console.log(`[rank-upsell] candidates: ${JSON.stringify(finalCandidates.map(c => c.name))}`);

        // Full menu context passed separately so GPT can reason with complete landscape
        const fullMenuContext = enrichedCandidates;

        // --- AI-driven selection: evaluate per cart item ---
        let finalUpsell = null;
        for (const cartItem of enrichedCartItems) {
            const result = await generateUpsell(finalCandidates, [cartItem], fullMenuContext);
            if (result && result.item) {
                finalUpsell = result;
                break;
            }
        }

        if (finalUpsell) {
            console.log(`[rank-upsell] Winner: ${finalUpsell.item.name}`);

            // Provide BOTH reason and upsell_copy if the frontend starts using upsell_copy eventually. Currently, it expects `reason`, but we'll pack both safely.
            const combinedReason = finalUpsell.copy || finalUpsell.reason; 
            return res.json({ 
                item: finalUpsell.item, 
                reason: combinedReason,
                candidate_pool_size: finalCandidates.length 
            });
        } else {
            throw new Error("No upsell generated from cart loop");
        }
    } catch (err) {
        console.error("[rank-upsell] Unexpected error:", err.message);
        // Emergency fallback: return first candidate with generic reason
        try {
            const { candidates } = req.body;
            if (candidates && candidates.length > 0) {
                return res.json({
                    item: candidates[0],
                    reason: "A perfect addition to your order."
                });
            }
        } catch (_) { /* ignore */ }
        res.status(500).json({ error: "Internal error" });
    }
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
