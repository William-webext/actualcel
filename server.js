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
const cookieSession = require('cookie-session');
const rateLimit = require('express-rate-limit');
const api = require('@actual-app/api');
const Database = require('better-sqlite3');

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

let budgetReady = false;
let lastSyncError = null;
let recovering = false;

// NOTA: @actual-app/api può generare un rifiuto di promise "fuori banda"
// (fuori dal try/catch della singola richiesta) sia durante la connessione
// iniziale sia, più raramente, durante operazioni successive (sync, modifica,
// cancellazione) — es. quando actual_server si è aggiornato nel frattempo.
// Se succede PRIMA che il budget sia mai stato caricato, non c'è nulla da
// salvare: usciamo e lasciamo che "restart: unless-stopped" riprovi pulito.
// Se succede DOPO (a runtime, con utenti già loggati), proviamo prima a
// riconnetterci nello stesso processo: così il server resta in piedi e le
// sessioni attive non vengono perse (con express-session in memoria un
// riavvio forzava tutti a reinserire il PIN). Solo se anche il tentativo di
// riconnessione fallisce usciamo, come rete di sicurezza finale.
async function handleFatalError(err) {
  console.error('[actualcel] Errore non gestito:', err);
  lastSyncError = (err && err.message) || String(err);

  if (!budgetReady) {
    console.error('[actualcel] Mai arrivato a caricare il budget: esco per farmi riavviare da Docker.');
    process.exit(1);
    return;
  }

  if (recovering) return;
  recovering = true;
  budgetReady = false;
  console.error('[actualcel] Provo a riconnettermi senza riavviare il container…');
  try {
    await api.shutdown().catch(() => {});
    await connectOnce();
    console.log('[actualcel] Riconnessione riuscita, sessioni utente preservate.');
  } catch (e) {
    console.error('[actualcel] Riconnessione fallita, esco per farmi riavviare da Docker:', e.message || e);
    process.exit(1);
  } finally {
    recovering = false;
  }
}

process.on('uncaughtException', handleFatalError);
process.on('unhandledRejection', handleFatalError);

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
  tuneDatabase();
  logBudgetStats();
}

function findBudgetDbPath() {
  const entries = fs.readdirSync(DATA_DIR, { withFileTypes: true });
  const budgetDirEntry = entries.find(
    (e) => e.isDirectory() && fs.existsSync(path.join(DATA_DIR, e.name, 'db.sqlite')),
  );
  if (!budgetDirEntry) return null;
  return { name: budgetDirEntry.name, dbPath: path.join(DATA_DIR, budgetDirEntry.name, 'db.sqlite') };
}

// @actual-app/api apre il suo db.sqlite locale senza impostare nessun PRAGMA
// (usa i default di better-sqlite3: rollback journal, cioè per ogni singola
// scrittura crea/fsync-a/cancella un file di journal a parte). Su un NAS con
// disco meccanico questo può costare centinaia di ms per ogni messaggio, e
// durante un catch-up di sync che ne riapplica una decina è lì che se ne
// vanno i secondi. journal_mode=WAL è un'impostazione persistita nel FILE
// stesso (non nella singola connessione): impostarla qui una volta per avvio
// vale anche per le connessioni che @actual-app/api apre dopo su questo
// stesso file, ed evita quel giro di journal per ogni scrittura. NOTA:
// "synchronous" invece NON è persistito nel file — vale solo per la nostra
// connessione, che chiudiamo subito dopo — quindi la connessione di
// @actual-app/api riparte comunque con il suo default; lo impostiamo qui solo
// perché non costa nulla provarci. Il beneficio vero è journal_mode=WAL.
// Best-effort: se fallisce non blocca l'avvio, si torna al comportamento di
// prima.
function tuneDatabase() {
  try {
    const found = findBudgetDbPath();
    if (!found) return;
    const db = new Database(found.dbPath);
    const journalMode = db.pragma('journal_mode = WAL', { simple: true });
    db.pragma('synchronous = NORMAL');
    db.close();
    console.log(`[actualcel] Ottimizzazione db locale (${found.name}): journal_mode=${journalMode}`);
  } catch (e) {
    console.warn('[actualcel] Impossibile ottimizzare il db locale (continuo comunque):', e.message);
  }
}

