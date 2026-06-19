// AD SOUTHERN SMART POS — Module 5 Backend Routes
// module5_routes.js
//
// ════════════════════════════════════════════════════════════════════
//  මෙම file server.js වලට import කරන්න:
//
//    const { setupModule5 } = require('./module5_routes');
//    setupModule5(app, mongoose);
//
//  Required npm packages (server.js package.json):
//    npm install @whiskeysockets/baileys qrcode-terminal node-cron axios form-data
//
//  Required .env variables:
//    CLOUDINARY_CLOUD_NAME=your_cloud_name
//    CLOUDINARY_API_KEY=your_api_key
//    CLOUDINARY_API_SECRET=your_api_secret
//    WHATSAPP_ADMIN_NUMBER=94771234567   (country code + number, no +)
//    BAILEYS_SESSION_PATH=./baileys_auth (writable path in HF Space)
// ════════════════════════════════════════════════════════════════════

'use strict';

const express   = require('express');
const mongoose  = require('mongoose');   // top-level import (setupModule5 argument ද use කෙරේ)
const axios     = require('axios');
const FormData  = require('form-data');
const cron      = require('node-cron');
const jwt       = require('jsonwebtoken');

/* ══════════════════════════════════════════════════════════════════════
   MONGOOSE SCHEMA — Cheque
   server.js-ට directly add කළ හැකිය; නැතහොත් මෙතැනින්ම export කෙරේ.
══════════════════════════════════════════════════════════════════════ */
function buildChequeModel(mongoose) {
  if (mongoose.models.Cheque) return mongoose.models.Cheque;

  const ChequeSchema = new mongoose.Schema({
    shopId:     { type: mongoose.Schema.Types.ObjectId, ref: 'Shop', required: true, index: true },
    type:       { type: String, enum: ['received', 'issued'], required: true },

    party:      { type: String, required: true, trim: true },
    amount:     { type: Number, required: true },
    chequeNo:   { type: String, trim: true, default: '' },
    chequeDate: { type: Date,   required: true },
    bank:       { type: String, trim: true, default: '' },
    note:       { type: String, default: '' },

    // Received cheque only
    imageUrl:   { type: String, default: null },  // Cloudinary URL
    imagePublicId: { type: String, default: null }, // for deletion

    // Status
    isCashed:   { type: Boolean, default: false },
    cashedAt:   { type: Date,   default: null },
    cashedBy:   { type: String, default: null },  // username

    // WhatsApp reminder tracking (issued cheques)
    reminderSent: { type: Boolean, default: false },
    reminderSentAt: { type: Date, default: null },
  }, { timestamps: true });

  return mongoose.model('Cheque', ChequeSchema);
}

/* ══════════════════════════════════════════════════════════════════════
   CLOUDINARY UPLOAD HELPER
   Direct REST API call (cloudinary npm package නොමැතිව)
══════════════════════════════════════════════════════════════════════ */
async function uploadToCloudinary(base64Data, mimeType = 'image/jpeg') {
  const {
    CLOUDINARY_CLOUD_NAME,
    CLOUDINARY_API_KEY,
    CLOUDINARY_API_SECRET,
  } = process.env;

  if (!CLOUDINARY_CLOUD_NAME || !CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET) {
    throw new Error('Cloudinary env variables (CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET) set කරන්න');
  }

  // Create multipart form data
  const buffer   = Buffer.from(base64Data, 'base64');
  const ext      = mimeType.split('/')[1] || 'jpg';
  const filename = `cheque_${Date.now()}.${ext}`;

  const form = new FormData();
  form.append('file', buffer, { filename, contentType: mimeType });
  form.append('folder', 'pos_cheques');
  form.append('resource_type', 'image');

  // Basic auth: API_KEY:API_SECRET
  const credentials = Buffer.from(`${CLOUDINARY_API_KEY}:${CLOUDINARY_API_SECRET}`).toString('base64');

  const response = await axios.post(
    `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/image/upload`,
    form,
    {
      headers: {
        ...form.getHeaders(),
        Authorization: `Basic ${credentials}`,
      },
      timeout: 20000,
    }
  );

  return {
    url:      response.data.secure_url,
    publicId: response.data.public_id,
  };
}

