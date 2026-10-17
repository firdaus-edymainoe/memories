# Memories Cloud

The optional cloud server for the Memories desktop app. People who never sign in never talk to it; the app stays local only.

What it does:

- **Accounts.** Better Auth with email and password plus Google, Apple, Microsoft, GitHub and Facebook (each one turns on when its client id and secret are set).
- **Roles.** Everyone is a `user`, and an `admin` is a user who can also manage people (list, make admin, block, remove). Admins manage people from Settings in the app.
- **Catalog sync.** Each device sends its SQLite catalog (places, files, copies, folders, versions, backups) to PostgreSQL, keyed by person and device.
- **Cloud storage.** Signed uploads and downloads to any S3-compatible provider. The app shows it as a place called Memories Cloud.
- **Your own drives.** People connect their own Google Drive or OneDrive accounts, as many as they like (two Google accounts and a work OneDrive is fine). Each one is a place in the app, and Memories manages the files in its own folder there.

## Run it

```sh
cp apps/cloud/.env.example apps/cloud/.env   # fill it in
docker run -d --name memories-pg -e POSTGRES_USER=memories -e POSTGRES_PASSWORD=memories -p 5432:5432 postgres:17
set -a; . apps/cloud/.env; set +a
npm start -w @memories/cloud                 # creates or updates the tables, then serves
```

Then point the desktop app at it:

```sh
MEMORIES_CLOUD_URL=http://localhost:8787 npm run electron -w @memories/desktop
```

Without `MEMORIES_CLOUD_URL` the app offers no sign-in at all.

### Make yourself an admin

Sign up in the app first, then run this against the database:

```sh
npm run grant-admin -w @memories/cloud -- you@example.com
```

Add `--revoke` to make someone a normal user again. After that, admins can promote others from Settings → People.

## Storage providers

Storage goes through `ObjectStorage` (`packages/storage`), so switching provider only takes a change to the environment.

| `STORAGE_PROVIDER` | Needs |
| --- | --- |
| `backblaze-b2` (default) | `STORAGE_REGION` (e.g. `us-west-004`, from the bucket's S3 endpoint) |
| `aws-s3` | `STORAGE_REGION` |
| `cloudflare-r2` | `STORAGE_ACCOUNT_ID` |
| `s3-compatible` | `STORAGE_ENDPOINT` (MinIO, Wasabi, …) |
| `memory` | nothing; files vanish when the server stops |

All of them need `STORAGE_BUCKET`, `STORAGE_ACCESS_KEY_ID` and `STORAGE_SECRET_ACCESS_KEY`.

**Backblaze B2 setup:** create a private bucket, then an application key restricted to that bucket. The key's `keyID` goes in `STORAGE_ACCESS_KEY_ID` and its `applicationKey` in `STORAGE_SECRET_ACCESS_KEY`. Uploads and downloads go straight from the app to B2 through signed URLs, so the bucket needs a CORS rule only if a browser will ever talk to it (the desktop app doesn't need one).

Files never overwrite each other: the server refuses an upload or copy to a path that's taken. On AWS and R2 this is also enforced by the provider (`If-None-Match`).

## Bring your own drive

Google Drive and OneDrive don't speak S3, so each has an adapter (`GoogleDriveStorage`, `OneDriveStorage` in `packages/storage`) that implements the same `ObjectStorage` contract as the S3 adapter. The rest of the server and the app only see that contract: the same `/storage` endpoints, signed uploads and downloads, never overwriting.

| Drive | Turn it on with | Access Memories asks for | Where files go |
| --- | --- | --- | --- |
| Google Drive | `GOOGLE_DRIVE_CLIENT_ID`, `GOOGLE_DRIVE_CLIENT_SECRET` | `drive.file`: only files Memories made | a `Memories` folder in My Drive |
| OneDrive (personal, work or school) | `ONEDRIVE_CLIENT_ID`, `ONEDRIVE_CLIENT_SECRET` (`ONEDRIVE_TENANT_ID`, default `common`) | `Files.ReadWrite.AppFolder`, `User.Read`, `offline_access` | `Apps/Memories` |

Register `<BETTER_AUTH_URL>/drives/callback` as the redirect URI for both. For Google, turn on the Drive API in the same Google Cloud project; the sign-in client can be reused.

How connecting works: the app sends a PKCE challenge, the person allows access in their browser, this server trades the provider's code for tokens and sends a sealed one-time code back to the app on `127.0.0.1`, and only that app (with its verifier) can turn it into a connection on its own signed-in account. Refresh tokens are stored encrypted (AES-256-GCM, key derived from `BETTER_AUTH_SECRET`). When a provider stops accepting them, the drive shows "Connect again" in the app. Disconnecting revokes access and leaves the files in the person's drive.

Provider differences the adapters absorb:

- **Uploads** go straight from the app to the drive: Google's resumable session URL, or a OneDrive upload session sent in 10 MiB pieces. Neither URL carries a token.
- **Downloads** use OneDrive's pre-authenticated download URL. Google Drive has no such URL, so the signed request carries a short-lived access token for that drive (scoped to Memories' own files).
- **Checksums** are kept in Google's private `appProperties` and in the OneDrive item's description. Work OneDrive accounts drop descriptions; the app then hashes the file itself.
- **Delete** moves files to the person's trash or recycle bin.

## Sign-in providers

For each provider, register this redirect URI: `<BETTER_AUTH_URL>/api/auth/callback/<provider>`, for example `https://cloud.example.com/api/auth/callback/google`.

The desktop app signs in through the system browser (RFC 8252). It opens `/desktop/sign-in`, the person signs in with the provider, and `/api/auth/desktop/authorize` sends a one-time code back to the app on `127.0.0.1`. The app trades the code and its PKCE verifier for a session of its own (`/api/auth/desktop/token`), so nothing in the browser can be reused to act as the app.

## Endpoints

| Path | What |
| --- | --- |
| `/api/auth/*` | Better Auth (sign up, sign in, reset password, admin) |
| `GET /v1/config` | Sign-in providers that are turned on |
| `GET /v1/me` | The signed-in person |
| `PUT /v1/devices/:id`, `GET /v1/devices` | Devices that sync |
| `POST /v1/sync` | One batch of catalog changes from a device |
| `/v1/storage/*` | Memories Cloud: list, stat, signed upload and download, copy, delete |
| `GET /v1/drives` | The person's connected drives, and which kinds can be connected |
| `POST /v1/drives/connect`, `POST /v1/drives/complete` | Connect a drive (see above) |
| `PATCH /v1/drives/:id`, `DELETE /v1/drives/:id` | Rename or disconnect one |
| `/v1/drives/:id/storage/*` | The same storage API, on that drive |
| `GET /drives/callback` | Where the provider sends the browser |

The desktop app sends `Authorization: Bearer <session token>` and keeps the token sealed with the OS keychain (Electron `safeStorage`).
