// AD SOUTHERN SMART POS — Backend Server
// ✅ Choreo Compatible Version (MongoDB Atlas → Choreo → GitHub Pages)
// PORT from env | Node.js + Express | MongoDB Atlas | JWT Auth | 3-Layer Security
//
// ── PATCH LOG ─────────────────────────────────────────────────────────────
// CHOREO-1: PORT env — Choreo injects PORT automatically (was hardcoded 3000)
// CHOREO-2: CORS — FRONTEND_URL env var හරහා GitHub Pages URL set කරන්න
// CHOREO-3: /health — Choreo healthcheck probe use කරයි
// CHOREO-4: ShopSchema → geminiApiKey field added (per-shop Gemini API key)
// CHOREO-5: OCR route → uses shop's own geminiApiKey first, falls back to global
// CHOREO-6: SA route to update shop geminiApiKey added
// CHOREO-7: Admin settings route — geminiApiKey save/load support added
// CHOREO-8: trust proxy — Choreo load balancer headers handle කිරීමට
// ──────────────────────────────────────────────────────────────────────────

'use strict';

const express    = require('express');
const cors       = require('cors');
const helmet     = require('helmet');
const mongoose   = require('mongoose');
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');
const rateLimit  = require('express-rate-limit');
const morgan     = require('morgan');
const axios      = require('axios');
const FormData   = require('form-data');
const cron       = require('node-cron');

const { setupBillingRoutes } = require('./server_billing_routes');
const { setupModule5 }       = require('./module5_routes');

const app  = express();
// CHOREO-1: Choreo PORT inject කරයි — process.env.PORT use කරන්න
const PORT = process.env.PORT || 8080;

/* ── Environment ──
   NOTE: A global ACTION_PIN fallback ('1234') previously existed here but was
   never actually checked anywhere in the routes — it was dead code left over
   from before Layer 2 became per-user (see UserSchema.actionPin). Removed to
   avoid a misleading hardcoded fallback PIN sitting in the codebase. */
const {
  MONGO_URI,
  JWT_SECRET             = 'change_me_in_production',
  MASTER_ACTION_PASSWORD = 'change_master_password',
  // CHOREO-2: GitHub Pages URL — Choreo env var හරහා inject කරන්න
  // Choreo Console → Environment Variables → FRONTEND_URL=https://YOUR_ORG.github.io/YOUR_REPO
  FRONTEND_URL           = 'https://slvip.github.io',
} = process.env;

// CHOREO-8: Choreo load balancer proxy trust
app.set('trust proxy', true);

/* ── Middleware ── */
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(cors({
  // CHOREO-2: FRONTEND_URL env var + local dev allow
  // Choreo Console හිදී FRONTEND_URL set කරන්න: https://YOUR_ORG.github.io
  origin: (origin, cb) => {
    const allowed = [
      FRONTEND_URL,
      'https://slvip.github.io',
      'http://localhost:3000',
      'http://localhost:3001',
    ].filter(Boolean);

    // Allow no-origin requests (mobile, Postman, Choreo health probes)
    if (!origin || allowed.some(u => origin.startsWith(u))) return cb(null, true);
    cb(new Error('CORS blocked: ' + origin));
  },
  credentials: true,
}));
app.use(express.json({ limit: '10mb' }));
app.use(morgan('tiny'));

/* ── MongoDB ── */
if (!MONGO_URI) {
  console.error('❌ MONGO_URI env variable set කරන්න!');
  process.exit(1);
}
mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 10000 })
  .then(() => console.log('✅ MongoDB Connected'))
  .catch(err => { console.error('❌ MongoDB Error:', err.message); process.exit(1); });

/* ════════════════════════════════════════════════════════════
   SCHEMAS
════════════════════════════════════════════════════════════ */

const ShopSchema = new mongoose.Schema({
  name:             { type: String, required: true, trim: true },
  businessCategory: { type: String, required: true, enum: ['Grocery','Hardware','Pharmacy','Electronic','Apparel','Communication','Other'] },
  stockTier:        { type: String, required: true, enum: ['micro','standard','mega','enterprise'], default: 'standard' },
  isActive:         { type: Boolean, default: true },
  ownerUsername:    { type: String },
  // CHOREO-4: Per-shop Gemini API Key
  geminiApiKey:     { type: String, default: '' },
  settings: {
    cosmeticSavingsPercent: { type: Number,  default: 0 },
    lowStockDefault:        { type: Number,  default: 10 },
    voiceAlerts:            { type: Boolean, default: true },
    whatsappEnabled:        { type: Boolean, default: false },
    whatsappPhoneNumber:    { type: String,  default: '' },
    shopDisplayName:        { type: String,  default: '' },
    receiptFooter:          { type: String,  default: 'ස්තූතියි! AD SOUTHERN SMART POS' },
    geminiApiKey:           { type: String,  default: '' },
  },
}, { timestamps: true });
const Shop = mongoose.model('Shop', ShopSchema);

const UserSchema = new mongoose.Schema({
  username:       { type: String, required: true, unique: true, lowercase: true, trim: true },
  displayName:    { type: String, required: true, trim: true },
  password:       { type: String, required: true },
  role:           { type: String, required: true, enum: ['super_admin','admin','manager','cashier'], default: 'cashier' },
  shopId:         { type: mongoose.Schema.Types.ObjectId, ref: 'Shop', default: null },
  isActive:       { type: Boolean, default: true },
  loginAttempts:  { type: Number, default: 0 },
  lockUntil:      { type: Date,   default: null },
  // Per-user 4-digit Action PIN (Layer 2 Security — each user sets their own)
  actionPin:      { type: String, default: null },   // bcrypt hashed
  pinSetAt:       { type: Date,   default: null },
}, { timestamps: true });

