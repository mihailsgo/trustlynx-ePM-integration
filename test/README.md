# eParaksts Mobile signing: test kit

A runnable Node script for the cycle described in the [main manual](../README.md): upload,
start ePM signing, walk the two LVRTC browser legs, finalize, download the signed PDF.

Unlike the Smart-ID kit, this cycle cannot run unattended: a human confirms both LVRTC legs in
the eParaksts mobile app. The script automates everything around those two confirmations.

## Files

| File | What it is |
|---|---|
| `sign-epm-demo.mjs` | Node (18+) script that runs the full cycle and saves `signed.pdf` |
| `sample.pdf` | A minimal one-page PDF to sign |

## Configure

The script is parameterised through environment variables:

```
ARCHIVE_BASE        https://<your-host>/archive/api   (or http://<archive-host>:8090/api)
CONTAINER_BASE      https://<your-host>/container/api (or http://<container-host>:8092/api)
AUTH_REDIRECT_URI   return URL for the authentication leg, as registered with LVRTC
SIGN_REDIRECT_URI   return URL for the signing leg, as registered with LVRTC
TOKEN               optional; only if the archive enforces JWT
LOCALE              default lv (LVRTC page language: lv / en / ru)
DOC_TYPE            default DMSSDoc (must be a document type configured on the archive)
ACR_VALUES          default urn:eparaksts:authentication:flow:mobileid
```

Set `AUTH_REDIRECT_URI` and `SIGN_REDIRECT_URI` together, or leave both unset to use the
redirect URIs configured on the Container Service. Setting only one of the two is refused by
the script, because it breaks the second token exchange (see the manual, step 2).

## Run

```
ARCHIVE_BASE="https://<your-host>/archive/api" \
CONTAINER_BASE="https://<your-host>/container/api" \
AUTH_REDIRECT_URI="https://<your-app>/epm/return/auth" \
SIGN_REDIRECT_URI="https://<your-app>/epm/return/sign" \
node sign-epm-demo.mjs ./sample.pdf
```

The script prints an LVRTC URL at steps 2 and 4. Open it in a browser, complete the eParaksts
Mobile confirmation, and hand the resulting redirect back to the script in one of two modes:

- **Paste mode (default).** When the browser lands on the return page, copy the full URL from
  the address bar and paste it into the terminal. Works with any registered return page, even
  one that shows a 404, since only the URL matters.
- **Listener mode (`--listen <port>`).** The script starts a local HTTP server and captures the
  redirect automatically. Usable only when the redirect URI registered with LVRTC actually
  reaches your machine on that port (for example through a tunnel with a public HTTPS name).

## Expected output

```
1) upload PDF ...
   document id: <uuid>
2) start ePM signing ...
   state: <uuid>
   Open this URL in a browser and authenticate with eParaksts Mobile:
   https://eidas.eparaksts.lv/trustedx-authserver/oauth/lvrtc-eipsign-as?...
3) waiting for the authentication redirect ...
   auth code received.
4) exchange auth code for identity + sign URL ...
   signer : <NAME SURNAME> (PNOLV-<personal code>)
   Open this URL in a browser and confirm the signature in eParaksts Mobile:
   https://eidas.eparaksts.lv/trustedx-authserver/oauth/lvrtc-eipsign-as?...&digests_summary=...
5) waiting for the signing redirect ...
   sign code received.
6) finalize signature ...
   result: SIGNING_COMPLETED
7) download signed document ...
   saved signed.pdf (<n> bytes), signature present: true
OK: cycle completed, signed PDF downloaded.
```

Mind the clock: the signing session expires 10 minutes after step 2, so complete both browser
legs within that window or the script fails with a 401 and you start over.

> An immediate `403` at step 2 means the Container Service has no LVRTC client ID configured.
> Apply the one-time configuration from section 7 of the manual and restart the service.
