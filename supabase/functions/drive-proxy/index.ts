import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
};

const DRIVE_API = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const FEATURES_FOLDER_NAME = "features";
const IMAGES_FOLDER_NAME = "images";
const STATUS_FILENAME = "status.json";
const TEMP_DIAG_FILENAME = ".qa-drive-write-test.json";
const DEFAULT_STATUS = {
  status: {},
  deletedCases: [],
  executions: {},
};

type GoogleAuthMode = "oauth_refresh_token" | "service_account";

type RefreshTokenConfig = {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
};

type ServiceAccountConfig = {
  clientEmail: string;
  privateKey: string;
  tokenUri: string;
};

type GoogleAuthConfig =
  | { mode: "oauth_refresh_token"; refresh: RefreshTokenConfig }
  | { mode: "service_account"; serviceAccount: ServiceAccountConfig };

type DriveBootstrap = {
  rootFolderId: string;
  rootFolderName: string;
  featuresFolderId: string;
  imagesFolderId: string;
  statusFileId: string;
};

type DriveDiagnosticCheck = {
  key: string;
  ok: boolean;
  detail: string;
};

type DriveDiagnostics = {
  ok: boolean;
  authMode: GoogleAuthMode | "unknown";
  rootFolderId?: string | null;
  serviceAccountEmail?: string | null;
  checks: DriveDiagnosticCheck[];
  recommendations: string[];
};

let cachedGoogleToken: { value: string; expiresAt: number } | null = null;
let cachedGoogleAuthConfig: GoogleAuthConfig | null = null;

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}

function mustGetEnv(name: string) {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

function optionalEnv(name: string) {
  return Deno.env.get(name)?.trim() || "";
}

function getDriveSharedFolderId() {
  const value = mustGetEnv("DRIVE_SHARED_FOLDER_ID").trim();
  if ([".", "/", "YOUR_GOOGLE_DRIVE_FOLDER_ID", "YOUR_FOLDER_ID"].includes(value)) {
    throw new Error(
      `Invalid DRIVE_SHARED_FOLDER_ID: "${value}". Please set it to the real Google Drive folder id.`,
    );
  }
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizeStatusFile(value: unknown) {
  const data = isPlainObject(value) ? value : {};
  const rawExecutions = isPlainObject(data.executions) ? data.executions : {};
  const executions: Record<string, { executor: string; remark: string; status: string; updatedAt: string }> = {};

  Object.entries(rawExecutions).forEach(([caseId, row]) => {
    if (!isPlainObject(row)) return;
    const executor = typeof row.executor === "string" ? row.executor.trim() : "";
    if (!executor) return;
    executions[caseId] = {
      executor,
      remark: typeof row.remark === "string" ? row.remark : "",
      status: typeof row.status === "string" ? row.status : "",
      updatedAt: typeof row.updatedAt === "string" ? row.updatedAt : "",
    };
  });

  return {
    status: isPlainObject(data.status) ? data.status : {},
    deletedCases: Array.isArray(data.deletedCases)
      ? data.deletedCases.filter((item) => typeof item === "string")
      : [],
    executions,
  };
}

function sanitizeFeaturePayload(value: unknown) {
  const data = isPlainObject(value) ? value : {};
  return {
    meta: isPlainObject(data.meta) ? data.meta : {},
    cases: Array.isArray(data.cases) ? data.cases : [],
    fileId: typeof data.fileId === "string" ? data.fileId : "",
    featureId: typeof data.featureId === "string" ? data.featureId : "",
  };
}

function encodeBase64Url(input: string | Uint8Array) {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function pemToArrayBuffer(pem: string) {
  const normalized = pem
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/\s+/g, "");
  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

function getGoogleAuthConfig(): GoogleAuthConfig {
  if (cachedGoogleAuthConfig) return cachedGoogleAuthConfig;

  const refreshToken = optionalEnv("GOOGLE_REFRESH_TOKEN");
  const clientId = optionalEnv("GOOGLE_OAUTH_CLIENT_ID");
  const clientSecret = optionalEnv("GOOGLE_OAUTH_CLIENT_SECRET");

  if (refreshToken && clientId && clientSecret) {
    cachedGoogleAuthConfig = {
      mode: "oauth_refresh_token",
      refresh: {
        clientId,
        clientSecret,
        refreshToken,
      },
    };
    return cachedGoogleAuthConfig;
  }

  const raw = mustGetEnv("GOOGLE_SERVICE_ACCOUNT_JSON");
  const parsed = JSON.parse(raw);

  if (!parsed.client_email || !parsed.private_key) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is missing client_email or private_key");
  }

  cachedGoogleAuthConfig = {
    mode: "service_account",
    serviceAccount: {
      clientEmail: parsed.client_email,
      privateKey: parsed.private_key,
      tokenUri: parsed.token_uri ?? GOOGLE_TOKEN_URL,
    },
  };
  return cachedGoogleAuthConfig;
}

async function createGoogleJwtAssertion(config: ServiceAccountConfig) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iss: config.clientEmail,
    scope: DRIVE_SCOPE,
    aud: config.tokenUri,
    iat: now,
    exp: now + 3600,
  };

  const unsignedToken = `${encodeBase64Url(JSON.stringify(header))}.${encodeBase64Url(JSON.stringify(payload))}`;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToArrayBuffer(config.privateKey),
    {
      name: "RSASSA-PKCS1-v1_5",
      hash: "SHA-256",
    },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(unsignedToken),
  );

  return `${unsignedToken}.${encodeBase64Url(new Uint8Array(signature))}`;
}

