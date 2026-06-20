// AD SOUTHERN SMART POS — Module 3 Backend Routes
// server_billing_routes.js
//
// ════════════════════════════════════════════════════════════
//  HOW TO INTEGRATE INTO server.js:
//
//  1. server.js ෆයිල් පහල require() ලිස්ට් එකට add කරන්න:
//       const { setupBillingRoutes } = require('./server_billing_routes');
//
//  2. app.use('/api/super-admin', saRouter); ලයිනෙ පහල:
//       setupBillingRoutes(app, {
//         requireAuth, audit,
//         Shop, User,
//       });
//
//  3. MONGOOSE SCHEMAS (server.js ට add කරන්න — Shop/User schema definitions BELOW):
//     ──────────────────────────────────────────────────────────
//     paste the two schema blocks at the bottom of this file
//     into your server.js, after the AuditLog schema.
// ════════════════════════════════════════════════════════════

'use strict';

const express  = require('express');
const mongoose = require('mongoose');

/* ════════════════════════════════════════════════════════════
   SCHEMAS  (server.js ට paste කරන්න)
════════════════════════════════════════════════════════════ */

// ── EAN-13 Barcode Auto-Generator (for items without printed barcodes) ──
// Prefix "99" = Internal/local barcode (EAN private use range)
async function generateEAN13(shopId) {
  // Body: "99" + shopId last 4 chars + 7-digit sequence
  const shopSuffix = String(shopId).slice(-4);
  const count = await InventoryItem.countDocuments({ shopId });
  const seq   = String(count + 1 + Math.floor(Math.random() * 100)).padStart(7, '0');
  const body  = `99${shopSuffix}${seq}`.slice(0, 12); // 12 digits
  // EAN-13 check digit calculation
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += parseInt(body[i]) * (i % 2 === 0 ? 1 : 3);
  const check = (10 - (sum % 10)) % 10;
  return body + check;
}

// ── InventoryItem Schema ──
const InventoryItemSchema = new mongoose.Schema({
  shopId:        { type: mongoose.Schema.Types.ObjectId, ref: 'Shop', required: true },
  name:          { type: String, required: true, trim: true },
  sku:           { type: String, trim: true },
  barcode:       { type: String, trim: true },
  category:      { type: String, trim: true },
  subCategory:   { type: String, trim: true },
  unit:          { type: String, default: 'Nos' },
  quantity:      { type: Number, default: 0 },  // දශමස්ථාන 3: kg=1.000, 250g=0.250
  costPrice:     { type: Number, required: true, min: 0 },
  sellingPrice:  { type: Number, required: true, min: 0 },
  expiryDate:    { type: Date, default: null },
  lowStockAt:    { type: Number, default: null },
  isActive:      { type: Boolean, default: true },
  // FRACTIONAL STOCK: දශම ප්‍රමාණ (කිලෝ, ලීටර්) සඳහා
  isFractional:  { type: Boolean, default: false }, // true = kg/l, false = Nos/Pkt
}, { timestamps: true });

// DATABASE INDEXING: Performance optimization — barcode/sku සෙවීම ms 5ක් ඇතුළත
InventoryItemSchema.index({ shopId: 1, barcode: 1 });
InventoryItemSchema.index({ shopId: 1, sku: 1 });
InventoryItemSchema.index({ shopId: 1, name: 'text', sku: 'text', barcode: 'text' });

const InventoryItem = mongoose.models.InventoryItem
  || mongoose.model('InventoryItem', InventoryItemSchema);