UserSchema.pre('save', async function (next) {
  if (this.isModified('password')) this.password = await bcrypt.hash(this.password, 12);
  if (this.isModified('actionPin') && this.actionPin && !/^\$2[aby]\$/.test(this.actionPin)) {
    // Hash only if it's a plain 4-digit string (not already hashed)
    this.actionPin = await bcrypt.hash(this.actionPin, 10);
  }
  next();
});
UserSchema.methods.comparePassword = function (plain) {
  return bcrypt.compare(plain, this.password);
};
UserSchema.methods.comparePin = function (plain) {
  if (!this.actionPin) return Promise.resolve(false);
  return bcrypt.compare(plain, this.actionPin);
};
const User = mongoose.model('User', UserSchema);

const AuditLogSchema = new mongoose.Schema({
  action:      { type: String, required: true },
  severity:    { type: String, enum: ['low','medium','high'], default: 'low' },
  userId:      { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  username:    String,
  displayName: String,
  shopId:      { type: mongoose.Schema.Types.ObjectId, ref: 'Shop' },
  shopName:    String,
  ipAddress:   String,
  details:     String,
  timestamp:   { type: Date, default: Date.now },
});
const AuditLog = mongoose.model('AuditLog', AuditLogSchema);

/* ════════════════════════════════════════════════════════════
   HELPERS
════════════════════════════════════════════════════════════ */
const signToken   = (payload, expiresIn = '12h') => jwt.sign(payload, JWT_SECRET, { expiresIn });
const verifyToken = (token) => jwt.verify(token, JWT_SECRET);

function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return res.status(401).json({ message: 'Unauthorized' });
  try { req.user = verifyToken(header.slice(7)); next(); }
  catch { return res.status(401).json({ message: 'Token expired or invalid' }); }
}

function requireSuperAdmin(req, res, next) {
  if (req.user?.role !== 'super_admin') return res.status(403).json({ message: 'Super Admin only' });
  next();
}

function requireAdmin(req, res, next) {
  if (!['admin', 'manager', 'super_admin'].includes(req.user?.role))
    return res.status(403).json({ message: 'Admin/Manager only' });
  next();
}

async function audit(action, severity, req, extra = {}) {
  try {
    await AuditLog.create({
      action, severity,
      userId:      req.user?._id || req.user?.id,
      username:    req.user?.username,
      displayName: req.user?.displayName,
      shopId:      extra.shopId,
      shopName:    extra.shopName,
      ipAddress:   req.ip || req.headers['x-forwarded-for'],
      details:     extra.details,
    });
  } catch (err) { console.error('Audit error:', err.message); }
}

/* ════════════════════════════════════════════════════════════
   RATE LIMITERS
════════════════════════════════════════════════════════════ */
const loginLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, max: 5, skipSuccessfulRequests: true,
  handler: (req, res) => res.status(429).json({ code: 'LOGIN_LOCKED', message: 'ගිණුම අගුළු දමා ඇත. මිනිත්තු 5කින් නැවත උත්සාහ කරන්න.', retryAfter: 300 }),
});
const apiLimiter = rateLimit({ windowMs: 60_000, max: 300 });
app.use('/api/', apiLimiter);

/* ════════════════════════════════════════════════════════════
   HEALTH / KEEP-ALIVE
   CHOREO-3: Choreo healthcheck probe '/health' use කරයි
   Choreo Console → Component → Health Check → Path: /health
════════════════════════════════════════════════════════════ */
app.get('/ping', (req, res) => res.status(200).json({
  status: 'ok',
  service: 'AD SOUTHERN SMART POS Backend',
  timestamp: new Date().toISOString(),
  uptime: process.uptime(),
}));
app.get('/health', (req, res) => res.status(200).json({
  status: 'ok',
  db: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
}));
app.get('/', (req, res) => res.json({ status: 'AD SOUTHERN SMART POS API — Online ✅', version: '1.0.0' }));

/* ════════════════════════════════════════════════════════════
   AUTH ROUTES
════════════════════════════════════════════════════════════ */
const authRouter = express.Router();

authRouter.post('/login', loginLimiter, async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ message: 'Username සහ Password ඇතුළත් කරන්න' });
  try {
    const user = await User.findOne({ username: username.toLowerCase().trim() });
    if (!user || !user.isActive) {
      await audit('LOGIN_FAIL', 'medium', { ip: req.ip, headers: req.headers, user: null }, { details: `Unknown: ${username}` });
      return res.status(401).json({ message: 'Username හෝ Password වැරදියි', attemptsLeft: null });
    }
    if (user.lockUntil && user.lockUntil > new Date()) {
      const retryAfter = Math.ceil((user.lockUntil - Date.now()) / 1000);
      return res.status(429).json({ code: 'LOGIN_LOCKED', message: 'ගිණුම අගුළු දමා ඇත.', retryAfter });
    }
    const valid = await user.comparePassword(password);
    if (!valid) {
      user.loginAttempts += 1;
      if (user.loginAttempts >= 5) { user.lockUntil = new Date(Date.now() + 5 * 60 * 1000); user.loginAttempts = 0; }
      await user.save();
      return res.status(401).json({ message: 'Username හෝ Password වැරදියි', attemptsLeft: Math.max(0, 5 - user.loginAttempts) });
    }
    user.loginAttempts = 0; user.lockUntil = null; await user.save();
    let shopDoc = null;
    if (user.shopId) shopDoc = await Shop.findById(user.shopId).select('name businessCategory stockTier isActive settings geminiApiKey').lean();
    const payload = { id: user._id, username: user.username, displayName: user.displayName, role: user.role, shopId: user.shopId };
    const token   = signToken(payload);
    await audit('LOGIN', 'low', { user: payload, ip: req.ip, headers: req.headers }, { shopId: user.shopId, shopName: shopDoc?.name, details: 'Successful login' });
    return res.json({ token, user: { _id: user._id, username: user.username, displayName: user.displayName, role: user.role, shopId: user.shopId, shop: shopDoc } });
  } catch (err) { return res.status(500).json({ message: 'Server error' }); }
});