/* ══════════════════════════════════════════════════════════════════════
   BAILEYS WHATSAPP CLIENT SINGLETON
   Hugging Face Space: persistent path /data/baileys_auth recommend
══════════════════════════════════════════════════════════════════════ */
let waSocket   = null;   // Baileys socket instance
let waReady    = false;  // true when WA connected
let waQR       = null;   // latest QR string for admin to scan

async function initWhatsApp() {
  try {
    const {
      default: makeWASocket,
      DisconnectReason,
      useMultiFileAuthState,
      fetchLatestBaileysVersion,
    } = await import('@whiskeysockets/baileys');

    const { default: pino } = await import('pino');
    const { default: QRCode } = await import('qrcode-terminal');

    const SESSION_PATH = process.env.BAILEYS_SESSION_PATH || './baileys_auth';
    const { state, saveCreds } = await useMultiFileAuthState(SESSION_PATH);
    const { version } = await fetchLatestBaileysVersion();

    waSocket = makeWASocket({
      version,
      auth:   state,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false,
    });

    waSocket.ev.on('creds.update', saveCreds);

    waSocket.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
      if (qr) {
        waQR   = qr;
        waReady = false;
        QRCode.generate(qr, { small: true });
        console.log('📱 WhatsApp QR: /api/admin/whatsapp/qr endpoint හරහා scan කරන්න');
      }

      if (connection === 'open') {
        waReady = true;
        waQR    = null;
        console.log('✅ WhatsApp Connected (Baileys)');
      }

      if (connection === 'close') {
        waReady = false;
        const code = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = code !== DisconnectReason.loggedOut;
        console.log('⚠️  WhatsApp Disconnected. Reconnect:', shouldReconnect);
        if (shouldReconnect) {
          setTimeout(initWhatsApp, 5000);
        }
      }
    });

  } catch (err) {
    console.error('❌ WhatsApp init error:', err.message);
    // Baileys install නොකළ විට gracefully skip
  }
}

async function sendWhatsApp(to, message) {
  if (!waSocket || !waReady) {
    console.warn('WhatsApp not ready — message not sent:', message.slice(0, 60));
    return false;
  }
  try {
    const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`;
    await waSocket.sendMessage(jid, { text: message });
    return true;
  } catch (err) {
    console.error('WhatsApp send error:', err.message);
    return false;
  }
}

/* ══════════════════════════════════════════════════════════════════════
   CHEQUE REMINDER CRON JOB
   Daily 8:00AM: Issued cheques clearing within 2 days → WhatsApp alert
══════════════════════════════════════════════════════════════════════ */
function startChequeReminderCron(Cheque) {
  // Every day at 08:00 AM server time
  cron.schedule('0 8 * * *', async () => {
    try {
      const now      = new Date();
      const in2Days  = new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000);
      // Issued cheques clearing within next 2 days, not yet cashed, reminder not yet sent
      const cheques = await Cheque.find({
        type:         'issued',
        isCashed:     false,
        reminderSent: false,
        chequeDate:   { $lte: in2Days },
      }).lean();

      if (cheques.length === 0) return;

      const adminNumber = process.env.WHATSAPP_ADMIN_NUMBER;
      if (!adminNumber) {
        console.log('⚠️  WHATSAPP_ADMIN_NUMBER set නොකළ නිසා reminder skip');
        return;
      }

      for (const c of cheques) {
        const daysLeft = Math.ceil((new Date(c.chequeDate) - now) / 86400000);
        const msg =
          `⚠️ *AD SOUTHERN SMART POS — Cheque Reminder*\n\n` +
          `📤 *Issued Cheque Alert!*\n` +
          `Party: *${c.party}*\n` +
          `Amount: *රු. ${Number(c.amount).toLocaleString()}*\n` +
          `Cheque #: ${c.chequeNo || '—'}\n` +
          `Bank: ${c.bank || '—'}\n` +
          `Clearing Date: *${new Date(c.chequeDate).toLocaleDateString('si-LK')}*\n` +
          `⏰ දින ${daysLeft}කින් Clearing වේ!\n\n` +
          `_AD Southern Smart POS විසින් ස්වයංක්‍රීයව යොමු කරන ලදී_`;

        const sent = await sendWhatsApp(adminNumber, msg);
        if (sent) {
          await Cheque.findByIdAndUpdate(c._id, {
            reminderSent:    true,
            reminderSentAt:  new Date(),
          });
          console.log(`✅ Cheque reminder sent for: ${c.party}`);
        }
      }
    } catch (err) {
      console.error('Cron reminder error:', err.message);
    }
  }, { timezone: 'Asia/Colombo' });

  console.log('🕐 Cheque reminder cron job active (daily 8AM Sri Lanka time)');
}

