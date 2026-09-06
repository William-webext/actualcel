// ActualCel — mini interfaccia mobile per inserire rapidamente
// entrate/uscite su un budget Actual self-hosted, scrivendo direttamente
// via l'API ufficiale @actual-app/api.
//
// Config via variabili d'ambiente (vedi .env.example):
//   ACTUAL_SERVER_URL, ACTUAL_PASSWORD, ACTUAL_SYNC_ID,
//   ACTUAL_ENCRYPTION_PASSWORD (opzionale), APP_PIN, SESSION_SECRET,
//   PORT, DATA_DIR

const fs = require('fs');
const path = require('path');
const express = require('express');
const session = require('express-session');
const rateLimit = require('express-rate-limit');
const api = require('@actual-app/api');

const {
  ACTUAL_SERVER_URL,
  ACTUAL_PASSWORD,
  ACTUAL_SYNC_ID,
  ACTUAL_ENCRYPTION_PASSWORD,
  APP_PIN,
  SESSION_SECRET,
  PORT = '8730',
  DATA_DIR = '/data',
  SYNC_INTERVAL_MINUTES = '10',
  COOKIE_SECURE = 'true',
} = process.env;

const missing = Object.entries({
  ACTUAL_SERVER_URL,
  ACTUAL_PASSWORD,
  ACTUAL_SYNC_ID,
  APP_PIN,
  SESSION_SECRET,
})
  .filter(([, val]) => !val)
  .map(([name]) => name);

if (missing.length) {
  console.error(`[actualcel] Variabili d'ambiente mancanti: ${missing.join(', ')}`);
  process.exit(1);
}

fs.mkdirSync(DATA_DIR, { recursive: true });

// @actual-app/api può generare eccezioni asincrone fuori dal try/catch di
// connectWithRetry (es. durante operazioni interne sul file di cache). In un
// container la cosa giusta da fare è loggare chiaramente ed uscire, così
// "restart: unless-stopped" lo fa ripartire pulito invece di restare in uno
// stato inconsistente.
process.on('uncaughtException', (err) => {
  console.error('[actualcel] Eccezione non gestita, esco per farmi riavviare da Docker:', err);
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  console.error('[actualcel] Rejection non gestita, esco per farmi riavviare da Docker:', err);
  process.exit(1);
});

let budgetReady = false;
let lastSyncError = null;

// NOTA: @actual-app/api può generare un secondo rifiuto di promise "fuori banda"
// (oltre a quello del normale await) quando il server non è raggiungibile. Anziché
// inseguirlo con un retry-loop interno che verrebbe comunque scavalcato da quel
// rifiuto fuori banda, la strategia semplice e robusta è: un solo tentativo,
// log chiaro, e se fallisce si esce — è compose/Portainer con
// "restart: unless-stopped" a far ripartire il container con backoff finché
// actual_server non è pronto (capita tipicamente solo al boot dello stack).
async function connectOnce() {
  console.log('[actualcel] Connessione al server Actual…');
  await api.init({
    dataDir: DATA_DIR,
    serverURL: ACTUAL_SERVER_URL,
    password: ACTUAL_PASSWORD,
  });

  const downloadOpts = ACTUAL_ENCRYPTION_PASSWORD
    ? { password: ACTUAL_ENCRYPTION_PASSWORD }
    : undefined;
  await api.downloadBudget(ACTUAL_SYNC_ID, downloadOpts);

  budgetReady = true;
  lastSyncError = null;
  console.log('[actualcel] Budget caricato correttamente.');
}

function requireBudgetReady(req, res, next) {
  if (!budgetReady) {
    return res.status(503).json({ error: 'budget_not_ready', detail: lastSyncError });
  }
  next();
}

function requireAuth(req, res, next) {
  if (req.session && req.session.authed) return next();
  return res.status(401).json({ error: 'unauthorized' });
}

// --- App setup ---------------------------------------------------------

const app = express();
app.set('trust proxy', 1); // dietro Cloudflare Tunnel / reverse proxy
app.use(express.json());
app.use(
  session({
    name: 'actualcel.sid',
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      // true per default: il tunnel Cloudflare parla HTTPS col client. Metti
      // COOKIE_SECURE=false solo se accedi in HTTP semplice (es. solo LAN, test locale).
      secure: COOKIE_SECURE !== 'false',
      maxAge: 1000 * 60 * 60 * 24 * 30, // 30 giorni, evita di re-inserire il PIN ogni volta da mobile
    },
  }),
);

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too_many_attempts' },
});