async function getGoogleAccessToken() {
  if (cachedGoogleToken && cachedGoogleToken.expiresAt > Date.now()) {
    return cachedGoogleToken.value;
  }

  const config = getGoogleAuthConfig();
  let tokenRes: Response;

  if (config.mode === "oauth_refresh_token") {
    tokenRes = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        client_id: config.refresh.clientId,
        client_secret: config.refresh.clientSecret,
        refresh_token: config.refresh.refreshToken,
        grant_type: "refresh_token",
      }),
    });
  } else {
    const assertion = await createGoogleJwtAssertion(config.serviceAccount);
    tokenRes = await fetch(config.serviceAccount.tokenUri, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }),
    });
  }

  const tokenJson = await tokenRes.json();
  if (!tokenRes.ok || !tokenJson.access_token) {
    throw new Error(tokenJson.error_description || tokenJson.error || "Failed to get Google access token");
  }

  cachedGoogleToken = {
    value: tokenJson.access_token,
    expiresAt: Date.now() + ((tokenJson.expires_in ?? 3600) - 60) * 1000,
  };

  return cachedGoogleToken.value;
}

async function googleFetch(input: string, init: RequestInit = {}) {
  const token = await getGoogleAccessToken();
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  return fetch(input, { ...init, headers });
}

function escapeDriveQueryLiteral(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

async function parseGoogleResponse(res: Response) {
  const contentType = res.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    return await res.json();
  }
  return await res.text();
}

function buildDriveErrorMessage(payload: any, fallback: string) {
  if (typeof payload === "string" && payload) return payload;
  return payload?.error?.message || payload?.error_description || payload?.error || fallback;
}

function normalizeDriveCreateError(message: string, authMode: GoogleAuthMode) {
  if (message.includes("Service Accounts do not have storage quota")) {
    return authMode === "service_account"
      ? "Service account ของ Google Drive สร้างไฟล์ใหม่ใน My Drive ของ Gmail ส่วนตัวไม่ได้ (storage quota restriction). ถ้าต้องการแยกไฟล์ต่อ feature ให้เปลี่ยนไปใช้ OAuth refresh token ของ testbulk87@gmail.com หรือสร้างไฟล์/โฟลเดอร์ที่ต้องใช้ไว้ล่วงหน้าแล้วแชร์ให้ service account."
      : message;
  }
  return message;
}

async function getDriveFileMetadata(fileId: string, fields = "id,name,mimeType") {
  const url = new URL(`${DRIVE_API}/files/${fileId}`);
  url.searchParams.set("fields", fields);
  url.searchParams.set("supportsAllDrives", "true");
  const res = await googleFetch(url.toString());
  const payload = await parseGoogleResponse(res);
  if (!res.ok) {
    throw new Error(buildDriveErrorMessage(payload, `Drive metadata failed: ${res.status}`));
  }
  return payload;
}