// Diagnostica di sola lettura: quante righe ha davvero il replica locale del
// budget (db.sqlite dentro DATA_DIR). Serve a capire se la lentezza di
// sync/modifica dipende dal numero di transazioni "vive" oppure da altro
// (mesi di storico del foglio di calcolo, registro CRDT accumulato nel
// tempo…) invece di continuare a indovinare. Non modifica nulla.
function logBudgetStats() {
  try {
    const found = findBudgetDbPath();
    if (!found) {
      console.warn('[actualcel] Statistiche db: nessuna cartella budget trovata sotto', DATA_DIR);
      return;
    }
    const db = new Database(found.dbPath, { readonly: true });
    const count = (table) => {
      try {
        return db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
      } catch (e) {
        return 'n/d (' + e.message + ')';
      }
    };
    console.log('[actualcel] Statistiche budget locale (' + found.name + '):', {
      transactions: count('transactions'),
      categories: count('categories'),
      category_groups: count('category_groups'),
      zero_budget_months: count('zero_budget_months'),
      spreadsheet_cells: count('spreadsheet_cells'),
      messages_crdt: count('messages_crdt'),
    });
    db.close();
  } catch (e) {
    console.warn('[actualcel] Impossibile leggere le statistiche del db locale:', e.message);
  }
}

// api.sync() è sempre una richiesta di rete verso actual_server: a volte è
// una verifica veloce (0 messaggi), altre volte deve scaricare un blocco più
// grosso ed è quello a incidere di più sui tempi di attesa. Il client, dopo
// ogni salvataggio/modifica/cancellazione, ricarica subito la lista o i
// metadati (loadHistory()/loadMeta()) — cosa che fa scattare UN'ALTRA sync a
// pochi istanti dalla prima, raddoppiando l'attesa senza portare nessuna
// informazione nuova. Le scritture (aggiungi/modifica/elimina) fanno sempre
// una sync vera, per spingere subito la modifica sul server; le sole letture
// (elenco/meta), se richiamate entro pochi secondi da una sync già fatta,
// vengono saltate: restano comunque aggiornate dalla sync periodica e da
// qualunque sync "vera" successiva.
let lastSyncAt = 0;
const SYNC_THROTTLE_MS = 3000;

async function timedSync(label) {
  const t0 = Date.now();
  await api.sync();
  lastSyncAt = Date.now();
  console.log(`[actualcel] sync (${label}) completata in ${lastSyncAt - t0}ms`);
}

// Il sito ufficiale di Actual sembra "istantaneo" perché il motore di sync
// gira nel browser: la modifica va subito nella copia locale (lì il
// browser stesso), e l'invio al server parte in background senza che
// l'interfaccia aspetti. Da noi la copia locale è sul NAS, non sul telefono,
// ma il principio è lo stesso: updateTransaction/deleteTransaction/
// addTransactions scrivono SUBITO nella copia locale (sincrono, già fatto
// prima di arrivare qui) — è solo il push verso actual_server a essere
// lento in certi casi (vedi timedSync). Non ha senso far aspettare l'utente
// per quel passaggio: lo lanciamo e rispondiamo subito, esattamente come fa
// il sito. Se il push fallisce lo logghiamo soltanto: la prossima sync
// (dalla prossima richiesta, o dal giro periodico) lo recupera comunque.
function syncInBackground(label) {
  timedSync(label).catch((e) => {
    console.warn(`[actualcel] sync (${label}) in background fallita, verrà ritentata più tardi:`, e.message);
  });
}