authRouter.get('/me', requireAuth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('-password');
    if (!user || !user.isActive) return res.status(401).json({ message: 'User not found' });
    let shop = null;
    if (user.shopId) shop = await Shop.findById(user.shopId).select('name businessCategory stockTier isActive settings geminiApiKey').lean();
    return res.json({ user: { ...user.toObject(), shop } });
  } catch { return res.status(500).json({ message: 'Server error' }); }
});

authRouter.post('/logout', requireAuth, async (req, res) => {
  await audit('LOGOUT', 'low', req, { details: 'User logged out' });
  return res.json({ success: true });
});

authRouter.post('/verify-pin', requireAuth, async (req, res) => {
  const { pin } = req.body;
  if (!pin || !/^\d{4}$/.test(pin)) return res.status(400).json({ message: 'PIN ඉලක්කම් 4ක් ඇතුළත් කරන්න' });
  try {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ message: 'User හමු නොවීය' });

    // If user has no personal PIN yet, guide them to set one first
    if (!user.actionPin) {
      return res.status(403).json({
        code: 'PIN_NOT_SET',
        message: 'ඔබේ Personal PIN සකස් කර නොමැත. Settings > Security හි PIN Set කරන්න.'
      });
    }

    const valid = await user.comparePin(pin);
    if (!valid) return res.status(401).json({ message: 'PIN වැරදියි. නැවත උත්සාහ කරන්න.' });

    const pinToken = signToken({ ...req.user, pinVerified: true }, '2h');
    await audit('PIN_VERIFY', 'medium', req, { details: 'Layer 2 personal PIN verified' });
    return res.json({ success: true, pinToken });
  } catch (err) { return res.status(500).json({ message: err.message }); }
});

// POST /api/auth/set-pin — user ගේ own personal 4-digit PIN set / change
authRouter.post('/set-pin', requireAuth, async (req, res) => {
  const { pin, currentPin, currentPassword } = req.body;
  if (!pin || !/^\d{4}$/.test(pin)) return res.status(400).json({ message: 'PIN ඉලක්කම් 4ක් ඇතුළත් කරන්න' });
  try {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ message: 'User හමු නොවීය' });

    // If user already has a PIN, require current PIN OR current password to change
    if (user.actionPin) {
      const pinOk      = currentPin ? await user.comparePin(currentPin) : false;
      const passwordOk = currentPassword ? await user.comparePassword(currentPassword) : false;
      if (!pinOk && !passwordOk) {
        return res.status(401).json({ message: 'වත්මන් PIN හෝ Password නිවැරදිව ඇතුළත් කරන්න' });
      }
    }

    user.actionPin = pin;  // pre-save hook will bcrypt this
    user.pinSetAt  = new Date();
    await user.save();
    await audit('SET_PIN', 'medium', req, { details: 'Personal action PIN set/changed' });
    return res.json({ success: true, message: 'PIN සාර්ථකව සකස් කළා' });
  } catch (err) { return res.status(500).json({ message: err.message }); }
});

// GET /api/auth/pin-status — user ගේ PIN set කර ඇත්දැයි check
authRouter.get('/pin-status', requireAuth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('actionPin pinSetAt');
    return res.json({ pinSet: !!user?.actionPin, pinSetAt: user?.pinSetAt });
  } catch (err) { return res.status(500).json({ message: err.message }); }
});

authRouter.post('/verify-master-password', requireAuth, (req, res) => {
  const { masterPassword } = req.body;
  if (!masterPassword) return res.status(400).json({ message: 'Master Password ඇතුළත් කරන්න' });
  const master = process.env.MASTER_ACTION_PASSWORD || MASTER_ACTION_PASSWORD;
  if (masterPassword !== master) return res.status(401).json({ message: 'Master Password වැරදියි' });
  return res.json({ success: true });
});

// FIX: change-password route — api.js authAPI.changePassword() calls this
authRouter.put('/change-password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) return res.status(400).json({ message: 'currentPassword සහ newPassword අවශ්‍යයි' });
  if (newPassword.length < 8) return res.status(400).json({ message: 'නව Password min 8 chars' });
  try {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ message: 'User හමු නොවීය' });
    const valid = await user.comparePassword(currentPassword);
    if (!valid) return res.status(401).json({ message: 'වත්මන් Password වැරදියි' });
    user.password = newPassword;
    await user.save();
    await audit('CHANGE_PASSWORD', 'medium', req, { details: 'Password changed by user' });
    return res.json({ success: true });
  } catch (err) { return res.status(500).json({ message: err.message }); }
});

app.use('/api/auth', authRouter);

/* ════════════════════════════════════════════════════════════
   SUPER ADMIN ROUTES
════════════════════════════════════════════════════════════ */
const saRouter = express.Router();
saRouter.use(requireAuth, requireSuperAdmin);

saRouter.get('/dashboard', async (req, res) => {
  try {
    const [totalShops, activeShops, totalUsers] = await Promise.all([
      Shop.countDocuments(), Shop.countDocuments({ isActive: true }), User.countDocuments({ role: { $ne: 'super_admin' } }),
    ]);
    const tierCounts = await Shop.aggregate([{ $group: { _id: '$stockTier', count: { $sum: 1 } } }]);
    const tiers = { micro: 0, standard: 0, mega: 0, enterprise: 0 };
    tierCounts.forEach(t => { tiers[t._id] = t.count; });
    const recentActivity = await AuditLog.find().sort({ timestamp: -1 }).limit(10).lean();
    return res.json({ totalShops, activeShops, totalUsers, tierCounts: tiers, todayBills: '—', recentActivity });
  } catch (err) { return res.status(500).json({ message: err.message }); }
});