async function findFolderId(name: string, parentId: string) {
  const url = new URL(`${DRIVE_API}/files`);
  url.searchParams.set(
    "q",
    `name='${escapeDriveQueryLiteral(name)}' and '${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
  );
  url.searchParams.set("fields", "files(id,name)");
  url.searchParams.set("pageSize", "1");
  url.searchParams.set("includeItemsFromAllDrives", "true");
  url.searchParams.set("supportsAllDrives", "true");

  const res = await googleFetch(url.toString());
  const payload = await parseGoogleResponse(res);
  if (!res.ok) {
    throw new Error(buildDriveErrorMessage(payload, `Drive folder lookup failed: ${res.status}`));
  }
  return payload.files?.[0]?.id ?? null;
}

async function createFolder(name: string, parentId: string) {
  const authMode = getGoogleAuthConfig().mode;
  const res = await googleFetch(`${DRIVE_API}/files?supportsAllDrives=true`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name,
      mimeType: "application/vnd.google-apps.folder",
      parents: [parentId],
    }),
  });
  const payload = await parseGoogleResponse(res);
  if (!res.ok || !payload.id) {
    throw new Error(normalizeDriveCreateError(buildDriveErrorMessage(payload, `Create folder failed: ${res.status}`), authMode));
  }
  return payload.id as string;
}

async function ensureFolder(name: string, parentId: string) {
  const existingId = await findFolderId(name, parentId);
  if (existingId) return existingId;
  return await createFolder(name, parentId);
}

async function findFileId(name: string, parentId: string) {
  const url = new URL(`${DRIVE_API}/files`);
  url.searchParams.set(
    "q",
    `name='${escapeDriveQueryLiteral(name)}' and '${parentId}' in parents and trashed=false`,
  );
  url.searchParams.set("fields", "files(id,name,mimeType)");
  url.searchParams.set("pageSize", "1");
  url.searchParams.set("includeItemsFromAllDrives", "true");
  url.searchParams.set("supportsAllDrives", "true");

  const res = await googleFetch(url.toString());
  const payload = await parseGoogleResponse(res);
  if (!res.ok) {
    throw new Error(buildDriveErrorMessage(payload, `Drive file lookup failed: ${res.status}`));
  }
  return payload.files?.[0]?.id ?? null;
}

async function createJsonFile(name: string, parentId: string, data: unknown) {
  const authMode = getGoogleAuthConfig().mode;
  const boundary = `qa-drive-${crypto.randomUUID()}`;
  const body = [
    `--${boundary}`,
    "Content-Type: application/json; charset=UTF-8",
    "",
    JSON.stringify({
      name,
      parents: [parentId],
      mimeType: "application/json",
    }),
    `--${boundary}`,
    "Content-Type: application/json; charset=UTF-8",
    "",
    JSON.stringify(data),
    `--${boundary}--`,
  ].join("\r\n");

  const url = new URL(`${DRIVE_UPLOAD_API}/files`);
  url.searchParams.set("uploadType", "multipart");
  url.searchParams.set("fields", "id,name");
  url.searchParams.set("supportsAllDrives", "true");

  const res = await googleFetch(url.toString(), {
    method: "POST",
    headers: {
      "Content-Type": `multipart/related; boundary=${boundary}`,
    },
    body,
  });
  const payload = await parseGoogleResponse(res);
  if (!res.ok || !payload.id) {
    throw new Error(normalizeDriveCreateError(buildDriveErrorMessage(payload, `Create file failed: ${res.status}`), authMode));
  }
  return payload;
}

async function writeJsonFile(fileId: string, data: unknown) {
  const url = new URL(`${DRIVE_UPLOAD_API}/files/${fileId}`);
  url.searchParams.set("uploadType", "media");
  url.searchParams.set("supportsAllDrives", "true");

  const res = await googleFetch(url.toString(), {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(data),
  });
  const payload = await parseGoogleResponse(res);
  if (!res.ok) {
    throw new Error(buildDriveErrorMessage(payload, `Drive write failed: ${res.status}`));
  }
}

async function readJsonFile(fileId: string) {
  const url = new URL(`${DRIVE_API}/files/${fileId}`);
  url.searchParams.set("alt", "media");
  url.searchParams.set("supportsAllDrives", "true");

  const res = await googleFetch(url.toString());
  const payload = await parseGoogleResponse(res);
  if (!res.ok) {
    throw new Error(buildDriveErrorMessage(payload, `Drive read failed: ${res.status}`));
  }
  return payload;
}

async function deleteDriveFile(fileId: string) {
  const url = new URL(`${DRIVE_API}/files/${fileId}`);
  url.searchParams.set("supportsAllDrives", "true");
  const res = await googleFetch(url.toString(), { method: "DELETE" });
  if (!res.ok && res.status !== 404) {
    const payload = await parseGoogleResponse(res);
    throw new Error(buildDriveErrorMessage(payload, `Drive delete failed: ${res.status}`));
  }
}

async function listJsonFiles(parentId: string) {
  const url = new URL(`${DRIVE_API}/files`);
  url.searchParams.set(
    "q",
    `'${parentId}' in parents and mimeType='application/json' and trashed=false`,
  );
  url.searchParams.set("fields", "files(id,name)");
  url.searchParams.set("pageSize", "1000");
  url.searchParams.set("includeItemsFromAllDrives", "true");
  url.searchParams.set("supportsAllDrives", "true");

  const res = await googleFetch(url.toString());
  const payload = await parseGoogleResponse(res);
  if (!res.ok) {
    throw new Error(buildDriveErrorMessage(payload, `Drive list failed: ${res.status}`));
  }
  return payload.files ?? [];
}

async function makeFilePublic(fileId: string) {
  const url = new URL(`${DRIVE_API}/files/${fileId}/permissions`);
  url.searchParams.set("supportsAllDrives", "true");
  const res = await googleFetch(url.toString(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      role: "reader",
      type: "anyone",
    }),
  });
  if (!res.ok && res.status !== 409) {
    const payload = await parseGoogleResponse(res);
    throw new Error(buildDriveErrorMessage(payload, `Drive permission update failed: ${res.status}`));
  }
}

async function uploadImageFile(file: File, caseFolderId: string) {
  const authMode = getGoogleAuthConfig().mode;
  const form = new FormData();
  form.append(
    "metadata",
    new Blob([
      JSON.stringify({
        name: file.name,
        parents: [caseFolderId],
      }),
    ], { type: "application/json" }),
  );
  form.append("media", file);

  const url = new URL(`${DRIVE_UPLOAD_API}/files`);
  url.searchParams.set("uploadType", "multipart");
  url.searchParams.set("fields", "id,name,webViewLink,webContentLink");
  url.searchParams.set("supportsAllDrives", "true");

  const res = await googleFetch(url.toString(), {
    method: "POST",
    body: form,
  });
  const payload = await parseGoogleResponse(res);
  if (!res.ok || !payload.id) {
    throw new Error(normalizeDriveCreateError(buildDriveErrorMessage(payload, `Image upload failed: ${res.status}`), authMode));
  }

  await makeFilePublic(payload.id);

  return {
    id: payload.id,
    name: payload.name,
    url: `https://lh3.googleusercontent.com/d/${payload.id}`,
    viewUrl: payload.webViewLink,
  };
}