function syncIfStaleInBackground(label) {
  if (Date.now() - lastSyncAt < SYNC_THROTTLE_MS) return;
  syncInBackground(label);
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
  cookieSession({
    name: 'actualcel.sid',
    secret: SESSION_SECRET,
    httpOnly: true,
    sameSite: 'lax',
    // true per default: il tunnel Cloudflare parla HTTPS col client. Metti
    // COOKIE_SECURE=false solo se accedi in HTTP semplice (es. solo LAN, test locale).
    secure: COOKIE_SECURE !== 'false',
    maxAge: 1000 * 60 * 60 * 24 * 30, // 30 giorni, evita di re-inserire il PIN ogni volta da mobile
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
  req.session = null;
  res.json({ ok: true });
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
    syncIfStaleInBackground('meta');

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

// --- Validazione condivisa importo/data ---------------------------------

function parseAmountAndDate(body) {
  const { type, amount, date } = body || {};
  const numericAmount = Number(amount);
  if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
    return { error: 'invalid_amount' };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) {
    return { error: 'invalid_date' };
  }
  const signedCents = Math.round(numericAmount * 100) * (type === 'income' ? 1 : -1);
  return { signedCents, date };
}

// addTransactions accetta "payee_name" e crea/abbina il beneficiario da solo,
// ma updateTransaction no: vuole l'id del beneficiario già risolto (il campo
// "payee_name" non esiste sullo schema della tabella transactions e fa
// fallire l'update). Qui replichiamo a mano la stessa logica di
// find-or-create per poterlo usare anche in modifica.
async function resolvePayeeIdByName(name) {
  const trimmed = name.trim();
  const payees = await api.getPayees();
  const existing = payees.find(
    (p) => !p.transfer_acct && p.name && p.name.toLowerCase() === trimmed.toLowerCase(),
  );
  if (existing) return existing.id;
  return api.createPayee({ name: trimmed });
}

// --- Inserimento transazione --------------------------------------------

app.post('/api/transaction', requireAuth, requireBudgetReady, async (req, res) => {
  const { accountId, payeeName, categoryId, notes } = req.body || {};

  if (!accountId || !req.body || !req.body.date || req.body.amount === undefined || req.body.amount === null) {
    return res.status(400).json({ error: 'missing_fields' });
  }
  const parsed = parseAmountAndDate(req.body);
  if (parsed.error) return res.status(400).json({ error: parsed.error });

  const tx = {
    account: accountId,
    date: parsed.date,
    amount: parsed.signedCents,
    notes: notes || undefined,
  };
  if (payeeName && payeeName.trim()) tx.payee_name = payeeName.trim();
  if (categoryId) tx.category = categoryId;

  try {
    const ids = await api.addTransactions(accountId, [tx], undefined, true);
    res.json({ ok: true, id: ids && ids[0] });
    syncInBackground('add');
  } catch (err) {
    console.error('[actualcel] Errore /api/transaction:', err);
    res.status(500).json({ error: 'add_failed', detail: err.message });
  }
});

// --- Storico transazioni (lettura, modifica, cancellazione) -------------

app.get('/api/transactions', requireAuth, requireBudgetReady, async (req, res) => {
  const { accountId } = req.query;
  const days = Math.min(Math.max(Number(req.query.days) || 60, 1), 365);
  if (!accountId) return res.status(400).json({ error: 'missing_account' });

  const end = new Date();
  const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
  const toISO = (d) => d.toISOString().slice(0, 10);

  try {
    syncIfStaleInBackground('list');

    let accountsToQuery;
    if (accountId === 'all') {
      const accounts = await api.getAccounts();
      accountsToQuery = accounts.filter((a) => !a.closed).map((a) => ({ id: a.id, name: a.name }));
    } else {
      accountsToQuery = [{ id: accountId, name: null }];
    }

    const perAccount = await Promise.all(
      accountsToQuery.map(async (acc) => {
        const transactions = await api.getTransactions(acc.id, toISO(start), toISO(end));
        return transactions
          .filter((t) => !t.is_parent) // le transazioni divise (split) restano fuori dallo storico rapido
          .map((t) => ({
            id: t.id,
            date: t.date,
            amount: t.amount,
            payee: t.payee || null,
            payeeName: t.imported_payee || null,
            category: t.category || null,
            notes: t.notes || '',
            cleared: !!t.cleared,
            isTransfer: !!t.transfer_id,
            accountId: acc.id,
            accountName: acc.name,
          }));
      }),
    );

    const list = perAccount.flat().sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    res.json({ transactions: list });
  } catch (err) {
    console.error('[actualcel] Errore /api/transactions:', err);
    res.status(500).json({ error: 'list_failed', detail: err.message });
  }
});

app.patch('/api/transactions/:id', requireAuth, requireBudgetReady, async (req, res) => {
  const { id } = req.params;
  const { payeeName, categoryId, notes, accountId } = req.body || {};
  const parsed = parseAmountAndDate(req.body);
  if (parsed.error) return res.status(400).json({ error: parsed.error });

  const fields = {
    date: parsed.date,
    amount: parsed.signedCents,
    notes: notes || null,
    category: categoryId || null,
  };
  if (accountId) fields.account = accountId;

  try {
    if (payeeName && payeeName.trim()) {
      fields.payee = await resolvePayeeIdByName(payeeName);
    }
    await api.updateTransaction(id, fields);
    res.json({ ok: true });
    syncInBackground('edit');
  } catch (err) {
    console.error('[actualcel] Errore modifica transazione:', err);
    res.status(500).json({ error: 'update_failed', detail: err.message });
  }
});

app.delete('/api/transactions/:id', requireAuth, requireBudgetReady, async (req, res) => {
  const { id } = req.params;
  try {
    await api.deleteTransaction(id);
    res.json({ ok: true });
    syncInBackground('delete');
  } catch (err) {
    console.error('[actualcel] Errore cancellazione transazione:', err);
    res.status(500).json({ error: 'delete_failed', detail: err.message });
  }
});

// --- Statico + avvio -----------------------------------------------------

app.use(express.static(path.join(__dirname, 'public')));

const server = app.listen(Number(PORT), () => {
  console.log(`[actualcel] In ascolto sulla porta ${PORT}`);
});

connectOnce().catch(handleFatalError);

// Ri-sincronizza periodicamente per tenere aggiornate categorie/beneficiari
// creati da altri client (desktop/altro telefono).
setInterval(() => {
  if (budgetReady) timedSync('periodico').catch((e) => console.warn('[actualcel] sync periodico fallito:', e.message));
}, Math.max(1, Number(SYNC_INTERVAL_MINUTES)) * 60 * 1000);

process.on('SIGTERM', async () => {
  try {
    await api.shutdown();
  } finally {
    server.close(() => process.exit(0));
  }
});