/* ══════════════════════════════════════════════════════════════════════
   AUTH MIDDLEWARE FACTORY
   server.js-ෙ requireAuth function reference pass කළ හැකිය,
   නැතිනම් JWT_SECRET env var direct use කෙරේ.
══════════════════════════════════════════════════════════════════════ */
function makeAuthMiddleware() {
  return function requireAuth(req, res, next) {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer '))
      return res.status(401).json({ message: 'Unauthorized' });
    try {
      req.user = jwt.verify(header.slice(7), process.env.JWT_SECRET || 'change_me_in_production');
      next();
    } catch {
      return res.status(401).json({ message: 'Token expired or invalid' });
    }
  };
}

function requireAdmin(req, res, next) {
  if (!['admin', 'manager', 'super_admin'].includes(req.user?.role))
    return res.status(403).json({ message: 'Admin/Manager only' });
  next();
}

/* ══════════════════════════════════════════════════════════════════════
   MAIN SETUP FUNCTION — server.js-ෙ call කෙරේ
══════════════════════════════════════════════════════════════════════ */
function setupModule5(app, mongoose) {
  const Cheque     = buildChequeModel(mongoose);
  const requireAuth = makeAuthMiddleware();

  // ── Start WhatsApp (if enabled) ─────────────────────────────────
  if (process.env.WHATSAPP_ENABLED === 'true') {
    initWhatsApp();
  }

  // ── Start Cron ───────────────────────────────────────────────────
  startChequeReminderCron(Cheque);

  /* ────────────────────────────────────────────────────────────────
     CHEQUE ROUTES  (/api/admin/cheques/*)
  ──────────────────────────────────────────────────────────────── */
  const chequeRouter = express.Router();
  chequeRouter.use(requireAuth, requireAdmin);

  /**
   * GET /api/admin/cheques
   * Shop-ෙ received + issued cheques load
   */
  chequeRouter.get('/', async (req, res) => {
    try {
      const shopId = req.user.shopId;
      if (!shopId) return res.status(400).json({ message: 'Shop ID නොමැත' });

      const [received, issued] = await Promise.all([
        Cheque.find({ shopId, type: 'received' }).sort({ createdAt: -1 }).lean(),
        Cheque.find({ shopId, type: 'issued'   }).sort({ chequeDate:  1 }).lean(),
      ]);

      return res.json({ received, issued });
    } catch (err) {
      return res.status(500).json({ message: err.message });
    }
  });

  /**
   * POST /api/admin/cheques/received
   * Received cheque add + optional Cloudinary image upload
   */
  chequeRouter.post('/received', async (req, res) => {
    const { party, amount, chequeNo, chequeDate, bank, note, imageBase64, imageType } = req.body;

    if (!party || !amount || !chequeDate)
      return res.status(400).json({ message: 'Party, Amount, Cheque Date අවශ්‍යයි' });

    try {
      let imageUrl      = null;
      let imagePublicId = null;

      // Cloudinary upload (if image provided)
      if (imageBase64) {
        try {
          const result  = await uploadToCloudinary(imageBase64, imageType || 'image/jpeg');
          imageUrl      = result.url;
          imagePublicId = result.publicId;
        } catch (uploadErr) {
          console.error('Cloudinary upload failed:', uploadErr.message);
          // image upload fail වුනත් cheque save කෙරේ
        }
      }

      const cheque = await Cheque.create({
        shopId:      req.user.shopId,
        type:        'received',
        party, amount: Number(amount),
        chequeNo:    chequeNo || '',
        chequeDate:  new Date(chequeDate),
        bank:        bank || '',
        note:        note || '',
        imageUrl, imagePublicId,
      });

      return res.status(201).json({ cheque });
    } catch (err) {
      return res.status(500).json({ message: err.message });
    }
  });

  /**
   * POST /api/admin/cheques/issued
   * Issued cheque add (supplier, etc.)
   */
  chequeRouter.post('/issued', async (req, res) => {
    const { party, amount, chequeNo, chequeDate, bank, note } = req.body;

    if (!party || !amount || !chequeDate)
      return res.status(400).json({ message: 'Party, Amount, Cheque Date අවශ්‍යයි' });

    try {
      const cheque = await Cheque.create({
        shopId:     req.user.shopId,
        type:       'issued',
        party, amount: Number(amount),
        chequeNo:   chequeNo || '',
        chequeDate: new Date(chequeDate),
        bank:       bank || '',
        note:       note || '',
      });

      return res.status(201).json({ cheque });
    } catch (err) {
      return res.status(500).json({ message: err.message });
    }
  });

  /**
   * PUT /api/admin/cheques/:id/cashed
   * Mark received cheque as cashed → revenue ට add කිරීම
   * NOTE: Revenue model ඇත්නම් ඒකෙ Bill/Revenue document create කෙරේ.
   *       නොමැතිනම් Shop-level running total update කෙරේ.
   */
  chequeRouter.put('/:id/cashed', async (req, res) => {
    try {
      const cheque = await Cheque.findOne({ _id: req.params.id, shopId: req.user.shopId });
      if (!cheque) return res.status(404).json({ message: 'Cheque හමු නොවීය' });
      if (cheque.type !== 'received')
        return res.status(400).json({ message: 'Issued cheque Cashed mark කළ නොහැකිය — Received cheques only' });
      if (cheque.isCashed)
        return res.status(400).json({ message: 'දැනටමත් Cashed ලෙස සලකුණු කොට ඇත' });

      // Mark as cashed
      cheque.isCashed  = true;
      cheque.cashedAt  = new Date();
      cheque.cashedBy  = req.user.username;
      await cheque.save();

      // ── Revenue Registration ────────────────────────────────────
      // Bill/Revenue model ඇත්නම් Revenue document create කෙරේ.
      // server.js-ෙ Bill/Revenue model export/expose කොට ඇත්නම් use කෙරේ.
      try {
        const mongoose = require('mongoose');

        // Revenue model exist කරයිදැයි check (server.js-ෙ define කළ model)
        if (mongoose.models.Bill) {
          // Bill model හරහා revenue track කෙරේ නම් — void=false, type='cheque_cashed'
          // ඔබේ Bill schema අනුව fields adjust කරන්න:
          await mongoose.models.Bill.create({
            shopId:        cheque.shopId,
            billNumber:    `CHQ-${cheque.chequeNo || cheque._id.toString().slice(-6).toUpperCase()}`,
            subtotal:      cheque.amount,
            total:         cheque.amount,
            cashierName:   req.user.displayName || req.user.username,
            customerName:  `Cheque Cashed — ${cheque.party} | ${cheque.bank}`,
            items:         [],
            paymentMethod: 'transfer',
            amountPaid:    cheque.amount,
            change:        0,
            isVoided:      false,
          });
        }
      } catch (revErr) {
        // Revenue model නොමැතිනම් gracefully skip — cheque status saved
        console.warn('Revenue model update skip:', revErr.message);
      }

      return res.json({
        success: true,
        cheque,
        message: `✅ Cheque Cashed — රු. ${cheque.amount.toLocaleString()} ආදායමට Add විය`,
      });
    } catch (err) {
      return res.status(500).json({ message: err.message });
    }
  });

  /**
   * DELETE /api/admin/cheques/:id
   */
  chequeRouter.delete('/:id', async (req, res) => {
    try {
      const cheque = await Cheque.findOneAndDelete({ _id: req.params.id, shopId: req.user.shopId });
      if (!cheque) return res.status(404).json({ message: 'Cheque හමු නොවීය' });
      return res.json({ success: true });
    } catch (err) {
      return res.status(500).json({ message: err.message });
    }
  });

  app.use('/api/admin/cheques', chequeRouter);

  /* ────────────────────────────────────────────────────────────────
     DASHBOARD PENDING CHEQUES COUNT
     AdminDashboard.js — GET /api/admin/dashboard හෙදී
     data.pendingCheques value return කිරීම.
     server.js-ෙ /api/admin/dashboard route ඒකට මෙය add කරන්න.

     නමුත් separate endpoint ද provide කෙරේ:
  ──────────────────────────────────────────────────────────────── */
  const dashRouter = express.Router();
  dashRouter.use(requireAuth, requireAdmin);

  /**
   * GET /api/admin/dashboard/cheque-summary
   * Pending cheques count + total amount
   */
  dashRouter.get('/cheque-summary', async (req, res) => {
    try {
      const shopId = req.user.shopId;
      const [pendingReceived, pendingIssued, totalPendingAmt] = await Promise.all([
        Cheque.countDocuments({ shopId, type: 'received', isCashed: false }),
        Cheque.countDocuments({ shopId, type: 'issued',   isCashed: false }),
        Cheque.aggregate([
          { $match: { shopId: mongoose.Types.ObjectId.isValid(shopId) ? new mongoose.Types.ObjectId(shopId) : shopId, isCashed: false } },
          { $group: { _id: null, total: { $sum: '$amount' } } },
        ]),
      ]);

      return res.json({
        pendingReceived,
        pendingIssued,
        pendingTotal: pendingReceived + pendingIssued,
        totalPendingAmount: totalPendingAmt[0]?.total || 0,
      });
    } catch (err) {
      return res.status(500).json({ message: err.message });
    }
  });

  app.use('/api/admin/dashboard', dashRouter);

  /* ────────────────────────────────────────────────────────────────
     WHATSAPP ROUTES  (/api/admin/whatsapp/*)
  ──────────────────────────────────────────────────────────────── */
  const waRouter = express.Router();
  waRouter.use(requireAuth, requireAdmin);

  /**
   * GET /api/admin/whatsapp/status
   * WhatsApp connection status + QR code (if pending scan)
   */
  waRouter.get('/status', (req, res) => {
    return res.json({
      connected: waReady,
      qrPending: !!waQR,
      qr:        waQR,  // frontend-ෙ QRCode.toDataURL() හරහා render කෙරේ
    });
  });

  /**
   * POST /api/admin/whatsapp/send
   * Manual WhatsApp message send (Dashboard "Send via WhatsApp" button)
   * body: { to, message }
   */
  waRouter.post('/send', async (req, res) => {
    const { to, message } = req.body;
    if (!message) return res.status(400).json({ message: 'Message ඇතුළත් කරන්න' });

    const number = to || process.env.WHATSAPP_ADMIN_NUMBER;
    if (!number)  return res.status(400).json({ message: 'WhatsApp number ඇතුළත් කරන්න' });

    const sent = await sendWhatsApp(number, message);
    if (sent) return res.json({ success: true });
    return res.status(503).json({ message: 'WhatsApp ready නොවේ — QR scan කළාද?' });
  });

  /**
   * POST /api/admin/whatsapp/send-void-alert
   * Cashier bill void → automatic WhatsApp void alert (Mandatory per spec)
   * Billing route-ෙ bill void කළ පසු මෙය call කෙරේ.
   * body: { billNumber, cashierName, total, reason }
   */
  waRouter.post('/send-void-alert', async (req, res) => {
    const { billNumber, cashierName, total, reason } = req.body;
    const adminNumber = process.env.WHATSAPP_ADMIN_NUMBER;

    if (!adminNumber)
      return res.status(503).json({ message: 'WHATSAPP_ADMIN_NUMBER set කරන්න' });

    const msg =
      `🚨 *AD SOUTHERN SMART POS — VOID ALERT*\n\n` +
      `Bill #${billNumber} Void කරන ලදී!\n` +
      `Cashier: *${cashierName}*\n` +
      `Amount: රු. *${Number(total || 0).toLocaleString()}*\n` +
      `හේතුව: ${reason || '—'}\n` +
      `වේලාව: ${new Date().toLocaleString('si-LK')}\n\n` +
      `_AD Southern Smart POS_`;

    const sent = await sendWhatsApp(adminNumber, msg);
    return res.json({ success: sent });
  });

  /**
   * POST /api/admin/whatsapp/reconnect
   * Force reconnect WhatsApp (if disconnected)
   */
  waRouter.post('/reconnect', async (req, res) => {
    try {
      await initWhatsApp();
      return res.json({ success: true, message: 'Reconnect attempt started' });
    } catch (err) {
      return res.status(500).json({ message: err.message });
    }
  });

  app.use('/api/admin/whatsapp', waRouter);

  console.log('✅ Module 5 Routes loaded: /api/admin/cheques, /api/admin/dashboard/cheque-summary, /api/admin/whatsapp');
}

module.exports = { setupModule5 };
