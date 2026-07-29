# UK Visa Compliance — API Service (Phase 2)

NestJS API service implementing the real, identity-first login against
`security.credential` in Cloud SQL — replacing the Phase 1 frontend's
mock/demo login.

## Current state (already correct in this bundle)

- `service.yaml` — pre-filled with your actual project ID
  (`uk-visa-compliance-dev`), the working image tags (`api-service:v4`,
  `pgbouncer-sidecar:v2`), and the sidecar-port fix already applied
  (only the `api` container declares a port — Cloud Run requires this).
- `pgbouncer/pgbouncer.ini` — pre-filled with your Cloud SQL private IP
  (`10.18.0.3`) and `auth_type = plain`.
- `src/auth/auth.controller.ts` — now returns `token` in the JSON body
  (not just as a cookie), which the frontend's `/api/login` route needs
  to set its own same-domain cookie.

## One thing you still need to do yourself

`pgbouncer/userlist.txt` needs your actual PostgreSQL password — this
bundle can't know that value. It should read exactly:
```
"postgres" "YOUR_ACTUAL_PASSWORD"
```
using the same password already confirmed working in Secret Manager's
`db-password` secret and Cloud SQL itself.

## Deploying this bundle

```powershell
# 1. Rebuild the API image with the token fix, using a NEW tag
gcloud builds submit --tag asia-south1-docker.pkg.dev/uk-visa-compliance-dev/uk-visa-compliance/api-service:v4

# 2. Only rebuild the sidecar if you changed userlist.txt's password
#    since the last :v2 build — if it's unchanged, skip this and reuse :v2.
cd pgbouncer
gcloud builds submit --tag asia-south1-docker.pkg.dev/uk-visa-compliance-dev/uk-visa-compliance/pgbouncer-sidecar:v2
cd ..

# 3. Deploy
gcloud run services replace service.yaml --region=asia-south1

# 4. Confirm a NEW revision was actually created (critical check —
#    reusing a tag Cloud Run has already seen won't create one)
gcloud run revisions list --service=api-service --region=asia-south1
```

## Verifying the fix specifically

```powershell
Invoke-WebRequest -Uri "https://api-service-57843829799.asia-south1.run.app/auth/login" -Method POST -ContentType "application/json" -Body '{"email":"hr.admin@ukvisacompliance.com","password":"Password123!"}' -UseBasicParsing | Select-Object -ExpandProperty Content
```

Expected: `{"ok":true,"token":"eyJhbGc..."}` — a `token` field with a long
value must be present. If it's still `{"ok":true}` with no token, the new
revision didn't actually deploy — check step 4 above again.