// ── Bill Schema ──
const BillSchema = new mongoose.Schema({
  shopId:      { type: mongoose.Schema.Types.ObjectId, ref: 'Shop', required: true },
  billNumber:  { type: String, required: true },
  cashierId:   { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  cashierName: { type: String },
  customerName:{ type: String, default: '' },
  items: [{
    itemId:  { type: mongoose.Schema.Types.ObjectId, ref: 'InventoryItem' },
    name:    String,
    sku:     String,
    unit:    String,
    qty:     { type: Number, required: true, min: 0 },  // fractional items: 0.250 kg etc.
    price:   { type: Number, required: true },
    total:   Number, // qty * price (denormalized for quick reads)
  }],
  subtotal:      { type: Number, required: true },
  total:         { type: Number, required: true },
  paymentMethod: { type: String, enum: ['cash','card','transfer'], default: 'cash' },
  amountPaid:    { type: Number, default: 0 },
  change:        { type: Number, default: 0 },
  cosmeticSaving:{ type: Number, default: 0 },
  cosmeticRate:  { type: Number, default: 0 },
  isVoided:      { type: Boolean, default: false },
  voidedAt:      { type: Date, default: null },
  voidReason:    { type: String, default: '' },
  isOfflineSync: { type: Boolean, default: false }, // came from Module 4 sync
}, { timestamps: true });

BillSchema.index({ shopId: 1, createdAt: -1 });
BillSchema.index({ shopId: 1, billNumber: 1 }, { unique: true });

const Bill = mongoose.models.Bill || mongoose.model('Bill', BillSchema);

// ── HeldBill Schema ──
const HeldBillSchema = new mongoose.Schema({
  shopId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Shop', required: true },
  cashierId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  items:     [{ type: mongoose.Schema.Types.Mixed }],
  subtotal:  { type: Number, default: 0 },
  total:     { type: Number, default: 0 },
  heldAt:    { type: Date, default: Date.now },
}, { timestamps: true });

const HeldBill = mongoose.models.HeldBill || mongoose.model('HeldBill', HeldBillSchema);

/* ════════════════════════════════════════════════════════════
   BILL NUMBER GENERATOR
   Format: YYYYMMDD-SHOPABBR-0001
════════════════════════════════════════════════════════════ */
async function generateBillNumber(shopId) {
  const today = new Date();
  const dateStr = `${today.getFullYear()}${String(today.getMonth()+1).padStart(2,'0')}${String(today.getDate()).padStart(2,'0')}`;
  const prefix = `${dateStr}-`;

  // Count today's bills for this shop
  const startOfDay = new Date(today); startOfDay.setHours(0,0,0,0);
  const endOfDay   = new Date(today); endOfDay.setHours(23,59,59,999);

  const count = await Bill.countDocuments({
    shopId,
    createdAt: { $gte: startOfDay, $lte: endOfDay },
  });

  return `${prefix}${String(count + 1).padStart(4, '0')}`;
}

/* ════════════════════════════════════════════════════════════
   MAIN SETUP FUNCTION
════════════════════════════════════════════════════════════ */
function setupBillingRoutes(app, { requireAuth, audit, Shop }) {

  /* ────────────────────────────────────────────────────────
     MIDDLEWARE: verify shop membership
  ──────────────────────────────────────────────────────── */
  function requireShopAccess(req, res, next) {
    if (!req.user?.shopId) return res.status(403).json({ message: 'Shop access required' });
    next();
  }

  /* ════════════════════════════════════════════════════════
     ADMIN INVENTORY ROUTES  /api/admin/items
  ════════════════════════════════════════════════════════ */
  const inventoryRouter = express.Router();
  inventoryRouter.use(requireAuth, requireShopAccess);

  /* GET /api/admin/items — paginated list with filters */
  inventoryRouter.get('/', async (req, res) => {
    const shopId = req.user.shopId;
    const { search, category, page = 1, limit = 40, lowStock, expiring } = req.query;

    const query = { shopId, isActive: true };

    if (search) {
      query.$or = [
        { name:     { $regex: search, $options: 'i' } },
        { sku:      { $regex: search, $options: 'i' } },
        { barcode:  { $regex: search, $options: 'i' } },
        { category: { $regex: search, $options: 'i' } },
      ];
    }
    if (category) query.category = { $regex: category, $options: 'i' };

    if (lowStock === 'true') {
      // Items below their individual threshold or shop default
      const shop = await Shop.findById(shopId).lean();
      const defaultThreshold = shop?.settings?.lowStockDefault || 10;
      query.$expr = {
        $lte: [
          '$quantity',
          { $ifNull: ['$lowStockAt', defaultThreshold] },
        ],
      };
    }

    if (expiring === 'true') {
      const in30Days = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      query.expiryDate = { $ne: null, $lte: in30Days, $gte: new Date() };
    }

    try {
      const total = await InventoryItem.countDocuments(query);
      const items = await InventoryItem.find(query)
        .sort({ name: 1 })
        .skip((+page - 1) * +limit)
        .limit(+limit)
        .lean();

      return res.json({ items, total, totalPages: Math.ceil(total / +limit), page: +page });
    } catch (err) {
      return res.status(500).json({ message: err.message });
    }
  });

  /* POST /api/admin/items — create item */
  inventoryRouter.post('/', async (req, res) => {
    const shopId = req.user.shopId;
    const {
      name, sku, barcode, category, subCategory,
      unit, quantity, costPrice, sellingPrice,
      expiryDate, lowStockAt, isFractional,
    } = req.body;

    if (!name || costPrice == null || sellingPrice == null) {
      return res.status(400).json({ message: 'name, costPrice, sellingPrice අවශ්‍යයි' });
    }

    // Check stock tier limit
    const shop = await Shop.findById(shopId).lean();
    const tierLimits = { micro: 1500, standard: 15000, mega: 60000, enterprise: Infinity };
    const limit = tierLimits[shop?.stockTier] || 15000;
    const currentCount = await InventoryItem.countDocuments({ shopId, isActive: true });
    if (currentCount >= limit) {
      return res.status(403).json({ message: `Stock tier limit (${limit} items) ඉක්මවා ඇත. Tier Upgrade සඳහා Super Admin ට contact කරන්න.` });
    }

    // SKU AUTO-GENERATION: භාණ්ඩ නමේ මුල් අකුරු 3 + අනුක්‍රම අංකය
    // (eg: "Parippu" → PAR-451)
    let finalSku = sku;
    if (!finalSku) {
      const nameCode = name.trim().replace(/[^a-zA-Z]/g, '').slice(0, 3).toUpperCase() || 'ITM';
      const seq      = String(currentCount + 1).padStart(3, '0');
      // Ensure uniqueness: if PAR-001 exists, try PAR-002 etc.
      let candidate  = `${nameCode}-${seq}`;
      const conflict = await InventoryItem.findOne({ shopId, sku: candidate });
      if (conflict) candidate = `${nameCode}-${String(currentCount + 1 + Math.floor(Math.random()*89) + 10).padStart(3,'0')}`;
      finalSku = candidate;
    }

    // BARCODE AUTO-GENERATION: EAN-13 starting with "99" (internal range)
    let finalBarcode = (barcode || '').trim();
    if (!finalBarcode) {
      finalBarcode = await generateEAN13(shopId);
    }

    // FRACTIONAL: quantity always stored as decimal (3 places for kg/l items)
    const parsedQty = isFractional
      ? Math.round(parseFloat(quantity || 0) * 1000) / 1000  // 3 decimal places
      : Math.round(parseFloat(quantity || 0));

    try {
      const item = await InventoryItem.create({
        shopId, name, sku: finalSku, barcode: finalBarcode, category, subCategory,
        unit: unit || (isFractional ? 'kg' : 'Nos'),
        quantity: parsedQty,
        costPrice: +costPrice,
        sellingPrice: +sellingPrice,
        expiryDate: expiryDate || null,
        lowStockAt: lowStockAt != null ? +lowStockAt : null,
        isFractional: !!isFractional,
      });
      await audit('CREATE_ITEM', 'low', req, { shopId, details: `Item සාදන ලදී: ${name} (${finalSku}) | Barcode: ${finalBarcode}` });
      return res.status(201).json({ item });
    } catch (err) {
      return res.status(500).json({ message: err.message });
    }
  });

  /* PATCH /api/admin/items/:itemId — update item */
  inventoryRouter.patch('/:itemId', async (req, res) => {
    try {
      const item = await InventoryItem.findOneAndUpdate(
        { _id: req.params.itemId, shopId: req.user.shopId },
        req.body,
        { new: true }
      );
      if (!item) return res.status(404).json({ message: 'Item හමු නොවීය' });
      await audit('UPDATE_ITEM', 'low', req, { shopId: req.user.shopId, details: `Item update: ${item.name}` });
      return res.json({ item });
    } catch (err) {
      return res.status(500).json({ message: err.message });
    }
  });

  /* DELETE /api/admin/items/:itemId — soft delete */
  inventoryRouter.delete('/:itemId', async (req, res) => {
    const { confirmation, masterPassword } = req.body;
    if (confirmation !== 'YES') return res.status(400).json({ message: '"YES" ලෙස confirm කරන්න' });

    const master = process.env.MASTER_ACTION_PASSWORD || 'change_master_password';
    if (masterPassword !== master) return res.status(401).json({ message: 'Master Password වැරදියි' });

    try {
      const item = await InventoryItem.findOneAndUpdate(
        { _id: req.params.itemId, shopId: req.user.shopId },
        { isActive: false },
        { new: true }
      );
      if (!item) return res.status(404).json({ message: 'Item හමු නොවීය' });
      await audit('DELETE_ITEM', 'medium', req, { shopId: req.user.shopId, details: `Item deleted: ${item.name}` });
      return res.json({ success: true });
    } catch (err) {
      return res.status(500).json({ message: err.message });
    }
  });

  /* ════════════════════════════════════════════════════════
     FINANCE ROUTES  /api/admin/finance/*
     BUG FIX: this used to be the SAME inventoryRouter mounted a
     second time at '/api/admin/finance', which meant the full
     item CRUD handlers (PATCH/DELETE '/:itemId') were also live
     under '/api/admin/finance/:id' — e.g. a DELETE to
     '/api/admin/finance/<itemId>' would silently soft-delete an
     item, since Express matched it against inventoryRouter's
     '/:itemId' route. Finance now has its own isolated router
     that exposes ONLY the matrix endpoint.
  ════════════════════════════════════════════════════════ */
  const financeRouter = express.Router();
  financeRouter.use(requireAuth, requireShopAccess);

  /* GET /api/admin/finance/matrix — Financial Live Matrix (Module 2B) */
  financeRouter.get('/matrix', async (req, res) => {
    const shopId = req.user.shopId;
    try {
      const agg = await InventoryItem.aggregate([
        { $match: { shopId: new mongoose.Types.ObjectId(shopId), isActive: true } },
        { $group: {
          _id: null,
          totalCostValue:    { $sum: { $multiply: ['$costPrice',    '$quantity'] } },
          totalSellingValue: { $sum: { $multiply: ['$sellingPrice', '$quantity'] } },
        }},
      ]);
      const row = agg[0] || { totalCostValue: 0, totalSellingValue: 0 };
      const totalNetProfit = row.totalSellingValue - row.totalCostValue;
      const profitMarginPercent = row.totalSellingValue > 0
        ? (totalNetProfit / row.totalSellingValue) * 100
        : 0;
      return res.json({ ...row, totalNetProfit, profitMarginPercent });
    } catch (err) {
      return res.status(500).json({ message: err.message });
    }
  });

  app.use('/api/admin/items',   inventoryRouter);
  app.use('/api/admin/finance', financeRouter);

  /* ════════════════════════════════════════════════════════
     BILLING ROUTES  /api/billing/*
  ════════════════════════════════════════════════════════ */
  const billingRouter = express.Router();
  billingRouter.use(requireAuth, requireShopAccess);

  /* GET /api/billing/items/search?q= — POS item search (api.js: searchItems) */
  billingRouter.get('/items/search', async (req, res) => {
    const { q } = req.query;
    if (!q) return res.json({ items: [] });

    try {
      const items = await InventoryItem.find({
        shopId:   req.user.shopId,
        isActive: true,
        $or: [
          { name:    { $regex: q, $options: 'i' } },
          { sku:     { $regex: q, $options: 'i' } },
          { barcode: { $regex: q, $options: 'i' } },
        ],
      })
        .select('name sku barcode category unit quantity sellingPrice costPrice')
        .limit(12)
        .lean();

      return res.json({ items });
    } catch (err) {
      return res.status(500).json({ message: err.message });
    }
  });

  /* GET /api/billing/items/barcode?barcode= (api.js: getItemByBarcode) */
  billingRouter.get('/items/barcode', async (req, res) => {
    const { barcode } = req.query;
    if (!barcode) return res.json({ item: null });
    try {
      const item = await InventoryItem.findOne({
        shopId:   req.user.shopId,
        barcode,
        isActive: true,
      }).lean();
      return res.json({ item: item || null });
    } catch (err) {
      return res.status(500).json({ message: err.message });
    }
  });

  /* GET /api/billing/settings/cosmetic-rate (api.js: getCosmeticSavingsRate) */
  billingRouter.get('/settings/cosmetic-rate', async (req, res) => {
    try {
      const shop = await Shop.findById(req.user.shopId).select('settings').lean();
      return res.json({ rate: shop?.settings?.cosmeticSavingsPercent || 0 });
    } catch (err) {
      return res.status(500).json({ message: err.message });
    }
  });

  /* POST /api/billing/bills — Create bill + deduct stock */
  billingRouter.post('/bills', async (req, res) => {
    const {
      items, subtotal, total, paymentMethod,
      amountPaid, change, cosmeticSaving, cosmeticRate,
      customerName, cashierName, isOfflineSync,
    } = req.body;

    if (!items?.length) return res.status(400).json({ message: 'Items අවශ්‍යයි' });

    const shopId    = req.user.shopId;
    const session   = await mongoose.startSession();
    session.startTransaction();

    try {
      // Deduct stock for each item (atomic transaction)
      for (const bi of items) {
        const item = await InventoryItem.findOne(
          { _id: bi.itemId, shopId, isActive: true },
          null, { session }
        );
        if (!item) throw new Error(`Item "${bi.name}" හමු නොවීය`);
        if (item.quantity < bi.qty) throw new Error(`Stock අඩු: "${item.name}" — Available: ${item.quantity}, Requested: ${bi.qty}`);

        await InventoryItem.findByIdAndUpdate(
          bi.itemId,
          { $inc: { quantity: -bi.qty } },
          { session }
        );
        bi.total = bi.price * bi.qty; // denormalize
      }

      const billNumber = await generateBillNumber(shopId);

      const [bill] = await Bill.create([{
        shopId,
        billNumber,
        cashierId:   req.user.id,
        cashierName: cashierName || req.user.displayName,
        customerName: customerName || '',
        items,
        subtotal,
        total,
        paymentMethod: paymentMethod || 'cash',
        amountPaid:    parseFloat(amountPaid) || total,
        change:        parseFloat(change)     || 0,
        cosmeticSaving: cosmeticSaving || 0,
        cosmeticRate:   cosmeticRate   || 0,
        isOfflineSync:  isOfflineSync  || false,
      }], { session });

      await session.commitTransaction();
      session.endSession();

      await audit('CREATE_BILL', 'low', req, {
        shopId,
        details: `Bill #${billNumber} — Rs.${total} (${paymentMethod})`,
      });

      return res.status(201).json({ bill });
    } catch (err) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ message: err.message });
    }
  });

  /* GET /api/billing/bills — Bill list with search */
  billingRouter.get('/bills', async (req, res) => {
    const { search, limit = 40, page = 1, dateFrom, dateTo } = req.query;
    const shopId = req.user.shopId;

    const query = { shopId };
    if (search) {
      query.$or = [
        { billNumber:  { $regex: search, $options: 'i' } },
        { cashierName: { $regex: search, $options: 'i' } },
        { customerName:{ $regex: search, $options: 'i' } },
      ];
    }
    if (dateFrom || dateTo) {
      query.createdAt = {};
      if (dateFrom) query.createdAt.$gte = new Date(dateFrom);
      if (dateTo)   query.createdAt.$lte = new Date(dateTo + 'T23:59:59');
    }

    try {
      const total = await Bill.countDocuments(query);
      const bills = await Bill.find(query)
        .sort({ createdAt: -1 })
        .skip((+page-1) * +limit)
        .limit(+limit)
        .lean();

      // Add itemCount for display
      const billsWithCount = bills.map(b => ({
        ...b,
        itemCount: b.items?.reduce((s, i) => s + i.qty, 0) || 0,
      }));

      return res.json({ bills: billsWithCount, total, totalPages: Math.ceil(total / +limit) });
    } catch (err) {
      return res.status(500).json({ message: err.message });
    }
  });

  /* GET /api/billing/bills/:billId */
  billingRouter.get('/bills/:billId', async (req, res) => {
    try {
      const bill = await Bill.findOne({ _id: req.params.billId, shopId: req.user.shopId }).lean();
      if (!bill) return res.status(404).json({ message: 'Bill හමු නොවීය' });
      return res.json({ bill });
    } catch (err) {
      return res.status(500).json({ message: err.message });
    }
  });

  /* PUT /api/billing/bills/:billId/void — Void bill (api.js: voidBill uses PUT) */
  billingRouter.put('/bills/:billId/void', async (req, res) => {
    const { reason, masterPassword } = req.body;

    if (!reason?.trim()) return res.status(400).json({ message: 'Void reason ඇතුළත් කරන්න' });

    const master = process.env.MASTER_ACTION_PASSWORD || 'change_master_password';
    if (masterPassword !== master) return res.status(401).json({ message: 'Master Password වැරදියි' });

    const shopId = req.user.shopId;
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const bill = await Bill.findOne(
        { _id: req.params.billId, shopId, isVoided: false },
        null, { session }
      );
      if (!bill) return res.status(404).json({ message: 'Bill හමු නොවීය හෝ දැනටමත් Void කර ඇත' });

      // Restore stock
      for (const bi of bill.items) {
        if (bi.itemId) {
          await InventoryItem.findByIdAndUpdate(
            bi.itemId,
            { $inc: { quantity: +bi.qty } },
            { session }
          );
        }
      }

      await Bill.findByIdAndUpdate(
        bill._id,
        { isVoided: true, voidedAt: new Date(), voidReason: reason },
        { session }
      );

      await session.commitTransaction();
      session.endSession();

      await audit('VOID_BILL', 'high', req, {
        shopId,
        details: `Bill #${bill.billNumber} VOID — Reason: ${reason}`,
      });

      // WhatsApp Void Alert (fire-and-forget via existing WA module)
      if (process.env.WA_VOID_ENABLED === 'true') {
        try {
          const waPayload = {
            type:       'void_alert',
            billNumber: bill.billNumber,
            total:      bill.total,
            cashier:    bill.cashierName,
            reason,
            voidedBy:   req.user.displayName,
          };
          // Emit to WA module (implement in whatsapp.js separately)
          app.emit('wa:send_void_alert', waPayload);
        } catch {}
      }

      return res.json({ success: true, message: `Bill #${bill.billNumber} Void කළා` });
    } catch (err) {
      await session.abortTransaction();
      session.endSession();
      return res.status(500).json({ message: err.message });
    }
  });

  /* POST /api/billing/holds — Hold bill (api.js: holdBill) */
  billingRouter.post('/holds', async (req, res) => {
    const { items, subtotal, total } = req.body;
    if (!items?.length) return res.status(400).json({ message: 'Items අවශ්‍යයි' });
    try {
      const hold = await HeldBill.create({
        shopId:    req.user.shopId,
        cashierId: req.user.id,
        items, subtotal, total,
      });
      return res.status(201).json({ hold });
    } catch (err) {
      return res.status(500).json({ message: err.message });
    }
  });

  /* GET /api/billing/holds — Get all held bills (api.js: getHeldBills) */
  billingRouter.get('/holds', async (req, res) => {
    try {
      const holds = await HeldBill.find({ shopId: req.user.shopId })
        .sort({ heldAt: -1 })
        .lean();
      return res.json({ holds });
    } catch (err) {
      return res.status(500).json({ message: err.message });
    }
  });

  /* POST /api/billing/holds/:holdId/retrieve (api.js: retrieveHeldBill) */
  billingRouter.post('/holds/:holdId/retrieve', async (req, res) => {
    try {
      const hold = await HeldBill.findOneAndDelete({
        _id:    req.params.holdId,
        shopId: req.user.shopId,
      });
      if (!hold) return res.status(404).json({ message: 'Held bill හමු නොවීය' });
      return res.json({ items: hold.items });
    } catch (err) {
      return res.status(500).json({ message: err.message });
    }
  });

  // NOTE: /api/admin/settings — server.js ෙකේ geminiApiKey-aware version register වෙනවා.
  //       Duplicate register කිරීමෙන් route conflict ඇති වෙනවා. Settings router ඉවත් කළා.
  // NOTE: /api/admin/dashboard — server.js ෙකේ register වෙනවා; module5 cheque-summary ද register කෙරේ.
  //       Duplicate dashboard router ද ඉවත් කළා.

  /* ────────────────────────────────────────────────────────
     OFFLINE SYNC ROUTE  /api/sync/offline-push  (Module 4)
  ──────────────────────────────────────────────────────── */
  const syncRouter = express.Router();
  syncRouter.use(requireAuth, requireShopAccess);

  syncRouter.post('/offline-push', async (req, res) => {
    const { bills = [] } = req.body;
    const shopId = req.user.shopId;
    const results = { created: 0, skipped: 0, errors: [] };

    for (const b of bills) {
      try {
        // Skip if already synced (duplicate protection by offline billNumber)
        const exists = await Bill.findOne({ shopId, billNumber: b.billNumber });
        if (exists) { results.skipped++; continue; }

        const billNumber = b.billNumber || await generateBillNumber(shopId);

        // BUG FIX: deduct real server-side stock for every item in this
        // offline bill. The decrement that happens client-side while
        // offline (utils/offlineSync.js decrementOfflineStock) only ever
        // updates that device's local IndexedDB mirror — it never reaches
        // the database. Without this, InventoryItem.quantity in MongoDB
        // would never reflect anything sold while offline, silently
        // drifting from real stock on hand. We clamp at 0 instead of
        // rejecting, since the sale already physically happened and
        // can't be undone after the fact — a stock count going to 0
        // (rather than negative) just surfaces as "needs recount" instead
        // of crashing the sync.
        for (const bi of (b.items || [])) {
          if (!bi.itemId) continue;
          await InventoryItem.updateOne(
            { _id: bi.itemId, shopId },
            [{ $set: { quantity: { $max: [0, { $subtract: ['$quantity', bi.qty || 0] }] } } }]
          ).catch(() => {}); // missing/renamed item shouldn't block the rest of the sync
        }

        await Bill.create({
          shopId, billNumber,
          cashierId:   req.user.id,
          cashierName: b.cashierName || req.user.displayName,
          customerName: b.customerName || '',
          items:        b.items || [],
          subtotal:     b.subtotal,
          total:        b.total,
          paymentMethod: b.paymentMethod || 'cash',
          amountPaid:   b.amountPaid || b.total,
          change:       b.change || 0,
          cosmeticSaving: b.cosmeticSaving || 0,
          cosmeticRate:   b.cosmeticRate || 0,
          isOfflineSync: true,
          createdAt:    b.createdAt ? new Date(b.createdAt) : new Date(),
        });
        results.created++;
      } catch (err) {
        results.errors.push({ billNumber: b.billNumber, error: err.message });
      }
    }

    await audit('OFFLINE_SYNC', 'low', req, {
      shopId,
      details: `Offline sync: ${results.created} bills synced, ${results.skipped} skipped, ${results.errors.length} errors`,
    });

    return res.json({ success: true, results });
  });

  syncRouter.get('/stock-snapshot/:shopId', async (req, res) => {
    // Only allow access to own shop (or super admin)
    if (req.user.shopId?.toString() !== req.params.shopId && req.user.role !== 'super_admin') {
      return res.status(403).json({ message: 'Unauthorized' });
    }
    try {
      const items = await InventoryItem.find({ shopId: req.params.shopId, isActive: true })
        .select('_id name sku barcode unit quantity sellingPrice')
        .lean();
      return res.json({ items, snapshotAt: new Date().toISOString() });
    } catch (err) {
      return res.status(500).json({ message: err.message });
    }
  });

  app.use('/api/sync', syncRouter);
  app.use('/api/billing', billingRouter);

  console.log('✅ Module 3 Billing Routes registered');
}

module.exports = { setupBillingRoutes, InventoryItem, Bill, HeldBill };