async function ensureBootstrap() {
  const rootFolderId = getDriveSharedFolderId();
  const rootFolder = await getDriveFileMetadata(rootFolderId, "id,name,mimeType");
  const featuresFolderId = await ensureFolder(FEATURES_FOLDER_NAME, rootFolderId);
  const imagesFolderId = await ensureFolder(IMAGES_FOLDER_NAME, rootFolderId);

  let statusFileId = await findFileId(STATUS_FILENAME, rootFolderId);
  if (!statusFileId) {
    statusFileId = (await createJsonFile(STATUS_FILENAME, rootFolderId, DEFAULT_STATUS)).id;
  }

  return {
    rootFolderId,
    rootFolderName: rootFolder.name,
    featuresFolderId,
    imagesFolderId,
    statusFileId,
  } satisfies DriveBootstrap;
}

async function readBootstrapState(bootstrap: DriveBootstrap) {
  const rawStatus = await readJsonFile(bootstrap.statusFileId);
  const statusFile = sanitizeStatusFile(rawStatus);
  const featureFiles = await listJsonFiles(bootstrap.featuresFolderId);

  const features = [];
  for (const file of featureFiles) {
    try {
      const payload = await readJsonFile(file.id);
      const feature = sanitizeFeaturePayload(payload);
      const meta = isPlainObject(feature.meta) ? feature.meta : {};
      const featureId = typeof meta.id === "string" && meta.id
        ? meta.id
        : file.name.replace(/\.json$/i, "");

      features.push({
        featureId,
        meta,
        cases: feature.cases,
        fileId: file.id,
      });
    } catch (error) {
      console.error("skip invalid feature file", file.id, error);
    }
  }

  return {
    ...bootstrap,
    status: statusFile.status,
    deletedCases: statusFile.deletedCases,
    executions: statusFile.executions,
    features,
  };
}

