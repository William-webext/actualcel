# ActualCel

Mini interfaccia mobile per inserire velocemente entrate/uscite sul tuo Actual Budget self-hosted, senza passare dalla PWA. Scrive direttamente sul tuo budget tramite la libreria ufficiale `@actual-app/api`, che parla con `actual-server` esattamente come farebbe l'app desktop/web.

Fa solo questo, di proposito: form con conto, beneficiario (autocomplete su quelli esistenti), categoria (raggruppata come nel tuo budget, filtrata per uscita/entrata), importo, data, note. Niente storico, niente modifica di transazioni esistenti, niente gestione conti/categorie — quello resta nell'app Actual vera.

## 1. Recuperare i dati che servono da Actual

- **Sync ID**: nell'app Actual → Settings → Show advanced settings → Sync ID
- **Password server**: quella che usi per fare login sulla tua istanza
- **Encryption password**: solo se hai attivato la crittografia end-to-end sul budget, altrimenti lascia vuoto

## 2. Pubblicare il repository su GitHub (account william-webext)

1. Su github.com, loggato come `william-webext`: **New repository** → nome `actualcel` → visibilità **Private** (consigliata: nessun segreto reale finisce nel repo grazie al `.gitignore`, ma è comunque configurazione della tua infrastruttura personale) → **non** spuntare "Add a README" (ce l'hai già in questa cartella).
2. In locale, dentro questa cartella:

```bash
git init
git add .
git commit -m "Initial commit: ActualCel, quick-entry mobile UI per Actual Budget"
git branch -M main
git remote add origin https://github.com/william-webext/actualcel.git
git push -u origin main
```

Se non hai ancora un token/SSH configurato per `william-webext` su questa macchina, GitHub te lo chiede al primo `push` (token di accesso personale al posto della password, oppure chiave SSH se usi l'URL `git@github.com:william-webext/actualcel.git`).

## 3. Portare i file sul NAS e configurare `.env`

Sul NAS, via SSH (o il terminale di Portainer), clona il repo direttamente nella cartella dove Docker se lo aspetta:

```bash
cd /volume1/docker
git clone https://github.com/william-webext/actualcel.git
cd actualcel
cp .env.example .env
```

Essendo il repo privato, anche il `clone` ti chiede le credenziali GitHub (stesso token/SSH del punto 2).

Poi compila `.env` (`vi .env` o File Station):

- `ACTUAL_SERVER_URL`: dato che sta nello stesso stack/rete Docker di `actual_server`, usa `http://actual_server:5006` (nome-servizio:porta-interna, non quella host `8304`).
- `ACTUAL_PASSWORD`, `ACTUAL_SYNC_ID`, `ACTUAL_ENCRYPTION_PASSWORD`: dal punto 1.
- `APP_PIN`: il codice che userai per sbloccare l'app da mobile.
- `SESSION_SECRET`: genera con `openssl rand -hex 32`.

## 4. Aggiungere il servizio allo stack Portainer esistente

Nello stack Portainer dove già gira `actual_server` (quello creato seguendo la guida di Marius):

1. Portainer → **Stacks** → apri lo stack di Actual → **Editor**.
2. Incolla il contenuto di `compose.snippet.yml` sotto il servizio `actual_server` esistente (stessa indentazione, è già pensato per stare allo stesso livello degli altri `services:`). Nota che `build:` ed `env_file:` puntano al percorso assoluto `/volume1/docker/actualcel` — necessario perché in uno stack Portainer `.` punterebbe alla cartella interna di Portainer, non a questa.
3. **Update the stack** (spunta "Re-pull image and redeploy" non serve dato che è build locale, ma va bene lasciarlo).
4. Verifica nei log del container `actualcel` che appaia "Budget caricato correttamente."

## 5. Esporlo con Cloudflare Tunnel

Stessa procedura che hai già fatto per Actual: Cloudflare Zero Trust → Networks → Tunnels → il tuo tunnel → Public Hostname → Add:

- Sottodominio a piacere, es. `actualcel.beerfactory.pt`
- Service type: HTTP
- URL: `actualcel:8730` se `cloudflared` condivide la rete Docker col container, altrimenti `<IP-LAN-NAS>:8730`

## 6. Uso

Apri l'URL da mobile, inserisci il PIN, salva sulla home screen per un accesso tipo app (il tag `apple-mobile-web-app-capable` è già nell'pagina). Il form dopo un salvataggio si svuota solo su importo/beneficiario/note e resta pronto per il prossimo inserimento — conto, categoria e data restano impostati per velocizzare inserimenti multipli.

## Note di sicurezza

Questo servizio scrive sui tuoi dati finanziari reali, protetto solo da un PIN con rate-limit (10 tentativi/15 min). È ragionevole per iniziare, ma se vuoi un livello in più valuta di mettere anche **Cloudflare Access** davanti all'hostname (login extra prima ancora di arrivare al PIN dell'app) — con Cloudflare Tunnel che già usi è un'aggiunta di pochi minuti.

I cookie di sessione sono `Secure` di default (richiedono HTTPS, cioè il tunnel Cloudflare) — se mai lo esponi solo in LAN su HTTP semplice, imposta `COOKIE_SECURE=false` nel `.env`, altrimenti il login non "tiene".

## Comportamento all'avvio

Se `actual_server` non è ancora pronto quando parte `actualcel` (es. riavvio del NAS), il container si ferma con un log chiaro invece di restare in uno stato inconsistente — `restart: unless-stopped` lo fa ripartire da solo con backoff automatico di Docker. È normale vedere 1-2 riavvii nei log subito dopo un riavvio dello stack.
