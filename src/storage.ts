import { Storage } from "@google-cloud/storage";

const BUCKET_NAME = process.env.DOCUMENT_STORAGE_BUCKET;

// On Cloud Run, the Storage client picks up the service account
// automatically - no key file. Signing URLs additionally requires the
// service account to hold roles/iam.serviceAccountTokenCreator on
// itself (see the FSD / deployment notes for the exact gcloud command).
const storage = new Storage();

export const ALLOWED_CONTENT_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document", // .docx
]);

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10MB

export function assertStorageConfigured() {
  if (!BUCKET_NAME) {
    throw new Error("DOCUMENT_STORAGE_BUCKET is not configured.");
  }
}

export function sanitizeFilename(filename: string): string {
  return filename.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-150);
}

export function buildStorageKey(tenantId: string, employeeId: string, uuid: string, filename: string): string {
  return `tenants/${tenantId}/employees/${employeeId}/documents/${uuid}-${sanitizeFilename(filename)}`;
}

export async function getSignedUploadUrl(storageKey: string, contentType: string): Promise<string> {
  assertStorageConfigured();
  const [url] = await storage
    .bucket(BUCKET_NAME!)
    .file(storageKey)
    .getSignedUrl({
      version: "v4",
      action: "write",
      expires: Date.now() + 15 * 60 * 1000, // 15 minutes
      contentType,
    });
  return url;
}

export async function getSignedDownloadUrl(storageKey: string): Promise<string> {
  assertStorageConfigured();
  const [url] = await storage
    .bucket(BUCKET_NAME!)
    .file(storageKey)
    .getSignedUrl({
      version: "v4",
      action: "read",
      expires: Date.now() + 15 * 60 * 1000,
    });
  return url;
}

/** Confirms the object actually landed in GCS after a client-side
 * upload, and returns its size/checksum for the Document Master row -
 * the backend never receives the file bytes itself, only this
 * metadata. Uses GCS's own MD5 metadata rather than re-downloading the
 * whole object server-side just to compute a hash. */
export async function verifyUploadedObject(storageKey: string): Promise<{ exists: boolean; sizeBytes: number; md5Hash: string | null }> {
  assertStorageConfigured();
  const file = storage.bucket(BUCKET_NAME!).file(storageKey);
  const [exists] = await file.exists();
  if (!exists) return { exists: false, sizeBytes: 0, md5Hash: null };
  const [metadata] = await file.getMetadata();
  return {
    exists: true,
    sizeBytes: Number(metadata.size ?? 0),
    md5Hash: metadata.md5Hash ?? null,
  };
}