app.post('/api/login', loginLimiter, (req, res) => {
  const { pin } = req.body || {};
  if (typeof pin === 'string' && pin === APP_PIN) {
    req.session.authed = true;
    return res.json({ ok: true });
  }
  return res.status(401).json({ error: 'wrong_pin' });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/session', (req, res) => {
  res.json({ authed: !!(req.session && req.session.authed) });
});

app.get('/api/health', (req, res) => {
  res.json({ budgetReady, lastSyncError });
});

// --- Dati per il form (conti, categorie, beneficiari) -------------------

app.get('/api/meta', requireAuth, requireBudgetReady, async (req, res) => {
  try {
    await api.sync();

    const [accounts, groups, payees] = await Promise.all([
      api.getAccounts(),
      api.getCategoryGroups(),
      api.getPayees(),
    ]);

    const openAccounts = accounts
      .filter((a) => !a.closed)
      .map((a) => ({ id: a.id, name: a.name, offbudget: !!a.offbudget }));

    const isIncomeGroup = (g) =>
      g.is_income === true || /^\s*income\s*$/i.test(g.name || '') || /entrate/i.test(g.name || '');

    const expenseGroups = [];
    const incomeGroups = [];
    for (const g of groups) {
      if (g.hidden) continue;
      const entry = {
        id: g.id,
        name: g.name,
        categories: (g.categories || [])
          .filter((c) => !c.hidden)
          .map((c) => ({ id: c.id, name: c.name })),
      };
      if (isIncomeGroup(g)) incomeGroups.push(entry);
      else expenseGroups.push(entry);
    }

    const payeeList = payees
      .filter((p) => !p.transfer_acct) // esclude i beneficiari "trasferimento tra conti"
      .map((p) => ({ id: p.id, name: p.name }))
      .sort((a, b) => a.name.localeCompare(b.name));

    res.json({
      accounts: openAccounts,
      expenseGroups,
      incomeGroups,
      payees: payeeList,
    });
  } catch (err) {
    console.error('[actualcel] Errore /api/meta:', err);
    res.status(500).json({ error: 'meta_failed', detail: err.message });
  }
});

// --- Inserimento transazione --------------------------------------------

app.post('/api/transaction', requireAuth, requireBudgetReady, async (req, res) => {
  const { accountId, type, amount, payeeName, categoryId, date, notes } = req.body || {};

  if (!accountId || !date || amount === undefined || amount === null) {
    return res.status(400).json({ error: 'missing_fields' });
  }
  const numericAmount = Number(amount);
  if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
    return res.status(400).json({ error: 'invalid_amount' });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'invalid_date' });
  }

  const signedCents = Math.round(numericAmount * 100) * (type === 'income' ? 1 : -1);

  const tx = {
    account: accountId,
    date,
    amount: signedCents,
    notes: notes || undefined,
  };
  if (payeeName && payeeName.trim()) tx.payee_name = payeeName.trim();
  if (categoryId) tx.category = categoryId;

  try {
    const ids = await api.addTransactions(accountId, [tx], undefined, true);
    await api.sync();
    res.json({ ok: true, id: ids && ids[0] });
  } catch (err) {
    console.error('[actualcel] Errore /api/transaction:', err);
    res.status(500).json({ error: 'add_failed', detail: err.message });
  }
});

// --- Statico + avvio -----------------------------------------------------

app.use(express.static(path.join(__dirname, 'public')));

const server = app.listen(Number(PORT), () => {
  console.log(`[actualcel] In ascolto sulla porta ${PORT}`);
});

connectOnce().catch((err) => {
  console.error('[actualcel] Connessione iniziale fallita:', err.message || err);
  lastSyncError = err.message || String(err);
  process.exit(1);
});

// Ri-sincronizza periodicamente per tenere aggiornate categorie/beneficiari
// creati da altri client (desktop/altro telefono).
setInterval(() => {
  if (budgetReady) api.sync().catch((e) => console.warn('[actualcel] sync periodico fallito:', e.message));
}, Math.max(1, Number(SYNC_INTERVAL_MINUTES)) * 60 * 1000);

process.on('SIGTERM', async () => {
  try {
    await api.shutdown();
  } finally {
    server.close(() => process.exit(0));
  }
});