saRouter.get('/shops', async (req, res) => {
  try { return res.json({ shops: await Shop.find().sort({ createdAt: -1 }).lean() }); }
  catch (err) { return res.status(500).json({ message: err.message }); }
});

saRouter.post('/shops', async (req, res) => {
  const { shopName, businessCategory, stockTier, adminUsername, adminPassword, adminDisplayName, adminPin, masterPassword, geminiApiKey } = req.body;
  const master = process.env.MASTER_ACTION_PASSWORD || MASTER_ACTION_PASSWORD;
  if (!masterPassword || masterPassword !== master) return res.status(401).json({ message: 'Master Password වැරදියි' });
  if (!shopName || !businessCategory || !stockTier || !adminUsername || !adminPassword || !adminDisplayName || !adminPin)
    return res.status(400).json({ message: 'සියලු ක්ෂේත්‍ර අවශ්‍යයි' });
  if (adminPassword.length < 8) return res.status(400).json({ message: 'Admin Password min 8 chars' });
  // CHOREO-9: SA shop creation වෙලාවේම admin ගේ Layer 2 PIN එක direct set කරයි
  if (!/^\d{4}$/.test(adminPin)) return res.status(400).json({ message: 'Admin PIN ඉලක්කම් 4ක් ඇතුළත් කරන්න' });
  try {
    if (await User.findOne({ username: adminUsername.toLowerCase() })) return res.status(409).json({ message: 'Username දැනටමත් භාවිතයේ' });
    const shop = await Shop.create({
      name: shopName, businessCategory, stockTier,
      ownerUsername: adminUsername.toLowerCase(),
      geminiApiKey: (geminiApiKey || '').trim(),
    });
    const adminUser = await User.create({
      username: adminUsername.toLowerCase(),
      displayName: adminDisplayName,
      password: adminPassword,
      actionPin: adminPin,   // pre-save hook bcrypt කරයි
      pinSetAt: new Date(),
      role: 'admin',
      shopId: shop._id,
    });
    await audit('CREATE_SHOP', 'high', req, { shopId: shop._id, shopName: shop.name, details: `Admin: ${adminUsername} (PIN pre-set by SA)` });
    return res.status(201).json({ shop, adminUser: { _id: adminUser._id, username: adminUser.username } });
  } catch (err) { return res.status(500).json({ message: err.message }); }
});

saRouter.patch('/shops/:shopId/gemini-key', async (req, res) => {
  const { geminiApiKey } = req.body;
  if (geminiApiKey === undefined) return res.status(400).json({ message: 'geminiApiKey field අවශ්‍යයි' });
  try {
    const shop = await Shop.findByIdAndUpdate(
      req.params.shopId,
      { geminiApiKey: geminiApiKey.trim() },
      { new: true }
    );
    if (!shop) return res.status(404).json({ message: 'Shop හමු නොවීය' });
    await audit('UPDATE_GEMINI_KEY', 'medium', req, { shopId: shop._id, shopName: shop.name, details: geminiApiKey ? 'Key set' : 'Key cleared' });
    return res.json({ success: true, shop: { _id: shop._id, name: shop.name, geminiApiKey: shop.geminiApiKey } });
  } catch (err) { return res.status(500).json({ message: err.message }); }
});

saRouter.patch('/shops/:shopId/tier', async (req, res) => {
  const { stockTier } = req.body;
  if (!['micro','standard','mega','enterprise'].includes(stockTier)) return res.status(400).json({ message: 'Invalid tier' });
  try {
    const shop = await Shop.findByIdAndUpdate(req.params.shopId, { stockTier }, { new: true });
    await audit('TIER_CHANGE', 'medium', req, { shopId: shop._id, shopName: shop.name, details: `Tier → ${stockTier}` });
    return res.json({ shop });
  } catch (err) { return res.status(500).json({ message: err.message }); }
});

saRouter.put('/shops/:shopId', async (req, res) => {
  const allowed = ['name','businessCategory','stockTier','isActive','ownerUsername','geminiApiKey'];
  const update  = {};
  allowed.forEach(k => { if (req.body[k] !== undefined) update[k] = req.body[k]; });
  try {
    const shop = await Shop.findByIdAndUpdate(req.params.shopId, update, { new: true });
    if (!shop) return res.status(404).json({ message: 'Shop හමු නොවීය' });
    return res.json({ shop });
  } catch (err) { return res.status(500).json({ message: err.message }); }
});

saRouter.put('/shops/:shopId/toggle', async (req, res) => {
  try {
    const shop = await Shop.findById(req.params.shopId);
    if (!shop) return res.status(404).json({ message: 'Shop හමු නොවීය' });
    shop.isActive = !shop.isActive; await shop.save();
    await audit('SHOP_TOGGLE', 'medium', req, { shopId: shop._id, shopName: shop.name });
    return res.json({ shop });
  } catch (err) { return res.status(500).json({ message: err.message }); }
});

saRouter.get('/shops/:shopId', async (req, res) => {
  try {
    const shop = await Shop.findById(req.params.shopId).lean();
    if (!shop) return res.status(404).json({ message: 'Shop හමු නොවීය' });
    return res.json({ shop });
  } catch (err) { return res.status(500).json({ message: err.message }); }
});