function validateFeatureBody(value: unknown) {
  const payload = sanitizeFeaturePayload(value);
  const meta = isPlainObject(payload.meta) ? payload.meta : {};
  const featureId = payload.featureId || (typeof meta.id === "string" ? meta.id : "");
  if (!featureId) throw new Error("featureId is required");
  if (!meta || typeof meta.id !== "string" || !meta.id) throw new Error("meta.id is required");
  return {
    featureId,
    meta,
    cases: Array.isArray(payload.cases) ? payload.cases : [],
    fileId: payload.fileId || "",
  };
}

async function upsertFeatureFile(body: unknown) {
  const bootstrap = await ensureBootstrap();
  const payload = validateFeatureBody(body);
  const fileName = `${payload.featureId}.json`;
  let fileId = payload.fileId || await findFileId(fileName, bootstrap.featuresFolderId) || "";

  if (!fileId) {
    fileId = (await createJsonFile(fileName, bootstrap.featuresFolderId, {
      meta: payload.meta,
      cases: payload.cases,
    })).id;
  } else {
    await writeJsonFile(fileId, {
      meta: payload.meta,
      cases: payload.cases,
    });
  }

  return { ok: true, fileId };
}

async function upsertStatusFile(body: unknown) {
  const bootstrap = await ensureBootstrap();
  const status = sanitizeStatusFile(body);
  await writeJsonFile(bootstrap.statusFileId, status);
  return { ok: true, fileId: bootstrap.statusFileId };
}

async function listCaseIdsFromFeatureFile(fileId: string) {
  const payload = sanitizeFeaturePayload(await readJsonFile(fileId));
  const ids = (payload.cases || [])
    .map((row) => (isPlainObject(row) && typeof row.id === "string" ? row.id.trim() : ""))
    .filter(Boolean);
  return [...new Set(ids)];
}

async function deleteImageFoldersForCases(caseIds: string[], imagesFolderId: string) {
  let deleted = 0;
  for (const caseId of caseIds) {
    try {
      const folderId = await findFolderId(caseId, imagesFolderId);
      if (!folderId) continue;
      await deleteDriveFile(folderId);
      deleted += 1;
    } catch (error) {
      console.error("skip image folder delete", caseId, error);
    }
  }
  return deleted;
}

async function deleteFeature(featureId: string, fileId = "") {
  const bootstrap = await ensureBootstrap();
  const resolvedFileId = fileId || await findFileId(`${featureId}.json`, bootstrap.featuresFolderId);
  if (!resolvedFileId) return { ok: true, deleted: false, deletedImageFolders: 0 };

  const caseIds = await listCaseIdsFromFeatureFile(resolvedFileId).catch((error) => {
    console.error("read case ids failed", resolvedFileId, error);
    return [] as string[];
  });
  const deletedImageFolders = caseIds.length
    ? await deleteImageFoldersForCases(caseIds, bootstrap.imagesFolderId)
    : 0;

  await deleteDriveFile(resolvedFileId);
  return { ok: true, deleted: true, deletedImageFolders };
}

async function uploadImages(req: Request) {
  const bootstrap = await ensureBootstrap();
  const form = await req.formData();
  const caseId = String(form.get("caseId") || "").trim();
  if (!caseId) throw new Error("caseId is required");

  const caseFolderId = await ensureFolder(caseId, bootstrap.imagesFolderId);
  const files = form.getAll("files").filter((entry): entry is File => entry instanceof File);
  if (!files.length) throw new Error("No files uploaded");

  const images = [];
  for (const file of files) {
    images.push(await uploadImageFile(file, caseFolderId));
  }

  return { ok: true, images };
}

