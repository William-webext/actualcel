# ActualCel

Mini interfaccia mobile per inserire velocemente entrate/uscite sul tuo Actual Budget self-hosted, senza passare dalla PWA. Scrive direttamente sul tuo budget tramite la libreria ufficiale `@actual-app/api`, che parla con `actual-server` esattamente come farebbe l'app desktop/web.

Fa solo questo, di proposito: form con conto, beneficiario (autocomplete su quelli esistenti), categoria (raggruppata come nel tuo budget, filtrata per uscita/entrata), importo, data, note. Niente storico, niente modifica di transazioni esistenti, niente gestione conti/categorie — quello resta nell'app Actual vera.

## 1. Recuperare i dati che servono da Actual

- **Sync ID**: nell'app Actual → Settings → Show advanced settings → Sync ID
- **Password server**: quella che usi per fare login sulla tua istanza
- **Encryption password**: solo se hai attivato la crittografia end-to-end sul budget, altrimenti lascia vuoto

## 2. Pubblicare il repository su GitHub (account william-webext)

1. Su github.com, loggato come `william-webext`: **New repository** → nome `actualcel` → **Public** → **non** spuntare "Add a README" (ce l'hai già in questa cartella).
2. In locale, dentro questa cartella:

```bash
git init
git add .
git commit -m "Initial commit: ActualCel, quick-entry mobile UI per Actual Budget"
git branch -M main
git remote add origin https://github.com/william-webext/actualcel.git
git push -u origin main
```

Se non hai ancora un token/SSH configurato per `william-webext` su questa macchina, GitHub te lo chiede al primo `push` (token di accesso personale al posto della password, oppure chiave SSH se usi l'URL `git@github.com:william-webext/actualcel.git`). Nota: repo pubblico significa che chiunque vede il codice, ma nessun segreto ci finisce dentro — password, sync ID, PIN restano solo dentro Portainer (punto 3), mai nel repository.

## 3. Aggiungere il servizio allo stack Portainer esistente — nessun clone o build manuale sul NAS

`compose.snippet.yml` usa `build: https://github.com/william-webext/actualcel.git`: è Docker stesso a scaricare e buildare il repo quando fai il deploy, non devi mettere file sul NAS né aprire una shell.

1. Portainer → **Stacks** → apri lo stack di Actual (quello di Marius, con `actual_server`) → **Editor**.
2. Incolla il contenuto di `compose.snippet.yml` sotto il servizio `actual_server` esistente, stessa indentazione (allo stesso livello degli altri servizi sotto `services:`).
3. Scorri sotto l'editor fino alla sezione **Environment variables** dello stack (non dentro il file YAML) e aggiungi, una riga per variabile:
   - `ACTUAL_PASSWORD` → la password del tuo server Actual
   - `ACTUAL_SYNC_ID` → da Actual: Settings → Show advanced settings → Sync ID
   - `ACTUAL_ENCRYPTION_PASSWORD` → solo se hai la crittografia end-to-end attiva, altrimenti lasciala vuota/ometti
   - `APP_PIN` → il PIN che userai da mobile
   - `SESSION_SECRET` → una stringa lunga a caso, es. generata con `openssl rand -hex 32` (da un terminale qualsiasi, anche sul tuo PC)
4. **Update the stack**. Al primo deploy la build da Git richiede qualche decina di secondi in più del solito — normale.
5. Verifica nei log del container `actualcel` (Portainer → Containers → actualcel → Logs) che appaia "Budget caricato correttamente."

Per aggiornare dopo un futuro `git push` su GitHub: torna sullo stack e rifai **Update the stack**. Se Portainer non rileva da solo che deve ricostruire l'immagine (capita, essendo build locale e non un'immagine da registry), elimina prima l'immagine `actualcel:latest` da Portainer → Images, poi rifai Update: così è costretto a ributtare giù il repo e ricostruirla.

## 4. Esporlo con Cloudflare Tunnel

Stessa procedura che hai già fatto per Actual: Cloudflare Zero Trust → Networks → Tunnels → il tuo tunnel → Public Hostname → Add:

- Sottodominio a piacere, es. `actualcel.beerfactory.pt`
- Service type: HTTP
- URL: `actualcel:8730` se `cloudflared` condivide la rete Docker col container, altrimenti `<IP-LAN-NAS>:8730`

## 5. Uso

Apri l'URL da mobile, inserisci il PIN, salva sulla home screen per un accesso tipo app (il tag `apple-mobile-web-app-capable` è già nell'pagina). Il form dopo un salvataggio si svuota solo su importo/beneficiario/note e resta pronto per il prossimo inserimento — conto, categoria e data restano impostati per velocizzare inserimenti multipli.

## Note di sicurezza

Questo servizio scrive sui tuoi dati finanziari reali, protetto solo da un PIN con rate-limit (10 tentativi/15 min). È ragionevole per iniziare, ma se vuoi un livello in più valuta di mettere anche **Cloudflare Access** davanti all'hostname (login extra prima ancora di arrivare al PIN dell'app) — con Cloudflare Tunnel che già usi è un'aggiunta di pochi minuti.

I cookie di sessione sono `Secure` di default (richiedono HTTPS, cioè il tunnel Cloudflare) — se mai lo esponi solo in LAN su HTTP semplice, aggiungi `COOKIE_SECURE=false` tra le Environment variables dello stack Portainer, altrimenti il login non "tiene".

## Comportamento all'avvio

Se `actual_server` non è ancora pronto quando parte `actualcel` (es. riavvio del NAS), il container si ferma con un log chiaro invece di restare in uno stato inconsistente — `restart: unless-stopped` lo fa ripartire da solo con backoff automatico di Docker. È normale vedere 1-2 riavvii nei log subito dopo un riavvio dello stack.