saRouter.delete('/shops/:shopId', async (req, res) => {
  const { confirmation, masterPassword } = req.body;
  if (confirmation !== 'YES') return res.status(400).json({ message: '"YES" ලෙස ටයිප් කළ යුතුය' });
  const master = process.env.MASTER_ACTION_PASSWORD || MASTER_ACTION_PASSWORD;
  if (!masterPassword || masterPassword !== master) return res.status(401).json({ message: 'Master Password වැරදියි' });
  try {
    const shop = await Shop.findById(req.params.shopId);
    if (!shop) return res.status(404).json({ message: 'Shop හමු නොවීය' });
    await User.deleteMany({ shopId: shop._id });
    await Shop.findByIdAndDelete(shop._id);
    await audit('DELETE_SHOP', 'high', req, { shopId: shop._id, shopName: shop.name });
    return res.json({ success: true });
  } catch (err) { return res.status(500).json({ message: err.message }); }
});

saRouter.get('/users', async (req, res) => {
  try { return res.json({ users: await User.find().select('-password').sort({ createdAt: -1 }).lean() }); }
  catch (err) { return res.status(500).json({ message: err.message }); }
});

saRouter.post('/users', async (req, res) => {
  const { displayName, username, password, role, shopId } = req.body;
  if (!displayName || !username || !password || !role || !shopId) return res.status(400).json({ message: 'සියලු ක්ෂේත්‍ර අවශ්‍යයි' });
  if (password.length < 8) return res.status(400).json({ message: 'Password min 8 chars' });
  try {
    if (await User.findOne({ username: username.toLowerCase() })) return res.status(409).json({ message: 'Username දැනටමත් භාවිතයේ' });
    const user = await User.create({ displayName, username: username.toLowerCase(), password, role, shopId });
    await audit('CREATE_USER', 'medium', req, { shopId, details: `${username} (${role})` });
    return res.status(201).json({ user: { ...user.toObject(), password: undefined } });
  } catch (err) { return res.status(500).json({ message: err.message }); }
});

saRouter.patch('/users/:userId', async (req, res) => {
  try {
    const user = await User.findByIdAndUpdate(req.params.userId, req.body, { new: true }).select('-password');
    await audit('UPDATE_USER', 'medium', req, { details: `Update: ${user.username}` });
    return res.json({ user });
  } catch (err) { return res.status(500).json({ message: err.message }); }
});

saRouter.put('/users/:userId/reset-password', async (req, res) => {
  const { newPassword } = req.body;
  if (!newPassword || newPassword.length < 8) return res.status(400).json({ message: 'Password min 8 chars' });
  try {
    const user = await User.findById(req.params.userId);
    if (!user) return res.status(404).json({ message: 'User හමු නොවීය' });
    user.password = newPassword; await user.save();
    await audit('RESET_PASSWORD', 'high', req, { details: `Reset: ${user.username}` });
    return res.json({ success: true });
  } catch (err) { return res.status(500).json({ message: err.message }); }
});

saRouter.delete('/users/:userId', async (req, res) => {
  const { confirmation, masterPassword } = req.body;
  if (confirmation !== 'YES') return res.status(400).json({ message: '"YES" ලෙස ටයිප් කළ යුතුය' });
  const master = process.env.MASTER_ACTION_PASSWORD || MASTER_ACTION_PASSWORD;
  if (!masterPassword || masterPassword !== master) return res.status(401).json({ message: 'Master Password වැරදියි' });
  try {
    const user = await User.findByIdAndDelete(req.params.userId).select('-password');
    if (!user) return res.status(404).json({ message: 'User හමු නොවීය' });
    await audit('DELETE_USER', 'high', req, { details: `Deleted: ${user.username}` });
    return res.json({ success: true });
  } catch (err) { return res.status(500).json({ message: err.message }); }
});

saRouter.post('/ghost/:shopId', async (req, res) => {
  try {
    const shop = await Shop.findById(req.params.shopId);
    if (!shop) return res.status(404).json({ message: 'Shop හමු නොවීය' });
    if (!shop.isActive) return res.status(400).json({ message: 'Shop අක්‍රීයයි' });
    const adminUser = await User.findOne({ shopId: shop._id, role: 'admin' }).select('-password');
    if (!adminUser) return res.status(404).json({ message: 'Shop Admin හමු නොවීය' });
    const ghostToken = signToken({ id: adminUser._id, username: adminUser.username, displayName: adminUser.displayName, role: adminUser.role, shopId: adminUser.shopId, isGhost: true, ghostBy: req.user.username }, '4h');
    await audit('GHOST_LOGIN', 'high', req, { shopId: shop._id, shopName: shop.name, details: `${req.user.username} → ${shop.name}` });
    return res.json({ ghostToken, targetUser: adminUser });
  } catch (err) { return res.status(500).json({ message: err.message }); }
});

saRouter.get('/audit', async (req, res) => {
  const { page = 1, limit = 25, search, severity, action, dateFrom, dateTo } = req.query;
  const query = {};
  if (severity && severity !== 'all') query.severity = severity;
  if (action   && action   !== 'all') query.action   = action;
  if (dateFrom || dateTo) { query.timestamp = {}; if (dateFrom) query.timestamp.$gte = new Date(dateFrom); if (dateTo) query.timestamp.$lte = new Date(dateTo + 'T23:59:59'); }
  if (search) query.$or = [{ username: { $regex: search, $options: 'i' } }, { shopName: { $regex: search, $options: 'i' } }, { action: { $regex: search, $options: 'i' } }, { details: { $regex: search, $options: 'i' } }];
  try {
    const total = await AuditLog.countDocuments(query);
    const logs  = await AuditLog.find(query).sort({ timestamp: -1 }).skip((+page - 1) * +limit).limit(+limit).lean();
    return res.json({ logs, total, totalPages: Math.ceil(total / +limit), page: +page });
  } catch (err) { return res.status(500).json({ message: err.message }); }
});