async function requireSupabaseUser(req: Request) {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return null;

  const supabase = createClient(
    mustGetEnv("SUPABASE_URL"),
    mustGetEnv("SUPABASE_ANON_KEY"),
    {
      global: {
        headers: {
          Authorization: authHeader,
        },
      },
    },
  );

  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return null;
  return data.user;
}

async function runDriveDiagnostics(includeWriteCheck = false): Promise<DriveDiagnostics> {
  const checks: DriveDiagnosticCheck[] = [];
  const recommendations = new Set<string>();
  let authMode: DriveDiagnostics["authMode"] = "unknown";
  let rootFolderId: string | null = null;
  let serviceAccountEmail: string | null = null;

  try {
    rootFolderId = getDriveSharedFolderId();
    checks.push({ key: "env.drive_folder_id", ok: true, detail: `DRIVE_SHARED_FOLDER_ID=${rootFolderId}` });
  } catch (error) {
    checks.push({ key: "env.drive_folder_id", ok: false, detail: error instanceof Error ? error.message : String(error) });
  }

  try {
    const config = getGoogleAuthConfig();
    authMode = config.mode;
    if (config.mode === "service_account") {
      serviceAccountEmail = config.serviceAccount.clientEmail;
      checks.push({
        key: "auth.config",
        ok: true,
        detail: `Using service account ${serviceAccountEmail}`,
      });
      recommendations.add(
        "ถ้า Google Drive ปลายทางเป็น My Drive ของ Gmail ส่วนตัว และต้องสร้างไฟล์ใหม่หลายไฟล์ต่อ feature แนะนำให้ใช้ OAuth refresh token ของ owner แทน service account",
      );
    } else {
      checks.push({
        key: "auth.config",
        ok: true,
        detail: "Using Google OAuth refresh token mode",
      });
    }
  } catch (error) {
    checks.push({ key: "auth.config", ok: false, detail: error instanceof Error ? error.message : String(error) });
  }

  try {
    await getGoogleAccessToken();
    checks.push({ key: "auth.token", ok: true, detail: "Google access token fetched successfully" });
  } catch (error) {
    checks.push({ key: "auth.token", ok: false, detail: error instanceof Error ? error.message : String(error) });
    recommendations.add("ตรวจสอบ secret ของ Google auth ว่าถูกต้องและยังใช้งานได้");
  }

  if (rootFolderId) {
    try {
      const root = await getDriveFileMetadata(rootFolderId, "id,name,mimeType");
      checks.push({
        key: "drive.root_folder",
        ok: true,
        detail: `Accessible root folder: ${root.name} (${root.id})`,
      });
    } catch (error) {
      checks.push({ key: "drive.root_folder", ok: false, detail: error instanceof Error ? error.message : String(error) });
      recommendations.add("ตรวจสอบว่า DRIVE_SHARED_FOLDER_ID ชี้ไปที่ folder จริง และ account ที่ใช้ auth มองเห็น folder นี้");
    }
  }

  if (rootFolderId) {
    try {
      const featuresFolderId = await findFolderId(FEATURES_FOLDER_NAME, rootFolderId);
      checks.push({
        key: "drive.features_folder",
        ok: Boolean(featuresFolderId),
        detail: featuresFolderId
          ? `Found features folder (${featuresFolderId})`
          : "features folder not found yet",
      });
    } catch (error) {
      checks.push({ key: "drive.features_folder", ok: false, detail: error instanceof Error ? error.message : String(error) });
    }

    try {
      const imagesFolderId = await findFolderId(IMAGES_FOLDER_NAME, rootFolderId);
      checks.push({
        key: "drive.images_folder",
        ok: Boolean(imagesFolderId),
        detail: imagesFolderId
          ? `Found images folder (${imagesFolderId})`
          : "images folder not found yet",
      });
    } catch (error) {
      checks.push({ key: "drive.images_folder", ok: false, detail: error instanceof Error ? error.message : String(error) });
    }

    try {
      const statusFileId = await findFileId(STATUS_FILENAME, rootFolderId);
      checks.push({
        key: "drive.status_file",
        ok: Boolean(statusFileId),
        detail: statusFileId
          ? `Found status file (${statusFileId})`
          : "status.json not found yet",
      });
    } catch (error) {
      checks.push({ key: "drive.status_file", ok: false, detail: error instanceof Error ? error.message : String(error) });
    }
  }

  if (includeWriteCheck && rootFolderId) {
    try {
      const created = await createJsonFile(TEMP_DIAG_FILENAME, rootFolderId, { createdAt: new Date().toISOString() });
      await deleteDriveFile(created.id);
      checks.push({
        key: "drive.write_check",
        ok: true,
        detail: "Create + delete temp file succeeded",
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      checks.push({
        key: "drive.write_check",
        ok: false,
        detail,
      });
      if (detail.includes("storage quota")) {
        recommendations.add(
          "ตอนนี้ auth mode ที่ใช้อยู่สร้างไฟล์ใหม่ใน Drive นี้ไม่ได้ ถ้าต้องการแยกไฟล์ต่อ feature จริง ให้สลับไปใช้ OAuth refresh token ของ testbulk87@gmail.com",
        );
        recommendations.add(
          "ถ้าจะใช้ service account ต่อ ต้องให้ owner สร้างไฟล์/โฟลเดอร์ที่ต้องใช้ไว้ล่วงหน้าแล้วแชร์ให้ service account",
        );
      } else {
        recommendations.add("ตรวจสอบสิทธิ์เขียนของ Google Drive folder ปลายทาง");
      }
    }
  }

  return {
    ok: checks.every((check) => check.ok),
    authMode,
    rootFolderId,
    serviceAccountEmail,
    checks,
    recommendations: [...recommendations],
  };
}

async function safeDiagnostics(includeWriteCheck = false) {
  try {
    return await runDriveDiagnostics(includeWriteCheck);
  } catch (error) {
    return {
      ok: false,
      authMode: "unknown",
      checks: [
        {
          key: "diagnostics",
          ok: false,
          detail: error instanceof Error ? error.message : String(error),
        },
      ],
      recommendations: [
        "ตรวจสอบ environment variables ของ function แล้วลอง diagnostics ใหม่อีกครั้ง",
      ],
    } satisfies DriveDiagnostics;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const url = new URL(req.url);
  const action = (url.searchParams.get("action") || "bootstrap").trim();

  try {
    const user = await requireSupabaseUser(req);
    if (!user) return jsonResponse({ error: "Unauthorized" }, 401);

    if (req.method === "GET" && action === "diagnostics") {
      const includeWriteCheck = url.searchParams.get("writeCheck") === "1";
      return jsonResponse(await runDriveDiagnostics(includeWriteCheck));
    }

    if (req.method === "GET" && action === "bootstrap") {
      const bootstrap = await ensureBootstrap();
      return jsonResponse(await readBootstrapState(bootstrap));
    }

    if (req.method === "POST" && action === "feature-upsert") {
      return jsonResponse(await upsertFeatureFile(await req.json()));
    }

    if (req.method === "POST" && action === "status-upsert") {
      return jsonResponse(await upsertStatusFile(await req.json()));
    }

    if (req.method === "POST" && action === "image-upload") {
      return jsonResponse(await uploadImages(req));
    }

    if (req.method === "DELETE" && action === "feature-delete") {
      const featureId = (url.searchParams.get("featureId") || "").trim();
      const fileId = (url.searchParams.get("fileId") || "").trim();
      if (!featureId && !fileId) throw new Error("featureId or fileId is required");
      return jsonResponse(await deleteFeature(featureId, fileId));
    }

    if (req.method === "DELETE" && action === "file-delete") {
      const fileId = (url.searchParams.get("fileId") || "").trim();
      if (!fileId) throw new Error("fileId is required");
      await deleteDriveFile(fileId);
      return jsonResponse({ ok: true });
    }

    return jsonResponse({ error: "Method not allowed" }, 405);
  } catch (error) {
    console.error("drive-proxy error", error);
    return jsonResponse(
      {
        error: error instanceof Error ? error.message : "Unexpected error",
        diagnostics: await safeDiagnostics(action === "diagnostics"),
      },
      500,
    );
  }
});