saRouter.get('/audit/export', async (req, res) => {
  const { severity, action, dateFrom, dateTo } = req.query;
  const query = {};
  if (severity && severity !== 'all') query.severity = severity;
  if (action   && action   !== 'all') query.action   = action;
  if (dateFrom || dateTo) { query.timestamp = {}; if (dateFrom) query.timestamp.$gte = new Date(dateFrom); if (dateTo) query.timestamp.$lte = new Date(dateTo + 'T23:59:59'); }
  try {
    const logs = await AuditLog.find(query).sort({ timestamp: -1 }).limit(5000).lean();
    const header = 'Timestamp,Action,Severity,Username,DisplayName,Shop,IP,Details\n';
    const rows = logs.map(l => [new Date(l.timestamp).toISOString(), l.action, l.severity, l.username, l.displayName, l.shopName || '', l.ipAddress || '', `"${(l.details || '').replace(/"/g, '""')}"`].join(',')).join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=audit-${Date.now()}.csv`);
    return res.send(header + rows);
  } catch (err) { return res.status(500).json({ message: err.message }); }
});

app.use('/api/super-admin', saRouter);

/* ════════════════════════════════════════════════════════════
   MODULE 3+4 BILLING ROUTES
════════════════════════════════════════════════════════════ */
setupBillingRoutes(app, { requireAuth, audit, Shop, User });

/* ════════════════════════════════════════════════════════════
   MODULE 5 ROUTES
════════════════════════════════════════════════════════════ */
setupModule5(app, mongoose);

/* ════════════════════════════════════════════════════════════
   ADMIN STAFF ROUTES
════════════════════════════════════════════════════════════ */
const staffRouter = express.Router();
staffRouter.use(requireAuth);

staffRouter.get('/', async (req, res) => {
  try {
    const staff = await User.find({ shopId: req.user.shopId, role: { $in: ['manager', 'cashier'] } }).select('-password').sort({ createdAt: -1 }).lean();
    return res.json({ staff });
  } catch (err) { return res.status(500).json({ message: err.message }); }
});

staffRouter.post('/', async (req, res) => {
  const { displayName, username, password, role } = req.body;
  if (!displayName || !username || !password || !role) return res.status(400).json({ message: 'සියලු ක්ෂේත්‍ර අවශ්‍යයි' });
  if (!['manager', 'cashier'].includes(role)) return res.status(400).json({ message: 'Role: manager/cashier' });
  if (password.length < 8) return res.status(400).json({ message: 'Password min 8 chars' });
  try {
    if (await User.findOne({ username: username.toLowerCase() })) return res.status(409).json({ message: 'Username දැනටමත් භාවිතයේ' });
    const staff = await User.create({ displayName, username: username.toLowerCase(), password, role, shopId: req.user.shopId });
    await audit('CREATE_STAFF', 'medium', req, { shopId: req.user.shopId, details: `${username} (${role})` });
    return res.status(201).json({ staff: { ...staff.toObject(), password: undefined } });
  } catch (err) { return res.status(500).json({ message: err.message }); }
});

staffRouter.put('/:id/reset-password', async (req, res) => {
  const { newPassword } = req.body;
  if (!newPassword || newPassword.length < 8) return res.status(400).json({ message: 'Password min 8 chars' });
  try {
    const member = await User.findOne({ _id: req.params.id, shopId: req.user.shopId });
    if (!member) return res.status(404).json({ message: 'Staff හමු නොවීය' });
    member.password = newPassword; await member.save();
    await audit('RESET_STAFF_PASSWORD', 'high', req, { shopId: req.user.shopId, details: member.username });
    return res.json({ success: true });
  } catch (err) { return res.status(500).json({ message: err.message }); }
});

// PUT /api/admin/staff/:id/reset-pin — Admin staff ගේ PIN reset කිරීමට (clear කිරීමට)
staffRouter.put('/:id/reset-pin', async (req, res) => {
  try {
    const member = await User.findOne({ _id: req.params.id, shopId: req.user.shopId, role: { $in: ['manager', 'cashier'] } });
    if (!member) return res.status(404).json({ message: 'Staff හමු නොවීය' });
    member.actionPin = null;
    member.pinSetAt  = null;
    await member.save();
    await audit('RESET_STAFF_PIN', 'high', req, { shopId: req.user.shopId, details: `PIN cleared for ${member.username}` });
    return res.json({ success: true, message: `${member.displayName} ගේ PIN Reset කළා — ඔවුන් ලෝගින් වී නව PIN set කළ යුතුය` });
  } catch (err) { return res.status(500).json({ message: err.message }); }
});

// PUT /api/admin/staff/:id — update staff (api.js: adminAPI.updateStaff)
staffRouter.put('/:id', async (req, res) => {
  const allowed = ['displayName', 'role', 'isActive'];
  const update  = {};
  allowed.forEach(k => { if (req.body[k] !== undefined) update[k] = req.body[k]; });
  if (update.role && !['manager', 'cashier'].includes(update.role))
    return res.status(400).json({ message: 'Role: manager/cashier පමණි' });
  try {
    const member = await User.findOneAndUpdate(
      { _id: req.params.id, shopId: req.user.shopId, role: { $in: ['manager', 'cashier'] } },
      update, { new: true }
    ).select('-password');
    if (!member) return res.status(404).json({ message: 'Staff හමු නොවීය' });
    await audit('UPDATE_STAFF', 'medium', req, { shopId: req.user.shopId, details: member.username });
    return res.json({ staff: member });
  } catch (err) { return res.status(500).json({ message: err.message }); }
});

staffRouter.delete('/:id', async (req, res) => {
  try {
    const member = await User.findOneAndDelete({ _id: req.params.id, shopId: req.user.shopId, role: { $in: ['manager','cashier'] } });
    if (!member) return res.status(404).json({ message: 'Staff හමු නොවීය' });
    await audit('DELETE_STAFF', 'high', req, { shopId: req.user.shopId, details: member.username });
    return res.json({ success: true });
  } catch (err) { return res.status(500).json({ message: err.message }); }
});

app.use('/api/admin/staff', staffRouter);

/* ════════════════════════════════════════════════════════════
   ADMIN AUDIT LOGS
════════════════════════════════════════════════════════════ */
const adminAuditRouter = express.Router();
adminAuditRouter.use(requireAuth);

adminAuditRouter.get('/', async (req, res) => {
  const { page = 1, limit = 20, search } = req.query;
  const shopId = req.user.shopId;
  if (!shopId) return res.status(400).json({ message: 'Shop ID නොමැත' });
  const query = { shopId };
  if (search) query.$or = [{ action: { $regex: search, $options: 'i' } }, { username: { $regex: search, $options: 'i' } }, { details: { $regex: search, $options: 'i' } }];
  try {
    const total = await AuditLog.countDocuments(query);
    const logs  = await AuditLog.find(query).sort({ timestamp: -1 }).skip((+page - 1) * +limit).limit(+limit).lean();
    return res.json({ logs, total, totalPages: Math.ceil(total / +limit), page: +page });
  } catch (err) { return res.status(500).json({ message: err.message }); }
});

app.use('/api/admin/audit', adminAuditRouter);

/* ════════════════════════════════════════════════════════════
   OCR ROUTE — CHOREO-5: Per-shop Gemini key → global key fallback
════════════════════════════════════════════════════════════ */
const ocrRouter = express.Router();
ocrRouter.use(requireAuth);

ocrRouter.post('/', async (req, res) => {
  const { image } = req.body;
  if (!image) return res.status(400).json({ message: 'image (base64) අවශ්‍යයි' });

  let GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_KEY || '';
  if (req.user.shopId) {
    try {
      const shop = await Shop.findById(req.user.shopId).select('geminiApiKey settings').lean();
      const shopKey = shop?.geminiApiKey || shop?.settings?.geminiApiKey || '';
      if (shopKey) GEMINI_API_KEY = shopKey;
    } catch (_) { /* fallback to global */ }
  }

  if (!GEMINI_API_KEY) return res.status(503).json({ message: 'Gemini API Key නොමැත. Settings හි set කරන්න.' });

  try {
    const geminiRes = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      { contents: [{ parts: [{ text: `Extract ALL products from this invoice. Return ONLY valid JSON array:\n[{"name":"","qty":1,"unit":"Nos","costPrice":0,"sellingPrice":0,"barcode":"","category":""}]\nReturn [] if no items found.` }, { inline_data: { mime_type: 'image/jpeg', data: image } }] }], generationConfig: { temperature: 0.1, maxOutputTokens: 4096 } },
      { timeout: 30000 }
    );
    const rawText = geminiRes.data?.candidates?.[0]?.content?.parts?.[0]?.text || '[]';
    let items = [];
    try { items = JSON.parse(rawText.replace(/```json|```/g, '').trim()); } catch { items = []; }
    if (!Array.isArray(items)) items = [];
    return res.json({ items, source: 'gemini' });
  } catch (err) { return res.status(502).json({ message: 'Gemini OCR failed', error: err.message }); }
});

ocrRouter.post('/bulk-import', async (req, res) => {
  const { items } = req.body;
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ message: 'Items array අවශ්‍යයි' });
  const shopId      = req.user.shopId;
  const InventoryItem = mongoose.models.InventoryItem;
  if (!InventoryItem) return res.status(503).json({ message: 'Inventory model ready නැත' });
  const shop      = await Shop.findById(shopId).lean();
  const tierLimits = { micro: 1500, standard: 15000, mega: 60000, enterprise: Infinity };
  const tierLimit  = tierLimits[shop?.stockTier] || 15000;
  const results    = { created: 0, skipped: 0, errors: [] };
  for (const item of items) {
    try {
      if (!item.name || item.costPrice == null) { results.skipped++; continue; }
      if (await InventoryItem.countDocuments({ shopId, isActive: true }) >= tierLimit) { results.skipped++; continue; }
      await InventoryItem.create({ shopId, name: item.name, sku: item.sku || `OCR-${Date.now()}-${results.created}`, barcode: item.barcode || '', category: item.category || 'Other', unit: item.unit || 'Nos', quantity: Number(item.qty) || 0, costPrice: Number(item.costPrice) || 0, sellingPrice: Number(item.sellingPrice) || Number(item.costPrice) * 1.15 || 0 });
      results.created++;
    } catch (err) { results.errors.push({ name: item.name, error: err.message }); }
  }
  return res.json({ success: true, results });
});

app.use('/api/admin/items/ocr', ocrRouter);

/* ════════════════════════════════════════════════════════════
   ADMIN DASHBOARD
════════════════════════════════════════════════════════════ */
const adminDashRouter = express.Router();
adminDashRouter.use(requireAuth, requireAdmin);

adminDashRouter.get('/', async (req, res) => {
  try {
    const shopId     = req.user.shopId;
    const todayStart = new Date(); todayStart.setHours(0,0,0,0);
    let pendingCheques = 0;
    try { if (mongoose.models.Cheque) pendingCheques = await mongoose.models.Cheque.countDocuments({ shopId, isCashed: false }); } catch (_) {}
    let totalItems = 0, lowStockItems = [], expiringItems = [];
    if (mongoose.models.InventoryItem) {
      const Item             = mongoose.models.InventoryItem;
      const shop             = await Shop.findById(shopId).lean();
      const lowStockDefault  = shop?.settings?.lowStockDefault || 10;
      const expiryDate       = new Date(Date.now() + 30 * 86400000);
      [totalItems, lowStockItems, expiringItems] = await Promise.all([
        Item.countDocuments({ shopId }),
        Item.find({ shopId, quantity: { $lte: lowStockDefault } }).select('name quantity').lean(),
        Item.find({ shopId, expiryDate: { $lte: expiryDate, $gte: new Date() } }).select('name expiryDate').lean().then(items => items.map(i => ({ ...i, daysLeft: Math.ceil((new Date(i.expiryDate) - Date.now()) / 86400000) }))),
      ]);
    }
    let todayBills = 0, todayRevenue = 0, recentBills = [];
    if (mongoose.models.Bill) {
      const Bill = mongoose.models.Bill;
      [todayBills, todayRevenue, recentBills] = await Promise.all([
        Bill.countDocuments({ shopId, isVoided: false, createdAt: { $gte: todayStart } }),
        Bill.aggregate([{ $match: { shopId: new mongoose.Types.ObjectId(shopId), isVoided: false, createdAt: { $gte: todayStart } } }, { $group: { _id: null, total: { $sum: '$total' } } }]).then(r => r[0]?.total || 0),
        Bill.find({ shopId, isVoided: false }).sort({ createdAt: -1 }).limit(10).select('billNumber cashierName total createdAt items').lean().then(bills => bills.map(b => ({ ...b, itemCount: b.items?.length || 0 }))),
      ]);
    }
    return res.json({ totalItems, lowStockItems, expiringItems, todayBills, todayRevenue, recentBills, pendingCheques });
  } catch (err) { return res.status(500).json({ message: err.message }); }
});

app.use('/api/admin/dashboard', adminDashRouter);

/* ════════════════════════════════════════════════════════════
   ADMIN SETTINGS — CHOREO-7: geminiApiKey save/load
════════════════════════════════════════════════════════════ */
const adminSettingsRouter = express.Router();
adminSettingsRouter.use(requireAuth, requireAdmin);

adminSettingsRouter.get('/', async (req, res) => {
  try {
    const shop = await Shop.findById(req.user.shopId).lean();
    if (!shop) return res.status(404).json({ message: 'Shop හමු නොවීය' });
    return res.json({
      settings: {
        ...shop.settings,
        geminiApiKey: shop.geminiApiKey || shop.settings?.geminiApiKey || '',
      }
    });
  } catch (err) { return res.status(500).json({ message: err.message }); }
});

adminSettingsRouter.put('/', async (req, res) => {
  const allowed = ['cosmeticSavingsPercent','lowStockDefault','voiceAlerts','whatsappEnabled','whatsappPhoneNumber','shopDisplayName','receiptFooter','geminiApiKey'];
  const update  = {};
  allowed.forEach(k => { if (req.body[k] !== undefined) update[`settings.${k}`] = req.body[k]; });
  if (req.body.geminiApiKey !== undefined) {
    update['geminiApiKey'] = req.body.geminiApiKey.trim();
  }
  try {
    const shop = await Shop.findByIdAndUpdate(req.user.shopId, { $set: update }, { new: true });
    if (!shop) return res.status(404).json({ message: 'Shop හමු නොවීය' });
    await audit('UPDATE_SETTINGS', 'low', req, { shopId: shop._id, shopName: shop.name });
    return res.json({ success: true, settings: { ...shop.settings, geminiApiKey: shop.geminiApiKey } });
  } catch (err) { return res.status(500).json({ message: err.message }); }
});

app.use('/api/admin/settings', adminSettingsRouter);

/* ════════════════════════════════════════════════════════════
   FINANCIAL MATRIX (api.js FIX-1 route)
════════════════════════════════════════════════════════════ */
app.get('/api/admin/finance/matrix', requireAuth, requireAdmin, async (req, res) => {
  try {
    const shopId = req.user.shopId;
    if (!mongoose.models.InventoryItem) return res.json({ totalCostValue: 0, totalSellingValue: 0, totalNetProfit: 0, profitMarginPercent: 0 });
    const result = await mongoose.models.InventoryItem.aggregate([{ $match: { shopId: new mongoose.Types.ObjectId(shopId) } }, { $group: { _id: null, totalCostValue: { $sum: { $multiply: ['$costPrice', '$quantity'] } }, totalSellingValue: { $sum: { $multiply: ['$sellingPrice', '$quantity'] } } } }]);
    const { totalCostValue = 0, totalSellingValue = 0 } = result[0] || {};
    const totalNetProfit = totalSellingValue - totalCostValue;
    return res.json({ totalCostValue, totalSellingValue, totalNetProfit, profitMarginPercent: totalSellingValue > 0 ? (totalNetProfit / totalSellingValue) * 100 : 0 });
  } catch (err) { return res.status(500).json({ message: err.message }); }
});

/* ════════════════════════════════════════════════════════════
   SUPER ADMIN AUTO-CREATE
════════════════════════════════════════════════════════════ */
async function ensureSuperAdmin() {
  const exists = await User.findOne({ role: 'super_admin' });
  if (!exists) {
    await User.create({
      username:    process.env.SA_USERNAME    || 'superadmin',
      displayName: process.env.SA_DISPLAYNAME || 'Super Admin',
      password:    process.env.SA_PASSWORD    || 'SuperAdmin@123',
      role:        'super_admin',
    });
    console.log('✅ Super Admin created — SA_PASSWORD env var change කරන්න!');
  }
}
mongoose.connection.once('open', () => ensureSuperAdmin().catch(console.error));

/* ════════════════════════════════════════════════════════════
   START
════════════════════════════════════════════════════════════ */
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 AD SOUTHERN SMART POS Backend — port ${PORT}`);
});

module.exports = app;

/* ── Anti-crash shield ── */
process.on('unhandledRejection', (r) => console.error('❌ Unhandled Rejection:', r));
process.on('uncaughtException',  (e) => console.error('❌ Uncaught Exception:', e.message));
app.use((err, req, res, next) => res.status(500).json({ success: false, message: err.message }));
